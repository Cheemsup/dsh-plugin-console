/**
 * 读一个 prompt 注册点的源码片段。
 *
 * 插件页要知道「这个名字在源码里怎么写的」，但快照只带 file/line/receiver，
 * 不带正文：正文是低频查看的数据，塞进每 30 秒轮询的快照会把体积推到 MB 级。
 * 所以这里按需读一个包的一个文件，并把结果压到固定上限。
 *
 * 安全边界与源码扫描一致：只读包目录内的 `lib/**\/*.{js,mjs,cjs}`；客户端只能
 * 传模块名与名字，不能传路径。任何失败都返回 `found: false` + 原因，不抛到页面。
 * @module dsh-plugin-console/host/registration-site
 */

import path from 'node:path'
import { isDirectory, readTextFile } from './fs.js'
import { registrationSitesOf, scanPackageRegistrations } from './source-scan.js'

/** 注册点短窗口的字符上限。 */
const SNIPPET_LIMIT = 8 * 1024

/** 「查看完整文件」的字符上限；再大也只给前缀。 */
const FILE_LIMIT = 24 * 1024

/** 注册点短窗口的半径（行）。 */
const WINDOW_LINES = 16

/** 一次最多返回几个站点：bundle 与 types 各一份时，多出来的只是重复。 */
const MAX_SITES = 3

/** 单次响应的总字符上限。 */
const TOTAL_LIMIT = 72 * 1024

/**
 * 从 Loader 条目解析包目录。
 *
 * 正常插件有 Loader 行，`pluginPackages.packageOf(moduleName, base)` 能给出目录；
 * 只由模式声明的插件没有自己的行，按「任一行的包目录 → node_modules 根 → 裸包名」
 * 推导。推导失败就返回 undefined，由调用方降级。
 * @param {object} ctx - host 插件上下文。
 * @param {string} moduleName - 模块名。
 * @returns {Promise<string | undefined>} 包目录。
 */
async function resolvePackageDir(ctx, moduleName) {
  const packages = ctx.get('pluginPackages')
  const entries = typeof ctx.loader?.entries === 'function' ? [...ctx.loader.entries()] : []
  const packageOf = (name, base) => {
    if (base === undefined || packages === undefined) return undefined
    try {
      return packages.packageOf(name, base)
    } catch {
      return undefined
    }
  }

  for (const entry of entries) {
    if (entry.options?.name !== moduleName) continue
    const base = entry.parent?.tree?.ctx?.baseUrl
    const pkg = packageOf(moduleName, base)
    if (typeof pkg?.dir === 'string') return pkg.dir
  }

  // 模式专属模块：从任一行的包目录推出 node_modules 根，再按完整模块名拼候选。
  // 不能只去掉最后一段再拼裸包名：`@scope/pkg` 会丢掉 scope。
  for (const entry of entries) {
    const name = entry.options?.name
    if (typeof name !== 'string') continue
    const base = entry.parent?.tree?.ctx?.baseUrl
    const pkg = packageOf(name, base)
    if (typeof pkg?.dir !== 'string') continue
    const normalized = pkg.dir.replace(/\\/g, '/')
    const marker = normalized.lastIndexOf('/node_modules/')
    const root = marker >= 0
      ? pkg.dir.slice(0, marker + '/node_modules'.length)
      : pkg.dir.replace(/[\\/][^\\/]+$/, '')
    const candidate = `${root}/${moduleName}`
    if (await isDirectory(candidate)) return candidate
  }
  return undefined
}

/**
 * 把文件切成片段。
 *
 * 默认只给注册点前后 16 行：源码是「注入点在哪、条件是什么」的证据，不是正文；
 * 完整文件是用户主动点「查看完整文件」后的第二层，且有独立上限。
 * @param {string} text - 文件内容。
 * @param {number} line - 注册点行号（1 起）。
 * @param {'focus' | 'file'} mode - 短窗口或完整文件。
 * @returns {{ text: string, startLine: number, endLine: number, truncated: boolean, windowed: boolean }} 片段。
 */
function snippetOf(text, line, mode) {
  if (mode === 'file') {
    const clipped = text.slice(0, FILE_LIMIT)
    return {
      text: clipped,
      startLine: 1,
      endLine: clipped.split('\n').length,
      truncated: text.length > FILE_LIMIT,
      windowed: false,
    }
  }
  const lines = text.split('\n')
  const startLine = Math.max(1, line - WINDOW_LINES)
  const endLine = Math.min(lines.length, line + WINDOW_LINES)
  let body = lines.slice(startLine - 1, endLine).join('\n')
  // 「窗口化了」和「被大小上限截断」是两件事：前者是默认展示策略，
  // 后者才说明内容确实丢了；界面只对后者写「已截断」。
  const windowed = startLine > 1 || endLine < lines.length
  const truncated = body.length > SNIPPET_LIMIT
  if (truncated) body = body.slice(0, SNIPPET_LIMIT)
  return { text: body, startLine, endLine, truncated, windowed }
}

/**
 * 读取一个注册点的源码片段。
 * @param {object} ctx - host 插件上下文。
 * @param {{ moduleName: string, kind: 'section' | 'context' | 'variable', name: string, mode?: 'focus' | 'file' }} options - 目标。
 * @returns {Promise<object>} `{ found, mode?, reason?, sites? }`。
 */
export async function readRegistrationSnippet(ctx, options) {
  const mode = options.mode === 'file' ? 'file' : 'focus'
  const packageDir = await resolvePackageDir(ctx, options.moduleName)
  if (packageDir === undefined) return { found: false, reason: '找不到这个模块的包目录' }

  const registrations = await scanPackageRegistrations(packageDir)
  const matches = registrationSitesOf(registrations, options.kind, options.name)
  if (matches.length === 0) return { found: false, reason: '包源码里没有找到这个注册点' }

  // 入口 bundle 通常是最大的文件，围绕注册点的窗口可能看不到相邻的常量定义；
  // 非入口的 types/*.js 往往更短、更完整。展示时把它们排在前面。
  const entryRank = (file) => (/(^|\/)index\.(?:mjs|cjs|js)$/.test(file) ? 1 : 0)
  const ordered = [...matches].sort((left, right) => (
    entryRank(left.file) - entryRank(right.file)
    || left.file.localeCompare(right.file)
    || left.line - right.line
  ))

  const root = path.resolve(packageDir)
  const sites = []
  let total = 0
  for (const site of ordered.slice(0, MAX_SITES)) {
    const absolute = path.resolve(root, site.file)
    // 路径必须在包目录内；注册点来自扫描结果，但这条检查防止未来扫描器变更越界。
    if (absolute !== root && !absolute.startsWith(root + path.sep)) continue
    if (!/\.(?:js|mjs|cjs)$/.test(absolute)) continue
    const text = await readTextFile(absolute)
    if (text === null) continue
    const snippet = snippetOf(text, site.line, mode)
    if (total + snippet.text.length > TOTAL_LIMIT) break
    total += snippet.text.length
    sites.push({ ...site, snippet })
  }
  if (sites.length === 0) return { found: false, reason: '注册点文件读不到' }
  return { found: true, mode, sites }
}
