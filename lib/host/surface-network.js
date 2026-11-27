/**
 * 能力面 · 网络能力与连接：provider 注册表、MCP 状态、入站路由声明、源码调用点。
 *
 * 这是「能力与连接」视图，不是请求流水：宿主没有逐请求记录，本插件也不拦截
 * fetch。四组数据全部来自公开面：
 *   - `ctx.llm.listProviders()` / `ctx.web.listProviders()`：网络 provider 的 id；
 *   - `ctx.mcpManager.list()`：MCP server 的配置与连接状态；
 *   - fiber 的 effect label（`... Fetch route`）与源码里的 `path` 字面量：入站路由；
 *   - 包源码的导入绑定 + 调用形状：fetch / axios / node:http / WebSocket / 配置键。
 *
 * 不返回 endpoint、headers、env、args：它们是配置值，可能含凭据。源码调用点的
 * `target` 只保留去掉凭据与查询串的字面量。单项服务失败只让那一组降级，不影响其余。
 * @module dsh-plugin-console/host/surface-network
 */

import { ownersForMcpServer, ownersForProvider, readSurfaceOwnerIndex } from './surface-owners.js'

/** 从 label 里认出路由：`…: /path Fetch route` 或 `…: /path route`。 */
const ROUTE_LABEL = /[:\s](\/[^\s]+)\s+(?:Fetch\s+)?route$/i

/**
 * 把 effect 树摊平成 label 列表。
 * @param {Array<object>} effects - `readEffects()` 的结果。
 * @param {string[]} out - 收集数组。
 * @returns {string[]} label 列表。
 */
function flattenLabels(effects, out = []) {
  for (const effect of effects ?? []) {
    // `readEffects()` 把子级压平成字符串；顶层才是 `{ label, children }`。
    if (typeof effect === 'string') {
      out.push(effect)
      continue
    }
    if (typeof effect?.label === 'string') out.push(effect.label)
    flattenLabels(effect?.children, out)
  }
  return out
}

/**
 * 从 label 里取路由路径。
 * @param {string} label - effect label。
 * @returns {string | undefined} 路径。
 */
function routeOfLabel(label) {
  const match = ROUTE_LABEL.exec(label)
  return match?.[1]
}

/**
 * MCP 状态只保留可读、可序列化的字段。
 * @param {object | undefined} status - manager 给出的状态。
 * @returns {object} 投影后的状态。
 */
function projectStatus(status) {
  if (status === undefined || status === null || typeof status !== 'object') return { state: 'unknown' }
  return {
    state: typeof status.state === 'string' ? status.state : 'unknown',
    ...(typeof status.attempt === 'number' ? { attempt: status.attempt } : {}),
    ...(typeof status.reason === 'string' ? { reason: status.reason } : {}),
    ...(typeof status.lastError === 'string' ? { lastError: status.lastError } : {}),
  }
}

/**
 * 读一组 provider。
 * @param {Function} read - 返回 provider 数组的函数。
 * @param {Array<object>} index - 归属索引。
 * @param {'llmProviders' | 'webSearch' | 'webFetch'} field - 归属字段。
 * @param {Function} project - provider → 展示行。
 * @returns {{available: boolean, providers: Array<object>, reason?: string}} 分组结果。
 */
