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
 * 除了名字数组，扫描还记录 prompt 注册点（`sites`）：文件、行号、接收者与模板名
 * 的解析结果。名字回答「写过什么」，站点回答「在哪里、以什么上下文写的」——
 * 插件页要靠后者判断这个名字有没有可能进入首请求装配。
 *
 * 结果按「包目录 + 文件 stat」缓存：快照每次都会重扫，但包没变就不重新读盘。
 * @module dsh-plugin-console/host/source-scan
 */

import { listDirDetailed, readTextFile, statFile } from './fs.js'

/** 空结果；包目录缺失或读不到源码时返回它。 */
const EMPTY = { tools: [], sections: [], contexts: [], variables: [], runtimeSkills: [], commands: [], llmProviders: [], webSearch: [], webFetch: [], routePaths: [], mcpServers: [], sites: [] }

/** 单个包最多扫多少个 JS 文件 / 多少字节。 */
const MAX_FILES = 200
const MAX_BYTES = 4 * 1024 * 1024

/** 递归深度上限：lib 下的目录通常只有一两层。 */
const MAX_DEPTH = 4

/** 每个包最多保留多少条 prompt 站点；超出的截断并标记，避免快照被单个大包拖重。 */
const MAX_SITES = 32

/** 注入文本的展示上限；超过只保留前缀，界面标「已截断」。 */
const TEXT_LIMIT = 2000

/** 运行时表达式（函数、`composition.persona` 等）的展示上限。 */
const EXPRESSION_LIMIT = 300

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
const OPEN_PAREN = 40
const CLOSE_PAREN = 41
const OPEN_BRACKET = 91
const CLOSE_BRACKET = 93
const COMMA = 44
const PLUS = 43
const SEMICOLON = 59

/** 用字符码拼引号类，避免本文件自身出现会被静态体检误判的裸引号。 */
const QUOTE_CLASS = '["' + String.fromCharCode(QUOTE_SINGLE, QUOTE_TEMPLATE) + ']'
const NAME_PATTERN = new RegExp('\\bname\\s*:\\s*(' + QUOTE_CLASS + ')([^"' + String.fromCharCode(QUOTE_SINGLE, QUOTE_TEMPLATE) + ']*)\\1')

/** 与 `QUOTE_TEMPLATE` 对应的字符；反引号字面量里的 `${}` 才需要常量展开。 */
const TEMPLATE_QUOTE = String.fromCharCode(QUOTE_TEMPLATE)

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

/** 这个字符码是不是字符串引号。 */
function isQuoteCode(code) {
  return code === QUOTE_DOUBLE || code === QUOTE_SINGLE || code === QUOTE_TEMPLATE
}

/** 把 JS 字符串字面量里的常见转义还原成正文。 */
function unescapeText(text) {
  return text.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (whole, code) => {
    if (code[0] === 'u') return String.fromCharCode(parseInt(code.slice(1), 16))
    if (code[0] === 'x') return String.fromCharCode(parseInt(code.slice(1), 16))
    if (code === 'n') return '\n'
    if (code === 'r') return '\r'
    if (code === 't') return '\t'
    if (code === 'b') return '\b'
    if (code === 'f') return '\f'
    if (code === 'v') return '\v'
    if (code === '0') return '\0'
    return code
  })
}

/**
 * 解析一个完整的字符串字面量（单引号 / 双引号 / 反引号）。
 *
 * 反引号里的 `${IDENT}` 只解析「同包字符串常量」这一种形式；其它插值保持原样，
 * 由调用方标成「运行时求值」。这不是通用 JS 求值器，只服务源码里的文本常量。
 * @param {string} term - 字面量表达式。
 * @param {Map<string, string>} constants - 字符串常量表。
 * @returns {string | undefined} 解析后的文本。
 */
