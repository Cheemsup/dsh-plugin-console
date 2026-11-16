/**
 * scope 影响：一个 scope 相对全局工具集的差集。
 *
 * 只回答两组事实：
 *   - 全局有、此 scope 不可见（通常是 restrict 过滤，不承诺「谁遮蔽了谁」）；
 *   - 此 scope 额外可见（模式 / 会话在 scope 上注册的工具）。
 *
 * 同名替换不会让名字从可见集里消失，所以这里不列「覆盖者」；
 * `tools.layers` 是私有结构，公开面拿不到逐层归属。
 *
 * 活会话直接读它自己的 agent scope；没有活会话的模式用
 * `agentPresets.acquireScope(presetId)` 临时建一个预设 scope，读完立刻释放。
 * @module dsh-plugin-console/host/scope-impact
 */

import { readToolView } from './tools.js'

/**
 * 比较两个名字集合，得到「被挡掉」与「额外可见」。
 * @param {string[]} visible - 目标 scope 的可见工具名。
 * @param {string[]} global - 全局视图的可见工具名。
 * @returns {{removed: string[], added: string[]}} 差集。
 */
export function toolImpactOf(visible, global) {
  const inScope = new Set(visible ?? [])
  const inGlobal = new Set(global ?? [])
  return {
    removed: [...inGlobal].filter((name) => !inScope.has(name)),
    added: [...inScope].filter((name) => !inGlobal.has(name)),
  }
}

/**
 * 释放一个 acquireScope 租约。
 * @param {{[Symbol.asyncDispose]?: Function} | undefined} lease - 租约。
 * @returns {Promise<void>} 释放完成。
 */
async function releaseScope(lease) {
  if (lease === undefined || typeof lease[Symbol.asyncDispose] !== 'function') return
  try {
    await lease[Symbol.asyncDispose]()
  } catch {
    // 释放失败不影响已经读到的结果
  }
}

/**
 * 临时建预设 scope，读它的工具可见集，读完释放。
 * @param {object} ctx - host 插件上下文。
 * @param {object | undefined} presets - agentPresets / agentPresetRegistry。
 * @param {string} presetId - 模式 id。
 * @param {string[]} globalTools - 全局可见工具名。
 * @returns {Promise<object>} scope 影响；失败时带 source=error 与原因。
 */
async function readPresetToolImpact(ctx, presets, presetId, globalTools) {
  const base = { kind: 'preset', presetId, removed: [], added: [] }
  if (presets === undefined || typeof presets.acquireScope !== 'function') {
    return { ...base, source: 'unavailable', reason: 'agentPresets.acquireScope 不可用' }
  }

  let lease
  try {
    lease = await presets.acquireScope(presetId)
    const view = readToolView(ctx, lease?.key)
    if (view === undefined) return { ...base, source: 'unavailable', reason: 'tools.view 不可用' }
    return { ...base, source: 'preset', ...toolImpactOf(view.visible, globalTools) }
  } catch (error) {
    return { ...base, source: 'error', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    await releaseScope(lease)
  }
}

/**
 * 给模式与活会话挂上 scope 影响。
 *
 * 活会话挂在自己的条目上（`liveAgents[].scopeImpact`），会话页优先用它；
 * 模式条目（`modes[].scopeImpact`）优先取同模式的第一个活会话，没有活会话时
 * 才临时 acquireScope。这样一次快照最多建几个预设 scope，且全部释放。
 * @param {object} ctx - host 插件上下文。
 * @param {Array<object>} modes - 模式列表（会被就地补 scopeImpact）。
 * @param {Array<object>} liveAgents - 活会话工具快照（会被就地补 scopeImpact）。
 * @param {string[]} globalTools - 全局可见工具名。
 * @returns {Promise<void>} 采集完成。
 */
export async function attachScopeImpacts(ctx, modes, liveAgents, globalTools) {
  for (const agent of liveAgents) {
    agent.scopeImpact = {
      kind: 'session',
      source: 'live',
      presetId: agent.preset,
      sessionId: agent.sessionId,
      ...toolImpactOf(agent.tools, globalTools),
    }
  }

  const presets = ctx.get('agentPresetRegistry') ?? ctx.get('agentPresets')
  for (const mode of modes) {
    // 模式声明本身有诊断时不去建 scope：建出来也读不到完整组合，
    // 还会在宿主里留下一次无意义的挂载尝试。
    if (typeof mode.broken === 'string' && mode.broken.length > 0) {
      mode.scopeImpact = {
        kind: 'preset',
        presetId: mode.id,
        source: 'unavailable',
        removed: [],
        added: [],
        reason: '模式声明有诊断：' + mode.broken,
      }
      continue
    }

    const peers = liveAgents.filter((agent) => agent.preset === mode.id)
    if (peers.length > 0) {
      mode.scopeImpact = {
        ...peers[0].scopeImpact,
        kind: 'preset',
        sessions: peers.map((agent) => agent.sessionId),
      }
      continue
    }

    mode.scopeImpact = await readPresetToolImpact(ctx, presets, mode.id, globalTools)
  }
}
