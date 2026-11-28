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
       * 能力面读数：技能 / 命令 / 网络行为。
       *
       * 技能与命令优先用能力面摘要里的 owner 计数：`dsh-skill-filesystem` 这类
       * provider 发现的技能没有 `skills.register` 源码，只看快照会漏掉整类贡献。
       * 摘要还没到位或该 owner 在摘要里为 0 时，退回源码扫描的数量，避免行上
       * 什么都不显示。网络行为只数源码扫描到的调用/配置点，是静态证据。
       * @param {object} entry - 插件行。
       * @param {{skills?: object, commands?: object}} [summary] - 按 owner 聚合的能力面计数。
       * @returns {object} 读数。
       */
      function surfaceReadingsOf(entry, summary) {
        const regs = entry?.registrations ?? {}
        const countOf = (field) => (Array.isArray(regs[field]) ? regs[field].length : 0)
        const sourceSkills = countOf('runtimeSkills')
        const sourceCommands = countOf('commands')
        const runtimeSkills = summary?.skills?.[entry.rowId]
        const runtimeCommands = summary?.commands?.[entry.rowId]
        const skillsFromRuntime = typeof runtimeSkills === 'number' && runtimeSkills > 0
        const commandsFromRuntime = typeof runtimeCommands === 'number' && runtimeCommands > 0
        return {
          skills: skillsFromRuntime ? runtimeSkills : sourceSkills,
          sourceSkills,
          skillsFromRuntime,
          commands: commandsFromRuntime ? runtimeCommands : sourceCommands,
          sourceCommands,
          commandsFromRuntime,
          networkSites: countOf('networkSites'),
        }
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
        const { entry, selected, onSelect, snapshot, focused, byId, usage, activityStatus, activityError, control, sessions, reload, query, modeMounts, surface, surfaceSummary } = props
        const missing = missingServicesOf(entry, snapshot)
        const mounts = modeMounts?.get(entry.moduleName) ?? []
        // 已禁用的行仍可能有调用记录：活动按工具名归并，模式预设里另有一份同名挂载。
        const presetActivity = !entry.enabled && mounts.length > 0
        const tools = entry.registrations?.tools?.length ?? 0
        const sections = (entry.registrations?.sections?.length ?? 0) + (entry.registrations?.contexts?.length ?? 0)
        const surfaceReadings = surfaceReadingsOf(entry, surfaceSummary)
        const skillTitle = surfaceReadings.skillsFromRuntime
          ? `能力面当前条件下归属本插件的 ${surfaceReadings.skills} 个技能（按 provider 或源码扫描匹配）`
            + (surfaceReadings.sourceSkills > 0 && surfaceReadings.sourceSkills !== surfaceReadings.skills
              ? `；源码里注册了 ${surfaceReadings.sourceSkills} 个`
              : '')
          : `源码扫描：注册了 ${surfaceReadings.skills} 个技能；运行时是否可见以能力面为准`
        const commandTitle = surfaceReadings.commandsFromRuntime
          ? `能力面当前条件下归属本插件的 ${surfaceReadings.commands} 个斜杠命令（按 definitionId 或源码扫描匹配）`
            + (surfaceReadings.sourceCommands > 0 && surfaceReadings.sourceCommands !== surfaceReadings.commands
              ? `；源码里注册了 ${surfaceReadings.sourceCommands} 个`
              : '')
          : `源码扫描：注册了 ${surfaceReadings.commands} 个斜杠命令；运行时是否可见以能力面为准`
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
              surfaceReadings.skills
                ? h('span', { className: 'ptCount', title: skillTitle }, '技能 ' + surfaceReadings.skills)
                : null,
              surfaceReadings.commands
                ? h('span', { className: 'ptCount', title: commandTitle }, '命令 ' + surfaceReadings.commands)
                : null,
              surfaceReadings.networkSites
                ? h('span', { className: 'ptCount', title: `源码扫描发现 ${surfaceReadings.networkSites} 处网络行为` }, '网络行为 ' + surfaceReadings.networkSites)
                : null,
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
                surface,
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
        const { filtered, collapsedCategories, setCollapsedCategories, selected, setSelected, snapshot, byId, gotoTool, gotoSection, clearPluginFilters, query, categories, missingPlugin, clearMissingPlugin } = vc
        // 全局行 → 模式挂载的索引只算一次；逐行重算会变成 行数 × 模式行数。
        const modeMounts = modeMountsOf(snapshot)
        // 变更条是全局诊断，不随当前搜索/筛选消失。
        const changeBar = changes?.renderChanges?.(vc) ?? null
        // 能力面 / 关系图给出的 owner 可能来自旧快照、模式专属模块或已被移除的行；
        // 跳转不能静默失手，否则用户只会看到「点了没反应」。
        const missingNotice = typeof missingPlugin === 'string' && missingPlugin.length > 0
          ? h(
              'p',
              { className: 'ptHint', style: { color: 'var(--pt-warn)' } },
              `没有找到行 id「${missingPlugin}」：它可能来自模式专属模块、旧快照，或这一行已被移除。`,
              ' ',
              typeof clearMissingPlugin === 'function' ? textButton('关闭', clearMissingPlugin) : null,
            )
          : null
        const searching = search.normalizeQuery(query) !== ''
        const totals = new Map((categories ?? []).map((item) => [item.id, item.count]))

        if (!filtered.length) {
          return h(
            React.Fragment,
            null,
            changeBar,
            missingNotice,
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
          missingNotice,
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
                          surface: vc.surface,
                          surfaceSummary: vc.surface?.summary?.counts ?? null,
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
