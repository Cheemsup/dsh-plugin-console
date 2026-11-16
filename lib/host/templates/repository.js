/**
 * 模板仓库：对四张表的业务读写。
 *
 * 这一层不碰 HTTP，也不碰 agent——它只回答「模板有哪些、某个模板的最新配方是
 * 什么、哪个会话绑了哪份配方、开关是开还是关」。物化在 `materialize.js`。
 * @module dsh-plugin-console/host/templates/repository
 */

import { appliedHandles } from './materialize.js'
import { ensureTemplateStore, newTemplateId, templateTable } from './store.js'

/**
 * 读出「哪些会话绑定了模板、现在是否启用」。
 *
 * 两表合并成一条视图：manifest 提供「绑了哪个模板」，activation 提供「开没开」。
 * 没有 activation 记录就是启用——这正是「默认开」这条语义的落点。
 * @param {object} state - 模板存储状态。
 * @returns {Promise<Map<string, object>>} 会话 id → 绑定信息。
 */
export async function readTemplateBindings(state) {
  const bindings = new Map()
  const manifests = templateTable(state, 'manifests')
  const heads = templateTable(state, 'templates')
  const activations = templateTable(state, 'activations')

  for (const [sessionId, manifest] of manifests.entries()) {
    const templateId = manifest?.source?.templateId
    const head = typeof templateId === 'string' ? heads.get(templateId) : undefined
    const activation = activations.get(sessionId)
    // 名字优先取模板头（跟着改名走）；模板已删时退回应用时写进 manifest 的快照，
    // 这样删除模板不会让会话那一行只剩一个裸 id。
    const snapshotName = manifest?.source?.templateName
    const templateName = typeof head?.name === 'string'
      ? head.name
      : typeof snapshotName === 'string' && snapshotName.length > 0 ? snapshotName : null
    bindings.set(sessionId, {
      sessionId,
      templateId: typeof templateId === 'string' ? templateId : null,
      templateName,
      enabled: activation === undefined ? true : activation.enabled === true,
      // 「登记为启用」和「此刻真的有注册生效」是两回事：后者还要会话活着、
      // 且上一次物化成功。这一栏直接读进程内句柄表，不靠推断。
      materialized: appliedHandles.has(sessionId),
      // 显式关过才有 updatedAt，从没动过则是 undefined。
      updatedAt: typeof activation?.updatedAt === 'number' ? activation.updatedAt : undefined,
      // 子 Agent 继承父会话时写下 `inheritedFrom`；界面用它区分「自己套的」
      // 和「从父会话继承来的」。
      inheritedFrom: typeof manifest?.inheritedFrom === 'string' ? manifest.inheritedFrom : undefined,
      recipe: manifest?.recipe ?? {},
    })
  }
  return bindings
}

/**
 * 快照要额外带上的模板数据：绑定视图 + 模板列表。
 *
 * 存储不可用时也不能让整个快照失败——会话页拿不到绑定信息只是少一栏开关，
 * 不该连带把插件/工具/提示词三个视图一起拖垮。
 * @param {object} ctx - host 插件上下文。
 * @param {object} state - 模板存储状态。
 * @returns {Promise<object>} `{ bindings, templates }`。
 */
export async function snapshotExtras(ctx, state) {
  try {
    await ensureTemplateStore(ctx, state)
    const bindings = await readTemplateBindings(state)
    const templates = []
    for (const [, head] of templateTable(state, 'templates').entries()) {
      templates.push({ id: head.id, name: head.name, updatedAt: head.updatedAt })
    }
    templates.sort((left, right) => right.updatedAt - left.updatedAt)
    return { bindings: Object.fromEntries(bindings), templates }
  } catch (error) {
    ctx.logger?.warn?.('plugin-console: 读取模板绑定失败，会话页开关不可用：' + String(error))
    return {}
  }
}

/**
 * 列出所有模板，带历史条数。
 * @param {object} state - 模板存储状态。
 * @returns {object[]} 模板列表（按更新时间倒序）。
 */
