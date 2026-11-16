/**
 * 插件活动：从 session log 的 `tool/call` / `tool/result` 归约出工具级用量。
 *
 * 这里只做「工具名 → 调用数/错误数/耗时/最后使用/会话」的纯聚合，不判断
 * 插件归属；归属由客户端用快照里的 `tools.attributed` 做连接，避免 host 为了
 * 一份活动重新跑整份快照。
 *
 * 读取范围有意限制在最近 N 天、最多 M 个会话：活动是诊断视图，不是全量审计。
 * 单个会话的结果按「最后事件序号」缓存，日志没变就不重复归约。
 * @module dsh-plugin-console/host/activity
 */

import { readSessionEvents } from './session-events.js'

/** 默认时间窗与扫描上限。 */
const DEFAULT_DAYS = 7
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

/** 单个工具最多保留多少个耗时样本；p95 不需要全量。 */
const MAX_DURATIONS = 2000

/** 会话活动缓存上限。 */
const MAX_CACHE = 256
const CACHE = new Map()

/** 把任意输入收成范围内的整数。 */
function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** 最近秩百分位；空数组返回 null。 */
function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

/** 事件序列的轻量指纹：活会话用 seq，冷会话用长度 + 末事件序号/时间。 */
function stampOf(events, captured) {
  const last = events[events.length - 1]
  if (captured.source === 'live' && typeof captured.agent?.session?.seq === 'number') {
    return 'live:' + captured.agent.session.seq
  }
  return 'log:' + events.length + ':' + (last?.seq ?? '') + ':' + (last?.time ?? '')
}

/**
 * 纯归约：把一段会话事件变成「工具名 → 计数 + 耗时样本」。
 *
 * 只处理已经配对的 `tool/result`；没有结果的调用计入 calls，但不计耗时。
 * 同一个 callId 的重复结果只算一次。
 * @param {Array<object>} events - 会话事件。
 * @returns {Map<string, {calls: number, results: number, errors: number, durations: number[], lastUsed: number}>} 工具级结果。
 */
export function summarizeToolEvents(events) {
  const pending = new Map()
  const tools = new Map()

  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'tool/call') {
      const data = event.data ?? {}
      const name = typeof data.name === 'string' ? data.name : undefined
      if (name === undefined) continue
      const time = typeof event.time === 'number' ? event.time : undefined
      const row = tools.get(name) ?? { calls: 0, results: 0, errors: 0, durations: [], lastUsed: 0 }
      row.calls++
      if (time !== undefined) row.lastUsed = Math.max(row.lastUsed, time)
      tools.set(name, row)
      if (typeof data.callId === 'string') pending.set(data.callId, { name, time })
      continue
    }

    if (event?.type === 'tool/result') {
      const data = event.data ?? {}
      const callId = typeof data.toolCallId === 'string'
        ? data.toolCallId
        : (typeof data.message?.toolCallId === 'string' ? data.message.toolCallId : undefined)
      const call = callId === undefined ? undefined : pending.get(callId)
      if (call === undefined) continue
      pending.delete(callId)
      const row = tools.get(call.name)
      if (row === undefined) continue
      row.results++
      if (data.message?.isError === true || data.isError === true) row.errors++
      const time = typeof event.time === 'number' ? event.time : undefined
      if (time !== undefined) {
        row.lastUsed = Math.max(row.lastUsed, time)
        if (call.time !== undefined && row.durations.length < MAX_DURATIONS) {
          row.durations.push(Math.max(0, time - call.time))
        }
      }
    }
  }

  return tools
}

/** 把单个会话的结果并进总表。 */
function mergeRows(target, source, sessionId) {
  for (const [name, row] of source) {
    const merged = target.get(name) ?? {
      calls: 0,
      results: 0,
      errors: 0,
      durations: [],
      lastUsed: 0,
      sessions: new Set(),
    }
    merged.calls += row.calls
    merged.results += row.results
    merged.errors += row.errors
    merged.lastUsed = Math.max(merged.lastUsed, row.lastUsed ?? 0)
    merged.sessions.add(sessionId)
    const room = MAX_DURATIONS - merged.durations.length
    if (room > 0) merged.durations.push(...row.durations.slice(0, room))
    target.set(name, merged)
  }
}

