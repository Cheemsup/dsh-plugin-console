/**
 * 每会话的启用开关。
 *
 * 设计取自「manifest 不可变，开关独立」：
 *   manifest 记「这个会话该应用哪份 recipe」，是创建时的快照；
 *   activation 记「现在要不要真的应用它」，是频繁变动的开关。
 *
 * 切换语义（GET 查 / POST 切）：
 *   活跃会话关闭 → dispose 当前物化，下一次 assemble 回退到基础组合；
 *   活跃会话开启 → 按 manifest 重新物化；
 *   冷会话       → 只改 activation，等 resume 后由 apply 决定。
 *
 * GET 一次返回全部绑定（会话页要批量渲染开关），POST 只切一个。
 * @module dsh-plugin-console/host/routes/activation
 */

import { jsonError, jsonOk, readJsonBody } from '../http.js'
import { applyRecipeToSession, clearRecipeForSession } from '../templates/materialize.js'
import { getManifest, readTemplateBindings, writeActivation } from '../templates/repository.js'
import { ensureTemplateStore } from '../templates/store.js'

/**
 * @param {object} ctx - host 插件上下文。
 * @param {object} templateState - 模板存储状态。
 * @returns {Function} fetch 处理函数。
 */
export function createActivationRoute(ctx, templateState) {
  return async (request) => {
    await ensureTemplateStore(ctx, templateState)

    if (request.method === 'GET') {
      const bindings = await readTemplateBindings(templateState)
      return jsonOk({ bindings: Object.fromEntries(bindings) })
    }

    const body = await readJsonBody(request)
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
    if (sessionId === undefined) return jsonError(400, 'missing sessionId')
    // enabled 必须是显式布尔值：省略不等于「关」，那会把写错参数变成静默关闭。
    if (typeof body?.enabled !== 'boolean') return jsonError(400, 'enabled 必须是 true 或 false')
    const enabled = body.enabled

    const record = await writeActivation(templateState, sessionId, enabled)

    // 先看这个会话有没有绑定模板——没有的话开关只是个空标记，
    // 不值得去动 agent。仍然写下来，方便用户表达「以后也别应用」。
    const manifest = getManifest(templateState, sessionId)
    if (manifest === undefined) {
      return jsonOk({
        sessionId,
        enabled,
        updatedAt: record.updatedAt,
        applied: false,
        reason: '这个会话没有绑定提示词定制模板，开关已记录但没有可撤销的内容',
      })
    }

    const live = ctx.get('agents')?.get?.(sessionId)
    if (live === undefined) {
      return jsonOk({
        sessionId,
        enabled,
        updatedAt: record.updatedAt,
        applied: false,
        live: false,
        reason: '会话未激活，开关已记录；resume 时按这个状态决定是否应用',
      })
    }

    if (!enabled) {
      const cleared = await clearRecipeForSession(sessionId)
      return jsonOk({
        sessionId,
        enabled,
        updatedAt: record.updatedAt,
        applied: false,
        live: true,
        cleared,
        note: '已撤销注册；当前 step 的请求已冻结，从下一步开始回退到基础组合',
      })
    }

    const presetId = typeof body?.presetId === 'string' ? body.presetId : undefined
    const result = await applyRecipeToSession(ctx, sessionId, manifest.recipe, presetId)
    return jsonOk({
      sessionId,
      enabled,
      updatedAt: record.updatedAt,
      live: true,
      applied: result.applied === true,
      applied0: result.applied0,
      errors: result.errors,
      reason: result.reason,
    })
  }
}
