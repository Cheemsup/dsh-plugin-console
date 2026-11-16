/**
 * skill 目录的模型可见帧。
 *
 * 这段文字属于 `@deepseek-ai/dsh-tool-skill`，不属于本插件；预演与真实 pre-step
 * 改写必须渲染出**同一份**帧，所以集中在这里，只保留一处可移植的副本。
 *
 * 帧抄自已安装版 `0.2.2-rc.1`。DSH 升级后如果文案变化，`verify-request-preview`
 * 的逐字 fixture 会先红，改这里即可。
 * @module dsh-plugin-console/host/catalog
 */

/** 行配置缺省值，与已安装版 `@deepseek-ai/dsh-tool-skill` 的 Config 默认一致。 */
export const CATALOG_DEFAULT_MAX_LENGTH = 500

/** 目录描述里的 `&` / `<` / `>` 必须转义：它们会被嵌进伪 XML 帧里。 */
export function escapeText(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** 属性值只转义会破坏引号结构的字符。 */
export function escapeAttr(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/**
 * 描述归一化并截断：连续空白折成一个空格，超长截到 `maxLength - 3` 再补 `...`。
 * @param {string} value - 原始描述。
 * @param {number} maxLength - 上限。
 * @returns {string} 归一化后的描述。
 */
export function catalogDescription(value, maxLength) {
  const normalized = String(value ?? '').replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

/** 目录条目行；条目只暴露 name / description。 */
function renderCatalogEntries(entries) {
  return entries.map((entry) => `- \`${entry.name}\`: ${escapeText(entry.description)}`)
}

/** 不完整目录的提示句，首包与更新包共用。 */
function incompleteCatalogNotice() {
  return 'Some skills could not be checked. Only confirmed skills are listed; a lower-priority definition of the same name may be selected when a preferred source is unavailable. Discovery will be retried on the next request.'
}

/**
 * 首包目录消息。
 *
 * 与「目录更新」消息（后续轮次才会出现）刻意不同：首包要解释「这是本会话可见的
 * 全部 skill」，更新包要说明「它替换了之前的列表」。首请求只会遇到前者。
 * @param {Array<{name: string, description: string}>} entries - 目录条目。
 * @param {boolean} incomplete - 快照是否不完整。
 * @returns {string} 消息正文。
 */
export function renderCatalogMessage(entries, incomplete) {
  return [
    '<system-reminder>',
    entries.length === 0
      ? 'No skills could be confirmed in this discovery attempt.'
      : 'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
    '',
    '<available_skills>',
    ...renderCatalogEntries(entries),
    '</available_skills>',
    '',
    ...(incomplete ? [incompleteCatalogNotice(), ''] : []),
    entries.length === 0
      ? 'Wait for an updated catalog before calling the `skill` tool. Do not infer skill instructions from an empty catalog.'
      : "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
    'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    '</system-reminder>',
  ].join('\n')
}

/**
 * 目录更新消息（后续轮次才会出现）。
 *
 * 之所以也要移植：如果会话运行中 skill 目录真的变了，DSH 会发更新帧；模板对条目的
 * 覆盖必须在更新帧上继续成立，不能只在首包生效。
 * @param {Array<{name: string, description: string}>} entries - 目录条目。
 * @param {boolean} incomplete - 快照是否不完整。
 * @returns {string} 消息正文。
 */
export function renderCatalogUpdate(entries, incomplete) {
  const availability = entries.length === 0
    ? [
        incomplete
          ? 'No skills could be confirmed in this discovery attempt. Do not use names from earlier skill catalogs.'
          : 'No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.',
        'A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.',
      ]
    : [
        'Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.',
        'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
      ]
  return [
    '<system-reminder>',
    incomplete
      ? 'Skill discovery is incomplete. This catalog of currently available skills replaces every earlier available-skills list in this session:'
      : 'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:',
    '',
    '<available_skills>',
    ...renderCatalogEntries(entries),
    '</available_skills>',
    '',
    ...(incomplete ? [incompleteCatalogNotice(), ''] : []),
    ...availability,
    '</system-reminder>',
  ].join('\n')
}

/**
 * 按模板覆盖过滤/改写目录条目。
 *
 * 目录改写与「真实 pre-step 改写」共用这一份，避免两处对“隐藏哪些、用谁的描述”
 * 给出不同答案。描述覆盖不截断：它是用户明确写下的最终文字。
 * @param {Array<{name: string, description: string}>} entries - 原始条目。
 * @param {object | undefined} overrides - `recipe.messages['skill-catalog']`。
 * @returns {Array<{name: string, description: string}>} 过滤后的条目。
 */
export function applyCatalogOverrides(entries, overrides) {
  const hidden = new Set(Array.isArray(overrides?.hiddenEntries) ? overrides.hiddenEntries : [])
  const descriptions = overrides?.descriptions ?? {}
  const out = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry?.name !== 'string' || hidden.has(entry.name)) continue
    const description = typeof descriptions[entry.name] === 'string'
      ? descriptions[entry.name]
      : entry.description
    out.push({ ...entry, description: typeof description === 'string' ? description : '' })
  }
  return out
}
