/**
 * 按真实发送顺序拼出首请求的 user-role 消息。
 *
 * 顺序不是猜的：日志里一条 `standard` 会话的首请求依次是
 * user → agent-instructions → runtime-context → skill-catalog → time-context。
 * 依据是各自挂在哪里：
 *   - `agent-instructions` 在 `agent/pre-step` 里插到 claimed 消息之后；
 *   - runtime-context 由 loop 的默认 decision 追加；
 *   - skill-catalog 与 skill-invocation 依次 append；
 *   - time-context 的 prepend 监听器最后把时间快照放到末尾。
 *
 * 每条消息都带「这是什么、凭什么这样预测、有多确定」，页面据此区分实测与推导。
 * @module dsh-plugin-console/host/preview-messages
 */

import { previewRuntimeContext } from './preview-contexts.js'
import { previewInstructions } from './preview-instructions.js'
import { hostModuleResolver } from './preview-modules.js'
import { invokedSkillNames, previewSkillInvocation, previewSkills } from './preview-skills.js'
import { overlayPreviewMessages } from './recipe-overlay.js'

/** 时间快照的 pre-step 所有者；宿主行与模式挂载任一成立就会发这条消息。 */
const TIME_MODULE = '@deepseek-ai/dsh-time-context'

/** 三段会话依赖上下文分别由谁注册，用于溯源。 */
const CONTEXT_OWNERS = {
  'working-directory:current': '@deepseek-ai/dsh-working-directory',
  'sandbox:policy': '@deepseek-ai/dsh-sandbox-policy',
  'approval:policy': '@deepseek-ai/dsh-user-approval',
}

/**
 * 一条消息。
 * @param {object} init - 字段。
 * @returns {object} 消息。
 */
function message(init) {
  return {
    index: 0,
    sourceKind: init.sourceKind,
    role: init.role ?? 'user',
    text: init.text,
    // 占位行有文案但没有内容，所以长度可以显式给 0；其余消息按正文算。
    length: init.length ?? init.text.length,
    mechanism: init.mechanism,
    owners: init.owners ?? [],
    confidence: init.confidence,
    basis: init.basis ?? [],
    ...(init.parts === undefined ? {} : { parts: init.parts }),
    ...(init.unavailable === undefined ? {} : { unavailable: init.unavailable }),
    ...(init.incomplete === true ? { incomplete: true } : {}),
  }
}

/**
 * ISO 形状 + 偏移 + IANA 时区名的时间戳，与 DSH 的 time-context 逐字一致。
 * @param {number} now - 预览时刻（epoch ms）。
 * @param {string | undefined} timeZone - 展示时区。
 * @returns {string} 时间戳文本。
 */