function parseStringLiteral(term, constants) {
  const quote = term.charCodeAt(0)
  if (!isQuoteCode(quote)) return undefined
  let body = ''
  for (let index = 1; index < term.length; index++) {
    const code = term.charCodeAt(index)
    if (code === BACKSLASH) {
      body += term[index] + (term[index + 1] ?? '')
      index++
      continue
    }
    if (code === quote) {
      if (index !== term.length - 1) return undefined
      if (quote === QUOTE_TEMPLATE && body.includes('${')) {
        const resolved = body.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (whole, identifier) => constants.get(identifier) ?? whole)
        if (resolved.includes('${')) return undefined
        return unescapeText(resolved)
      }
      return unescapeText(body)
    }
    body += term[index]
  }
  return undefined
}

/**
 * 按顶层分隔符切分表达式；括号、字符串与注释里的分隔符不切。
 * @param {string} text - 表达式。
 * @param {number} separator - 分隔符字符码。
 * @returns {string[]} 片段。
 */
function splitTopLevel(text, separator) {
  const parts = []
  let start = 0
  let depth = 0
  let quote = 0
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < text.length; index++) {
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
    if (isQuoteCode(code)) {
      quote = code
      continue
    }
    if (code === OPEN_PAREN || code === OPEN_BRACKET || code === OPEN_BRACE) {
      depth++
      continue
    }
    if (code === CLOSE_PAREN || code === CLOSE_BRACKET || code === CLOSE_BRACE) {
      depth--
      continue
    }
    if (depth === 0 && code === separator) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** 解析一个 `+` 拼接项：字符串字面量或字符串常量。 */
function evaluateTerm(term, constants) {
  const text = term.trim()
  if (text.length === 0) return undefined
  if (isQuoteCode(text.charCodeAt(0))) return parseStringLiteral(text, constants)
  if (/^[A-Za-z_$][\w$]*$/.test(text)) return constants.get(text)
  return undefined
}

/**
 * 解析「字面量 / 常量 / 多个字符串相加」的表达式。
 * 解析不了时返回 undefined，由调用方保留表达式原文并标成运行时。
 */
function evaluateExpression(expression, constants) {
  const text = expression.trim()
  if (text.length === 0) return undefined
  const terms = splitTopLevel(text, PLUS)
  if (terms.length > 1) {
    const values = terms.map((term) => evaluateTerm(term, constants))
    return values.every((value) => typeof value === 'string') ? values.join('') : undefined
  }
  return evaluateTerm(text, constants)
}

/**
 * 一条 const 声明的结束位置。
 *
 * 以顶层 `;` 结束；没有分号时以「外层换行」结束，但跨行拼接（上一行以 `+`
 * 结尾，或下一行以 `+` 开头）不算结束。只服务文本常量，不追求完整语法树。
 */
function declarationEnd(text, start) {
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
    if (isQuoteCode(code)) {
      quote = code
      continue
    }
    if (code === OPEN_PAREN || code === OPEN_BRACKET || code === OPEN_BRACE) {
      depth++
      continue
    }
    if (code === CLOSE_PAREN || code === CLOSE_BRACKET || code === CLOSE_BRACE) {
      depth--
      continue
    }
    if (depth !== 0) continue
    if (code === SEMICOLON) return index
    if (code === NEWLINE) {
      const before = text.slice(start, index).trimEnd()
      let look = index + 1
      while (look < text.length && /\s/.test(text[look])) look++
      if (!before.endsWith('+') && text[look] !== '+') return index
    }
  }
  return Math.min(text.length, start + 4000)
}

/**
 * 收集同包里的字符串常量。
 *
 * 先解析简单字面量，再解析依赖其它常量的拼接；三轮足够覆盖
 * `STRUCTURED_OUTPUT_INSTRUCTION = '...' + \`${TOOL}\` + '...'` 这种写法。
 * 解析不了的常量不放进表里，调用方会把它当成运行时表达式。
 * @param {string} text - 包内合并源码。
 * @returns {Map<string, string>} 常量名 → 文本。
 */
