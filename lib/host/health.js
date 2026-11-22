/**
 * 健康摘要与「需要关注」列表。
 *
 * 这一层不读新的数据源，只把快照里已经采到的事实压成两个用户问题：
 *   1. 现在有多少东西不正常？（summary）
 *   2. 具体是哪几项，按什么顺序看？（attention）
 *
 * 判断只依赖运行时事实与已有的归属索引，因此同一个快照反复计算得到同一份结果。
 * 活动、错误率、延迟等需要读 session log 的指标留给后续阶段，不在这里推断。
 * @module dsh-plugin-console/host/health
 */

/** 严重度排序：数字越小越靠前。 */
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 }

/** 同类问题的展示顺序：先故障，再缺依赖，最后是归属。 */
const KIND_RANK = {
  failed: 0,
  'missing-service': 1,
  'unattributed-tools': 2,
  'unattributed-sections': 3,
}

/** 单次最多返回多少条关注项；summary 仍保留全量计数。 */
const MAX_ATTENTION = 40

/** 结构行（cordis:include 等）不是插件，不参与健康统计。 */
function isStructural(entry) {
  return typeof entry?.moduleName === 'string' && entry.moduleName.startsWith('cordis:')
}

/** 插件在界面上的名字：组合行 id；同一个包挂载成多行时标题会重复。 */
function displayName(entry) {
  if (typeof entry?.rowId === 'string' && entry.rowId.length > 0) return entry.rowId
  if (typeof entry?.entryId === 'string' && entry.entryId.length > 0) return entry.entryId
  if (typeof entry?.title === 'string' && entry.title.length > 0) return entry.title
  if (typeof entry?.packageName === 'string' && entry.packageName.length > 0) return entry.packageName
  if (typeof entry?.moduleName === 'string' && entry.moduleName.length > 0) return entry.moduleName
  return '未知插件'
}

/**
 * 一个条目缺了哪些必需服务。
 * @param {object} entry - 已采集的 Loader 条目。
 * @param {object} services - 服务名 → `{ providers, consumers }`。
 * @returns {string[]} 没有提供者的服务名。
 */
function missingServicesOf(entry, services) {
  return (entry?.requires ?? []).filter((name) => (services?.[name]?.providers ?? []).length === 0)
}

/** 把名字列表压成一句短摘要，避免关注项被长列表撑开。 */
function sampleNames(names, limit = 5) {
  if (names.length === 0) return '（无）'
  const head = names.slice(0, limit).join('、')
  return names.length > limit ? `${head} 等 ${names.length} 个` : head
}

/**
 * 计算健康摘要与关注项。
 * @param {object} input - 快照里的相关事实。
 * @param {Array<object>} [input.entries] - 全部条目（含结构行与模式合成条目）。
 * @param {object} [input.services] - 服务名 → 提供者/消费者。
 * @param {object} [input.tools] - 至少包含 `attributed`。
 * @param {object} [input.prompt] - 至少包含 `sections` / `contexts`。
 * @returns {{summary: object, attention: Array<object>}} 摘要与按严重度排序的关注项。
 */
export function computeHealth(input = {}) {
  const entries = Array.isArray(input.entries) ? input.entries : []
  const services = input.services ?? {}
  const attributedTools = Array.isArray(input.tools?.attributed) ? input.tools.attributed : []
  const promptSections = Array.isArray(input.prompt?.sections) ? input.prompt.sections : []
  const promptContexts = Array.isArray(input.prompt?.contexts) ? input.prompt.contexts : []
  const plugins = entries.filter((entry) => !isStructural(entry))

  const attention = []
  let conditional = 0
  let overridden = 0
  let missingServices = 0

  for (const entry of plugins) {
    if (entry.phase === 'failed') {
      attention.push({
        id: 'failed:' + entry.entryId,
        severity: 'critical',
        kind: 'failed',
        title: displayName(entry) + ' 启动失败',
        detail: typeof entry.diagnostic === 'string' && entry.diagnostic.length > 0
          ? entry.diagnostic
          : 'fiber 阶段为 failed；诊断未返回。',
        entryId: entry.entryId,
        rowId: entry.rowId,
        moduleName: entry.moduleName,
      })
    }

    const missing = entry.enabled === true ? missingServicesOf(entry, services) : []
    if (missing.length > 0) {
      missingServices++
      attention.push({
        id: 'missing-service:' + entry.entryId,
        severity: 'warning',
        kind: 'missing-service',
        title: displayName(entry) + ' 缺少服务',
        detail: '没有提供者：' + missing.join('、'),
        entryId: entry.entryId,
        rowId: entry.rowId,
        moduleName: entry.moduleName,
        services: missing,
      })
    }

    if (entry.disabledExpr !== undefined && entry.enabled !== true) {
      // 条件禁用是声明语义，不一定是问题；只进 summary，不占用关注项。
      conditional++
    }

    if ((entry.overriddenBy ?? []).length > 0) overridden++
  }

  const unattributedTools = attributedTools
    .filter((tool) => (tool.owners ?? []).length === 0)
    .map((tool) => tool.name)
  const unattributedSections = [...promptSections, ...promptContexts]
    .filter((row) => (row.owners ?? []).length === 0)
    .map((row) => row.name)

  if (unattributedTools.length > 0) {
    attention.push({
      id: 'unattributed-tools',
      severity: 'info',
      kind: 'unattributed-tools',
      title: `${unattributedTools.length} 个工具没有归属`,
      detail: '无法从源码字面量或 MCP 规则确定注册者：' + sampleNames(unattributedTools),
      names: unattributedTools,
    })
  }

  if (unattributedSections.length > 0) {
    attention.push({
      id: 'unattributed-sections',
      severity: 'info',
      kind: 'unattributed-sections',
      title: `${unattributedSections.length} 个提示词段没有归属`,
      detail: '无法从源码字面量确定注册者：' + sampleNames(unattributedSections),
      names: unattributedSections,
    })
  }

  attention.sort((left, right) => {
    const severity = (SEVERITY_RANK[left.severity] ?? 9) - (SEVERITY_RANK[right.severity] ?? 9)
    if (severity !== 0) return severity
    const kind = (KIND_RANK[left.kind] ?? 9) - (KIND_RANK[right.kind] ?? 9)
    if (kind !== 0) return kind
    return String(left.title).localeCompare(String(right.title))
  })

  const countBySeverity = (severity) => attention.filter((item) => item.severity === severity).length
  const summary = {
    entries: plugins.length,
    active: plugins.filter((entry) => entry.phase === 'active').length,
    pending: plugins.filter((entry) => entry.phase === 'pending').length,
    failed: plugins.filter((entry) => entry.phase === 'failed').length,
    disabled: plugins.filter((entry) => entry.enabled !== true).length,
    conditional,
    missingServices,
    overridden,
    modeOnly: plugins.filter((entry) => entry.modeOnly === true).length,
    unattributedTools: unattributedTools.length,
    unattributedSections: unattributedSections.length,
    totalTools: attributedTools.length,
    totalSections: promptSections.length + promptContexts.length,
    attention: attention.length,
    critical: countBySeverity('critical'),
    warning: countBySeverity('warning'),
    info: countBySeverity('info'),
  }

  return { summary, attention: attention.slice(0, MAX_ATTENTION) }
}
