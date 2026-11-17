/**
 * 一个 Loader 行的 config 分层视图。
 *
 * 快照只保留「生效值」（`entry.configEntries`），看不到这个值来自哪一层、
 * 哪一层又没写。禁用预演要回答的正是后者：上游组合包声明了什么、下游覆盖
 * 改成了什么，以及上游声明的键在生效配置里还在不在。
 *
 * 三条硬规则：
 *   1. **层存在与文件可读分开**：内置组合包、缺 `pluginPackages`、manifest 没有
 *      patch 声明，都会让文件读不到；这一层仍然出现在覆盖链里，标 `readable:false`
 *      与原因，不能据此断言「它没改 config」。
 *   2. **只比较、不解释**：诊断只说「生效配置里没有这个键」「值与某层声明不同」。
 *      patch 的合并语义不是本插件的公开契约，涉及原因的措辞一律标推断。
 *   3. **只读一个目标行**：文件按 `path + mtime + size` 缓存，最多 32 份；
 *      不返回整份 patch，只返回目标行的 config 子树（有长度上限）。
 * @module dsh-plugin-console/host/config-layers
 */

import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { configText } from './entries.js'
import { readJsonFile, readTextFile, statFile } from './fs.js'
import { scanPatchConfig } from './patch-config.js'

/** 覆盖链最多展示的层数（含生效层）。 */
const MAX_LAYERS = 12
/** 单层 config 原文的展示上限。 */
const MAX_RAW_TEXT = 6000
/** patch 文本缓存条数。 */
const MAX_CACHE = 32

/** path → `{mtimeMs, size, text}`；只用于同一路径反复读取（bundle patch 很少变）。 */
const patchTextCache = new Map()

/**
 * 读一个 patch 文件，按指纹缓存。
 * @param {string} file - 绝对路径。
 * @returns {Promise<string | null>} 文件内容或 null。
 */
async function readPatchText(file) {
  const stat = await statFile(file)
  if (stat === null) return null
  const hit = patchTextCache.get(file)
  if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text
  const text = await readTextFile(file)
  if (text === null) return null
  if (patchTextCache.size >= MAX_CACHE) {
    const oldest = patchTextCache.keys().next().value
    patchTextCache.delete(oldest)
  }
  patchTextCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, text })
  return text
}

/** 把 `file://`、绝对路径与相对路径统一成绝对路径。 */
function resolvePath(file, baseDir) {
  if (typeof file !== 'string' || file === '') return undefined
  if (file.startsWith('file://')) {
    try {
      return fileURLToPath(file)
    } catch {
      return undefined
    }
  }
  if (isAbsolute(file)) return file
  return baseDir === undefined ? undefined : join(baseDir, file)
}

/** 一个路径字符串的 file URL；profile.dir 传给 packageOf 时需要目录 URL。 */
function dirUrl(dir) {
  if (typeof dir !== 'string' || dir === '') return undefined
  return pathToFileURL(dir.endsWith('/') || dir.endsWith('\\') ? dir : dir + '/').href
}

/** 组合包是否插入或覆盖了目标行。 */
function bundleTouch(bundle, rowId) {
  const inserted = (bundle.rows ?? []).some((row) => row?.rowId === rowId)
  const overridden = (bundle.overrides ?? []).some((id) => id === rowId)
  return { inserted, overridden }
}

/**
 * 读一个组合包的 patch 文件。
 *
 * 解析顺序：`pluginPackages.packageOf` → `<profile>/node_modules/<name>` 兜底 →
 * manifest 的 `dsh.bundle.patch`（数组只读第一个）→ `cordis.patch.yml`。
 * 任何一步失败都返回原因，不抛错。
 * @param {object} ctx - host 插件上下文。
 * @param {object} snapshot - 快照（只用 profile.dir）。
 * @param {object} bundle - `pluginManager.listBundles()` 的一条记录。
 * @returns {Promise<{readable: boolean, reason?: string, file?: string, note?: string}>} 读取结果。
 */
