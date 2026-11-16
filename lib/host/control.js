/**
 * 插件控制：全局启停（委托 pluginManager）与会话工具掩码。
 *
 * 两条边界：
 *   - 全局变更只调用 `pluginManager.setPluginEnabled`，不自己写 cordis.patch.yml；
 *   - 会话掩码只动工具 deny 名单，不卸载插件、不停服务、不移除监听器。
 *
 * 所有动作都要 `confirmed: true`——调用方必须先看过影响预览。每次动作写一条
 * 审计记录，失败也写，审计写入失败不改变已经发生的动作。
 * @module dsh-plugin-console/host/control
 */

import { readSnapshot } from './snapshot.js'
import { addMask, removeMask } from './masks.js'
import { appendOperation } from './templates/repository.js'
import { ensureTemplateStore } from './templates/store.js'

/** 在快照里找目标条目：rowId 优先，其次 entryId。 */
function findEntry(snapshot, rowId) {
  return (snapshot?.entries ?? []).find((entry) => entry.rowId === rowId)
    ?? (snapshot?.entries ?? []).find((entry) => entry.entryId === rowId)
}

/** 一条审计的结果文本。 */
function resultText(result) {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

/** 写审计；失败不改变已经发生的控制动作。 */
async function record(ctx, state, facts) {
  try {
    await ensureTemplateStore(ctx, state)
    return await appendOperation(state, facts)
  } catch (error) {
    ctx.logger?.warn?.('plugin-console: 控制审计写入失败：' + (error instanceof Error ? error.message : String(error)))
    return undefined
  }
}

/**
 * 执行一次控制。
 * @param {object} ctx - host 插件上下文。
 * @param {object} state - 模板存储状态。
 * @param {object} input - `{ action, rowId, sessionId?, confirmed? }`。
 * @returns {Promise<object>} `{ ok, ... }`；拒绝时 `ok:false` 并带原因。
 */
export async function controlPlugin(ctx, state, input = {}) {
  const action = typeof input.action === 'string' ? input.action : undefined
  const rowId = typeof input.rowId === 'string' ? input.rowId : undefined
  if (action === undefined) return { ok: false, reason: '缺少 action' }
  if (rowId === undefined) return { ok: false, reason: '缺少 rowId' }
  if (input.confirmed !== true) return { ok: false, reason: '需要先确认影响预览' }

  const snapshot = await readSnapshot(ctx, {})
  const entry = findEntry(snapshot, rowId)
  if (entry === undefined) return { ok: false, reason: '找不到这个插件条目' }

  if (action === 'enable' || action === 'disable') {
    if (entry.rowId === 'plugin-console' || entry.moduleName === 'dsh-plugin-console') {
      return { ok: false, reason: '不能在这里关闭插件控制台自身' }
    }
    const pluginManager = ctx.get('pluginManager')
    if (pluginManager === undefined || typeof pluginManager.setPluginEnabled !== 'function') {
      return { ok: false, reason: '这个部署没有 pluginManager，无法做全局启停' }
    }

    let target
    try {
      const listed = await pluginManager.listPlugins()
      target = listed.find((item) => item.entryId === entry.entryId)
        ?? listed.find((item) => item.moduleName === entry.moduleName)
    } catch (error) {
      return { ok: false, reason: '读取 pluginManager 列表失败：' + (error instanceof Error ? error.message : String(error)) }
    }
    if (target === undefined) return { ok: false, reason: 'pluginManager 不认识这个条目' }
    if (target.readOnlyReason === 'management-required') {
      return { ok: false, reason: '这是管理插件自身，不能通过 profile patch 启停' }
    }
    if (target.readOnlyReason === 'unaddressable') {
      return { ok: false, reason: '这一行没有唯一可寻址的 profile patch，无法启停' }
    }

    const enabled = action === 'enable'
    let result
    try {
      result = await pluginManager.setPluginEnabled(target.entryId, enabled)
    } catch (error) {
      return { ok: false, reason: '启停失败：' + (error instanceof Error ? error.message : String(error)) }
    }
    const operation = await record(ctx, state, {
      action,
      scope: 'profile',
      target: target.entryId,
      before: { enabled: entry.enabled === true },
      after: { enabled },
      result: resultText(result ?? 'ok'),
    })
    return {
      ok: true,
      action,
      entryId: target.entryId,
      enabled,
      result,
      restartRequired: result === 'restart-required' || result?.restartRequired === true,
      operation,
    }
  }

  if (action === 'mask' || action === 'unmask') {
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined
    if (sessionId === undefined) return { ok: false, reason: '会话掩码需要 sessionId' }

    if (action === 'unmask') {
      const { result } = await removeMask(ctx, state, { sessionId, rowId: entry.rowId })
      const operation = await record(ctx, state, {
        action,
        scope: 'session',
        target: entry.rowId,
        before: { sessionId },
        after: { sessionId },
        result: result?.applied === true ? 'applied' : 'recorded',
      })
      return { ok: true, action, sessionId, rowId: entry.rowId, result, operation }
    }

    const tools = entry.registrations?.tools ?? []
    if (tools.length === 0) {
      return { ok: false, reason: '这个插件没有工具型贡献，暂不支持会话掩码' }
    }
    const shared = tools.filter((name) => {
      const tool = (snapshot.tools?.attributed ?? []).find((candidate) => candidate.name === name)
      return (tool?.owners ?? []).length > 1
    })
    if (shared.length > 0) {
      return {
        ok: false,
        reason: '这些工具与其他插件重名，按名字 deny 会连带隐藏对方的同名工具：' + shared.join('、'),
      }
    }

    const { record: mask, result } = await addMask(ctx, state, { sessionId, rowId: entry.rowId, tools })
    const operation = await record(ctx, state, {
      action,
      scope: 'session',
      target: entry.rowId,
      before: { sessionId, visibleTools: tools },
      after: { sessionId, maskedTools: tools },
      result: result?.applied === true ? 'applied' : 'recorded',
    })
    return { ok: true, action, sessionId, rowId: entry.rowId, mask, result, operation }
  }

  return { ok: false, reason: '未知动作：' + action }
}
