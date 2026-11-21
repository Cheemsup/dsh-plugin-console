/**
 * 名字级归属：把注册表里的名字连回「谁注册的」。
 *
 * 运行时只能回答「有哪些工具/区块」，回答不了「谁注册的」——注册表不记 owner。
 * 答案在包源码里（见 `source-scan.js`），这里的职责是把两边按名字连接起来：
 * 完全同名 → 模板前缀 → MCP 工具名规则，三种匹配逐级降级。
 * @module dsh-plugin-console/host/attribution
 */

import { categorize } from './categorize.js'
import { scanPackageRegistrations } from './source-scan.js'

/**
 * 建立「名字 → 注册它的行」索引。
 *
 * 一行可能有多个名字，一个名字也可能来自多行（例如 PTC 与 native 都注册 grep）。
 * @param {Array<object>} entries - 已采集条目。
 * @returns {{entryByRow: Map<string, object>, toolOwners: Map<string, string[]>, sectionOwners: Map<string, string[]>, mcpServerRow: Map<string, string>}} 四张索引。
 */
export function buildOwnerIndex(entries) {
  const entryByRow = new Map(entries.map((entry) => [entry.rowId, entry]))

  /** 名字 → 注册它的条目（一行可能有多个，例如 PTC 与 native 都注册 grep）。 */
  const toolOwners = new Map()
  const sectionOwners = new Map()
  for (const entry of entries) {
    for (const name of entry.registrations?.tools ?? []) {
      const list = toolOwners.get(name) ?? []
      list.push(entry.rowId)
      toolOwners.set(name, list)
    }
    for (const name of entry.registrations?.sections ?? []) {
      const list = sectionOwners.get(name) ?? []
      list.push(entry.rowId)
      sectionOwners.set(name, list)
    }
    for (const name of entry.registrations?.contexts ?? []) {
      const list = sectionOwners.get(name) ?? []
      list.push(entry.rowId)
      sectionOwners.set(name, list)
    }
  }

  /** MCP 工具的名字形如 `mcp__<server>__<tool>`，据此归到对应的 mcp-client 行。 */
  const mcpServerRow = new Map()
  for (const entry of entries) {
    if (!entry.moduleName.includes('mcp-client')) continue
    const serverName = entry.mcpServerName
    if (typeof serverName === 'string') mcpServerRow.set(serverName, entry.rowId)
  }

  return { entryByRow, toolOwners, sectionOwners, mcpServerRow }
}

/**
 * 名字级归属。
 *
 * 先找完全同名的来源；找不到再找模板来源（源码里写的是 `mcp:${server}`，
 * 注册表里落成 `mcp:firecrawl`），按 `${}` 之前的前缀匹配。
 * @param {Map<string, string[]>} owners - 名字 → 行 id。
 * @param {string} name - 注册表里的实际名字。
 * @param {Map<string, object>} entryByRow - 行 id → 条目。
 * @returns {{owners: string[], via: string}} 归属结果。
 */
export function matchOwners(owners, name, entryByRow) {
  const exact = owners.get(name)
  if (exact !== undefined) return { owners: exact, via: 'source' }
  for (const [pattern, rowIds] of owners) {
    const cut = pattern.indexOf('${')
    if (cut <= 0 || !name.startsWith(pattern.slice(0, cut))) continue
    // 模板里 `${}` 之后的字面尾巴（若有）也要对上，避免 mcp:${a} 吃掉 mcp:xyz
    const tail = pattern.slice(pattern.indexOf('}') + 1)
    if (tail !== '' && !name.endsWith(tail)) continue
    // `mcp:${server}` 这类模板，只归给 serverName 与之相符的那一条
    const narrowed = rowIds.filter((rowId) => {
      const serverName = entryByRow.get(rowId)?.mcpServerName
      if (typeof serverName !== 'string') return rowIds.length === 1
      return name === `${pattern.slice(0, cut)}${serverName}${tail}`
    })
    if (narrowed.length > 0) return { owners: narrowed, via: 'template' }
    return { owners: rowIds, via: 'template' }
  }
  return { owners: [], via: 'unknown' }
}

