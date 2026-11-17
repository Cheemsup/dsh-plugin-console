/**
 * 「应用提示词模板到会话」那条五步链，单独成一个纯函数。
 *
 * 顺序不能变，而且每一步的失败语义都不一样：存版本失败就整体失败，建会话失败
 * 就整体失败，物化失败要保留会话并报告原因，首句失败**不该**让整个流程失败。
 * 把这些判断从 React 状态里拿出来，才能单独读、单独测。
 *
 * 链：
 *   1. 保存草稿为新版本（保证「应用到会话的」就是眼前看到的）
 *   2. 建会话（返回时 agent 已发布、首个 turn 尚未开始）
 *   3. 物化提示词模板到这个会话
 *   4. 首句：自动发送，或只填进输入框
 *   5. 决定要不要跳过去
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.apply.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.apply.js',
  factory: () => (deps) => {
    const { fetchJson, TEMPLATE_ROUTE, APPLY_ROUTE } = deps

    /**
     * 把首句投递到会话：自动发送，或只填进输入框。
     *
     * 两件事都需要一个「已 retain 的 binding」，而刚 create 出来的会话还没有。
     * 所以这里自己 retain 一次：不导航、只把 scope 建起来拿到 binding，做完再释放。
     * 这样即使后面发现物化有失败、决定不跳走，也已经落好了。
     *
     * 发送走 `binding.session.prompt()` 而不是 `conversation.send()`：
     * 后者要求「调用方 ctx 带 session scope」，而我们是从根 ctx 拿到的
     * conversation，直接调会抛 root-context 错误。binding.session 是那个会话
     * 自己的对象层，不需要再借 scope。
     * @param {object} options - 投递参数。
     * @returns {Promise<{promptSent: boolean, draftFilled: boolean, promptError: string | null}>} 投递结果。
     */
    async function deliverFirstPrompt({ ctx, sessionsService, sessionId, prompt, autoSend }) {
      let reference
      let promptSent = false
      let draftFilled = false
      let promptError = null
      try {
        reference = sessionsService.retain?.(sessionId, { source: 'pluginTree' })
        const binding = reference === undefined ? sessionsService.binding?.(sessionId) : await reference.ready
        if (binding !== undefined) {
          if (autoSend) {
            const result = await binding.session.prompt([{ type: 'text', text: prompt }], 'queue')
            if (result?.ok === true) promptSent = true
            else promptError = result?.error?.message ?? '发送被拒绝'
          } else {
            const conversation = ctx?.get?.('conversation')
            if (conversation?.input?.requestDraftInitialization !== undefined) {
              conversation.input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'replace' })
              draftFilled = true
            }
          }
        }
      } catch (cause) {
        // 首句没落好不该让整个流程失败：会话和物化都已经成了
        promptError = cause instanceof Error ? cause.message : String(cause)
      } finally {
        reference?.release?.()
      }
      return { promptSent, draftFilled, promptError }
    }

    /**
     * 把一条提示行拼出来：成功项与失败项都要说清楚，不能只报一句「完成」。
     * @param {object} state - 本次运行的中间结果。
     * @returns {{notes: string, failed: boolean}} 提示文本与是否算失败。
     */
    function summarize({ sessionId, applied, prompt, wantPrompt }) {
      const notes = []
      notes.push('已建会话 ' + sessionId.slice(0, 16) + '… 并应用提示词模板')
      if (applied.created === true) notes.push('（新建）')
      const appliedSections = applied.applied0?.sections?.length ?? 0
      const appliedOverrides = applied.applied0?.overrides?.length ?? 0
      const denied = applied.applied0?.deniedTools?.length ?? 0
      const contexts = applied.applied0?.contextOverrides?.length ?? 0
      const messageKinds = applied.applied0?.messageKinds?.length ?? 0
      notes.push(' · 追加段落 ' + appliedSections + ' · 改写 ' + appliedOverrides + ' · 禁用工具 ' + denied)
      if (contexts > 0) notes.push(' · 上下文 ' + contexts)
      if (messageKinds > 0) notes.push(' · 消息 ' + messageKinds)
      const skipped = applied.applied0?.skippedTools ?? []
      if (skipped.length > 0) notes.push(' · ' + skipped.length + ' 个工具名不在当前 scope，跳过（' + skipped.join('、') + '）')
      const failures = applied.errors ?? []
      if (failures.length > 0) notes.push(' · 失败 ' + failures.length + ' 项：' + failures.join('；'))
      if (applied.applied !== true) notes.push(' · 物化没发生：' + (applied.reason ?? '未知原因'))
      if (prompt.promptSent) notes.push(' · 首句已发送')
      else if (prompt.promptError !== null) notes.push(' · 首句发送失败：' + prompt.promptError)
      else if (wantPrompt && !prompt.draftFilled) notes.push(' · 首句没能填进输入框，请手动粘贴')
      const failed = failures.length > 0 || applied.applied !== true
      return { notes: notes.join(''), failed }
    }

    /**
     * 跑完整条链。
     *
     * @param {object} options - 运行参数。
     * @param {object} options.ctx - 浏览器插件上下文（按需取宿主服务）。
     * @param {string} options.templateId - 目标提示词模板。
     * @param {object} options.recipe - 当前草稿算出的配方。
     * @param {string | null} options.workspaceId - 目标工作区；null 表示让宿主决定。
     * @param {string | null} options.presetId - 会话模式（= 编辑器基线模式）。
     * @param {string} options.promptText - 首句内容。
     * @param {boolean} options.autoSend - true 表示物化后立刻发送。
     * @param {Function} options.onPhase - 阶段回调（'saving' | 'creating' | 'applying'）。
     * @returns {Promise<{ok: true, sessionId: string, notes: string, failed: boolean} | {ok: false, message: string}>} 结果。
     */
    async function runApplyChain(options) {
      const { ctx, templateId, recipe, workspaceId, presetId, promptText, autoSend, onPhase } = options
      const sessionsService = ctx?.get?.('sessions')
      const uiWorkspace = ctx?.get?.('uiWorkspace')
      if (sessionsService === undefined) {
        return { ok: false, message: '宿主没有 sessions 服务，无法新建会话' }
      }

      try {
        // 1. 先把草稿存成新版本，保证「应用到会话的」就是眼前看到的。
        onPhase('saving')
        await fetchJson(TEMPLATE_ROUTE + '?id=' + encodeURIComponent(templateId), {
          method: 'POST',
          body: JSON.stringify({ recipe }),
        })

        // 2. 建会话：这一步返回时 agent 已经在册、还没开始任何 turn。
        //    模式就用编辑器的基线模式——提示词模板的覆盖是按它的段落名算的。
        onPhase('creating')
        const sessionId = await sessionsService.create({
          ...(workspaceId === null ? {} : { workspaceId }),
          ...(presetId === null ? {} : { agentPreset: presetId }),
        })

        // 3. 物化到这个会话上。
        onPhase('applying')
        const applied = await fetchJson(APPLY_ROUTE, {
          method: 'POST',
          body: JSON.stringify({
            templateId,
            sessionId,
            ...(presetId === null ? {} : { presetId }),
          }),
        })

        // 4. 首句。
        const wantPrompt = promptText.trim().length > 0
        const prompt = wantPrompt
          ? await deliverFirstPrompt({ ctx, sessionsService, sessionId, prompt: promptText, autoSend })
          : { promptSent: false, draftFilled: false, promptError: null }

        const { notes, failed } = summarize({ sessionId, applied, prompt, wantPrompt })

        // 5. 一切正常才跳走。有失败就停在面板上——跳过去面板卸载，
        //    通知跟着消失，用户永远看不到哪几项没成。
        if (!failed && uiWorkspace?.openSession !== undefined) {
          uiWorkspace.openSession(sessionId)
        }
        const suffix = uiWorkspace?.openSession === undefined
          ? ' · 宿主没有 uiWorkspace，没能自动打开，请从侧边栏点进去'
          : ''

        return { ok: true, sessionId, notes: notes + suffix, failed }
      } catch (cause) {
        return { ok: false, message: cause instanceof Error ? cause.message : String(cause) }
      }
    }

    return { runApplyChain, deliverFirstPrompt, summarize }
  },
})
