/**
 * 一个会话的「首次请求」摘要。
 *
 * 插件控制台现有的提示词视图看的是**注册表与预设装配**：全局段、预设段、模式工具。
 * 但一个插件影响模型的方式远不止这些——它还可以往会话里写 user-role 消息
 * （运行时上下文、时间快照、skill 目录）、在派发时改写首条任务、发起额外的
 * LLM 请求（标题、压缩），或者在 agent scope 上注册只对这个会话生效的段。
 *
 * 这些事实都落进了 session log，却没有任何一条经过注册表。所以这里直接读
 * 会话事件（活会话走内存，冷会话走 sessionPersistence 的读句柄），把**首个
 * request/header 之前**的那一次请求提取出来，再与预设基线做差分。
 *
 * 只做读取，不改任何状态；数据量大，所以按会话懒读取，不进整份快照。
 * @module dsh-plugin-console/host/session-influence
 */

import { previewAssembly } from './assembly-preview.js'
import { scopeKeyOf } from './fiber.js'
import { readSessionEvents } from './session-events.js'
import { classifyToolSchemas, toolSchemaOf } from './tool-set.js'

/** 单块文本/单个字段的展示上限；超过只保留前缀并标记 truncated。 */
const TEXT_LIMIT = 8000
/**
 * system 提示词是「首次请求分析」的主体，单独给更高的上限。
 *
 * 普通上限 8000 字会把 10KB 量级的 system 截掉尾部，用户会看到「原文」比
 * 「组成」少了几段——那不是内容差异，只是被截断了。
 */
const SYSTEM_TEXT_LIMIT = 200000

/** 消息 source.kind → 产出它的包。没有映射的 kind 留空，由名字归属兜底。 */
const SOURCE_OWNERS = {
  'runtime-context': ['@deepseek-ai/dsh-agent-loop'],
  'time-context': ['@deepseek-ai/dsh-time-context'],
  'skill-catalog': ['@deepseek-ai/dsh-tool-skill'],
  'agent-message': ['@deepseek-ai/dsh-subagent'],
  'subagent-settled': ['@deepseek-ai/dsh-subagent'],
}

/** 截断一个字符串，保留可读前缀。 */
function clip(text, limit = TEXT_LIMIT) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= limit) return { text: value, length: value.length, truncated: false }
  return { text: value.slice(0, limit), length: value.length, truncated: true }
}

/** 把一条 user/message 的 content 块整理成可传输的形状。 */
function blocksOf(content) {
  const blocks = []
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const clipped = clip(block.text)
      blocks.push({ type: 'text', ...clipped })
      continue
    }
    blocks.push({ type: typeof block?.type === 'string' ? block.type : 'unknown' })
  }
  return blocks
}

/** 一条 user/message 的摘要，包括 source 归属。 */
function messageOf(event, header) {
  const data = event.data ?? {}
  const source = data.source ?? {}
  const blocks = blocksOf(data.content)
  const text = blocks.map((block) => block.text ?? '').join('\n\n')
  const kind = typeof source.kind === 'string' ? source.kind : 'unknown'
  // 子 Agent 的首条任务由 subagent manager 在派发时追加返回指引。它没有
  // 独立的 source.kind，只能按 header.origin + 文本前缀识别。
  if (kind === 'user' && header?.origin === 'subagent') {
    for (const block of blocks) {
      if (block.type === 'text' && block.text?.startsWith('Your parent agent id is ')) {
        block.injectedBy = '@deepseek-ai/dsh-subagent'
        block.injection = 'continuable-return-guidance'
      }
    }
  }
  return {
    seq: event.seq,
    time: event.time,
    sourceKind: kind,
    form: typeof source.form === 'string' ? source.form : undefined,
    senderSessionId: typeof source.senderSessionId === 'string' ? source.senderSessionId : undefined,
    summary: typeof source.summary === 'string' ? source.summary : undefined,
    owner: SOURCE_OWNERS[kind] ?? [],
    blocks,
    ...clip(text),
  }
}

