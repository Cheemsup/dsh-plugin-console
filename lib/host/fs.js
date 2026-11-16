/**
 * 只读文件访问。
 *
 * 快照里的每一次文件读取都是**可选的**：读不到就降级，不让整份快照失败。
 * 因此这里的函数全部返回 `null` 而不是抛错。文件读取只在快照时发生，
 * 不参与模块加载期。
 * @module dsh-plugin-console/host/fs
 */

/**
 * 读一个文本文件；任何失败都返回 null。
 * @param {string} file - 绝对路径。
 * @returns {Promise<string | null>} 文件内容或 null。
 */
export async function readTextFile(file) {
  try {
    const { readFile } = await import('node:fs/promises')
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * 读一个 JSON 文件；解析失败同样返回 null。
 * @param {string} file - 绝对路径。
 * @returns {Promise<any | null>} 解析结果或 null。
 */
export async function readJsonFile(file) {
  const text = await readTextFile(file)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 列一个目录的文件名；失败返回空数组。
 * @param {string} dir - 绝对路径。
 * @returns {Promise<string[]>} 文件名列表。
 */
export async function listDir(dir) {
  try {
    const { readdir } = await import('node:fs/promises')
    return await readdir(dir)
  } catch {
    return []
  }
}

/**
 * 列一个目录的条目（带类型）；失败返回空数组。
 * @param {string} dir - 绝对路径。
 * @returns {Promise<Array<{name: string, isDirectory: boolean, isFile: boolean}>>} 条目列表。
 */
export async function listDirDetailed(dir) {
  try {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }))
  } catch {
    return []
  }
}

/**
 * 判断一个路径是不是目录；任何失败都返回 false。
 * @param {string} dir - 绝对路径。
 * @returns {Promise<boolean>} 是否是目录。
 */
export async function isDirectory(dir) {
  try {
    const { stat } = await import('node:fs/promises')
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 读一个文件的元信息；失败返回 null。
 * @param {string} file - 绝对路径。
 * @returns {Promise<{mtimeMs: number, size: number} | null>} 元信息或 null。
 */
export async function statFile(file) {
  try {
    const { stat } = await import('node:fs/promises')
    const value = await stat(file)
    return { mtimeMs: value.mtimeMs, size: value.size }
  } catch {
    return null
  }
}
