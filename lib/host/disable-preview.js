/**
 * 插件禁用效果预演：一个插件被禁用后，谁失去什么。
 *
 * 与 `impact.js` 的关系：那边的结果给「控制」区做一屏确认，只覆盖目标行自己
 * 注册的工具/段与直接供需；这里要回答整页问题，所以补四件事：
 *   1. **分组级联**：禁用 group 行时，按 Loader id 前缀把子行一起算进来；
 *   2. **完整依赖链**：一个插件的服务没了，消费者会停在 pending；消费者自己也提供
 *      服务，它的消费者接着不可用——按「所需服务的提供者全部不可用」迭代到不动点，
 *      而不是只看上下相邻两层；
 *   3. **id 归一**：服务供需给的是 `entryId`，工具/段 owner 给的是 `rowId`，
 *      输出前统一成 `{entryId,rowId,title}`；
 *   4. **不把未知当失去**：owner 为空的名字进 `unknown` 桶，不并入 `lost`；
 *      消费者自己也在不可用集合里时标 `willBeUnavailable`，不说它「在等」。
 *
 * 链路的语义是「禁用并重载/重启后」：已激活的插件可能在下一次重载前仍保留
 * 注册与工具。因此所有链路结论都按推断呈现，不写成运行时实测。
 *
 * 只读：本模块不 import 任何控制/写入路径；执行禁用仍只在插件详情里。
 * @module dsh-plugin-console/host/disable-preview
 */

import { expandRegistrationName } from './attribution.js'
import { collectConfigLayers } from './config-layers.js'
import { injectionKindsOf } from './injection-owners.js'
import { readSnapshot } from './snapshot.js'

/** 影响面里单个桶的展示上限；超出只标数量，界面给「另有 N 个」。 */
const MAX_ROWS = 200
/** 依赖链最多迭代的轮数；环与超长链都靠上限收敛。 */
const MAX_CHAIN_ROUNDS = 64
/** 单条链路的节点上限；超长链截断路径，但不影响不可用判定。 */
const MAX_PATH_NODES = 64

/** 条目展示名。 */
function labelOf(entry) {
  if (entry === undefined) return '未知插件'
  return entry.title || entry.packageName || entry.moduleName || entry.entryId || '未知插件'
}

/** entryId / rowId 双向索引；服务供需用前者，工具与段 owner 用后者。 */
function buildIndex(entries) {
  const byEntryId = new Map()
  const byRowId = new Map()
  for (const entry of entries) {
    byEntryId.set(entry.entryId, entry)
    const list = byRowId.get(entry.rowId) ?? []
    list.push(entry)
    byRowId.set(entry.rowId, list)
  }
  return { byEntryId, byRowId }
}

/** 一条条目引用；服务里拿不到对应行时保留原始 id。 */
function refOf(entryId, index) {
  const entry = index.byEntryId.get(entryId)
  return {
    entryId,
    rowId: entry?.rowId ?? entryId,
    title: labelOf(entry),
    phase: entry?.phase ?? null,
  }
}

/** 一个名字的归属结论；空的 owner 是未知，不是失去。 */
function ownership(owners, unavailableRowIds) {
  return {
    lost: owners.length > 0 && owners.every((owner) => unavailableRowIds.has(owner)),
    shared: owners.some((owner) => !unavailableRowIds.has(owner)),
    unknown: owners.length === 0,
  }
}

/** 目标行与它的子行。 */
function disabledEntriesOf(entries, target) {
  return entries.filter((entry) => (
    entry.entryId === target.entryId
    || entry.entryId.startsWith(target.entryId + ':')
  ))
}

/**
 * 按服务供需推到不动点，得到完整不可用集合。
 *
 * 一条服务只有在「本来有提供者、且提供者全部不可用」时才算被这次禁用带走；
 * 本来就没人提供的服务是既有缺口，不能算到本次头上。条目的距离取它最后失效
 * 的那条必需服务的距离 + 1，这样路径展示的是真正让它停下的那一环。
 * @param {object} target - 目标条目。
 * @param {Array<object>} baseEntries - 目标与其分组子行（距离 0）。
 * @param {Array<object>} entries - 全部条目。
 * @param {object} services - `snapshot.services`。
 * @returns {{unavailable: Map<string, object>, serviceDistance: Map<string, number>, baseIds: Set<string>}} 闭包。
 */
