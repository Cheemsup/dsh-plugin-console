/**
 * 预测首请求里的 `skill-catalog` 消息。
 *
 * 它同样不进系统提示词：`@deepseek-ai/dsh-tool-skill` 在 `agent/pre-step` 里向
 * `ctx.skills` 要一份目录快照，再渲染成一条 user 消息追加到请求末尾。目录内容随
 * **工作区**变化（实测同一台机器两个工作区分别是 10 与 27 个 skill），所以这条消息
 * 是「预演必须带工作区条件」的直接原因。
 *
 * 渲染格式抄自已安装版本 `0.2.2-rc.1` 的 `@deepseek-ai/dsh-tool-skill/lib/index.js`，
 * 逐字正确性由两份日志 fixture 保证。
 * @module dsh-plugin-console/host/preview-skills
 */

import { CATALOG_DEFAULT_MAX_LENGTH, catalogDescription, escapeAttr, escapeText, renderCatalogMessage } from './catalog.js'
import { hostModuleResolver } from './preview-modules.js'

/** 目录消息的 pre-step 所有者；是否启用见 `preview-modules.js` 的判定口径。 */
const MODULE = '@deepseek-ai/dsh-tool-skill'

/**
 * 模式 scope 里的 skill 提供方。
 *
 * 宿主层的 `skill-filesystem` 在 web/desktop profile 里同样是 disabled 的；
 * 拿不到模式 scope 时读不到它的提供方，目录会是空的——那不是「没有 skill」。
 */
const SKILL_PROVIDER = '@deepseek-ai/dsh-skill-filesystem'

/** 目录快照的上限：cwd 扫描可能真的去读磁盘，预演不该被它拖住。 */
const SNAPSHOT_TIMEOUT_MS = 3000

/**
 * 预测一条首请求里的 `skill-catalog` 消息。
 * @param {object} ctx - host 插件上下文。
 * @param {object} options - 条件与装配结果。
 * @param {string} options.workspacePath - 工作区路径（cwd）。
 * @param {symbol | undefined} options.scopeKey - 预设 scope 标识。
 * @param {Array<{name: string}>} options.tools - 装配出的工具 schema。
 * @param {object} [options.modules] - `resolveModules()` 的结果；省略时只按宿主行判定。
 * @returns {Promise<object>} `{ available, text, entries, complete, confidence, reason? }`。
 */
