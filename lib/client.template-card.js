/**
 * 定制编辑器顶部的两张卡片：提示词定制模板与预设的基准模式。
 *
 * 与编辑器正文拆开：这两张卡片只回答「用哪份模板、跑在哪个模式上」的具体选择，
 * 正文回答「具体改了什么」。数据与动作全部来自视图上下文 `vc`。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.template-card.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.template-card.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { modeTitle, selectField, workspaceField, samePath, textButton, formatAge, dialog } = deps

      /**
       * 提示词定制模板与基准模式各用一个卡片。
       *
       * 第一张管提示词定制模板本身（选择 / 重命名 / 保存 / 删除），第二张管预设的基准模式。
       * 下拉框第一项「新模板」不是占位符：选中它就能直接改，保存时才生成模板头。
       * 它们是两件事：换模板不换基准，换基准会把整份草稿重填。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderTemplateToolbar(vc) {
        const {
          snapshot, templateList, templateId, nameDraft, setNameDraft,
          openTemplate, startNewTemplate, renameTemplate, requestPreset, editPreset, editStatus,
          templateSaving, dirty, saveTemplate, deleteTemplate, deletingId, setDeletingId, templateNotice,
          previewWorkspaces, effectiveWorkspacePath,
          editPermissionPreset, requestBaselineChange, editPreview, workspacePicker,
        } = vc
        const modes = snapshot.modes ?? []
        const current = templateList.find((template) => template.id === templateId) ?? null
        const shownName = nameDraft !== null ? nameDraft : (current?.name ?? '')
        // 已创建工作区在快照里；刚新建、快照未刷新时下拉会补一个「当前选择」项。
        const workspaceRegistered = (previewWorkspaces ?? []).some((workspace) => samePath(workspace.path, effectiveWorkspacePath))
        const workspaceUnregistered = typeof effectiveWorkspacePath === 'string'
          && effectiveWorkspacePath.length > 0 && !workspaceRegistered
        // 编辑器不显示整份预演警告，但工作区路径解析失败必须让用户看见。
        const workspaceWarnings = (editPreview?.warnings ?? []).filter((row) => String(row).includes('工作区'))
        // 最近更新的几个模板直接列出来：切模板不必先打开下拉再找一遍。
        const recentTemplates = [...templateList]
          .filter((template) => template.id !== templateId)
          .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
          .slice(0, 6)
        // 权限选项只有基线载入后才由宿主给出；定制页用自己的条件，不读预演页。
        const permissionOptions = editPreview?.conditions?.permission?.options ?? []
        const permissionValue = editPermissionPreset ?? editPreview?.conditions?.permission?.preset ?? ''

        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'ptCard' },
            h(
              'div',
              { className: 'ptCardHead' },
              h('p', { className: 'ptCardTitle' }, '提示词定制模板'),
              dirty ? h('span', { className: 'ptDirty' }, '未保存') : null,
            ),
            h(
              'div',
              { className: 'ptCardRow' },
              selectField('已选模板', templateId ?? '', [
                { value: '', label: '新模板' },
                ...templateList.map((template) => ({ value: template.id, label: template.name || '未命名' })),
              ], (value) => {
                // 选中项没变就什么都不做：下拉框的当前值就是 templateId（null 显示为「新模板」）。
                if (value === (templateId ?? '')) return
                if (value === '') {
                  startNewTemplate()
                  return
                }
                void openTemplate(value)
              }),
              h('span', { style: { flex: 1 } }),
              // 重命名与保存、删除同处右侧动作组：三者都是对「当前提示词模板」的操作。
              current === null ? null : textButton('重命名', () => setNameDraft(current.name)),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ptBtn',
                  title: current === null ? '把当前草稿生成成一个新模板' : undefined,
                  disabled: templateSaving || editStatus !== 'ready',
                  onClick: () => void saveTemplate(),
                },
                templateSaving ? '保存中…' : dirty ? '保存 *' : '保存',
              ),
              current === null
                ? null
                : h('button', { type: 'button', className: 'ptBtn', 'data-tone': 'danger', onClick: () => setDeletingId(current.id) }, '删除'),
            ),
            templateNotice !== null ? h('p', { className: 'ptSub', style: { margin: 0 } }, templateNotice) : null,
            // 最近更新的模板放在容器下方：切模板不必先打开下拉再找一遍。
            recentTemplates.length
              ? h(
                  'div',
                  { className: 'ptChipGroup' },
                  h('span', { className: 'ptFieldLabel' }, '最近更新'),
                  ...recentTemplates.map((template) => h(
                    'button',
                    {
                      key: template.id,
                      type: 'button',
                      className: 'ptTag ptLink',
                      title: typeof template.updatedAt === 'number' ? '更新于 ' + formatAge(template.updatedAt) : undefined,
                      onClick: () => void openTemplate(template.id),
                    },
                    template.name || '未命名',
                  )),
                )
              : null,
          ),
          h(
            'div',
            { className: 'ptCard' },
            h(
              'div',
              { className: 'ptCardHead' },
              h('p', { className: 'ptCardTitle', title: '提示词定制模板的规则在选定的基准模式上执行' }, '预设的基准模式'),
            ),
            h(
              'div',
              { className: 'ptCardRow' },
              // 选框里只写模式名：order 是排序依据，不是选模式时要比较的信息。
              selectField('基准模式', editPreset ?? '', modes.map((mode) => ({ value: mode.id, label: modeTitle(mode) })),
                (value) => requestPreset(value)),
            ),
            // 四个预设直接列在容器下方：换基准不必先打开下拉。
            modes.length
              ? h(
                  'div',
                  { className: 'ptChipGroup' },
                  modes.map((mode) => h(
                    'button',
                    {
                      key: mode.id,
                      type: 'button',
                      className: 'ptChip',
                      'aria-pressed': editPreset === mode.id ? 'true' : 'false',
                      title: editPreset === mode.id ? '当前基准模式' : '切到' + modeTitle(mode),
                      onClick: () => requestPreset(mode.id),
                    },
                    modeTitle(mode),
                  )),
                )
              : null,
          ),
          h(
            'div',
            { className: 'ptCard' },
            h(
              'div',
              { className: 'ptCardHead' },
              h('p', { className: 'ptCardTitle', title: '不同的条件选择可能影响下方可定制prompt的初始状态' }, '工作区与权限'),
            ),
            h(
              'div',
              { className: 'ptCardRow' },
              // 已创建工作区是常规选项；「新建工作区…」走系统选择器并登记到 DSH。
              workspaceField('工作区', effectiveWorkspacePath, previewWorkspaces, (value) => {
                requestBaselineChange({ workspacePath: value })
              }, workspacePicker?.edit, {
                title: '首请求的 cwd：skill 目录、AGENTS.md 链与 cwd / sandbox / approval 文本都由它决定；「新建工作区…」会把选中的目录登记为 DSH 工作区',
                ariaLabel: '工作区',
                busy: workspacePicker?.busy === true,
                error: workspacePicker?.error ?? null,
              }),
              permissionOptions.length > 0
                ? selectField('权限预设', permissionValue, permissionOptions.map((option) => ({ value: option.value, label: option.name })), (value) => {
                    if (value === '' || value === permissionValue) return
                    requestBaselineChange({ permissionPreset: value })
                  }, { title: '权限预设只决定 sandbox / approval 的预演文本；不改变应用到会话后的实际权限' })
                : h('span', { className: 'ptHint', style: { margin: 0 } }, '权限预设等基线载入后可用'),
            ),
            // 工作区条件解析失败的反馈：编辑器不显示整份预演警告，但路径问题必须说清楚。
            workspaceWarnings.length > 0
              ? h(
                  'p',
                  { className: 'ptHint', style: { margin: 0 } },
                  h('span', { className: 'ptError' }, workspaceWarnings.join(' ')),
                )
              : null,
            h(
              'p',
              { className: 'ptHint', style: { margin: 0 } },
              workspaceUnregistered
                ? '应用到会话时新会话落在当前工作区，权限预设只影响prompt（实际权限由DSH控制）'
                : '权限预设只影响prompt，不改变新会话的实际权限（实际权限由DSH控制）',
            ),
          ),
          // 二次操作放进弹窗：它们打断当前动作，留在卡片里会被当成又一段说明读过去。
          current !== null && nameDraft !== null
            ? dialog({
                id: 'pt-rename-title',
                title: '重命名提示词模板',
                body: h('input', {
                  className: 'ptSearch',
                  style: { width: '100%', maxWidth: 'none', height: '28px' },
                  value: shownName,
                  placeholder: '提示词模板名称',
                  autoFocus: true,
                  onChange: (event) => setNameDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter') return
                    if (shownName.trim().length === 0) return
                    void renameTemplate(current.id, shownName)
                  },
                }),
                confirmLabel: '确定',
                confirmDisabled: shownName.trim().length === 0,
                onConfirm: () => void renameTemplate(current.id, shownName),
                onCancel: () => setNameDraft(null),
              })
            : null,
          current !== null && deletingId === current.id
            ? dialog({
                id: 'pt-delete-title',
                title: '删除提示词模板？',
                detail: '此操作会删除「' + (current.name || '未命名') + '」模板，已应用它的会话保留各自的快照不受影响，是否继续？',
                confirmLabel: '确认删除',
                danger: true,
                onConfirm: () => void deleteTemplate(current.id),
                onCancel: () => setDeletingId(null),
              })
            : null,
        )
      }

      return { renderTemplateToolbar }
    }
  },
})
