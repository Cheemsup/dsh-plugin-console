/**
 * 单模板：GET 详情 + 历史，POST 保存配方或改名，DELETE 连历史一起删。
 * @module dsh-plugin-console/host/routes/template
 */

import { jsonError, jsonOk, readJsonBody, searchParam } from '../http.js'
import {
  deleteTemplate,
  getTemplate,
  renameTemplate,
  revisionsOf,
  saveRecipe,
} from '../templates/repository.js'
import { ensureTemplateStore } from '../templates/store.js'

/**
 * @param {object} ctx - host 插件上下文。
 * @param {object} templateState - 模板存储状态。
 * @returns {Function} fetch 处理函数。
 */
export function createTemplateRoute(ctx, templateState) {
  return async (request) => {
    await ensureTemplateStore(ctx, templateState)
    const id = searchParam(request, 'id')
    if (id === undefined) return jsonError(400, 'missing id')

    if (request.method === 'DELETE') {
      const head = getTemplate(templateState, id)
      if (head === undefined) return jsonError(404, 'template not found')
      const removed = await deleteTemplate(templateState, id)
      return jsonOk({ deleted: id, ...removed })
    }

    if (request.method === 'POST') {
      const body = await readJsonBody(request)
      const head = getTemplate(templateState, id)
      if (head === undefined) return jsonError(404, 'template not found')

      // 改名：只动 name，不产生新记录。
      if (typeof body?.name === 'string') {
        const name = body.name.trim()
        if (name.length === 0) return jsonError(400, '提示词模板名称不能为空')
        return jsonOk({ template: await renameTemplate(templateState, id, head, name) })
      }

      // 保存配方：覆盖当前内容。
      return jsonOk(await saveRecipe(templateState, id, head, body?.recipe))
    }

    const head = getTemplate(templateState, id)
    if (head === undefined) return jsonError(404, 'template not found')
    return jsonOk({ template: head, revisions: revisionsOf(templateState, id) })
  }
}
