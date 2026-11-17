/**
 * 会话日志里 `user/message.source.kind` → 产出它的包。
 *
 * 这是**推断**，不是注册表事实：宿主没有把「这条消息由谁注入」登记在任何
 * 公开接口上，只能按已知的来源类型映射回包名。禁用预演用它回答「哪些运行时
 * 消息可能不再注入」，因此调用方必须把结果标成「推断」。
 *
 * 抽成独立模块而不是留在 `session-influence.js`：那边会拖进整个会话日志读取
 * 链路，而禁用预演只需要这张静态表。
 * @module dsh-plugin-console/host/injection-owners
 */

/** source.kind → 产出它的包。没有映射的 kind 留空，由调用方标「未知」。 */
export const MESSAGE_INJECTION_OWNERS = {
  'runtime-context': ['@deepseek-ai/dsh-agent-loop'],
  'time-context': ['@deepseek-ai/dsh-time-context'],
  'skill-catalog': ['@deepseek-ai/dsh-tool-skill'],
  'agent-message': ['@deepseek-ai/dsh-subagent'],
  'subagent-settled': ['@deepseek-ai/dsh-subagent'],
}

/** source.kind 的中文说明；界面只展示这个说法。 */
export const MESSAGE_INJECTION_LABELS = {
  'runtime-context': '运行时上下文',
  'time-context': '时间上下文',
  'skill-catalog': 'skill 目录',
  'agent-message': '子 Agent 消息',
  'subagent-settled': '子 Agent 结束消息',
}

/** 去掉 scope 与子路径，得到裸包名。 */
function bareName(name) {
  if (typeof name !== 'string') return ''
  const parts = name.split('/')
  return name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * 一个条目可能负责的注入类型。
 *
 * 同时用包名与模块名匹配：Loader 行给的是模块说明符，包名是它的裸名；
 * 子路径模块（`@scope/pkg/lib/x`）也归到同一包。
 * @param {string | null | undefined} packageName - 条目包名。
 * @param {string | null | undefined} moduleName - 条目模块说明符。
 * @returns {Array<{sourceKind: string, label: string, owners: string[]}>} 匹配到的注入类型。
 */
export function injectionKindsOf(packageName, moduleName) {
  const candidates = new Set([bareName(packageName), bareName(moduleName)].filter((name) => name !== ''))
  if (candidates.size === 0) return []
  const rows = []
  for (const [sourceKind, owners] of Object.entries(MESSAGE_INJECTION_OWNERS)) {
    if (!owners.some((owner) => candidates.has(owner))) continue
    rows.push({
      sourceKind,
      label: MESSAGE_INJECTION_LABELS[sourceKind] ?? sourceKind,
      owners: [...owners],
    })
  }
  return rows
}
