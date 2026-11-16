/**
 * 清理模板数据。
 *
 * POST `{ scope: 'session', sessionId }`      → 只清该会话的绑定与开关；
 * POST `{ scope: 'workspace', workspaceId }` → 只清该工作区的绑定与开关；
 * POST `{ scope: 'all' }`                      → 清空全部并删除存储文件。
 *
 * 三种范围都不撤销正在运行的会话：清理的是持久记录，运行时注册保留到会话结束。
 * @module dsh-plugin-console/host/routes/cleanup
 */

import { jsonError, jsonOk, readJsonBody } from '../http.js'
import { clearAllTemplateData, clearSessionTemplateData, clearWorkspaceTemplateData } from '../templates/cleanup.js'
import { ensureTemplateStore } from '../templates/store.js'

/**
 * @param {object} ctx - host 插件上下文。
 * @param {object} templateState - 模板存储状态。
 * @returns {Function} fetch 处理函数。
 */
export function createCleanupRoute(ctx, templateState) {
  return async (request) => {
    const body = await readJsonBody(request)
    const scope = body?.scope

    if (scope === 'session') {
      await ensureTemplateStore(ctx, templateState)
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
      if (sessionId === undefined) return jsonError(400, 'missing sessionId')
      const result = await clearSessionTemplateData(templateState, sessionId)
      return jsonOk({ scope, ...result, liveSessionsUntouched: true })
    }

    if (scope === 'workspace') {
      await ensureTemplateStore(ctx, templateState)
      const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : undefined
      if (workspaceId === undefined) return jsonError(400, 'missing workspaceId')
      const result = await clearWorkspaceTemplateData(ctx, templateState, workspaceId)
      if (result === undefined) return jsonError(404, 'workspace not found')
      return jsonOk({ scope, workspaceId, ...result, liveSessionsUntouched: true })
    }

    if (scope === 'all') {
      // 打开失败也要能清：坏记录不该把「删除存储文件」这个恢复出口一起挡住。
      let storeError
      try {
        await ensureTemplateStore(ctx, templateState)
      } catch (error) {
        storeError = error instanceof Error ? error.message : String(error)
      }
      const result = await clearAllTemplateData(ctx, templateState)
      return jsonOk({
        scope,
        ...result,
        ...(storeError === undefined ? {} : { storeError }),
        liveSessionsUntouched: true,
      })
    }

    return jsonError(400, 'scope must be "session", "workspace" or "all"')
  }
}
