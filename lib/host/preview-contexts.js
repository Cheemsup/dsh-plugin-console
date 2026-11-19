/**
 * 预测首请求里的 `runtime-context` 快照。
 *
 * 这段快照由 loop 在请求前拼好，来源有两类：
 *   - **实测**：`assemble()` 直接给出的 contexts（harness:source、app:web-surface 等）；
 *   - **推导**：cwd / sandbox / approval 三段依赖会话状态，没有 Agent 时装配里是空的，
 *     但它们恰恰把「权限预设」这个条件变成了模型能看到的文字。
 *
 * 三段推导文案抄自已安装版本 `0.2.2-rc.5`（`dsh-working-directory`、`dsh-sandbox-policy`、
 * `dsh-user-approval`）。外层包装则来自同一版本的 `dsh-agent-loop`：首份快照把 sections
 * 包进 `<system-reminder>`，只介绍当前会话；只有后续快照才声明替换更早的上下文。
 * 本地源码 checkout 的文案与已安装版不同，所以以日志为准。
 * @module dsh-plugin-console/host/preview-contexts
 */

/**
 * 快照的固定包装。预演只模拟新会话的首请求，所以只会用到首份快照的引导语；
 * 后续快照的 `It replaces earlier versions…` 不会出现在这里。
 */
const SNAPSHOT_OPEN = '<system-reminder>'
const SNAPSHOT_CLOSE = '</system-reminder>'
const FIRST_SNAPSHOT_INTRO = 'The following information describes your current session:'

/**
 * 把按 order 拼好的分段正文包成模型可见的 runtime-context 快照。
 *
 * 包装抄自 `0.2.2-rc.5` 的 `@deepseek-ai/dsh-agent-loop`（`project()`）；早先版本
 * 用的是 `Current runtime context. This snapshot supersedes…` 前缀，不能再拿旧文案
 * 当预测。
 * @param {string} body - 段间以 `\n\n` 连接的正文。
 * @returns {string} 模型可见消息正文；没有正文时返回空串。
 */
export function wrapRuntimeContext(body) {
  if (body.length === 0) return ''
  // 与 agent-loop 的 project() 一致：正文里若出现闭合标签，必须转义成 `<\/system-reminder>`，
  // 否则一段上下文就能提前把提醒包装关掉。
  const safeBody = body.replace(/<\/system-reminder\s*>/gi, (tag) => `<\\${tag.slice(1)}`)
  return `${SNAPSHOT_OPEN}\n${FIRST_SNAPSHOT_INTRO}\n\n${safeBody}\n${SNAPSHOT_CLOSE}`
}

/** 三段会话依赖上下文的 order，与 `dsh-system-prompt` 的常量表一致。 */
const ORDER = {
  WORKING_DIRECTORY: 100,
  SANDBOX_POLICY: 110,
  APPROVAL_POLICY: 115,
}

/** 三种 sandbox 模式各自在模型面前的文案。 */
const SANDBOX_TEXT = {
  'read-only': 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.',
  'danger-full-access': 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.',
}

const NEVER_SENTENCE = 'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'
const ASK_SENTENCE = 'Approval prompts are enabled in this session: operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.'

/**
 * workspace-write 的文案要带上沙箱根目录；没有额外可写目录时不加那一句。
 * @param {string} workspaceRoot - 会话工作区路径。
 * @returns {string} 模型可见文本。
 */
