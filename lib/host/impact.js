/**
 * 影响预览：禁用/掩码一个插件会发生什么。
 *
 * 全部基于快照里已有的事实：工具与提示词段的归属、服务供需、模式行、活会话
 * 的运行时工具集。不调用任何写操作，也不读 session log。
 * @module dsh-plugin-console/host/impact
 */

import { expandRegistrationName } from './attribution.js'
import { readSnapshot } from './snapshot.js'

/** 取一个条目的展示名：组合行 id；同一个包挂载成多行时标题会重复。 */
function labelOf(entry) {
  return entry?.rowId || entry?.entryId || entry?.title || entry?.packageName || entry?.moduleName || '未知插件'
}

/** 从一个名字的所有者里判断是否会真的消失。 */
function ownership(owners) {
  return {
    owners,
    shared: owners.length > 1,
    lost: owners.length <= 1,
  }
}

/**
 * 计算一个目标条目的影响面。
 * @param {object} snapshot - 完整快照。
 * @param {string} rowId - 目标行 id 或运行时 id。
 * @returns {object} 影响面；找不到时 `{found:false}`。
 */
export function computeImpact(snapshot, rowId) {
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : []
  const entry = entries.find((candidate) => candidate.rowId === rowId)
    ?? entries.find((candidate) => candidate.entryId === rowId)
  if (entry === undefined) return { found: false, reason: '找不到这个插件条目' }

  const toolRows = []
  for (const name of entry.registrations?.tools ?? []) {
    const tool = (snapshot?.tools?.attributed ?? []).find((candidate) => candidate.name === name)
    const owners = tool?.owners ?? []
    toolRows.push({ name, ...ownership(owners) })
  }

  const promptRows = []
  const promptByName = new Map(
    [...(snapshot?.prompt?.sections ?? []), ...(snapshot?.prompt?.contexts ?? [])]
      .map((row) => [row.name, row]),
  )
  for (const name of [...(entry.registrations?.sections ?? []), ...(entry.registrations?.contexts ?? [])]) {
    for (const actual of expandRegistrationName(name, entry, promptByName)) {
      const row = promptByName.get(actual)
      const owners = row?.owners ?? []
      promptRows.push({ name: actual, ...ownership(owners) })
    }
  }

  const services = (entry.provides ?? []).map((name) => {
    const record = snapshot?.services?.[name] ?? {}
    const providers = record.providers ?? []
    const consumers = record.consumers ?? []
    return {
      name,
      providers,
      consumers,
      soleProvider: providers.length <= 1,
      affectedConsumers: providers.length <= 1 ? consumers : [],
    }
  })

  const modes = (snapshot?.modes ?? [])
    .filter((mode) => (mode.rows ?? []).some((row) => row.entryId === entry.rowId || row.moduleName === entry.moduleName))
    .map((mode) => ({ id: mode.id, name: mode.name ?? mode.id }))
  const modeIds = new Set(modes.map((mode) => mode.id))

  const liveSessions = (snapshot?.tools?.liveAgents ?? [])
    .filter((agent) => modeIds.has(agent.preset) || (agent.tools ?? []).some((name) => (entry.registrations?.tools ?? []).includes(name)))
    .map((agent) => ({ sessionId: agent.sessionId, preset: agent.preset }))

  const allSessions = [
    ...(snapshot?.workspaces ?? []).flatMap((workspace) => workspace.sessions ?? []),
    ...(snapshot?.ungroupedSessions ?? []),
  ]
  const seenSessions = new Set()
  let coldSessionCount = 0
  for (const session of allSessions) {
    if (typeof session?.id !== 'string' || seenSessions.has(session.id)) continue
    seenSessions.add(session.id)
    if (session.live === true) continue
    if (modeIds.has(session.preset)) coldSessionCount++
  }

  return {
    found: true,
    rowId: entry.rowId,
    entryId: entry.entryId,
    moduleName: entry.moduleName,
    title: labelOf(entry),
    enabled: entry.enabled === true,
    phase: entry.phase ?? null,
    tools: {
      owned: toolRows.map((row) => row.name),
      lost: toolRows.filter((row) => row.lost).map((row) => row.name),
      shared: toolRows.filter((row) => row.shared).map((row) => row.name),
      rows: toolRows,
    },
    sections: {
      owned: promptRows.map((row) => row.name),
      lost: promptRows.filter((row) => row.lost).map((row) => row.name),
      shared: promptRows.filter((row) => row.shared).map((row) => row.name),
      rows: promptRows,
    },
    services: {
      rows: services,
      soleProviders: services.filter((service) => service.soleProvider).map((service) => service.name),
      affectedConsumers: [...new Set(services.flatMap((service) => service.affectedConsumers))],
    },
    modes,
    liveSessions,
    coldSessionCount,
  }
}

/**
 * 读取一个目标的影响预览。
 * @param {object} ctx - host 插件上下文。
 * @param {string} rowId - 目标行 id/运行时 id。
 * @returns {Promise<object>} 影响面 + 快照时间与 HMR 提示。
 */
export async function readImpact(ctx, rowId) {
  const snapshot = await readSnapshot(ctx, {})
  return {
    ...computeImpact(snapshot, rowId),
    generatedAt: snapshot.generatedAt,
    // HMR 是否可用决定全局变更是否需要重启；未知时返回 false，界面按「可能需要重启」写。
    hmr: ctx.get('hmr') !== undefined,
  }
}
