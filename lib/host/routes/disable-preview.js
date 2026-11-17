/**
 * 禁用效果预演：GET ?id=<rowId|entryId>。
 * @module dsh-plugin-console/host/routes/disable-preview
 */

import { readDisablePreview } from '../disable-preview.js'
import { jsonError, jsonOk, searchParam } from '../http.js'

/**
 * @param {object} ctx - host 插件上下文。
 * @returns {Function} fetch 处理函数。
 */
export function createDisablePreviewRoute(ctx) {
  return async (request) => {
    const id = searchParam(request, 'id')
    if (id === undefined) return jsonError(400, 'missing id')
    return jsonOk(await readDisablePreview(ctx, id))
  }
}
