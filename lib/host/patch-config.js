/**
 * patch 文件的 config 子树扫描与有限 YAML 解析。
 *
 * 为什么不直接用完整 YAML：本插件零依赖，而这里要回答的问题很窄——
 * 「某一层给这一行声明了哪些 config 键、值是什么」。因此只实现 DSH 组合
 * 文件实际出现的块式写法；遇到块标量、锚点、跨行流式值这类不支持的构造，
 * 保留原文并标记 `parsed:false`，**不猜一个看起来合理的值**。
 *
 * 与 `patch-scan.js` 的分工：那边只回答「被谁、改了哪些顶层键」，是快照的
 * 轻量事实；这里回答「改成了什么」，只在禁用预演按需读取一个目标行。
 * 两套扫描器独立演进，`verify-patch-config.mjs` 用同一份样例断言 id、类型与
 * 顶层键名一致，防止语义悄悄分叉。
 * @module dsh-plugin-console/host/patch-config
 */

/** 单个 patch 文件最多扫描的行数；超出只保留已读到的行。 */
const MAX_LINES = 2000
/** 单个标量的展示上限；超出截断并给行标 truncated。 */
const MAX_VALUE_TEXT = 2000
/** config 的最大嵌套深度。 */
const MAX_DEPTH = 8
/** 单个 config 子树的节点上限。 */
const MAX_NODES = 2000

/** 解析失败：patch 里出现了本页刻意不支持的写法。 */
class PatchParseError extends Error {}

/**
 * 去掉行尾注释。
 *
 * 只在引号外、且 `#` 前面是空白时截断——`url: a#b` 里的 `#` 是值的一部分。
 * @param {string} raw - 原始行。
 * @returns {string} 去掉注释后的行。
 */
function stripComment(raw) {
  let quote = null
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    if (quote !== null) {
      if (char === '\\' && quote === '"') {
        index++
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(raw[index - 1]))) return raw.slice(0, index)
  }
  return raw
}

/** 去掉键两端的引号；只处理 patch 里常见的写法。 */
function unquoteKey(text) {
  const trimmed = text.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

/**
 * 切出 `key: value`。
 *
 * 分隔符是引号外的第一个 `:`，且它后面必须是空白或行尾——否则
 * `url: https://x` 会被从协议名处切开。
 * @param {string} text - 已去掉注释的正文（不含列表前缀）。
 * @returns {{key: string, rest: string} | null} 键与剩余文本。
 */
function splitKey(text) {
  let quote = null
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote !== null) {
      if (char === '\\' && quote === '"') {
        index++
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char !== ':') continue
    const rest = text.slice(index + 1)
    if (rest !== '' && !/^\s/.test(rest)) continue
    const key = unquoteKey(text.slice(0, index))
    if (key === '') return null
    return { key, rest: rest.trim() }
  }
  return null
}

/**
 * 解析一个标量文本。
 *
 * 引号、布尔、null 与数字按 YAML 的常见语义；其余原样当字符串。
 * @param {string} text - 标量文本。
 * @returns {unknown} 解析结果。
 */
function parseScalarToken(text) {
  const value = text.trim()
  if (value === '' ) return null
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) throw new PatchParseError('双引号未闭合')
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new PatchParseError('单引号未闭合')
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (/^(null|~)$/i.test(value)) return null
  if (/^true$/i.test(value)) return true
  if (/^false$/i.test(value)) return false
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return Number(value)
  return value
}

/**
 * 解析流式值 `[a, b]` / `{a: b}`。
 *
 * 只支持单行、可嵌套的写法；跨行流式值属于不支持的构造。
 * @param {string} text - 以 `[` 或 `{` 开头的文本。
 * @param {number} line - 行号，用于错误信息。
 * @returns {unknown} 解析结果。
 */
