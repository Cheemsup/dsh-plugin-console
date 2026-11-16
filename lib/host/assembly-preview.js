/**
 * 预测一次「首条消息发出前」的装配。
 *
 * 与 loop 的区别只有一个：loop 用 `agent.ctx` 的 scope，这里用
 * `agentPresets.acquireScope(presetId)` 拿到的 preset scope。两者都是
 * `assemble({ scope })` 的合法输入——scope 决定「沿哪条链收集贡献」，
 * 而装配本身（sections/contexts/tools 的求值）走的是同一段代码。
 *
 * 因此这是**预测**而不是记录：它不产生任何会话事件，也不改变注册表。
 * @module dsh-plugin-console/host/assembly-preview
 */

import { readScopePromptOverrides } from './prompt.js'
import { classifyPreviewTools } from './tool-set.js'
import { readToolSchemas } from './tools.js'

/**
 * 找出 scope 链上声明了 `complete` 的那一段。
 *
 * complete 段一旦生效，`assemble` 就把 sections 换成「只有它」——其余段全部
 * 被丢掉，追加段落也不会出现。这不是 bug，是 system-prompt 的既定语义，
 * 但它对定制功能有决定性影响：minimal 模式就是这样，它的整份提示词就是
 * 一个 complete 段。所以这里要把它是谁标出来，前端才能如实提示，
 * 物化时也才知道那个段必须带着 complete 注册回去。
 * @param {object} systemPrompt - systemPrompt 服务。
 * @param {symbol} scopeKey - preset scope 标识。
 * @returns {string | undefined} 独占段名字。
 */
function completeSectionName(systemPrompt, scopeKey) {
  const layers = systemPrompt.layers
  if (layers === undefined || typeof layers.merge !== 'function') return undefined
  try {
    // 必须作为方法调用：merge 内部用 this.chainLayers。
    for (const [name, section] of layers.merge(scopeKey, (layer) => layer.sections)) {
      if (section?.complete === true) return name
    }
  } catch {
    // 读不到就当没有 complete 段
  }
  return undefined
}

/**
 * 从 scope 链上读取段/上下文的 order。
 *
 * `assemble()` 按 order 排好序，但不把 order 带回来；注册表 merge 能给出每个名字
 * 的 order。这里只读取、不改动装配结果，读不到就留空。
 * @param {object} systemPrompt - systemPrompt 服务。
 * @param {symbol | undefined} scopeKey - preset scope 标识。
 * @param {'sections' | 'contexts'} table - 要读的注册表。
 * @returns {Map<string, number>} 名字 → order。
 */
function orderOf(systemPrompt, scopeKey, table) {
  const result = new Map()
  const layers = systemPrompt.layers
  if (layers === undefined || typeof layers.merge !== 'function') return result
  try {
    for (const [name, item] of layers.merge(scopeKey, (layer) => layer[table])) {
      if (typeof item?.order === 'number') result.set(name, item.order)
    }
  } catch {
    // 注册表读不到时不影响装配预览
  }
  return result
}

/**
 * 取得「某个模式」的临时 scope。
 *
 * 单独抽出来是因为一次首请求预演要拿同一份 scope 做两件事：装配（sections / contexts /
 * tools）和 skill 目录快照。两边各自 `acquireScope()` 会挂两个并行 scope，注册表里同名
 * 段落的覆盖顺序也会变得不可预期，所以由编排层取一次、传下去、最后统一释放。
 * @param {object} ctx - host 插件上下文。
 * @param {string} [presetId] - 目标模式；省略则用默认模式。
 * @returns {Promise<object>} `{ presetId, scopeKey, warnings, dispose() }`。
 */
export async function acquirePresetScope(ctx, presetId) {
  const presets = ctx.get('agentPresetRegistry') ?? ctx.get('agentPresets')
  const warnings = []
  let resolved = presetId
  let acquired
  let scopeKey

  if (presets !== undefined && typeof presets.acquireScope === 'function') {
    if (typeof resolved !== 'string') {
      // 默认模式：从 roster 里找 isDefault
      try {
        const inventory = await presets.compositionInventory()
        resolved = inventory.find((mode) => mode.isDefault)?.id ?? inventory[0]?.id
      } catch {
        resolved = undefined
      }
    }
    if (typeof resolved === 'string') {
      acquired = await presets.acquireScope(resolved)
      scopeKey = acquired.key
    }
  }
  if (scopeKey === undefined) {
    warnings.push('没有可用的模式预设：本次预演只覆盖全局层，预设贡献缺失')
  }
  return {
    presetId: resolved,
    scopeKey,
    warnings,
    async dispose() {
      if (acquired !== undefined) await acquired[Symbol.asyncDispose]()
    },
  }
}

/**
 * @param {object} ctx - host 插件上下文。
 * @param {object} options - 选择项。
 * @param {string} [options.presetId] - 目标模式；省略则用默认模式。
 * @param {object} [options.scope] - 已经取得的 scope（`acquirePresetScope()` 的返回值）。
 *   传入时不再自行取得，也不在结束时释放；由调用方统一管理。
 * @param {object} [options.variableOverrides] - 补上装配结果里缺失的插值变量。
 *   只补缺失项：`assemble()` 自己给出的值优先。
 * @returns {Promise<object>} 装配结果与归因。
 */
