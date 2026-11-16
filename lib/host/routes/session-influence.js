/**
 * 单会话的实际请求摘要：GET ?id=<sessionId>。
 *
 * 单独一条路由而不是塞进快照：要把日志读全，成本随会话长度增长；只有用户
 * 展开某个会话时才值得付。不可读时仍返回 200 + `{available:false, reason}`，
 * 让界面区分「没有数据」和「请求失败」。
 * @module dsh-plugin-console/host/routes/session-influence
 */

import { jsonError, jsonOk, searchParam } from '../http.js'
import { readSessionInfluence } from '../session-influence.js'

/**
 * @param {object} ctx - host 插件上下文。
 * @returns {Function} fetch 处理函数。
 */
export function createSessionInfluenceRoute(ctx) {
  return async (request) => {
    const id = searchParam(request, 'id')
    if (id === undefined) return jsonError(400, 'missing id')
    return jsonOk(await readSessionInfluence(ctx, id))
  }
}
