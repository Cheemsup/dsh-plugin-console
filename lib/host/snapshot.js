/**
 * 快照编排。
 *
 * 采集分八步，每一步只依赖前面几步的产物：
 *   1. profile 声明的 bundle 顺序 → 层归因优先级；
 *   2. 每个组合包插入/覆盖了哪些行；
 *   3. 用户自己的 profile / home patch；
 *   4. 逐条 Loader 行（含服务供需与统计）；
 *   5. 模式（Agent 预设）与会话归属；
 *   6. 工具注入全景（全局 ∪ 各活会话）；
 *   7. 提示词注册表与名字级归属；
 *   8. 汇总成一份可直接序列化的 JSON。
 * @module dsh-plugin-console/host/snapshot
 */

import {
  annotateSessionDiffs,
  attributeTool,
  backfillMcpTools,
  buildModeOnlyEntries,
  buildOwnerIndex,
  computePresetDifferences,
  computePresetLayer,
  matchOwners,
  scanModeOnlyModules,
} from './attribution.js'
import { collectEntries, indexRowsByModule } from './entries.js'
import { computeHealth } from './health.js'
import { collectBundles, collectUserLayers } from './layers.js'
import { readModes } from './modes.js'
import { readPromptRegistry } from './prompt.js'
import { attachScopeImpacts } from './scope-impact.js'
import { readSessions } from './sessions.js'
import { readScopedSchemas, readVisibleTools } from './tools.js'

/**
 * 采集一份完整的插件树快照。
 * @param {object} ctx - host 插件上下文。
 * @param {object} [extras] - 额外要挂进快照的东西（模板绑定等）。
 * @returns {Promise<object>} 可直接序列化为 JSON 的快照。
 */
