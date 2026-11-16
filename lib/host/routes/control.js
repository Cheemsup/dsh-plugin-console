/**
 * 控制：POST `{ action, rowId, sessionId?, confirmed }`。
 * @module dsh-plugin-console/host/routes/control
 */

import { controlPlugin } from '../control.js'
import { jsonError, jsonOk, readJsonBody } from '../http.js'

/**
 * @param {object} ctx - host 插件上下文。
 * @param {object} templateState - 模板存储状态。
 * @returns {Function} fetch 处理函数。
 */
export function createControlRoute(ctx, templateState) {
  return async (request) => {
    const body = await readJsonBody(request)
    if (typeof body?.action !== 'string') return jsonError(400, 'missing action')
    if (typeof body?.rowId !== 'string') return jsonError(400, 'missing rowId')
    const result = await controlPlugin(ctx, templateState, body)
    return jsonOk(result)
  }
}
