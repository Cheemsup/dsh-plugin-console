/**
 * 源码里的网络调用点：按「导入绑定 + 调用形状」识别，而不是裸名匹配。
 *
 * 为什么需要这张表：运行时注册表只记录注册过的网络能力，插件直接 `fetch()`、
 * `axios.get()`、`net.connect()` 发起的请求没有任何登记。静态扫描能补上「源码里
 * 确实写了这个调用」，但必须避免把同名变量当网络调用——所以先看这个名字从哪个
 * 模块导入（借鉴 Semgrep 的绑定解析），再看调用/构造形状。
 *
 * 结果仍然是源码事实：`line` 用于定位，`target` 只是可读的端点字面量（去掉
 * 凭据与查询串），不证明请求真的发出过。浏览器规则同样适用，因为 client chunk
 * 也在包的 `lib/` 下。
 *
 * 边界：不做跨过程污点分析。Semgrep 的 SSRF 规则能追「用户输入 → URL」的数据流；
 * 这里只回答「这个包有没有网络调用形状、端点的静态前缀是什么」，不判断参数是否可控。
 * @module dsh-plugin-console/host/network-scan
 */

/** 单条 target 的展示上限；超过只保留前缀。 */
const TARGET_LIMIT = 160

/** target 里出现动态插值时从这里截断，避免把半成品当真实端点。 */
const INTERPOLATION = String.fromCharCode(36) + '{'