export function listTemplates(state) {
  const items = []
  const revisions = templateTable(state, 'revisions')
  for (const [, head] of templateTable(state, 'templates').entries()) {
    let revisionCount = 0
    for (const [, value] of revisions.entries()) {
      if (value.templateId === head.id) revisionCount++
    }
    items.push({ ...head, revisionCount })
  }
  items.sort((left, right) => right.updatedAt - left.updatedAt)
  return items
}

/**
 * 新建一个模板头。
 * @param {object} state - 模板存储状态。
 * @param {string} name - 显示名；空白时用「未命名模板」。
 * @returns {Promise<object>} 新建的模板头。
 */
export async function createTemplate(state, name) {
  const now = Date.now()
  const label = typeof name === 'string' && name.trim().length > 0 ? name.trim() : '未命名提示词模板'
  const head = { id: newTemplateId(), name: label, latestRevision: 0, createdAt: now, updatedAt: now }
  await templateTable(state, 'templates').put(head.id, head)
  return head
}

/**
 * 读一个模板头。
 * @param {object} state - 模板存储状态。
 * @param {string} id - 模板 id。
 * @returns {object | undefined} 模板头。
 */
export function getTemplate(state, id) {
  return templateTable(state, 'templates').get(id)
}

/**
 * 读出一个模板的全部历史，按内部序号升序。
 * @param {object} state - 模板存储状态。
 * @param {string} templateId - 模板 id。
 * @returns {object[]} 历史记录。
 */
export function revisionsOf(state, templateId) {
  const out = []
  for (const [, value] of templateTable(state, 'revisions').entries()) {
    if (value.templateId === templateId) out.push(value)
  }
  return out.sort((left, right) => left.revision - right.revision)
}

/**
 * 读出一个模板的最新 recipe。
 *
 * `revision` 是内部序号，这里取最大的那条——界面已不再显示版本号，
 * 但存储里保留历史是为了能查改动轨迹。
 * @param {object} state - 模板存储状态。
 * @param {string} templateId - 模板 id。
 * @returns {object | undefined} `{ revision, recipe }`，没有历史时 undefined。
 */
export function latestRecipe(state, templateId) {
  let latest
  for (const [, value] of templateTable(state, 'revisions').entries()) {
    if (value.templateId !== templateId) continue
    if (latest === undefined || value.revision > latest.revision) latest = value
  }
  if (latest === undefined) return undefined
  return { revision: latest.revision, recipe: latest.recipe }
}

/**
 * 改名：只动 name，不产生新记录。
 * @param {object} state - 模板存储状态。
 * @param {string} id - 模板 id。
 * @param {object} head - 现有模板头。
 * @param {string} name - 新名字（调用方已校验非空）。
 * @returns {Promise<object>} 更新后的模板头。
 */
export async function renameTemplate(state, id, head, name) {
  const renamed = { ...head, name, updatedAt: Date.now() }
  await templateTable(state, 'templates').put(id, renamed)
  return renamed
}

/**
 * 保存一份配方为新版本。
 *
 * `revision` 只是内部历史序号，不再面向用户——界面上不出现「v12」这种东西。
 * 保留历史是为了查到改动轨迹，但用户看到的就是「这个模板现在是什么」。
 * @param {object} state - 模板存储状态。
 * @param {string} id - 模板 id。
 * @param {object} head - 现有模板头。
 * @param {object} recipe - 配方。
 * @returns {Promise<{template: object, revision: object}>} 新头与新版本。
 */
export async function saveRecipe(state, id, head, recipe) {
  const revision = head.latestRevision + 1
  const record = {
    templateId: id,
    revision,
    schemaVersion: 3,
    recipe: recipe !== null && typeof recipe === 'object' ? recipe : {},
    createdAt: Date.now(),
  }
  await templateTable(state, 'revisions').put(id + '#' + revision, record)
  const next = { ...head, latestRevision: revision, updatedAt: record.createdAt }
  await templateTable(state, 'templates').put(id, next)
  return { template: next, revision: record }
}

/**
 * 删除一个模板：只删模板自己的头与历史，不动会话侧的 manifest。
 *
 * manifest 是应用模板时复制成的独立快照——按设计，模板只是模板，删除它不该
 * 改变已应用会话的行为。这些会话仍按自己的 recipe 物化、仍能开关、resume 与
 * 被新建的子 Agent 继承；只是名字退回快照，界面标「模板已删除」。
 *
 * 只删头会留下永远读不到的 revision，所以历史一起清掉。
 * @param {object} state - 模板存储状态。
 * @param {string} id - 模板 id。
 * @returns {Promise<{removedRevisions: number, keptManifests: number}>} 删掉的历史条数与保留的会话绑定数。
 */