/**
 * 把源码扫描得到的注册名展开成注册表里的实际名字。
 *
 * 源码里写的是模板（`mcp:${server}`），注册表里落成具体值（`mcp:firecrawl`）。
 * 直接拿模板当键查注册表永远查不到，每个 MCP 客户端都会显示成同一条「未归属」
 * 的模板名，点开也无从定位。模板规则与 {@link matchOwners} 同向：只按 `${`
 * 前的前缀与 `}` 后的尾巴匹配；条目带 serverName 时收窄到这一个实际名。
 * @param {string} name - 源码里写的注册名。
 * @param {object} entry - 注册它的条目（用于取 mcpServerName）。
 * @param {Map<string, object>} registryNames - 注册表：实际名字 → 行。
 * @returns {string[]} 注册表里的实际名字；匹配不到时保留可读的具体名或原模板名。
 */
export function expandRegistrationName(name, entry, registryNames) {
  if (registryNames.has(name)) return [name]
  const cut = name.indexOf('${')
  if (cut <= 0) return [name]
  const close = name.indexOf('}', cut)
  if (close < 0) return [name]
  const prefix = name.slice(0, cut)
  const tail = name.slice(close + 1)
  const serverName = typeof entry?.mcpServerName === 'string' ? entry.mcpServerName : undefined
  const matches = [...registryNames.keys()].filter((actual) => (
    actual.length >= prefix.length + tail.length
    && actual.startsWith(prefix)
    && actual.endsWith(tail)
    && (serverName === undefined || actual === prefix + serverName + tail)
  ))
  if (matches.length > 0) return matches
  // 注册表里没有对应项（插件没注册成功）时，至少把 `${server}` 填成具体服务名，
  // 界面才能指出是哪一条；否则每个 MCP 客户端都显示同一个 `mcp:${server}`。
  if (serverName !== undefined && name.slice(cut + 2, close) === 'server') return [prefix + serverName + tail]
  return [name]
}

/**
 * 归因一个工具名：先按源码名字，再按 MCP 工具名规则。
 * @param {string} toolName - 工具名。
 * @param {{toolOwners: Map<string, string[]>, mcpServerRow: Map<string, string>, entryByRow: Map<string, object>}} index - 名字索引。
 * @returns {{owners: string[], via: string}} 归属结果。
 */
export function attributeTool(toolName, index) {
  const direct = matchOwners(index.toolOwners, toolName, index.entryByRow)
  if (direct.owners.length > 0) return direct
  const mcp = toolName.match(/^mcp__(.+?)__/)
  if (mcp !== null) {
    const rowId = index.mcpServerRow.get(mcp[1])
    if (rowId !== undefined) return { owners: [rowId], via: 'mcp-server' }
    return { owners: [], via: 'mcp-unmatched' }
  }
  return { owners: [], via: 'unknown' }
}

/**
 * 为「只出现在模式声明里的模块」补扫源码，并登记它们注册的名字。
 *
 * 这些插件确实装在这台机器上（present / schedule_create / ask_user_question
 * 都由它们注册），只是没有自己的 Loader 行——模式在会话里挂载它们。包根目录
 * 可以从任一条目的 packageDir 推出（条目都在同一个 node_modules 下）。
 * @param {Array<object>} entries - 全局条目（会被就地补 registry）。
 * @param {Array<object>} modes - 模式列表（会被就地补 registry）。
 * @param {Map<string, string[]>} toolOwners - 工具归属索引（会被就地补）。
 * @param {Map<string, string[]>} sectionOwners - 段落归属索引（会被就地补）。
 * @returns {Promise<string | undefined>} 推测出的包根目录。
 */
