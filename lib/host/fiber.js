/**
 * fiber 层的读取：失败诊断、副作用标签树、agent scope 标识。
 *
 * 这三件事都只依赖 Cordis fiber / ctx 的公开面，不依赖任何 registry，
 * 因此单独成一层，供快照与物化共用。
 * @module dsh-plugin-console/host/fiber
 */

import { DIAGNOSTIC_TIMEOUT_MS } from './constants.js'

/**
 * 读取失败 fiber 的启动诊断，带超时。
 * @param {object} fiber - Cordis fiber。
 * @returns {Promise<string | undefined>} 诊断文本。
 */
export async function readDiagnostic(fiber) {
  if (!fiber || typeof fiber.await !== 'function') return undefined
  try {
    await Promise.race([
      fiber.await().catch((error) => {
        throw error
      }),
      new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('__timeout__')), DIAGNOSTIC_TIMEOUT_MS)
        // 定时器不阻止进程退出
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ])
    return undefined
  } catch (error) {
    if (error instanceof Error && error.message === '__timeout__') return '诊断读取超时'
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * 把一个 fiber 已注册的副作用整理成「它做了什么」的清单。
 *
 * Cordis 给每个 `ctx.effect()` 生成一个带 label 的元数据节点，`ctx.on`、`tools.register`、
 * `ctx.provide` 这些公开 API 都会自己起一个有意义的 label，因此这份清单是框架给的，
 * 不需要猜。子级 effect 会被压平成 `父 → 子` 的形式，便于前端直接展示。
 * @param {object | undefined} fiber - Cordis fiber。
 * @returns {Array<{label: string, children: Array<string>}>} 顶层 effect 及其压平后的子标签。
 */
export function readEffects(fiber) {
  if (fiber === undefined || typeof fiber.getEffects !== 'function') return []
  let metas
  try {
    metas = fiber.getEffects()
  } catch {
    return []
  }
  if (!Array.isArray(metas)) return []

  /** 递归收集一个元数据节点下的全部子标签。 */
  const flatten = (meta) => {
    const out = []
    for (const child of meta?.children ?? []) {
      const label = typeof child?.label === 'string' ? child.label : undefined
      if (label !== undefined && label !== 'anonymous') out.push(label)
      out.push(...flatten(child))
    }
    return out
  }

  return metas
    .map((meta) => (typeof meta?.label === 'string' ? { label: meta.label, children: flatten(meta) } : undefined))
    .filter((effect) => effect !== undefined)
}

/**
 * 从 Agent 上下文里取出它的 scope 标识。
 *
 * `tools.view(scope)` 的 `scope` 参数是 `createScope` 写下的那个 symbol 的**值**，
 * 不是 ctx 本身；直接把 ctx 传进去只会落到全局层。dsh-scope 没有把符号注册到
 * `Symbol.for`，只能按描述找——这是唯一可用的公开路径。
 * @param {object} ctx - 可能带 scope 标签的上下文。
 * @returns {symbol | undefined} scope 标识。
 */
export function scopeKeyOf(ctx) {
  if (ctx === undefined || ctx === null) return undefined
  for (const symbol of Object.getOwnPropertySymbols(ctx)) {
    if (symbol.description === 'dsh.scope') return ctx[symbol]
  }
  return undefined
}