async function readBundlePatch(ctx, snapshot, bundle) {
  const profileDir = snapshot.profile?.dir
  if (bundle.availability !== undefined && bundle.availability !== 'profile') {
    return { readable: false, reason: '内置组合包没有可读的 patch 文件' }
  }
  const packages = ctx.get('pluginPackages')
  let pkgDir
  let manifest
  if (packages !== undefined && typeof packages.packageOf === 'function') {
    try {
      const pkg = packages.packageOf(bundle.name, dirUrl(profileDir))
      if (typeof pkg?.dir === 'string') pkgDir = pkg.dir
      manifest = pkg?.manifest
    } catch {
      // 解析失败不算异常：下面还有 node_modules 兜底。
    }
  }
  if (pkgDir === undefined && typeof profileDir === 'string') {
    const candidate = join(profileDir, 'node_modules', ...String(bundle.name).split('/'))
    const json = await readJsonFile(join(candidate, 'package.json'))
    if (json !== null) {
      pkgDir = candidate
      manifest = json
    }
  }
  if (pkgDir === undefined) {
    return { readable: false, reason: '无法解析组合包目录（pluginPackages 缺席或没有返回 dir）' }
  }
  manifest ??= await readJsonFile(join(pkgDir, 'package.json'))
  const declared = manifest?.dsh?.bundle?.patch
  let rel = 'cordis.patch.yml'
  let note
  if (Array.isArray(declared)) {
    const first = declared.find((item) => typeof item === 'string')
    if (first !== undefined) rel = first
    note = '声明了多个 patch 文件，本页只读取第一个'
  } else if (typeof declared === 'string') {
    rel = declared
  }
  const file = resolvePath(rel, pkgDir)
  if (file === undefined) return { readable: false, reason: `无法解析 patch 路径（${rel}）` }
  const text = await readPatchText(file)
  if (text === null) return { readable: false, reason: `patch 文件读取失败：${file}` }
  return { readable: true, file, ...(note === undefined ? {} : { note }) }
}

/** 把若干次出现合并成一层视图；同层内后面的出现覆盖前面的键。 */
function mergeOccurrences(occurrences) {
  const keys = []
  const configKeys = []
  const values = {}
  const parsedValues = {}
  const rows = []
  let parsed = true
  let complete = true
  let truncated = false
  const rawParts = []
  for (const occurrence of occurrences) {
    for (const key of occurrence.keys) if (!keys.includes(key)) keys.push(key)
    const row = {
      line: occurrence.line,
      keys: [...occurrence.keys],
      configKeys: [...(occurrence.configKeys ?? [])],
      hasConfig: occurrence.hasConfig === true,
      parsed: occurrence.parsed !== false,
      ...(occurrence.reason === undefined ? {} : { reason: occurrence.reason }),
      rawText: typeof occurrence.configRaw === 'string' ? occurrence.configRaw : '',
    }
    rows.push(row)
    if (occurrence.hasConfig !== true) continue
    if (occurrence.parsed === false) {
      parsed = false
      complete = false
    }
    if (occurrence.truncated === true) truncated = true
    for (const key of occurrence.configKeys ?? []) {
      if (!configKeys.includes(key)) configKeys.push(key)
      if (occurrence.parsed !== false && occurrence.config !== undefined && typeof occurrence.config === 'object') {
        values[key] = configText(occurrence.config[key])
        parsedValues[key] = occurrence.config[key]
      }
    }
    if (typeof occurrence.configRaw === 'string' && occurrence.configRaw !== '') rawParts.push(occurrence.configRaw)
  }
  const rawText = rawParts.join('\n---\n')
  return {
    keys,
    configKeys,
    values,
    parsedValues,
    rows,
    parsed,
    complete,
    truncated: truncated || rawText.length > MAX_RAW_TEXT,
    rawText: rawText.length > MAX_RAW_TEXT ? `${rawText.slice(0, MAX_RAW_TEXT)}…（已截断）` : rawText,
  }
}

/** 一条层记录的基础字段。 */
function baseLayer(fields) {
  return {
    layerId: fields.layerId,
    label: fields.label,
    kind: fields.kind,
    order: fields.order,
    present: true,
    readable: true,
    keys: [],
    configKeys: [],
    values: {},
    parsedValues: {},
    rows: [],
    parsed: true,
    complete: true,
    truncated: false,
    rawText: '',
    ...fields,
  }
}

