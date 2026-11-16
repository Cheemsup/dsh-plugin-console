/**
 * 把一份提示词模板 recipe 叠加到**预演结果**上。
 *
 * 这一层只做纯投影：不注册 section/context、不写 session log、不创建 Agent。
 * 真实会话的同一份语义由 `templates/materialize.js` + `templates/message-overlay.js`
 * 落地；两边的条目过滤与目录帧共用 `catalog.js`，避免预演与实测漂移。
 * @module dsh-plugin-console/host/recipe-overlay
 */

import { applyCatalogOverrides, renderCatalogMessage } from './catalog.js'
import { RUNTIME_CONTEXT_PREFIX } from './preview-contexts.js'

/** 追加段落的名字与位置，与物化时保持一致（DSH 最高段 order 是 10200）。 */
const APPEND_SECTION = 'template:extra'
const APPEND_ORDER = 20000

/** 把 `template` 加进依据列表，不重复。 */
function withTemplateBasis(message) {
  const basis = Array.isArray(message.basis) ? message.basis : []
  return basis.includes('template') ? basis : [...basis, 'template']
}

/** 一条被模板改写的预览消息。 */
function overriddenMessage(message, text, extra = {}) {
  return {
    ...message,
    text,
    length: text.length,
    overridden: true,
    basis: withTemplateBasis(message),
    ...extra,
  }
}

/**
 * 叠加 system 段、runtime context、工具可见集，并重算统计。
 * @param {object} assembly - `previewAssembly()` 的结果。
 * @param {object} recipe - 提示词模板配方。
 * @returns {object} 叠加后的装配结果。
 */
export function applyRecipeToAssembly(assembly, recipe) {
  const prompt = recipe?.prompt ?? {}
  const sectionOverrides = prompt.sectionOverrides ?? {}
  const applied = { sections: [], contexts: [], tools: [], appended: false }

  const sections = (assembly.sections ?? []).map((section) => {
    const text = sectionOverrides[section.name]
    if (typeof text !== 'string') return section
    applied.sections.push(section.name)
    return {
      ...section,
      text,
      rendered: text,
      length: text.length,
      interpolate: false,
      unresolved: [],
      overridden: true,
    }
  })

  // 独占提示词下追加段落无处安放；客户端算 recipe 时已经折进那一整段。
  if (typeof prompt.appendText === 'string' && prompt.appendText.length > 0 && assembly.completeSection === null) {
    const text = prompt.appendText
    sections.push({
      index: sections.length,
      name: APPEND_SECTION,
      order: APPEND_ORDER,
      text,
      rendered: text,
      length: text.length,
      interpolate: false,
      unresolved: [],
      overridden: true,
      template: true,
    })
    applied.appended = true
  }

  const contexts = (assembly.contexts ?? []).map((context) => {
    const text = recipe?.contexts?.[context.name]
    if (typeof text !== 'string') return context
    applied.contexts.push(context.name)
    return { ...context, text, length: text.length, interpolate: false, overridden: true }
  })

  const disabled = new Set(Array.isArray(recipe?.tools?.disabled) ? recipe.tools.disabled : [])
  const tools = (assembly.tools ?? []).filter((tool) => {
    if (typeof tool?.name !== 'string' || !disabled.has(tool.name)) return true
    applied.tools.push(tool.name)
    return false
  })

  const visible = new Set(tools.map((tool) => tool.name))
  const toolSet = assembly.toolSet === undefined ? undefined : {
    ...assembly.toolSet,
    layers: Object.fromEntries(
      Object.entries(assembly.toolSet.layers ?? {}).map(([layer, names]) => [layer, (names ?? []).filter((name) => visible.has(name))]),
    ),
    layerByName: Object.fromEntries(
      Object.entries(assembly.toolSet.layerByName ?? {}).filter(([name]) => visible.has(name)),
    ),
    counts: Object.fromEntries(
      Object.entries(assembly.toolSet.layers ?? {}).map(([layer, names]) => [layer, (names ?? []).filter((name) => visible.has(name)).length]),
    ),
  }

  const systemText = sections.map((section) => section.rendered ?? section.text ?? '').filter((text) => text.length > 0).join('\n\n')
  const stats = {
    ...(assembly.stats ?? {}),
    sections: sections.length,
    sectionChars: sections.reduce((sum, section) => sum + (section.length ?? 0), 0),
    contexts: contexts.length,
    contextChars: contexts.reduce((sum, context) => sum + (context.length ?? 0), 0),
    tools: tools.length,
    toolSchemaChars: JSON.stringify(tools).length,
  }

  return {
    ...assembly,
    sections,
    contexts,
    tools,
    ...(toolSet === undefined ? {} : { toolSet }),
    systemText,
    stats,
    applied,
  }
}

