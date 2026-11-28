/**
 * 能力面：模型工具之外，这台部署还提供了哪些可浏览的能力。
 *
 * 第一阶段只有「技能」一段；条件与状态在 `client.surface-store.js`，
 * 技能段正文在 `client.surface-skills.js`。页面壳按「段选择器 → 条件栏 → 正文」
 * 三行排布：段决定这一页看什么，条件只属于当前段。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.surface.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.surface.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { selectField, workspaceField, modeTitle, formatSessionId } = deps
      const { renderSkillsSegment } = deps.surfaceSkills
      const { renderCommandsSegment } = deps.surfaceCommands
      const { renderNetworkSegment } = deps.surfaceNetwork

      /** 已实现的段；后续阶段在这里追加，不提前放不可用的按钮。 */
      const SEGMENTS = [
        ['skills', '技能'],
        ['commands', '斜杠命令'],
        ['network', '网络'],
      ]

      /** 可输入选择器在缺省状态下的空实现：视图被单独渲染（自检）时也能工作。 */
      const EMPTY_PICKER = {
        query: '',
        open: false,
        index: -1,
        setQuery: () => {},
        setOpen: () => {},
        setIndex: () => {},
      }

      /**
       * 网络段的插件选择器：聚焦展开完整列表，输入即过滤；关闭时显示当前插件。
       *
       * 选项来自快照 entries，而不是网络结果：这样也能筛到「没有网络事实」的插件，
       * 用空结果确认它没有登记/调用。检索覆盖展示名、标题、rowId、包名与模块名。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function networkPluginField(vc) {
        const surface = vc.surface
        const picker = surface.networkPicker ?? EMPTY_PICKER
        const chosen = typeof surface.networkPlugin === 'string' ? surface.networkPlugin : ''
        // 显示名优先本地化标题 / 包名；同一个包挂成多行时补 rowId 区分。
        const labelOf = (entry) => {
          const base = (typeof entry.title === 'string' && entry.title.length > 0)
            ? entry.title
            : (typeof entry.packageName === 'string' && entry.packageName.length > 0)
              ? entry.packageName
              : (typeof entry.moduleName === 'string' && entry.moduleName.length > 0 ? entry.moduleName : entry.rowId)
          return entry.rowId === base ? base : base + ' · ' + entry.rowId
        }
        const entries = (vc.snapshot?.entries ?? [])
          .filter((entry) => typeof entry?.rowId === 'string' && entry.rowId.length > 0 && entry.isGroup !== true)
          .map((entry) => ({
            value: entry.rowId,
            label: labelOf(entry),
            // 下拉显示行 id，但标题、包名与模块名也要能搜到。
            search: `${labelOf(entry)} ${entry.title ?? ''} ${entry.rowId} ${entry.packageName ?? ''} ${entry.moduleName ?? ''}`.toLowerCase(),
          }))
          .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))
        const all = [{ value: '', label: '全部插件', search: '全部插件 all plugins' }, ...entries]
        if (chosen !== '' && !all.some((item) => item.value === chosen)) {
          all.splice(1, 0, { value: chosen, label: chosen, search: chosen.toLowerCase() })
        }
        const needle = picker.query.trim().toLowerCase()
        const items = needle === '' ? all : all.filter((item) => item.search.includes(needle))
        const selected = all.find((item) => item.value === chosen)
        const active = items.length === 0 ? -1 : Math.min(picker.index, items.length - 1)
        /** 收起列表并清空筛选词；输入框随后显示当前选中项。 */
        const close = () => {
          picker.setOpen(false)
          picker.setQuery('')
          picker.setIndex(-1)
        }
        const choose = (value) => {
          close()
          surface.setNetworkPlugin?.(value)
        }
        const onKeyDown = (event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            picker.setOpen(true)
            if (items.length === 0) {
              picker.setIndex(-1)
              return
            }
            const step = event.key === 'ArrowDown' ? 1 : -1
            const start = picker.index
            picker.setIndex(start < 0
              ? (step > 0 ? 0 : items.length - 1)
              : (start + step + items.length) % items.length)
          } else if (event.key === 'Enter' && picker.open === true && active >= 0) {
            event.preventDefault()
            choose(items[active].value)
          } else if (event.key === 'Escape') {
            close()
          }
        }
        return h(
          'div',
          { className: 'ptField' },
          h('span', { className: 'ptFieldLabel' }, '插件'),
          h(
            'div',
            { className: 'ptCombo' },
            h('input', {
              type: 'text',
              className: 'ptSelect ptComboInput',
              placeholder: '筛选插件…',
              value: picker.open === true ? picker.query : (selected?.label ?? '全部插件'),
              role: 'combobox',
              'aria-label': '按插件筛选网络',
              title: selected?.label ?? '全部插件',
              'aria-expanded': picker.open === true,
              'aria-controls': 'pt-network-plugin-options',
              'aria-autocomplete': 'list',
              'aria-activedescendant': picker.open === true && active >= 0 ? `pt-network-plugin-option-${active}` : undefined,
              onFocus: () => {
                picker.setOpen(true)
                picker.setQuery('')
                picker.setIndex(-1)
              },
              onChange: (event) => {
                picker.setOpen(true)
                picker.setQuery(event.target.value)
                picker.setIndex(0)
              },
              // 已经聚焦时再点一次也要能重新展开（例如刚按过 Esc）。
              onClick: () => {
                if (picker.open === true) return
                picker.setOpen(true)
                picker.setQuery('')
                picker.setIndex(-1)
              },
              onKeyDown,
              onBlur: () => picker.setOpen(false),
            }),
            picker.open === true
              ? h(
                  'div',
                  { id: 'pt-network-plugin-options', className: 'ptComboList', role: 'listbox' },
                  items.length === 0
                    ? h('p', { className: 'ptComboEmpty' }, '没有匹配的插件')
                    : items.map((item, index) => h(
                        'button',
                        {
                          key: item.value,
                          id: `pt-network-plugin-option-${index}`,
                          type: 'button',
                          className: 'ptComboOption',
                          role: 'option',
                          'data-active': index === active,
                          'aria-selected': item.value === chosen,
                          // 按下时不抢输入框焦点，click 才能正常命中。
                          onMouseDown: (event) => event.preventDefault(),
                          onClick: () => choose(item.value),
                        },
                        item.label,
                      )),
                )
              : null,
          ),
        )
      }

      /**
       * 会话选项：与会话页一致优先用标题，再补模式与运行状态。
       * 运行状态要能一眼看到——未运行的会话读不到会话 scope，目录只是回退结果；
       * 未归属工作区的会话兜底进默认工作区，用尾部的「未归属」说明它没有自己的分组。
       * @param {object} session - 快照里的会话行。
       * @returns {string} 选项文案。
       */
      function sessionOptionLabel(session) {
        const name = typeof session.title === 'string' && session.title.length > 0
          ? session.title
          : formatSessionId(session.id)
        const preset = session.runtime?.preset ?? session.preset
        return name
          + (typeof preset === 'string' && preset.length > 0 ? ' · ' + preset : '')
          + (session.live === true ? ' · 运行中' : ' · 未运行')
          + (session.ungrouped === true ? ' · 未归属' : '')
      }

      /**
       * 能力面的条件栏：技能段是模式 + 工作区；命令段是工作区 + 会话 + 模式
       * （选中会话时模式只显示该会话的预设，不能再改）；网络段是插件筛选 + 重读。
       * @param {object} vc - 视图上下文。
       * @returns {object | null} React 节点。
       */
      function renderSurfaceFilters(vc) {
        const surface = vc.surface
        if (surface === undefined) return null
        const modes = vc.snapshot?.modes ?? []
        // 宿主在未指定模式时取 isDefault（没有就是列表第一条），这里直接显示那一条。
        // 不再提供「部署默认模式」这个间接选项：它和列表里的同一个模式等价，只会藏起实际生效的模式。
        const defaultModeId = modes.find((mode) => mode.isDefault === true)?.id ?? modes[0]?.id ?? ''
        const commandsMode = surface.segment === 'commands'
        const networkMode = surface.segment === 'network'
        const currentSession = surface.sessionId ?? ''
        const sessionMode = commandsMode && currentSession !== ''
        // 选中会话时目录由会话决定：模式栏如实显示它的预设，改它没有意义。
        const shownMode = sessionMode
          ? (surface.sessionPreset ?? defaultModeId)
          : (surface.presetId ?? defaultModeId)
        const unknown = shownMode !== '' && !modes.some((mode) => mode.id === shownMode)
        return h(
          React.Fragment,
          null,
          networkMode
            ? null
            : workspaceField('工作区', surface.workspacePath, vc.previewWorkspaces, (value) => {
                surface.setWorkspace(value)
              }, vc.workspacePicker?.surface, {
                title: commandsMode
                  ? '命令段的会话只在它里面挑；会话已结束（或没选会话）时，技能入口也用它的路径作 cwd'
                  : '技能目录按 cwd 扫描：项目根的 skill 只在对应工作区出现；「新建工作区…」会把选中的目录登记为 DSH 工作区',
                ariaLabel: '工作区',
                busy: vc.workspacePicker?.busy === true,
                error: vc.workspacePicker?.error ?? null,
              }),
          commandsMode
            ? selectField('会话', currentSession, [
                { value: '', label: '不指定会话（按模式 scope）' },
                ...(surface.sessions ?? []).map((session) => ({
                  value: session.id,
                  label: sessionOptionLabel(session),
                })),
              ], (value) => surface.setSession(value), {
                title: '会话只在当前工作区里挑：活会话读完整 scope 链；未运行的会话按它的模式与工作区做只读回退，会话 scope 里的命令读不到',
              })
            : null,
          networkMode
            ? null
            : selectField('模式', shownMode, [
                ...(unknown ? [{ value: shownMode, label: shownMode }] : []),
                ...modes.map((mode) => ({ value: mode.id, label: modeTitle(mode) })),
                ...(modes.length === 0 ? [{ value: '', label: '没有可用的模式预设', disabled: true }] : []),
              ], (value) => surface.setPreset(value), {
                disabled: sessionMode,
                title: sessionMode
                  ? '由所选会话决定：活会话显示运行时预设，未运行的会话显示 header 记录的预设；选「不指定会话」才能换模式'
                  : commandsMode
                    ? '只在「不指定会话」时生效：按该模式的预设 scope 只读回退'
                    : '模式决定 preset scope：同一工作区换个模式，技能目录可能不同',
              }),
          networkMode ? networkPluginField(vc) : null,
          h(
            'div',
            { className: 'ptActions' },
            h(
              'button',
              {
                type: 'button',
                className: 'ptBtn',
                onClick: () => void (networkMode ? surface.loadNetwork() : commandsMode ? surface.loadCommands() : surface.loadSkills()),
                disabled: networkMode ? surface.network?.status === 'loading' : commandsMode ? surface.commands?.status === 'loading' : surface.skills?.status === 'loading',
              },
              networkMode
                ? (surface.network?.status === 'loading' ? '读取中…' : '重新读取')
                : commandsMode
                  ? (surface.commands?.status === 'loading' ? '读取中…' : '重新读取')
                  : (surface.skills?.status === 'loading' ? '读取中…' : '重新读取'),
            ),
          ),
        )
      }

      /**
       * 段选择器：能力面先问「看哪一类能力」，条件再按段给。
       * 页面壳把它排在条件栏上面一行——段是页面级的组织方式，不是筛选条件。
       * @param {object} vc - 视图上下文。
       * @returns {object | null} React 节点。
       */
      function renderSurfaceSegments(vc) {
        const surface = vc.surface
        if (surface === undefined || SEGMENTS.length <= 1) return null
        return h(
          'span',
          { className: 'ptSeg', role: 'group', 'aria-label': '能力面分类' },
          SEGMENTS.map(([id, label]) => h(
            'button',
            {
              key: id,
              type: 'button',
              className: 'ptSegBtn',
              'aria-pressed': surface.segment === id ? 'true' : 'false',
              onClick: () => surface.setSegment(id),
            },
            label,
          )),
        )
      }

      /**
       * 能力面正文。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderSurfaceView(vc) {
        const surface = vc.surface
        if (surface === undefined) return h('div', { className: 'ptEmpty' }, '能力面状态不可用。')
        return surface.segment === 'skills'
          ? renderSkillsSegment(vc)
          : surface.segment === 'commands'
            ? renderCommandsSegment(vc)
            : surface.segment === 'network'
              ? renderNetworkSegment(vc)
              : h('div', { className: 'ptEmpty' }, '这一段还没有实现。')
      }

      return { renderSurfaceSegments, renderSurfaceFilters, renderSurfaceView }
    }
  },
})
