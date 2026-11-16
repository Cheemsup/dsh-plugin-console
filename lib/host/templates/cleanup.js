/**
 * 模板数据的清理。
 *
 * 两种范围：
 *   - workspace：只清该工作区（含它派生的子 Agent）的 manifest 与 activation，
 *     模板定义和历史保留；
 *   - all：清空四张表并删除存储文件，下一次写入自动重建空单元。
 *
 * 运行中的会话不受影响：这里不碰 `appliedHandles`，已经注册到 agent scope 上的
 * 提示词段与工具限制会保留到会话结束（或 DSH 重启）。这是刻意的——清理的是
 * 持久记录，不是正在运行的那一步。
 * @module dsh-plugin-console/host/templates/cleanup
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { resetTemplateStore, templateTable } from './store.js'

/** 存储文件名；与 storage-json 的 single 布局一致。 */
const UNIT_FILE = 'plugin_console_templates.json'

/**
 * 收集当前宿主认识的所有会话 header。
 *
 * 两路来源：持久化列表（含冷会话）与进程内会话（可能还没进持久化列表）。
 * 都拿不到就只靠工作区自己记录的 sessionIds，派生会话会漏——所以两路都试。
 * @param {object} ctx - host 插件上下文。
 * @returns {Promise<Array<object>>} 去重后的 header 列表。
 */
async function knownHeaders(ctx) {
  const headers = []
  const seen = new Set()
  const add = (header) => {
    if (header === null || typeof header !== 'object') return
    if (typeof header.id !== 'string' || seen.has(header.id)) return
    seen.add(header.id)
    headers.push(header)
  }

  try {
    const persistence = ctx.get('sessionPersistence')
    if (typeof persistence?.list === 'function') {
      for (const snapshot of await persistence.list()) add(snapshot?.header)
    }
  } catch {
    // 读不到持久化列表时继续用进程内会话
  }
  try {
    const sessions = ctx.get('sessions')
    if (typeof sessions?.list === 'function') {
      for (const session of sessions.list()) add(session?.header)
    }
  } catch {
    // 同上
  }
  return headers
}

/**
 * 把一个工作区展开成「它自己的会话 + 所有派生会话」。
 *
 * 子 Agent 不写进 workspaceRegistry 的 sessionIds，所以只看工作区记录会漏掉
 * 继承出来的绑定。这里按 header.parentSession 反复扩展，直到没有新节点。
 * @param {object} ctx - host 插件上下文。
 * @param {string} workspaceId - 工作区 id。
 * @returns {Promise<Set<string> | undefined>} 会话 id 集合；工作区不存在时 undefined。
 */
async function workspaceSessionIds(ctx, workspaceId) {
  let workspaces
  try {
    workspaces = ctx.get('workspaceRegistry')?.list?.() ?? []
  } catch {
    workspaces = []
  }
  const workspace = workspaces.find((candidate) => candidate?.id === workspaceId)
  if (workspace === undefined) return undefined

  const ids = new Set((workspace.sessionIds ?? []).filter((id) => typeof id === 'string'))
  const headers = await knownHeaders(ctx)
  let grew = true
  while (grew) {
    grew = false
    for (const header of headers) {
      if (ids.has(header.id)) continue
      if (typeof header.parentSession === 'string' && ids.has(header.parentSession)) {
        ids.add(header.id)
        grew = true
      }
    }
  }
  return ids
}

/**
 * 清理一个工作区里的模板绑定。
 * @param {object} ctx - host 插件上下文。
 * @param {object} state - 模板存储状态（调用方已 ensure）。
 * @param {string} workspaceId - 工作区 id。
 * @returns {Promise<object | undefined>} 计数；工作区不存在时 undefined。
 */
