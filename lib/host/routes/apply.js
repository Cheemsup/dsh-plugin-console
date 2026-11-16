/**
 * 把模板应用到会话。
 *
 * 两种用法：
 *   `{ templateId, sessionId }`                    物化到一个已经活着的会话；
 *   `{ templateId, workspaceId?, cwd?, presetId? }` 先建会话，再在首个 turn 前物化。
 *
 * 后者之所以成立，是因为 agents.create() 在返回前就已经发布了这个 agent
 * （setup 组合完 → announce → create 解决），而 turn 要等 prompt 才开。
 * 所以「建会话后立刻物化」正好落在「首个 turn 之前」这个窗口里。
 * @module dsh-plugin-console/host/routes/apply
 */

import { jsonError, jsonOk, readJsonBody } from '../http.js'
import { applyRecipeToSession } from '../templates/materialize.js'
import { getTemplate, latestRecipe, putManifest } from '../templates/repository.js'
import { ensureTemplateStore } from '../templates/store.js'

/**
 * @param {object} ctx - host 插件上下文。
 * @param {object} templateState - 模板存储状态。
 * @returns {Function} fetch 处理函数。
 */
export function createApplyRoute(ctx, templateState) {
  return async (request) => {
    await ensureTemplateStore(ctx, templateState)
    const body = await readJsonBody(request)
    const templateId = typeof body?.templateId === 'string' ? body.templateId : undefined
    let sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
    if (templateId === undefined) return jsonError(400, 'missing templateId')

    const head = getTemplate(templateState, templateId)
    if (head === undefined) return jsonError(404, 'template not found')
    const latest = latestRecipe(templateState, templateId)
    if (latest === undefined) return jsonError(400, 'template has no revision')

    const presetId = typeof body?.presetId === 'string' ? body.presetId : undefined
    // manifest 是快照，不只是「指向模板的指针」：recipe 与名字都复制一份。
    // 之后模板改名、改版、甚至删除，都不回写已应用的会话。
    const manifest = {
      schemaVersion: 1,
      sessionId: sessionId ?? '',
      source: { templateId, revision: latest.revision, templateName: head.name },
      recipe: latest.recipe,
      createdAt: Date.now(),
    }

    // 没有指名会话时现建一个：这样「模板」才有地方生效。
    let created = false
    if (sessionId === undefined) {
      const controller = ctx.get('sessionController')
      if (controller === undefined || typeof controller.create !== 'function') {
        return jsonError(503, 'sessionController 服务缺席，无法新建会话')
      }
      const result = await controller.create({
        ...(typeof body?.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {}),
        ...(typeof body?.cwd === 'string' ? { cwd: body.cwd } : {}),
        ...(presetId === undefined ? {} : { agentPreset: presetId }),
      })
      sessionId = result?.sessionId
      created = true
      if (typeof sessionId !== 'string') {
        return jsonError(500, '新建会话未返回 sessionId')
      }
      manifest.sessionId = sessionId
    }

    await putManifest(templateState, sessionId, manifest)
    const result = await applyRecipeToSession(ctx, sessionId, manifest.recipe, presetId)
    if (result.applied !== true) {
      return jsonOk({
        applied: false,
        live: false,
        created,
        sessionId,
        reason: result.reason,
        manifest,
      })
    }
    manifest.applied = result.applied0
    manifest.errors = result.errors
    await putManifest(templateState, sessionId, manifest)
    return jsonOk({
      applied: true,
      live: true,
      created,
      sessionId,
      applied0: result.applied0,
      errors: result.errors,
      manifest,
    })
  }
}
