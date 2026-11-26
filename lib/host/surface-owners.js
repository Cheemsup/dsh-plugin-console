/**
 * 能力面的归属索引：把运行时名字接回 Loader 行。
 *
 * 技能、命令、provider 的运行时列表都只带名字，不带「谁注册的」。这里按
 * 同一套顺序解析：
 *   1. runtime 字段本身是包名/包名后缀（provider、definitionId）；
 *   2. 源码扫描得到的注册名；
 *   3. 都匹配不到时返回空 owners，并给出原因，不硬凑近似结果。
 *
 * 行身份与 `entries.js` 保持一致：`include:` 前缀去掉后才是组合行 id；
 * 包目录来自 `pluginPackages.packageOf()`，扫描结果由 `source-scan` 自己缓存。
 * @module dsh-plugin-console/host/surface-owners
 */

import { readEffects } from './fiber.js'
import { scanPackageRegistrations } from './source-scan.js'

/** 一次索引构建的最长复用时间；Loader 变更后最多这么久才会被重新读到。 */
const INDEX_TTL_MS = 30_000

/** ctx → { at, promise }。同一份 ctx 的索引只建一次；路由是懒取的，不会互相拖住。 */
const INDEX = new WeakMap()

/**
 * 取模块名的裸名：去掉 scope 后按 `/` 切最后一段。
 * @param {string} moduleName - Loader 的模块名。
 * @returns {string} 裸名。
 */
