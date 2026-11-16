/**
 * 模板列表：GET 列出，POST 新建。
 * @module dsh-plugin-console/host/routes/templates
 */

import { jsonOk, readJsonBody } from '../http.js'
import { createTemplate, listTemplates } from '../templates/repository.js'
import { ensureTemplateStore } from '../templates/store.js'

/**
 * @param {object} ctx - host 插件上下文。
 * @param {object} templateState - 模板存储状态。
 * @returns {Function} fetch 处理函数。
 */
export function createTemplatesRoute(ctx, templateState) {
  return async (request) => {
    await ensureTemplateStore(ctx, templateState)
    if (request.method === 'POST') {
      const body = await readJsonBody(request)
      const template = await createTemplate(templateState, typeof body?.name === 'string' ? body.name : undefined)
      return jsonOk({ template })
    }
    return jsonOk({
      templates: listTemplates(templateState),
      persistent: templateState.domain !== undefined,
    })
  }
}