export async function deleteTemplate(state, id) {
  const revisions = templateTable(state, 'revisions')
  const manifests = templateTable(state, 'manifests')

  let removedRevisions = 0
  for (const [key, value] of [...revisions.entries()]) {
    if (value.templateId !== id) continue
    await revisions.delete(key)
    removedRevisions++
  }
  // 只统计、不删除：绑定是会话自有的快照。
  let keptManifests = 0
  for (const [, value] of manifests.entries()) {
    if (value?.source?.templateId === id) keptManifests++
  }
  await templateTable(state, 'templates').delete(id)
  return { removedRevisions, keptManifests }
}

/**
 * 写一条 activation。
 * @param {object} state - 模板存储状态。
 * @param {string} sessionId - 会话 id。
 * @param {boolean} enabled - 目标状态。
 * @returns {Promise<object>} 写入的记录。
 */
export async function writeActivation(state, sessionId, enabled) {
  const record = { sessionId, enabled, updatedAt: Date.now() }
  await templateTable(state, 'activations').put(sessionId, record)
  return record
}

/**
 * 读一个会话的 manifest。
 * @param {object} state - 模板存储状态。
 * @param {string} sessionId - 会话 id。
 * @returns {object | undefined} manifest。
 */
export function getManifest(state, sessionId) {
  return templateTable(state, 'manifests').get(sessionId)
}

/**
 * 写一个会话的 manifest。
 * @param {object} state - 模板存储状态。
 * @param {string} sessionId - 会话 id。
 * @param {object} manifest - manifest。
 * @returns {Promise<void>} 写入完成。
 */
export async function putManifest(state, sessionId, manifest) {
  await templateTable(state, 'manifests').put(sessionId, manifest)
}

/**
 * 读一个会话的全部掩码。
 * @param {object} state - 模板存储状态。
 * @param {string} sessionId - 会话 id。
 * @returns {Array<object>} 掩码记录。
 */
export function masksForSession(state, sessionId) {
  const out = []
  for (const [, record] of templateTable(state, 'masks').entries()) {
    if (record?.sessionId === sessionId) out.push(record)
  }
  return out
}

/**
 * 写一条掩码；key 用 sessionId + rowId，天然去重。
 * @param {object} state - 模板存储状态。
 * @param {string} sessionId - 会话 id。
 * @param {string} rowId - 目标行 id。
 * @returns {Promise<object>} 写入的记录。
 */
export async function putMask(state, sessionId, rowId, tools) {
  const record = { sessionId, rowId, tools: Array.isArray(tools) ? tools : [], createdAt: Date.now() }
  await templateTable(state, 'masks').put(sessionId + ':' + rowId, record)
  return record
}

/**
 * 删除一条掩码。
 * @param {object} state - 模板存储状态。
 * @param {string} sessionId - 会话 id。
 * @param {string} rowId - 目标行 id。
 * @returns {Promise<void>} 写入完成。
 */
export function deleteMask(state, sessionId, rowId) {
  return templateTable(state, 'masks').delete(sessionId + ':' + rowId)
}

/**
 * 追加一条控制审计。
 * @param {object} state - 模板存储状态。
 * @param {object} record - 至少含 action/scope/target/before/after/result。
 * @returns {Promise<object>} 写入的记录。
 */
export async function appendOperation(state, record) {
  const id = 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
  const value = { id, time: Date.now(), ...record }
  await templateTable(state, 'operations').put(id, value)
  return value
}

/**
 * 读最近的控制审计。
 * @param {object} state - 模板存储状态。
 * @param {number} [limit] - 最多返回多少条。
 * @returns {Array<object>} 按时间倒序的记录。
 */
export function listOperations(state, limit = 20) {
  return [...templateTable(state, 'operations').entries()]
    .map(([, record]) => record)
    .sort((left, right) => right.time - left.time)
    .slice(0, limit)
}
