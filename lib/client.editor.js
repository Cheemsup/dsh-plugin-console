/**
 * 定制编辑器：把「预演」页看到的构造真正变成可改、可存、可应用的东西。
 *
 * 数据变换（草稿指纹 / 基线 → 草稿 / 草稿 → 配方）在 `client.draft.js` 里，
 * 是三个不碰 React 的纯函数；本文件只做渲染，状态与动作全部来自视图上下文 `vc`。
 *
 * 分区顺序就是操作顺序：
 *   返回 → 提示词定制模板 → 基准模式 → 逐段原文 → 追加段落 → 工具 → 预览定制结果 → 应用到会话 → 清理数据。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.editor.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-console',
  chunk: 'client.editor.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const {
        modeTitle, formatBytes, textButton, chip2, foldNodes, setDetailsOpen, samePath, draft, cleanupUi, templateCard, messageEditors, previewView, search,
      } = deps

      /** 一段在草稿里的当前文本。 */
      function draftText(section, draftSections) {
        return draftSections[section.name] ?? draft.baselineText(section)
      }

      /**
       * 定制页内的只读预览：用当前草稿（不是已保存模板）求一次首请求。
       *
       * 复用预演页的四个标签，但不显示页底「定制上下文」入口——已经在编辑器里了。
       */
      function renderAppliedPreview(vc) {
        const overrides = vc.editAppliedPreview?.overrides
        const applied = overrides === undefined
          ? []
          : [
              (overrides.sections ?? []).length > 0 ? '段 ' + overrides.sections.length : null,
              (overrides.contexts ?? []).length > 0 ? '上下文 ' + overrides.contexts.length : null,
              (overrides.messages ?? []).length > 0 ? '消息 ' + overrides.messages.length : null,
              (overrides.tools ?? []).length > 0 ? '工具 ' + overrides.tools.length : null,
              overrides.appended === true ? '追加段落' : null,
            ].filter((item) => item !== null)
        return h(
          'div',
          null,
          h(
            'div',
            { className: 'ptCardRow', style: { marginBottom: '10px' } },
            textButton('← 返回编辑', () => vc.closeApplied(), { title: '回到提示词定制页面' }),
          ),
          // 这是定制页内的一个独立视图：用页面级标题说明「现在看到的是什么」，
          // 不再用一句小字解释「只预览、不保存」——标题本身已经回答了。
          h('h2', { className: 'ptPageTitle' }, '提示词定制结果预览'),
          applied.length > 0
            ? h('p', { className: 'ptHint', style: { margin: '0 0 8px' } }, '已叠加：' + applied.join(' · '))
            : null,
          previewView.renderPreviewView({
            ...vc,
            preview: vc.editAppliedPreview,
            previewStatus: vc.editAppliedStatus,
            previewError: vc.editAppliedError,
            previewTab: vc.editAppliedTab,
            setPreviewTab: vc.setEditAppliedTab,
            runPreview: () => void vc.previewApplied(),
            previewPreset: vc.editPreset,
            previewDraft: undefined,
            setPreviewDraft: undefined,
            applyDraft: undefined,
            appliedPreview: true,
          }),
        )
      }

      /**
       * 提示词模板编辑器。
       *
       * 顶部三块各管一件事：返回、提示词定制模板、基准模式；正文默认收起，改动过的段自动展开。
       * 「应用到会话」与「清除提示词定制模板快照数据」放在最后，因为它们都是整份草稿之后才做的事。
       */
      function renderTemplateEditorView(vc) {
        const { editStatus, editPreview, editError, loadBaseline, editPreset } = vc
        if (vc.showingApplied === true) return renderAppliedPreview(vc)
        if (editStatus === 'loading' || (editStatus === 'idle' && editPreview === null)) {
          return h(
            'div',
            null,
            backRow(vc),
            templateCard.renderTemplateToolbar(vc),
            h('div', { 'aria-busy': 'true' }, Array.from({ length: 6 }, (_v, index) => h('div', { key: index, className: 'ptSkeleton' }))),
          )
        }
        if (editStatus === 'error') {
          return h(
            'div',
            null,
            backRow(vc),
            templateCard.renderTemplateToolbar(vc),
            h(
              'div',
              { className: 'ptNotice' },
              h('p', { className: 'ptError' }, editError),
              h('button', { type: 'button', className: 'ptBtn', style: { marginTop: '12px' }, onClick: () => void loadBaseline(editPreset) }, '重试'),
            ),
          )
        }
        const {
          draftSections, setDraftSections, draftAppend, setDraftAppend, draftDisabled, setDraftDisabled,
          query, onlyDisabledTools, setOnlyDisabledTools,
        } = vc
        const base = editPreview
        if (base === null) return h('p', { className: 'ptEmpty' }, '正在读取基础组合…')
        const tools = base.tools ?? []
        const sections = base.sections ?? []
        const completeName = base.completeSection ?? null
        const isCompleteMode = completeName !== null
        const changedSections = sections.filter((section) => draftText(section, draftSections) !== draft.baselineText(section))
        const needle = search.normalizeQuery(query)
        const visibleSections = sections.filter((section) => search.matchesQuery(query, [section.name, draftText(section, draftSections)]))
        const disabledCount = tools.filter((tool) => draftDisabled.has(tool.name)).length
        // 搜索也筛工具：README 一直写着编辑器用来「筛段落、消息与工具」，实现只兑现了前两类。
        const visibleTools = tools
          .filter((tool) => !onlyDisabledTools || draftDisabled.has(tool.name))
          .filter((tool) => search.matchesQuery(query, [tool.name, tool.description]))

        return h(
          'div',
          null,
          backRow(vc),
          templateCard.renderTemplateToolbar(vc),
          pendingPresetBar(vc),
          isCompleteMode
            ? h(
                'p',
                { className: 'ptHint' },
                h('span', { className: 'ptTag', 'data-tone': 'warn' }, '独占提示词'),
                ` 这个模式的提示词只有「${completeName}」一段（它声明了 complete），其余段落不会送达模型。这里只有一段可改，追加内容会并进这一段。`,
              )
            : null,
          h(
            'div',
            { className: 'ptSectionHead', style: { margin: '4px 0 2px' } },
            h('p', { className: 'ptSectionTitle', style: { margin: 0 } }, `逐段原文（${visibleSections.length} / ${sections.length} 段）`),
            changedSections.length ? h('span', { className: 'ptTag', 'data-tone': 'warn' }, changedSections.length + ' 段已改动') : null,
            h(
              'div',
              { className: 'ptActions' },
              textButton('折叠全部', () => setDetailsOpen(foldNodes(), false)),
              textButton('展开全部', () => setDetailsOpen(foldNodes(), true)),
            ),
          ),
          // 常态下不再放说明行；只有搜索把段落藏起来时才需要一句解释。
          needle
            ? h('p', { className: 'ptHint', style: { margin: '0 0 6px' } }, '只显示匹配搜索的段落。')
            : null,
          visibleSections.length
            ? visibleSections.map((section) => sectionEditor(section, vc, needle !== ''))
            : h('p', { className: 'ptEmpty' }, '没有匹配的段落。'),
          h(
            'div',
            { className: 'ptCard', style: { marginTop: '14px' } },
            h(
              'div',
              { className: 'ptCardHead' },
              h('p', { className: 'ptCardTitle' }, '追加段落'),
              // 只有独占提示词模式需要说明落点：常态下追加就排在基线段落之后。
              isCompleteMode ? h('span', { className: 'ptMeta' }, '并进独占段末尾') : null,
            ),
            h('textarea', {
              className: 'ptEditor',
              value: draftAppend,
              placeholder: '例如：改代码前先读 README',
              onChange: (event) => setDraftAppend(event.target.value),
            }),
          ),
          messageEditors.renderMessageEditors(vc),
          h(
            'div',
            { className: 'ptSectionHead', style: { margin: '18px 0 2px' } },
            h('p', { className: 'ptSectionTitle', style: { margin: 0 } }, needle === '' ? `工具（${tools.length} 个）` : `工具（${visibleTools.length} / ${tools.length} 个）`),
            disabledCount ? h('span', { className: 'ptTag', 'data-tone': 'warn' }, '已禁用 ' + disabledCount) : null,
            h(
              'div',
              { className: 'ptActions' },
              chip2('仅看已禁用', onlyDisabledTools, () => setOnlyDisabledTools(!onlyDisabledTools)),
              disabledCount ? textButton('全部启用', () => setDraftDisabled(new Set())) : null,
            ),
          ),
          h('p', { className: 'ptHint', style: { margin: '0 0 6px' } }, '取消勾选会把工具从模型可见集合里去掉，并拒绝其执行'),
          visibleTools.length
            ? h(
                'div',
                { className: 'ptToolGrid' },
                visibleTools.map((tool) => {
                  const on = !draftDisabled.has(tool.name)
                  const toggle = () => setDraftDisabled((previous) => {
                    const next = new Set(previous)
                    if (next.has(tool.name)) next.delete(tool.name)
                    else next.add(tool.name)
                    return next
                  })
                  return h(
                    'div',
                    { key: tool.name, className: 'ptToolCheck', 'data-off': on ? 'false' : 'true', title: tool.description ?? '' },
                    h('input', { type: 'checkbox', checked: on, onChange: toggle }),
                    h('code', { onClick: toggle, style: { cursor: 'pointer' } }, search.markQuery(tool.name, query)),
                  )
                }),
              )
            : needle === ''
              ? h('p', { className: 'ptEmpty' }, onlyDisabledTools ? '没有已禁用的工具。' : '没有工具。')
              : search.renderQueryEmpty({ noun: '工具', onClear: () => vc.setQuery('') }),
          // 预览是整份草稿之后的下一个动作，但不是提交：用次级大按钮。
          // 页面上唯一的实底主按钮留给最后的「应用并发送」。
          h(
            'div',
            { className: 'ptBottomAction', style: { margin: '16px 0 2px' } },
            h(
              'button',
              {
                type: 'button',
                className: 'ptBtn ptBtnLarge',
                title: '调用首请求预演查看结果',
                onClick: () => void vc.previewApplied(),
              },
              '预览定制结果',
            ),
          ),
          applyPanel(vc),
          cleanupUi?.renderCleanupCard?.(vc) ?? null,
        )
      }

      /** 单独一行返回，不再和提示词定制模板选择、基准模式夹在同一行。 */
      function backRow(vc) {
        return h(
          'div',
          { className: 'ptCardRow', style: { marginBottom: '10px' } },
          textButton('← 返回预演', () => vc.setEditing(false), { title: '回到最终构造，不保存当前改动' }),
        )
      }

      /** 一段可折叠的原文编辑框。 */
      function sectionEditor(section, vc, keepOpen) {
        const { draftSections, setDraftSections } = vc
        const baseline = draft.baselineText(section)
        const current = draftText(section, draftSections)
        const changed = current !== baseline
        return h(
          'details',
          // 搜索时展开命中项；改动过的段也默认展开，让「改了什么」就在眼前。
          { key: section.name, className: 'ptFold ptFoldable', ...(keepOpen || changed ? { open: true } : {}) },
          h(
            'summary',
            null,
            h('span', { className: 'ptPromptName' }, section.name),
            changed ? h('span', { className: 'ptTag', 'data-tone': 'warn' }, current.length === 0 ? '已清空' : '已改动') : null,
            h('span', { className: 'ptFoldMeta' }, formatBytes(current.length)),
            changed
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ptTextBtn',
                    onClick: (event) => {
                      // summary 里不放 action 的话，还原会连带展开/收起；这里截断。
                      event.preventDefault()
                      event.stopPropagation()
                      setDraftSections((previous) => ({ ...previous, [section.name]: baseline }))
                    },
                  },
                  '还原',
                )
              : null,
          ),
          h('textarea', {
            className: 'ptEditor',
            style: { minHeight: '64px', border: 0, borderRadius: 0, resize: 'vertical' },
            value: current,
            onChange: (event) => setDraftSections((previous) => ({ ...previous, [section.name]: event.target.value })),
          }),
        )
      }

      /**
       * 切换基准模式的确认条。
       *
       * 只在有未保存改动、且用户真的点了别的模式时出现。三条出路：
       * 丢掉改动用新模式、先保存再切、取消。
       */
      function pendingPresetBar(vc) {
        const {
          pendingBaselineChange, setPendingBaselineChange, commitBaselineChange,
          snapshot, previewWorkspaces, recipeFromDraft, saveTemplate,
        } = vc
        if (pendingBaselineChange === undefined) return null
        const change = pendingBaselineChange
        const label = change.presetId !== undefined
          ? (change.presetId === null
              ? '默认模式'
              : modeTitle((snapshot.modes ?? []).find((mode) => mode.id === change.presetId) ?? { id: change.presetId }))
          : change.workspacePath !== undefined
            ? '工作区 ' + ((previewWorkspaces ?? []).find((workspace) => samePath(workspace.path, change.workspacePath))?.title ?? change.workspacePath)
            : '权限 ' + (change.permissionPreset ?? '默认')
        return h(
          'div',
          { className: 'ptCard ptWarnCard' },
          h(
            'div',
            { className: 'ptCardHead' },
            h('p', { className: 'ptCardTitle' }, '切换前确认'),
            h('span', { className: 'ptHint', style: { margin: 0 } }, '切到「' + label + '」会丢掉当前未保存的改动。'),
          ),
          h(
            'div',
            { className: 'ptCardRow' },
            h('button', {
              type: 'button',
              className: 'ptBtn',
              onClick: () => commitBaselineChange(change),
            }, '丢弃改动并切换'),
            h('button', {
              type: 'button',
              className: 'ptBtn',
              'data-tone': 'primary',
              onClick: () => {
                // 用刚算出的 recipe 直接重放，而不是等 setTemplateRecipe 落地：
                // 状态更新是异步的，loadBaseline 的闭包里还拿不到新的那份。
                // 草稿还是新模板时，saveTemplate 会先把它生成出来。
                const saved = recipeFromDraft()
                void saveTemplate()
                commitBaselineChange(change, saved)
              },
            }, '先保存再切换'),
            textButton('取消', () => setPendingBaselineChange(undefined)),
          ),
        )
      }

      /**
       * 「应用到会话」：把当前提示词模板落到一个真会话上，并直接发送首句。
       *
       * 放在页面最下方：编辑区很长，动作必须在「改完」之后出现。这里只保留
       * 直接发送模式——建好会话、物化提示词模板、立刻发送，不再有「只填不发送」的分叉。
       */
      function applyPanel(vc) {
        const {
          snapshot, effectiveWorkspacePath, applyPrompt, setApplyPrompt,
          applyPhase, applyNotice, setApplyNotice, applyTemplate,
        } = vc
        const workspaces = snapshot.workspaces ?? []
        const targetWorkspace = workspaces.find((workspace) => samePath(workspace.path, effectiveWorkspacePath))
        const targetText = effectiveWorkspacePath === null || effectiveWorkspacePath === undefined
          ? '未指定工作区：由宿主决定'
          : targetWorkspace !== undefined
            ? '将建在：' + (targetWorkspace.title ?? targetWorkspace.path) + ' · ' + targetWorkspace.path
            // 自定义目录没有工作区 id，建会话时只能落回当前工作区；别把预演条件说成目标位置。
            : '路径「' + effectiveWorkspacePath + '」未注册：只用于预演与基线，应用时新会话落在当前工作区'
        const busy = applyPhase === 'saving' || applyPhase === 'creating' || applyPhase === 'applying'
        const phaseText = applyPhase === 'saving'
          ? '保存提示词模板…'
          : applyPhase === 'creating'
            ? '建会话…'
            : applyPhase === 'applying'
              ? '物化提示词模板…'
              : '应用并发送'
        const hasPrompt = applyPrompt.trim().length > 0

        return h(
          'div',
          { className: 'ptCard' },
          h(
            'div',
            { className: 'ptCardHead' },
            h('p', { className: 'ptCardTitle' }, '应用到会话'),
            h('span', { className: 'ptMeta' }, '工作区在页面级「工作区与权限」里切换'),
          ),
          h(
            'p',
            { className: 'ptHint', style: { margin: 0 } },
            targetText,
          ),
          h('textarea', {
            className: 'ptEditor',
            style: { minHeight: '52px' },
            value: applyPrompt,
            placeholder: '输入首条消息',
            onChange: (event) => setApplyPrompt(event.target.value),
          }),
          h(
            'div',
            { className: 'ptCardRow' },
            h(
              'div',
              { className: 'ptCardActions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ptBtn',
                  'data-tone': 'primary',
                  disabled: busy || !hasPrompt,
                  title: hasPrompt ? undefined : '先写第一条消息',
                  onClick: () => {
                    if (busy) return
                    if (!hasPrompt) {
                      setApplyNotice('直接发送需要先写首句')
                      return
                    }
                    void applyTemplate()
                  },
                },
                busy ? phaseText : '应用并发送',
              ),
            ),
          ),
          applyNotice !== null
            ? h('p', { className: applyPhase === 'error' ? 'ptError' : 'ptSub', style: { margin: 0 } }, applyNotice)
            : null,
        )
      }

      return {
        ...draft,
        renderTemplateEditorView,
        pendingPresetBar,
        applyPanel,
      }
    }
  },
})