function extractConstants(text) {
  const constants = new Map()
  const declarations = []
  for (const match of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    const start = match.index + match[0].length
    const end = declarationEnd(text, start)
    declarations.push({ name: match[1], expression: text.slice(start, end).trim() })
  }
  for (let pass = 0; pass < 3; pass++) {
    for (const declaration of declarations) {
      if (constants.has(declaration.name)) continue
      const value = evaluateExpression(declaration.expression, constants)
      if (typeof value === 'string') constants.set(declaration.name, value)
    }
  }
  return constants
}

/**
 * 一个字段值的结束位置：顶层逗号，或外层对象的闭合 `}`。
 * 括号、字符串与注释里的分隔符不参与。
 */
function valueEnd(span, start) {
  let depth = 0
  let quote = 0
  let lineComment = false
  let blockComment = false
  for (let index = start; index < span.length; index++) {
    const code = span.charCodeAt(index)
    const next = span.charCodeAt(index + 1)
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
    if (isQuoteCode(code)) {
      quote = code
      continue
    }
    if (code === OPEN_PAREN || code === OPEN_BRACKET || code === OPEN_BRACE) {
      depth++
      continue
    }
    if (code === CLOSE_PAREN || code === CLOSE_BRACKET || code === CLOSE_BRACE) {
      if (depth === 0 && code === CLOSE_BRACE) return index
      depth--
      continue
    }
    if (depth === 0 && code === COMMA) return index
  }
  return span.length
}

/**
 * 取对象字面量顶层某个字段的值表达式。
 * 只认未加引号的字段名；`text` 不会出现在嵌套对象里被误取。
 */
function fieldValueSpan(span, field) {
  let depth = 0
  let quote = 0
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < span.length; index++) {
    const code = span.charCodeAt(index)
    const next = span.charCodeAt(index + 1)
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
    if (isQuoteCode(code)) {
      quote = code
      continue
    }
    if (code === OPEN_PAREN || code === OPEN_BRACKET || code === OPEN_BRACE) {
      depth++
      continue
    }
    if (code === CLOSE_PAREN || code === CLOSE_BRACKET || code === CLOSE_BRACE) {
      depth--
      continue
    }
    if (depth !== 1 || code !== field.charCodeAt(0) || !span.startsWith(field, index)) continue
    const previous = index === 0 ? '' : span[index - 1]
    if (/[A-Za-z0-9_$]/.test(previous)) continue
    const after = span.slice(index + field.length)
    const match = after.match(/^\s*:\s*/)
    if (match === null) continue
    const start = index + field.length + match[0].length
    return span.slice(start, valueEnd(span, start)).trim()
  }
  return undefined
}

/**
 * 从一个注册对象里取 `text` 字段。
 *
 * 返回值只描述**源码里怎么写**：
 *   - `literal` / `constant`：能解析出的文本（可能被截断）；
 *   - `function` / `expression`：运行时才求值，只保留表达式原文；
 *   - 没有 `text` 字段时返回 undefined。
 * 这是源码事实，不是模型实际收到的正文。
 * @param {string} span - 注册对象字面量。
 * @param {Map<string, string>} constants - 字符串常量表。
 * @returns {{kind: string, value?: string, expression?: string, truncated?: boolean} | undefined} 文本描述。
 */
function textInObject(span, constants) {
  const expression = fieldValueSpan(span, 'text')
  if (expression === undefined) return undefined
  const value = evaluateExpression(expression, constants)
  const literal = isQuoteCode(expression.charCodeAt(0))
  if (typeof value === 'string') {
    const clipped = value.length > TEXT_LIMIT ? value.slice(0, TEXT_LIMIT) : value
    return {
      kind: literal ? 'literal' : 'constant',
      value: clipped,
      ...(value.length > TEXT_LIMIT ? { truncated: true } : {}),
    }
  }
  const kind = /=>|^\s*function\b/.test(expression) ? 'function' : 'expression'
  const clipped = expression.length > EXPRESSION_LIMIT ? expression.slice(0, EXPRESSION_LIMIT) : expression
  return {
    kind,
    expression: clipped,
    ...(expression.length > EXPRESSION_LIMIT ? { truncated: true } : {}),
  }
}