export async function previewSkills(ctx, options) {
  const unavailable = (reason) => ({ available: false, reason, text: '', entries: [], complete: false })
  const devices = options.modules ?? hostModuleResolver(ctx)
  const device = devices.get(MODULE)
  if (!device.available) return unavailable(device.reason)
  // 目录只随这份确切注册一起出现：工具被掩码或同名覆盖挡掉时，模型根本看不到目录。
  if (!(options.tools ?? []).some((tool) => tool?.name === 'skill')) return unavailable('本次装配里看不到 skill 工具')
  if (typeof options.workspacePath !== 'string' || options.workspacePath.length === 0) return unavailable('未选择工作区')
  // 宿主层没有提供方时，目录完全来自模式 scope；没有 scope 就只能读到空目录。
  if (options.scopeKey === undefined && devices.onlyFromPreset(SKILL_PROVIDER)) {
    return unavailable('没有取得模式 scope：读不到该模式注册的 skill 提供方')
  }

  const maxLength = typeof device.config?.catalogDescriptionMaxLength === 'number' && Number.isInteger(device.config.catalogDescriptionMaxLength) && device.config.catalogDescriptionMaxLength >= 3
    ? device.config.catalogDescriptionMaxLength
    : CATALOG_DEFAULT_MAX_LENGTH

  const skills = ctx.get('skills')
  if (typeof skills?.snapshot !== 'function') return unavailable('skills 服务不可用')

  let snapshot
  try {
    snapshot = await skills.snapshot({
      cwd: options.workspacePath,
      ...(options.scopeKey === undefined ? {} : { scope: options.scopeKey }),
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    })
  } catch (error) {
    return unavailable(`skill 目录快照失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // 快照不完整**不等于没有目录**：真实的 DSH 仍然会发一份目录，并在帧里附一句
  // 「有些 skill 没能确认」。早先这里直接判成不可用，结果是「预演没有、真实请求有」——
  // 比给一份带警告的目录更误导。缺少的那份提示文案与 DSH 逐字一致。
  const incomplete = snapshot?.complete !== true
  const entries = (snapshot?.skills ?? [])
    .filter((skill) => skill?.invocation?.modelInvocable === true)
    .map((skill) => ({
      name: skill.name,
      description: catalogDescription(skill.description, maxLength),
      source: skill.source,
      provider: skill.provider,
    }))
  if (entries.length === 0 && !incomplete) {
    return { available: true, text: '', entries: [], complete: true, confidence: 'derived' }
  }

  return {
    available: true,
    confidence: 'derived',
    complete: !incomplete,
    incomplete,
    entries,
    text: renderCatalogMessage(entries, incomplete),
  }
}

/**
 * 一条 skill 的资源提示。
 *
 * 三种资源基座（目录 / URL / 不透明）加的句子不同；没有基座时说明由 provider 托管。
 * @param {object} skill - 已加载的 skill。
 * @returns {string[]} 提示行。
 */
function renderResourceHint(skill) {
  const base = skill.resourceBase
  if (base === undefined) {
    const provider = escapeText(skill.provider ?? '')
    return [`Resources for this skill are managed by provider "${provider}".`, 'Load referenced resources only as needed.']
  }
  if (base.kind === 'directory') {
    const path = escapeText(base.path)
    return [`Base directory for this skill: ${path}`, 'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.']
  }
  if (base.kind === 'url') {
    const url = escapeText(base.url)
    return [`Base URL for this skill: ${url}`, 'Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.']
  }
  const description = escapeText(base.description ?? '')
  return [`Resources for this skill: ${description}`, 'Load referenced resources only as needed.']
}

/**
 * `<skill_content>` 块：`skill` 工具结果与用户 `/name` 注入共用同一份渲染。
 *
 * 正文原样嵌入（skill 是可信的本地内容），名字走转义后的属性。
 * @param {object} skill - 已加载的 skill。
 * @returns {string} 模型可见文本。
 */
function renderSkillContent(skill) {
  const name = escapeAttr(skill.name)
  return [
    `<skill_content name="${name}">`,
    '<skill_resources>',
    ...renderResourceHint(skill),
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content ?? '',
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

/** 用户消息里的 `/name` 手势：与 DSH 的公共 skill 名文法一致。 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/**
 * 从首条消息草稿里取 `/name` 手势，按首次出现顺序去重。
 * @param {string} text - 草稿正文。
 * @returns {string[]} 候选 skill 名。
 */
export function invokedSkillNames(text) {
  const names = []
  for (const match of String(text ?? '').matchAll(SKILL_GESTURE)) {
    const name = match[2]
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * 预测一条 `/name` 带出来的 `skill-invocation` 消息。
 * @param {object} ctx - host 插件上下文。
 * @param {object} options - 条件。
 * @param {string} options.name - skill 名。
 * @param {string} options.workspacePath - 工作区路径。
 * @param {symbol | undefined} options.scopeKey - 预设 scope。
 * @param {object} [options.modules] - `resolveModules()` 的结果；省略时只按宿主行判定。
 * @returns {Promise<object>} `{ available, text, skill, reason? }`。
 */
export async function previewSkillInvocation(ctx, options) {
  const device = (options.modules ?? hostModuleResolver(ctx)).get(MODULE)
  if (!device.available) return { available: false, reason: device.reason }
  if (typeof options.workspacePath !== 'string' || options.workspacePath.length === 0) {
    return { available: false, reason: '未选择工作区' }
  }
  const skills = ctx.get('skills')
  if (typeof skills?.get !== 'function') return { available: false, reason: 'skills 服务不可用' }
  let skill
  try {
    skill = await skills.get(options.name, {
      cwd: options.workspacePath,
      ...(options.scopeKey === undefined ? {} : { scope: options.scopeKey }),
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    })
  } catch (error) {
    return { available: false, reason: `skill 读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (skill === undefined) return { available: false, reason: `当前工作区没有 skill「${options.name}」` }
  // 只有用户可调用的 skill 才会被 `/name` 展开；模型可调用但用户不可调用的名字只能走工具。
  if (skill.invocation?.userInvocable !== true) {
    return { available: false, reason: `skill「${options.name}」不允许用户调用` }
  }
  return {
    available: true,
    text: renderSkillContent(skill),
    skill: { name: skill.name, provider: skill.provider, resourceBase: skill.resourceBase },
  }
}
