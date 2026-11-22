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
 *   4. **不把未知当失去**：注册表里有、owner 扫不到的名字进 `unknown` 桶；名字扫得到、
 *      全局注册表没有的（会话内/条件注册）进独立的 `registryMissing` 桶；两者都不并入
 *      `lost`。消费者自己也在不可用集合里时标 `willBeUnavailable`，不说它「在等」。
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

/** 工具/提示词/服务等清单的展示上限；依赖链不套用这个上限。 */
const MAX_ROWS = 200

/** 条目展示名：组合行 id；同一个包挂载成多行时标题会重复。 */
function labelOf(entry) {
  if (entry === undefined) return '未知插件'
  return entry.rowId || entry.entryId || entry.title || entry.packageName || entry.moduleName || '未知插件'
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
 * 先求完整失效集合，再统一算距离与归因，避免先命中的浅服务把深层链压平。
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

  // 第一阶段：只算「谁不可用」，不急着归因。
  // 一个条目可能同时缺几条服务，它们在后续轮次才陆续失效；如果在第一次
  // 命中时就冻结距离，链条会被压平（例如 agent → goal → driver 被画成
  // agent → driver 的兄弟节点）。
  const lostServices = new Set()
  let changed = true
  const maxSetRounds = entries.length + Object.keys(services).length + 1
  for (let round = 0; changed && round < maxSetRounds; round++) {
    changed = false
    for (const [name, record] of Object.entries(services)) {
      if (lostServices.has(name)) continue
      const providers = Array.isArray(record?.providers) ? record.providers : []
      if (providers.length === 0) continue
      if (!providers.every((id) => unavailable.has(id))) continue
      lostServices.add(name)
      changed = true
    }
    for (const entry of entries) {
      if (unavailable.has(entry.entryId)) continue
      if (entry.enabled === false) continue
      const missing = (entry.requires ?? []).filter((name) => lostServices.has(name))
      if (missing.length === 0) continue
      unavailable.set(entry.entryId, {
        entry,
        distance: undefined,
        kind: 'blocked',
        missingServices: missing,
        causeService: null,
        viaEntryId: null,
      })
      changed = true
    }
  }

  // 第二阶段：在完整失效集合上算距离与归因。
  // 距离取「最后失效的必需服务」+ 1；viaEntryId 始终指向距离更小的提供者，
  // 所以即使依赖成环，父链也不会自己咬住自己。
  const serviceDistance = new Map()
  const maxDistanceRounds = entries.length + lostServices.size + 1
  changed = true
  for (let round = 0; changed && round < maxDistanceRounds; round++) {
    changed = false
    for (const name of lostServices) {
      const record = services[name]
      const providers = (record?.providers ?? []).filter((id) => unavailable.has(id))
      if (providers.length === 0) continue
      let distance = 0
      let known = true
      for (const id of providers) {
        const provider = unavailable.get(id)
        if (typeof provider.distance !== 'number') {
          known = false
          break
        }
        distance = Math.max(distance, provider.distance)
      }
      if (!known) continue
      if (distance > (serviceDistance.get(name) ?? -1)) {
        serviceDistance.set(name, distance)
        changed = true
      }
    }
    for (const record of unavailable.values()) {
      if (record.kind !== 'blocked') continue
      const missing = (record.entry.requires ?? []).filter((name) => serviceDistance.has(name))
      if (missing.length === 0) continue
      let primary = missing[0]
      for (const name of missing) {
        if (serviceDistance.get(name) > serviceDistance.get(primary)) primary = name
      }
      const distance = serviceDistance.get(primary) + 1
      if (typeof record.distance === 'number' && distance <= record.distance) continue
      const providers = (services[primary]?.providers ?? []).filter((id) => unavailable.has(id))
      let via = providers[0]
      for (const id of providers) {
        if ((unavailable.get(id)?.distance ?? -1) > (unavailable.get(via)?.distance ?? -1)) via = id
      }
      record.distance = distance
      record.missingServices = missing
      record.causeService = primary
      record.viaEntryId = via
      changed = true
    }
  }

  // 兜底：只有完全脱离目标的环才可能拿不到距离；给一个可渲染的起点。
  for (const record of unavailable.values()) {
    if (record.kind !== 'blocked' || typeof record.distance === 'number') continue
    const missing = (record.entry.requires ?? []).filter((name) => lostServices.has(name))
    record.distance = 1
    record.missingServices = missing
    record.causeService = missing[0] ?? null
    record.viaEntryId = record.causeService === null
      ? null
      : (services[record.causeService]?.providers ?? []).find((id) => unavailable.has(id)) ?? null
  }

  return { unavailable, serviceDistance, baseIds }
}

