/**
 * 把一份 recipe 物化到 agent 的 scope 上，并保证它能被撤销。
 *
 * 三个作用点里只用了两个：注册期（scoped section + restrict）。装配期 waterfall
 * 留给下一阶段——先保证「注册的东西能撤销」这条底线。
 *
 * 撤销顺序在这里是有意义的：必须先把旧句柄 await 掉再注册新的，因为同一个
 * scope 里同名段落不允许重复注册，而 Cordis 的 effect 撤销是异步的。
 * @module dsh-plugin-console/host/templates/materialize
 */

import { completeSectionOf } from '../prompt.js'
import { scopeKeyOf } from '../fiber.js'
import { readRestrictableNames } from '../tools.js'
import { previewAssembly } from '../assembly-preview.js'
import { hasMessageOverrides, overlayStepMessages } from './message-overlay.js'

/**
 * 已物化的句柄，按会话记。
 *
 * 必须挂在进程级而不是插件级：物化的注册本身写在 agent 的 scope 上，
 * 插件被重新加载时那些注册还活着，而模块内的 Map 会被清空。清空之后就
 * 找不到上一次的句柄去撤销，同一个 scope 里再注册同名段落必然失败。
 */
const APPLIED_KEY = Symbol.for('dsh-plugin-console.applied')
export const appliedHandles = globalThis[APPLIED_KEY] ?? (globalThis[APPLIED_KEY] = new Map())

/**
 * 追加段落的名字与位置。
 *
 * 必须排在 DSH 已知段顺序之后：`deployment:persona-suffix` 是 10200，
 * 所以用 20000，确保「追加」真的是整份提示词的最后一段。
 */
const APPEND_SECTION = 'template:extra'
const APPEND_ORDER = 20000

/**
 * agent scope 链上的 context 注册表。
 *
 * 覆盖 runtime-context 的干净落点是 scoped 同名 context：注册时沿用原来的 order /
 * required，`interpolate:false` 直接使用 recipe 里已经渲染好的文字。
 * @param {object} agent - 目标 agent。
 * @returns {Map<string, object> | undefined} name → 注册项。
 */
function contextRegistrationsOf(agent) {
  const layers = agent?.ctx?.systemPrompt?.layers
  if (layers === undefined || typeof layers.merge !== 'function') return undefined
  try {
    return new Map(layers.merge(scopeKeyOf(agent.ctx), (layer) => layer.contexts))
  } catch {
    return undefined
  }
}

/** recipe 里真正配了覆盖的消息类型；用于 `applied` 与监听器安装判定。 */
function configuredMessageKinds(recipe) {
  const messages = recipe?.messages
  if (messages === null || typeof messages !== 'object') return []
  return ['agent-instructions', 'skill-catalog', 'time-context'].filter((kind) => {
    const spec = messages[kind]
    if (spec === null || typeof spec !== 'object') return false
    if (spec.hidden === true || typeof spec.text === 'string') return true
    return Array.isArray(spec.hiddenEntries) || (spec.descriptions !== null && typeof spec.descriptions === 'object')
  })
}

/**
 * 把一个模板 recipe 应用到 agent 上。
 * @param {object} agent - 目标 agent。
 * @param {object} recipe - 配方。
 * @param {Map<string, number>} sectionOrder - 同名覆盖沿用的 order。
 * @returns {{applied: object, errors: string[], dispose: Function}} 物化句柄。
 */