/** 额外 LLM 请求（标题、压缩等）的摘要；事件名以 `-llm-request` 结尾。 */
function auxiliaryOf(event) {
  const data = event.data ?? {}
  const system = typeof data.system === 'string' ? data.system : ''
  const messages = Array.isArray(data.messages) ? data.messages : []
  const provider = typeof data.titleProvider === 'string' ? data.titleProvider : undefined
  return {
    type: event.type,
    seq: event.seq,
    time: event.time,
    provider,
    route: data.route,
    maxTokens: data.maxTokens,
    messageSeqs: Array.isArray(data.messageSeqs) ? data.messageSeqs : undefined,
    system: clip(system),
    messageCount: messages.length,
    messages: messages.slice(0, 4).map((message) => {
      const raw = JSON.stringify(message)
      return { role: message?.role, length: raw.length, preview: raw.slice(0, 240) }
    }),
    owner: provider === undefined ? [] : ['@deepseek-ai/dsh-' + provider],
  }
}

/**
 * 纯函数：把一段会话事件整理成**首次请求**摘要。
 *
 * 摘要必须锚定在首个 `request/header` 之前：同一份日志里每一步都会再写
 * system/message 与 header，取最后一次会把「首次请求分析」变成最后一次请求的快照
 * （模板开关之后系统提示词确实会变）。
 * @param {string} sessionId - 会话 id。
 * @param {object | undefined} header - 会话 header（日志首事件或 session.header）。
 * @param {Array<object>} events - 会话事件。
 * @returns {object} 首次请求摘要。
 */