function computeClosure(target, baseEntries, entries, services) {
  const unavailable = new Map()
  const baseIds = new Set()
  for (const entry of baseEntries) {
    baseIds.add(entry.entryId)
    unavailable.set(entry.entryId, {
      entry,
      distance: 0,
      kind: entry.entryId === target.entryId ? 'target' : 'group',
      missingServices: [],
      causeService: null,
      viaEntryId: null,
    })
  }

  const serviceDistance = new Map()
  let changed = true
  for (let round = 0; changed && round < MAX_CHAIN_ROUNDS; round++) {
    changed = false
    for (const [name, record] of Object.entries(services)) {
      if (serviceDistance.has(name)) continue
      const providers = Array.isArray(record?.providers) ? record.providers : []
      if (providers.length === 0) continue
      if (!providers.every((id) => unavailable.has(id))) continue
      let distance = 0
      for (const id of providers) distance = Math.max(distance, unavailable.get(id).distance)
      serviceDistance.set(name, distance)
      changed = true
    }
    for (const entry of entries) {
      if (unavailable.has(entry.entryId)) continue
      if (entry.enabled === false) continue
      const missing = (entry.requires ?? []).filter((name) => serviceDistance.has(name))
      if (missing.length === 0) continue
      // 必需服务全部失效才会停；它是在「最后一条」失效时停下的，所以取最大距离。
      let primary = missing[0]
      for (const name of missing) {
        if (serviceDistance.get(name) > serviceDistance.get(primary)) primary = name
      }
      const providers = (services[primary]?.providers ?? []).filter((id) => unavailable.has(id))
      let via = providers[0]
      for (const id of providers) {
        if (unavailable.get(id).distance > unavailable.get(via).distance) via = id
      }
      unavailable.set(entry.entryId, {
        entry,
        distance: serviceDistance.get(primary) + 1,
        kind: 'blocked',
        missingServices: missing,
        causeService: primary,
        viaEntryId: via,
      })
      changed = true
    }
  }
  return { unavailable, serviceDistance, baseIds }
}

/** 从不可用集合里重建一条因果路径：目标 → 服务 → 消费者 → …。 */
function pathOf(entryId, unavailable, index) {
  const path = []
  let current = entryId
  for (let guard = 0; current !== undefined && guard < MAX_PATH_NODES; guard++) {
    const record = unavailable.get(current)
    const entry = index.byEntryId.get(current)
    path.unshift({
      kind: 'entry',
      entryId: current,
      rowId: entry?.rowId ?? current,
      title: labelOf(entry),
    })
    if (record === undefined || record.kind === 'target' || record.kind === 'group') break
    if (typeof record.causeService === 'string') path.unshift({ kind: 'service', name: record.causeService })
    current = record.viaEntryId
  }
  return path
}

/** 链路行：谁不可用、缺哪些服务、经由哪条服务、到目标有多远。 */
function chainRowsOf(unavailable, index) {
  const rows = []
  for (const [entryId, record] of unavailable) {
    if (record.kind !== 'blocked') continue
    const entry = index.byEntryId.get(entryId)
    rows.push({
      entryId,
      rowId: entry?.rowId ?? entryId,
      title: labelOf(entry),
      moduleName: entry?.moduleName ?? null,
      distance: record.distance,
      phase: entry?.phase ?? null,
      alreadyPending: entry?.phase === 'pending',
      missingServices: [...record.missingServices],
      causeService: record.causeService,
      viaEntryId: record.viaEntryId,
      viaTitle: labelOf(index.byEntryId.get(record.viaEntryId)),
      path: pathOf(entryId, unavailable, index),
    })
  }
  return rows.sort((left, right) => left.distance - right.distance || left.title.localeCompare(right.title, 'zh-CN'))
}

/** 工具影响：目标、子行与链路插件的注册工具，按 owner 判断失去 / 共享 / 未知。 */
function impactTools(snapshot, unavailableEntries, unavailableRowIds, baseRowIds) {
  const attached = Array.isArray(snapshot.tools?.attributed) ? snapshot.tools.attributed : []
  const byName = new Map(attached.map((tool) => [tool.name, tool]))
  const owned = []
  for (const entry of unavailableEntries) {
    for (const name of entry.registrations?.tools ?? []) {
      if (!owned.includes(name)) owned.push(name)
    }
  }
  const rows = owned.map((name) => {
    const tool = byName.get(name)
    const owners = Array.isArray(tool?.owners) ? tool.owners : []
    const status = ownership(owners, unavailableRowIds)
    return {
      name,
      owners,
      scopes: Array.isArray(tool?.scopes) ? tool.scopes : [],
      via: tool?.via ?? 'unknown',
      ...status,
      // 全部 owner 都在链路上失去、且都不是目标/子行：这条工具是「连带失去」。
      chainOnly: status.lost && !owners.some((owner) => baseRowIds.has(owner)),
    }
  })
  const bucket = (predicate) => rows.filter(predicate).map((row) => row.name)
  return {
    owned,
    lost: bucket((row) => row.lost),
    shared: bucket((row) => row.shared),
    unknown: bucket((row) => row.unknown),
    chainOnly: bucket((row) => row.chainOnly),
    rows: rows.slice(0, MAX_ROWS),
    truncated: rows.length > MAX_ROWS,
  }
}