/** 从一段 patch 文本里建层；没有目标行时返回 null。 */
function layerFromPatchText({ text, rowId, layerId, label, kind, order, file, version, availability, note }) {
  const { rows } = scanPatchConfig(text)
  const occurrences = rows.filter((row) => row.id === rowId)
  if (occurrences.length === 0) return null
  const merged = mergeOccurrences(occurrences)
  return baseLayer({
    layerId,
    label,
    kind,
    order,
    file,
    ...(version === undefined ? {} : { version }),
    ...(availability === undefined ? {} : { availability }),
    ...(note === undefined ? {} : { note }),
    ...merged,
  })
}

/** 有效配置里被快照截断的值：不能参与等值比较。 */
function isClipped(text) {
  return typeof text === 'string' && text.includes('…（已截断，共 ')
}

/** 深比较：对象键顺序无关，数组顺序敏感。 */
function deepEqual(left, right) {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
}

/** 层声明的值与生效值是否一致。 */
function valueMatches(layerValue, effectiveText) {
  if (typeof layerValue === 'string') return layerValue === effectiveText
  if (typeof effectiveText !== 'string') return false
  try {
    return deepEqual(layerValue, JSON.parse(effectiveText))
  } catch {
    return false
  }
}

/** 诊断项；`id` 只用于 React key 与自检定位。 */
function diagnostic(kind, severity, evidence, message, extra = {}) {
  const suffix = extra.key ?? extra.layerId ?? ''
  return { id: `${kind}:${suffix}`, kind, severity, evidence, message, ...extra }
}

/**
 * 比较各层声明与生效配置。
 *
 * 只产出四类可辩护的结论：某个键在生效配置里有没有、值与某层是否相同、
 * 同一键被几层声明、以及「后层覆盖了 config 却没重写上游的 inject」这个
 * **带条件**的推断（措辞里明确写「若运行时按整份替换」）。
 * @param {Array<object>} layers - 覆盖链，含 `effective` 层。
 * @returns {Array<object>} 诊断列表。
 */
export function diffConfigLayers(layers) {
  const effective = layers.find((layer) => layer.kind === 'effective')
  if (effective === undefined) return []
  const diagnostics = []
  const effectiveKeys = new Set(effective.configKeys ?? [])
  const declaring = new Map()
  for (const layer of layers) {
    if (layer.kind === 'effective') continue
    if (layer.readable !== true || layer.complete !== true) continue
    for (const key of layer.configKeys ?? []) {
      const list = declaring.get(key) ?? []
      list.push({ layer, value: layer.parsedValues?.[key] })
      declaring.set(key, list)
    }
    if (layer.configKeys?.length === 0 && layer.rows.some((row) => row.hasConfig === true)) {
      diagnostics.push(diagnostic(
        'empty-config-override',
        'warn',
        'file',
        `层「${layer.label}」覆盖了 config，但没有写出任何键；本页不推断这是否会清空早层配置。`,
        { layerId: layer.layerId },
      ))
    }
  }

  for (const [key, list] of declaring) {
    const declaredBy = [...new Set(list.map((item) => item.layer.label))]
    if (!effectiveKeys.has(key)) {
      if (key === 'inject') {
        diagnostics.push(diagnostic(
          'upstream-inject-risk',
          'warn',
          'runtime',
          `上游层「${declaredBy.join('、')}」声明了 config.inject，但当前生效配置里没有这个键。若上游更新了 inject 而覆盖层没有同步重写，二者会失配；本页不推断合并语义。`,
          { key },
        ))
      } else {
        diagnostics.push(diagnostic(
          'missing-in-effective',
          'info',
          'runtime',
          `层「${declaredBy.join('、')}」声明了 config.${key}，但当前生效配置里没有这个键。若后续层按整份 config 替换，早层声明会失效；本页不推断合并语义。`,
          { key },
        ))
      }
      continue
    }
    if (list.length > 1) {
      diagnostics.push(diagnostic(
        'duplicate-key',
        'info',
        'file',
        `config.${key} 被 ${list.length} 层声明；生效值只能反映最后一次结果。`,
        { key },
      ))
    }
    const effectiveText = effective.values?.[key]
    if (isClipped(effectiveText)) {
      diagnostics.push(diagnostic(
        'value-not-compared',
        'info',
        'runtime',
        `config.${key} 的生效值已被快照截断，无法与层声明做等值比较。`,
        { key },
      ))
      continue
    }
    const mismatched = list.filter((item) => !valueMatches(item.value, effectiveText))
    if (mismatched.length === 0) continue
    if (key === 'inject') {
      const laterWithout = layers.filter((layer) => (
        layer.kind !== 'effective'
        && layer.readable === true
        && layer.order > list[0].layer.order
        && (layer.configKeys ?? []).length > 0
        && !(layer.configKeys ?? []).includes('inject')
      ))
      diagnostics.push(diagnostic(
        'upstream-drift',
        'warn',
        'inference',
        `上游层声明的 config.inject 与生效值不同${laterWithout.length === 0
          ? ''
          : `；后层「${laterWithout.map((layer) => layer.label).join('、')}」覆盖了 config，但没有重写 inject`}。若运行时按整份替换，说明覆盖层没有跟随上游更新。`,
        { key, laterOverrideWithoutKey: ['inject'] },
      ))
      continue
    }
    diagnostics.push(diagnostic(
      'value-differs',
      'info',
      'runtime',
      `config.${key} 在层「${mismatched.map((item) => item.layer.label).join('、')}」与生效值中不同；生效值以后层为准（运行时事实）。`,
      { key },
    ))
  }

  for (const key of effectiveKeys) {
    if (declaring.has(key)) continue
    diagnostics.push(diagnostic(
      'only-runtime',
      'info',
      'runtime',
      `config.${key} 只出现在生效配置里，文件层没有声明（可能来自插件默认值或运行时补全）。`,
      { key },
    ))
  }

  return diagnostics
}

