/**
 * 模式（Agent 预设）的两份事实：声明组合与运行时实测组合。
 *
 * 模式不是全局 Loader 的一部分，它挂在每个 Agent 自己的隔离 scope 里，所以必须
 * 单独读：`compositionInventory()` 给声明值，`inspectCompositions(agent.ctx)` 给
 * 此刻真正挂载的结果。两者的差额来自禁用行、条件行与仍在等依赖的条目。
 * @module dsh-plugin-console/host/modes
 */

import { FIBER_PHASE } from './constants.js'
import { readScopeTools } from './tools.js'

/**
 * 读取 Agent 预设（模式）的当前组合。
 *
 * 每个 preset 自带一串子插件行，这是「模式」这一层贡献的插件；
 * 和 base/profile 的条目合并后才是会话最终得到的插件集合。
 * @param {object} ctx - host 插件上下文。
 * @param {Map<string, Array<object>>} rowsByModule - 模块名 → 全局行摘要。
 * @returns {Promise<Array<object>>} 预设列表；无 roster 时为空数组。
 */
export async function readModes(ctx, rowsByModule) {
  const presets = ctx.get('agentPresets')
  if (presets === void 0 || typeof presets.compositionInventory !== 'function') return []
  let inventory
  try {
    inventory = await presets.compositionInventory()
  } catch {
    return []
  }
  // `order` 只出现在 preset 的元数据列表里，compositionInventory 不带它。
  // 它不是插件排序，而是模式自己的选择器顺序；读不到就不编造。
  const orderById = new Map()
  try {
    const listed = typeof presets.list === 'function' ? await presets.list() : []
    for (const row of Array.isArray(listed) ? listed : []) {
      if (typeof row?.id === 'string' && typeof row.order === 'number') orderById.set(row.id, row.order)
    }
  } catch {
    // 元数据列表读不到不影响组合本身
  }
  return inventory.map((mode) => ({
    id: mode.id,
    name: typeof mode.name === 'string' ? mode.name : undefined,
    description: typeof mode.description === 'string' ? mode.description : undefined,
    order: orderById.get(mode.id),
    isDefault: Boolean(mode.isDefault),
    broken: typeof mode.broken === 'string' ? mode.broken : undefined,
    rows: (mode.rows ?? []).map((row) => ({
      entryId: typeof row.entryId === 'string' ? row.entryId : null,
      moduleName: row.moduleName,
      // 读 preset 行引用的全局条目：会话追溯链的中间一环
      globalRows: rowsByModule?.get(row.moduleName) ?? [],
      enabled: row.enabled === 'conditional' ? null : row.enabled !== false,
      conditional: row.enabled === 'conditional',
      condition: typeof row.condition === 'string' ? row.condition : undefined,
      phase: row.fiberState === undefined ? null : (FIBER_PHASE[row.fiberState] ?? null),
    })),
  })).sort((left, right) => (left.order ?? Infinity) - (right.order ?? Infinity) || left.id.localeCompare(right.id))
}

/**
 * 读取一个活会话此刻**真正在运行**的模式组合。
 *
 * `inspectCompositions(agentCtx)` 只返回 `state === ACTIVE` 且未被禁用的条目。
 * 因此它给的是实测值而不是声明值；冷会话没有 fiber，取不到，返回 undefined。
 * @param {object} ctx - host 插件上下文。
 * @param {object} agent - 活跃 Agent（`agents.get(sessionId)`）。
 * @returns {{preset: string, modules: Array<string>, leakedServices: string[], tools?: string[]} | undefined} 运行时组合。
 */
export function readRuntimeComposition(ctx, agent) {
  const presets = ctx.get('agentPresets')
  if (presets === undefined || typeof presets.inspectCompositions !== 'function') return undefined
  const agentCtx = agent?.ctx
  if (agentCtx === undefined) return undefined
  let compositions
  try {
    compositions = presets.inspectCompositions(agentCtx)
  } catch {
    return undefined
  }
  const composition = compositions?.[0]
  if (composition === undefined) return undefined
  const view = readScopeTools(ctx, agentCtx)
  return {
    preset: composition.id,
    modules: (composition.modules ?? [])
      .map((module) => module?.moduleName)
      .filter((name) => typeof name === 'string'),
    leakedServices: (composition.leakedServices ?? []).filter((name) => typeof name === 'string'),
    /** 读 agent scope 此刻可用的工具：已算完全局层与 scope 层的遮蔽。 */
    tools: view?.visible,
    /** restrict 之前的已知集；与 visible 的差集才是「被 restrict 过滤」。 */
    knownNames: view?.knownNames,
  }
}