export async function previewAssembly(ctx, options = {}) {
  const systemPrompt = ctx.get('systemPrompt')

  if (systemPrompt === undefined || typeof systemPrompt.assemble !== 'function') {
    throw new Error('systemPrompt service unavailable, cannot predict assembly')
  }

  const givenScope = options.scope
  const scope = givenScope ?? await acquirePresetScope(ctx, options.presetId)
  const { presetId, scopeKey } = scope
  const warnings = [...scope.warnings]

  try {
    const assembly = await systemPrompt.assemble(scopeKey === undefined ? {} : { scope: scopeKey })
    const completeName = completeSectionName(systemPrompt, scopeKey)
    const sectionOrder = orderOf(systemPrompt, scopeKey, 'sections')
    const contextOrder = orderOf(systemPrompt, scopeKey, 'contexts')

    const sections = (assembly.sections ?? []).map((section, index) => ({
      index,
      name: section.name,
      /** DSH 用 order 决定段落在最终提示词里的先后；它才是排序依据。 */
      order: sectionOrder.get(section.name),
      text: typeof section.text === 'string' ? section.text : '',
      length: typeof section.text === 'string' ? section.text.length : 0,
      interpolate: section.interpolate === false ? false : undefined,
      complete: section.name === completeName ? true : undefined,
    }))
    const contexts = (assembly.contexts ?? []).map((context) => ({
      name: context.name,
      order: contextOrder.get(context.name),
      text: typeof context.text === 'string' ? context.text : '',
      length: typeof context.text === 'string' ? context.text.length : 0,
      required: context.required === true ? true : undefined,
      // 预演要按同一套规则插值：`false` 的上下文是字面量，不能被 `{{}}` 改写。
      interpolate: context.interpolate === false ? false : undefined,
    }))
    const toolSchemas = (assembly.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      deferLoading: tool.deferLoading === true ? true : undefined,
    }))
    // 工具按名字来自哪一层分组：全局视图里就有的名字归全局层，只有 preset scope
    // 才有的归预设层。只看名字、不比定义——装配结果本来就取自 preset scope。
    const toolSet = classifyPreviewTools({
      tools: toolSchemas,
      global: readToolSchemas(ctx),
      preset: scopeKey === undefined ? [] : readToolSchemas(ctx, scopeKey),
    })

    // 渲染：与 renderPrompt 一致用 `\n\n` 连接，但我们**不让缺变量中断整次预览**。
    //
    // `{{model}}` / `{{provider}}` 由 agent-loop 的 variable provider 提供，取值来自
    // `context.agent.options`。没有 Agent 时它们是 undefined，`interpolate()` 会抛错。
    // 预览的价值在于「看构造」，不该因为一个未选模型就整页失败，所以这里自行插值：
    // 能解析的替换，解析不了的保留字面量并记进 unresolvedVariables，由前端标出来。
    // 变量优先用 `assemble()` 给出的值，调用方只补它缺失的那些（通常是默认模型）。
    const overrides = options.variableOverrides ?? {}
    const variables = { ...overrides, ...(assembly.variables ?? {}) }
    const unresolved = new Set()
    const renderSection = (section) => {
      if (section.interpolate === false) return section.text
      return section.text.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
        const value = variables[key]
        if (typeof value === 'string') return value
        unresolved.add(key)
        return whole
      })
    }

    const renderedSections = sections.map((section) => ({
      ...section,
      rendered: renderSection(section),
      unresolved: section.interpolate === false
        ? []
        : [...section.text.matchAll(/\{\{(\w+)\}\}/g)]
            .map((match) => match[1])
            .filter((key) => typeof variables[key] !== 'string'),
    }))

    const systemText = renderedSections
      .map((section) => section.rendered)
      .filter((text) => text.length > 0)
      .join('\n\n')

    // 逐层枚举 scope 链：哪些全局段被同名替换、哪些段只在这个 scope 出现。
    // 这是名字级事实；owner 由前端用快照里的源码扫描索引回填。
    const scopeOverrides = readScopePromptOverrides(ctx, scopeKey) ?? null

    return {
      presetId: presetId ?? null,
      scoped: scopeKey !== undefined,
      warnings,
      sections: renderedSections,
      contexts,
      tools: toolSchemas,
      variables,
      /** 插值变量里由调用方补上的键；前端据此说明「这几项不是装配给的」。 */
      predictedVariables: Object.keys(overrides).filter((key) => typeof (assembly.variables ?? {})[key] !== 'string'),
      /** 工具按名字来源分层（全局层 / 预设层 / 未分类）；口径见 classifyPreviewTools。 */
      toolSet,
      // 哪个段是 complete。有值时说明这个模式的提示词是「独占」的：
      // assemble 只保留了它一段，追加段落之类不会出现在模型看到的内容里。
      completeSection: completeName ?? null,
      /** scope 层对全局 sections / contexts 的同名替换与追加；无 scope 时为 null。 */
      scopeOverrides,
      stats: {
        sections: renderedSections.length,
        sectionChars: sections.reduce((sum, section) => sum + section.length, 0),
        contexts: contexts.length,
        contextChars: contexts.reduce((sum, context) => sum + context.length, 0),
        tools: toolSchemas.length,
        toolSchemaChars: JSON.stringify(toolSchemas).length,
      },
      systemText,
      unresolvedVariables: [...unresolved],
    }
  } finally {
    // 共享 scope 的生命周期归调用方（首请求预演要跨采集器复用同一份）。
    if (givenScope === undefined) await scope.dispose()
  }
}