export function summarizeSessionEvents(sessionId, header, events) {
  const counts = {}
  const systemNodes = []
  let firstUser
  let otherUserCount = 0
  let runtimeContext
  let runtimeContextCount = 0
  let timeContext
  let timeContextCount = 0
  let skillCatalog
  let requestHeader
  let requestContext
  let descriptor
  let catalog
  let firstHeaderSeq
  const injections = []
  const auxiliary = []

  for (const event of Array.isArray(events) ? events : []) {
    const type = typeof event?.type === 'string' ? event.type : 'unknown'
    counts[type] = (counts[type] ?? 0) + 1
    // 首个请求 header 之后的事件仍计入 counts 与额外 LLM 请求，但不进入摘要正文。
    const beforeFirstRequest = firstHeaderSeq === undefined

    if (type === 'system/message') {
      if (!beforeFirstRequest) continue
      const message = event.data?.message ?? {}
      const text = (Array.isArray(message.content) ? message.content : [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n\n')
      systemNodes.push({ seq: event.seq, time: event.time, ...clip(text, SYSTEM_TEXT_LIMIT) })
      continue
    }

    if (type === 'user/message') {
      if (!beforeFirstRequest) {
        otherUserCount++
        continue
      }
      const message = messageOf(event, header)
      if (message.sourceKind === 'runtime-context') {
        runtimeContextCount++
        runtimeContext = {
          seq: message.seq,
          time: message.time,
          sections: Array.isArray(event.data?.source?.sections)
            ? event.data.source.sections.map((section) => ({
                name: section?.name,
                ...clip(section?.text),
              }))
            : [],
          owner: message.owner,
        }
        continue
      }
      if (message.sourceKind === 'time-context') {
        timeContextCount++
        timeContext = {
          seq: message.seq,
          time: message.time,
          sections: Array.isArray(event.data?.source?.sections)
            ? event.data.source.sections.map((section) => ({
                name: section?.name,
                ...clip(section?.text),
              }))
            : [],
          owner: message.owner,
        }
        continue
      }
      if (message.sourceKind === 'skill-catalog') {
        skillCatalog = {
          seq: message.seq,
          time: message.time,
          entries: Array.isArray(event.data?.source?.entries)
            ? event.data.source.entries.map((entry) => ({
                name: entry?.name,
                description: entry?.description,
              }))
            : [],
          owner: message.owner,
        }
        continue
      }
      if (message.sourceKind === 'user') {
        if (firstUser === undefined) firstUser = message
        else otherUserCount++
        continue
      }
      if (injections.length < 20) injections.push(message)
      continue
    }

    if (type === 'request/header') {
      if (!beforeFirstRequest) continue
      firstHeaderSeq = event.seq
      const value = event.data?.header ?? {}
      const toolSchemas = Array.isArray(value.tools)
        ? value.tools.map(toolSchemaOf).filter((tool) => tool !== undefined)
        : []
      requestHeader = {
        seq: event.seq,
        time: event.time,
        config: value.config ?? {},
        toolCount: toolSchemas.length,
        tools: toolSchemas.map((tool) => tool.name),
        /** 实际请求里的完整工具定义；日志里本来就有，不只名字。 */
        toolSchemas,
      }
      continue
    }

    if (type === 'request/context') {
      // 首个 header 之后紧跟着的就是它的 context；后续步骤的 context 不再覆盖。
      if (requestContext !== undefined) continue
      requestContext = {
        seq: event.seq,
        time: event.time,
        provider: event.data?.provider,
        model: event.data?.model,
        contextWindow: event.data?.contextWindow,
      }
      continue
    }

    if (type === 'subagent/descriptor') {
      descriptor = event.data
      continue
    }

    if (type === 'subagent/catalog') {
      catalog = event.data
      continue
    }

    if (type.endsWith('-llm-request') && auxiliary.length < 10) auxiliary.push(auxiliaryOf(event))
  }

  // 首个请求前可能有多次 system/message（in-history 更新），最后一条才是生效的那份。
  const firstRequestSystem = systemNodes[systemNodes.length - 1]
  return {
    available: true,
    sessionId,
    header: {
      id: header?.id ?? sessionId,
      cwd: header?.cwd,
      parentSession: header?.parentSession,
      origin: header?.origin,
      delegationDepth: header?.delegationDepth,
      agentPreset: header?.agentPreset,
      isSeeded: header?.isSeeded,
      createdAt: header?.createdAt,
    },
    eventCounts: counts,
    system: {
      count: systemNodes.length,
      length: firstRequestSystem?.length ?? 0,
      text: firstRequestSystem?.text ?? '',
      truncated: firstRequestSystem?.truncated === true,
      /** 展示上限；前端据此说明截断，而不是让用户以为内容少了。 */
      limit: SYSTEM_TEXT_LIMIT,
      nodes: systemNodes.slice(-5),
    },
    firstUser,
    otherUserCount,
    runtimeContext: runtimeContext === undefined
      ? undefined
      : { ...runtimeContext, count: runtimeContextCount },
    timeContext: timeContext === undefined ? undefined : { ...timeContext, count: timeContextCount },
    skillCatalog,
    injections,
    request: { header: requestHeader, context: requestContext },
    auxiliary,
    subagent: {
      ...(descriptor === undefined ? {} : { descriptor }),
      ...(catalog === undefined ? {} : { catalog }),
    },
  }
}

/**
 * 读一个活 agent 当前 scope 的真实装配。
 *
 * 与 `previewAssembly` 的区别：这里用 agent 自己的 scope，而不是预设的
 * `acquireScope`。因此 agent scope 上注册的段/上下文（模板覆盖、
 * `subagent:delegation`、条件注入）都会出现；`assemble()` 也会跑
 * `system-prompt/assemble` waterfall，拿到的是与下一次请求最接近的结果。
 *
 * 只读：不修改注册表；失败返回 undefined，由调用方降级。
 * @param {object} ctx - host 插件上下文。
 * @param {object} agent - 活 agent。
 * @returns {Promise<object | undefined>} `{ sections, contexts, tools, completeSection }`。
 */
async function liveAssemblyOf(ctx, agent) {
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined || typeof systemPrompt.assemble !== 'function') return undefined
  const scope = scopeKeyOf(agent?.ctx)
  if (scope === undefined) return undefined

  const assembly = await systemPrompt.assemble({ scope, agent })
  const sections = (assembly.sections ?? []).map((section) => ({
    name: section.name,
    text: typeof section.text === 'string' ? section.text : '',
    length: typeof section.text === 'string' ? section.text.length : 0,
    interpolate: section.interpolate === false ? false : undefined,
  }))
  const contexts = (assembly.contexts ?? []).map((context) => ({
    name: context.name,
    text: typeof context.text === 'string' ? context.text : '',
    length: typeof context.text === 'string' ? context.text.length : 0,
    required: context.required === true ? true : undefined,
  }))
  let completeSection
  const layers = systemPrompt.layers
  if (layers !== undefined && typeof layers.merge === 'function') {
    try {
      for (const [name, section] of layers.merge(scope, (layer) => layer.sections)) {
        if (section?.complete === true) {
          completeSection = name
          break
        }
      }
    } catch {
      // 读不到独占段不影响其余装配结果
    }
  }
  return {
    scoped: true,
    completeSection,
    sections,
    contexts,
    sectionCount: sections.length,
    contextCount: contexts.length,
    tools: Array.isArray(assembly.tools)
      ? assembly.tools.map((tool) => tool?.name).filter((name) => typeof name === 'string')
      : [],
  }
}

/**
 * 读全局层的工具 schema，用于判断实际请求里的定义来自哪一层。
 *
 * `tools.schemas()` 不传 scope 就是 global 视图；服务缺席或读取失败时返回空，
 * 分类会退化成「未分类」，不影响实际 schema 的展示。
 * @param {object} ctx - host 插件上下文。
 * @returns {Array<object>} 全局工具 schema。
 */
function readGlobalToolSchemas(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.schemas !== 'function') return []
  try {
    return (tools.schemas() ?? []).map(toolSchemaOf).filter((tool) => tool !== undefined)
  } catch {
    return []
  }
}

