/**
 * 工具视图：模型能看到哪些工具、谁给的。
 *
 * 两段：
 *   按插件来源分类工具集 —— 每个来源一个可折叠分组，工具挂在它下面；
 *   模式预设   —— DSH 四种模式在 agent scope 上挂的工具（默认折叠）。
 *
 * 不再列一个扁平的「工具集」：同一来源的工具原本每行都重复一遍归属标签，
 * 现在归到一个标题下，既省行数，也让「这个插件给了我哪些工具」一眼可答。
 * 相对全局的工具集差异与同模式会话差异已经移除：它们回答的是诊断问题，
 * 会话页的首次请求分析已经给出更接近实际的读数。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.tools.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.tools.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { modeTitle, selectField, resultText, passesOwner, activity, shortName, textButton, rowEnd, setDetailsOpen, schema, search } = deps

      /**
       * 本视图里的插件来源分组。
       *
       * 只选 owner 分组：工具行与「模式预设」也是可折叠块，一键展开/收起不该波及它们。
       * details 的开关归浏览器，直接改 DOM 比把展开状态提升成受控 state 更简单。
       * @returns {Array<object>} 分组节点。
       */
      function ownerFoldNodes() {
        if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return []
        return document.querySelectorAll('.ptBody details.ptOwnerGroup')
      }

      /**
       * 按来源与搜索筛过的工具。
       *
       * 视图与筛选条共用同一个谓词：这页有两个工具集合，筛选条自己再写一遍
       * `includes` 的话，迟早只改了一处。
       * @param {object[]} list - 工具记录。
       * @param {string} query - 页头搜索词。
       * @param {string | null} toolOwner - 来源筛选。
       * @returns {object[]} 留下的工具。
       */
      function visibleToolsOf(list, query, toolOwner) {
        return list.filter((tool) => passesOwner(tool, toolOwner) && search.matchesQuery(query, [tool.name, tool.description]))
      }

      /**
       * 模式预设层按同一个词收窄；没有命中的层整层不返回。
       *
       * 预设层里只有工具名，没有描述可匹配；空卡片必须消失，否则上方的
       * 「没有匹配的工具」会和下方仍列出的同名卡片正面矛盾。
       * @param {object[] | undefined} layers - `tools.presetLayer`。
       * @param {string} query - 页头搜索词。
       * @returns {object[]} 收窄后的层。
       */
      function visiblePresetLayersOf(layers, query) {
        return (layers ?? [])
          .map((layer) => ({ ...layer, tools: layer.tools.filter((name) => search.matchesQuery(query, [name])) }))
          .filter((layer) => layer.tools.length > 0)
      }

      /** 两个集合去重后的工具名：计数按名字合并，否则同一个工具在每个模式里各算一次。 */
      function toolNameSet(...lists) {
        const names = new Set()
        for (const list of lists) for (const name of list) names.add(name)
        return names
      }

      /**
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderToolsView(vc) {
        const { snapshot, query, toolOwner, focusTool } = vc
        const { activity: activityData, activityStatus, activityError } = vc
        const tools = snapshot.tools ?? { global: [] }
        const all = tools.attributed ?? (tools.global ?? []).map((name) => ({ name, owners: [], via: 'unknown' }))
        const rawPresetLayers = tools.presetLayer ?? []

        if (!all.length && !rawPresetLayers.length) {
          return h('p', { className: 'ptEmpty' }, '这个部署没有可读的工具注册表（或 tools 服务缺席）。')
        }

        const visible = visibleToolsOf(all, query, toolOwner)
        const presetLayers = visiblePresetLayersOf(rawPresetLayers, query)

        // 两个集合都没有命中时才给统一的空状态。只在一个集合里没命中时不喊
        // 「没有匹配的工具」——它会和下方仍有内容的模式卡片正面矛盾。
        if (visible.length === 0 && presetLayers.length === 0) {
          return search.renderQueryEmpty({
            noun: '工具',
            onClear: search.normalizeQuery(query) === '' ? undefined : () => vc.setQuery(''),
            extra: toolOwner === null ? undefined : textButton('清除来源筛选', () => vc.setToolOwner(null)),
          })
        }

        const byRow = new Map((snapshot.entries ?? []).map((entry) => [entry.rowId, entry]))
        const groups = new Map()
        for (const tool of visible) {
          const owners = (tool.owners ?? []).length > 0 ? [...new Set(tool.owners)] : ['__none']
          for (const owner of owners) {
            const list = groups.get(owner) ?? []
            list.push(tool)
            groups.set(owner, list)
          }
        }
        const orderedGroups = [...groups.entries()].sort((left, right) => {
          if (left[0] === '__none') return 1
          if (right[0] === '__none') return -1
          return right[1].length - left[1].length
        })

        return h(
          'div',
          null,
          // 两段都是「区块」：同一个折叠头、同一种展开状态，不再一段像标题、一段像卡片。
          h(
            'details',
            { key: 'tools-by-owner', className: 'ptSectionFold', open: true },
            h(
              'summary',
              { className: 'ptSectionHead' },
              h('span', { className: 'ptChevron', 'aria-hidden': 'true' }, '▶'),
              h('span', {
                className: 'ptSectionTitle',
                title: '一个工具若被多个插件注册会同时出现在多个来源里，未归属说明源码扫描没找到注册点',
              }, '按插件来源分类工具集'),
              h('span', { className: 'ptCount' }, `${visible.length} 个工具 · ${orderedGroups.length} 个来源`),
              // 动作放在 summary 里会连带开关这一节，所以整组截断冒泡。
              h(
                'span',
                { className: 'ptActions', onClick: (event) => event.stopPropagation() },
                textButton('折叠全部', () => setDetailsOpen(ownerFoldNodes(), false), { title: '收起所有插件来源分组' }),
                textButton('展开全部', () => setDetailsOpen(ownerFoldNodes(), true), { title: '展开所有插件来源分组' }),
              ),
            ),
            h(
              'div',
              { className: 'ptSectionBody' },
              // 来源分组为空、但模式预设层有命中时只留标题（计数写着 0 个工具）；
              // 整页都没有命中的情况已经在上面统一处理。
              orderedGroups.map(([owner, list]) => ownerGroup(owner, list, byRow, vc, focusTool, activityData, activityStatus, activityError)),
            ),
          ),
          // 没有命中任何预设工具时整块不渲染：留着空壳等于把「没有匹配」说两遍。
          presetLayers.length === 0
            ? null
            : h(
                'details',
                { key: 'preset-tools', className: 'ptSectionFold' },
                h(
                  'summary',
                  { className: 'ptSectionHead' },
                  h('span', { className: 'ptChevron', 'aria-hidden': 'true' }, '▶'),
                  h('span', { className: 'ptSectionTitle' }, '模式预设工具集'),
                  h('span', { className: 'ptCount' }, presetLayers.length + ' 个模式'),
                  h('span', { className: 'ptMeta' }, '模式挂在 agent scope 上的工具'),
                ),
                h(
                  'div',
                  { className: 'ptSectionBody' },
                  presetLayers.map((layer) => presetLayerCard(layer, vc)),
                ),
              ),
        )
      }

      /**
       * 一个插件来源分组：分组本身可折叠，默认展开；标题仍可跳到插件详情。
       *
       * 折叠头整行都是 `<summary>`，点它开关分组；插件名是一个独立的按钮，
       * 必须 `stopPropagation`，否则「跳到详情」会顺带把分组收起。
       */
      function ownerGroup(owner, list, byRow, vc, focusTool, activityData, activityStatus, activityError) {
        const entry = byRow.get(owner)
        const label = owner === '__none' ? '未归属' : (entry ? shortName(entry) : owner)
        const title = owner === '__none'
          ? '源码扫描没有找到这些工具的注册点'
          : (entry?.packageName ?? entry?.moduleName ?? owner) + ' · 点击查看插件'
        return h(
          'details',
          { key: owner, className: 'ptOwnerGroup', open: true },
          h(
            'summary',
            { className: 'ptOwnerHead' },
            h('span', { className: 'ptChevron', 'aria-hidden': 'true' }, '▶'),
            owner === '__none'
              ? h('span', { className: 'ptOwnerName', title }, label)
              : h('button', {
                  type: 'button',
                  className: 'ptOwnerName',
                  title,
                  onClick: (event) => {
                    event.stopPropagation()
                    vc.gotoPlugin(owner)
                  },
                }, label),
            owner === '__none'
              ? h('span', { className: 'ptTag', 'data-tone': 'warn', title: '未归属：源码扫描没有找到注册点' }, '未归属')
              : h('span', { className: 'ptMeta' }, entry?.moduleName ?? owner),
            h('span', { className: 'ptCount' }, `${list.length} 个工具`),
          ),
          h(
            'div',
            { className: 'ptOwnerBody' },
            h(
              'ul',
              { className: 'ptDepList' },
              list.map((tool) => toolRow(tool, vc, focusTool, activityData, activityStatus, activityError)),
            ),
          ),
        )
      }

      /**
       * 一个工具：默认收起，展开是描述与参数 schema。
       * @param {object} tool - 工具记录。
       * @param {object} vc - 视图上下文（schema 原文开关按工具记在这里）。
       * @param {string | null} focusTool - 被跳转定位的工具名。
       * @returns {object} React 节点。
       */
      function toolRow(tool, vc, focusTool, activityData, activityStatus, activityError) {
        const usage = activity?.toolUsage?.(activityData, tool.name)
        return h(
          'li',
          { key: tool.name },
          h(
            'details',
            {
              className: 'ptToolBlock ptFold ptFoldable',
              // open 只在被跳转定位时给值：给了就是受控，用户点不动；
              // 其余情况留 undefined 让它自己管自己。
              ...(focusTool === tool.name ? { open: true, id: 'pt-tool-focus' } : {}),
            },
            h(
              'summary',
              null,
              h(
                'span',
                {
                  className: 'ptDepKey',
                  // 「仅会话」不再单独占一个标签：它只是一个 scope 说明，挂在名字的悬停里。
                  title: (tool.scopes ?? []).includes('global') ? undefined : '仅会话：只在会话 scope 里可见，全局视图没有它',
                },
                search.markQuery(tool.name, vc.query),
              ),
              tool.deferLoading ? h('span', { className: 'ptTag', title: '延迟加载：模型真正需要时才载入这份 schema' }, 'lazy') : null,
              rowEnd(usage !== undefined
                ? h('span', {
                    className: 'ptCount',
                    title: `最近 7 天：${usage.calls} 次调用，${usage.errors} 次错误`,
                  }, `${usage.calls} 次${usage.errors > 0 ? ` · ${usage.errors} 错` : ''}`)
                : null),
            ),
            h(
              'div',
              { className: 'ptFoldBody' },
              activityStatus === 'ready' && usage !== undefined
                ? h('p', { className: 'ptHint', style: { margin: '0 0 8px' } },
                    `最近 7 天：${usage.calls} 次调用 · ${usage.errors} 次错误 · p95 ${activity.formatDuration(usage.p95Ms)} · 最后 ${activity.formatLastUsed(usage.lastUsed)}`)
                : activityStatus === 'error'
                  ? h('p', { className: 'ptError', style: { margin: '0 0 8px' } }, '活动读取失败：' + (activityError ?? '未知错误'))
                  : null,
              tool.description
                ? h('p', { className: 'ptToolDesc', style: { margin: 0 } }, tool.description)
                : h('p', { className: 'ptSub', style: { margin: 0 } }, '（无描述）'),
              tool.parameters !== undefined
                ? schema.renderParameters(tool, { vc, source: 'tools' })
                : h('p', { className: 'ptSub', style: { margin: '6px 0 0' } }, '（无参数 schema）'),
            ),
          ),
        )
      }

      /**
       * 一个模式的工具卡片。
       *
       * 声明值与实测值的出入不再单独占行，收进模式标题的悬停里：
       * 它只在两种读数不一致时出现，常态下把版面留给工具名单。
       */
      function presetLayerCard(layer, vc) {
        const { snapshot, gotoTool } = vc
        const mode = (snapshot.modes ?? []).find((candidate) => candidate.id === layer.presetId)
        return h(
          'div',
          { key: layer.presetId, style: { marginBottom: '14px' } },
          h(
            'div',
            { className: 'ptCardHead', style: { marginBottom: '4px' } },
            h('span', { className: 'ptCardTitle', title: presetNotes(layer) }, mode ? modeTitle(mode) : layer.presetId),
            h('span', { className: 'ptCount' }, `${layer.tools.length} 个工具`),
            h(
              'span',
              { className: 'ptTag', title: layer.measured ? '来源：有活会话，数值来自运行时' : '来源：没有活会话，数值来自声明行的源码扫描' },
              layer.measured ? `实测 · ${layer.sessions.length} 个会话` : '声明值',
            ),
          ),
          h(
            'div',
            { className: 'ptChipGroup', style: { gap: '3px' } },
            layer.tools.map((name) =>
              h(
                'button',
                { key: name, type: 'button', className: 'ptTag ptLink', onClick: () => gotoTool(name), title: '在「按插件来源分类工具集」里查看 schema' },
                search.markQuery(name, vc.query),
              ),
            ),
          ),
        )
      }

      /**
       * 模式卡片的悬停说明：声明行与实测值之间的两处出入。
       * @param {object} layer - 模式预设层的快照。
       * @returns {string | undefined} 多行说明；两边一致时不带 title。
       */
      function presetNotes(layer) {
        const notes = []
        if (layer.absent.length) {
          notes.push(`声明行注册了、实测没出现（${layer.absent.length}）：${layer.absent.join('、')} —— 被平台条件跳过或被本 scope 的 restrict 挡掉`)
        }
        if (layer.unlisted.length) {
          notes.push(`实测出现、声明行的注册记录里没有（${layer.unlisted.length}）：${layer.unlisted.join('、')} —— 运行时动态注册或名字不是源码字面量`)
        }
        return notes.length ? notes.join('\n') : undefined
      }

      /** 工具页筛选：来源插件 + 结果数。 */
      function renderToolFilters(vc) {
        const { snapshot, toolOwner, setToolOwner, query } = vc
        const attributed = snapshot.tools?.attributed ?? []
        const owners = new Map()
        for (const tool of attributed) {
          for (const owner of tool.owners ?? []) owners.set(owner, (owners.get(owner) ?? 0) + 1)
        }
        const byRow = new Map((snapshot.entries ?? []).map((entry) => [entry.rowId, entry]))
        const unowned = attributed.filter((tool) => (tool.owners ?? []).length === 0).length
        const visible = visibleToolsOf(attributed, query, toolOwner)
        // 与视图同一套收窄：读数要把下方「模式预设工具集」也算进去，否则搜到预设层
        // 的工具时这里仍然写着 0。两个集合按名字去重，同一工具挂在多个模式下只算一次。
        const presetLayers = snapshot.tools?.presetLayer ?? []
        const shownNames = toolNameSet(visible.map((tool) => tool.name), visiblePresetLayersOf(presetLayers, query).flatMap((layer) => layer.tools))
        const totalNames = toolNameSet(attributed.map((tool) => tool.name), presetLayers.flatMap((layer) => layer.tools))
        return h(
          React.Fragment,
          null,
          selectField('来源插件', toolOwner, [
            { value: '', label: `全部来源（${attributed.length}）` },
            ...[...owners.entries()]
              .sort((left, right) => right[1] - left[1])
              .map(([owner, count]) => ({ value: owner, label: `${byRow.get(owner) ? shortName(byRow.get(owner)) : owner}（${count}）` })),
            unowned ? { value: '__none', label: `未归属（${unowned}）` } : null,
          ], (value) => setToolOwner(value === '' ? null : value)),
          resultText(shownNames.size, totalNames.size, ' 个工具'),
        )
      }

      return { renderToolsView, renderToolFilters }
    }
  },
})