function parseFlow(text, line) {
  let index = 0
  const fail = (why) => {
    throw new PatchParseError(`第 ${line} 行的流式值无法解析：${why}`)
  }
  const skip = () => {
    while (index < text.length && /\s/.test(text[index])) index++
  }

  /** 读一个带引号的字符串。 */
  const readQuoted = () => {
    const quote = text[index]
    let out = ''
    index++
    while (index < text.length) {
      const char = text[index]
      if (char === '\\' && quote === '"') {
        out += text[index + 1] ?? ''
        index += 2
        continue
      }
      if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") {
          out += "'"
          index += 2
          continue
        }
        index++
        return out
      }
      out += char
      index++
    }
    fail('引号未闭合')
    return ''
  }

  /** 流式 map 的键：允许引号，也允许到 `:` 为止的裸键。 */
  const readKey = () => {
    skip()
    if (text[index] === '"' || text[index] === "'") return readQuoted()
    const start = index
    while (index < text.length && text[index] !== ':') index++
    const key = text.slice(start, index).trim()
    if (key === '') fail('缺少键名')
    return key
  }

  const readNode = (depth) => {
    if (depth > MAX_DEPTH) fail('嵌套过深')
    skip()
    const char = text[index]
    if (char === '[') {
      index++
      const list = []
      skip()
      if (text[index] === ']') {
        index++
        return list
      }
      while (true) {
        list.push(readNode(depth + 1))
        skip()
        if (text[index] === ',') {
          index++
          skip()
          if (text[index] === ']') {
            index++
            return list
          }
          continue
        }
        if (text[index] === ']') {
          index++
          return list
        }
        fail('缺少 ]')
      }
    }
    if (char === '{') {
      index++
      const map = {}
      skip()
      if (text[index] === '}') {
        index++
        return map
      }
      while (true) {
        const key = readKey()
        skip()
        if (text[index] !== ':') fail('缺少 :')
        index++
        map[key] = readNode(depth + 1)
        skip()
        if (text[index] === ',') {
          index++
          skip()
          if (text[index] === '}') {
            index++
            return map
          }
          continue
        }
        if (text[index] === '}') {
          index++
          return map
        }
        fail('缺少 }')
      }
    }
    if (char === '"' || char === "'") return readQuoted()
    const start = index
    while (index < text.length && !',]}'.includes(text[index])) index++
    return parseScalarToken(text.slice(start, index))
  }

  const value = readNode(1)
  skip()
  if (index !== text.length) fail('值后面还有多余内容')
  return value
}

/**
 * 解析一个值文本；不支持的构造直接抛错，由调用方整行降级。
 * @param {string} text - 值文本。
 * @param {number} line - 行号。
 * @param {object} state - 截断/节点计数状态。
 * @returns {unknown} 解析结果。
 */
function parseValueText(text, line, state) {
  const value = text.trim()
  if (value === '') return null
  if (/^[|>]/.test(value)) throw new PatchParseError(`第 ${line} 行使用了块标量，本页只保留原文`)
  if (/^[&*!]/.test(value)) throw new PatchParseError(`第 ${line} 行使用了锚点、别名或标签，本页只保留原文`)
  if (value.startsWith('[') || value.startsWith('{')) {
    state.nodes++
    if (state.nodes > MAX_NODES) throw new PatchParseError('config 节点过多，已截断')
    return parseFlow(value, line)
  }
  return clipScalar(parseScalarToken(value), state)
}

/** 超长标量截断；只影响展示与比较，解析结果仍然是字符串。 */
function clipScalar(value, state) {
  if (typeof value !== 'string' || value.length <= MAX_VALUE_TEXT) return value
  state.truncated = true
  return `${value.slice(0, MAX_VALUE_TEXT)}…（已截断，共 ${value.length} 字符）`
}

/**
 * 解析一块缩进文本。
 * @param {Array<{indent: number, text: string, line: number}>} lines - 块内行。
 * @param {number} start - 起始下标。
 * @param {number} indent - 该块的首行缩进。
 * @param {number} depth - 当前深度。
 * @param {object} state - 截断/节点计数状态。
 * @returns {[unknown, number]} 解析值与该块之后的下标。
 */
function parseBlock(lines, start, indent, depth, state) {
  if (depth > MAX_DEPTH) throw new PatchParseError('config 嵌套过深')
  const first = lines[start]
  if (first.text === '-' || first.text.startsWith('- ')) {
    return parseSequence(lines, start, indent, depth, state)
  }
  return parseMapping(lines, start, indent, depth, state)
}

