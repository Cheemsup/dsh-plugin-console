/**
 * 控制审计：GET ?limit=20。
 * @module dsh-plugin-console/host/routes/operations
 */

import { jsonOk, searchParam } from '../http.js'
import { listOperations } from '../templates/repository.js'
import { ensureTemplateStore } from '../templates/store.js'

/**
 * @param {object} ctx - host 插件上下文。
 * @param {object} templateState - 模板存储状态。
 * @returns {Function} fetch 处理函数。
 */
export function createOperationsRoute(ctx, templateState) {
  return async (request) => {
    await ensureTemplateStore(ctx, templateState)
    const raw = Number(searchParam(request, 'limit'))
    const limit = Number.isFinite(raw) ? Math.min(100, Math.max(1, Math.trunc(raw))) : 20
    return jsonOk({ operations: listOperations(templateState, limit) })
  }
}
