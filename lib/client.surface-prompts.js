/**
 * 插件能力面 · 上下文注入段：每个插件在源码里注册了哪些提示词段与运行时上下文。
 *
 * 与「上下文预演」页的分工：预演回答「首请求真正装配出什么」，这一段只回答
 * 「哪个插件写了哪些注入」，正文来自源码字面量或全局注册表的装配结果，注册点、
 * 接收者作用域与「是否可预演」都按现有提示词贡献模型渲染。
 *
 * 数据全部来自快照，不需要路由；容器与工具段 / 网络段一致：外层一个可折叠区块，
 * 每个插件一个可折叠的 `ptOwnerGroup`（默认展开），并在区块头提供折叠 / 展开全部。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.surface-prompts.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.surface-prompts.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { resultText, ownerFilterLabel, search, textButton, setDetailsOpen, foldNodes, UNOWNED_REASON } = deps
      const { promptGroupsOf, PromptFold } = deps.promptContribution

      /** 一段的全部可见行数与种类计数：页头与筛选条共用同一份口径。 */
      function countsOf(groups) {
        let sections = 0
        let contexts = 0
        for (const group of groups) {
          sections += group.sections.length
          contexts += group.contexts.length
        }
        return { sections, contexts, total: sections + contexts }
      }

      /**
       * 一行是否通过名字聚焦与页头搜索。
       *
       * 模板名与展开后的名字都要能匹配：从插件详情点一个 `tool:${name}` 进来时，
       * 传的是源码原名，而清单里显示的是解析后的名字。
       * @param {object} row - 行模型。
       * @param {object} group - 所属分组。
       * @param {string | null} focusName - 名字条件。
       * @param {string} query - 页头搜索词。
       * @param {object} snapshot - 快照。
       * @returns {boolean} 是否保留。
       */
      function matchesRow(row, group, focusName, query, snapshot) {
        if (focusName !== null && row.display !== focusName && row.rawName !== focusName) return false
        if (search.normalizeQuery(query) === '') return true
        return search.matchesQuery(query, [
          row.display,
          row.rawName,
          row.text?.value,
          row.text?.expression,
          group.unowned ? '未归属' : ownerFilterLabel(snapshot, group.owner),
          ...row.sites.map((site) => site.file),
          ...row.sites.map((site) => String(site.line)),
        ])
      }

      /**
       * 一个插件分组：可折叠的 owner 容器，里面是该插件的提示词段与上下文。
       *
       * 容器形态与工具段 / 网络段一致（`details.ptOwnerGroup` + `summary.ptOwnerHead`），
       * 默认展开；插件名是独立按钮，点击跳插件页，必须截断冒泡，否则会顺带收起分组。
       * @param {object} group - 分组。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function ownerFold(group, vc) {
        const modules = group.entry === undefined ? null : group.entry.moduleName
        return h(
          'details',
          { key: group.owner, className: 'ptOwnerGroup', open: true },
          h(
            'summary',
            { className: 'ptOwnerHead' },
            h('span', { className: 'ptChevron', 'aria-hidden': 'true' }, '▶'),
            group.unowned
              ? h('span', { className: 'ptOwnerName', title: UNOWNED_REASON }, '未归属')
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'ptOwnerName',
                    title: '来源插件 · 点击在插件页查看',
                    onClick: (event) => {
                      event.stopPropagation()
                      vc.gotoPlugin(group.owner)
                    },
                  },
                  ownerFilterLabel(vc.snapshot, group.owner),
                ),
            group.unowned
              ? h('span', { className: 'ptTag', 'data-tone': 'warn', title: UNOWNED_REASON }, '未归属')
              : null,
            modules
              ? h('span', { className: 'ptMeta', title: '这个条目加载的模块名' }, modules)
              : null,
            h('span', { className: 'ptCount', title: '这个插件名下的提示词段与运行时上下文总数' }, `注入 ${group.count}`),
          ),
          h(
            'div',
            { className: 'ptOwnerBody' },
            groupRows('提示词段', group.sections, group, vc),
            groupRows('运行时上下文', group.contexts, group, vc),
          ),
        )
      }

      /**
       * 一段的行清单；`label` 只说种类，不重复组头的插件名。
       * @param {string} label - 种类标题。
       * @param {object[]} rows - 行模型。
       * @param {object} group - 分组。
       * @param {object} vc - 视图上下文。
       * @returns {object | null} React 节点。
       */
      function groupRows(label, rows, group, vc) {
        if (rows.length === 0) return null
        const hasSiteData = group.unowned ? true : Array.isArray(group.entry?.registrationSites)
        return h(
          React.Fragment,
          null,
          h('p', { className: 'ptSubTitle' }, `${label}（${rows.length}）`),
          h(
            'ul',
            { className: 'ptList' },
            rows.map((row) => h(PromptFold, {
              key: row.rawName,
              row,
              moduleName: group.entry?.moduleName,
              hasSiteData,
              onPreview: (target, kind) => vc.gotoSection(target, kind, ownerFilterLabel(vc.snapshot, group.owner)),
            })),
          ),
        )
      }

      /**
       * 上下文注入段正文。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderPromptsSegment(vc) {
        const surface = vc.surface ?? {}
        const query = vc.query ?? ''
        const focusOwner = typeof surface.focusOwner === 'string' && surface.focusOwner.length > 0
          ? surface.focusOwner
          : null
        const focusName = typeof surface.focusName === 'string' && surface.focusName.length > 0
          ? surface.focusName
          : null
        const groups = promptGroupsOf(vc.snapshot, vc.preview ?? null)
        if (groups.length === 0) return h('div', { className: 'ptEmpty' }, '这次快照没有可读的提示词注入。')

        const visible = groups
          .filter((group) => focusOwner === null || group.owner === focusOwner)
          .map((group) => {
            const sections = group.sections.filter((row) => matchesRow(row, group, focusName, query, vc.snapshot))
            const contexts = group.contexts.filter((row) => matchesRow(row, group, focusName, query, vc.snapshot))
            return { ...group, sections, contexts, count: sections.length + contexts.length }
          })
          .filter((group) => group.count > 0)
        const shown = countsOf(visible)
        // 旧快照没有 registrationSites：仍能列出注册名与装配正文，但作用域判断不可用。
        const siteDataMissing = groups.some((group) => group.entry !== undefined
          && !Array.isArray(group.entry.registrationSites)
          && group.count > 0)

        const emptyNode = focusName !== null
          ? h('p', { className: 'ptHint' }, `这个条件下没有名为「${focusName}」的提示词注入。`)
          : focusOwner !== null
            ? h('p', { className: 'ptHint' }, focusOwner === '__none'
                ? '当前快照里没有未归属的提示词注入。'
                : `当前快照里没有归属插件「${ownerFilterLabel(vc.snapshot, focusOwner)}」的提示词注入。`)
            : search.normalizeQuery(query) !== ''
              ? search.renderQueryEmpty({ noun: '提示词注入', onClear: () => vc.setQuery?.('') })
              : h('p', { className: 'ptHint' }, '这个条件下没有提示词注入。')

        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'ptChipGroup', style: { marginBottom: '8px' } },
            // 计数跟着当前插件 / 搜索条件走，和下方列表、筛选条的「显示 N / 总数」同口径。
            h('span', { className: 'ptCount', title: '当前条件下的注入总数' }, `共 ${shown.total} 处`),
            h('span', { className: 'ptCount', title: 'systemPrompt.section 注册的段落' }, `提示词段 ${shown.sections}`),
            h('span', { className: 'ptCount', title: 'systemPrompt.context 注册的运行时上下文' }, `运行时上下文 ${shown.contexts}`),
            h('span', { className: 'ptCount', title: '当前条件下有注入的插件数，未归属单独一组' }, `来源 ${visible.length}`),
          ),
          siteDataMissing
            ? h('p', { className: 'ptHint', style: { color: 'var(--pt-warn)' } }, '这次快照没有带注册点数据：只能列出注册名与已装配的文本。')
            : null,
          shown.total === 0
            ? emptyNode
            : h(
                'details',
                { className: 'ptSectionFold', open: true },
                h(
                  'summary',
                  { className: 'ptSectionHead' },
                  h('span', { className: 'ptChevron', 'aria-hidden': 'true' }, '▶'),
                  h(
                    'span',
                    {
                      className: 'ptSectionTitle',
                      title: '源码扫描到的提示词段与运行时上下文，按 owners 归到插件；未归组单独一组',
                    },
                    '按插件来源分组的注入',
                  ),
                  h('span', { className: 'ptCount' }, `${shown.total} 处 · ${visible.length} 个来源`),
                  // 动作放在 summary 里会连带开关这一节，所以整组截断冒泡。
                  h(
                    'span',
                    { className: 'ptActions', onClick: (event) => event.stopPropagation() },
                    textButton('折叠全部', () => setDetailsOpen(foldNodes('.ptBody details.ptOwnerGroup'), false), { title: '收起所有插件分组' }),
                    textButton('展开全部', () => setDetailsOpen(foldNodes('.ptBody details.ptOwnerGroup'), true), { title: '展开所有插件分组' }),
                  ),
                ),
                h('div', { className: 'ptSectionBody' }, visible.map((group) => ownerFold(group, vc))),
              ),
        )
      }

      /**
       * 上下文注入段筛选：只有结果数；插件条件由页面壳统一提供。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderPromptsSegmentFilters(vc) {
        const surface = vc.surface ?? {}
        const query = vc.query ?? ''
        const focusOwner = typeof surface.focusOwner === 'string' && surface.focusOwner.length > 0
          ? surface.focusOwner
          : null
        const focusName = typeof surface.focusName === 'string' && surface.focusName.length > 0
          ? surface.focusName
          : null
        const groups = promptGroupsOf(vc.snapshot, vc.preview ?? null)
        const total = countsOf(groups)
        let shown = 0
        for (const group of groups) {
          if (focusOwner !== null && group.owner !== focusOwner) continue
          shown += group.sections.filter((row) => matchesRow(row, group, focusName, query, vc.snapshot)).length
            + group.contexts.filter((row) => matchesRow(row, group, focusName, query, vc.snapshot)).length
        }
        return resultText(shown, total.total, ' 处注入')
      }

      return { renderPromptsSegment, renderPromptsSegmentFilters }
    }
  },
})
