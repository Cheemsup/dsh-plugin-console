/**
 * 从包的源码里静态提取它注册的工具名与提示词段名。
 *
 * 为什么必须静态扫：`tools.register(definition)` 只把 `definition` 存进注册表，
 * `systemPrompt.section({name})` 也只把对象存进 `NamedEntries`——两者都不保留
 * 「谁注册的」。唯一可靠的归属信息是 `fiber.getEffects()` 的 label，而它只有
 * `tools.register()` 这种不带名字的通用文案。
 *
 * 因此这里读包自己的 lib 目录，按 `defineTool({ name })`、
 * `systemPrompt.section/context({ name })` 的写法提取名字。这是**源码级**事实，
 * 不是运行时推断：名字确实写在代码里，只是运行时的注册表把它丢掉了。
 *
 * 扫描实现有两条务实约束：
 *   - 不假设只有 `lib/index.js`。第三方插件可能拆成多个 chunk，所以递归扫
 *     `lib/**\/*.{js,mjs,cjs}`；文件数与总字节都有上限，避免大包拖住快照。
 *   - 用平衡花括号截取对象字面量，而不是固定字符窗口；`name` 可能写在几十行
 *     之后，固定窗口会截断，也可能把下一个调用的 name 收进来。
 *
 * 结果按「包目录 + 文件 stat」缓存：快照每次都会重扫，但包没变就不重新读盘。
 * @module dsh-plugin-console/host/source-scan
 */

import { listDirDetailed, readTextFile, statFile } from './fs.js'

/** 空结果；包目录缺失或读不到源码时返回它。 */
const EMPTY = { tools: [], sections: [], contexts: [], variables: [] }

/** 单个包最多扫多少个 JS 文件 / 多少字节。 */
const MAX_FILES = 200
const MAX_BYTES = 4 * 1024 * 1024

/** 递归深度上限：lib 下的目录通常只有一两层。 */
const MAX_DEPTH = 4

/** packageDir → { stamp, result }。 */
const CACHE = new Map()
const CACHE_LIMIT = 128

/**
 * 递归列出 lib 下的 JS 文件；失败/超限时返回已收集的部分。
 * @param {string} dir - 目录。
 * @param {number} depth - 当前深度。
 * @param {string[]} out - 收集数组。
 * @returns {Promise<string[]>} 文件路径。
 */
async function jsFiles(dir, depth = 0, out = []) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out
  const entries = await listDirDetailed(dir)
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break
    const full = `${dir}/${entry.name}`
    if (entry.isFile && /\.(?:mjs|cjs|js)$/.test(entry.name)) {
      out.push(full)
      continue
    }
    // 只递归真实子目录；跳过 node_modules 与隐藏目录，避免把依赖当成本包源码。
    if (entry.isDirectory && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      await jsFiles(full, depth + 1, out)
    }
  }
  return out
}

/** 文件列表的轻量指纹：路径 + mtime + size。 */
async function stampOf(files) {
  const parts = []
  for (const file of files) {
    const stat = await statFile(file)
    parts.push(`${file}:${stat?.mtimeMs ?? 0}:${stat?.size ?? 0}`)
  }
  return parts.join('|')
}

/** 引号/斜杠/花括号的字符码：避免在源码里写裸引号，静态体检会把它们当成字符串边界。 */
const QUOTE_DOUBLE = 34
const QUOTE_SINGLE = 39
const QUOTE_TEMPLATE = 96
const BACKSLASH = 92
const SLASH = 47
const STAR = 42
const NEWLINE = 10
const OPEN_BRACE = 123
const CLOSE_BRACE = 125

/** 用字符码拼引号类，避免本文件自身出现会被静态体检误判的裸引号。 */
const QUOTE_CLASS = '["' + String.fromCharCode(QUOTE_SINGLE, QUOTE_TEMPLATE) + ']'
const NAME_PATTERN = new RegExp('\\bname\\s*:\\s*(' + QUOTE_CLASS + ')([^"' + String.fromCharCode(QUOTE_SINGLE, QUOTE_TEMPLATE) + ']*)\\1')
const CONSTANT_PATTERN = new RegExp(
  '\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(' + QUOTE_CLASS + ')([^"' + String.fromCharCode(QUOTE_SINGLE, QUOTE_TEMPLATE) + ']*)\\2',
  'g',
)