/** 提示词影响：sections 与 contexts 分开，回答「哪些上下文不再注入」。 */
function impactPrompt(snapshot, unavailableEntries, unavailableRowIds, baseRowIds) {
  const build = (kind, registry, field) => {
    const byName = new Map((Array.isArray(registry) ? registry : []).map((row) => [row.name, row]))
    const owned = []
    for (const entry of unavailableEntries) {
      for (const name of entry.registrations?.[field] ?? []) {
        for (const actual of expandRegistrationName(name, entry, byName)) {
          if (!owned.includes(actual)) owned.push(actual)
        }
      }
    }
    const rows = owned.map((name) => {
      const row = byName.get(name)
      const owners = Array.isArray(row?.owners) ? row.owners : []
      const status = ownership(owners, unavailableRowIds)
      return {
        name,
        kind,
        owners,
        ...status,
        chainOnly: status.lost && !owners.some((owner) => baseRowIds.has(owner)),
      }
    })
    const bucket = (predicate) => rows.filter(predicate).map((row) => row.name)
    return {
      owned,
      lost: bucket((row) => row.lost),
      shared: bucket((row) => row.shared),
      unknown: bucket((row) => row.unknown),
      chainOnly: bucket((row) => row.chainOnly),
      rows: rows.slice(0, MAX_ROWS),
      truncated: rows.length > MAX_ROWS,
    }
  }
  return {
    sections: build('section', snapshot.prompt?.sections, 'sections'),
    contexts: build('context', snapshot.prompt?.contexts, 'contexts'),
  }
}

/** 服务影响：唯一提供者失效时，哪些消费者跟着不可用。 */
function impactServices(snapshot, unavailableEntries, unavailableEntryIds, blockedEntryIds, index) {
  const registry = snapshot.services ?? {}
  const provided = []
  for (const entry of unavailableEntries) {
    for (const name of entry.provides ?? []) if (!provided.includes(name)) provided.push(name)
  }
  const rows = provided.map((name) => {
    const record = registry[name] ?? {}
    const providers = (record.providers ?? []).map((id) => refOf(id, index))
    const consumers = (record.consumers ?? []).map((id) => {
      const ref = refOf(id, index)
      const entry = index.byEntryId.get(id)
      return {
        ...ref,
        alreadyPending: ref.phase === 'pending',
        disabled: entry?.enabled === false,
        willBeUnavailable: unavailableEntryIds.has(id),
        blocked: blockedEntryIds.has(id),
      }
    })
    // provider 为空本来就是既有缺口，不是「禁用导致」；不列为本次影响。
    const soleInSet = providers.length > 0 && providers.every((provider) => unavailableEntryIds.has(provider.entryId))
    return { name, providers, consumers, soleInSet, affected: soleInSet }
  })

  const pending = new Map()
  for (const row of rows) {
    if (!row.soleInSet) continue
    for (const consumer of row.consumers) {
      if (consumer.willBeUnavailable || consumer.disabled) continue
      const existing = pending.get(consumer.rowId) ?? { ...consumer, services: [] }
      if (!existing.services.includes(row.name)) existing.services.push(row.name)
      pending.set(consumer.rowId, existing)
    }
  }
  const affected = rows.filter((row) => row.soleInSet)
  return {
    rows: rows.slice(0, MAX_ROWS),
    truncated: rows.length > MAX_ROWS,
    soleProviders: affected.map((row) => row.name),
    affectedConsumers: [...new Set(affected.flatMap((row) => row.consumers.filter((consumer) => !consumer.willBeUnavailable && !consumer.disabled).map((consumer) => consumer.rowId)))],
    pending: [...pending.values()],
  }
}

/** 受影响的模式：行 id 或模块名命中不可用集合。 */
function impactModes(snapshot, unavailableEntryIds, unavailableModules) {
  return (Array.isArray(snapshot.modes) ? snapshot.modes : [])
    .map((mode) => {
      const rows = Array.isArray(mode.rows) ? mode.rows : []
      const byEntry = rows.some((row) => unavailableEntryIds.has(row.entryId))
      const byModule = rows.some((row) => unavailableModules.has(row.moduleName))
      if (!byEntry && !byModule) return null
      return { id: mode.id, name: mode.name ?? mode.id, matchedBy: byEntry ? 'entry' : 'module' }
    })
    .filter((mode) => mode !== null)
}

