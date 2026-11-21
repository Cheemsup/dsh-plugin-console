/**
 * 页面壳：组装状态、派生视图上下文、分发视图。
 *
 * 这是客户端唯一持有 React state 的地方，但状态本身按用途拆在 `client.store.js`
 * 的三个 hook 里。这里只做三件事：
 *   1. 把三个 store 的结果拼成一个视图上下文（`vc`）；
 *   2. 算派生值（过滤后的插件、类别计数、会话索引）；
 *   3. 按当前标签渲染对应视图。
 *
 * 视图因此是纯函数：只读 `vc`，不闭包隐藏状态，可以脱离页面单独调用。
 *
 * 五个视图各自回答一个独立问题：
 *   插件 —— 这台机器到底装了什么、按能力分类看；
 *   会话 —— 从某个会话往上追它的插件是哪来的；
 *   工具 —— 模型能看到哪些工具、谁给的；
 *   上下文预演 —— 首条消息发出去之前模型会收到什么；从页底进「定制」；
 *   插件禁用预演 —— 禁用某个插件会失去什么、谁受影响、config 逐层声明了什么。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.page.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect, useMemo, useRef, useState } = React

    return function create(deps) {
      // 三个名字各管一摊：`preview` 是预演结果，`previewView` 是视图 chunk，
      // `previewStore` 是条件与请求状态。混用会在 PluginTreePage 里被内层解构遮蔽。
      const { runtimeCtx, shared, store, plugins, pluginFilters, sessions, tools, preview: previewView, previewStore, editorStore, editor, influence, activity, changes, control, disablePreview, search } = deps
      const {
        CATEGORY_LABELS,
        isStructural,
        isTypingTarget,
        layerLabel,
        tabButton,
        formatTime,
        formatAge,
        useWorkspacePicker,
        useThemePreference,
      } = shared

      /** 页头外观控件：三态分段，当前项由 aria-pressed 标出。 */
      const THEME_OPTIONS = [
        ['follow', '跟随 DSH', '跟随 DSH 的主题：宿主切换明暗时这个面板一起变'],
        ['light', '明亮', '固定为明亮配色，不受宿主主题影响'],
        ['dark', '夜间', '固定为夜间配色，不受宿主主题影响'],
      ]

      /**
       * 外观三段控件。
       * @param {string} theme - 当前外观。
       * @param {Function} setTheme - 切换外观。
       * @returns {object} React 节点。
       */
      function themeSwitch(theme, setTheme) {
        return h(
          'span',
          { className: 'ptSeg', role: 'group', 'aria-label': '面板外观' },
          THEME_OPTIONS.map(([value, label, title]) => h(
            'button',
            {
              key: value,
              type: 'button',
              className: 'ptSegBtn',
              'aria-pressed': theme === value ? 'true' : 'false',
              title,
              onClick: () => setTheme(value),
            },
            label,
          )),
        )
      }
      const { useSnapshotStore, useTemplateStore } = store
      /** 主面板。 */
      function PluginTreePage() {
        const { status, snapshot, previous, error, lastLoadedAt, load } = useSnapshotStore()
        // 外观只是显示偏好：留在页面层，不进三个 store，也不写宿主存储域。
        const [theme, setTheme] = useThemePreference()
        // 预演要选工作区：默认取最近活跃的那个，所以排序在这里做一次（store 不碰快照）。
        const previewWorkspaces = useMemo(
          () => [...(snapshot?.workspaces ?? [])].sort((left, right) => (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0)),
          [snapshot],
        )
        const {
          previewPreset,
          setPreviewPreset,
          preview,
          previewStatus,
          previewError,
          previewTab,
          setPreviewTab,
          fetchPreview,
          runPreview,
          previewWorkspacePath,
          setPreviewWorkspacePath,
          previewPermissionPreset,
          setPreviewPermissionPreset,
          previewDraft, setPreviewDraft, applyDraft,
        } = previewStore.usePreviewStore(previewWorkspaces)
        const editorState = editorStore.useEditorStore({ fetchPreview, workspaces: previewWorkspaces })
        const templateState = useTemplateStore({
          runtimeCtx,
          snapshot,
          reloadSnapshot: load,
          editorState,
        })
        const workspacePicker = useWorkspacePicker(runtimeCtx)
        /** 预演页：新建或切换工作区后直接成为条件并重算；取消 / 失败保持原条件。 */
        const browsePreviewWorkspace = async () => {
          const picked = await workspacePicker.pick()
          if (picked === null) return
          void load({ silent: true })
          setPreviewWorkspacePath(picked)
        }
        /** 定制页：选中工作区等于切换基线；有未保存改动时由既有确认条接管。 */
        const browseEditWorkspace = async () => {
          const picked = await workspacePicker.pick()
          if (picked === null) return
          void load({ silent: true })
          templateState.requestBaselineChange({ workspacePath: picked })
        }
        const { influenceById: sessionInfluence, statusById: sessionInfluenceStatus, loadSessionInfluence } = influence.useSessionInfluenceStore()
        // 两处长文本页各有一份页内搜索：会话详情与预演看的不是同一份内容，词也不该互相串。
        const sessionSearch = search.useSearchState()
        const previewSearch = search.useSearchState()
        const { status: activityStatus, data: activityData, error: activityError, load: loadActivity } = activity.useActivityStore()
        const controlStore = control.useControlStore()
        // 禁用预演：目标与结果都在这个 store 里；页面只负责切标签与传条件。
        const disableState = disablePreview.useDisablePreviewStore()
        // 只属于「怎么摆」的 UI 状态，不进 store：换了视图就该重置。
        const [view, setView] = useState('plugins')
        const [query, setQuery] = useState('')
        const [category, setCategory] = useState(null)
        const [layer, setLayer] = useState(null)
        const [only, setOnly] = useState(null)
        const [selected, setSelected] = useState(null)
        const [openSession, setOpenSession] = useState(null)
        const [focusTool, setFocusTool] = useState(null)
        const [focusSection, setFocusSection] = useState(null)
        // 被定位的名字种类与来源：预演页据此选标签页，并在顶部说明「从哪跳来」。
        const [focusKind, setFocusKind] = useState(null)
        const [focusOrigin, setFocusOrigin] = useState(null)
        // 从健康条点「未归属段落」进来时，预演页只看没有归属的段。
        const [previewOnlyUnowned, setPreviewOnlyUnowned] = useState(false)
        const [toolOwner, setToolOwner] = useState(null)
        const [onlyDisabledTools, setOnlyDisabledTools] = useState(false)
        // 折叠集合：分组（category id）与工作区（workspace id）各自记一份。
        // 用「记录已折叠的」而不是「记录已展开的」，这样新增分组默认展开。
        const [collapsedCategories, setCollapsedCategories] = useState(() => new Set())
        const [collapsedWorkspaces, setCollapsedWorkspaces] = useState(() => new Set())
        // 会话时间范围：0=全部，其余是「最近 N 天」。
        const [recentDays, setRecentDays] = useState(0)
        // 会话的工作区筛选：null=全部，工作区 id 或 '__ungrouped'（未归属）。
        // 与时间范围、搜索同时生效，三者是并列的筛选条件，互不覆盖。
        const [workspaceFilter, setWorkspaceFilter] = useState(null)
        // 工具 schema 的原文开关：键是 `来源:工具名`，逐个工具切换，详见 client.schema.js。
        const [schemaRaw, setSchemaRaw] = useState(() => new Set())

        useEffect(() => { if (typeof openSession === 'string') void loadSessionInfluence(openSession) }, [openSession, loadSessionInfluence])
        /** 切换主标签。搜索与来源筛选跨视图没有意义；切标签就清掉。 */
        const switchView = (next) => {
          if (next === view) return
          setQuery('')
          setToolOwner(null)
          setPreviewOnlyUnowned(false)
          setFocusTool(null)
          setFocusSection(null)
          setFocusKind(null)
          setFocusOrigin(null)
          setView(next)
        }

        /**
         * 进入禁用预演且还没有目标时，默认选中本插件（控制台自身）。
         *
         * 只自动选一次：用户把选择器清空后不再抢回；从插件页跳进来的目标
         * 已经有 rowId，也原样保留。
         */
        const disableAutoTargetDone = useRef(false)
        useEffect(() => {
          if (disableAutoTargetDone.current || view !== 'disable') return
          if (disableState.rowId !== null) {
            disableAutoTargetDone.current = true
            return
          }
          const entries = snapshot?.entries ?? []
          const own = entries.find((entry) => entry.rowId === 'plugin-console')
            ?? entries.find((entry) => entry.moduleName === '@cheemsup/dsh-plugin-console')
          if (own === undefined) return
          disableAutoTargetDone.current = true
          disableState.choose(own.rowId)
        }, [view, snapshot, disableState.rowId, disableState.choose])

        /**
         * 跳到插件视图并展开某个条目。
         *
         * 会清空筛选与搜索，否则目标可能被当前过滤条件藏起来——跳转失败
         * 比跳转后丢失筛选更糟。
         * @param {string} rowId - 目标条目的行 id。
         */
        const gotoPlugin = (rowId) => {
          setCategory(null)
          setLayer(null)
          setOnly(null)
          setQuery('')
          setToolOwner(null)
          setFocusTool(null)
          setFocusSection(null)
          setFocusKind(null)
          setFocusOrigin(null)
          setView('plugins')
          // 用 rowId 定位：同一模块可能有多行，rowId 是唯一的
          setSelected('row:' + rowId)
        }

        /** 跳到工具视图并展开某个工具。 */
        const gotoTool = (name) => {
          setQuery('')
          setToolOwner(null)
          setView('tools')
          setFocusTool(name)
          setFocusSection(null)
          setFocusKind(null)
          setFocusOrigin(null)
        }

        /**
         * 跳到预演页并展开某一段（提示词页已并入预演）。
         *
         * `kind` 由调用方给出时直接用；没有时按「当前预演 → 全局注册表」推断。
         * 预演的上下文可能只存在于 runtime-context 的消息分段里，所以 context 的
         * 判定必须同时看 `preview.contexts` 与 `preview.messages[].parts`。
         * @param {string} name - 目标名字（具体名，不是源码模板）。
         * @param {'section' | 'context'} [kind] - 调用方已知的种类。
         * @param {string} [originLabel] - 来源插件名；用于预演页顶部说明。
         */
        const gotoSection = (name, kind, originLabel) => {
          setQuery('')
          setToolOwner(null)
          setPreviewOnlyUnowned(false)
          const inPreviewSections = (preview?.sections ?? []).some((row) => row.name === name)
          const inPreviewContexts = (preview?.contexts ?? []).some((row) => row.name === name)
            || (preview?.messages ?? []).some((message) => (message.parts ?? []).some((part) => part.name === name))
          const inGlobalSections = (snapshot?.prompt?.sections ?? []).some((row) => row.name === name)
          const inGlobalContexts = (snapshot?.prompt?.contexts ?? []).some((row) => row.name === name)
          // 同名时提示词段优先；否则先看上下文，再看两边都没有时的默认标签。
          const resolved = kind === 'context' || kind === 'section'
            ? kind
            : (inPreviewSections || inGlobalSections ? 'section' : (inPreviewContexts || inGlobalContexts ? 'context' : 'section'))
          setPreviewTab(resolved === 'context' ? 'messages' : 'prompt')
          // 从插件页跳过来时编辑器可能还开着；先回到预演，否则目标段落在编辑器里不可见。
          editorState.setEditing(false)
          setView('preview')
          setFocusSection(name)
          setFocusKind(resolved)
          setFocusOrigin(typeof originLabel === 'string' && originLabel !== '' ? { name, label: originLabel } : null)
          setFocusTool(null)
        }

        /** 跳到工具页并只看未归属工具。 */
        const gotoToolsUnattributed = () => {
          setQuery('')
          setToolOwner('__none')
          setView('tools')
          setFocusTool(null)
          setFocusSection(null)
          setFocusKind(null)
          setFocusOrigin(null)
        }

        /** 跳到预演页并只看未归属段落。 */
        const gotoPromptUnattributed = () => {
          setQuery('')
          setToolOwner('__none')
          setPreviewOnlyUnowned(true)
          setPreviewTab('prompt')
          editorState.setEditing(false)
          setView('preview')
          setFocusTool(null)
          setFocusSection(null)
          setFocusKind(null)
          setFocusOrigin(null)
        }

        /** 跳到「插件禁用预演」页并选中一个插件；目标由 store 懒加载。 */
        const gotoDisablePreview = (rowId) => {
          if (typeof rowId !== 'string' || rowId === '') return
          setQuery('')
          setToolOwner(null)
          setFocusTool(null)
          setFocusSection(null)
          setFocusKind(null)
          setFocusOrigin(null)
          setPreviewOnlyUnowned(false)
          editorState.setEditing(false)
          setView('disable')
          disableState.choose(rowId)
        }

        /**
         * 进入 / 离开定制编辑器。
         *
         * 离开时把搜索清掉：那个词是编辑器用来筛段落的，回到预演页后没有
         * 对应的可筛对象。进入时重置工具的「仅看已禁用」。
         * @param {boolean} next - 是否进入编辑器。
         */
        const setEditing = (next) => {
          if (next) setOnlyDisabledTools(false)
          else setQuery('')
          editorState.setEditing(next)
        }

        /** 清空插件页的所有筛选，用于空结果时的出口。 */
        const clearPluginFilters = () => {
          setCategory(null)
          setLayer(null)
          setOnly(null)
          setQuery('')
        }

        /** 手动刷新：快照与已加载的活动一起重取。 */
        const refresh = () => {
          void load()
          if (activityStatus !== 'idle') void loadActivity()
        }

        // 预演页：只有它自己要展示时才求值，且只在「还没算过」时自动算一次。
        //
        // 两个前置条件都有理由：等快照到位，因为默认工作区来自 `snapshot.workspaces`，
        // 早跑一次就会缺 cwd 条件；只在 idle 时触发，否则失败后状态在 error ↔ loading
        // 之间来回，effect 会把一次失败变成无限重试。重试交给页面上的按钮。
        useEffect(() => {
          if (view !== 'preview' || preview !== null || previewStatus !== 'idle' || snapshot === null) return
          void runPreview(previewPreset)
        }, [view, preview, previewStatus, previewPreset, runPreview, snapshot])

        // 活动只在插件/工具视图可见时读一次；失败只影响活动栏，不影响快照。
        useEffect(() => {
          if (view !== 'plugins' && view !== 'tools') return
          if (activityStatus !== 'idle') return
          void loadActivity()
        }, [view, activityStatus, loadActivity])

        // 快照静默刷新后，已选目标的数字可能过期。只在 generatedAt 真的变了时重算一次；
        // 选择目标那次由 `choose` 自己发请求，这里不能重复发，否则每次筛选都双倍计算。
        const disableStamp = useRef(null)
        useEffect(() => {
          if (snapshot === null) return
          const stamp = snapshot.generatedAt
          if (disableStamp.current === null) {
            disableStamp.current = stamp
            return
          }
          if (disableStamp.current === stamp) return
          disableStamp.current = stamp
          if (view === 'disable' && disableState.rowId !== null) disableState.reload()
        }, [snapshot, view])

        // 跳转到工具/提示词后把目标滚进视野。与插件详情的滚动同一套理由：
        // 滚动容器是 .ptBody 而不是 window，交给 scrollIntoView 自己找。
        useEffect(() => {
          const target = focusTool === null ? (focusSection === null ? null : 'pt-section-focus') : 'pt-tool-focus'
          if (target === null) return
          const node = document.getElementById(target)
          if (node === null || typeof node.scrollIntoView !== 'function') return
          node.scrollIntoView({ block: 'center', behavior: 'auto' })
        }, [focusTool, focusSection, view, preview, previewStatus])

        // 全部会话按 id 索引：派发树要跨工作区反查父/子，不能只看当前分组里的。
        const allSessions = useMemo(() => {
          const map = new Map()
          for (const workspace of snapshot?.workspaces ?? []) {
            for (const session of workspace.sessions ?? []) map.set(session.id, session)
          }
          for (const session of snapshot?.ungroupedSessions ?? []) map.set(session.id, session)
          return map
        }, [snapshot])

        const entries = useMemo(() => (snapshot?.entries ?? []).filter((entry) => !isStructural(entry)), [snapshot])
        const byId = useMemo(() => new Map((snapshot?.entries ?? []).map((entry) => [entry.entryId, entry])), [snapshot])
        const changeSet = useMemo(() => changes?.diffSnapshots?.(previous, snapshot) ?? null, [changes, previous, snapshot])

        const filtered = useMemo(() => {
          return entries.filter((entry) => {
            if (category !== null && entry.category !== category) return false
            if (layer !== null && entry.layer !== layer) return false
            if (only === 'failed' && entry.phase !== 'failed') return false
            if (only === 'disabled' && entry.enabled) return false
            if (only === 'missing') {
              if (!entry.enabled) return false
              const missing = (entry.requires ?? []).some((name) => (snapshot?.services?.[name]?.providers ?? []).length === 0)
              if (!missing) return false
            }
            if (only === 'unregistered' && (entry.effects?.length ?? 0) > 0) return false
            return search.matchesQuery(query, [entry.rowId, entry.moduleName, entry.packageName, entry.title, entry.description])
          })
        }, [entries, category, layer, only, query, snapshot])

        const categories = useMemo(() => {
          const counts = new Map()
          for (const entry of entries) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)
          return [...counts.entries()]
            .map(([id, count]) => ({ id, count, label: CATEGORY_LABELS[id] ?? id }))
            .sort((left, right) => right.count - left.count)
        }, [entries])

        const layers = useMemo(() => {
          const counts = new Map()
          for (const entry of entries) counts.set(entry.layer, (counts.get(entry.layer) ?? 0) + 1)
          return [...counts.entries()].map(([id, count]) => ({ id, count, label: layerLabel(id) }))
        }, [entries])

        const statusCounts = useMemo(() => ({
          disabled: entries.filter((entry) => !entry.enabled).length,
          failed: entries.filter((entry) => entry.phase === 'failed').length,
          missing: entries.filter((entry) => entry.enabled && (entry.requires ?? []).some((name) => (snapshot?.services?.[name]?.providers ?? []).length === 0)).length,
          unregistered: entries.filter((entry) => (entry.effects?.length ?? 0) === 0).length,
        }), [entries, snapshot])

        /**
         * 面板级快捷键：`/` 聚焦搜索，Escape 逐层收起。
         *
         * 只在事件冒泡到根节点、且焦点不在输入控件里时生效——编辑器里的
         * 文本框必须能正常输入斜杠和退出键。
         * @param {object} event - 键盘事件。
         */
        const handleKeyDown = (event) => {
          if (isTypingTarget(event.target)) return
          if (event.key === 'Escape') {
            if (selected !== null) setSelected(null)
            else if (openSession !== null) setOpenSession(null)
            else if (query !== '') setQuery('')
            return
          }
          if (event.key !== '/') return
          const node = event.currentTarget.querySelector('.ptSearch')
          if (node === null) return
          event.preventDefault()
          node.focus()
        }

        /** 视图上下文：状态值 + setter + 动作 + 派生值。视图只读它。 */
        const vc = {
          ...editorState,
          ...templateState,
          setEditing,
          previewPreset,
          setPreviewPreset,
          preview,
          previewStatus,
          previewError,
          previewTab,
          setPreviewTab,
          runPreview,
          previewWorkspaces,
          previewWorkspacePath,
          setPreviewWorkspacePath,
          // 两个页面的「新建工作区」走同一个 hook；一次只允许一个系统对话框在跑。
          workspacePicker: {
            preview: browsePreviewWorkspace,
            edit: browseEditWorkspace,
            busy: workspacePicker.busy,
            error: workspacePicker.error,
          },
          previewPermissionPreset,
          setPreviewPermissionPreset,
          previewDraft, setPreviewDraft, applyDraft,
          snapshot,
          status,
          error,
          activity: activityData,
          activityStatus,
          activityError,
          loadActivity,
          control: controlStore,
          disablePreview: disableState,
          changes: changeSet,
          query,
          setQuery,
          view,
          setView: switchView,
          category,
          setCategory,
          layer,
          setLayer,
          only,
          setOnly,
          selected,
          setSelected,
          openSession, setOpenSession,
          sessionInfluence, sessionInfluenceStatus,
          sessionSearch,
          previewSearch,
          focusTool,
          focusSection,
          focusKind,
          focusOrigin,
          previewOnlyUnowned,
          setPreviewOnlyUnowned,
          toolOwner,
          setToolOwner,
          onlyDisabledTools,
          setOnlyDisabledTools,
          collapsedCategories,
          setCollapsedCategories,
          collapsedWorkspaces,
          setCollapsedWorkspaces,
          recentDays,
          setRecentDays,
          workspaceFilter,
          setWorkspaceFilter,
          schemaRaw,
          setSchemaRaw,
          allSessions,
          entries,
          byId,
          filtered,
          categories,
          layers,
          statusCounts,
          load,
          clearPluginFilters,
          gotoPlugin,
          gotoTool,
          gotoSection,
          gotoToolsUnattributed,
          gotoPromptUnattributed,
          gotoDisablePreview,
        }
        const inEditor = view === 'preview' && editorState.editing
        // 占位符跟着子标签走：预演页的四个标签能筛的东西不同，不能共用一句话。
        const searchHint = search.searchHint({ view, editing: inEditor, previewTab })
        // 请求结构没有可筛的列表：页头把词一次性交给下方的文本检索，之后两边互不同步。
        const handoff = view === 'preview' && previewTab === 'raw' && !inEditor
        const handoffQuery = search.normalizeQuery(query)
        const sendQueryToSearch = () => {
          if (handoffQuery === '') return
          previewSearch.add(query.trim())
          setQuery('')
        }
        return h(
          'div',
          { className: 'ptRoot', 'data-pt-theme': theme, onKeyDown: handleKeyDown },
          h(
            'header',
            { className: 'ptBar' },
            h(
              'div',
              { className: 'ptHead' },
              h('h1', { className: 'ptTitle' }, '插件控制台'),
              h(
                'span',
                { className: 'ptSub' },
                snapshot ? 'profile ' + (snapshot.profile.name ?? '—') + ' · ' + formatTime(snapshot.generatedAt) + ' · 快照 ' + formatAge(lastLoadedAt ?? Date.parse(snapshot.generatedAt)) : '正在读取宿主组合…',
              ),
              h('span', { className: 'ptSpacer' }),
              themeSwitch(theme, setTheme),
              h(
                'button',
                { type: 'button', className: 'ptBtn', onClick: refresh, disabled: status === 'loading' },
                status === 'loading' ? '刷新中…' : '刷新',
              ),
            ),
            // 搜索固定在页头最上方，所有视图共用同一个入口；各页工具条只放自己的筛选器。
            h(
              'div',
              { className: 'ptSearchRow', style: handoff ? { flexDirection: 'column', alignItems: 'stretch', gap: '4px' } : undefined },
              h('input', {
                className: 'ptSearch ptSearchTop',
                type: 'search',
                placeholder: searchHint,
                value: query,
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => {
                  // 请求结构标签：回车把词交给下方文本检索，页头随后清空。
                  if (handoff && event.key === 'Enter') {
                    event.preventDefault()
                    sendQueryToSearch()
                    return
                  }
                  if (event.key !== 'Escape') return
                  event.stopPropagation()
                  setQuery('')
                  event.currentTarget.blur()
                },
                'aria-label': searchHint,
              }),
              handoff
                ? h(
                    'div',
                    { className: 'ptSearchHandoff' },
                    h('span', { className: 'ptHint', style: { margin: 0 } }, '请求结构用下方文本检索定位；回车把当前词加入标记'),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ptTextBtn',
                        disabled: handoffQuery === '',
                        onClick: sendQueryToSearch,
                        title: '把页头的词加进下方「文本检索」，然后清空这里',
                      },
                      '标记此词',
                    ),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'ptTabs', role: 'tablist', 'aria-label': '插件控制台视图' },
              tabButton('plugins', '插件', view, switchView, snapshot ? entries.length : undefined),
              tabButton('sessions', '会话', view, switchView, snapshot ? allSessions.size : undefined),
              tabButton('tools', '工具', view, switchView, snapshot?.tools?.attributed?.length),
              tabButton('preview', '上下文预演', view, switchView),
              tabButton('disable', '插件禁用预演', view, switchView),
            ),
            // 快照未到位或处于定制编辑器时没有页内筛选器；空工具条不占位置。
            snapshot === null || inEditor
              ? null
              : h(
                  'div',
                  { className: 'ptToolbar' },
                  view === 'plugins'
                    ? pluginFilters.renderPluginFilters(vc)
                    : view === 'sessions'
                      ? sessions.renderSessionFilters(vc)
                      : view === 'tools'
                        ? tools.renderToolFilters(vc)
                        : view === 'preview'
                          ? previewView.renderPreviewFilters(vc)
                          : view === 'disable'
                            ? disablePreview.renderDisablePreviewFilters(vc)
                            : null,
                ),
          ),
          h(
            'div',
            {
              className: 'ptBody',
              id: 'pt-panel',
              role: 'tabpanel',
              'aria-labelledby': 'pt-tab-' + view,
            },
            renderBody(vc),
          ),
        )
      }

      /**
       * 视图分发。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderBody(vc) {
        const { status, error, snapshot, view, load } = vc
        if (status === 'error') {
          return h(
            'div',
            { className: 'ptNotice' },
            h('p', { className: 'ptError' }, error),
            h('button', { type: 'button', className: 'ptBtn', onClick: () => void load(), style: { marginTop: '12px' } }, '重试'),
          )
        }
        if (!snapshot) {
          return h('div', { 'aria-busy': 'true' }, Array.from({ length: 10 }, (_v, index) => h('div', { key: index, className: 'ptSkeleton' })))
        }
        if (view === 'sessions') return sessions.renderSessionsView(vc)
        if (view === 'tools') return tools.renderToolsView(vc)
        if (view === 'disable') return disablePreview.renderDisablePreviewView(vc)
        if (view === 'preview') {
          // 定制模式接管整页：先在预演里看清最终构造，再决定怎么改并发送。
          if (vc.editing) return editor.renderTemplateEditorView(vc)
          return previewView.renderPreviewView(vc)
        }
        return plugins.renderPluginsView(vc)
      }

      return PluginTreePage
    }
  },
})
