/**
 * 名字归一与来源层判定。
 *
 * 这三个函数处理的是「一行的身份从哪来」这类问题：包名怎么从模块标识里取、
 * 没有组合包认领的行该算哪一层、哪些行只是 Loader 的结构行。
 * @module dsh-plugin-console/host/names
 */

/**
 * 从包名得到「裸包名」：`@scope/name` 或 `name`，丢弃子路径导出。
 * @param {string} specifier - Loader 行的模块标识。
 * @returns {string | undefined} 裸包名；不是包标识时 undefined。
 */
export function barePackageName(specifier) {
  if (typeof specifier !== 'string' || specifier.startsWith('.') || specifier.startsWith('cordis:')) return undefined
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined
  return parts[0]
}

/**
 * 没有 bundle 认领的行，按来源判层。
 *
 * - `cordis:*` 是 Loader 结构行（include 根、group），不属于任何组合包；
 * - 深度 0 且无 bundle 认领的行，是插件在运行时用 `ctx.plugin()` 直接挂上的
 *   子 fiber（例如目录选择器的原生实现），也不来自任何 patch；
 * - 其余未认领的行只可能是 profile 或 home 补丁自己插入的。
 * @param {string} moduleName - 行的模块标识。
 * @param {number} depth - 条目在 id 路径上的深度；顶层根行的深度是 0。
 * @returns {string} 层标识。
 */
export function fallbackLayer(moduleName, depth) {
  if (typeof moduleName === 'string' && moduleName.startsWith('cordis:')) return 'cordis'
  return depth === 0 ? 'runtime' : 'profile'
}

/**
 * 结构行（cordis:include、cordis:group）不是插件，不计入任何统计。
 * @param {object} entry - 已采集的条目。
 * @returns {boolean} 是否结构行。
 */
export function isStructuralEntry(entry) {
  return typeof entry.moduleName === 'string' && entry.moduleName.startsWith('cordis:')
}