export async function scanModeOnlyModules(entries, modes, toolOwners, sectionOwners) {
  const sampleDir = entries.find((entry) => typeof entry.packageDir === 'string')?.packageDir
  const packageRoot = typeof sampleDir === 'string'
    ? sampleDir.replace(/[\\/][^\\/]+$/, '')
    : undefined
  if (packageRoot === undefined) return undefined

  const scanned = new Set(entries.map((entry) => entry.moduleName))
  for (const mode of modes) {
    for (const row of mode.rows ?? []) {
      const moduleName = row.moduleName
      if (typeof moduleName !== 'string' || scanned.has(moduleName)) continue
      scanned.add(moduleName)
      const bare = moduleName.replace(/^@[^/]+\//, '')
      const registrations = await scanPackageRegistrations(`${packageRoot}/${bare}`)
      row.registry = registrations.tools.length + registrations.sections.length + registrations.contexts.length > 0
        ? registrations
        : undefined
      for (const name of registrations.tools) {
        const list = toolOwners.get(name) ?? []
        if (!list.includes(moduleName)) list.push(moduleName)
        toolOwners.set(name, list)
      }
      for (const name of [...registrations.sections, ...registrations.contexts]) {
        const list = sectionOwners.get(name) ?? []
        if (!list.includes(moduleName)) list.push(moduleName)
        sectionOwners.set(name, list)
      }
    }
  }
  return packageRoot
}

/**
 * 把只出现在模式声明里的模块补成「合成条目」。
 *
 * 它们确实装在这台机器上（present / schedule_create / ask_user_question 都由它们注册），
 * 只是没有自己的 Loader 行——模式在会话里挂载它们。不补进来的话，
 * 插件视图里搜不到它们，工具页上的归属标签也点不到落点。
 * @param {Array<object>} entries - 全局条目（用于判断哪些模块已经有行）。
 * @param {Array<object>} modes - 模式列表（行上的 registry 来自 {@link scanModeOnlyModules}）。
 * @returns {Array<object>} 合成条目列表。
 */
export function buildModeOnlyEntries(entries, modes) {
  const known = new Set(entries.map((entry) => entry.moduleName))
  const covered = new Set()
  for (const mode of modes) {
    for (const row of mode.rows ?? []) {
      const moduleName = row.moduleName
      if (typeof moduleName !== 'string' || known.has(moduleName) || row.registry === undefined) continue
      covered.add(moduleName)
    }
  }

  const modeOnlyEntries = []
  for (const moduleName of covered) {
    const modeIds = modes
      .filter((mode) => (mode.rows ?? []).some((row) => row.moduleName === moduleName))
      .map((mode) => mode.id)
    const registry = modes
      .flatMap((mode) => mode.rows ?? [])
      .find((row) => row.moduleName === moduleName)?.registry
    modeOnlyEntries.push({
      entryId: `mode:${moduleName}`,
      rowId: moduleName,
      depth: 1,
      moduleName,
      packageName: moduleName,
      version: undefined,
      title: undefined,
      description: undefined,
      layer: 'mode',
      layerVersion: undefined,
      overriddenBy: [],
      userInserted: false,
      face: 'host',
      enabled: true,
      inheritedDisabled: false,
      phase: null,
      requires: [],
      provides: [],
      clientInject: [],
      clientExternal: [],
      configKeys: [],
      effects: [],
      registrations: registry,
      // 合成条目也要带注册点：模式专属插件的提示词同样需要判断作用域。
      registrationSites: registry?.sites ?? [],
      category: categorize(moduleName, registry),
      modeOnly: true,
      modeIds,
    })
  }
  return modeOnlyEntries
}

/**
 * 计算「模式层」工具集：每个模式在 agent scope 上挂的工具。
 *
 * 这一层不能靠「全局视图里没有」来判断，那样会把整层误标成「会话私有」。
 * 这里用实测：从同模式的一个活会话取 `tools − global`，再与其它会话两两比对，
 * 只有真的对不上的部分才算会话差异。
 * @param {Array<object>} modes - 模式列表（`mode.tools` 会被就地写入）。
 * @param {Array<object>} entries - 全局条目（含合成条目）。
 * @param {Array<object>} liveAgents - 活会话的工具快照。
 * @param {string[]} globalTools - 全局可见工具名。
 * @returns {Map<string, object>} presetId → 模式层。
 */
export function computePresetLayer(modes, entries, liveAgents, globalTools) {
  const presetLayer = new Map()
  for (const mode of modes) {
    const peers = liveAgents.filter((agent) => agent.preset === mode.id)
    const fromLive = peers.length > 0
      ? peers[0].tools.filter((name) => !globalTools.includes(name))
      : undefined
    const fromScan = new Set()
    for (const row of mode.rows ?? []) {
      const entry = entries.find((candidate) => candidate.rowId === row.entryId)
        ?? entries.find((candidate) => candidate.moduleName === row.moduleName)
      for (const name of (row.registry ?? entry?.registrations)?.tools ?? []) fromScan.add(name)
    }
    presetLayer.set(mode.id, {
      /** 实测优先；没有活会话时退回源码扫描的结果。 */
      tools: fromLive ?? [...fromScan],
      measured: fromLive !== undefined,
      /** 声明行里注册了、但实测没出现的：被平台条件跳过或被 restrict 挡掉。 */
      absent: fromLive === undefined ? [] : [...fromScan].filter((name) => !fromLive.includes(name)),
      /** 实测出现了、但声明行的注册记录里找不到的：动态注册或扫描盲区。 */
      unlisted: fromLive === undefined ? [] : fromLive.filter((name) => !fromScan.has(name)),
      sessions: peers.map((agent) => agent.sessionId),
    })
    mode.tools = presetLayer.get(mode.id).tools
  }
  return presetLayer
}

/**
 * 把每个活会话的工具集与「全局 + 模式」对比，得出会话级差异。
 * @param {Array<object>} liveAgents - 活会话的工具快照（会被就地补 extra/missing/hidden）。
 * @param {Map<string, object>} presetLayer - 模式层。
 * @param {string[]} globalTools - 全局可见工具名。
 * @returns {void}
 */
export function annotateSessionDiffs(liveAgents, presetLayer, globalTools) {
  for (const agent of liveAgents) {
    const layer = presetLayer.get(agent.preset)
    // 只有「同模式会话之间真的不一样」的那部分才算会话差异。
    agent.extra = layer === undefined ? [] : agent.tools.filter((name) => !globalTools.includes(name) && !layer.tools.includes(name))
    agent.missing = layer === undefined ? [] : layer.tools.filter((name) => !agent.tools.includes(name))
    // 「被 restrict 过滤」必须用 knownNames − visible：同名替换不会让名字消失，
    // 「全局可见 − 会话可见」会把这种替换误报成遮蔽。
    const known = Array.isArray(agent.knownNames) ? agent.knownNames : globalTools
    agent.hidden = known.filter((name) => !agent.tools.includes(name))
  }
}

/**
 * 同模式会话之间是否真的存在差异——这是回答「是不是每个会话一套」的直接证据。
 * @param {Array<object>} liveAgents - 活会话的工具快照。
 * @returns {Array<{presetId: string, sessions: number, divergent: string[]}>} 差异摘要。
 */
export function computePresetDifferences(liveAgents) {
  const presetIds = new Set(liveAgents.map((agent) => agent.preset))
  const presetDifferences = []
  for (const presetId of presetIds) {
    const peers = liveAgents.filter((agent) => agent.preset === presetId)
    if (peers.length < 2) continue
    const first = new Set(peers[0].tools)
    const divergent = peers.filter((agent) => {
      const set = new Set(agent.tools)
      return set.size !== first.size || [...set].some((name) => !first.has(name))
    })
    presetDifferences.push({ presetId, sessions: peers.length, divergent: divergent.map((agent) => agent.sessionId) })
  }
  return presetDifferences
}

/**
 * MCP 客户端的工具是运行时从 server 拉取后动态注册的，源码里没有字面量，
 * 静态扫描必然为空。改为按 serverName 前缀从工具集里反推，补回 registrations.tools，
 * 让插件详情页也能列出这些工具。
 * @param {Array<object>} entries - 条目（会被就地补 registrations.tools）。
 * @param {string[]} allToolNames - 全局与会话可见集的并集。
 * @returns {void}
 */
export function backfillMcpTools(entries, allToolNames) {
  for (const entry of entries) {
    const serverName = entry.mcpServerName
    if (typeof serverName !== 'string') continue
    const owned = allToolNames.filter((name) => name.startsWith(`mcp__${serverName}__`))
    if (owned.length === 0) continue
    entry.registrations = { ...entry.registrations, tools: owned }
  }
}
