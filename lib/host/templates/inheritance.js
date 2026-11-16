/**
 * 子 Agent 的模板继承。
 *
 * DSH 创建子 Agent 时只复制模式组合（provider / model / preset）与工具注册，
 * 不会复制父会话在运行时注册的提示词段——模板物化出来的段是运行时注册，
 * 因此子会话默认看不到它。
 *
 * 这里监听 `agent/created`，在子 Agent 的首个 turn 之前补做物化：
 *   - 会话自己有 manifest（resume / startup / clear）→ 按它重放；
 *   - 自己没有，但 header.parentSession 指向的父会话有 manifest → 复制一份
 *     父会话的 recipe（保持快照语义），写成自己的 manifest 再物化。
 *
 * 监听器不能抛错：`agent/created` 是串行生命周期，一个监听器 reject 会让
 * 整个 agent 创建失败。所有失败只记日志。
 * @module dsh-plugin-console/host/templates/inheritance
 */

import { applyRecipeToSession } from './materialize.js'
import { getManifest, putManifest } from './repository.js'
import { ensureTemplateStore, templateTable } from './store.js'

/**
 * 会话当前是否启用。
 *
 * 没有 activation 记录 = 启用，所以「关」必须是显式写下的 `enabled: false`。
 * @param {object} state - 模板存储状态。
 * @param {string} sessionId - 会话 id。
 * @returns {boolean} 是否启用。
 */
function isEnabled(state, sessionId) {
  const record = templateTable(state, 'activations').get(sessionId)
  return record === undefined ? true : record.enabled === true
}

/**
 * 取一个会话自己的模式。
 *
 * header 是持久化真源（冷会话只看 header）；`agentPresets` 只做兜底，
 * 缺失时返回 undefined，让预览退回默认模式。
 * @param {object} ctx - host 插件上下文。
 * @param {object} session - 会话对象。
 * @returns {string | undefined} 模式 id。
 */
function presetOf(ctx, session) {
  const header = session?.header
  if (typeof header?.agentPreset === 'string') return header.agentPreset
  try {
    return ctx.get('agentPresets')?.presetForSession?.(session) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * 为一个刚创建的 agent 决定是否套模板，并在需要时物化。
 *
 * 规则：
 *   1. 自己有 manifest → 按自己的重放（resume / clear 走这条）；
 *   2. 自己没有、header.parentSession 有 manifest → 继承父会话的 recipe；
 *   3. 任一方显式关闭（activation.enabled === false）→ 不套。
 *
 * 子会话继承时会写一份自己的 manifest，并带 `inheritedFrom`。这样：
 *   - 会话页能显示它确实绑了模板，也能单独关掉；
 *   - 父模板之后改版不影响已经创建的子会话（manifest 仍是快照）；
 *   - resume 时按这份 manifest 重新物化，不必再找父会话。
 * @param {object} ctx - host 插件上下文。
 * @param {object} state - 模板存储状态。
 * @param {object} agent - 刚创建的 agent。
 * @returns {Promise<object>} 处理结果（`applied` / `inherited` / `reason`）。
 */
export async function inheritTemplateForAgent(ctx, state, agent) {
  const sessionId = typeof agent?.id === 'string' ? agent.id : agent?.session?.id
  const header = agent?.session?.header
  if (typeof sessionId !== 'string' || header === undefined || header === null) {
    return { applied: false, reason: 'no-session' }
  }

  await ensureTemplateStore(ctx, state)

  const own = getManifest(state, sessionId)
  if (own !== undefined) {
    if (!isEnabled(state, sessionId)) return { applied: false, reason: 'activation-disabled' }
    const result = await applyRecipeToSession(ctx, sessionId, own.recipe, presetOf(ctx, agent.session))
    return { applied: result.applied === true, inherited: false, result }
  }

  const parentId = typeof header.parentSession === 'string' ? header.parentSession : undefined
  if (parentId === undefined) return { applied: false, reason: 'no-parent' }
  // 子会话自己显式关过：不继承。这是「子自己被关过时以子为准」的落点。
  if (!isEnabled(state, sessionId)) return { applied: false, reason: 'activation-disabled' }

  const parent = getManifest(state, parentId)
  if (parent === undefined) return { applied: false, reason: 'parent-unbound' }
  // 父会话关掉了模板，子树也不该继承它。
  if (!isEnabled(state, parentId)) return { applied: false, reason: 'parent-disabled' }
  if (typeof parent.source?.templateId !== 'string' || parent.recipe === null || typeof parent.recipe !== 'object') {
    return { applied: false, reason: 'parent-manifest-incomplete' }
  }

  const manifest = {
    schemaVersion: 1,
    sessionId,
    source: {
      templateId: parent.source.templateId,
      revision: parent.source.revision,
      // 名字也随快照复制：父模板之后改名或删除，子会话仍显示应用时的名字。
      ...(typeof parent.source.templateName === 'string' ? { templateName: parent.source.templateName } : {}),
    },
    recipe: parent.recipe,
    createdAt: Date.now(),
    inheritedFrom: parentId,
  }
  // 先落 manifest：即使这一次物化失败，会话页也能看出它「登记为继承」，
  // resume 时还会按它再试一次。
  await putManifest(state, sessionId, manifest)

  const result = await applyRecipeToSession(ctx, sessionId, manifest.recipe, presetOf(ctx, agent.session))
  if (result.applied === true) {
    manifest.applied = result.applied0
    manifest.errors = result.errors
    await putManifest(state, sessionId, manifest)
  }
  return { applied: result.applied === true, inherited: true, result, manifest }
}

/**
 * 安装模板继承监听。
 *
 * 不需要 connection——`agent/created` 来自 agent 注册表，插件加载时就能挂上。
 * @param {object} ctx - host 插件上下文。
 * @param {object} state - 模板存储状态。
 * @returns {void}
 */
export function installTemplateInheritance(ctx, state) {
  ctx.on('agent/created', async ({ agent }) => {
    try {
      await inheritTemplateForAgent(ctx, state, agent)
    } catch (error) {
      ctx.logger?.warn?.(
        'plugin-console: 模板继承失败：' + (error instanceof Error ? error.message : String(error)),
      )
    }
  })
}