export async function clearWorkspaceTemplateData(ctx, state, workspaceId) {
  const ids = await workspaceSessionIds(ctx, workspaceId)
  if (ids === undefined) return undefined

  const manifests = templateTable(state, 'manifests')
  const activations = templateTable(state, 'activations')
  const masks = templateTable(state, 'masks')
  const touched = new Set()
  let removedManifests = 0
  let removedActivations = 0
  let removedMasks = 0

  for (const [sessionId] of [...manifests.entries()]) {
    if (!ids.has(sessionId)) continue
    await manifests.delete(sessionId)
    touched.add(sessionId)
    removedManifests++
  }
  for (const [sessionId] of [...activations.entries()]) {
    if (!ids.has(sessionId)) continue
    await activations.delete(sessionId)
    touched.add(sessionId)
    removedActivations++
  }
  for (const [key, record] of [...masks.entries()]) {
    if (typeof record?.sessionId !== 'string' || !ids.has(record.sessionId)) continue
    await masks.delete(key)
    touched.add(record.sessionId)
    removedMasks++
  }

  return {
    sessionCount: ids.size,
    touchedSessions: touched.size,
    removedManifests,
    removedActivations,
    removedMasks,
    keptTemplates: [...templateTable(state, 'templates').entries()].length,
  }
}

/**
 * 清理单个会话的模板绑定。
 *
 * 只动这一条会话：不展开子 Agent，也不碰同一工作区的其他会话。运行中的会话
 * 同样不受影响——清的是持久记录，已注册到 agent scope 的内容保留到会话结束。
 * @param {object} state - 模板存储状态（调用方已 ensure）。
 * @param {string} sessionId - 目标会话 id。
 * @returns {Promise<object>} 各表删除计数。
 */
export async function clearSessionTemplateData(state, sessionId) {
  const manifests = templateTable(state, 'manifests')
  const activations = templateTable(state, 'activations')
  const masks = templateTable(state, 'masks')
  const removedManifests = manifests.get(sessionId) !== undefined ? 1 : 0
  const removedActivations = activations.get(sessionId) !== undefined ? 1 : 0
  await manifests.delete(sessionId)
  await activations.delete(sessionId)

  let removedMasks = 0
  for (const [key, record] of [...masks.entries()]) {
    if (typeof record?.sessionId !== 'string' || record.sessionId !== sessionId) continue
    await masks.delete(key)
    removedMasks++
  }

  return {
    sessionId,
    removedManifests,
    removedActivations,
    removedMasks,
    keptTemplates: [...templateTable(state, 'templates').entries()].length,
  }
}

/**
 * 清空全部模板数据并删除存储文件。
 *
 * 先统计、再关闭域（排空在途写入），最后删文件。关闭后把 state 退回「从未打开」，
 * 下一次访问会重新打开一个空单元；如果文件删除失败，错误会带回去，界面能看见。
 * @param {object} ctx - host 插件上下文。
 * @param {object} state - 模板存储状态（调用方已 ensure）。
 * @returns {Promise<object>} 计数与文件删除结果。
 */
export async function clearAllTemplateData(ctx, state) {
  // 打开失败（坏记录、版本不匹配）时也要能清理：没有可读的表就按 0 计，
  // 直接关域、删文件，让下一次访问从空单元开始。这是坏数据的恢复出口。
  const hasStore = state.domain !== undefined || state.memory !== undefined
  const countOf = (name) => hasStore ? [...templateTable(state, name).entries()].length : 0
  const counts = {
    removedTemplates: countOf('templates'),
    removedRevisions: countOf('revisions'),
    removedManifests: countOf('manifests'),
    removedActivations: countOf('activations'),
    removedMasks: countOf('masks'),
    removedOperations: countOf('operations'),
  }

  if (state.domain !== undefined) await state.domain.close()
  resetTemplateStore(state)

  const home = ctx.get('profileContext')?.home
  if (typeof home !== 'string' || home.length === 0) {
    return { ...counts, fileDeleted: false, fileError: 'profileContext.home 不可用，未能删除存储文件' }
  }

  const path = join(home, 'storages', UNIT_FILE)
  try {
    await rm(path, { force: true })
    return { ...counts, fileDeleted: true, filePath: path }
  } catch (error) {
    return {
      ...counts,
      fileDeleted: false,
      filePath: path,
      fileError: error instanceof Error ? error.message : String(error),
    }
  }
}
