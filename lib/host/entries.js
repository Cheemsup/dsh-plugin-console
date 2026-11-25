/**
 * 逐条采集 Loader 行。
 *
 * 这是快照里最重的一段采集：一行的包身份、启用状态、fiber 阶段、服务供需、
 * 副作用、源码注册名、类别都在这里定下来。它只依赖前面几个纯读取模块，
 * 不依赖进程内的任何缓存，所以同一份 ctx 反复调用得到同一份结果。
 * @module dsh-plugin-console/host/entries
 */

import { categorize } from './categorize.js'
import { FIBER_PHASE } from './constants.js'
import { readDiagnostic, readEffects } from './fiber.js'
import { barePackageName, fallbackLayer } from './names.js'
import { scanPackageRegistrations } from './source-scan.js'

/**
 * 覆盖者的展示名。
 *
 * bundle 只给包名——`pluginManager.listBundles()` 的 `overrides` 只暴露 id，
 * 不提供改了哪些键；用户层则由扫描器记到层与键，一并显示出来。
 * @param {{layer: string, index?: number, keys: string[]}} info - 一条用户层归因。
 * @returns {string} 用于「覆盖」一栏的文本。
 */
function overrideLabel(info) {
  const layer = info.layer === 'overlay'
    ? (typeof info.index === 'number' ? `启动覆盖层 ${info.index + 1}` : '启动覆盖层')
    : `profile patch（${info.layer}）`
  // 键放进花括号而不是再接一个冒号：外层已经是「覆盖来源：…」，再套冒号会读成两级。
  return info.keys.length > 0 ? `${layer}{${info.keys.join('、')}}` : layer
}

/**
 * @param {object} ctx - host 插件上下文。
 * @param {object} packages - `pluginPackages` 服务（可缺）。
 * @param {Map<string, {bundle: string, version?: string}>} rowOwner - 行 id → 首个插入它的 bundle。
 * @param {Map<string, string[]>} rowOverriders - 行 id → 覆盖它的 bundle 列表。
 * @param {Set<string>} userInserted - 用户 patch 插入的行 id。
 * @param {Map<string, Array<{layer: string, index?: number, keys: string[]}>>} userOverrides - 行 id → 用户层覆盖记录。
 * @returns {Promise<{entries: Array<object>, services: object, stats: object}>} 条目、服务供需与统计。
 */
