/**
 * 影响预览：GET ?id=<rowId>。
 * @module dsh-plugin-console/host/routes/impact
 */

import { jsonError, jsonOk, searchParam } from '../http.js'
import { readImpact } from '../impact.js'

/**
 * @param {object} ctx - host 插件上下文。
 * @returns {Function} fetch 处理函数。
 */
export function createImpactRoute(ctx) {
  return async (request) => {
    const id = searchParam(request, 'id')
    if (id === undefined) return jsonError(400, 'missing id')
    return jsonOk(await readImpact(ctx, id))
  }
}
