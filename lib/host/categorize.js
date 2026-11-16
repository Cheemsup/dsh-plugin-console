/**
 * 面向用户的能力分类。
 *
 * 分类依据是包的职责而不是命名：用户问「哪些插件给我加了工具」时，
 * `dsh-tool-fs` 和 `dsh-mcp-client` 应该在同一个栏，尽管后者名字里没有 tool。
 * 顺序有意义——先命中先返回，所以 `tool-` 规则必须排在 `client-*` 之前。
 * @module dsh-plugin-console/host/categorize
 */

/**
 * 把插件归到一个面向用户的「能力类别」。
 * @param {string} moduleName - 行的模块标识。
 * @param {object} entry - 已采集的条目（用于看它注册了什么）。
 * @returns {string} 类别 id。
 */
export function categorize(moduleName, entry) {
  const name = typeof moduleName === 'string' ? moduleName : ''
  // 结构行与 MCP 客户端优先
  if (name.startsWith('cordis:')) return 'structure'
  if (/dsh-mcp-client|dsh-mcp-resources/.test(name)) return 'extend'
  // 工具：名字里带 tool，或实际注册了工具且不是 MCP
  if (/dsh-tool[-/]|\/tools$|-tools$/.test(name)) return 'tool'
  // 界面
  if (/client-ui/.test(name)) return 'ui'
  // 模型
  if (/dsh-llm/.test(name)) return 'model'
  // 会话与持久化
  if (/dsh-session|session-projection|session-query|session-format|session-persistence/.test(name)) return 'session'
  // 安全
  if (/sandbox|approval|permission-presets|fs-observation-policy|authorization|credentials/.test(name)) return 'safety'
  // 传输与网关
  if (/dsh-api-|api-gateway|typert|remote-access|dsh-acp|jsonrpc/.test(name)) return 'transport'
  // 扩展能力
  if (/dsh-skill|dsh-command|dsh-goal|plan-mode|compaction|dsh-subagent|workflow|dsh-ptc|dsh-web|repeat-tool|spill|token-meter|context-|persona|agent-instructions|system-prompt|attachment|file-reference|deliverable/.test(name)) return 'extend'
  // 客户端内核
  if (/dsh-client-|dsh-web-app|dsh-frontend|dsh-web-frontend/.test(name)) return 'client'
  // 其余是宿主基础设施
  if (/dsh-storage|dsh-subprocess|dsh-timer|cordis-plugin|dsh-hmr|dsh-otel|dsh-shell-env|dsh-config-editor|dsh-settings|dsh-workspace|dsh-home-paths|dsh-atomic|dsh-timeout|dsh-chunked|dsh-jobs|plugin-manager|plugin-inventory|package-inventory|dsh-brand|dsh-deepseek-account|dsh-agent|dsh-scope|dsh-tools/.test(name)) return 'infra'
  return 'other'
}