export async function readSnapshot(ctx, extras = {}) {
  const profile = ctx.get('profileContext')
  const pluginManager = ctx.get('pluginManager')
  const packages = ctx.get('pluginPackages')

  // —— 1~3. 层：bundle 顺序、bundle 认领、用户 patch ——
  const { rowOwner, rowOverriders, layerList, enabledBundles } = await collectBundles(profile, pluginManager)
  const { userInserted, userOverrides, userLayers } = await collectUserLayers(profile)

  // —— 4. 逐条 Loader 行 ——
  const { entries, services, stats } = await collectEntries(
    ctx,
    packages,
    rowOwner,
    rowOverriders,
    userInserted,
    userOverrides,
  )

  // —— 5. 模式（Agent 预设）与会话归属 ——
  const rowsByModule = indexRowsByModule(entries)
  const modes = await readModes(ctx, rowsByModule)
  const sessionIndex = await readSessions(ctx, profile)
  stats.modes = modes.length
  stats.sessions = sessionIndex.sessions.length
  stats.liveSessions = sessionIndex.sessions.filter((session) => session.live === true).length

  // —— 6. 工具注入全景 ——
  // 全局视图（无 scope）是该部署在 agent 之外的默认工具集；
  // 某个 agent 的可见集若比它多，差额就是该 agent 的 preset scope 注入的工具。
  const globalTools = readVisibleTools(ctx) ?? []
  const liveAgents = sessionIndex.sessions
    .filter((session) => session.live === true && Array.isArray(session.runtime?.tools))
    .map((session) => ({
      sessionId: session.id,
      preset: session.runtime.preset,
      tools: session.runtime.tools,
      // restrict 之前的已知集；与 tools 的差集才是「被 restrict 过滤」。
      knownNames: session.runtime.knownNames,
    }))

  // —— 7. 提示词注册表 + 工具/区段的名字级归属 ——
  // 注册表给「有什么」，源码扫描给「谁注册的」；两边按名字连接。
  const promptRegistry = await readPromptRegistry(ctx)
  const index = buildOwnerIndex(entries)
  const { entryByRow, toolOwners, sectionOwners } = index
  // 有些插件只出现在模式声明里，不在全局条目树中（present / schedule / ask_user 都是），
  // 它们同样会注册工具与提示词，但没有任何「行」可供扫描。
  const packageRoot = await scanModeOnlyModules(entries, modes, toolOwners, sectionOwners)
  const modeOnlyEntries = packageRoot === undefined ? [] : buildModeOnlyEntries(entries, modes)
  entries.push(...modeOnlyEntries)

  // 工具集取「全局 ∪ 各活会话」的并集。
  //
  // 只看全局会漏掉一半：read / write / bash / glob 这些是模式通过 agent scope
  // 注册的，全局视图里根本不存在（实测全局 62 个、每个会话 94 个，差 32 个全是核心工具）。
  // 并集里每个工具标注它在哪些范围可见，这样「全局」与「某会话」都能对上。
  const schemaByName = new Map((promptRegistry?.tools ?? []).map((tool) => [tool.name, tool]))
  for (const agent of liveAgents) {
    const agentCtx = ctx.get('agents')?.get?.(agent.sessionId)?.ctx
    if (agentCtx === undefined) continue
    for (const schema of readScopedSchemas(ctx, agentCtx)) {
      if (!schemaByName.has(schema.name)) schemaByName.set(schema.name, schema)
    }
  }

  const toolScopes = new Map()
  for (const name of globalTools) {
    const list = toolScopes.get(name) ?? []
    list.push('global')
    toolScopes.set(name, list)
  }
  for (const agent of liveAgents) {
    for (const name of agent.tools ?? []) {
      const list = toolScopes.get(name) ?? []
      if (!list.includes('global')) list.push(agent.sessionId)
      toolScopes.set(name, list)
    }
  }
  const allToolNames = [...toolScopes.keys()]

  // 一个会话的工具集是怎么来的，需要区分三层：
  //
  //   1. 全局层：不带 scope 注册的工具，所有会话都看得到；
  //   2. 模式层：模式的声明行在 agent scope 上注册的工具。*同模式的会话共享同一份*
  //      ——`agentPresets` 的 `retain(id)` 返回同一份 generation，`bind` 只是把会话
  //      的 scope 挂到那份上，所以工具不是每个会话各建一套；
  //   3. 会话层：会话自己的 scope 注册的。实测为空——没有哪个会话注册了模式之外的工具。
  const presetLayer = computePresetLayer(modes, entries, liveAgents, globalTools)
  annotateSessionDiffs(liveAgents, presetLayer, globalTools)
  // scope 影响：活会话用自己的 agent scope；没有活会话的模式临时建 preset scope，
  // 读完立刻释放。它只回答「差集」，不推断覆盖者。
  await attachScopeImpacts(ctx, modes, liveAgents, globalTools)
  const presetDifferences = computePresetDifferences(liveAgents)

  // MCP 回填必须在归属之前：toolOwners 是一座「名字 → 行」的索引，
  // MCP 后缀反推出来的工具名要能落回 mcp-client 那一行。
  backfillMcpTools(entries, allToolNames)

  const toolsAttributed = allToolNames.map((name) => {
    const schema = schemaByName.get(name)
    return {
      name,
      ...attributeTool(name, index),
      scopes: toolScopes.get(name) ?? [],
      ...(schema === undefined
        ? {}
        : {
            description: schema.description,
            parameters: schema.parameters,
            deferLoading: schema.deferLoading,
          }),
    }
  })

  const sectionsAttributed = (promptRegistry?.sections ?? []).map((section) => ({ ...section, ...matchOwners(sectionOwners, section.name, entryByRow) }))
  const contextsAttributed = (promptRegistry?.contexts ?? []).map((context) => ({ ...context, ...matchOwners(sectionOwners, context.name, entryByRow) }))

  stats.entries = entries.length
  stats.plugins = entries.length
  stats.modeOnly = modeOnlyEntries.length
  stats.tools = allToolNames.length
  stats.toolsGlobal = globalTools.length
  stats.promptSections = sectionsAttributed.length
  stats.toolsAttributed = toolsAttributed.filter((tool) => tool.owners.length > 0).length
  stats.sectionsAttributed = sectionsAttributed.filter((section) => section.owners.length > 0).length

  // MCP 连接状态是同步事实，失败项进关注列表；服务缺席或读取失败不阻塞快照。
  let mcpServers = []
  try {
    mcpServers = ctx.get('mcpManager')?.list?.() ?? []
  } catch {
    mcpServers = []
  }

  // 健康摘要只聚合已采集到的静态事实：失败、缺服务、归属盲区、条件禁用、MCP 故障。
  // 它不读 session log，因此可以跟着快照一起刷新，不会把首屏拖慢。
  const { summary: health, attention } = computeHealth({
    entries,
    services,
    tools: { attributed: toolsAttributed },
    prompt: { sections: sectionsAttributed, contexts: contextsAttributed },
    mcp: mcpServers,
  })

  return {
    generatedAt: new Date().toISOString(),
    profile: {
      name: profile?.name ?? null,
      dir: profile?.dir ?? null,
      home: profile?.home ?? null,
      bundles: enabledBundles,
    },
    layers: layerList,
    userLayers,
    stats,
    health,
    attention,
    entries,
    services,
    modes,
    workspaces: sessionIndex.workspaces,
    ungroupedSessions: sessionIndex.ungrouped,
    dispatch: sessionIndex.dispatch,
    tools: {
      global: globalTools,
      liveAgents,
      attributed: toolsAttributed,
      /** 模式层：每个模式在 agent scope 上挂的工具。 */
      presetLayer: [...presetLayer.entries()].map(([id, layer]) => ({ presetId: id, ...layer })),
      /** 同模式会话之间的实际差异；空数组表示所有同模式会话完全一致。 */
      presetDifferences,
    },
    prompt: {
      sections: sectionsAttributed,
      contexts: contextsAttributed,
      // 名字 → 产出它的模块。会话级上下文与消息注入不在全局注册表里，
      // 但它们的名字仍写在包源码中，这份索引让按会话懒读到的条目也能归属。
      nameOwners: Object.fromEntries(sectionOwners),
    },
    // 模板绑定：哪些会话绑了模板、现在是否启用。会话页的开关读这一份。
    bindings: extras.bindings ?? {},
    // 模板列表本身也带上，会话页要显示「绑的是哪个模板」而不只是 id。
    templates: extras.templates ?? [],
  }
}