/** 解析一个块式 map。 */
function parseMapping(lines, start, indent, depth, state) {
  const map = {}
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line.indent < indent) break
    if (line.indent > indent) throw new PatchParseError(`第 ${line.line} 行的缩进无法归入上一级`)
    if (line.text === '-' || line.text.startsWith('- ')) break
    const kv = splitKey(line.text)
    if (kv === null) throw new PatchParseError(`第 ${line.line} 行不是键值对`)
    state.nodes++
    if (state.nodes > MAX_NODES) throw new PatchParseError('config 节点过多，已截断')
    if (kv.rest === '') {
      if (index + 1 < lines.length && lines[index + 1].indent > indent) {
        const [child, next] = parseBlock(lines, index + 1, lines[index + 1].indent, depth + 1, state)
        map[kv.key] = child
        index = next
      } else {
        map[kv.key] = null
        index++
      }
      continue
    }
    map[kv.key] = parseValueText(kv.rest, line.line, state)
    index++
    if (index < lines.length && lines[index].indent > indent) {
      throw new PatchParseError(`第 ${lines[index].line} 行：标量后面还有子行`)
    }
  }
  return [map, index]
}

/** 解析一个块式序列；序列项可以是标量或 map。 */
function parseSequence(lines, start, indent, depth, state) {
  const list = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line.indent < indent) break
    if (line.indent > indent) throw new PatchParseError(`第 ${line.line} 行的缩进无法归入上一级`)
    if (!(line.text === '-' || line.text.startsWith('- '))) break
    state.nodes++
    if (state.nodes > MAX_NODES) throw new PatchParseError('config 节点过多，已截断')
    const body = line.text === '-' ? '' : line.text.slice(2).trim()
    if (body === '') {
      if (index + 1 < lines.length && lines[index + 1].indent > indent) {
        const [child, next] = parseBlock(lines, index + 1, lines[index + 1].indent, depth + 1, state)
        list.push(child)
        index = next
      } else {
        list.push(null)
        index++
      }
      continue
    }
    const kv = splitKey(body)
    if (kv === null) {
      list.push(parseValueText(body, line.line, state))
      index++
      continue
    }
    const item = {}
    index++
    if (kv.rest === '') {
      if (index < lines.length && lines[index].indent > indent) {
        const [child, next] = parseBlock(lines, index, lines[index].indent, depth + 1, state)
        item[kv.key] = child
        index = next
      } else {
        item[kv.key] = null
      }
    } else {
      item[kv.key] = parseValueText(kv.rest, line.line, state)
    }
    if (index < lines.length && lines[index].indent > indent) {
      const [rest, next] = parseMapping(lines, index, lines[index].indent, depth + 1, state)
      Object.assign(item, rest)
      index = next
    }
    list.push(item)
  }
  return [list, index]
}

/** 从 config 块里按首层缩进抓键名；解析失败时用它回答「声明了哪些键」。 */
function topLevelKeys(lines, indent) {
  const keys = []
  for (const line of lines) {
    if (line.indent !== indent) continue
    const kv = splitKey(line.text)
    if (kv !== null && !keys.includes(kv.key)) keys.push(kv.key)
  }
  return keys
}

/**
 * 扫描一个 patch 文件的 config 子树。
 *
 * 每个 `- id:` 出现一次就是一条记录；同一 id 在一个文件里出现多次时保留
 * 各自的 occurrence，不做合并——合并是「生效值」的事，覆盖链需要看到每一层。
 * @param {string} text - patch 文件内容。
 * @returns {{rows: Array<object>, diagnostics: string[]}} config 行与文件级诊断。
 */
