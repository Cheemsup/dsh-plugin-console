/**
 * 首请求预演：POST `{ presetId, workspacePath, permissionPreset, clientTimeZone }`
 * → 一次首请求的完整构造。
 *
 * 用 POST 而不是 GET，因为这是一次「按选择求值」的计算，不是资源读取。
 * 本文件只做参数解析与响应序列化：条件如何解析、装配怎么做，见
 * `host/request-preview.js`。
 * @module dsh-plugin-console/host/routes/preview
 */

import { jsonError, jsonOk, readJsonBody } from '../http.js'
import { requestPreview } from '../request-preview.js'

/** 草稿上限：预演要把它原样放进响应，超长文本会把整页响应撑大。 */
const MAX_DRAFT_LENGTH = 20000

/** 模板 recipe 上限：预演只做投影，但不应成为一条任意大的请求体通道。 */
const MAX_RECIPE_JSON = 512 * 1024

/**
 * 只把非空字符串当作条件；缺省、null、数字一律视为「没有提供」，
 * 由宿主按默认值解析并给出警告。空 body 因此仍然可用。
 * @param {unknown} value - 请求体里的字段。
 * @returns {string | undefined} 条件值。
 */
function conditionText(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * @param {object} ctx - host 插件上下文。
 * @returns {Function} fetch 处理函数。
 */
export function createPreviewRoute(ctx) {
  return async (request) => {
    const body = await readJsonBody(request)
    const draft = conditionText(body?.draft)
    if (draft !== undefined && draft.length > MAX_DRAFT_LENGTH) {
      return jsonError(400, `草稿超过 ${MAX_DRAFT_LENGTH} 个字符`)
    }
    const recipe = body?.recipe
    if (recipe !== undefined && (recipe === null || typeof recipe !== 'object' || Array.isArray(recipe))) {
      return jsonError(400, 'recipe 必须是对象')
    }
    if (recipe !== undefined && JSON.stringify(recipe).length > MAX_RECIPE_JSON) {
      return jsonError(400, `recipe 超过 ${MAX_RECIPE_JSON} 字节`)
    }
    const result = await requestPreview(ctx, {
      presetId: conditionText(body?.presetId),
      workspacePath: conditionText(body?.workspacePath),
      permissionPreset: conditionText(body?.permissionPreset),
      clientTimeZone: conditionText(body?.clientTimeZone),
      draft,
      recipe,
    })
    return jsonOk(result)
  }
}