export function materializeRecipe(agent, recipe, sectionOrder) {
  const disposers = []
  const prompt = recipe?.prompt ?? {}
  const applied = {
    sections: [],
    overrides: [],
    deniedTools: [],
    skippedTools: [],
    foldedAppend: null,
    contextOverrides: [],
    skippedContexts: [],
    suppressedRuntimeContext: false,
    messageKinds: [],
  }
  const errors = []
  // 这个 agent 所在模式是不是「独占型」提示词。是的话，同名覆盖要带上 complete，
  // 追加段落也只能并进那一段——见函数体里的两处注释。
  const completeName = completeSectionOf(agent.ctx, scopeKeyOf)
  applied.completeSection = completeName ?? null

  /** 覆盖某一段。`complete` 只在它本来就是独占段时传。 */
  const overrideSection = (name, text) => {
    const section = {
      name,
      order: sectionOrder.get(name) ?? APPEND_ORDER,
      text: () => text,
      interpolate: false,
    }
    if (name === completeName) section.complete = true
    disposers.push(agent.ctx.systemPrompt.section(section))
    applied.overrides.push(name)
  }

  // 追加段落：独占型提示词下追加段落无处安放——独占段会把别的段全丢弃，所以
  // 只能并进那一段。并进去要基于它当前的文本，而这里只有 recipe（存的是差异），
  // 因此这件事由客户端在算 recipe 时折进去；host 这边只记录发生了什么。
  if (typeof prompt.appendText === 'string' && prompt.appendText.length > 0) {
    if (completeName !== undefined) {
      applied.foldedAppend = completeName
    } else {
      try {
        disposers.push(agent.ctx.systemPrompt.section({
          name: APPEND_SECTION,
          order: APPEND_ORDER,
          text: () => prompt.appendText,
          interpolate: false,
        }))
        applied.sections.push(APPEND_SECTION)
      } catch (error) {
        errors.push('追加段落失败：' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }

  // 同名覆盖：空字符串 = 隐藏该段
  for (const [name, text] of Object.entries(prompt.sectionOverrides ?? {})) {
    if (typeof text !== 'string') continue
    try {
      overrideSection(name, text)
    } catch (error) {
      errors.push('改写 ' + name + ' 失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  // runtime-context 逐段覆盖：scoped 同名 context 会遮蔽外层注册。
  // 名字在当前 agent scope 里不存在时不凭空新增——那会把「本没有这一段」变成「有」。
  const contextTexts = recipe?.contexts
  if (contextTexts !== null && typeof contextTexts === 'object') {
    const entries = Object.entries(contextTexts).filter(([, text]) => typeof text === 'string')
    if (entries.length > 0 && typeof agent.ctx.systemPrompt?.context !== 'function') {
      errors.push('systemPrompt.context 不可用，runtime-context 覆盖未安装')
    } else if (entries.length > 0) {
      const registry = contextRegistrationsOf(agent)
      for (const [name, text] of entries) {
        const entry = registry?.get(name)
        if (entry === undefined) {
          applied.skippedContexts.push(name)
          continue
        }
        const order = typeof entry.order === 'number'
          ? entry.order
          : agent.ctx.systemPrompt.getContextOrder?.(name)
        if (!Number.isFinite(order)) {
          applied.skippedContexts.push(name)
          continue
        }
        try {
          disposers.push(agent.ctx.systemPrompt.context({
            name,
            order,
            ...(entry.required === true ? { required: true } : {}),
            text: () => text,
            interpolate: false,
          }))
          applied.contextOverrides.push(name)
        } catch (error) {
          applied.skippedContexts.push(name)
          errors.push('改写上下文 ' + name + ' 失败：' + (error instanceof Error ? error.message : String(error)))
        }
      }
    }
  }

  if (recipe?.messages?.['runtime-context']?.hidden === true) {
    if (typeof agent.ctx.systemPrompt?.suppressRuntimeContext === 'function') {
      try {
        disposers.push(agent.ctx.systemPrompt.suppressRuntimeContext())
        applied.suppressedRuntimeContext = true
      } catch (error) {
        errors.push('隐藏 runtime-context 失败：' + (error instanceof Error ? error.message : String(error)))
      }
    } else {
      errors.push('systemPrompt.suppressRuntimeContext 不可用，runtime-context 未隐藏')
    }
  }

  // pre-step 消息改写：只在真的有覆盖时注册，避免每个会话多一个空监听器。
  // prepend 让它在内置注入（instructions / catalog / time）之后拿到最终列表。
  if (hasMessageOverrides(recipe)) {
    applied.messageKinds = configuredMessageKinds(recipe)
    if (typeof agent.ctx.on !== 'function') {
      errors.push('agent 上下文没有 on()，消息改写未安装')
    } else {
      try {
        disposers.push(agent.ctx.on('agent/pre-step', async (payload, next) => {
          const decision = await next()
          if (decision?.kind === 'reject' || payload?.signal?.aborted === true) return decision
          try {
            const result = overlayStepMessages(decision.messages ?? [], recipe)
            return { ...decision, messages: result.messages }
          } catch (error) {
            agent.ctx.logger?.warn?.('plugin-console: 消息改写失败：' + (error instanceof Error ? error.message : String(error)))
            return decision
          }
        }, { prepend: true }))
      } catch (error) {
        errors.push('安装消息改写失败：' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }

  // 工具：用 deny 黑名单而不是 allow 白名单——晚到的 MCP 工具不会被误挡。
  // restrict() 对「当前 scope 不认识的全局工具名」直接抛错，一个名字不认识
  // 就整批失效；所以先逐个探明哪些名字真的可禁，只提交认识的那批。
  const disabled = Array.isArray(recipe?.tools?.disabled)
    ? recipe.tools.disabled.filter((name) => typeof name === 'string')
    : []
  if (disabled.length > 0 && typeof agent.ctx.tools?.restrict === 'function') {
    let deny = disabled
    const known = readRestrictableNames(agent.ctx)
    if (known !== undefined) {
      deny = disabled.filter((name) => known.has(name))
      applied.skippedTools = disabled.filter((name) => !known.has(name))
    }
    if (deny.length > 0) {
      try {
        disposers.push(agent.ctx.tools.restrict({ deny }))
        applied.deniedTools = deny
      } catch (error) {
        errors.push('禁用工具失败：' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }

  return {
    applied,
    errors,
    /**
     * 撤销这次物化。
     *
     * 必须 await：Cordis 的 effect 撤销是异步的（清理阶段可能要等），
     * 不 await 就立刻重新注册同名段落，注册表里那一段还在，会直接抛错。
     * @returns {Promise<void>} 全部撤销完成。
     */
    async dispose() {
      for (const dispose of disposers.reverse()) {
        try {
          await dispose()
        } catch {
          // 单个撤销失败不影响其余
        }
      }
    },
  }
}

/**
 * 预构建拿 order 表：同名覆盖要沿用原段位置。
 * @param {object} ctx - host 插件上下文。
 * @param {string | undefined} presetId - 该会话的模式。
 * @returns {Promise<Map<string, number>>} 段落名 → order。
 */
export async function sectionOrderOf(ctx, presetId) {
  const base = await previewAssembly(ctx, { presetId })
  return new Map(base.sections.map((section, index) => [section.name, index * 100]))
}

/**
 * 把一个 recipe 物化到指定会话，并接管它的生命周期。
 *
 * 抽出来是因为两条路径都要用：应用模板（`/apply`）和打开开关（`/activation`）。
 * 两者语义完全一样——「把这份 recipe 注册到这个 agent 的 scope 上，并保证可撤销」。
 * @param {object} ctx - host 插件上下文。
 * @param {string} sessionId - 目标会话。
 * @param {object} recipe - 配方。
 * @param {string | undefined} presetId - 该会话的模式（决定 order 表）。
 * @returns {Promise<object>} `{ applied, live, applied0?, errors?, reason? }`。
 */
export async function applyRecipeToSession(ctx, sessionId, recipe, presetId) {
  const live = ctx.get('agents')?.get?.(sessionId)
  if (live === undefined) {
    return { applied: false, live: false, reason: '这个会话当前没有活的 agent，物化未发生；启动会话后可以再试' }
  }

  const previous = appliedHandles.get(sessionId)
  if (previous !== undefined) {
    appliedHandles.delete(sessionId)
    try { await previous() } catch { /* 旧句柄失效不该挡住新的一次 */ }
  }

  const order = await sectionOrderOf(ctx, presetId)
  const handle = materializeRecipe(live, recipe, order)
  appliedHandles.set(sessionId, handle.dispose)
  // 撤销挂在 agent 的 scope 上：会话一结束，注册过的段与工具限制一起消失。
  live.ctx.effect(() => () => {
    appliedHandles.delete(sessionId)
    void handle.dispose()
  }, 'plugin-console: template materialization')

  return { applied: true, live: true, applied0: handle.applied, errors: handle.errors }
}

/**
 * 撤掉某个会话的物化。
 * @param {string} sessionId - 目标会话。
 * @returns {Promise<boolean>} 是否真的撤掉了一份注册。
 */
export async function clearRecipeForSession(sessionId) {
  const handle = appliedHandles.get(sessionId)
  if (handle === undefined) return false
  appliedHandles.delete(sessionId)
  try { await handle() } catch { /* 已失效的句柄不算失败 */ }
  return true
}