/** 从不可用集合里重建一条因果路径：目标 → 服务 → 消费者 → …。 */
function pathOf(entryId, unavailable, index, maxNodes) {
  const path = []
  let current = entryId
  for (let guard = 0; current !== undefined && guard < maxNodes; guard++) {
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
function chainRowsOf(unavailable, index, maxNodes) {
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
      path: pathOf(entryId, unavailable, index, maxNodes),
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

/**
 * 名字扫得到、全局注册表里却没有时的说明。
 *
 * 这不是「失去」，也不是「归属失败」：`agent.ctx.systemPrompt.section()` 这类
 * 会话内注册、条件注册（例如只在某个工具可见时才有正文）以及本次没注册成功，
 * 都会落成这种形态。预演读的是全局注册表，无法进一步区分，所以只陈述事实。
 */
const REGISTRY_MISSING_REASON = '源码里有注册调用，但当前全局注册表没有这一项；可能是会话内（agent scope）或条件注册，或本次没有注册成功。不计入「失去」。'

/** 注册表里有这一项、但源码扫描定位不到 owner 时的说明。 */
const UNATTRIBUTED_REASON = '注册表里有这一项，但源码扫描没有定位到注册它的包'

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
      // 扫得到名字、注册表里没有：多为会话内或条件注册。它和「注册表里有、
      // 但 owner 扫不到」是两件事，不能都塞进「未归属」。
      if (row === undefined) {
        return {
          name,
          kind,
          owners: [],
          lost: false,
          shared: false,
          unknown: false,
          registryMissing: true,
          reason: REGISTRY_MISSING_REASON,
          chainOnly: false,
        }
      }
      const owners = Array.isArray(row.owners) ? row.owners : []
      const status = ownership(owners, unavailableRowIds)
      return {
        name,
        kind,
        owners,
        ...status,
        registryMissing: false,
        ...(status.unknown ? { reason: UNATTRIBUTED_REASON } : {}),
        chainOnly: status.lost && !owners.some((owner) => baseRowIds.has(owner)),
      }
    })
    const bucket = (predicate) => rows.filter(predicate).map((row) => row.name)
    return {
      owned,
      lost: bucket((row) => row.lost),
      shared: bucket((row) => row.shared),
      unknown: bucket((row) => row.unknown),
      registryMissing: bucket((row) => row.registryMissing === true),
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

  const blocked = chainRowsOf(unavailable, index, entries.length + 1)
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
    descendants,
    descendantsTruncated: false,
    chain: {
      depth: chainDepth,
      blocked,
      truncated: false,
      note: '按「所需服务的提供者全部不可用则插件不可用」规则推导',
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
        ? '未匹配到已知的消息注入来源（本插件暂时覆盖 5 类已知 kind，不代表没有注入）'
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

/**
 * 按页面区块写证据与边界。
 *
 * 顺序与页面自上而下一致，读者能在对应区块里找到这句话说的是哪一块。
 */
const SECTION_NOTES = [
  {
    id: 'target',
    area: '预禁用的插件信息',
    text: '插件、模块与层来自 Loader 行；分组行的子行按 entryId 前缀推断。',
  },
  {
    id: 'reaction',
    area: '会失去的提示词与消息内容',
    text: '工具、提示词段与上下文来自快照注册表，归属由包源码扫描补齐；消息注入按包名推断；「失去」只表示没有其他所有者，不是卸载实测；未归属与不在全局注册表的项单独列出。',
  },
  {
    id: 'chain',
    area: '受影响的下游插件',
    text: '依赖链按 fiber.inject 声明推导到不动点，服务只在提供者全部不可用时失效；结论对应禁用并重载/重启后，已激活插件可能在下一次重载前仍保留注册与工具。',
  },
  {
    id: 'graph',
    area: '依赖关系图',
    text: '上游只展开 2 层、下游按影响链完整展开；边来自 provides / requires 声明，config 引用只认完全相等的值，同组子行按 Loader id 前缀推断。',
  },
  {
    id: 'config',
    area: '配置与覆盖',
    text: '各层声明来自 patch 文件，生效值来自 Loader；读不到的层或不受支持的写法会写原因，诊断只比较、不推断各层如何合并。',
  },
  {
    id: 'page',
    area: '整页',
    text: '只读预演，不执行禁用；执行仍在插件详情控制区，由 plugin-manager 写入并审计。',
  },
]

/**
 * 关系图所需的最小快照切片。
 *
 * 影响链来自本次 disable-preview 的快照；完整链路若改用页面级的另一份快照，
 * 两次采集之间的插件增减会让两张图对不上。这里把同一份快照的 entries/services
 * 一起返回，两张图共用一份数据。
 * @param {object} snapshot - 本次预演采集的快照。
 * @returns {{entries: Array<object>, services: object}} 图数据。
 */
export function graphSlice(snapshot) {
  return {
    entries: (Array.isArray(snapshot.entries) ? snapshot.entries : []).map((entry) => ({
      entryId: entry.entryId,
      rowId: entry.rowId,
      title: entry.title,
      moduleName: entry.moduleName,
      packageName: entry.packageName,
      phase: entry.phase,
      enabled: entry.enabled,
      requires: entry.requires ?? [],
      provides: entry.provides ?? [],
      configEntries: entry.configEntries ?? [],
    })),
    services: snapshot.services ?? {},
  }
}

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
    // 影响图与完整链路共用这一份快照，避免与页面级快照的时间差。
    graph: graphSlice(snapshot),
    notes: SECTION_NOTES,
  }
}