function workspaceWriteText(workspaceRoot) {
  return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(workspaceRoot)}. Some platform temporary areas may also be writable.`
}

/**
 * 与 system 段同一套插值规则：只替换能解析的变量，解析不了的保留字面量。
 * @param {string} text - 原文。
 * @param {object} variables - 变量表。
 * @returns {string} 渲染结果。
 */
function interpolateText(text, variables) {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    const value = variables?.[key]
    return typeof value === 'string' ? value : whole
  })
}

/**
 * 一条 runtime-context 分段。
 * @param {object} init - 分段字段。
 * @returns {object} 分段。
 */
function segment(init) {
  return {
    name: init.name,
    order: init.order,
    text: init.text ?? '',
    confidence: init.confidence,
    ...(init.basis === undefined ? {} : { basis: init.basis }),
    ...(init.reason === undefined ? {} : { reason: init.reason }),
  }
}

/**
 * 预测整个 runtime-context 快照。
 * @param {object} assembly - `previewAssembly()` 的结果。
 * @param {object} conditions - `resolveConditions()` 的结果。
 * @param {object} [overrides] - 模板对 context 的逐段覆盖（name → 最终文本）。
 * @returns {object} `{ text, segments }`。
 */
export function previewRuntimeContext(assembly, conditions, overrides) {
  const workspacePath = conditions?.workspace?.path
  const measured = new Map((assembly?.contexts ?? []).map((context) => [context.name, context]))
  const segments = []

  // —— 三段由会话状态决定的部分 ——
  if (typeof workspacePath === 'string' && workspacePath.length > 0) {
    segments.push(segment({
      name: 'working-directory:current',
      order: ORDER.WORKING_DIRECTORY,
      text: `Current working directory: ${JSON.stringify(workspacePath)}.`,
      confidence: 'derived',
      basis: ['workspace'],
    }))
  } else {
    // 没有工作区时不编一个路径，也不把这一项当成空段：模型是收不到的。
    segments.push(segment({
      name: 'working-directory:current',
      order: ORDER.WORKING_DIRECTORY,
      confidence: 'unknown',
      basis: ['workspace'],
      reason: 'workspace is not selected',
    }))
  }

  const sandbox = conditions?.permission?.sandbox
  if (typeof sandbox === 'string' && typeof workspacePath === 'string') {
    segments.push(segment({
      name: 'sandbox:policy',
      order: ORDER.SANDBOX_POLICY,
      text: sandbox === 'workspace-write' ? workspaceWriteText(workspacePath) : (SANDBOX_TEXT[sandbox] ?? ''),
      confidence: 'derived',
      basis: ['workspace', 'permission'],
    }))
  } else {
    segments.push(segment({
      name: 'sandbox:policy',
      order: ORDER.SANDBOX_POLICY,
      confidence: 'unknown',
      basis: ['permission'],
      reason: 'sandbox mode is unknown',
    }))
  }

  const approval = conditions?.permission?.approval
  if (approval === 'ask' || approval === 'never') {
    segments.push(segment({
      name: 'approval:policy',
      order: ORDER.APPROVAL_POLICY,
      text: approval === 'never' ? NEVER_SENTENCE : ASK_SENTENCE,
      confidence: 'derived',
      basis: ['permission'],
    }))
  } else {
    segments.push(segment({
      name: 'approval:policy',
      order: ORDER.APPROVAL_POLICY,
      confidence: 'unknown',
      basis: ['permission'],
      reason: 'approval policy is unknown',
    }))
  }

  // —— 装配直接给出的部分 ——
  const derivedNames = new Set(['working-directory:current', 'sandbox:policy', 'approval:policy'])
  for (const [name, context] of measured) {
    if (derivedNames.has(name)) continue
    const text = context.interpolate === false ? context.text : interpolateText(context.text, assembly?.variables)
    segments.push(segment({
      name,
      order: typeof context.order === 'number' ? context.order : undefined,
      text,
      confidence: 'measured',
    }))
  }

  // 模板覆盖只落在已经存在的段上：名字对不上就保持原样，不凭空造一个 context。
  if (overrides !== null && typeof overrides === 'object') {
    for (const item of segments) {
      const text = overrides[item.name]
      if (typeof text !== 'string') continue
      item.text = text
      item.overridden = true
      item.confidence = 'derived'
      delete item.reason
      item.basis = [...(item.basis ?? []), 'template']
    }
  }

  // DSH 按 order 排；读不到 order 的放在最后，保持相对顺序（sort 在 V8 上稳定）。
  segments.sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER))
  const body = segments.map((item) => item.text).filter((text) => text.length > 0).join('\n\n')
  return {
    text: wrapRuntimeContext(body),
    segments,
  }
}