export async function collectEntries(ctx, packages, rowOwner, rowOverriders, userInserted, userOverrides) {
  /** @type {Array<object>} */
  const entries = []
  /** @type {Map<string, string[]>} 服务名 → 提供它的运行时条目 id */
  const providers = new Map()
  /** @type {Map<string, string[]>} 服务名 → 需要它的运行时条目 id */
  const consumers = new Map()
  /** @type {Map<string, object>} 运行时条目 id → fiber；补查树外提供者时要用条目自己的上下文 */
  const fibers = new Map()

  let loadIndex = 0
  for (const entry of ctx.loader.entries()) {
    const options = entry.options ?? {}
    const fullId = entry.id
    const rowId = fullId.startsWith('include:') ? fullId.slice('include:'.length) : fullId
    const base = entry.parent?.tree?.ctx?.baseUrl
    const moduleName = options.name

    // 包身份与显示元信息；解析失败不影响行本身
    let pkg
    let meta
    try {
      pkg = base === undefined || !packages ? undefined : packages.packageOf(moduleName, base)
    } catch {
      pkg = undefined
    }
    try {
      meta = base === undefined || !packages ? undefined : packages.metaOf(moduleName, base)
    } catch {
      meta = undefined
    }

    const manifest = pkg?.manifest
    const clientDecl = manifest?.dsh?.client
    const face = clientDecl?.platform === 'web' ? 'both' : 'host'

    // 有效启用状态：自身表达式 + 祖先 group 继承
    let ownDisabled = false
    let disabledExpr
    const rawDisabled = options.disabled
    if (rawDisabled && typeof rawDisabled === 'object' && '__jsExpr' in rawDisabled) {
      disabledExpr = rawDisabled.__jsExpr
      try {
        ownDisabled = Boolean(entry.evaluate?.(disabledExpr))
      } catch {
        ownDisabled = false
      }
    } else {
      ownDisabled = Boolean(rawDisabled)
    }
    let effectiveDisabled
    try {
      effectiveDisabled = Boolean(entry.disabled)
    } catch {
      effectiveDisabled = ownDisabled
    }
    const inheritedDisabled = effectiveDisabled && !ownDisabled

    const fiber = entry.fiber
    if (fiber !== undefined) fibers.set(fullId, fiber)
    const phase = fiber === undefined ? null : (FIBER_PHASE[fiber.state] ?? null)
    const diagnostic = phase === 'failed' ? await readDiagnostic(fiber) : undefined

    const requires = fiber ? Object.keys(fiber.inject ?? {}) : []
    const provides = fiber
      ? [...(fiber.provisions ?? [])].map((provision) => provision?.name).filter((name) => typeof name === 'string')
      : []
    const effects = readEffects(fiber)
    const registrations = await scanPackageRegistrations(pkg?.dir)
    // 提示词注册点单独挂在行上：插件页要靠它判断「这个名字是不是在本作用域注册的」。
    // 名字数组仍留在 registrations 里，旧调用方不受影响。
    const registrationSites = registrations.sites ?? []

    // MCP 客户端的 serverName 决定了它注册的工具名前缀 mcp__<server>__*，
    // 读配置就能把工具归属回这一行。
    const mcpServerName = options.config && typeof options.config === 'object'
      ? (typeof options.config.serverName === 'string' ? options.config.serverName : undefined)
      : undefined

    const configEntries = readConfigEntries(options.config)

    const segments = fullId.split(':')
    const depth = segments.length - 1
    const entryRow = {
      entryId: fullId,
      rowId,
      /** Loader 里的声明顺序。DSH 没有插件级 order，这就是组合文件的加载链顺序。 */
      loadIndex,
      parentEntryId: segments.length > 1 ? segments.slice(0, -1).join(':') : null,
      depth,
      moduleName,
      packageName: barePackageName(moduleName) ?? null,
      version: typeof pkg?.version === 'string' ? pkg.version : null,
      packageDir: typeof pkg?.dir === 'string' ? pkg.dir : null,
      title: typeof meta?.title === 'string' ? meta.title : undefined,
      description: typeof meta?.description === 'string' ? meta.description : undefined,
      metaError: typeof meta?.error === 'string' ? meta.error : undefined,
      layer: rowOwner.get(rowId)?.bundle ?? fallbackLayer(moduleName, depth),
      layerVersion: rowOwner.get(rowId)?.version ?? null,
      overriddenBy: [
        ...(rowOverriders.get(rowId) ?? []),
        ...(userOverrides.get(rowId) ?? []).map(overrideLabel),
      ],
      userInserted: userInserted.has(rowId),
      face,
      enabled: !effectiveDisabled,
      disabledExpr,
      disabledValue: disabledExpr === undefined ? undefined : ownDisabled,
      inheritedDisabled,
      phase,
      diagnostic,
      requires,
      provides,
      effects,
      registrations,
      registrationSites,
      category: categorize(moduleName, registrations),
      mcpServerName,
      clientInject: Array.isArray(clientDecl?.inject) ? clientDecl.inject : [],
      clientExternal: Array.isArray(clientDecl?.external) ? clientDecl.external : [],
      configKeys: configEntries.map((row) => row.key),
      configEntries,
      isGroup: Boolean(options.group),
    }
    entries.push(entryRow)
    loadIndex++

    for (const name of provides) {
      const list = providers.get(name) ?? []
      list.push(fullId)
      providers.set(name, list)
    }
    for (const name of requires) {
      const list = consumers.get(name) ?? []
      list.push(fullId)
      consumers.set(name, list)
    }
  }

  // —— 汇总：服务名 → 提供者 / 消费者 ——
  const services = {}
  for (const name of new Set([...providers.keys(), ...consumers.keys()])) {
    services[name] = {
      providers: providers.get(name) ?? [],
      consumers: consumers.get(name) ?? [],
    }
  }

  // —— 树外提供者 ——
  // 这张表只统计 Loader 行的 `provisions`，而 `loader` 由 Loader 自己提供、
  // `profileContext` 等由宿主在挂树之前 `provide()`：它们都没有「提供者行」。
  // 只看这张表会把正在运行的行报成缺服务（active 的 fiber 本身就是反证），
  // 所以对没找到提供者的名字，再用条目自己的上下文确认一次。
  for (const entry of entries) {
    const missing = entry.requires.filter((name) => (services[name]?.providers ?? []).length === 0)
    if (missing.length === 0) continue
    const hostProvided = missing.filter((name) => providedOutsideTree(ctx, fibers.get(entry.entryId), name))
    if (hostProvided.length > 0) entry.hostRequires = hostProvided
  }

  const pluginEntries = entries.filter((entry) => !entry.moduleName.startsWith('cordis:'))
  const stats = {
    entries: entries.length,
    plugins: pluginEntries.length,
    active: pluginEntries.filter((entry) => entry.phase === 'active').length,
    pending: pluginEntries.filter((entry) => entry.phase === 'pending').length,
    failed: pluginEntries.filter((entry) => entry.phase === 'failed').length,
    disabled: pluginEntries.filter((entry) => !entry.enabled).length,
    dual: pluginEntries.filter((entry) => entry.face === 'both').length,
    thirdParty: pluginEntries.filter((entry) => entry.layer === 'profile' || entry.layer === 'runtime').length,
    services: Object.keys(services).length,
  }

  return { entries, services, stats }
}

