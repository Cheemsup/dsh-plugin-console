/**
 * 预演页的「工具 schema」：按名字来源分组，每个工具默认就展示名字与描述。
 *
 * 分组只看名字：全局工具视图里就有的 → 全局层；只在当前模式 preset scope 出现的
 * → 预设层；两边都没有 → 未分类。不比较描述或参数，避免把「模式重新注册了同名
 * 工具」误标成替换。层级由 host 的 `classifyPreviewTools` 给出，前端只负责展示。
 *
 * 每个工具行是一块占满宽度的摘要：名字 + 最多两行的描述，展开才是完整说明与
 * 参数契约。只展示名字时，一列几十个工具读起来只是一份名单，看不出该不该用。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.preview-tools.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-console',
  chunk: 'client.preview-tools.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { shortName, schema } = deps

      /** 每一层的展示名、悬停说明与展示顺序。 */
      const TOOL_SCOPES = {
        global: { label: '全局层' },
        preset: {
          label: '预设层（模式）',
          hint: '只在当前模式的 preset scope 出现，本会话的 agent scope 沿 scope 链继承它们',
        },
        unknown: { label: '未分类' },
      }
      const TOOL_SCOPE_ORDER = ['global', 'preset', 'unknown']

      /**
       * 工具的归属标签：注册表不记 owner，按快照里的源码扫描索引回填。
       * 扫不到就标「未归属」，不硬凑近似结果。
       * @param {string[] | undefined} owners - 注册行 id。
       * @param {Map<string, object>} byRow - 行 id → 条目。
       * @param {object} vc - 视图上下文。
       * @returns {Array<object>} 标签节点。
       */
      function ownerTags(owners, byRow, vc) {
        if (!Array.isArray(owners) || owners.length === 0) {
          return [h('span', { className: 'ptTag', 'data-tone': 'warn', title: '未归属：源码扫描没有找到注册点' }, '未归属')]
        }
        return owners.map((rowId) => {
          const entry = byRow.get(rowId)
          return h(
            'button',
            {
              key: rowId,
              type: 'button',
              className: 'ptTag ptLink',
              title: `注册插件：${entry?.packageName ?? entry?.moduleName ?? rowId}；点击查看这个插件`,
              onClick: (event) => {
                event.preventDefault()
                event.stopPropagation()
                vc.gotoPlugin(rowId)
              },
            },
            entry ? shortName(entry) : rowId,
          )
        })
      }

      /**
       * 一个工具：摘要本身就是一块内容（名字 + 最多两行描述），展开是完整说明。
       *
       * 所在层级不重复标在行上——分组标题已经说明了；行内只留会影响判断的标记
       * （有指导 / lazy）与归属。
       * @param {object} tool - 工具 schema。
       * @param {object} ctx - `{ guided, byRow, ownersByName, vc }`。
       * @returns {object} React 节点。
       */
      function toolRow(tool, ctx) {
        const { guided, byRow, ownersByName, vc } = ctx
        const description = typeof tool.description === 'string' ? tool.description : ''
        return h(
          'li',
          { key: tool.name },
          h(
            'details',
            { className: 'ptToolBlock ptFold ptFoldable ptPreviewTool' },
            h(
              'summary',
              null,
              h('span', { className: 'ptPreviewToolName' }, tool.name),
              guided?.has(tool.name)
                ? h('span', { className: 'ptTag', title: '系统提示词里有 tool:' + tool.name + ' 段落，内容是用法建议' }, '有指导')
                : null,
              tool.deferLoading ? h('span', { className: 'ptTag', title: '延迟加载：模型真正需要时才载入这份 schema' }, 'lazy') : null,
              ...ownerTags(ownersByName.get(tool.name), byRow, vc),
              // 描述放在标签之后并独占一行：读工具时先看它能做什么，而不是先读归属。
              description.length > 0 ? h('span', { className: 'ptPreviewToolDesc', title: description }, description) : null,
            ),
            h(
              'div',
              { className: 'ptFoldBody' },
              description.length > 0
                ? h('p', { className: 'ptToolDesc', style: { margin: 0 } }, description)
                : h('p', { className: 'ptSub', style: { margin: 0 } }, '（无描述）'),
              tool.parameters !== undefined
                ? schema.renderParameters(tool, { vc: ctx.vc, source: 'preview' })
                : h('p', { className: 'ptSub', style: { margin: '6px 0 0' } }, '（无参数 schema）'),
            ),
          ),
        )
      }

      /** 一个 scope 层：折叠头 + 该层的工具行；层内没有工具时不渲染。 */
      function scopeFold(layer, tools, ctx) {
        if (tools.length === 0) return null
        const scope = TOOL_SCOPES[layer] ?? { label: layer }
        return h(
          'details',
          { key: layer, className: 'ptFold ptFoldable', style: { marginTop: '8px' }, open: true },
          h(
            'summary',
            scope.hint === undefined ? null : { title: scope.hint },
            h('span', null, scope.label),
            h('span', { className: 'ptCount' }, tools.length + ' 个'),
          ),
          h(
            'ul',
            { className: 'ptList', style: { padding: '6px 12px 10px' } },
            tools.map((tool) => toolRow(tool, ctx)),
          ),
        )
      }

      /**
       * 工具 schema 的按 scope 分组视图。
       *
       * `tools` 是已按搜索词筛过的结果；分组只重排展示，不改变 host 给的顺序。
       * 没有分层数据时退回平铺：工具服务缺席也不该让这一标签变成空白。
       * @param {object} input - `{ tools, toolSet, guided, snapshot, vc }`。
       * @returns {object} React 节点。
       */
      function renderToolScopeGroups({ tools, toolSet, guided, snapshot, vc }) {
        const byRow = new Map((snapshot?.entries ?? []).map((entry) => [entry.rowId, entry]))
        const ownersByName = new Map((snapshot?.tools?.attributed ?? []).map((tool) => [tool.name, tool.owners ?? []]))
        const ctx = {
          guided,
          byRow,
          ownersByName,
          vc,
        }

        const layers = toolSet?.layers
        if (layers === undefined || layers === null) {
          return h('ul', { className: 'ptList' }, tools.map((tool) => toolRow(tool, ctx)))
        }

        const byName = new Map(tools.map((tool) => [tool.name, tool]))
        const grouped = { global: [], preset: [], unknown: [] }
        const placed = new Set()
        for (const name of Object.values(layers).flat()) {
          const tool = byName.get(name)
          if (tool === undefined || placed.has(name)) continue
          const declared = toolSet.layerByName?.[name]
          const layer = TOOL_SCOPES[declared] === undefined ? 'unknown' : declared
          grouped[layer].push(tool)
          placed.add(name)
        }
        // host 没覆盖到的名字（理论上不会出现）也算未分类，而不是从界面上消失。
        for (const tool of tools) {
          if (!placed.has(tool.name)) grouped.unknown.push(tool)
        }

        const counts = TOOL_SCOPE_ORDER
          .map((layer) => TOOL_SCOPES[layer].label + ' ' + grouped[layer].length)
          .join(' · ')
        return h(
          'details',
          { className: 'ptFold ptFoldable', style: { marginTop: '8px' }, open: true },
          h(
            'summary',
            { title: '此处仅作分组，不代表最终请求发出的tool顺序' },
            h('span', null, '按 scope 分组的工具 schema'),
            h('span', { className: 'ptFoldMeta' }, counts),
          ),
          h(
            'div',
            { className: 'ptFoldBody', style: { padding: '8px 12px 12px' } },
            TOOL_SCOPE_ORDER.map((layer) => scopeFold(layer, grouped[layer], ctx)),
          ),
        )
      }

      return { renderToolScopeGroups }
    }
  },
})
