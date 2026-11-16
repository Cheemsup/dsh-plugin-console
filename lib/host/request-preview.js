/**
 * 首请求预演的编排层：条件 → 一份 scope → 装配 → 信封。
 *
 * 这个文件回答的是「一条新会话的第一次请求里，模型到底会收到什么」。
 * 它不创建 Session / Agent，不写 session log，也不改注册表——所有值都是一次
 * 可复现的推导，页面据此把「实测」和「推导」分开标。
 *
 * 「哪些 pre-step 插件会运行」由 `preview-modules.js` 判定：宿主 Loader 行与
 * 目标模式的声明组合任一成立即可，因为 web/desktop profile 的这三条注入都是由
 * preset 挂载的。
 * @module dsh-plugin-console/host/request-preview
 */

import { acquirePresetScope, previewAssembly } from './assembly-preview.js'
import { previewEnvelope } from './preview-envelope.js'
import { resolveConditions } from './preview-conditions.js'
import { previewMessages } from './preview-messages.js'
import { resolveModules } from './preview-modules.js'
import { applyRecipeToAssembly } from './recipe-overlay.js'

/**
 * 用默认模型补上 `assemble()` 里缺失的插值变量。
 *
 * `{{model}}` / `{{provider}}` 由 agent-loop 在真实请求前提供，预演没有 Agent，
 * 所以这里用「默认模型选择」顶替——那正是新建会话会用的模型。
 * @param {object} conditions - 已解析的条件。
 * @returns {object | undefined} 变量覆盖表。
 */
function variableOverridesOf(conditions) {
  if (conditions.model === null) return undefined
  return { model: conditions.model.model, provider: conditions.model.provider }
}

/**
 * 预演一次首请求。
 * @param {object} ctx - host 插件上下文。
 * @param {object} options - 客户端上报的条件。
 * @param {string} [options.presetId] - 目标模式。
 * @param {string} [options.workspacePath] - 工作区路径：已注册路径，或任意绝对目录（自定义目录只影响推导）。
 * @param {string} [options.permissionPreset] - 权限预设名。
 * @param {string} [options.clientTimeZone] - 客户端 IANA 时区。
 * @param {string} [options.draft] - 首条消息草稿；决定 user 消息正文与 `/name` 展开。
 * @param {object} [options.recipe] - 提示词模板配方；提供时把覆盖叠加到本次预演。
 * @param {number} [options.now] - 预览时刻（epoch ms），默认当前时间；测试用它固定时间快照。
 * @returns {Promise<object>} 装配结果 + 条件 + 信封 + 消息 + 警告。
 */
export async function requestPreview(ctx, options = {}) {
  const conditions = await resolveConditions(ctx, options)
  // 一次预演只挂一份 preset scope：装配与（下一阶段的）skill 快照必须看到同一份链。
  const scope = await acquirePresetScope(ctx, options.presetId)
  try {
    const baseAssembly = await previewAssembly(ctx, {
      presetId: scope.presetId,
      scope,
      variableOverrides: variableOverridesOf(conditions),
    })
    // 模板叠加是纯投影：不注册任何东西，只改这次响应里模型会看到的文字与可见工具。
    const assembly = options.recipe === undefined
      ? baseAssembly
      : applyRecipeToAssembly(baseAssembly, options.recipe)
    const { applied: appliedToAssembly = { sections: [], contexts: [], tools: [], appended: false }, ...assemblyView } = assembly
    // 模块可用性必须按「目标模式」判定：agent-instructions / tool-skill / time-context
    // 在 web/desktop profile 里由 preset 挂载，宿主行是 disabled 或不存在。
    const modules = await resolveModules(ctx, scope.presetId)
    const envelope = previewEnvelope(assembly, conditions)
    const messages = await previewMessages(ctx, {
      assembly,
      conditions,
      modules,
      scopeKey: scope.scopeKey,
      now: options.now,
      draft: options.draft,
      recipe: options.recipe,
    })
    const systemTextChars = assembly.systemText.length
    const messageChars = messages.messages.reduce((sum, item) => sum + item.length, 0)
    return {
      ...assemblyView,
      conditions: {
        workspace: conditions.workspace,
        permission: conditions.permission,
        model: conditions.model,
        contextWindow: conditions.contextWindow,
        clientTimeZone: conditions.clientTimeZone,
        clientTimeZoneSource: conditions.clientTimeZoneSource,
      },
      envelope,
      messages: messages.messages,
      /** 被条件挡掉、因而没有生成的消息与原因：页面要能回答「为什么没有这一条」。 */
      skippedMessages: messages.skipped,
      /** 模板实际改到了哪些项；预演页与定制页据此显示「已叠加」，不靠猜。 */
      overrides: {
        ...appliedToAssembly,
        messages: messages.applied?.messages ?? [],
        catalogEntries: messages.applied?.catalogEntries ?? [],
        skippedMessages: messages.applied?.skipped ?? [],
      },
      // 装配的警告里已经有 scope 的那条；这里追加条件采集与消息采集的。
      warnings: [...assembly.warnings, ...conditions.warnings, ...messages.warnings],
      stats: {
        ...assembly.stats,
        // 单列 system 消息的真实长度：`sectionChars` 不含段间 `\n\n`，拿它当合计会低估。
        systemTextChars,
        messageCount: messages.messages.length,
        messageChars,
        // 合计按请求真实的三块算：system 消息 + tools 字段 + 全部 user 消息。
        // runtime-context 已经在 messages 里，所以不加 `contextChars`。
        totalChars: systemTextChars + assembly.stats.toolSchemaChars + messageChars,
      },
    }
  } finally {
    await scope.dispose()
  }
}
