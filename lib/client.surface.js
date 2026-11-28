/**
 * 插件能力面：这台部署、以及每个插件，到底提供了哪些能力。
 *
 * 五段：工具 / 上下文注入 / 技能 / 斜杠命令 / 网络。页面壳只做三件事：
 *   1. 段选择器（先问看哪一类能力）；
 *   2. 所有段共用的「插件」条件（owner 收窄，跨段保留）；
 *   3. 段自己的条件与正文（各段 chunk 提供）。
 *
 * 条件栏顺序固定为「插件 → 段条件」：插件是全局条件，段条件只属于当前段。
 * 段横幅（只看插件 / 只看某个名字）放在正文顶部，因为它描述的是下面列表的
 * 限定，不是页头筛选器。
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
      const { textButton, ownerFilterLabel } = deps
      const tools = deps.surfaceTools
      const prompts = deps.surfacePrompts
      const skills = deps.surfaceSkills
      const commands = deps.surfaceCommands
      const network = deps.surfaceNetwork

      /** 已实现的段；顺序就是页面上的顺序，第一段也是默认段。 */
      const SEGMENTS = [
        ['tools', '工具'],
        ['prompts', '上下文注入'],
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
       * 统一插件条件：聚焦展开完整列表，输入即过滤；关闭时显示当前插件。
       *
       * 选项来自快照 entries，而不是某一段的结果：这样也能筛到「没有该段事实」
       * 的插件，用空结果确认它没有登记 / 调用。检索覆盖展示名、标题、rowId、
       * 包名与模块名；「未归属」是一个固定的筛选项，不是一个行 id。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function ownerField(vc) {
        const surface = vc.surface
        const picker = surface.ownerPicker ?? EMPTY_PICKER
        const chosen = typeof surface.focusOwner === 'string' ? surface.focusOwner : ''
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
        const all = [
          { value: '', label: '全部插件', search: '全部插件 all plugins' },
          ...entries,
          { value: '__none', label: ownerFilterLabel(vc.snapshot, '__none'), search: '未归属 unowned none' },
        ]
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
          surface.setFocusOwner?.(value)
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
              'aria-label': '按插件筛选',
              title: selected?.label ?? '全部插件',
              'aria-expanded': picker.open === true,
              'aria-controls': 'pt-surface-owner-options',
              'aria-autocomplete': 'list',
              'aria-activedescendant': picker.open === true && active >= 0 ? `pt-surface-owner-option-${active}` : undefined,
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
                  { id: 'pt-surface-owner-options', className: 'ptComboList', role: 'listbox' },
                  items.length === 0
                    ? h('p', { className: 'ptComboEmpty' }, '没有匹配的插件')
                    : items.map((item, index) => h(
                        'button',
                        {
                          key: item.value,
                          id: `pt-surface-owner-option-${index}`,
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
       * 段选择器：先问「看哪一类能力」，条件再按段给。
       * 页面壳把它排在条件栏上面一行——段是页面级的组织方式，不是筛选条件。
       * @param {object} vc - 视图上下文。
       * @returns {object | null} React 节点。
       */
      function renderSurfaceSegments(vc) {
        const surface = vc.surface
        if (surface === undefined || SEGMENTS.length <= 1) return null
        return h(
          'span',
          { className: 'ptSeg', role: 'group', 'aria-label': '插件能力面分类' },
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

      /** 当前段的附加条件；插件条件不在这里，由页面壳统一给。 */
      const SEGMENT_FILTERS = {
        tools: () => tools.renderToolsSegmentFilters,
        prompts: () => prompts.renderPromptsSegmentFilters,
        skills: () => skills.renderSkillsSegmentFilters,
        commands: () => commands.renderCommandsSegmentFilters,
        network: () => network.renderNetworkSegmentFilters,
      }

      /**
       * 能力面的条件栏：统一的「插件」条件 + 当前段自己的条件。
       * @param {object} vc - 视图上下文。
       * @returns {object | null} React 节点。
       */
      function renderSurfaceFilters(vc) {
        const surface = vc.surface
        if (surface === undefined) return null
        const segmentFilter = SEGMENT_FILTERS[surface.segment]?.()
        return h(
          React.Fragment,
          null,
          ownerField(vc),
          typeof segmentFilter === 'function' ? segmentFilter(vc) : null,
        )
      }

      /**
       * 段横幅：说明正文被插件条件与名字条件收窄到了哪里。
       *
       * owner 跨段保留，所以横幅在五段里都会出现；名字条件在切段时清空。
       * @param {object} vc - 视图上下文。
       * @returns {object | null} React 节点。
       */
      function ownerBanner(vc) {
        const surface = vc.surface
        const owner = typeof surface.focusOwner === 'string' && surface.focusOwner.length > 0
          ? surface.focusOwner
          : null
        const name = typeof surface.focusName === 'string' && surface.focusName.length > 0
          ? surface.focusName
          : null
        if (owner === null && name === null) return null
        return h(
          'p',
          { className: 'ptHint' },
          owner !== null
            ? (owner === '__none' ? '只看未归属的条目' : `只看插件「${ownerFilterLabel(vc.snapshot, owner)}」`)
            : null,
          owner !== null && name !== null ? ' · ' : null,
          name !== null
            // 工具段只定位并展开目标工具，不强筛清单；措辞不能写成「只看」。
            ? (surface.segment === 'tools' ? `已定位「${name}」` : `只看「${name}」`)
            : null,
          ' ',
          textButton('查看全部', surface.clearFocus, { title: '清除插件与名字条件' }),
        )
      }

      /**
       * 能力面正文。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderSurfaceView(vc) {
        const surface = vc.surface
        if (surface === undefined) return h('div', { className: 'ptEmpty' }, '插件能力面状态不可用。')
        const body = surface.segment === 'tools'
          ? tools.renderToolsSegment(vc)
          : surface.segment === 'prompts'
            ? prompts.renderPromptsSegment(vc)
            : surface.segment === 'skills'
              ? skills.renderSkillsSegment(vc)
              : surface.segment === 'commands'
                ? commands.renderCommandsSegment(vc)
                : surface.segment === 'network'
                  ? network.renderNetworkSegment(vc)
                  : h('div', { className: 'ptEmpty' }, '这一段还没有实现。')
        return h(React.Fragment, null, ownerBanner(vc), body)
      }

      return { renderSurfaceSegments, renderSurfaceFilters, renderSurfaceView }
    }
  },
})