/**
 * 叠加预览消息列表。
 *
 * 预览消息是本插件自己的形状（`sourceKind / text / parts / length`），所以这里
 * 不处理 DSH 的 `content` 数组；真实请求的对应逻辑在 `templates/message-overlay.js`。
 * @param {Array<object>} messages - `previewMessages()` 的结果。
 * @param {Array<object>} skipped - 已跳过的消息原因。
 * @param {object} recipe - 提示词配方。
 * @param {object} assembly - 叠加后的装配结果（用于判断 required context）。
 * @returns {{messages: Array<object>, skipped: Array<object>, applied: object}} 叠加结果。
 */
export function overlayPreviewMessages(messages, skipped, recipe, assembly) {
  const out = []
  const skippedOut = Array.isArray(skipped) ? [...skipped] : []
  const applied = { messages: [], catalogEntries: [], skipped: [] }

  for (const message of Array.isArray(messages) ? messages : []) {
    const kind = message.sourceKind
    if (kind === 'runtime-context') {
      const hidden = recipe?.messages?.['runtime-context']?.hidden === true
      if (!hidden) {
        out.push(message)
        continue
      }
      // suppressRuntimeContext 只压可选上下文；required 的仍会进入请求。
      const required = new Set((assembly?.contexts ?? []).filter((context) => context.required === true).map((context) => context.name))
      const parts = (message.parts ?? []).filter((part) => required.has(part.name))
      if (parts.length === 0) {
        skippedOut.push({ sourceKind: 'runtime-context', reason: '模板隐藏' })
        applied.skipped.push('runtime-context')
        continue
      }
      const body = parts.map((part) => part.text).filter((text) => typeof text === 'string' && text.length > 0).join('\n\n')
      const text = body.length === 0 ? '' : RUNTIME_CONTEXT_PREFIX + '\n\n' + body
      out.push(overriddenMessage(message, text, { parts }))
      applied.messages.push('runtime-context')
      continue
    }

    if (kind === 'agent-instructions' || kind === 'time-context') {
      const spec = recipe?.messages?.[kind]
      if (spec?.hidden === true || spec?.text === '') {
        skippedOut.push({ sourceKind: kind, reason: '模板隐藏' })
        applied.skipped.push(kind)
        continue
      }
      if (typeof spec?.text === 'string') {
        out.push(overriddenMessage(message, spec.text))
        applied.messages.push(kind)
        continue
      }
      out.push(message)
      continue
    }

    if (kind === 'skill-catalog') {
      const spec = recipe?.messages?.['skill-catalog']
      if (spec?.hidden === true) {
        skippedOut.push({ sourceKind: kind, reason: '模板隐藏' })
        applied.skipped.push(kind)
        continue
      }
      const hasEntryOverrides = Array.isArray(spec?.hiddenEntries) || (spec?.descriptions !== null && typeof spec?.descriptions === 'object')
      if (!hasEntryOverrides) {
        out.push(message)
        continue
      }
      const entries = applyCatalogOverrides(message.parts ?? [], spec)
      const text = renderCatalogMessage(entries, message.incomplete === true)
      out.push(overriddenMessage(message, text, { parts: entries }))
      applied.messages.push(kind)
      applied.catalogEntries = entries.map((entry) => entry.name)
      continue
    }

    out.push(message)
  }

  return { messages: out, skipped: skippedOut, applied }
}
