/**
 * profile / home 的 `cordis.patch.yml` 扫描。
 *
 * 完整的 YAML 解析在这里没有收益：patch 的语义只有两种（`insert` 与按
 * `id` 覆盖），而界面需要回答的是「这一行被谁、改了哪些顶层键」。所以
 * 这里只按缩进识别块式 patch，并记下每个 id 的顶层键名；流式 insert
 * 与嵌套 group 不求全——漏报只影响键的展示，不影响覆盖关系本身。
 * @module dsh-plugin-console/host/patch-scan
 */

/**
 * 扫描一个 patch 文件，分别给出插入行与覆盖行。
 *
 * 识别的缩进形状（DSH 组合文件实际使用的块式写法）：
 *   - insert:              ← 顶层，进入插入模式
 *       - id: added        ← 插入行，缩进 > 0
 *         name: pkg        ← 该行的顶层键
 *   - id: existing         ← 顶层，覆盖行
 *     config:              ← 该行的顶层键（嵌套内容不展开）
 *
 * 同一个 id 在一个文件里出现多次时，键取并集，行号取首次出现的位置。
 * @param {string} text - patch 文件内容。
 * @returns {{inserted: Map<string, {keys: string[], line: number}>, overridden: Map<string, {keys: string[], line: number}>}}
 *   插入行与覆盖行；值是该行声明的顶层键与起始行号。
 */
export function scanPatchRows(text) {
  const inserted = new Map()
  const overridden = new Map()
  let inserting = false
  /** @type {{entry: {keys: string[], line: number}, keyIndent: number} | null} */
  let current = null
  let lineNo = 0

  /** 同一个 id 重复出现时复用同一条记录，键去重后合并。 */
  const record = (rows, id, line) => {
    let entry = rows.get(id)
    if (entry === undefined) {
      entry = { keys: [], line }
      rows.set(id, entry)
    }
    return entry
  }

  for (const rawLine of text.split(/\r?\n/)) {
    lineNo++
    // 注释只在行尾截断；引号内的 # 目前不会出现在 id 或键名上。
    const line = rawLine.replace(/#.*$/, '')
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    const body = line.trim()

    // 顶层的每个新条目都会结束上一个 id 的作用域。
    if (indent === 0) {
      current = null
      inserting = false
      if (/^-\s*insert\s*:/.test(body)) {
        inserting = true
        continue
      }
      const idLine = body.match(/^-\s*id\s*:\s*(.+)$/)
      if (idLine === null) continue
      const id = cleanId(idLine[1])
      if (!id) continue
      current = { entry: record(overridden, id, lineNo), keyIndent: 2 }
      continue
    }

    const idLine = body.match(/^-\s*id\s*:\s*(.+)$/)
    if (idLine !== null) {
      const id = cleanId(idLine[1])
      current = inserting && id ? { entry: record(inserted, id, lineNo), keyIndent: indent + 2 } : null
      continue
    }

    if (current === null) continue
    // 缩进回退说明这个行条目结束；顶层键只认它自己那一层。
    if (indent < current.keyIndent) {
      current = null
      continue
    }
    if (indent !== current.keyIndent) continue
    const keyLine = body.match(/^([A-Za-z_][\w-]*)\s*:/)
    if (keyLine === null || keyLine[1] === 'id') continue
    if (!current.entry.keys.includes(keyLine[1])) current.entry.keys.push(keyLine[1])
  }

  return { inserted, overridden }
}

/**
 * 只要 id 集合的兼容入口。
 * @param {string} text - patch 文件内容。
 * @returns {{inserted: Set<string>, overridden: Set<string>}} 两种 id 集合。
 */
export function scanPatchIds(text) {
  const { inserted, overridden } = scanPatchRows(text)
  return { inserted: new Set(inserted.keys()), overridden: new Set(overridden.keys()) }
}

/** 去掉 id 两端的引号，其余字符原样保留。 */
function cleanId(raw) {
  return raw.trim().replace(/^['"]|['"]$/g, '')
}