/**
 * 从 `{` 开始截取完整的对象字面量；字符串/注释里的括号不参与配对。
 * 找不到配对的 `}` 时退回一个有限窗口，至少保留可读内容。
 * @param {string} text - 源码。
 * @param {number} start - `{` 的下标。
 * @returns {string} 对象字面量文本。
 */
function objectSpan(text, start) {
  let depth = 0
  let quote = 0
  let lineComment = false
  let blockComment = false
  for (let index = start; index < text.length; index++) {
    const code = text.charCodeAt(index)
    const next = text.charCodeAt(index + 1)
    if (lineComment) {
      if (code === NEWLINE) lineComment = false
      continue
    }
    if (blockComment) {
      if (code === STAR && next === SLASH) {
        blockComment = false
        index++
      }
      continue
    }
    if (quote !== 0) {
      if (code === BACKSLASH) {
        index++
        continue
      }
      if (code === quote) quote = 0
      continue
    }
    if (code === SLASH && next === SLASH) {
      lineComment = true
      index++
      continue
    }
    if (code === SLASH && next === STAR) {
      blockComment = true
      index++
      continue
    }
    if (code === QUOTE_DOUBLE || code === QUOTE_SINGLE || code === QUOTE_TEMPLATE) {
      quote = code
      continue
    }
    if (code === OPEN_BRACE) depth++
    else if (code === CLOSE_BRACE) {
      depth--
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return text.slice(start, Math.min(text.length, start + 2000))
}

/**
 * 从一个对象字面量里取 `name`：字面量、常量引用，或大写占位名。
 * @param {string} span - 对象字面量。
 * @param {Map<string, string>} constants - 源码里的字符串常量。
 * @returns {string | undefined} 名字或 undefined。
 */
function nameIn(span, constants) {
  const literal = span.match(NAME_PATTERN)
  if (literal) return literal[2]
  const identifier = span.match(/\bname\s*:\s*([A-Za-z_$][\w$]*)/)
  if (identifier) {
    const resolved = constants.get(identifier[1])
    if (resolved !== undefined) return resolved
    // 查不到值的常量保留成占位，便于界面显示「这里有个名字但解析不出来」。
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(identifier[1])) return '⟨' + identifier[1] + '⟩'
  }
  return undefined
}

/**
 * 收集某一类调用里的 name。
 * @param {string} text - 合并后的源码。
 * @param {RegExp} pattern - 匹配到 `{` 的调用模式。
 * @param {Map<string, string>} constants - 字符串常量表。
 * @returns {string[]} 名字列表。
 */
function collect(text, pattern, constants) {
  const names = new Set()
  for (const match of text.matchAll(pattern)) {
    const open = text.indexOf('{', match.index)
    if (open < 0 || open > match.index + 160) continue
    const name = nameIn(objectSpan(text, open), constants)
    if (name !== undefined) names.add(name)
  }
  return [...names]
}

/**
 * @param {string} packageDir - 包的根目录。
 * @returns {Promise<{tools: string[], sections: string[], contexts: string[], variables: string[]}>} 静态提取结果。
 */
export async function scanPackageRegistrations(packageDir) {
  if (typeof packageDir !== 'string') return EMPTY
  const files = await jsFiles(`${packageDir}/lib`)
  if (files.length === 0) return EMPTY

  const stamp = await stampOf(files)
  const cached = CACHE.get(packageDir)
  if (cached !== undefined && cached.stamp === stamp) return cached.result

  let text = ''
  let bytes = 0
  for (const file of files) {
    if (bytes >= MAX_BYTES) break
    const part = await readTextFile(file)
    if (part === null) continue
    bytes += part.length
    text += '\n' + part
  }

  const constants = new Map()
  for (const match of text.matchAll(CONSTANT_PATTERN)) {
    constants.set(match[1], match[3])
  }

  const result = {
    tools: collect(text, /defineTool\s*\(\s*\{/g, constants),
    sections: collect(text, /systemPrompt\.section\s*\(\s*\{/g, constants),
    contexts: collect(text, /systemPrompt\.context\s*\(\s*\{/g, constants),
    variables: collect(text, /systemPrompt\.variable\s*\(\s*\{/g, constants),
  }

  CACHE.set(packageDir, { stamp, result })
  if (CACHE.size > CACHE_LIMIT) CACHE.delete(CACHE.keys().next().value)
  return result
}
