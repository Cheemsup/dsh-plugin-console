/**
 * 组合包层与用户 patch 层的归因。
 *
 * 一份快照要回答「这一行是哪来的」，三个来源必须分开记：
 *   1. profile 声明的 bundle 顺序（决定层级归因的优先级）；
 *   2. 每个可用 bundle 插入了哪些行、覆盖了哪些行；
 *   3. 用户自己在 profile / home 两层 `cordis.patch.yml` 里插入或覆盖的行。
 * @module dsh-plugin-console/host/layers
 */

import { readJsonFile, readTextFile } from './fs.js'
import { scanPatchRows } from './patch-scan.js'

/**
 * 采集组合包层。
 *
 * `rowOwner` 只记**首个**插入该行的 bundle（后插入的只是覆盖），
 * `rowOverriders` 记所有覆盖它的 bundle，顺序即应用顺序。
 * @param {object} profile - `profileContext` 服务。
 * @param {object} pluginManager - `pluginManager` 服务。
 * @returns {Promise<{bundleOrder: string[], profileManifest: object | null, rowOwner: Map, rowOverriders: Map, layerList: Array, enabledBundles: string[]}>} 层信息。
 */
export async function collectBundles(profile, pluginManager) {
  // —— 1. profile 声明的 bundle 顺序：决定层级归因的优先级 ——
  let bundleOrder = []
  let profileManifest = null
  if (profile?.dir) {
    const manifest = await readJsonFile(`${profile.dir}/package.json`)
    if (manifest !== null) {
      profileManifest = manifest
      bundleOrder = manifest?.dsh?.profile?.bundles ?? []
    }
  }

  // —— 2. 每个可用 bundle 插入了哪些行（用于层级归因） ——
  /** @type {Map<string, {bundle: string, version?: string}>} 行 id → 首个插入它的 bundle */
  const rowOwner = new Map()
  /** @type {Map<string, string[]>} 行 id → 覆盖它的 bundle 列表 */
  const rowOverriders = new Map()
  /** @type {Array<{name: string, version?: string, kind: string}>} */
  const layerList = []

  let bundles = []
  if (pluginManager && typeof pluginManager.listBundles === 'function') {
    try {
      bundles = await pluginManager.listBundles()
    } catch {
      bundles = []
    }
  }

  const enabledBundles = bundleOrder.length > 0
    ? bundleOrder
    : bundles.filter((bundle) => bundle.enabled).map((bundle) => bundle.name)

  for (const bundleName of enabledBundles) {
    const bundle = bundles.find((candidate) => candidate.name === bundleName)
    if (!bundle) continue
    const kind = bundle.availability === 'profile' ? 'package' : 'builtin'
    layerList.push({ name: bundle.name, version: bundle.version, kind })
    for (const row of bundle.rows ?? []) {
      if (!row?.rowId) continue
      if (!rowOwner.has(row.rowId)) rowOwner.set(row.rowId, { bundle: bundle.name, version: bundle.version })
    }
    for (const rowId of bundle.overrides ?? []) {
      const list = rowOverriders.get(rowId) ?? []
      list.push(bundle.name)
      rowOverriders.set(rowId, list)
    }
  }

  return { bundleOrder, profileManifest, rowOwner, rowOverriders, layerList, enabledBundles }
}

/**
 * 采集用户自己的 patch 层：profile、home 与启动覆盖层。
 *
 * 三层在 DSH 里的应用顺序是 profile → home → overlays
 * （`readProfilePatches`），所以归因数组也按这个顺序追加；
 * 界面上的 `→` 才等于真实的优先级。文件只读不写。
 * @param {object} profile - `profileContext` 服务。
 * @returns {Promise<{userInserted: Set<string>, userOverridden: Set<string>, userOverrides: Map<string, Array<{layer: string, index?: number, file: string | null, keys: string[]}>>, userLayers: Array<object>}>} 用户层信息。
 */
export async function collectUserLayers(profile) {
  const userInserted = new Set()
  const userOverridden = new Set()
  /** @type {Map<string, Array<{layer: string, index?: number, file: string | null, keys: string[]}>>} */
  const userOverrides = new Map()
  const userLayers = []

  /** 一个 id 可能同时被 profile 与 home 改过；保留每一次，顺序即优先级。 */
  const attribute = (id, info) => {
    userOverridden.add(id)
    const list = userOverrides.get(id) ?? []
    list.push(info)
    userOverrides.set(id, list)
  }

  const files = []
  if (profile?.dir) files.push({ layer: 'profile', dir: profile.dir, file: profile.patchPath ?? `${profile.dir}/cordis.patch.yml` })
  if (profile?.home) files.push({ layer: 'home', dir: profile.home, file: `${profile.home}/cordis.patch.yml` })
  for (const { layer, dir, file } of files) {
    const raw = await readTextFile(file)
    if (!raw) continue
    const { inserted, overridden } = scanPatchRows(raw)
    for (const id of inserted.keys()) userInserted.add(id)
    for (const [id, info] of overridden) attribute(id, { layer, file, keys: info.keys })
    userLayers.push({ name: layer, dir, rows: inserted.size, overrides: overridden.size })
  }

  // 启动覆盖层（`--patch`、遥测开关等）已经是解析好的 PatchOptions，
  // 不再读文件；它们应用在 profile / home 之上，所以排在归因最后。
  const overlays = Array.isArray(profile?.overlays) ? profile.overlays : []
  for (const [index, patch] of overlays.entries()) {
    if (patch === null || typeof patch !== 'object') continue
    if (Array.isArray(patch.insert)) {
      for (const row of patch.insert) {
        if (typeof row?.id === 'string') userInserted.add(row.id)
      }
      continue
    }
    if (typeof patch.id !== 'string') continue
    attribute(patch.id, {
      layer: 'overlay',
      ...(overlays.length > 1 ? { index } : {}),
      file: null,
      keys: Object.keys(patch).filter((key) => key !== 'id'),
    })
  }

  return { userInserted, userOverridden, userOverrides, userLayers }
}
