/**
 * 工具 schema 的分层归类：实际请求 vs 当前注册表，预演 vs 全局 + preset scope。
 *
 * `request/header` 只给最终工具列表，不记「谁注册的」；公开面也没有逐层 owner。
 * 所以这里拿实际 schema 与当前 global / preset / agent scope 的定义做等值比较，
 * 得出「更像哪一层」的推断，而不是声称历史归属。
 *
 * 边界：
 *   - 同名且定义完全相同时，无法区分是全局、预设还是会话层提供的；
 *   - 请求之后注册表变了，实际 schema 可能落进 `unknown` 或 `replaced`；
 *   - `replaced` 只说明「名字在全局/预设里存在，但实际定义不同」，不确认是谁替换的。
 * @module dsh-plugin-console/host/tool-set
 */

/**
 * 把一条工具定义整理成可展示、可比较的 schema。
 * @param {object} tool - 请求头或注册表里的工具定义。
 * @returns {{name: string, description?: string, parameters?: object, deferLoading?: boolean} | undefined} 归一化 schema。
 */
export function toolSchemaOf(tool) {
  if (tool === null || typeof tool !== 'object' || typeof tool.name !== 'string') return undefined
  return {
    name: tool.name,
    ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
    ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    ...(tool.deferLoading === true ? { deferLoading: true } : {}),
  }
}

/** 键顺序稳定的 JSON，避免同一份 schema 因属性顺序不同被判成不同定义。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
}

/** 一份 schema 的比较键；名字单独作为 map 的键，这里只比定义。 */
function schemaKey(tool) {
  return stableStringify({
    description: tool.description ?? '',
    parameters: tool.parameters ?? null,
    deferLoading: tool.deferLoading === true,
  })
}

/** 把一组工具整理成「名字 → 定义键」，用于跨层比对。 */
function keyMapOf(tools) {
  const map = new Map()
  for (const tool of Array.isArray(tools) ? tools : []) {
    const normalized = toolSchemaOf(tool)
    if (normalized !== undefined) map.set(normalized.name, schemaKey(normalized))
  }
  return map
}

/**
 * 把实际请求里的工具按「定义来自哪一层」分组。
 *
 * 判定顺序：
 *   1. 与全局层一致 → `global`；
 *   2. 与预设 scope 一致 → `preset`；
 *   3. 名字在当前 agent scope 里可见 → `session`（同名但定义不同也归这里，并进 `replaced`）；
 *   4. 名字只在 global/preset 里、定义却不同 → `replaced`（冷会话无法复核 agent scope）；
 *   5. 当前注册表里找不到 → `unknown`。
 * @param {{actual: Array<object>, global?: Array<object>, preset?: Array<object>, agentNames?: string[]}} input - 各层定义。
 * @returns {object} 分组结果；`layers` 是名字列表，`layerByName` 是名字 → 层级。
 */
export function classifyToolSchemas(input = {}) {
  const globalKeys = keyMapOf(input.global)
  const presetKeys = keyMapOf(input.preset)
  const agentNames = new Set(Array.isArray(input.agentNames) ? input.agentNames : [])
  const layers = { global: [], preset: [], session: [], replaced: [], unknown: [] }
  const layerByName = {}
  const replaced = []

  for (const raw of Array.isArray(input.actual) ? input.actual : []) {
    const tool = toolSchemaOf(raw)
    if (tool === undefined) continue
    const key = schemaKey(tool)
    const inGlobal = globalKeys.has(tool.name)
    const inPreset = presetKeys.has(tool.name)
    let layer
    if (inGlobal && globalKeys.get(tool.name) === key) layer = 'global'
    else if (inPreset && presetKeys.get(tool.name) === key) layer = 'preset'
    else if (agentNames.has(tool.name)) layer = 'session'
    else if (inGlobal || inPreset) layer = 'replaced'
    else layer = 'unknown'

    if ((inGlobal || inPreset) && layer !== 'global' && layer !== 'preset') replaced.push(tool.name)
    if (!layers[layer].includes(tool.name)) layers[layer].push(tool.name)
    layerByName[tool.name] = layer
  }

  return {
    basis: 'schema-match-current-registry',
    counts: Object.fromEntries(Object.entries(layers).map(([layer, names]) => [layer, names.length])),
    layers,
    layerByName,
    replaced,
  }
}

/** 把一组工具（名字或 schema）收成名字集合。 */
function namesOf(tools) {
  const set = new Set()
  for (const entry of Array.isArray(tools) ? tools : []) {
    if (typeof entry === 'string') set.add(entry)
    else if (typeof entry?.name === 'string') set.add(entry.name)
  }
  return set
}

/**
 * 把预演的工具按「这个名字从哪一层来」分组。
 *
 * 预演用 preset scope 装配，所以来源只有全局层与预设层。判定只看**名字是否在
 * 该层的可见集里**，不比较定义：
 *   1. 名字在全局视图里就有 → `global`（所有模式共享，模式可能重新注册过它）；
 *   2. 名字只在 preset scope 出现 → `preset`（模式新增的工具）；
 *   3. 两边都没有 → `unknown`（装配期间才出现的动态注册）。
 *
 * 为什么不做定义等值比较：装配结果本来就取自 preset scope，先按「全局层有同名、
 * 定义不同」判替换会把模式重新注册过的每个工具都标成「同名替换」；而注册表在
 * 装配后变化、投影方式差异都会制造假差异。名字级分组不会误报，也更容易解释。
 * @param {{tools?: Array<object>, global?: Array<object|string>, preset?: Array<object|string>}} input - 预演工具与两层可见集。
 * @returns {object} 分组结果；`layers` 是名字列表，`layerByName` 是名字 → 层级。
 */
export function classifyPreviewTools(input = {}) {
  const globalNames = namesOf(input.global)
  const presetNames = namesOf(input.preset)
  const layers = { global: [], preset: [], unknown: [] }
  const layerByName = {}

  for (const raw of Array.isArray(input.tools) ? input.tools : []) {
    const tool = toolSchemaOf(raw)
    if (tool === undefined) continue
    const layer = globalNames.has(tool.name)
      ? 'global'
      : presetNames.has(tool.name) ? 'preset' : 'unknown'
    if (!layers[layer].includes(tool.name)) layers[layer].push(tool.name)
    layerByName[tool.name] = layer
  }

  return {
    basis: 'name-membership-scope',
    counts: Object.fromEntries(Object.entries(layers).map(([layer, names]) => [layer, names.length])),
    layers,
    layerByName,
  }
}