/**
 * 读取最近一段时间的工具活动。
 * @param {object} ctx - host 插件上下文。
 * @param {{days?: number | string, limit?: number | string}} [options] - 时间窗与会话上限。
 * @returns {Promise<object>} 可直接序列化的活动摘要。
 */
export async function readActivity(ctx, options = {}) {
  const days = clampInt(options.days, 1, 90, DEFAULT_DAYS)
  const limit = clampInt(options.limit, 1, MAX_LIMIT, DEFAULT_LIMIT)
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

  /** @type {Map<string, {id: string, createdAt: number, sizeBytes?: number, live: boolean}>} */
  const records = new Map()
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined && typeof persistence.list === 'function') {
    try {
      for (const snapshot of await persistence.list()) {
        const header = snapshot?.header
        if (typeof header?.id !== 'string') continue
        const createdAt = typeof header.createdAt === 'number' ? header.createdAt : undefined
        records.set(header.id, {
          id: header.id,
          createdAt: createdAt ?? 0,
          sizeBytes: typeof snapshot.sizeBytes === 'number' ? snapshot.sizeBytes : undefined,
          live: false,
        })
      }
    } catch {
      // 读不到持久化时仍尝试活会话
    }
  }

  const sessions = ctx.get('sessions')
  if (sessions !== undefined && typeof sessions.list === 'function') {
    try {
      for (const session of sessions.list()) {
        if (typeof session?.id !== 'string') continue
        const existing = records.get(session.id)
        records.set(session.id, {
          id: session.id,
          createdAt: existing?.createdAt ?? Date.now(),
          sizeBytes: existing?.sizeBytes,
          live: true,
        })
      }
    } catch {
      // 活会话读失败不影响冷会话
    }
  }

  if (records.size === 0) {
    return {
      available: false,
      reason: '这个部署没有可读的会话持久化或活会话，无法归约工具活动',
      windowDays: days,
    }
  }

  const ordered = [...records.values()]
    .filter((record) => record.live || record.createdAt >= cutoff)
    // 活会话没有 createdAt 时按「现在」参与排序，避免被 limit 排掉
    .map((record) => ({ ...record, createdAt: record.createdAt || Date.now() }))
    .sort((left, right) => right.createdAt - left.createdAt)
  const selected = ordered.slice(0, limit)

  const merged = new Map()
  let scanned = 0
  let skipped = 0
  for (const record of selected) {
    let captured
    try {
      captured = await readSessionEvents(ctx, record.id)
    } catch {
      skipped++
      continue
    }
    if (captured === undefined) {
      skipped++
      continue
    }
    scanned++
    const stamp = stampOf(captured.events, captured)
    const cacheKey = record.id + '|' + stamp
    let rows = CACHE.get(cacheKey)
    if (rows === undefined) {
      rows = summarizeToolEvents(captured.events)
      CACHE.set(cacheKey, rows)
      if (CACHE.size > MAX_CACHE) CACHE.delete(CACHE.keys().next().value)
    }
    mergeRows(merged, rows, record.id)
  }

  const tools = {}
  let totalCalls = 0
  let totalResults = 0
  let totalErrors = 0
  for (const [name, row] of merged) {
    tools[name] = {
      calls: row.calls,
      results: row.results,
      errors: row.errors,
      errorRate: row.results > 0 ? row.errors / row.results : 0,
      p50Ms: percentile(row.durations, 0.5),
      p95Ms: percentile(row.durations, 0.95),
      lastUsed: row.lastUsed > 0 ? row.lastUsed : undefined,
      sessions: [...row.sessions],
    }
    totalCalls += row.calls
    totalResults += row.results
    totalErrors += row.errors
  }

  return {
    available: true,
    generatedAt: new Date().toISOString(),
    windowDays: days,
    limit,
    sessionsScanned: scanned,
    sessionsSkipped: skipped,
    truncated: ordered.length > selected.length,
    totals: {
      calls: totalCalls,
      results: totalResults,
      errors: totalErrors,
      tools: Object.keys(tools).length,
    },
    tools,
  }
}