/** 活会话：因模式或失去的工具而受影响；冷会话只按模式推断。 */
function impactSessions(snapshot, modeIds, lostTools) {
  const live = []
  for (const agent of snapshot.tools?.liveAgents ?? []) {
    const byMode = modeIds.has(agent.preset)
    const byTool = (agent.tools ?? []).some((name) => lostTools.has(name))
    if (!byMode && !byTool) continue
    live.push({ sessionId: agent.sessionId, preset: agent.preset, reason: byMode ? 'mode' : 'tool' })
  }
  const seen = new Set()
  let cold = 0
  const sessions = [
    ...(Array.isArray(snapshot.workspaces) ? snapshot.workspaces.flatMap((workspace) => workspace.sessions ?? []) : []),
    ...(Array.isArray(snapshot.ungroupedSessions) ? snapshot.ungroupedSessions : []),
  ]
  for (const session of sessions) {
    if (typeof session?.id !== 'string' || seen.has(session.id)) continue
    seen.add(session.id)
    if (session.live === true) continue
    if (modeIds.has(session.preset)) cold++
  }
  return { liveSessions: live, coldSessionCount: cold }
}

/**
 * 计算一个目标（含分组子行与完整依赖链）的影响面。
 *
 * 纯函数，不读文件、不调服务；`readDisablePreview` 在它之上再挂 config 分层。
 * @param {object} snapshot - 当前快照。
 * @param {string} rowId - 目标行 id 或运行时 id。
 * @returns {object} 影响面；找不到时 `{found:false, reason}`。
 */
export function computeCascadeImpact(snapshot, rowId) {
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : []
  const target = entries.find((candidate) => candidate.rowId === rowId)
    ?? entries.find((candidate) => candidate.entryId === rowId)
  if (target === undefined) return { found: false, reason: '找不到这个插件条目' }

  const index = buildIndex(entries)
  const baseEntries = disabledEntriesOf(entries, target)
  const { unavailable } = computeClosure(target, baseEntries, entries, snapshot.services ?? {})
  const unavailableEntries = entries.filter((entry) => unavailable.has(entry.entryId))
  const unavailableEntryIds = new Set(unavailableEntries.map((entry) => entry.entryId))
  const unavailableRowIds = new Set(unavailableEntries.map((entry) => entry.rowId))
  const baseRowIds = new Set(baseEntries.map((entry) => entry.rowId))
  const blockedEntries = [...unavailable.values()].filter((record) => record.kind === 'blocked')
  const blockedEntryIds = new Set(blockedEntries.map((record) => record.entry.entryId))
  const unavailableModules = new Set(unavailableEntries.map((entry) => entry.moduleName).filter((name) => typeof name === 'string'))

  const tools = impactTools(snapshot, unavailableEntries, unavailableRowIds, baseRowIds)
  const prompt = impactPrompt(snapshot, unavailableEntries, unavailableRowIds, baseRowIds)
  const services = impactServices(snapshot, unavailableEntries, unavailableEntryIds, blockedEntryIds, index)
  const modes = impactModes(snapshot, unavailableEntryIds, unavailableModules)
  const modeIds = new Set(modes.map((mode) => mode.id))
  const { liveSessions, coldSessionCount } = impactSessions(snapshot, modeIds, new Set(tools.lost))

  const descendants = baseEntries
    .filter((entry) => entry.entryId !== target.entryId)
    .map((entry) => ({
      rowId: entry.rowId,
      entryId: entry.entryId,
      title: labelOf(entry),
      depth: entry.depth ?? null,
      enabled: entry.enabled !== false,
      phase: entry.phase ?? null,
    }))

  const blocked = chainRowsOf(unavailable, index)
  const chainDepth = blocked.reduce((depth, row) => Math.max(depth, row.distance), 0)

  const injectionRows = injectionKindsOf(target.packageName, target.moduleName)
    .map((row) => ({ ...row, confidence: 'inference' }))

  return {
    found: true,
    rowId: target.rowId,
    target: {
      rowId: target.rowId,
      entryId: target.entryId,
      moduleName: target.moduleName ?? null,
      packageName: target.packageName ?? null,
      title: labelOf(target),
      version: target.version ?? null,
      layer: target.layer ?? null,
      layerVersion: target.layerVersion ?? null,
      enabled: target.enabled !== false,
      alreadyDisabled: target.enabled === false,
      phase: target.phase ?? null,
      isGroup: target.isGroup === true,
      modeOnly: target.modeOnly === true,
      requires: target.requires ?? [],
      provides: target.provides ?? [],
      configKeys: target.configKeys ?? [],
    },
    unavailableRowIds: [...unavailableRowIds],
    descendants: descendants.slice(0, MAX_ROWS),
    descendantsTruncated: descendants.length > MAX_ROWS,
    chain: {
      depth: chainDepth,
      blocked: blocked.slice(0, MAX_ROWS),
      truncated: blocked.length > MAX_ROWS,
      note: '按「所需服务的提供者全部不可用」推导，语义是禁用并重载/重启后；已激活的插件可能在下一次重载前仍保留注册与工具。',
    },
    tools,
    prompt,
    services,
    modes,
    liveSessions,
    coldSessionCount,
    injections: {
      available: true,
      rows: injectionRows,
      note: injectionRows.length === 0
        ? '没有匹配到已知的消息注入来源'
        : '归属按包名推断，不是运行时实测',
    },
    scale: {
      descendants: descendants.length,
      blockedEntries: blocked.length,
      chainDepth,
      lostTools: tools.lost.length,
      lostToolsViaChain: tools.chainOnly.length,
      sharedTools: tools.shared.length,
      unknownTools: tools.unknown.length,
      lostSections: prompt.sections.lost.length,
      lostSectionsViaChain: prompt.sections.chainOnly.length,
      sharedSections: prompt.sections.shared.length,
      lostContexts: prompt.contexts.lost.length,
      lostContextsViaChain: prompt.contexts.chainOnly.length,
      sharedContexts: prompt.contexts.shared.length,
      soleServices: services.soleProviders.length,
      pendingConsumers: services.pending.length,
      modes: modes.length,
      liveSessions: liveSessions.length,
      coldSessionCount,
      injectionRows: injectionRows.length,
    },
  }
}