/** 按模块导入识别的规则；`family` 同时是 UI 里的调用名。 */
const MODULE_RULES = [
  { family: 'http', modules: ['http'], members: ['request', 'get'] },
  { family: 'https', modules: ['https'], members: ['request', 'get'] },
  { family: 'undici', modules: ['undici'], callable: true, members: ['request', 'fetch', 'stream', 'pipeline', 'connect', 'upgrade'] },
  { family: 'node-fetch', modules: ['node-fetch', 'cross-fetch'], callable: true },
  { family: 'axios', modules: ['axios'], callable: true, members: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request', 'fetch'] },
  { family: 'got', modules: ['got'], callable: true, members: ['get', 'post', 'put', 'patch', 'delete', 'head'] },
  { family: 'request', modules: ['request'], callable: true, members: ['get', 'post', 'put', 'patch', 'delete', 'head'] },
  { family: 'superagent', modules: ['superagent'], callable: true, members: ['get', 'post', 'put', 'patch', 'delete', 'head'] },
  { family: 'needle', modules: ['needle'], callable: true, members: ['get', 'post', 'put', 'patch', 'delete', 'head'] },
  { family: 'net', modules: ['net'], members: ['connect', 'createConnection'] },
  { family: 'tls', modules: ['tls'], members: ['connect'] },
  { family: 'dgram', modules: ['dgram'], members: ['createSocket'] },
  { family: 'http2', modules: ['http2'], members: ['connect'] },
  { family: 'ws', modules: ['ws'], construct: true },
  { family: 'socket.io-client', modules: ['socket.io-client'], callable: true },
]

/** 规则族 → 页面分组。 */
const FAMILY_GROUP = {
  http: 'http',
  https: 'http',
  undici: 'http',
  'node-fetch': 'http',
  axios: 'http',
  got: 'http',
  request: 'http',
  superagent: 'http',
  needle: 'http',
  net: 'socket',
  tls: 'socket',
  dgram: 'socket',
  http2: 'socket',
  ws: 'websocket',
  'socket.io-client': 'websocket',
}

/** 没有导入来源、但确实会联网的全局写法。 */
const GLOBAL_RULES = [
  { family: 'fetch', group: 'http', kind: 'call', pattern: /(?<![\w$.])(?:window|globalThis|self)\s*\.\s*fetch\s*\(/g },
  { family: 'fetch', group: 'http', kind: 'call', pattern: /(?<![\w$.])fetch\s*\(/g },
  { family: 'WebSocket', group: 'websocket', kind: 'constructor', pattern: /(?<![\w$.])new\s+WebSocket\s*\(/g },
  { family: 'WebSocket', group: 'websocket', kind: 'constructor', pattern: /(?<![\w$.])new\s+(?:window|globalThis|self)\s*\.\s*WebSocket\s*\(/g },
  { family: 'XMLHttpRequest', group: 'browser', kind: 'constructor', pattern: /(?<![\w$.])new\s+XMLHttpRequest\s*\(/g },
  { family: 'XMLHttpRequest', group: 'browser', kind: 'constructor', pattern: /(?<![\w$.])new\s+(?:window|globalThis|self)\s*\.\s*XMLHttpRequest\s*\(/g },
  { family: 'EventSource', group: 'browser', kind: 'constructor', pattern: /(?<![\w$.])new\s+EventSource\s*\(/g },
  { family: 'EventSource', group: 'browser', kind: 'constructor', pattern: /(?<![\w$.])new\s+(?:window|globalThis|self)\s*\.\s*EventSource\s*\(/g },
  { family: 'navigator.sendBeacon', group: 'browser', kind: 'call', pattern: /(?<![\w$.])(?:window\s*\.\s*)?navigator\s*\.\s*sendBeacon\s*\(/g },
]

/** 强配置键：出现即记录，值可以缺失（运行时拼出来的端点也算配置意图）。 */
const STRONG_CONFIG = new Set(['baseURL', 'baseUrl', 'endpoint'])

/** 弱配置键：只认绝对值得像端点/主机名的字面量，避免把普通链接和相对路由算进来。 */
const WEAK_CONFIG = new Set(['hostname', 'host', 'url', 'uri'])

/** 配置键统一匹配；对象键在掩码后仍是代码，可以直接在掩码文本上找。 */
const CONFIG_PATTERN = /(?<![\w$.])(baseURL|baseUrl|endpoint|hostname|host|url|uri)\s*:/g

/** 字符码：掩码时只保留换行，保证行号不漂移。 */
const NEWLINE = 10
const CARRIAGE_RETURN = 13

/**
 * 把注释与字符串替换成空格，保留长度与换行。
 *
 * 调用点只可能在代码里；掩码后正则不会命中注释或字符串里的示例文本。模板字面量
 * 整体掩码（`${}` 里的调用很少，且用半成品文本匹配更容易误报）。
 * @param {string} text - 源码。
 * @returns {string} 同长度的掩码文本。
 */
function maskSource(text) {
  let out = ''
  let cursor = 0
  let index = 0
  const blank = (start, end) => {
    let value = ''
    for (let i = start; i < end; i++) {
      const code = text.charCodeAt(i)
      value += code === NEWLINE || code === CARRIAGE_RETURN ? text[i] : ' '
    }
    return value
  }
  while (index < text.length) {
    const code = text.charCodeAt(index)
    const next = text.charCodeAt(index + 1)
    if (code === 47 && next === 47) {
      const start = index
      index += 2
      while (index < text.length && text.charCodeAt(index) !== NEWLINE) index++
      out += text.slice(cursor, start) + blank(start, index)
      cursor = index
      continue
    }
    if (code === 47 && next === 42) {
      const start = index
      index += 2
      while (index < text.length && !(text.charCodeAt(index) === 42 && text.charCodeAt(index + 1) === 47)) index++
      index = Math.min(text.length, index + 2)
      out += text.slice(cursor, start) + blank(start, index)
      cursor = index
      continue
    }
    if (code === 34 || code === 39 || code === 96) {
      const start = index
      const quote = code
      index++
      while (index < text.length) {
        const current = text.charCodeAt(index)
        if (current === 92) {
          index += 2
          continue
        }
        index++
        if (current === quote) break
      }
      out += text.slice(cursor, start) + blank(start, index)
      cursor = index
      continue
    }
    index++
  }
  out += text.slice(cursor)
  return out
}

/**
 * 行首下标表，供 O(log n) 的行号查询。
 * @param {string} text - 源码。
 * @returns {number[]} 每行开头的位置。
 */
function lineStarts(text) {
  const starts = [0]
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === NEWLINE) starts.push(index + 1)
  }
  return starts
}

/**
 * 下标 → 行号（1 起）。
 * @param {number[]} starts - 行首下标表。
 * @param {number} index - 下标。
 * @returns {number} 行号。
 */
function lineOf(starts, index) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (starts[middle] <= index) low = middle
    else high = middle - 1
  }
  return low + 1
}

/**
 * 把一个名字安全地放进正则。
 * @param {string} value - 原始名字。
 * @returns {string} 转义后的文本。
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 去掉 `node:` 前缀并取包名；子路径归到同一个包。
 * @param {string} specifier - import / require 的模块说明符。
 * @returns {string} 包名。
 */
function packageOf(specifier) {
  const value = specifier.replace(/^node:/, '')
  if (value.startsWith('@')) return value.split('/').slice(0, 2).join('/')
  return value.split('/')[0]
}

/**
 * 记录一条命名导入。
 * @param {Map<string, object>} bindings - 本地名 → 绑定。
 * @param {string} local - 本地名。
 * @param {string} spec - 模块说明符。
 * @param {string | undefined} imported - 原始导出名；默认导入为 undefined。
 */
function addBinding(bindings, local, spec, imported) {
  if (!/^[A-Za-z_$][\w$]*$/.test(local) || bindings.has(local)) return
  bindings.set(local, { module: packageOf(spec), imported })
}

/**
 * 解析 `{ a, b as c }` 形式的命名导入。
 * @param {string} clause - 花括号片段。
 * @param {string} spec - 模块说明符。
 * @param {Map<string, object>} bindings - 绑定表。
 */
function addNamed(clause, spec, bindings) {
  const open = clause.indexOf('{')
  const close = clause.lastIndexOf('}')
  if (open < 0 || close <= open) return
  for (const part of clause.slice(open + 1, close).split(',')) {
    const piece = part.trim()
    if (piece.length === 0) continue
    const aliased = piece.split(/\s+as\s+/)
    let imported = piece
    let local = piece
    if (aliased.length === 2) {
      imported = aliased[0].trim()
      local = aliased[1].trim()
    } else {
      // CJS 解构用 `fetch: localFetch`；ESM 用 `as`。两种都接受。
      const colon = piece.indexOf(':')
      if (colon >= 0) {
        imported = piece.slice(0, colon).trim()
        local = piece.slice(colon + 1).trim()
      }
    }
    if (imported.length === 0) continue
    addBinding(bindings, local, spec, imported === 'default' ? undefined : imported)
  }
}

/**
 * 收集一个文件里的模块绑定。
 * `import` 关键字必须在代码区（掩码后未变）才解析，避免注释里的示例被当真。
 * @param {string} text - 原始源码。
 * @param {string} masked - 掩码源码。
 * @returns {Map<string, { module: string, imported?: string }>} 本地名 → 绑定。
 */
function collectBindings(text, masked) {
  const bindings = new Map()
  const esm = /\bimport\s+([^;]*?)\s*from\s*(['"])([^'"]+)\2/g
  for (const match of text.matchAll(esm)) {
    if (masked.charCodeAt(match.index) !== text.charCodeAt(match.index)) continue
    const clause = match[1].trim()
    const spec = match[3]
    if (clause.startsWith('*')) {
      const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause)
      if (namespace !== null) addBinding(bindings, namespace[1], spec)
      continue
    }
    if (clause.startsWith('{')) {
      addNamed(clause, spec, bindings)
      continue
    }
    const comma = clause.indexOf(',')
    const head = (comma < 0 ? clause : clause.slice(0, comma)).trim()
    addBinding(bindings, head, spec)
    if (comma >= 0) addNamed(clause.slice(comma + 1), spec, bindings)
  }

  const cjs = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*|\{[^}]*\})\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)/g
  for (const match of text.matchAll(cjs)) {
    if (masked.charCodeAt(match.index) !== text.charCodeAt(match.index)) continue
    const target = match[1].trim()
    if (target.startsWith('{')) addNamed(target, match[3], bindings)
    else addBinding(bindings, target, match[3])
  }

  // `const fetch = require('undici').fetch`：成员挂到一个本地名上。
  const cjsMember = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g
  for (const match of text.matchAll(cjsMember)) {
    if (masked.charCodeAt(match.index) !== text.charCodeAt(match.index)) continue
    addBinding(bindings, match[1], match[3], match[4])
  }

  // `const { fetch } = await import('undici')`：动态导入同样产生绑定，
  // 否则全局 fetch 规则会把一个明确的 undici 调用错标成全局 fetch。
  const dynamicImport = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*|\{[^}]*\})\s*=\s*await\s+import\s*\(\s*(['"])([^'"]+)\2\s*\)/g
  for (const match of text.matchAll(dynamicImport)) {
    if (masked.charCodeAt(match.index) !== text.charCodeAt(match.index)) continue
    const target = match[1].trim()
    if (target.startsWith('{')) addNamed(target, match[3], bindings)
    else addBinding(bindings, target, match[3])
  }
  return bindings
}

/**
 * 裸名后面跟 `{` 的是方法定义，不是调用。
 *
 * `async fetch(request) { … }` 这类类/对象方法在掩码后与 `fetch(args)` 形状相同；
 * 不区分的话，宿主自己的 provider 方法会被记成一次全局 fetch 调用。
 * @param {string} masked - 掩码源码。
 * @param {number} openEnd - `(` 之后的位置。
 * @param {number} index - 匹配起点，用于判断是否处在声明位置。
 * @returns {boolean} 是否方法定义。
 */
function looksLikeDefinition(masked, openEnd, index) {
  let depth = 1
  for (let cursor = openEnd; cursor < masked.length; cursor++) {
    const code = masked.charCodeAt(cursor)
    if (code === 40) depth++
    else if (code === 41) {
      depth--
      if (depth === 0) {
        let next = cursor + 1
        while (next < masked.length && /\s/.test(masked[next])) next++
        if (masked.charCodeAt(next) === 123) return true
        // TypeScript 方法签名：`) : ReturnType`。只在声明位置认，避免把三元表达式
        // `cond ? fetch(x) : y` 误判成定义。
        if (masked.charCodeAt(next) === 58) {
          const before = masked.slice(Math.max(0, index - 24), index)
          if (/(?:\basync|\bget|\bset|\bstatic|\bpublic|\bprivate|\bprotected|\breadonly|\boverride)\s+$/.test(before)) return true
          let previous = index - 1
          while (previous >= 0 && (masked[previous] === ' ' || masked[previous] === '\t')) previous--
          if (previous < 0 || masked[previous] === '\n' || masked[previous] === '\r') return true
          if (masked[previous] === '{' || masked[previous] === ';' || masked[previous] === '}') return true
        }
        return false
      }
    }
  }
  return false
}

/**
 * 这个名字是否在文件里被本地声明（而不是从模块导入）。
 * 全局 `fetch` / `WebSocket` 只在没有被遮蔽时才按全局写法记录。
 * @param {string} masked - 掩码源码。
 * @param {string} name - 名字。
 * @returns {boolean} 是否本地声明。
 */
function declaredLocally(masked, name) {
  const source = escapeRegExp(name)
  const direct = '(?:\\bfunction\\s+|\\bclass\\s+|\\b(?:const|let|var)\\s+)' + source + '\\b'
  const destructured = '\\b(?:const|let|var)\\s*\\{[^}]*\\b' + source + '\\b[^}]*\\}'
  return new RegExp('(?:' + direct + '|' + destructured + ')').test(masked)
}

/**
 * 读取调用实参位置上的字面量端点。
 * @param {string} text - 原始源码。
 * @param {number} index - `(` 之后的位置。
 * @param {Map<string, string>} constants - 同包字符串常量表。
 * @returns {string | undefined} 端点原文。
 */
function targetAt(text, index, constants) {
  let cursor = index
  while (cursor < text.length && /\s/.test(text[cursor])) cursor++
  const code = text.charCodeAt(cursor)
  if (code === 34 || code === 39 || code === 96) {
    const quote = code
    let value = ''
    cursor++
    while (cursor < text.length) {
      const current = text[cursor]
      if (current === '\\') {
        value += text[cursor + 1] ?? ''
        cursor += 2
        continue
      }
      if (text.charCodeAt(cursor) === quote) return value
      if (quote === 96 && current === '$' && text[cursor + 1] === '{') return value + INTERPOLATION
      value += current
      cursor++
    }
    return undefined
  }
  const identifier = /^[A-Za-z_$][\w$]*/.exec(text.slice(cursor, cursor + 120))
  if (identifier === null) return undefined
  return constants.get(identifier[0])
}

/**
 * 读取 `{ … }` 对象字面量；限制长度，避免把后续语句里的字段算进来。
 * @param {string} text - 原始源码。
 * @param {number} index - `{` 的位置。
 * @returns {string} 对象字面量，或空串。
 */
function objectTextAt(text, index) {
  if (text.charCodeAt(index) !== 123) return ''
  let depth = 0
  let quote = 0
  const end = Math.min(text.length, index + 400)
  for (let cursor = index; cursor < end; cursor++) {
    const code = text.charCodeAt(cursor)
    if (quote !== 0) {
      if (code === 92) {
        cursor++
        continue
      }
      if (code === quote) quote = 0
      continue
    }
    if (code === 34 || code === 39 || code === 96) {
      quote = code
      continue
    }
    if (code === 123) depth++
    else if (code === 125) {
      depth--
      if (depth === 0) return text.slice(index, cursor + 1)
    }
  }
  return text.slice(index, end)
}

/**
 * 对象实参里可能写端点：`axios({ url: '…' })` 这类形状。
 * 只认第一个实参确实是对象字面量的调用；否则窗口会跨到后续语句，把无关字段当目标。
 * @param {string} text - 原始源码。
 * @param {number} index - `(` 之后的位置。
 * @param {Map<string, string>} constants - 同包字符串常量表。
 * @returns {string | undefined} 端点原文。
 */
function propertyTargetAt(text, index, constants) {
  let cursor = index
  while (cursor < text.length && /\s/.test(text[cursor])) cursor++
  const span = objectTextAt(text, cursor)
  if (span.length === 0) return undefined
  const match = /\b(?:url|uri|endpoint)\s*:\s*(?:['"`]([^'"`]*)['"`]|([A-Za-z_$][\w$]*))/.exec(span)
  if (match === null) return undefined
  return match[1] ?? constants.get(match[2])
}

/**
 * 端点脱敏：去掉 userinfo 与查询串，模板插值处截断，长度封顶。
 * @param {string | undefined} raw - 原文。
 * @returns {string | undefined} 可展示端点。
 */
function sanitizeTarget(raw) {
  if (typeof raw !== 'string') return undefined
  let value = raw.trim()
  if (value.length === 0) return undefined
  const interpolation = value.indexOf(INTERPOLATION)
  if (interpolation >= 0) value = value.slice(0, interpolation) + '…'
  value = value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1')
  value = value.replace(/[?#].*$/, '')
  if (value.length > TARGET_LIMIT) value = value.slice(0, TARGET_LIMIT) + '…'
  return value
}

/**
 * 弱配置键的值是否像绝对端点/主机名。
 * @param {string | undefined} value - 字面量值。
 * @returns {boolean} 是否像端点。
 */
function looksLikeEndpoint(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  // 只要带 scheme 的绝对地址；`file:` / `data:` 是本地资源，不算网络端点。
  if (/^(?!file:|data:)[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true
  if (value.startsWith('//')) return true
  return /^(?:[\w-]+\.)+[\w-]+(?::\d+)?(?:\/|$)/.test(value) || /^localhost(?::\d+)?(?:\/|$)/i.test(value)
}

/**
 * 一个文件里的网络调用点与网络配置。
 * @param {string} file - 包内相对路径。
 * @param {string} text - 文件内容。
 * @param {Map<string, string>} constants - 同包字符串常量表。
 * @returns {Array<object>} `{ id, label, group, kind, file, line, target? }`。
 */
export function scanNetworkSites(file, text, constants = new Map()) {
  const masked = maskSource(text)
  const starts = lineStarts(text)
  const bindings = collectBindings(text, masked)
  const sites = []
  const seen = new Set()

  const push = (id, label, group, kind, index, target, extra) => {
    const line = lineOf(starts, index)
    const key = id + '|' + group + '|' + kind + '|' + line + '|' + (target ?? '')
    if (seen.has(key)) return
    seen.add(key)
    const clean = sanitizeTarget(target)
    sites.push({
      id,
      label,
      group: FAMILY_GROUP[group] ?? group,
      kind,
      file,
      line,
      ...(clean === undefined ? {} : { target: clean }),
      ...(extra ?? {}),
    })
  }

  // 1. 模块规则：本地名必须从对应模块导入，避免把同名变量当网络调用。
  for (const [local, binding] of bindings) {
    for (const rule of MODULE_RULES) {
      if (!rule.modules.includes(binding.module)) continue
      const qualified = binding.imported === undefined ? undefined : rule.family + '.' + binding.imported
      if (binding.imported !== undefined) {
        const pattern = new RegExp('(?<![\\w$.])' + escapeRegExp(local) + '\\s*\\(', 'g')
        for (const match of masked.matchAll(pattern)) {
          const open = match.index + match[0].length
          if (looksLikeDefinition(masked, open, match.index)) continue
          push(qualified, qualified, rule.family, 'call', match.index, targetAt(text, open, constants))
        }
        if (rule.construct === true) {
          const construct = new RegExp('(?<![\\w$.])new\\s+' + escapeRegExp(local) + '\\s*\\(', 'g')
          for (const match of masked.matchAll(construct)) {
            push(qualified, qualified, rule.family, 'call', match.index, targetAt(text, match.index + match[0].length, constants))
          }
        }
        continue
      }
      if (rule.callable === true) {
        const pattern = new RegExp('(?<![\\w$.])' + escapeRegExp(local) + '\\s*\\(', 'g')
        for (const match of masked.matchAll(pattern)) {
          const open = match.index + match[0].length
          if (looksLikeDefinition(masked, open, match.index)) continue
          push(local, rule.family, rule.family, 'call', match.index, targetAt(text, open, constants) ?? propertyTargetAt(text, open, constants))
        }
      }
      if (rule.construct === true) {
        const pattern = new RegExp('(?<![\\w$.])new\\s+' + escapeRegExp(local) + '\\s*\\(', 'g')
        for (const match of masked.matchAll(pattern)) {
          push(local, rule.family, rule.family, 'call', match.index, targetAt(text, match.index + match[0].length, constants))
        }
      }
      for (const member of rule.members ?? []) {
        const pattern = new RegExp('(?<![\\w$.])' + escapeRegExp(local) + '\\s*\\.\\s*' + member + '\\s*\\(', 'g')
        for (const match of masked.matchAll(pattern)) {
          const label = rule.family + '.' + member
          push(label, label, rule.family, 'call', match.index, targetAt(text, match.index + match[0].length, constants) ?? propertyTargetAt(text, match.index + match[0].length, constants))
        }
      }
    }
  }

  // 2. 内联 require：`require('node:http').get(...)`、`require('axios')(...)`。
  // 没有本地绑定，但调用形状仍然明确；只认模块说明符在规则表里的写法。
  const INLINE_REQUIRE = /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g
  for (const match of text.matchAll(INLINE_REQUIRE)) {
    if (masked.charCodeAt(match.index) !== text.charCodeAt(match.index)) continue
    const rule = MODULE_RULES.find((item) => item.modules.includes(packageOf(match[2])))
    if (rule === undefined) continue
    const rest = masked.slice(match.index + match[0].length)
    const member = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(rest)
    if (member !== null && (rule.members ?? []).includes(member[1])) {
      const open = match.index + match[0].length + member[0].length
      const label = rule.family + '.' + member[1]
      push(label, label, rule.family, 'call', match.index, targetAt(text, open, constants) ?? propertyTargetAt(text, open, constants))
      continue
    }
    const direct = /^\s*\(/.exec(rest)
    if (direct !== null && rule.callable === true) {
      const open = match.index + match[0].length + direct[0].length
      push(rule.family, rule.family, rule.family, 'call', match.index, targetAt(text, open, constants) ?? propertyTargetAt(text, open, constants))
    }
  }

  // 3. 全局写法：没有导入也联网；被同名绑定/本地声明遮蔽时跳过。
  for (const rule of GLOBAL_RULES) {
    const root = rule.family.split('.')[0]
    if (bindings.has(root) || (root !== 'navigator' && declaredLocally(masked, root))) continue
    for (const match of masked.matchAll(rule.pattern)) {
      const open = match.index + match[0].length
      if (rule.kind === 'call' && looksLikeDefinition(masked, open, match.index)) continue
      push(rule.family, rule.family, rule.group, rule.kind === 'constructor' ? 'call' : rule.kind, match.index, targetAt(text, open, constants))
    }
  }

  // 4. 配置键：强键出现即记；弱键要求值像端点，减少普通 url 字段的噪声。
  for (const match of masked.matchAll(CONFIG_PATTERN)) {
    const key = match[1]
    const literal = targetAt(text, match.index + match[0].length, constants)
    const strong = STRONG_CONFIG.has(key)
    const weak = WEAK_CONFIG.has(key)
    if (!strong && !weak) continue
    if (weak && !looksLikeEndpoint(literal)) continue
    push(key, key, 'config', 'config', match.index, literal)
  }

  return sites.sort((left, right) => left.line - right.line || left.label.localeCompare(right.label))
}