/**
 * 条目能否在 Loader 树之外解析某个必需服务。
 *
 * 有 fiber 时用条目自己的上下文，isolate / intercept 与运行时一致；没有 fiber
 * 时退回快照所在的宿主上下文，只回答「宿主里有没有这个名字」。
 * `get()` 不做 inject 要求，且 strict 模式只认 active 的提供者，所以被禁用或
 * 尚未挂载的提供者不会被当成可用。
 * @param {object} ctx - host 插件上下文。
 * @param {object | undefined} fiber - 条目的 fiber；没有 fiber 的行不会带 requires。
 * @param {string} name - 服务名。
 * @returns {boolean} 是否由 Loader 树之外的上下文提供。
 */
function providedOutsideTree(ctx, fiber, name) {
  const scope = fiber?.ctx ?? ctx
  try {
    return typeof scope?.get === 'function' && scope.get(name) !== undefined
  } catch {
    return false
  }
}

/**
 * 单个配置值在快照里的展示上限。
 *
 * 配置里可能有整份工具 schema，不能无限塞进快照；凭据类字段都很短，
 * 这个上限只截断异常大的对象，并在值末尾写明原始长度。
 */
const CONFIG_VALUE_LIMIT = 2000

/**
 * 把任意配置值转成可 JSON 序列化的文本。
 *
 * 配置由插件作者书写，可能带函数、BigInt、循环引用；直接放进快照会让
 * 整份响应序列化失败，所以逐值归一，读不出来就退化成 `String(value)`。
 * @param {unknown} value - `options.config` 里的一个值。
 * @returns {string} 展示文本。
 */
export function configText(value) {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
  if (typeof value === 'symbol') return String(value)
  if (typeof value === 'bigint') return `${value}n`
  try {
    const text = JSON.stringify(value, replaceNonJson)
    return text === undefined ? String(value) : text
  } catch {
    // 循环引用：正常对象走上面的快路径，只有真的序列化失败才做逐层检测。
    return configTextCircular(value)
  }
}

/** JSON 不认识的配置值：函数、BigInt、Symbol 转成可读文本。 */
function replaceNonJson(key, item) {
  if (typeof item === 'bigint') return `${item}n`
  if (typeof item === 'function') return `[function ${item.name || 'anonymous'}]`
  if (typeof item === 'symbol') return String(item)
  return item
}

/** 循环引用的退路：重复出现的对象标成 `[circular]`，其余照常序列化。 */
function configTextCircular(value) {
  const seen = new WeakSet()
  try {
    return JSON.stringify(value, (key, item) => {
      const replaced = replaceNonJson(key, item)
      if (typeof replaced === 'object' && replaced !== null) {
        if (seen.has(replaced)) return '[circular]'
        seen.add(replaced)
      }
      return replaced
    })
  } catch {
    return String(value)
  }
}

/**
 * 把 `options.config` 归一成「字段名 + 生效值」。
 *
 * 快照会原样带上这些值（包括凭据），因为「配置字段有哪些」不足以判断
 * 插件为什么这样行为；值只经由本地面板展示，不写日志、不落盘。
 * @param {unknown} config - Loader 行上的配置对象。
 * @returns {Array<{key: string, value: string}>} 键值对；非对象配置返回空数组。
 */
function readConfigEntries(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return []
  return Object.keys(config).map((key) => {
    const text = configText(config[key])
    return {
      key,
      value: text.length > CONFIG_VALUE_LIMIT
        ? `${text.slice(0, CONFIG_VALUE_LIMIT)}…（已截断，共 ${text.length} 字符）`
        : text,
    }
  })
}

/**
 * 条目按模块名索引：preset 行靠它连回全局条目。
 * @param {Array<object>} entries - 已采集条目。
 * @returns {Map<string, Array<object>>} 模块名 → 行摘要列表。
 */
export function indexRowsByModule(entries) {
  const rowsByModule = new Map()
  for (const entry of entries) {
    const list = rowsByModule.get(entry.moduleName) ?? []
    list.push({ rowId: entry.rowId, layer: entry.layer, phase: entry.phase, enabled: entry.enabled })
    rowsByModule.set(entry.moduleName, list)
  }
  return rowsByModule
}
