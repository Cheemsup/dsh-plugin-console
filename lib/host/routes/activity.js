/**
 * 工具活动：GET ?days=7&limit=20。
 *
 * 与 session-influence 一样，读日志的成本随会话数增长，所以单独一条路由、
 * 带时间窗与会话上限；不可读时返回 200 + `{available:false, reason}`。
 * @module dsh-plugin-console/host/routes/activity
 */

import { readActivity } from '../activity.js'
import { jsonOk, searchParam } from '../http.js'

/**
 * @param {object} ctx - host 插件上下文。
 * @returns {Function} fetch 处理函数。
 */
export function createActivityRoute(ctx) {
  return async (request) => {
    const days = searchParam(request, 'days')
    const limit = searchParam(request, 'limit')
    return jsonOk(await readActivity(ctx, { days, limit }))
  }
}