/**
 * 从一个对象字面量里取 `name`，并给出名字在对象字面量里的偏移。
 *
 * 三种写法：
 *   - 引号/反引号字面量：直接返回；反引号里的 `${CONST}` 若能在同包常量表里
 *     解析，就额外给出 `resolvedName`（源码里仍是模板，界面可以显示真实名字）。
 *   - 裸标识符：查同包常量表；查不到但看起来像大写常量时保留 `⟨NAME⟩` 占位。
 *   - 其它：返回 undefined。
 * @param {string} span - 对象字面量。
 * @param {Map<string, string>} constants - 源码里的字符串常量。
 * @returns {{name: string, resolvedName?: string, offset: number} | undefined} 名字信息。
 */
function nameDetail(span, constants) {
  const literal = span.match(NAME_PATTERN)
  if (literal !== null) {
    const raw = literal[2]
    if (literal[1] === TEMPLATE_QUOTE && raw.includes('${')) {
      const resolved = raw.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (whole, identifier) => constants.get(identifier) ?? whole)
      // 只要还有一个 `${}` 没解析，就不把半成品当真实名字；保留原名让界面标「模板名」。
      return resolved.includes('${')
        ? { name: raw, offset: literal.index }
        : { name: raw, resolvedName: resolved, offset: literal.index }
    }
    return { name: raw, offset: literal.index }
  }
  const identifier = span.match(/\bname\s*:\s*([A-Za-z_$][\w$]*)/)
  if (identifier !== null) {
    const resolved = constants.get(identifier[1])
    if (resolved !== undefined) return { name: resolved, offset: identifier.index }
    // 查不到值的常量保留成占位，便于界面显示「这里有个名字但解析不出来」。
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(identifier[1])) {
      return { name: '⟨' + identifier[1] + '⟩', offset: identifier.index }
    }
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
    const detail = nameDetail(objectSpan(text, open), constants)
    if (detail !== undefined) names.add(detail.name)
  }
  return [...names]
}

