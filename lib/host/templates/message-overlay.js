/**
 * 真实请求里的 user-role 消息改写。
 *
 * `agent-instructions`、`skill-catalog`、`time-context` 都由 DSH 的 pre-step 监听器
 * 注入；本插件在 agent scope 上注册一个 `prepend` 监听器，等 `next()` 完成后改
 * **最终**消息列表。关键约束：
 *
 *   - 只替换 `content`，保留 `id` 与 `source`。`agent-instructions` 靠
 *     `source.baseline/baselineIdentity` 判断 baseline 是否已可见；`skill-catalog`
 *     靠 `source.entries` 计算 digest。改掉它们会让 DSH 每步重新注入/重新发布。
 *   - 任何异常都由调用方吞掉：一个坏 recipe 不能让每次请求都失败。
 * @module dsh-plugin-console/host/templates/message-overlay
 */

import { applyCatalogOverrides, renderCatalogMessage, renderCatalogUpdate } from '../catalog.js'

/** 真正需要 pre-step 监听器的消息类型；runtime-context 由 suppress 处理。 */
const OVERLAY_KINDS = ['agent-instructions', 'skill-catalog', 'time-context']

/**
 * 这份 recipe 是否需要 pre-step 消息改写。
 * @param {object} recipe - 提示词配方。
 * @returns {boolean} 是否需要注册监听器。
 */
export function hasMessageOverrides(recipe) {
  const messages = recipe?.messages
  if (messages === null || typeof messages !== 'object') return false
  // runtime-context 的 hidden 由 systemPrompt.suppressRuntimeContext() 处理，
  // 不需要在这里改消息；把它排除，避免注册一个什么都不做的监听器。
  return OVERLAY_KINDS.some((kind) => {
    const spec = messages[kind]
    if (spec === null || typeof spec !== 'object') return false
    if (spec.hidden === true || typeof spec.text === 'string') return true
    return Array.isArray(spec.hiddenEntries) || (spec.descriptions !== null && typeof spec.descriptions === 'object')
  })
}

/** 一条消息的正文（只取 text 块）；没有时为空串。 */
function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n')
}

/** 用一段文本替换消息正文；保留 id / source。 */
function withText(message, text) {
  return {
    ...message,
    content: [{ type: 'text', text }],
  }
}

/**
 * time-context 的 `source.sections` 是会话页读的逐段事实；正文改了它也一起改，
 * 否则「原文」和「分段」会互相矛盾。
 */
function withTimeSource(message, text) {
  const sections = message?.source?.sections
  if (!Array.isArray(sections)) return message
  return {
    ...message,
    source: {
      ...message.source,
      sections: sections.map((section, index) => index === 0 ? { ...section, text } : section),
    },
  }
}

/**
 * 读取目录消息里的条目；不可读时返回 undefined（不改这条消息）。
 * @param {object} source - 消息的 source。
 * @returns {Array<{name: string, description: string}> | undefined} 条目。
 */
function catalogEntriesOf(source) {
  if (!Array.isArray(source?.entries)) return undefined
  const entries = []
  for (const entry of source.entries) {
    if (entry === null || typeof entry !== 'object') return undefined
    if (typeof entry.name !== 'string' || entry.name.length === 0 || typeof entry.description !== 'string') return undefined
    entries.push({ name: entry.name, description: entry.description })
  }
  return entries
}

/**
 * 按 recipe 改写一份 pre-step 决策里的消息。
 *
 * @param {Array<object>} messages - `decision.messages`。
 * @param {object} recipe - 提示词配方。
 * @returns {{messages: Array<object>, applied: {messages: string[], skipped: string[]}}} 改写结果。
 */
export function overlayStepMessages(messages, recipe) {
  const instructions = recipe?.messages?.['agent-instructions']
  const catalog = recipe?.messages?.['skill-catalog']
  const time = recipe?.messages?.['time-context']
  const instructionsHidden = instructions?.hidden === true || instructions?.text === ''
  const instructionsText = typeof instructions?.text === 'string' ? instructions.text : undefined
  const timeHidden = time?.hidden === true || time?.text === ''
  const timeText = typeof time?.text === 'string' ? time.text : undefined
  const catalogHidden = catalog?.hidden === true
  const hasCatalogOverrides = Array.isArray(catalog?.hiddenEntries) || (catalog?.descriptions !== null && typeof catalog?.descriptions === 'object')

  if (!instructionsHidden && instructionsText === undefined && !timeHidden && timeText === undefined && !catalogHidden && !hasCatalogOverrides) {
    return { messages, applied: { messages: [], skipped: [] } }
  }

  const out = []
  const applied = { messages: [], skipped: [] }
  // 只改 baseline 那条；后续的“指令变更”消息承载的是文件变化，继续保留。
  const hasBaseline = (Array.isArray(messages) ? messages : []).some((message) => message?.source?.kind === 'agent-instructions' && message?.source?.baseline === true)
  let instructionsRewritten = false

  for (const message of Array.isArray(messages) ? messages : []) {
    const kind = message?.source?.kind

    if (kind === 'agent-instructions') {
      const target = message.source.baseline === true || (!hasBaseline && !instructionsRewritten)
      if (!target) {
        out.push(message)
        continue
      }
      instructionsRewritten = true
      if (instructionsHidden) {
        applied.skipped.push(kind)
        continue
      }
      if (instructionsText !== undefined) {
        out.push(withText(message, instructionsText))
        applied.messages.push(kind)
        continue
      }
      out.push(message)
      continue
    }

    if (kind === 'time-context') {
      if (timeHidden) {
        applied.skipped.push(kind)
        continue
      }
      if (timeText !== undefined) {
        out.push(withTimeSource(withText(message, timeText), timeText))
        applied.messages.push(kind)
        continue
      }
      out.push(message)
      continue
    }

    if (kind === 'skill-catalog') {
      if (catalogHidden) {
        applied.skipped.push(kind)
        continue
      }
      if (!hasCatalogOverrides) {
        out.push(message)
        continue
      }
      const entries = catalogEntriesOf(message.source)
      if (entries === undefined) {
        // 外部写入的种子可能只有 kind；不猜条目，保持原样。
        out.push(message)
        applied.skipped.push(kind + ':unreadable')
        continue
      }
      const next = applyCatalogOverrides(entries, catalog)
      const text = message.source.update === true
        ? renderCatalogUpdate(next, message.source.incomplete === true)
        : renderCatalogMessage(next, message.source.incomplete === true)
      out.push(withText(message, text))
      applied.messages.push(kind)
      continue
    }

    out.push(message)
  }

  return { messages: out, applied }
}

/** 导出给自检：消息正文的读取口径与改写保持一致。 */
export { textOf }
