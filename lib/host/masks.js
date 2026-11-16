/**
 * 会话贡献掩码：把一个插件的工具贡献从**一个会话**里隐藏。
 *
 * 掩码只动工具 deny 名单，不卸载插件、不停服务、不移除事件监听，也不改模板
 * 的提示词覆盖。它和模板共存的方式是「编译成一份 plan 再物化」：
 *   base = 会话自己的 manifest recipe（模板关闭时为 null）
 *   mask = 所有掩码记录里的工具名并集
 *   plan = mergeRecipes(base, mask)
 * 这样同一个 agent scope 只会被物化一次，不会出现同名注册冲突。
 *
 * 掩码记录会持久化；resume / 子 Agent 创建时由 `installMaskInheritance` 重放。
 * @module dsh-plugin-console/host/masks
 */

import { applyRecipeToSession, clearRecipeForSession } from './templates/materialize.js'
import { deleteMask, getManifest, masksForSession, putMask } from './templates/repository.js'
import { ensureTemplateStore, templateTable } from './templates/store.js'

/**
 * 合并模板 recipe 与掩码 recipe。
 *
 * 只合并工具 deny；提示词覆盖保留模板自己的（掩码目前不碰提示词段）。
 * @param {object | null} base - 模板 recipe。
 * @param {object | null} mask - 掩码 recipe。
 * @returns {object} 合并后的 recipe。
 */
export function mergeRecipes(base, mask) {
  const left = base ?? {}
  const right = mask ?? {}
  const disabled = [...new Set([...(left.tools?.disabled ?? []), ...(right.tools?.disabled ?? [])])]
  return {
    ...left,
    prompt: { ...(left.prompt ?? {}), ...(right.prompt ?? {}) },
    tools: { ...(left.tools ?? {}), ...(right.tools ?? {}), disabled },
  }
}

/** 一个会话的全部掩码编译成 recipe；没有掩码时 null。 */
export function buildMaskRecipe(state, sessionId) {
  const masks = masksForSession(state, sessionId)
  if (masks.length === 0) return null
  const tools = [...new Set(masks.flatMap((mask) => Array.isArray(mask.tools) ? mask.tools : []))]
  return tools.length > 0 ? { tools: { disabled: tools } } : null
}

/** 会话的模板 recipe；没有 manifest 或模板显式关闭时为 null。 */
export function baseRecipeForSession(state, sessionId) {
  const manifest = getManifest(state, sessionId)
  if (manifest === undefined) return null
  const activation = templateTable(state, 'activations').get(sessionId)
  if (activation !== undefined && activation.enabled !== true) return null
  return manifest.recipe ?? null
}

/** 取会话的模式：header 优先，注册表兜底。 */
function presetOf(ctx, agent) {
  const header = agent?.session?.header
  if (typeof header?.agentPreset === 'string') return header.agentPreset
  try {
    return ctx.get('agentPresets')?.presetForSession?.(agent?.session) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * 按「模板 + 掩码」重新物化一个会话。
 *
 * 没有活 agent 时不物化，只返回 recorded；resume 时会由监听器重放。
 * @param {object} ctx - host 插件上下文。
 * @param {object} state - 模板存储状态。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<object>} 物化结果。
 */
export async function reapplySessionPlan(ctx, state, sessionId) {
  await ensureTemplateStore(ctx, state)
  const base = baseRecipeForSession(state, sessionId)
  const mask = buildMaskRecipe(state, sessionId)
  if (base === null && mask === null) {
    const cleared = await clearRecipeForSession(sessionId)
    return { applied: false, live: true, cleared, reason: '没有提示词模板也没有掩码' }
  }

  const agent = ctx.get('agents')?.get?.(sessionId)
  if (agent === undefined) {
    return { applied: false, live: false, recorded: true, reason: '会话未激活；掩码已记录，resume 时按它重放' }
  }

  const result = await applyRecipeToSession(ctx, sessionId, mergeRecipes(base, mask), presetOf(ctx, agent))
  return {
    ...result,
    live: true,
    maskTools: mask?.tools?.disabled ?? [],
    baseApplied: base !== null,
  }
}

/**
 * 记录一条掩码并立即重放 plan。
 * @param {object} ctx - host 插件上下文。
 * @param {object} state - 模板存储状态。
 * @param {{sessionId: string, rowId: string, tools: string[]}} input - 目标。
 * @returns {Promise<object>} 记录与物化结果。
 */
export async function addMask(ctx, state, input) {
  await ensureTemplateStore(ctx, state)
  const record = await putMask(state, input.sessionId, input.rowId, input.tools)
  return { record, result: await reapplySessionPlan(ctx, state, input.sessionId) }
}

/**
 * 删除一条掩码并重放剩余 plan。
 * @param {object} ctx - host 插件上下文。
 * @param {object} state - 模板存储状态。
 * @param {{sessionId: string, rowId: string}} input - 目标。
 * @returns {Promise<object>} 删除与物化结果。
 */
export async function removeMask(ctx, state, input) {
  await ensureTemplateStore(ctx, state)
  await deleteMask(state, input.sessionId, input.rowId)
  return { result: await reapplySessionPlan(ctx, state, input.sessionId) }
}

/**
 * 在 agent 创建时重放掩码。
 *
 * 必须排在模板继承之后：模板先把 base 物化，掩码再把它和 mask 合并重物化。
 * 没有掩码时什么都不做，避免每次 resume 都重复注册。
 * @param {object} ctx - host 插件上下文。
 * @param {object} state - 模板存储状态。
 * @returns {void}
 */
export function installMaskInheritance(ctx, state) {
  ctx.on('agent/created', async ({ agent }) => {
    const sessionId = typeof agent?.id === 'string' ? agent.id : agent?.session?.id
    if (typeof sessionId !== 'string') return
    try {
      await ensureTemplateStore(ctx, state)
      if (masksForSession(state, sessionId).length === 0) return
      await reapplySessionPlan(ctx, state, sessionId)
    } catch (error) {
      ctx.logger?.warn?.('plugin-console: 掩码重放失败：' + (error instanceof Error ? error.message : String(error)))
    }
  })
}