function bareModule(moduleName) {
  return String(moduleName ?? '').replace(/^@[^/]+\//, '').split(/[\\/]/).pop() ?? ''
}

/**
 * provider / 包名后缀是否指向这个模块。
 *
 * DSH 的 provider 习惯用包名去掉 `dsh-` 前缀后的短名（`skill-filesystem`），
 * 所以同时接受完整裸名、`-` 后缀与 scope 全名。
 * @param {string} moduleName - Loader 的模块名。
 * @param {string} provider - 运行时给出的 provider / 包标识。
 * @returns {boolean} 是否匹配。
 */
export function moduleMatchesProvider(moduleName, provider) {
  if (typeof moduleName !== 'string' || typeof provider !== 'string' || provider.length === 0) return false
  const bare = bareModule(moduleName)
  if (bare === provider) return true
  if (bare.endsWith('-' + provider)) return true
  if (moduleName === provider || moduleName.startsWith(provider + '/')) return true
  return false
}

/**
 * 构建一份轻量索引：Loader 行 + 包目录 + 源码扫描结果。
 * @param {object} ctx - host 插件上下文。
 * @returns {Promise<Array<object>>} 行。
 */
async function buildIndex(ctx) {
  const packages = ctx.get('pluginPackages')
  const rows = []
  let entries = []
  try {
    entries = [...(ctx.loader?.entries?.() ?? [])]
  } catch {
    entries = []
  }

  for (const entry of entries) {
    const moduleName = entry?.options?.name
    if (typeof moduleName !== 'string' || moduleName.length === 0) continue
    const base = entry.parent?.tree?.ctx?.baseUrl
    let pkg
    try {
      pkg = base === undefined || packages === undefined ? undefined : packages.packageOf(moduleName, base)
    } catch {
      pkg = undefined
    }
    rows.push({
      entryId: typeof entry.id === 'string' ? entry.id : String(entry.id ?? ''),
      rowId: String(entry.id ?? '').replace(/^include:/, ''),
      moduleName,
      packageDir: typeof pkg?.dir === 'string' ? pkg.dir : undefined,
      mcpServerName: typeof entry?.options?.config?.serverName === 'string' ? entry.options.config.serverName : undefined,
      effects: readEffects(entry?.fiber),
      registrations: undefined,
    })
  }

  // 扫描放在构建阶段一次做完；`scanPackageRegistrations` 自己按包目录 stat 缓存，
  // 这里不再叠一层，避免插件热重载后读到旧结果。
  for (const row of rows) {
    row.registrations = await scanPackageRegistrations(row.packageDir)
  }
  return rows
}

/**
 * 读取归属索引（30 秒内复用同一份）。
 * @param {object} ctx - host 插件上下文。
 * @returns {Promise<Array<object>>} 行。
 */
export function readSurfaceOwnerIndex(ctx) {
  const cached = INDEX.get(ctx)
  if (cached !== undefined && Date.now() - cached.at < INDEX_TTL_MS) return cached.promise
  const promise = buildIndex(ctx).catch(() => [])
  INDEX.set(ctx, { at: Date.now(), promise })
  return promise
}

/**
 * 一条 provider 的归属（LLM / web 搜索 / web 抓取）。
 * @param {string} id - provider id。
 * @param {Array<object>} rows - 归属索引。
 * @param {'llmProviders' | 'webSearch' | 'webFetch'} field - 源码扫描里的字段。
 * @returns {{owners: string[], via: string, ownerReason?: string}} 归属。
 */
export function ownersForProvider(id, rows, field) {
  const scanned = uniqueOwners(rows
    .filter((row) => (row.registrations?.[field] ?? []).includes(id))
    .map((row) => row.rowId))
  if (scanned.length > 0) return { owners: scanned, via: 'scan' }
  const byModule = uniqueOwners(rows
    .filter((row) => moduleMatchesProvider(row.moduleName, id))
    .map((row) => row.rowId))
  if (byModule.length > 0) return { owners: byModule, via: 'provider' }
  return {
    owners: [],
    via: 'none',
    ownerReason: `provider「${id}」没有对应的 Loader 行，源码扫描也没有同 id 注册点`,
  }
}

/**
 * 一个 MCP server 的归属：配置键或注册名都落在某一行上。
 * @param {string} name - server 名。
 * @param {Array<object>} rows - 归属索引。
 * @returns {{owners: string[], via: string, ownerReason?: string}} 归属。
 */
export function ownersForMcpServer(name, rows) {
  const configured = uniqueOwners(rows
    .filter((row) => row.mcpServerName === name)
    .map((row) => row.rowId))
  if (configured.length > 0) return { owners: configured, via: 'config' }
  const scanned = uniqueOwners(rows
    .filter((row) => (row.registrations?.mcpServers ?? []).includes(name))
    .map((row) => row.rowId))
  if (scanned.length > 0) return { owners: scanned, via: 'scan' }
  return { owners: [], via: 'none', ownerReason: `MCP server「${name}」没有对应的 Loader 行` }
}

/**
 * 一条命令的归属。
 *
 * `definitionId` 是一等事实（首方命令都写成包全名）；没有时退回源码扫描的
 * `commands` 名字表。两者都没有就是未归属。
 * @param {object} command - `commands.list()` 的一行。
 * @param {Array<object>} rows - 归属索引。
 * @returns {{owners: string[], via: string, ownerReason?: string}} 归属。
 */
export function ownersForCommand(command, rows) {
  const definitionId = typeof command?.definitionId === 'string' ? command.definitionId : ''
  if (definitionId.length > 0) {
    const matched = uniqueOwners(rows
      .filter((row) => row.moduleName === definitionId || moduleMatchesProvider(row.moduleName, definitionId))
      .map((row) => row.rowId))
    if (matched.length > 0) return { owners: matched, via: 'definitionId' }
  }

  const name = typeof command?.name === 'string' ? command.name : ''
  const scanned = uniqueOwners(rows
    .filter((row) => (row.registrations?.commands ?? []).includes(name))
    .map((row) => row.rowId))
  if (scanned.length > 0) return { owners: scanned, via: 'scan' }

  return {
    owners: [],
    via: 'none',
    ownerReason: definitionId.length > 0
      ? `definitionId「${definitionId}」没有对应的 Loader 行，源码扫描也没有同名命令`
      : '命令没有 definitionId，源码扫描也没有同名注册点',
  }
}

/**
 * 从一个名字的所有者里取出去重后的行 id。
 * @param {Iterable<string>} ids - 行 id。
 * @returns {string[]} 去重后的行 id。
 */
function uniqueOwners(ids) {
  return [...new Set([...ids].filter((id) => typeof id === 'string' && id.length > 0))]
}

/**
 * 一条 skill 的归属。
 *
 * provider 是运行时字段，优先；`runtime` provider 或匹配不到时再按源码扫描的
 * `runtimeSkills` 找。两边都没有就是未归属，并写明原因。
 * @param {object} skill - `ctx.skills.snapshot()` 的一行。
 * @param {Array<object>} rows - 归属索引。
 * @returns {{owners: string[], via: string, ownerReason?: string}} 归属。
 */
export function ownersForSkill(skill, rows) {
  const provider = typeof skill?.provider === 'string' ? skill.provider : ''
  if (provider.length > 0 && provider !== 'runtime') {
    const matched = uniqueOwners(rows
      .filter((row) => moduleMatchesProvider(row.moduleName, provider))
      .map((row) => row.rowId))
    if (matched.length > 0) return { owners: matched, via: 'provider' }
  }

  const name = typeof skill?.name === 'string' ? skill.name : ''
  const scanned = uniqueOwners(rows
    .filter((row) => (row.registrations?.runtimeSkills ?? []).includes(name))
    .map((row) => row.rowId))
  if (scanned.length > 0) return { owners: scanned, via: 'scan' }

  const reason = provider === 'runtime' || provider.length === 0
    ? '运行时注册的技能：源码扫描没有找到同名注册点'
    : `provider「${provider}」在 Loader 树里没有对应包，源码扫描也没有同名注册点`
  return { owners: [], via: 'none', ownerReason: reason }
}