function formatTimestamp(now, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  })
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]))
  const offset = (parts.timeZoneName ?? 'GMT+00:00').replace(/^GMT$/, 'GMT+00:00').slice(3)
  const zone = timeZone ?? formatter.resolvedOptions().timeZone
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}[${zone}]`
}

/**
 * 预测 `time-context` 消息。
 *
 * 时间取**预览时刻**而不是发送时刻，页面要标明这一点；首请求没有前序消息，
 * 所以 elapsed 恒为 `unavailable`。时间戳用行配置的时区（缺省为服务端时区），
 * 浏览器时区那一行只反映客户端上报的值——两者在 DSH 里本来就是分开的。
 * @param {object} conditions - 已解析条件。
 * @param {object} devices - 模块判定器（`resolveModules()` 或宿主层判定器）。
 * @param {number} now - 预览时刻。
 * @returns {object} `{ available, text, reason? }`。
 */
function previewTimeContext(conditions, devices, now) {
  const device = devices.get(TIME_MODULE)
  if (!device.available) return { available: false, reason: device.reason }
  let stamp
  try {
    stamp = formatTimestamp(now, typeof device.config?.timeZone === 'string' ? device.config.timeZone : undefined)
  } catch (error) {
    return { available: false, reason: `时区不可用：${error instanceof Error ? error.message : String(error)}` }
  }
  const browserLine = conditions.clientTimeZoneSource === 'client'
    ? `Browser time zone for this request: ${conditions.clientTimeZone}. Interpret otherwise-unqualified dates and times in this zone.`
    : 'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.'
  return {
    available: true,
    text: [
      `Time sampled while preparing turn 1, step 1: ${stamp}`,
      browserLine,
      'Elapsed since the preceding model-visible message: unavailable.',
    ].join('\n'),
  }
}

/**
 * 拼出一次首请求的全部 user-role 消息。
 * @param {object} ctx - host 插件上下文。
 * @param {object} options - 条件与装配结果。
 * @param {object} options.assembly - `previewAssembly()` 的结果。
 * @param {object} options.conditions - `resolveConditions()` 的结果。
 * @param {symbol | undefined} options.scopeKey - 预设 scope。
 * @param {object} [options.modules] - `resolveModules()` 的结果；省略时只按宿主行判定。
 * @param {string} [options.draft] - 首条消息草稿；有值时它成为 user 消息正文。
 * @param {object} [options.recipe] - 提示词模板配方；提供时在基线之后叠加覆盖。
 * @param {number} [options.now] - 预览时刻。
 * @returns {Promise<{messages: Array<object>, skipped: Array<object>, warnings: Array<string>, applied: object}>} 消息与诊断。
 */
export async function previewMessages(ctx, options) {
  const { assembly, conditions, scopeKey } = options
  const now = options.now ?? Date.now()
  const draft = typeof options.draft === 'string' ? options.draft : ''
  // 一次预演只解析一份模块判定：三个采集器必须看到同一份「谁在跑」的答案。
  const modules = options.modules ?? hostModuleResolver(ctx)
  const messages = []
  const skipped = []

  // 1. 首条用户消息。有草稿就用草稿；没有就留一行占位，并明确「没有内容」。
  if (draft.length > 0) {
    messages.push(message({
      sourceKind: 'user',
      text: draft,
      mechanism: 'user input',
      confidence: 'derived',
      basis: ['draft'],
      parts: [],
    }))
  } else {
    messages.push(message({
      sourceKind: 'user',
      text: '（未输入首条消息）',
      length: 0,
      mechanism: 'user input',
      confidence: 'unknown',
      basis: ['draft'],
      parts: [],
      unavailable: { reason: '草稿未提供：附件、图片与 `/skill` 调用都不会被预测' },
    }))
  }

  // 2. agent-instructions：行没挂或没有可读文件时整条不出现，不是空消息。
  const instructions = await previewInstructions(ctx, {
    workspacePath: conditions?.workspace?.path,
    modules,
  })
  if (instructions.available && instructions.text.length > 0) {
    messages.push(message({
      sourceKind: 'agent-instructions',
      text: instructions.text,
      mechanism: 'agent/pre-step',
      owners: ['@deepseek-ai/dsh-agent-instructions'],
      confidence: 'derived',
      basis: ['workspace'],
      parts: instructions.files,
    }))
  } else if (instructions.available) {
    skipped.push({ sourceKind: 'agent-instructions', reason: '这个工作区没有指令文件（例如AGENTS.md、CLAUDE.md）' })
  } else {
    skipped.push({ sourceKind: 'agent-instructions', reason: instructions.reason })
  }

  // 3. runtime-context：实测段与推导段拼成一份快照。
  const runtime = previewRuntimeContext(assembly, conditions, options.recipe?.contexts)
  if (runtime.text.length > 0) {
    messages.push(message({
      sourceKind: 'runtime-context',
      text: runtime.text,
      mechanism: 'agent-loop',
      confidence: runtime.segments.every((item) => item.confidence === 'measured') ? 'measured' : 'derived',
      basis: ['workspace', 'permission'],
      // 文本为空的段不会进入消息正文，也不属于「这条消息包含什么」：
      // 它们由消息视图按 `preview.contexts` 列进「注册了但没有进入这条消息」。
      parts: runtime.segments
        .filter((item) => item.text.length > 0)
        .map((item) => ({
          name: item.name,
          order: item.order,
          text: item.text,
          length: item.text.length,
          confidence: item.confidence,
          owners: CONTEXT_OWNERS[item.name] === undefined ? [] : [CONTEXT_OWNERS[item.name]],
          ...(item.basis === undefined ? {} : { basis: item.basis }),
          ...(item.reason === undefined ? {} : { reason: item.reason }),
          ...(item.overridden === true ? { overridden: true } : {}),
        })),
    }))
  } else {
    skipped.push({ sourceKind: 'runtime-context', reason: '没有生效的运行时上下文' })
  }

  // 4. skill 目录：工具不可见、快照不完整或目录为空时都不生成消息。
  const skills = await previewSkills(ctx, {
    workspacePath: conditions?.workspace?.path,
    scopeKey,
    tools: assembly?.tools ?? [],
    modules,
  })
  if (skills.available && skills.text.length > 0) {
    messages.push(message({
      sourceKind: 'skill-catalog',
      text: skills.text,
      mechanism: 'agent/pre-step',
      owners: ['@deepseek-ai/dsh-tool-skill'],
      confidence: 'derived',
      basis: ['workspace', 'preset', 'skills-service'],
      parts: skills.entries,
      incomplete: skills.incomplete,
    }))
  } else if (skills.available) {
    skipped.push({ sourceKind: 'skill-catalog', reason: '目录为空' })
  } else {
    skipped.push({ sourceKind: 'skill-catalog', reason: skills.reason })
  }

  // 5. `/name` 手势带出来的 skill 正文。只有草稿里出现手势时才存在，且每个名字一条消息。
  for (const name of invokedSkillNames(draft)) {
    const invocation = await previewSkillInvocation(ctx, {
      name,
      workspacePath: conditions?.workspace?.path,
      scopeKey,
      modules,
    })
    if (invocation.available && invocation.text.length > 0) {
      messages.push(message({
        sourceKind: 'skill-invocation',
        text: invocation.text,
        mechanism: 'agent/pre-step',
        owners: ['@deepseek-ai/dsh-tool-skill'],
        confidence: 'derived',
        basis: ['draft', 'workspace'],
        parts: [invocation.skill],
      }))
    } else {
      skipped.push({ sourceKind: 'skill-invocation:' + name, reason: invocation.reason })
    }
  }

  // 6. time-context：宿主行或当前模式挂载了它才会出现。
  const time = previewTimeContext(conditions, modules, now)
  if (time.available) {
    messages.push(message({
      sourceKind: 'time-context',
      text: time.text,
      mechanism: 'agent/pre-step',
      owners: ['@deepseek-ai/dsh-time-context'],
      confidence: 'derived',
      basis: ['client-time-zone'],
      parts: [{ sampledAt: now, timeZone: conditions.clientTimeZone, timeZoneSource: conditions.clientTimeZoneSource }],
    }))
  } else {
    skipped.push({ sourceKind: 'time-context', reason: time.reason })
  }

  // 模板叠加放在最后：它改的是“所有内置注入完成之后模型会看到的文字”，
  // 与真实请求里 pre-step 监听器的位置一致。
  const overlaid = options.recipe === undefined
    ? { messages, skipped, applied: { messages: [], catalogEntries: [], skipped: [] } }
    : overlayPreviewMessages(messages, skipped, options.recipe, assembly)
  overlaid.messages.forEach((item, index) => {
    item.index = index + 1
  })
  return {
    messages: overlaid.messages,
    skipped: overlaid.skipped,
    warnings: modules.warnings ?? [],
    applied: overlaid.applied,
  }
}