function readProviders(read, index, field, project) {
  try {
    const rows = read()
    if (!Array.isArray(rows)) return { available: false, providers: [], reason: '服务没有返回列表' }
    return {
      available: true,
      providers: rows
        .filter((row) => typeof row?.id === 'string' && row.id.length > 0)
        .map((row) => ({ ...project(row), evidence: 'runtime', ...ownersForProvider(row.id, index, field) })),
    }
  } catch (error) {
    return { available: false, providers: [], reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 读网络能力与连接。
 * @param {object} ctx - host 插件上下文。
 * @returns {Promise<object>} `{ llm, web, mcp, inbound, notes, warnings }`。
 */
export async function readSurfaceNetwork(ctx) {
  const warnings = []
  let index = []
  try {
    index = await readSurfaceOwnerIndex(ctx)
  } catch (error) {
    warnings.push(`归属索引构建失败：${error instanceof Error ? error.message : String(error)}`)
  }
  // 源码调用点与 provider / MCP 归属共用这份索引；没有包目录就只剩运行时事实。
  if (ctx.get('pluginPackages') === undefined) {
    warnings.push('缺少 pluginPackages 服务：源码网络调用点无法归属到插件')
  }

  const llm = ctx.get('llm')
  const llmSection = llm === undefined || typeof llm.listProviders !== 'function'
    ? { available: false, providers: [], reason: '宿主没有 llm 服务：无法读取模型 provider' }
    : readProviders(() => llm.listProviders(), index, 'llmProviders', (row) => ({
        id: row.id,
        ...(typeof row.name === 'string' ? { name: row.name } : {}),
      }))

  const web = ctx.get('web')
  let webSection
  if (web === undefined || typeof web.listProviders !== 'function') {
    webSection = {
      available: false,
      search: { available: false, providers: [], reason: '宿主没有 web 服务' },
      fetch: { available: false, providers: [], reason: '宿主没有 web 服务' },
    }
  } else {
    try {
      const list = web.listProviders()
      const project = (row) => ({
        id: row.id,
        ...(typeof row.title === 'string' ? { title: row.title } : {}),
        ...(typeof row.description === 'string' ? { description: row.description } : {}),
      })
      const search = Array.isArray(list?.search) ? list.search : []
      const fetchRows = Array.isArray(list?.fetch) ? list.fetch : []
      webSection = {
        available: true,
        search: {
          available: true,
          providers: search
            .filter((row) => typeof row?.id === 'string' && row.id.length > 0)
            .map((row) => ({ ...project(row), evidence: 'runtime', ...ownersForProvider(row.id, index, 'webSearch') })),
        },
        fetch: {
          available: true,
          providers: fetchRows
            .filter((row) => typeof row?.id === 'string' && row.id.length > 0)
            .map((row) => ({ ...project(row), evidence: 'runtime', ...ownersForProvider(row.id, index, 'webFetch') })),
        },
      }
    } catch (error) {
      webSection = {
        available: false,
        search: { available: false, providers: [], reason: error instanceof Error ? error.message : String(error) },
        fetch: { available: false, providers: [], reason: error instanceof Error ? error.message : String(error) },
      }
    }
  }

  const mcpManager = ctx.get('mcpManager')
  let mcpSection
  if (mcpManager === undefined || typeof mcpManager.list !== 'function') {
    mcpSection = { available: false, servers: [], reason: '宿主没有 mcpManager 服务：无法读取 MCP 连接状态' }
  } else {
    try {
      mcpSection = {
        available: true,
        servers: mcpManager.list()
          .filter((row) => typeof row?.name === 'string' && row.name.length > 0)
          .map((row) => ({
            name: row.name,
            configured: row.configured === true,
            status: projectStatus(row.status),
            evidence: 'runtime',
            ...ownersForMcpServer(row.name, index),
          })),
      }
    } catch (error) {
      mcpSection = { available: false, servers: [], reason: error instanceof Error ? error.message : String(error) }
    }
  }

  // 入站路由：label 是注册时写下的事实，源码 path 只补 label 没覆盖到的行。
  const routes = new Map()
  for (const row of index) {
    for (const label of flattenLabels(row.effects)) {
      const path = routeOfLabel(label)
      if (path === undefined) continue
      const key = path + '|' + row.rowId
      const existing = routes.get(key)
      if (existing !== undefined) {
        existing.labels.add(label)
        continue
      }
      routes.set(key, { path, owners: [row.rowId], evidence: 'label', labels: new Set([label]) })
    }
  }
  for (const row of index) {
    for (const path of row.registrations?.routePaths ?? []) {
      if (typeof path !== 'string' || path.length === 0) continue
      const key = path + '|' + row.rowId
      if (routes.has(key)) continue
      routes.set(key, { path, owners: [row.rowId], evidence: 'scan', labels: new Set() })
    }
  }
  const inboundRoutes = [...routes.values()].map((row) => ({
    path: row.path,
    owners: row.owners,
    evidence: row.evidence,
    ...(row.labels.size === 0 ? {} : { label: [...row.labels][0] }),
  }))

  // 源码网络调用点：静态证据，补运行时注册表看不到的直接请求（fetch / axios /
  // node:http / WebSocket / 配置键）。按 Loader 行归属，和 provider 一样没有
  // 运行时登记可查。
  const SOURCE_LIMIT = 150
  const sourceSites = []
  let sourceTruncated = false
  for (const row of index) {
    for (const site of row.registrations?.networkSites ?? []) {
      if (sourceSites.length >= SOURCE_LIMIT) {
        sourceTruncated = true
        break
      }
      sourceSites.push({ ...site, owners: [row.rowId] })
    }
    if (sourceTruncated) break
  }

  return {
    llm: llmSection,
    web: webSection,
    mcp: mcpSection,
    inbound: { available: true, routes: inboundRoutes },
    source: {
      available: true,
      sites: sourceSites,
      ...(sourceTruncated ? { truncated: true } : {}),
    },
    notes: [
      '只展示 provider / 连接状态 / 路由声明 / 源码调用点：endpoint、headers、env、args 是配置值，可能含凭据，不在此返回。',
      '源码网络调用是静态扫描事实：说明源码里写了这个调用与可读端点，不证明请求真的发生过。',
    ],
    warnings,
  }
}