/**
 * 读取一个会话的首次请求摘要，并与预设基线做差分。
 *
 * 预测只覆盖「预设 scope 下的装配」；实际多出来的段/上下文/工具正是
 * 会话级注册、消息注入与派发改写的落点，所以差分本身比绝对值更有信息量。
 * @param {object} ctx - host 插件上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<object>} 首次请求摘要；不可读时返回 `{ available: false, reason }`。
 */
export async function readSessionInfluence(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { available: false, reason: '缺少 session id' }
  }
  let captured
  try {
    captured = await readSessionEvents(ctx, sessionId)
  } catch (error) {
    return {
      available: false,
      reason: '读取会话日志失败：' + (error instanceof Error ? error.message : String(error)),
    }
  }
  if (captured === undefined) {
    return { available: false, reason: '这个部署没有可读的会话持久化或活会话' }
  }

  const summary = summarizeSessionEvents(sessionId, captured.header, captured.events)
  summary.source = captured.source
  const actualSchemas = summary.request.header?.toolSchemas ?? []
  const globalSchemas = readGlobalToolSchemas(ctx)
  let presetSchemas = []

  // 活会话多一份「当前 scope 实际装配」：比日志更完整，因为 agent scope 上的
  // 段/上下文在日志里只剩最终系统提示词，名字与归属都丢了。
  if (captured.agent !== undefined) {
    try {
      const assembly = await liveAssemblyOf(ctx, captured.agent)
      if (assembly !== undefined) summary.assembly = assembly
    } catch (error) {
      summary.assemblyError = error instanceof Error ? error.message : String(error)
    }
  }

  try {
    const preview = await previewAssembly(ctx, { presetId: summary.header.agentPreset })
    presetSchemas = preview.tools ?? []
    const predictedTools = preview.tools.map((tool) => tool.name)
    const actualTools = summary.request.header?.tools ?? []
    const predictedContexts = preview.contexts.map((context) => context.name)
    const predictedSections = preview.sections.map((section) => section.name)
    const actualContexts = (summary.assembly?.contexts ?? summary.runtimeContext?.sections ?? [])
      .map((section) => section.name)
      .filter((name) => typeof name === 'string')
    const actualSections = (summary.assembly?.sections ?? []).map((section) => section.name)
    summary.predicted = {
      presetId: preview.presetId,
      scoped: preview.scoped === true,
      warnings: preview.warnings ?? [],
      sectionCount: preview.sections.length,
      sections: predictedSections,
      systemLength: preview.systemText.length,
      toolCount: predictedTools.length,
      tools: predictedTools,
      contexts: predictedContexts,
    }
    summary.diff = {
      systemLengthDelta: summary.system.length - preview.systemText.length,
      toolsOnlyActual: actualTools.filter((name) => !predictedTools.includes(name)),
      toolsOnlyPredicted: predictedTools.filter((name) => !actualTools.includes(name)),
      sectionsOnlyActual: actualSections.filter((name) => !predictedSections.includes(name)),
      sectionsOnlyPredicted: predictedSections.filter((name) => !actualSections.includes(name)),
      contextsOnlyActual: actualContexts.filter((name) => !predictedContexts.includes(name)),
      contextsOnlyPredicted: predictedContexts.filter((name) => !actualContexts.includes(name)),
    }
  } catch (error) {
    summary.predictionError = error instanceof Error ? error.message : String(error)
  }

  // 实际 schema 已经由日志给出；这里只补「它更像哪一层的定义」。
  // 归组是当前注册表下的推断，不改变日志事实。
  if (actualSchemas.length > 0) {
    summary.toolSet = classifyToolSchemas({
      actual: actualSchemas,
      global: globalSchemas,
      preset: presetSchemas,
      agentNames: summary.assembly?.tools ?? [],
    })
  }

  return summary
}