export function scanPatchConfig(text) {
  const rawLines = String(text).split(/\r?\n/)
  const diagnostics = []
  if (rawLines.length > MAX_LINES) {
    diagnostics.push(`文件超过 ${MAX_LINES} 行，只扫描前 ${MAX_LINES} 行`)
  }
  const lines = rawLines.slice(0, MAX_LINES)
  /** @type {Array<object>} */
  const rows = []
  const occurrences = new Map()
  let inserting = false
  let current = null

  /** 开始一条新行记录。 */
  const startRow = (id, kind, line) => {
    const occurrence = (occurrences.get(id) ?? 0) + 1
    occurrences.set(id, occurrence)
    const row = {
      id,
      kind,
      line,
      occurrence,
      keys: [],
      hasConfig: false,
      configKeys: [],
      configRaw: '',
      parsed: true,
      truncated: false,
    }
    rows.push(row)
    return { row, keyIndent: null }
  }

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]
    if (/^\s*\t/.test(raw)) diagnostics.push(`第 ${index + 1} 行含 tab 缩进；本页按原文逐行识别，可能漏键`)
    const cleaned = stripComment(raw)
    if (!cleaned.trim()) continue
    const indent = cleaned.length - cleaned.trimStart().length
    const body = cleaned.trim()

    if (indent === 0) {
      current = null
      if (/^-?\s*insert\s*:/.test(body)) {
        inserting = true
        continue
      }
      const match = body.match(/^-\s*id\s*:\s*(.+)$/)
      if (match !== null) {
        inserting = false
        current = startRow(unquoteKey(match[1]), 'override', index + 1)
        current.keyIndent = indent + 2
      }
      continue
    }

    const idMatch = body.match(/^-\s*id\s*:\s*(.+)$/)
    if (idMatch !== null && inserting) {
      current = startRow(unquoteKey(idMatch[1]), 'insert', index + 1)
      current.keyIndent = indent + 2
      continue
    }
    if (idMatch !== null) {
      current = null
      continue
    }
    if (current === null) continue
    current.keyIndent ??= indent
    if (indent < current.keyIndent) {
      current = null
      continue
    }
    if (indent !== current.keyIndent) continue

    const kv = splitKey(body)
    if (kv === null || kv.key === 'id') continue
    if (!current.row.keys.includes(kv.key)) current.row.keys.push(kv.key)
    if (kv.key !== 'config') continue

    current.row.hasConfig = true
    // `config: {...}` 与 `config:` 两种写法都要认；后者收集子块。
    if (kv.rest !== '') {
      current.row.configRaw = kv.rest
      const state = { nodes: 0, truncated: false }
      try {
        current.row.config = parseValueText(kv.rest, index + 1, state)
        current.row.configKeys = current.row.config !== null && typeof current.row.config === 'object' && !Array.isArray(current.row.config)
          ? Object.keys(current.row.config)
          : []
        current.row.truncated = state.truncated
      } catch (cause) {
        current.row.parsed = false
        current.row.reason = cause instanceof Error ? cause.message : String(cause)
      }
      continue
    }

    const blockLines = []
    const rawBlock = []
    let next = index + 1
    for (; next < lines.length; next++) {
      const nested = stripComment(lines[next])
      if (!nested.trim()) {
        rawBlock.push(lines[next])
        continue
      }
      const nestedIndent = nested.length - nested.trimStart().length
      if (nestedIndent <= current.keyIndent) break
      blockLines.push({ indent: nestedIndent, text: nested.trim(), line: next + 1 })
      rawBlock.push(lines[next])
    }
    index = next - 1
    current.row.configRaw = rawBlock.join('\n').trim()
    if (blockLines.length === 0) {
      current.row.config = {}
      current.row.configKeys = []
      current.row.emptyConfig = true
      continue
    }
    const state = { nodes: 0, truncated: false }
    const firstIndent = blockLines[0].indent
    try {
      const [config, after] = parseBlock(blockLines, 0, firstIndent, 1, state)
      if (after < blockLines.length) throw new PatchParseError(`第 ${blockLines[after].line} 行无法归入 config 子树`)
      current.row.config = config
      current.row.configKeys = config !== null && typeof config === 'object' && !Array.isArray(config) ? Object.keys(config) : []
      current.row.truncated = state.truncated
    } catch (cause) {
      current.row.parsed = false
      current.row.reason = cause instanceof Error ? cause.message : String(cause)
      current.row.configKeys = topLevelKeys(blockLines, firstIndent)
    }
  }

  return { rows, diagnostics }
}

/**
 * 解析一个独立的 YAML 值文本。
 *
 * 只给测试与流式值使用；不承诺完整 YAML 语义，不支持的构造会抛错。
 * @param {string} text - 值文本。
 * @returns {unknown} 解析结果。
 */
export function parseYamlValue(text) {
  const cleaned = stripComment(String(text)).trim()
  if (cleaned === '') return null
  return parseValueText(cleaned, 0, { nodes: 0, truncated: false })
}
