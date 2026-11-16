/**
 * 工具注册表的读取：可见集与完整 schema。
 *
 * `tools.view(scope)` 已经把「全局层 → 祖先 scope → 本 scope」的遮蔽算完，
 * 因此这里拿到的是真正能调用的工具名，而不是某一次注册的内容。
 * @module dsh-plugin-console/host/tools
 */

import { scopeKeyOf } from './fiber.js'

/**
 * 把一个注册表视图的键集合读成字符串数组。
 *
 * `visible` 是 Map、`knownNames` 是 Set；测试里也可能给普通数组。
 * 三种都接受，避免调用方为形状差异写分支。
 * @param {Map<string, unknown> | Set<string> | Array<string> | undefined} table - 名字集合。
 * @returns {string[]} 名字（保持注册顺序）。
 */
function namesOf(table) {
  if (table === undefined || table === null) return []
  if (Array.isArray(table)) return table.filter((name) => typeof name === 'string')
  if (typeof table.keys === 'function') return [...table.keys()].filter((name) => typeof name === 'string')
  return []
}

/**
 * 读取一个 scope 的完整工具视图：restrict 之后的可见集，以及 restrict 之前的已知集。
 *
 * 两者之差才是「被 restrict 过滤」；不能用「全局可见 − 会话可见」代替——
 * 同名替换不会让名字消失，那样算出来的差额会把它误报成遮蔽。
 * @param {object} ctx - host 插件上下文。
 * @param {symbol | string | undefined} scopeKey - `tools.view` 接受的 scope 标识。
 * @returns {{visible: string[], knownNames?: string[]} | undefined} 视图；工具服务缺席时 undefined。
 */
export function readToolView(ctx, scopeKey) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.view !== 'function') return undefined
  try {
    const view = tools.view(scopeKey)
    if (view === undefined || view === null) return undefined
    return {
      visible: namesOf(view.visible),
      // 老版本宿主可能没有 knownNames；保留 undefined 让调用方退回旧口径，
      // 而不是把「读不到」当成「一个名字都没有」。
      knownNames: view.knownNames === undefined ? undefined : namesOf(view.knownNames),
    }
  } catch {
    return undefined
  }
}

/**
 * 读取一个 scope 此刻可见的工具集合。
 * @param {object} ctx - host 插件上下文。
 * @param {object | undefined} scope - Agent 的 ctx；省略表示全局视图。
 * @returns {string[] | undefined} 可见工具名（按注册顺序），工具服务缺席时返回 undefined。
 */
export function readVisibleTools(ctx, scope) {
  // tools.view(scope) 的 scope 参数是 `createScope` 写下的那个 symbol，
  // 不是 ctx 本身。传 ctx 进去只会拿到全局层（peek 落到 undefined）。
  // dsh-scope 没有把符号名注册到 Symbol.for，只能按描述找。
  return readToolView(ctx, scopeKeyOf(scope))?.visible
}

/**
 * 读取一个 scope 的 `visible` 与 `knownNames`（Agent ctx 版本）。
 * @param {object} ctx - host 插件上下文。
 * @param {object | undefined} scope - Agent 的 ctx；省略表示全局视图。
 * @returns {{visible: string[], knownNames?: string[]} | undefined} 视图。
 */
export function readScopeTools(ctx, scope) {
  return readToolView(ctx, scopeKeyOf(scope))
}

/**
 * 读取某个 scope 的全部工具 schema；省略 scopeKey 表示全局层。
 *
 * `tools.schemas()` 是模型声明用的投影（去掉 execute / render 等回调，只留
 * name / description / parameters）。预演要把「全局定义」与「preset scope 定义」
 * 分开比对，所以把 scope 做成参数；`readScopedSchemas` 只是它的 agent ctx 版本。
 * @param {object} ctx - host 插件上下文。
 * @param {symbol | string | undefined} [scopeKey] - scope 标识；省略表示全局。
 * @returns {Array<object>} 工具 schema 列表；服务缺席或读取失败时为空数组。
 */
export function readToolSchemas(ctx, scopeKey) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.schemas !== 'function') return []
  try {
    const rows = scopeKey === undefined ? tools.schemas() : tools.schemas(scopeKey)
    return (rows ?? []).filter((schema) => typeof schema?.name === 'string')
  } catch {
    return []
  }
}

/**
 * 读取某个 agent scope 下所有工具的完整 schema。
 *
 * `systemPrompt.assemble()` 不带 scope，因此只覆盖全局工具；模式在 agent scope
 * 里注册的那些（read / grep / schedule_create …）不在其中，需要单独从这里取。
 * @param {object} ctx - host 插件上下文。
 * @param {object} agentCtx - Agent 的上下文。
 * @returns {Array<object>} 工具 schema 列表；不可用时为空数组。
 */
export function readScopedSchemas(ctx, agentCtx) {
  const scopeKey = scopeKeyOf(agentCtx)
  if (scopeKey === undefined) return []
  return readToolSchemas(ctx, scopeKey)
}

/**
 * 读出某个 scope 下「可以被 restrict 提交」的工具名。
 *
 * `restrict({deny})` 对「当前 scope 不知道的全局工具名」直接抛错，一个不认识
 * 就整批失效；所以提交前先取这份名单做过滤。
 * @param {object} agentCtx - 带 scope 的上下文。
 * @returns {Set<string> | undefined} 可禁用的名字；读不到时 undefined。
 */
export function readRestrictableNames(agentCtx) {
  const tools = agentCtx?.get?.('tools')
  const scope = scopeKeyOf(agentCtx)
  if (scope === undefined || tools === undefined || typeof tools.view !== 'function') return undefined
  try {
    const known = tools.view(scope)?.restrictableNames
    return known instanceof Set ? known : undefined
  } catch {
    return undefined
  }
}