/** 用覆盖者名单兜底：pluginManager 不可用时仍要知道这一行来自哪个组合包。 */
function fallbackBundleLayer(entry, order) {
  if (typeof entry.layer !== 'string' || entry.layer === 'mode' || entry.layer === 'runtime') return []
  return [baseLayer({
    layerId: `bundle:${entry.layer}`,
    label: entry.layer,
    kind: 'bundle',
    order,
    readable: false,
    reason: 'pluginManager 不可用，无法读取组合包清单与 patch 文件',
  })]
}

/**
 * 汇总一个目标的 config 覆盖链。
 * @param {object} ctx - host 插件上下文。
 * @param {object} snapshot - 当前快照。
 * @param {string} rowId - 目标行 id。
 * @returns {Promise<object>} `{available:true, layers, diagnostics}` 或 `{available:false, reason}`。
 */
export async function collectConfigLayers(ctx, snapshot, rowId) {
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : []
  const entry = entries.find((candidate) => candidate.rowId === rowId)
    ?? entries.find((candidate) => candidate.entryId === rowId)
  if (entry === undefined) return { available: false, reason: '找不到这个插件条目' }
  if (entry.modeOnly === true) {
    return { available: false, reason: '这个条目只由模式挂载，没有自己的 Loader 行与 patch config' }
  }

  const profile = ctx.get('profileContext')
  const pluginManager = ctx.get('pluginManager')
  let bundles
  if (pluginManager !== undefined && typeof pluginManager.listBundles === 'function') {
    try {
      const listed = await pluginManager.listBundles()
      if (Array.isArray(listed)) bundles = listed
    } catch {
      bundles = undefined
    }
  }

  const orderNames = Array.isArray(snapshot.profile?.bundles) && snapshot.profile.bundles.length > 0
    ? snapshot.profile.bundles
    : (bundles ?? []).map((bundle) => bundle.name)
  const layers = []
  const touched = new Set()
  for (const [index, name] of orderNames.entries()) {
    const bundle = bundles?.find((candidate) => candidate.name === name)
    if (bundle === undefined) {
      if (name === entry.layer && !touched.has(name)) {
        layers.push(...fallbackBundleLayer(entry, index))
        touched.add(name)
      }
      continue
    }
    const touch = bundleTouch(bundle, entry.rowId)
    if (!touch.inserted && !touch.overridden) continue
    touched.add(name)
    const read = await readBundlePatch(ctx, snapshot, bundle)
    if (read.readable !== true) {
      layers.push(baseLayer({
        layerId: `bundle:${name}`,
        label: name,
        kind: 'bundle',
        order: index,
        version: bundle.version,
        availability: bundle.availability,
        readable: false,
        reason: read.reason ?? 'patch 文件不可读',
      }))
      continue
    }
    const text = await readPatchText(read.file)
    if (text === null) {
      layers.push(baseLayer({
        layerId: `bundle:${name}`,
        label: name,
        kind: 'bundle',
        order: index,
        version: bundle.version,
        availability: bundle.availability,
        readable: false,
        reason: `patch 文件读取失败：${read.file}`,
      }))
      continue
    }
    const fromText = layerFromPatchText({
      text,
      rowId: entry.rowId,
      layerId: `bundle:${name}`,
      label: name,
      kind: 'bundle',
      order: index,
      file: read.file,
      version: bundle.version,
      availability: bundle.availability,
      note: read.note,
    })
    if (fromText === null) {
      layers.push(baseLayer({
        layerId: `bundle:${name}`,
        label: name,
        kind: 'bundle',
        order: index,
        version: bundle.version,
        availability: bundle.availability,
        file: read.file,
        note: 'patch 文件里没有找到这一行的 id',
      }))
    } else {
      layers.push(fromText)
    }
  }
  if (layers.length === 0) layers.push(...fallbackBundleLayer(entry, orderNames.length))

  const userFiles = []
  if (typeof profile?.dir === 'string') {
    userFiles.push({ layerId: 'profile', label: 'profile patch', file: resolvePath(profile.patchPath ?? 'cordis.patch.yml', profile.dir) })
  }
  if (typeof profile?.home === 'string') {
    userFiles.push({ layerId: 'home', label: 'home patch', file: resolvePath('cordis.patch.yml', profile.home) })
  }
  let order = layers.length
  for (const item of userFiles) {
    if (item.file === undefined) continue
    const text = await readPatchText(item.file)
    if (text === null) continue
    const layer = layerFromPatchText({
      text,
      rowId: entry.rowId,
      layerId: item.layerId,
      label: item.label,
      kind: item.layerId,
      order,
      file: item.file,
    })
    if (layer !== null) layers.push(layer)
    order++
  }

  const overlays = Array.isArray(profile?.overlays) ? profile.overlays : []
  for (const [index, patch] of overlays.entries()) {
    if (patch === null || typeof patch !== 'object') continue
    const row = Array.isArray(patch.insert)
      ? patch.insert.find((item) => item?.id === entry.rowId)
      : patch.id === entry.rowId ? patch : undefined
    if (row === undefined) continue
    const values = {}
    const parsedValues = {}
    const configKeys = row.config !== null && typeof row.config === 'object' && !Array.isArray(row.config) ? Object.keys(row.config) : []
    for (const key of configKeys) {
      values[key] = configText(row.config[key])
      parsedValues[key] = row.config[key]
    }
    layers.push(baseLayer({
      layerId: `overlay:${index}`,
      label: overlays.length > 1 ? `启动覆盖层 ${index + 1}` : '启动覆盖层',
      kind: 'overlay',
      order: order++,
      keys: Object.keys(row).filter((key) => key !== 'id'),
      configKeys,
      values,
      parsedValues,
      readable: true,
      rows: [{ line: null, keys: Object.keys(row).filter((key) => key !== 'id'), configKeys, hasConfig: configKeys.length > 0, parsed: true, rawText: '' }],
    }))
  }

  const effectiveValues = {}
  const effectiveRaw = {}
  for (const row of Array.isArray(entry.configEntries) ? entry.configEntries : []) {
    effectiveValues[row.key] = row.value
  }
  const effectiveConfigKeys = Array.isArray(entry.configEntries) ? entry.configEntries.map((row) => row.key) : []
  layers.push(baseLayer({
    layerId: 'effective',
    label: '生效配置（运行时）',
    kind: 'effective',
    order: order++,
    keys: ['config'],
    configKeys: effectiveConfigKeys,
    values: effectiveValues,
    parsedValues: effectiveRaw,
    readable: true,
    rows: [],
    note: '来自 Loader 的合并结果；本页不推断各层如何合并',
  }))

  const kept = layers.length <= MAX_LAYERS
    ? layers
    : [...layers.slice(0, MAX_LAYERS - 1), layers[layers.length - 1]]
  const diagnostics = diffConfigLayers(kept)
  if (kept.length < layers.length) {
    diagnostics.push(diagnostic(
      'layers-truncated',
      'info',
      'unknown',
      `覆盖链共 ${layers.length} 层，本页只展示前 ${MAX_LAYERS - 1} 层与生效层。`,
    ))
  }
  return { available: true, layers: kept, diagnostics }
}