/** 属性名 → 字面量正则；只覆盖这里用到的两种。 */
const PROPERTY_PATTERNS = {
  id: /\bid\s*:\s*(["'])([^"']*)\1/,
  path: /\bpath\s*:\s*(["'])([^"']*)\1/,
}

/** 模板插值的开头两个字符；用字符拼，避免本文件出现会被静态体检误判的裸写法。 */
const INTERPOLATION = String.fromCharCode(36) + '{'

/**
 * 收集对象字面量里某个字符串属性（id / path）。
 *
 * 只解析单双引号字面量；模板字面量与插值跳过，避免把半成品当真实 id。
 * @param {string} text - 合并后的源码。
 * @param {RegExp} pattern - 匹配到对象左括号的调用模式。
 * @param {Map<string, string>} constants - 字符串常量表。
 * @param {'id' | 'path'} property - 属性名。
 * @returns {string[]} 属性值列表。
 */
function collectProperty(text, pattern, constants, property) {
  const names = new Set()
  const propPattern = PROPERTY_PATTERNS[property]
  if (propPattern === undefined) return []
  for (const match of text.matchAll(pattern)) {
    const open = text.indexOf('{', match.index)
    if (open < 0 || open > match.index + 160) continue
    const span = objectSpan(text, open)
    const literal = span.match(propPattern)
    if (literal === null) continue
    const raw = literal[2]
    if (raw.includes(INTERPOLATION)) continue
    const resolved = constants.get(raw)
    names.add(unescapeText(resolved ?? raw))
  }
  return [...names]
}

/**
 * 收集字符串数组实参里的值（registerAdapter 的 provider 列表）。
 * @param {string} text - 合并后的源码。
 * @param {RegExp} pattern - 匹配到数组左括号的调用模式。
 * @returns {string[]} 数组里的字符串。
 */
function collectStringArray(text, pattern) {
  const names = new Set()
  for (const match of text.matchAll(pattern)) {
    const open = text.indexOf('[', match.index)
    if (open < 0 || open > match.index + 120) continue
    const close = text.indexOf(']', open)
    if (close < 0) continue
    const body = text.slice(open + 1, close)
    for (const literal of body.matchAll(/(["'])([^"']*)\1/g)) {
      if (literal[2].includes(INTERPOLATION)) continue
      names.add(unescapeText(literal[2]))
    }
  }
  return [...names]
}

/**
 * 收集调用第一个实参是字符串字面量的名字（mcpManager.register 的 server 名）。
 * @param {string} text - 合并后的源码。
 * @param {RegExp} pattern - 匹配到调用左括号的调用模式。
 * @returns {string[]} 名字列表。
 */
function collectFirstArgStrings(text, pattern) {
  const names = new Set()
  for (const match of text.matchAll(pattern)) {
    const open = text.indexOf('(', match.index)
    if (open < 0) continue
    const literal = /^\s*(["'])([^"']*)\1/.exec(text.slice(open + 1, open + 200))
    if (literal === null || literal[2].includes(INTERPOLATION)) continue
    names.add(unescapeText(literal[2]))
  }
  return [...names]
}

/** 把接收者折叠成「本作用域 / 其它 / 未知」三档；这是启发式，不是运行时事实。 */
function receiverKindOf(receiver) {
  if (receiver === undefined) return 'unknown'
  if (receiver === 'ctx' || receiver.startsWith('this')) return 'own'
  return 'other'
}

/**
 * 扫描单个文件的 prompt 注册站点。
 *
 * 必须逐文件做：`file` 与 `line` 是给界面定位用的，合并文本会把文件边界抹掉。
 * 两条模式分别覆盖 `childCtx.systemPrompt.section({...})` 与
 * `systemPrompt.section({...})`（无接收者，作用域未知）。
 * @param {string} file - 包内相对路径。
 * @param {string} text - 文件内容。
 * @param {Map<string, string>} constants - 同包常量表。
 * @returns {Array<object>} 站点列表。
 */
function sitesInFile(file, text, constants) {
  const sites = []
  const withReceiver = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\.\s*systemPrompt\s*\.\s*(section|context|variable)\s*\(\s*\{/g
  const bare = /(?<![.\w$])systemPrompt\s*\.\s*(section|context|variable)\s*\(\s*\{/g
  const scan = (pattern, hasReceiver) => {
    for (const match of text.matchAll(pattern)) {
      const open = text.indexOf('{', match.index)
      if (open < 0 || open > match.index + 160) continue
      const span = objectSpan(text, open)
      const detail = nameDetail(span, constants)
      if (detail === undefined) continue
      const textInfo = textInObject(span, constants)
      const nameIndex = open + detail.offset
      const line = text.slice(0, nameIndex).split('\n').length
      const receiver = hasReceiver ? match[1] : undefined
      sites.push({
        kind: match[2] ?? match[1],
        name: detail.name,
        ...(detail.resolvedName === undefined ? {} : { resolvedName: detail.resolvedName }),
        file,
        line,
        ...(receiver === undefined ? {} : { receiver }),
        receiverKind: receiverKindOf(receiver),
        ...(textInfo === undefined ? {} : { text: textInfo }),
      })
    }
  }
  scan(withReceiver, true)
  scan(bare, false)
  return sites
}

/**
 * @param {string} packageDir - 包的根目录。
 * @returns {Promise<{tools: string[], sections: string[], contexts: string[], variables: string[], runtimeSkills: string[], commands: string[], llmProviders: string[], webSearch: string[], webFetch: string[], routePaths: string[], mcpServers: string[], sites: Array<object>}>} 静态提取结果。
 */
export async function scanPackageRegistrations(packageDir) {
  if (typeof packageDir !== 'string') return EMPTY
  const root = packageDir.replace(/[\\/]+$/, '')
  const files = await jsFiles(`${root}/lib`)
  if (files.length === 0) return EMPTY

  const stamp = await stampOf(files)
  const cached = CACHE.get(packageDir)
  if (cached !== undefined && cached.stamp === stamp) return cached.result

  const parts = []
  let bytes = 0
  for (const file of files) {
    if (bytes >= MAX_BYTES) break
    const part = await readTextFile(file)
    if (part === null) continue
    bytes += part.length
    parts.push({ file, text: part })
  }

  let text = ''
  for (const part of parts) text += '\n' + part.text

  const constants = extractConstants(text)

  const seen = new Set()
  const sites = []
  let sitesTruncated = false
  for (const part of parts) {
    const relative = part.file.slice(root.length).replace(/^[\\/]/, '').replace(/\\/g, '/')
    for (const site of sitesInFile(relative, part.text, constants)) {
      const key = `${site.kind}|${site.name}|${site.file}|${site.line}`
      if (seen.has(key)) continue
      seen.add(key)
      if (sites.length >= MAX_SITES) {
        sitesTruncated = true
        continue
      }
      sites.push(site)
    }
  }

  const result = {
    tools: collect(text, /defineTool\s*\(\s*\{/g, constants),
    sections: collect(text, /systemPrompt\.section\s*\(\s*\{/g, constants),
    contexts: collect(text, /systemPrompt\.context\s*\(\s*\{/g, constants),
    variables: collect(text, /systemPrompt\.variable\s*\(\s*\{/g, constants),
    // 运行时注册的技能：`skills.register({ name })`；provider 由运行时字段归属，不靠猜。
    runtimeSkills: collect(text, /skills\s*\.\s*register\s*\(\s*\{/g, constants),
    commands: collect(text, /commands\s*\.\s*register\s*\(\s*\{/g, constants),
    // 网络能力面：provider 注册与入站路由的源码字面量；运行时仍以服务列表为准。
    llmProviders: collectStringArray(text, /registerAdapter\s*\(\s*\[/g),
    webSearch: collectProperty(text, /registerSearchProvider\s*\(\s*\{/g, constants, 'id'),
    webFetch: collectProperty(text, /registerFetchProvider\s*\(\s*\{/g, constants, 'id'),
    routePaths: [
      ...collectProperty(text, /(?:connection\s*\.\s*)?fetch\s*\.\s*register\s*\(\s*\{/g, constants, 'path'),
      ...collectProperty(text, /webServer\s*\.\s*register\s*\(\s*\{/g, constants, 'path'),
    ],
    mcpServers: collectFirstArgStrings(text, /mcpManager\s*\.\s*register\s*\(/g),
    sites,
    ...(sitesTruncated ? { sitesTruncated: true } : {}),
  }

  CACHE.set(packageDir, { stamp, result })
  if (CACHE.size > CACHE_LIMIT) CACHE.delete(CACHE.keys().next().value)
  return result
}

/**
 * 取某个名字的注册站点；界面与片段路由共用同一套匹配规则。
 *
 * `name` 可能是源码里的模板名，也可能是展开后的真实名字；两者都接受。
 * @param {{sites?: Array<object>}} registrations - `scanPackageRegistrations()` 的结果。
 * @param {'section' | 'context' | 'variable'} kind - 站点种类。
 * @param {string} name - 源码名或解析后的名字。
 * @returns {Array<object>} 命中的站点。
 */
export function registrationSitesOf(registrations, kind, name) {
  return (registrations?.sites ?? []).filter((site) => (
    site.kind === kind && (site.name === name || site.resolvedName === name)
  ))
}
