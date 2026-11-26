/**
 * 插件视图：这台机器装了什么、都在干什么。
 *
 * 按能力类别分组（可折叠），可再按来源层与状态筛选；点一行展开
 * 基本信息 / 状态 / 组合链 / 服务 / 行为 / 注册项六段事实。
 * 详情本体在 `client.plugin-detail.js`，这里只保留行与分组。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.plugins.js')` 取它，
 * 工厂返回 `create(deps)`，`deps` 是共享工具集合。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.plugins.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const {
        shortName, layerLabel, textButton, rowEnd, missingServicesOf, modeMountsOf,
        CATEGORY_LABELS, toggleIn, activateOnKey, activity, changes, search, pluginDetail,
      } = deps
      // 详情是独立 chunk：它与行共用同一份 helpers，但不和分组渲染挤在同一个 1000 行上限里。
      const { Detail } = pluginDetail

      /** 分类说明：悬停在分组标题上时回答「这个一级分类是怎么来的」。 */
      const CATEGORY_NOTES = {
        tool: '注册工具定义（dsh-tool-*、MCP 客户端回填的工具也算）',
        ui: '浏览器半的界面槽位、面板与渲染器',
        model: '模型适配与模型选择',
        session: '会话持久化、投影、查询与格式迁移',
        safety: '沙箱、审批、权限预设与凭据',
        transport: 'API 网关、Remote 方法、ACP / JSON-RPC 传输',
        extend: '技能、命令、子 Agent、规划、压缩、Web、上下文与提示词注入',
        client: '客户端内核与前端外壳',
        infra: '存储、进程、工作区、Loader 等宿主基础设施',
        structure: 'cordis:include 这类结构行，不是插件',
        other: '按命名与注册内容都没有命中上面任何一类',
      }

      /** 只有这些来源层值得在行里点出来；base / web-app 是大多数，标出来只是噪音。 */
      const NOTABLE_LAYERS = new Set(['profile', 'runtime', 'mode'])

      /**
       * 行副标题：有本地化标题时显示标题，否则模块名。
       *
       * 主标题已经是插件 id，副标题用于保留人类可读的名字；与主标题相同就不重复。
       * @param {object} entry - 插件行。
       * @returns {string | null} 副标题。
       */
      function rowSubtitle(entry) {
        const name = shortName(entry)
        if (typeof entry.title === 'string' && entry.title !== '' && entry.title !== name) return entry.title
        if (typeof entry.moduleName === 'string' && entry.moduleName !== '' && entry.moduleName !== name) return entry.moduleName
        return null
      }

      /**
       * 一行「为什么这行留下」。
       *
       * 描述常是用户唯一记得的东西，命中了就要在行上看得见；模块名、包名与运行时 id
       * 可能在行里不显示，不给出来就像随机留下的结果。
       * @param {object} entry - 插件行。
       * @param {string} query - 页头搜索词。
       * @returns {object | null} 摘要节点；没命中或行里已看得见原因时为 null。
       */
      function rowReason(entry, query) {
        if (search.normalizeQuery(query) === '') return null
        if (search.matchesQuery(query, [entry.description])) {
          return h('span', { className: 'ptQueryReason', title: '命中的是描述' }, search.markQuery(entry.description, query))
        }
        if (search.matchesQuery(query, [shortName(entry), rowSubtitle(entry)])) return null
        const fields = [
          search.matchesQuery(query, [entry.title]) ? '显示名 ' + entry.title : null,
          search.matchesQuery(query, [entry.moduleName]) ? '模块 ' + entry.moduleName : null,
          search.matchesQuery(query, [entry.packageName]) ? '包名 ' + entry.packageName : null,
          search.matchesQuery(query, [entry.entryId]) ? '运行时 id ' + entry.entryId : null,
        ].filter((value) => value !== null)
        return fields.length === 0
          ? null
          : h('span', { className: 'ptQueryReason', title: '命中的是行里不显示的字面量' }, fields.join(' · '))
      }

      /**
       * 单行渲染。
       *
       * 行内只保留「值得瞥一眼」的徽标：非默认来源、禁用、失败、条件、
       * 缺服务、被覆盖、注册量。来源层与工具清单的完整信息在详情里。
       * @param {object} props - 行属性。
       * @returns {object} React 节点。
       */
      function Row(props) {
        const { entry, selected, onSelect, snapshot, focused, byId, usage, activityStatus, activityError, control, sessions, reload, query, modeMounts } = props
        const missing = missingServicesOf(entry, snapshot)
        const mounts = modeMounts?.get(entry.moduleName) ?? []
        // 已禁用的行仍可能有调用记录：活动按工具名归并，模式预设里另有一份同名挂载。
        const presetActivity = !entry.enabled && mounts.length > 0
        const tools = entry.registrations?.tools?.length ?? 0
        const sections = (entry.registrations?.sections?.length ?? 0) + (entry.registrations?.contexts?.length ?? 0)
        const expanded = selected || focused
        const reason = rowReason(entry, query)
        const subtitle = rowSubtitle(entry)

        return h(
          'li',
          null,
          h(
            'button',
            {
              type: 'button',
              className: 'ptRow',
              'data-selected': expanded ? 'true' : 'false',
              'data-off': entry.enabled ? 'false' : 'true',
              'data-failed': entry.phase === 'failed' ? 'true' : 'false',
              'aria-expanded': expanded ? 'true' : 'false',
              onClick: () => onSelect(expanded ? null : entry.entryId),
            },
            h('span', { className: 'ptIndent', style: { width: `${entry.depth * 14}px` } }),
            h('span', {
              className: 'ptDot',
              'data-phase': entry.phase ?? 'none',
              'aria-label': `状态：${entry.phase ?? '无存活 fiber'}`,
              role: 'img',
            }),
            h(
              'span',
              { className: 'ptName' },
              search.markQuery(shortName(entry), query),
              subtitle === null
                ? null
                : h('span', { className: 'ptModule', style: { display: 'block' } }, search.markQuery(subtitle, query)),
              reason,
            ),
            NOTABLE_LAYERS.has(entry.layer)
              ? h('span', { className: 'ptTag', title: `来源层：${entry.layer}` }, layerLabel(entry.layer))
              : null,
            entry.phase === 'failed' ? h('span', { className: 'ptTag', 'data-tone': 'error' }, '失败') : null,
            !entry.enabled
              ? h('span', { className: 'ptTag', 'data-tone': 'warn', title: '这一行在全局层面没有启动' }, '全局层面禁用')
              : null,
            presetActivity
              ? h('span', {
                  className: 'ptTag',
                  title: `同一个包在 ${mounts.length} 个模式的预设里另有挂载，调用可能来自那一份`,
                }, '模式内挂载 ' + mounts.length)
              : null,
            entry.disabledExpr ? h('span', { className: 'ptTag', 'data-tone': 'warn', title: '禁用条件：' + entry.disabledExpr }, '禁用条件') : null,
            missing.length
              ? h('span', { className: 'ptTag', 'data-tone': 'error', title: `缺 ${missing.length} 个服务：${missing.join('、')}` }, '缺 ' + missing.length)
              : null,
            entry.overriddenBy.length
              ? h('span', { className: 'ptTag', 'data-tone': 'user', title: `覆盖来源：${entry.overriddenBy.join('、')}` }, '被覆盖')
              : null,
            // 注册量与活动是读数，不是状态：统一靠右，且不再用胶囊包数字。
            rowEnd(
              tools ? h('span', { className: 'ptCount', title: `注册了 ${tools} 个工具` }, '工具 ' + tools) : null,
              sections ? h('span', { className: 'ptCount', title: `注册了 ${sections} 个提示词段与运行时上下文` }, '提示词段 ' + sections) : null,
              activity?.renderUsageTags?.(usage, presetActivity ? '可能来自模式预设里的同名挂载' : undefined) ?? null,
            ),
          ),
          expanded
            ? h(Detail, {
                entry,
                snapshot,
                modeMounts,
                preview: props.preview,
                byId,
                usage,
                activityStatus,
                activityError,
                control,
                sessions,
                reload,
                onOpenTool: props.onOpenTool,
                onOpenSection: props.onOpenSection,
                onOpenPlugin: props.onOpenPlugin,
                onOpenSurface: props.onOpenSurface,
                onPreviewDisable: props.onPreviewDisable,
                anchorId: focused ? 'pt-focused' : undefined,
                onClose: () => onSelect(null),
              })
            : null,
        )
      }

      /**
       * 插件视图正文：按类别分组，让「base 注入了什么」这类问题一眼可答。
       * 分类说明挂在分组标题的 `title` 上，不再单独占一个可折叠块。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderPluginsView(vc) {
        const { filtered, collapsedCategories, setCollapsedCategories, selected, setSelected, snapshot, byId, gotoTool, gotoSection, clearPluginFilters, query, categories } = vc
        // 全局行 → 模式挂载的索引只算一次；逐行重算会变成 行数 × 模式行数。
        const modeMounts = modeMountsOf(snapshot)
        // 变更条是全局诊断，不随当前搜索/筛选消失。
        const changeBar = changes?.renderChanges?.(vc) ?? null
        const searching = search.normalizeQuery(query) !== ''
        const totals = new Map((categories ?? []).map((item) => [item.id, item.count]))

        if (!filtered.length) {
          return h(
            React.Fragment,
            null,
            changeBar,
            h(
              'div',
              { className: 'ptEmpty' },
              '没有匹配的插件。',
              h('div', { style: { marginTop: '10px' } }, textButton('清除筛选', clearPluginFilters)),
            ),
          )
        }
        const groups = new Map()
        for (const entry of filtered) {
          const list = groups.get(entry.category) ?? []
          list.push(entry)
          groups.set(entry.category, list)
        }
        return h(
          React.Fragment,
          null,
          changeBar,
          [...groups.entries()]
            .sort((left, right) => right[1].length - left[1].length)
            .map(([id, list]) => {
              // 搜索激活时忽略折叠：把命中藏在收起的组里，页面看起来就是空的。
              const open = searching || !collapsedCategories.has(id)
              const total = totals.get(id) ?? list.length
              return h(
                'section',
                { key: id },
                h(
                  'div',
                  {
                    className: searching ? 'ptGroupHead' : 'ptGroupHead ptGroupHeadClickable',
                    role: searching ? undefined : 'button',
                    tabIndex: searching ? undefined : 0,
                    title: CATEGORY_NOTES[id] ?? '每个插件只归一类：先看它实际注册的工具/提示词，再看包名职责',
                    'aria-expanded': open ? 'true' : 'false',
                    onClick: searching ? undefined : () => toggleIn(setCollapsedCategories, id),
                    onKeyDown: searching ? undefined : (event) => activateOnKey(event, () => toggleIn(setCollapsedCategories, id)),
                  },
                  h('span', { className: 'ptChevron', 'data-open': open ? 'true' : 'false' }, '▶'),
                  h('span', null, CATEGORY_LABELS[id] ?? id),
                  h(
                    'span',
                    { className: 'ptCount', title: searching ? '筛选中：命中数 / 这一类在筛选前的总数' : undefined },
                    searching ? `${list.length} / ${total} 个` : `${list.length} 个`,
                  ),
                ),
                open
                  ? h(
                      'ul',
                      { className: 'ptList' },
                      list.map((entry) =>
                        h(Row, {
                          key: entry.entryId,
                          entry,
                          query,
                          snapshot,
                          modeMounts,
                          preview: vc.preview,
                          byId,
                          usage: activity?.pluginUsage?.(entry, vc.activity),
                          activityStatus: vc.activityStatus,
                          activityError: vc.activityError,
                          control: vc.control,
                          sessions: [...(vc.allSessions?.values?.() ?? [])],
                          reload: vc.load,
                          selected: selected === entry.entryId || selected === 'row:' + entry.rowId,
                          focused: selected === 'row:' + entry.rowId,
                          onSelect: setSelected,
                          onOpenTool: gotoTool,
                          onOpenSection: gotoSection,
                          onOpenPlugin: vc.gotoPlugin,
                          onOpenSurface: vc.gotoSurface,
                          onPreviewDisable: vc.gotoDisablePreview,
                        }),
                      ),
                    )
                  : null,
              )
            }),
        )
      }

      return { Row, Detail, renderPluginsView }
    }
  },
})
