/**
 * 内置斜杠命令的身份镜像。
 *
 * `dsh-commands` 的 `builtinCommandTokens` 是首方定义与中英文拼写的权威表，
 * 但它属于宿主包；本插件零依赖、不能 import 宿主包，所以在这里镜像一份。
 * 镜像只影响「别名」的展示：命令清单本身来自 `ctx.commands.list()`，镜像
 * 过期最多让某个别名显示不出来，不会漏掉命令。
 *
 * 对照版本：`@deepseek-ai/dsh-commands` 0.2.2-rc.1。
 * @module dsh-plugin-console/host/command-builtins
 */

/** 首方能力 id → 定义包名；与 dsh-commands 的 BUILTINS 一致。 */
const BUILTIN_IDS = {
  goal: '@deepseek-ai/dsh-command-goal',
  plan: '@deepseek-ai/dsh-plan-mode',
  feedback: '@deepseek-ai/dsh-command-feedback',
  compact: '@deepseek-ai/dsh-command-compact',
  permission: '@deepseek-ai/dsh-permission-presets',
  export: '@deepseek-ai/dsh-session-log-export',
}

/** 中英文拼写；`/目标` 与 `/goal` 解析到同一个首方定义。 */
const TOKENS = {
  en: { goal: 'goal', plan: 'plan', feedback: 'feedback', compact: 'compact', permission: 'permission', export: 'export' },
  zh: { goal: '目标', plan: '计划', feedback: '反馈', compact: '压缩', permission: '权限', export: '导出' },
}

/**
 * 按 definitionId 找内置身份。
 * @param {string | undefined} definitionId - 命令的稳定定义 id。
 * @returns {{id: string, tokens: {zh: string, en: string}} | undefined} 内置身份。
 */
export function builtinOf(definitionId) {
  if (typeof definitionId !== 'string') return undefined
  for (const [id, packageName] of Object.entries(BUILTIN_IDS)) {
    if (definitionId === packageName) {
      return { id, tokens: { zh: TOKENS.zh[id], en: TOKENS.en[id] } }
    }
  }
  return undefined
}
