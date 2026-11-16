/**
 * 页面状态：快照 / 提示词模板两块；预演条件在 `client.preview-store.js`，
 * 定制编辑器草稿在 `client.editor-store.js`。
 *
 * 分开的理由是失败语义不同：快照失败整页报错，预演失败只影响预演标签，
 * 提示词模板失败只影响通知行，编辑器基线失败只影响编辑器。
 * 本文件是一个包内 chunk：入口用 `require.async('./client.store.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-console',
  chunk: 'client.store.js',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    return function create(deps) {
      const { shared, applyChain, cleanup } = deps
      const { fetchJson, fetchSnapshot, samePath, TEMPLATES_ROUTE, TEMPLATE_ROUTE, ACTIVATION_ROUTE } = shared

      /** 快照：进入面板取一次，之后手动或每 30 秒静默刷新；previous 用于差分。 */
      function useSnapshotStore() {
        const [status, setStatus] = useState('idle')
        const [snapshot, setSnapshot] = useState(null)
        const [previous, setPrevious] = useState(null)
        const [error, setError] = useState(null)
        const [lastLoadedAt, setLastLoadedAt] = useState(null)
        const snapshotRef = useRef(null)

        const load = useCallback(async (options = {}) => {
          const silent = options.silent === true
          if (!silent) setStatus('loading')
          setError(null)
          try {
            const next = await fetchSnapshot()
            const before = snapshotRef.current
            if (before !== null) setPrevious(before)
            snapshotRef.current = next
            setSnapshot(next)
            setLastLoadedAt(Date.now())
            setStatus('ready')
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
            if (snapshotRef.current === null || !silent) setStatus('error')
          }
        }, [])

        useEffect(() => {
          void load()
        }, [load])

        // 自检脚本的 vm 没有 setInterval；浏览器里才有。隐藏页签时不刷。
        useEffect(() => {
          if (typeof setInterval !== 'function') return undefined
          const timer = setInterval(() => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
            void load({ silent: true })
          }, 30000)
          return () => clearInterval(timer)
        }, [load])

        return { status, snapshot, previous, error, lastLoadedAt, load }
      }

      /**
       * 提示词模板的 CRUD、保存、应用与每会话开关。
       *
       * 草稿与基线由 `useEditorStore` 持有；这里只通过 `editorState` 读写它们，
       * 让「模板列表」和「当前草稿」各自保持自己的失败语义。
       *
       * @param {object} options - 依赖。
       * @param {object | null} options.runtimeCtx - 浏览器插件上下文（按需取宿主服务）。
       * @param {object | null} options.snapshot - 当前快照，用于解析工作区与模式名。
       * @param {Function} options.reloadSnapshot - 开关生效后重取快照。
       * @param {object} options.editorState - `useEditorStore()` 的返回值。
       */
      function useTemplateStore({ runtimeCtx, snapshot, reloadSnapshot, editorState }) {
        // 切换基线条件（模式 / 工作区 / 权限）前待确认的目标：
        // undefined = 没有待确认的；对象里的字段各自可选。
        const [pendingBaselineChange, setPendingBaselineChange] = useState(undefined)
        // 兼容旧视图：只关心模式的确认条继续读这两个名字。
        const pendingPreset = pendingBaselineChange?.presetId
        const setPendingPreset = (presetId) => setPendingBaselineChange(presetId === undefined ? undefined : { presetId })
        // 提示词模板列表与当前选中的提示词模板。
        const [templateList, setTemplateList] = useState([])
        const [templateId, setTemplateId] = useState(null)
        const [templateSaving, setTemplateSaving] = useState(false)
        const [templateNotice, setTemplateNotice] = useState(null)
        // 提示词模板命名：正在编辑的名字（空表示未在编辑）、以及正在等待删除确认的提示词模板 id。
        const [nameDraft, setNameDraft] = useState(null)
        const [deletingId, setDeletingId] = useState(null)
        // 「应用」面板：把当前提示词模板物化到一个新会话，并带上首条消息。
        // 目标模式不再单独选：提示词模板的覆盖按基线模式的段落名算，换模式应用多半落空，
        // 所以应用模式恒等于编辑器的基线模式（editPreset）。工作区也由定制页的条件决定。
        const [applyPrompt, setApplyPrompt] = useState('')
        const [applyPhase, setApplyPhase] = useState('idle')
        const [applyNotice, setApplyNotice] = useState(null)
        // 每会话开关：正在提交的会话 id → 目标值。用 Map 而不是单个 id，
        // 因为用户可能连点几个会话；每个开关各自显状态。
        const [togglingSession, setTogglingSession] = useState(() => new Map())
        const [activationNotice, setActivationNotice] = useState(null)
        // 开关前的二次确认：记整份目标（会话 + 目标状态），确认时直接拿它发请求。
        const [activationPending, setActivationPending] = useState(null)

        /** 读取提示词模板列表。 */
        const loadTemplates = useCallback(async () => {
          try {
            const data = await fetchJson(TEMPLATES_ROUTE)
            setTemplateList(data.templates ?? [])
          } catch {
            setTemplateList([])
          }
        }, [])

        /** 全局清理后把编辑器退回纯基线，避免继续显示一个已不存在的提示词模板。 */
        const resetTemplateEditor = useCallback(() => {
          setTemplateId(null)
          setNameDraft(null)
          editorState.resetDraft()
        }, [editorState])

        // 清理状态独立成一个 chunk；这里只把「刷新快照 / 重取列表 / 重置编辑器」交给它。
        const cleanupState = cleanup({ reloadSnapshot, loadTemplates, onClearedAll: resetTemplateEditor })

        /**
         * 打开一个提示词模板：取它的 recipe，叠到当前基线之上。
         *
         * 提示词模板只存「与基线不同的项」，所以必须有一份基线才能还原成全文。
         * 当前编辑器的基线优先；没有就先载入默认模式的基线。
         * @param {string} id - 提示词模板 id。
         */
        const openTemplate = useCallback(async (id) => {
          try {
            const data = await fetchJson(TEMPLATE_ROUTE + '?id=' + encodeURIComponent(id))
            const latest = (data.revisions ?? []).at(-1)
            const recipe = latest?.recipe ?? {}
            setTemplateId(id)
            setNameDraft(null)
            await editorState.commitRecipe(recipe)
            // 载入成功不写通知：选中的模板在卡片里已经一目了然，多一行加载提示只是噪音。
            setTemplateNotice(null)
          } catch (cause) {
            setTemplateNotice(cause instanceof Error ? cause.message : String(cause))
          }
        }, [editorState])

        /**
         * 回到「新模板」：没有任何已保存的覆盖，草稿就是基线全文。
         *
         * `templateId === null` 不是「未选择」，而是「一份还没落库的新模板」——
         * 进入编辑器没选中任何模板时就是这个状态，保存或应用时才生成模板头。
         * @returns {void}
         */
        const startNewTemplate = useCallback(() => {
          setTemplateId(null)
          setNameDraft(null)
          setDeletingId(null)
          setTemplateNotice(null)
          editorState.resetDraft()
        }, [editorState])

        /**
         * 保证当前草稿有一个模板头：新模板在第一次保存 / 应用时才落库。
         *
         * 点进定制页只是看看也要在列表里留一条空模板，会让模板列表被垃圾填满；
         * 所以模板头的创建推迟到真的要用它的那一刻。
         * @returns {Promise<string>} 模板 id。
         */
        const ensureTemplate = useCallback(async () => {
          if (templateId !== null) return templateId
          const nextIndex = (templateList?.length ?? 0) + 1
          const data = await fetchJson(TEMPLATES_ROUTE, {
            method: 'POST',
            body: JSON.stringify({ name: '提示词模板 ' + nextIndex }),
          })
          setTemplateId(data.template.id)
          await loadTemplates()
          return data.template.id
        }, [templateId, templateList, loadTemplates])

        /**
         * 给当前提示词模板重命名。
         *
         * 名字只是标签：不回写任何 recipe，也不产生历史记录。
         * @param {string} id - 提示词模板 id。
         * @param {string} name - 新名字；空白名字拒绝提交。
         */
        const renameTemplate = useCallback(async (id, name) => {
          const trimmed = name.trim()
          if (trimmed.length === 0) {
            setTemplateNotice('名字不能为空')
            return
          }
          try {
            await fetchJson(TEMPLATE_ROUTE + '?id=' + encodeURIComponent(id), {
              method: 'POST',
              body: JSON.stringify({ name: trimmed }),
            })
            setNameDraft(null)
            await loadTemplates()
            setTemplateNotice('已重命名为「' + trimmed + '」')
          } catch (cause) {
            // 弹窗挡住卡片里的通知行：失败时先关掉，否则错误信息藏在覆盖层后面。
            setNameDraft(null)
            setTemplateNotice(cause instanceof Error ? cause.message : String(cause))
          }
        }, [loadTemplates])

        /**
         * 删除一个提示词模板（连同它的历史记录）。
         *
         * 删的是当前提示词模板时，把草稿退回纯基线并清空选中——否则界面会继续显示
         * 一个已经不存在的提示词模板。
         * @param {string} id - 提示词模板 id。
         */
        const deleteTemplate = useCallback(async (id) => {
          try {
            const data = await fetchJson(TEMPLATE_ROUTE + '?id=' + encodeURIComponent(id), { method: 'DELETE' })
            setDeletingId(null)
            await loadTemplates()
            if (templateId === id) {
              setTemplateId(null)
              setNameDraft(null)
              editorState.resetDraft()
            }
            const extra = (data.removedRevisions ?? 0) > 0 ? '（含 ' + data.removedRevisions + ' 条历史记录）' : ''
            setTemplateNotice('已删除提示词模板' + extra)
          } catch (cause) {
            // 删除确认是弹窗：失败时先关掉，错误通知才不会被覆盖层挡住。
            setDeletingId(null)
            setTemplateNotice(cause instanceof Error ? cause.message : String(cause))
          }
        }, [templateId, loadTemplates, editorState])

        /** 保存草稿为一个新 revision；草稿还是新模板时，先在这里把它真正生成出来。 */
        const saveTemplate = useCallback(async () => {
          if (templateSaving) return
          const wasNew = templateId === null
          setTemplateSaving(true)
          try {
            const id = await ensureTemplate()
            const recipe = editorState.recipeFromDraft()
            await fetchJson(TEMPLATE_ROUTE + '?id=' + encodeURIComponent(id), {
              method: 'POST',
              body: JSON.stringify({ recipe }),
            })
            await loadTemplates()
            editorState.setTemplateRecipe(recipe)
            // 保存后草稿仍是眼前这一份，只是「没有未保存改动」了。
            editorState.markSaved()
            // 摘要直接写进通知：只改新字段、旧字段被静默丢掉时，这里会立刻显示 0。
            setTemplateNotice((wasNew ? '已生成并保存新模板' : '已保存') + ' · ' + editorState.recipeSummary(recipe))
          } catch (cause) {
            setTemplateNotice(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setTemplateSaving(false)
          }
        }, [templateId, templateSaving, ensureTemplate, loadTemplates, editorState])

        /**
         * 把当前提示词模板真正用起来：存版本 → 建会话 → 物化 → 跳过去 → 填好草稿。
         *
         * 五步链本身在 `client.apply.js` 里，是一个不依赖 React 的纯函数；
         * 这里只做「把状态取出来、把结果写回去」。
         */
        const applyTemplate = useCallback(async () => {
          // 「当前」不是一个真的工作区 id：`sessions.create({})` 不带工作区会用
          // 宿主的 defaultCwd 建在哪儿都不属于，会话就落到「未分组」里，主区只剩
          // 一个选工作区的空白页。所以这里把「当前」解析成用户正待着的那个工作区。
          const resolveWorkspace = () => {
            // 定制页条件给了路径就以它为准；路径映射不到工作区 id 时退回「当前工作区」。
            const path = editorState.effectiveWorkspacePath
            if (typeof path === 'string' && path.length > 0) {
              const selected = (snapshot.workspaces ?? []).find((workspace) => samePath(workspace.path, path))
              if (selected !== undefined) return selected.id
            }
            const uiWorkspace = runtimeCtx?.get?.('uiWorkspace')
            const selectedSessionId = uiWorkspace?.selection?.getSnapshot?.()?.sessionId
            if (typeof selectedSessionId === 'string') {
              const owner = (snapshot.workspaces ?? []).find((workspace) =>
                (workspace.sessions ?? []).some((session) => session.id === selectedSessionId),
              )
              if (owner !== undefined) return owner.id
            }
            return (snapshot.workspaces ?? [])[0]?.id ?? null
          }

          setApplyPhase('saving')
          setApplyNotice(null)
          // 草稿还是新模板时先把它生成出来：应用链的每一步都要一个真实的模板 id。
          let id
          try {
            id = await ensureTemplate()
          } catch (cause) {
            setApplyPhase('error')
            setApplyNotice(cause instanceof Error ? cause.message : String(cause))
            return
          }
          const result = await applyChain.runApplyChain({
            ctx: runtimeCtx,
            templateId: id,
            recipe: editorState.recipeFromDraft(),
            workspaceId: resolveWorkspace(),
            presetId: editorState.editPreset,
            promptText: applyPrompt,
            autoSend: true,
            onPhase: setApplyPhase,
          })

          if (result.ok !== true) {
            setApplyPhase('error')
            setApplyNotice(result.message)
            return
          }
          setApplyPhase(result.failed ? 'error' : 'done')
          setApplyNotice(result.notes)
        }, [ensureTemplate, editorState, applyPrompt])

        // 开关改的是请求体最前面的工具定义与系统提示词，缓存按前缀匹配，前缀一变
        // 后面全部失效——这次操作有直接的账单代价，所以先挂起，等界面确认。
        const requestActivation = (sessionId, enabled, presetId) => setActivationPending({ sessionId, enabled, presetId })
        const cancelActivation = () => setActivationPending(null)

        /**
         * 切换某个会话的提示词模板启用状态，成功后重拉快照（绑定与运行时工具集都可能变了）。
         * @param {string} sessionId - 目标会话。
         * @param {boolean} enabled - 目标状态。
         * @param {string | null} presetId - 该会话的模式，用于重新物化时的 order 表。
         */
        const toggleActivation = useCallback(async (sessionId, enabled, presetId) => {
          setActivationPending(null)
          setTogglingSession((prev) => new Map(prev).set(sessionId, enabled))
          setActivationNotice(null)
          try {
            const data = await fetchJson(ACTIVATION_ROUTE, {
              method: 'POST',
              body: JSON.stringify({
                sessionId,
                enabled,
                ...(typeof presetId === 'string' ? { presetId } : {}),
              }),
            })
            const notes = [enabled ? '已开启' : '已关闭']
            if (data.cleared === true) notes.push(' · 已撤销上一次的注册')
            if (data.reason !== undefined) notes.push(' · ' + data.reason)
            if ((data.errors ?? []).length > 0) notes.push(' · 失败：' + data.errors.join('；'))
            if (data.note !== undefined) notes.push(' · ' + data.note)
            setActivationNotice(notes.join(''))
            await reloadSnapshot()
          } catch (cause) {
            setActivationNotice(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setTogglingSession((prev) => {
              const next = new Map(prev)
              next.delete(sessionId)
              return next
            })
          }
        }, [reloadSnapshot])

        /**
         * 真正应用一次基线条件变化。
         *
         * `replay` 省略时用当前提示词模板的 recipe；「先保存再切换」会把刚算出的
         * recipe 直接传进来，避免读到异步状态里的旧值。
         * @param {object} change - `{ presetId?, workspacePath?, permissionPreset? }`。
         * @param {object} [replay] - 要在新基线上重放的 recipe。
         * @returns {void}
         */
        const commitBaselineChange = useCallback((change, replay) => {
          setPendingBaselineChange(undefined)
          editorState.applyConditions(change)
          const presetId = change.presetId === undefined ? editorState.editPreset : change.presetId
          void editorState.loadBaseline(
            presetId,
            replay === undefined ? editorState.templateRecipe : replay,
            change,
          )
        }, [editorState])

        /**
         * 请求一次基线条件变化：有未保存改动先挂起确认，否则立即重载。
         * @param {object} change - `{ presetId?, workspacePath?, permissionPreset? }`。
         * @returns {void}
         */
        const requestBaselineChange = useCallback((change) => {
          // 模式相同、条件也相同就是一次空操作。
          const samePreset = change.presetId === undefined || change.presetId === editorState.editPreset
          const sameWorkspace = change.workspacePath === undefined || samePath(change.workspacePath, editorState.effectiveWorkspacePath)
          const samePermission = change.permissionPreset === undefined || change.permissionPreset === editorState.editPermissionPreset
          if (samePreset && sameWorkspace && samePermission) return
          if (editorState.dirty) {
            setPendingBaselineChange(change)
            return
          }
          commitBaselineChange(change)
        }, [editorState, commitBaselineChange])

        /**
         * 切换基线模式。
         *
         * 换模式会把草稿整份重填（段落集合与工具集合都变了），所以有未保存改动
         * 时必须先问一句——不然用户改的东西会无声消失。
         * @param {string | null} presetId - 目标模式。
         * @returns {void}
         */
        const requestPreset = useCallback((presetId) => {
          requestBaselineChange({ presetId })
        }, [requestBaselineChange])

        return {
          pendingPreset,
          setPendingPreset,
          pendingBaselineChange,
          setPendingBaselineChange,
          commitBaselineChange,
          requestBaselineChange,
          templateList,
          templateId,
          templateSaving,
          templateNotice,
          nameDraft,
          setNameDraft,
          deletingId,
          setDeletingId,
          applyPrompt,
          setApplyPrompt,
          applyPhase,
          applyNotice,
          setApplyNotice,
          togglingSession,
          activationNotice,
          activationPending,
          ...cleanupState,
          loadTemplates,
          openTemplate,
          startNewTemplate,
          renameTemplate,
          deleteTemplate,
          saveTemplate,
          applyTemplate,
          requestActivation,
          cancelActivation,
          toggleActivation,
          requestPreset,
        }
      }

      return { useSnapshotStore, useTemplateStore }
    }
  },
})