/** 证据级别：界面按这四级分开标，不允许把推断写成实测。 */
const EVIDENCE = [
  { id: 'snapshot', level: 'runtime', label: '运行时事实', detail: 'Loader 行、注册表、工具可见集与会话来自当前快照。' },
  { id: 'owners', level: 'source', label: '源码扫描', detail: '工具与提示词段的 owner 来自包源码扫描；扫不到就进「未归属」，不硬凑。' },
  { id: 'config', level: 'file', label: '文件事实', detail: '覆盖链的 config 值来自 patch 文件；读不到的层已标注原因。' },
  { id: 'inference', level: 'inference', label: '推断', detail: '依赖链按 inject 声明推导；消息注入归属按包名映射；分组子行按 Loader id 前缀推断。' },
]

/** 页面必须如实写出的边界。 */
const LIMITS = [
  '影响面是派生计算：「失去」只表示没有其他所有者，不等于运行时已确认消失。',
  '依赖链按「所需服务的提供者全部不可用」推导，语义是禁用并重载/重启后；已激活的插件可能在下一次重载前仍保留注册与工具。',
  '本页不执行禁用；执行仍在插件详情控制区，由 plugin-manager 写入并审计。',
  'config 分层只展示文件声明与生效值，本页不推断各层的合并语义。',
  '分组行按 entryId 前缀推断子行；条件禁用与动态挂载可能与此不同。',
  '未归属的工具/段不并入「失去」，单独列出；未匹配到注入来源也不等于没有注入。',
]

/**
 * 读取一个目标的禁用预演。
 * @param {object} ctx - host 插件上下文。
 * @param {string} rowId - 目标行 id 或运行时 id。
 * @returns {Promise<object>} 影响面 + 依赖链 + config 分层 + 证据与边界。
 */
export async function readDisablePreview(ctx, rowId) {
  const snapshot = await readSnapshot(ctx, {})
  const impact = computeCascadeImpact(snapshot, rowId)
  if (impact.found !== true) return impact

  let config
  try {
    config = await collectConfigLayers(ctx, snapshot, impact.rowId)
  } catch (cause) {
    // 配置块独立降级：文件读不到不影响影响面与关系图。
    config = { available: false, reason: cause instanceof Error ? cause.message : String(cause) }
  }

  return {
    ...impact,
    generatedAt: snapshot.generatedAt,
    // HMR 未知时按「可能需要重启」写；与 impact.js 保持同一口径。
    hmr: ctx.get('hmr') !== undefined,
    readOnly: true,
    config,
    evidence: EVIDENCE,
    limits: LIMITS,
  }
}
