/**
 * 定制编辑器的草稿状态：编辑态、基线、草稿、未保存判断与配方生成。
 *
 * 从 `client.store.js` 拆出来的理由有两个：
 *   1. `client.store.js` 已经贴着 520 行上限，再把消息/上下文草稿塞进去必然超；
 *   2. 草稿的失败语义与模板 CRUD 不同——基线载入失败只影响编辑器，
 *      模板列表失败只影响通知行，两者不该长在同一个 hook 里。
 *
 * 模板头、保存、应用与每会话开关仍在 `client.store.js`；它接收本 hook 的返回值。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.editor-store.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-console',
  chunk: 'client.editor-store.js',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useState } = React

    return function create(deps) {
      const { draft, browserTimeZone } = deps

      /**
       * @param {object} options - 依赖。
       * @param {Function} options.fetchPreview - 预演求值；基线就是同一份构造。
       * @param {object[]} [options.workspaces] - 快照工作区（已按最近活跃排序）。
       * @returns {object} 编辑器状态、草稿与动作。
       */
      function useEditorStore({ fetchPreview, workspaces }) {
        // 提示词页的编辑态。每段的**完整文本**都存在 draftSections 里，进入编辑器时
        // 用基线全文填充——用户看到的就是「这个模式下模型真正会收到的那些字」。
        const [editing, setEditing] = useState(false)
        const [draftAppend, setDraftAppend] = useState('')
        const [draftSections, setDraftSections] = useState({})
        const [draftDisabled, setDraftDisabled] = useState(() => new Set())
        // runtime-context 逐段文本；name → 最终模型可见文字。
        const [draftContexts, setDraftContexts] = useState({})
        // pre-step 消息草稿：instructions / time 是整段文本 + 隐藏开关；
        // catalog 是逐条「列出/不列出 + 描述」。
        const [draftInstructions, setDraftInstructions] = useState({ text: '', hidden: false })
        const [draftTime, setDraftTime] = useState({ text: '', mode: 'keep', hidden: false })
        const [draftRuntimeHidden, setDraftRuntimeHidden] = useState(false)
        const [draftCatalog, setDraftCatalog] = useState({ hidden: false, entries: {} })
        // 编辑器自己的基线：模式 + 该模式的完整构造。
        // 与预演页分开——在编辑器里换模式不该改掉预演页正在看的那个。
        const [editPreset, setEditPreset] = useState(null)
        const [editPreview, setEditPreview] = useState(null)
        const [editStatus, setEditStatus] = useState('idle')
        const [editError, setEditError] = useState(null)
        // 定制页自己的条件：与预演页互相独立，不共用任何状态。
        // null = 默认（最近活跃工作区 / 宿主部署默认权限）。
        const [editWorkspacePath, setEditWorkspacePath] = useState(null)
        const [editPermissionPreset, setEditPermissionPreset] = useState(null)
        const effectiveWorkspacePath = editWorkspacePath ?? workspaces?.[0]?.path ?? null
        // 上次载入或保存时的草稿指纹。用它判断「有没有未保存改动」——
        // 换条件会把草稿整份重置，有改动就得先问一句。
        const [savedSignature, setSavedSignature] = useState(null)
        // 当前提示词模板已保存的 recipe。换基线时用它在新基线上重放覆盖，
        // 否则切换会把提示词模板自己的改动也一并抹掉。
        const [templateRecipe, setTemplateRecipe] = useState(null)
        // 定制结果预览：用当前草稿的 recipe 再跑一次预演；只读，不保存。
        const [showingApplied, setShowingApplied] = useState(false)
        const [editAppliedPreview, setEditAppliedPreview] = useState(null)
        const [editAppliedStatus, setEditAppliedStatus] = useState('idle')
        const [editAppliedError, setEditAppliedError] = useState(null)
        const [editAppliedTab, setEditAppliedTab] = useState('prompt')

        /** 当前草稿的完整投影；纯函数与指纹只认这一份。 */
        const draftState = {
          append: draftAppend,
          sections: draftSections,
          disabled: draftDisabled,
          contexts: draftContexts,
          instructions: draftInstructions,
          time: draftTime,
          runtimeHidden: draftRuntimeHidden,
          catalog: draftCatalog,
        }

        /** 当前草稿与「上次载入/保存时」相比是否有改动。 */
        const dirty = savedSignature !== null && draft.signatureOf(draftState) !== savedSignature

        /** 把一份草稿装进状态，并记下它的指纹（= 此刻算「没有未保存改动」）。 */
        const commitDraft = useCallback((draftValue) => {
          setDraftAppend(draftValue.append)
          setDraftSections(draftValue.sections)
          setDraftDisabled(draftValue.disabled)
          setDraftContexts(draftValue.contexts ?? {})
          setDraftInstructions(draftValue.instructions ?? { text: '', hidden: false })
          setDraftTime(draftValue.time ?? { text: '', mode: 'keep', hidden: false })
          setDraftRuntimeHidden(draftValue.runtimeHidden === true)
          setDraftCatalog(draftValue.catalog ?? { hidden: false, entries: {} })
          setSavedSignature(draft.signatureOf(draftValue))
        }, [])

        /**
         * 取某个模式的基线构造，并把编辑器草稿整份填成它的全文。
         *
         * 换基线时会把当前提示词模板已保存的 recipe 在新基线上重放一遍：提示词模板的
         * 改动属于提示词模板，不该因为换了个基线就消失。当前基线里不存在的段落自然落不下。
         * @param {string | null} presetId - 目标模式。
         * @param {object} [replay] - 要重放的 recipe；省略则用当前提示词模板已保存的那份。
         * @returns {Promise<object>} 装配结果。
         */
        const loadBaseline = useCallback(async (presetId, replay, conditions) => {
          setEditStatus('loading')
          setEditError(null)
          try {
            // 条件只来自定制页自己的状态；不读取预演页的选择。
            const workspacePath = conditions?.workspacePath === undefined ? effectiveWorkspacePath : conditions.workspacePath
            const permissionPreset = conditions?.permissionPreset === undefined ? editPermissionPreset : conditions.permissionPreset
            const offset = browserTimeZone()
            const data = await fetchPreview({
              presetId,
              ...(typeof workspacePath === 'string' && workspacePath.length > 0 ? { workspacePath } : {}),
              ...(typeof permissionPreset === 'string' && permissionPreset.length > 0 ? { permissionPreset } : {}),
              ...(offset === undefined ? {} : { clientTimeZone: offset }),
            })
            const recipe = replay === undefined ? templateRecipe : replay
            const draftValue = draft.draftFromBaseline(data, recipe)
            setEditPreview(data)
            setEditPreset(data.presetId ?? presetId ?? null)
            setDraftSections(draftValue.sections)
            setDraftAppend(draftValue.append)
            setDraftDisabled(draftValue.disabled)
            setDraftContexts(draftValue.contexts ?? {})
            setDraftInstructions(draftValue.instructions ?? { text: '', hidden: false })
            setDraftTime(draftValue.time ?? { text: '', mode: 'keep', hidden: false })
            setDraftRuntimeHidden(draftValue.runtimeHidden === true)
            setDraftCatalog(draftValue.catalog ?? { hidden: false, entries: {} })
            // 刚载入的这份草稿就是「当前基线 + 提示词模板覆盖」，此刻没有未保存改动。
            setSavedSignature(draft.signatureOf(draftValue))
            setEditStatus('ready')
            return data
          } catch (cause) {
            setEditError(cause instanceof Error ? cause.message : String(cause))
            setEditStatus('error')
            throw cause
          }
        }, [fetchPreview, templateRecipe, effectiveWorkspacePath, editPermissionPreset, browserTimeZone])

        /**
         * 把一份已保存的 recipe 叠到当前基线上。
         *
         * 当前没有基线时先载入；`loadBaseline` 自己会把 recipe 重放进去，不需要
         * 再 commit 一次。
         * @param {object | null} recipe - 提示词模板配方；null 表示纯基线。
         * @returns {Promise<void>} 完成。
         */
        const commitRecipe = useCallback(async (recipe) => {
          setTemplateRecipe(recipe)
          if (editPreview === null) {
            await loadBaseline(editPreset, recipe)
            return
          }
          commitDraft(draft.draftFromBaseline(editPreview, recipe))
        }, [editPreview, editPreset, loadBaseline, commitDraft])

        /** 回到纯基线：清掉当前提示词模板的覆盖，但保留基线本身。 */
        const resetDraft = useCallback(() => {
          setTemplateRecipe(null)
          if (editPreview !== null) commitDraft(draft.draftFromBaseline(editPreview, null))
        }, [editPreview, commitDraft])

        /** 从当前草稿算出要写进 recipe 的内容。 */
        const recipeFromDraft = useCallback(() => draft.recipeFromDraft({
          ...draftState,
          editPreview,
        }), [draftState, editPreview])

        /** 保存成功后把当前草稿标成「没有未保存改动」，不改变内容。 */
        const markSaved = useCallback(() => {
          setSavedSignature(draft.signatureOf(draftState))
        }, [draftState])

        /** 更新定制页条件；`undefined` 表示这个条件不变。 */
        const applyConditions = useCallback((change) => {
          if (change?.workspacePath !== undefined) setEditWorkspacePath(change.workspacePath)
          if (change?.permissionPreset !== undefined) setEditPermissionPreset(change.permissionPreset)
        }, [])

        /**
         * 用当前草稿（不是已保存模板）求一次叠加后的首请求。
         *
         * 这是只读预演：不保存 recipe、不创建会话；失败只影响这个预览。
         * @returns {Promise<void>} 完成。
         */
        const previewApplied = useCallback(async () => {
          setEditAppliedStatus('loading')
          setEditAppliedError(null)
          setShowingApplied(true)
          try {
            const offset = browserTimeZone()
            const data = await fetchPreview({
              presetId: editPreset,
              ...(typeof effectiveWorkspacePath === 'string' && effectiveWorkspacePath.length > 0 ? { workspacePath: effectiveWorkspacePath } : {}),
              ...(typeof editPermissionPreset === 'string' && editPermissionPreset.length > 0 ? { permissionPreset: editPermissionPreset } : {}),
              ...(offset === undefined ? {} : { clientTimeZone: offset }),
              recipe: recipeFromDraft(),
            })
            setEditAppliedPreview(data)
            setEditAppliedStatus('ready')
          } catch (cause) {
            setEditAppliedError(cause instanceof Error ? cause.message : String(cause))
            setEditAppliedStatus('error')
          }
        }, [fetchPreview, editPreset, effectiveWorkspacePath, editPermissionPreset, browserTimeZone, recipeFromDraft])

        /** 回到编辑。 */
        const closeApplied = useCallback(() => setShowingApplied(false), [])

        return {
          editing,
          setEditing,
          draftAppend,
          setDraftAppend,
          draftSections,
          setDraftSections,
          draftDisabled,
          setDraftDisabled,
          draftContexts,
          setDraftContexts,
          draftInstructions,
          setDraftInstructions,
          draftTime,
          setDraftTime,
          draftRuntimeHidden,
          setDraftRuntimeHidden,
          draftCatalog,
          setDraftCatalog,
          editPreset,
          editPreview,
          editStatus,
          editError,
          editWorkspacePath,
          setEditWorkspacePath,
          effectiveWorkspacePath,
          editPermissionPreset,
          setEditPermissionPreset,
          dirty,
          templateRecipe,
          setTemplateRecipe,
          commitDraft,
          loadBaseline,
          commitRecipe,
          resetDraft,
          recipeFromDraft,
          recipeSummary: draft.recipeSummary,
          markSaved,
          applyConditions,
          showingApplied,
          editAppliedPreview,
          editAppliedStatus,
          editAppliedError,
          editAppliedTab,
          setEditAppliedTab,
          previewApplied,
          closeApplied,
        }
      }

      return { useEditorStore }
    }
  },
})
