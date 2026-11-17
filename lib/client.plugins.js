/**
 * 插件视图：这台机器装了什么、都在干什么。
 *
 * 按能力类别分组（可折叠），可再按来源层与状态筛选；点一行展开
 * 基本信息 / 状态 / 组合链 / 服务 / 行为 / 注册项六段事实。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.plugins.js')` 取它，
 * 工厂返回 `create(deps)`，`deps` 是共享工具集合。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.plugins.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect } = React

    return function create(deps) {
      const {
        shortName, layerLabel, depList, fact, shortId, textButton, rowEnd,
        CATEGORY_LABELS, toggleIn, activateOnKey, activity, changes, control, effects, search,
      } = deps

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

      /**
       * 详情字段的一句话解释。
       *
       * 绑定在字段名的 `title` 上，悬停即见；这样同一份解读不再以
       * `ptSectionNote` 的形式长期占版面。
       */
      const FACT_TIPS = {
        rowId: '插件声明使用的id',
        entryId: 'Loader树里的运行时实例id',
        loadIndex: '加载顺序就是组合文件的声明顺序',
        module: '这个条目加载的模块名',
        packageName: '从模块名解析出的包名',
        version: '包声明的版本',
        packageDir: '包在磁盘上的目录',
        face: 'host = 宿主/管理侧（Node/Cordis）：工具、服务、存储与权限等；client = 浏览器侧（dsh.client）：负责面板与交互',
        description: '包提供的本地化描述',
        metaError: '读取包元信息时发生的错误',
        enabled: '当自身未被禁用且祖先 group 也没有被禁用时为启用',
        inheritedDisabled: '插件自身没有禁用，但祖先 group 被禁用',
        disabledExpr: '组合文件里的条件禁用表达式',
        disabledValue: 'true 表示禁用，false 表示启用',
        phase: 'active = 已激活；pending = 等待依赖；loading / unloading = 正在切换；failed = 启动失败；无存活 fiber = 未挂载',
        diagnostic: 'fiber 启动失败时的错误信息',
        config: '插件收到的生效配置，可能包含凭据',
        source: '来源： profile patch（插件市场等 ） / base / web-app / profile / 运行时挂载 / 模式挂载等',
        layerVersion: '插件所属的组合包（bundle）以及版本',
        override: 'patch 层按行id覆盖 config、disabled 等的键内容',
        requires: '插件生效前需要等待的服务，没有提供者时会停在 pending',
        provides: '插件注册和对外提供的服务，停掉后消费者会失去依赖',
        clientDeps: '页面浏览方面（dsh.client）声明需要的的模块依赖',
        behavior: 'Cordis 登记的副作用（注册工具、监听事件、提供服务等）',
      }

      /** 只有这些来源层值得在行里点出来；base / web-app 是大多数，标出来只是噪音。 */
      const NOTABLE_LAYERS = new Set(['profile', 'runtime', 'mode'])

      /**
       * 一行「为什么这行留下」。
       *
       * 描述常是用户唯一记得的东西，命中了就要在行上看得见；包名与行 id 命中时
       * 标题本身不带这些字，不给出来就像随机留下的结果。
       * @param {object} entry - 插件行。
       * @param {string} query - 页头搜索词。
       * @returns {object | null} 摘要节点；没命中或行里已看得见原因时为 null。
       */
      function rowReason(entry, query) {
        if (search.normalizeQuery(query) === '') return null
        if (search.matchesQuery(query, [entry.description])) {
          return h('span', { className: 'ptQueryReason', title: '命中的是描述' }, search.markQuery(entry.description, query))
        }
        if (search.matchesQuery(query, [entry.title, entry.moduleName])) return null
        const fields = [
          search.matchesQuery(query, [entry.packageName]) ? '包名 ' + entry.packageName : null,
          search.matchesQuery(query, [entry.rowId]) ? '组合行 ' + entry.rowId : null,
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
        const { entry, selected, onSelect, snapshot, focused, byId, usage, activityStatus, activityError, control, sessions, reload, query } = props
        const missing = entry.requires.filter((name) => (snapshot.services[name]?.providers ?? []).length === 0)
        const tools = entry.registrations?.tools?.length ?? 0
        const sections = (entry.registrations?.sections?.length ?? 0) + (entry.registrations?.contexts?.length ?? 0)
        const expanded = selected || focused
        const reason = rowReason(entry, query)

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
              h('span', { className: 'ptModule', style: { display: 'block' } }, search.markQuery(entry.moduleName, query)),
              reason,
            ),
            NOTABLE_LAYERS.has(entry.layer)
              ? h('span', { className: 'ptTag', title: `来源层：${entry.layer}` }, layerLabel(entry.layer))
              : null,
            entry.phase === 'failed' ? h('span', { className: 'ptTag', 'data-tone': 'error' }, '失败') : null,
            !entry.enabled ? h('span', { className: 'ptTag', 'data-tone': 'warn' }, '已禁用') : null,
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
              sections ? h('span', { className: 'ptCount', title: `注册了 ${sections} 个提示词区块` }, '提示词段 ' + sections) : null,
              activity?.renderUsageTags?.(usage) ?? null,
            ),
          ),
          expanded
            ? h(Detail, {
                entry,
                snapshot,
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
                anchorId: focused ? 'pt-focused' : undefined,
                onClose: () => onSelect(null),
              })
            : null,
        )
      }

      /** 选中行的若干段事实。 */
      function Detail({ entry, snapshot, byId, onOpenTool, onOpenSection, onOpenPlugin, anchorId, onClose, usage, activityStatus, activityError, control, sessions, reload }) {
        // 被跳转定位时把详情滚进视野。
        //
        // 展开发生在虚拟的高度里，浏览器不会自己滚动；而滚动容器不是 window，
        // 是外层 .ptBody（overflow:auto）。所以用 scrollIntoView 并让它自己找容器。
        useEffect(() => {
          if (anchorId === undefined) return
          const node = document.getElementById(anchorId)
          if (node === null || typeof node.scrollIntoView !== 'function') return
          node.scrollIntoView({ block: 'center', behavior: 'auto' })
        }, [anchorId])

        /** 服务里的运行时条目 id 渲染成可跳转的名字；对方不是插件时退回纯文本。 */
        const linksOf = (ids) => ids.map((id, index) => {
          const target = byId.get(id)
          if (target === undefined) return h(React.Fragment, { key: id + index }, index === 0 ? null : '、', shortId(id, byId))
          return h(
            React.Fragment,
            { key: id + index },
            index === 0 ? null : '、',
            h('button', {
              type: 'button',
              className: 'ptTag ptLink',
              title: '在插件页展开 ' + (target.title || target.moduleName),
              onClick: () => onOpenPlugin?.(target.rowId),
            }, shortId(id, byId)),
          )
        })

        const requires = entry.requires.map((name) => {
          const providers = snapshot.services[name]?.providers ?? []
          return {
            key: name,
            node: h(
              React.Fragment,
              null,
              h('span', { className: 'ptDepKey' }, name),
              h(
                'span',
                { className: providers.length ? 'ptDepValue' : 'ptDepValue ptMissing' },
                providers.length ? h(React.Fragment, null, '← ', linksOf(providers)) : '← 无提供者（停在 pending）',
              ),
            ),
          }
        })
        const provides = entry.provides.map((name) => {
          const consumers = snapshot.services[name]?.consumers ?? []
          return {
            key: name,
            node: h(
              React.Fragment,
              null,
              h('span', { className: 'ptDepKey' }, name),
              h(
                'span',
                { className: 'ptDepValue' },
                consumers.length ? h(React.Fragment, null, '→ ', linksOf(consumers)) : '→ 无消费者',
              ),
            ),
          }
        })
        const clientDeps = [...entry.clientInject, ...entry.clientExternal].map((name) => ({
          key: name,
          node: h(
            React.Fragment,
            null,
            h('span', { className: 'ptDepKey' }, name),
            h('span', { className: 'ptDepValue' }, '客户端模块依赖'),
          ),
        }))
        const hasServices = requires.length + provides.length + clientDeps.length > 0
        // 客户端模块不是 host 服务，不能并进「需要」；但在标题里单独计数，
        // 读者才不会以为这一板块只有服务供需两类。
        const serviceCounts = `需要 ${requires.length} · 提供 ${provides.length}${clientDeps.length > 0 ? ` · 客户端 ${clientDeps.length}` : ''}`
        const regs = entry.registrations ?? {}
        const regTools = regs.tools ?? []
        const regSections = [...(regs.sections ?? []), ...(regs.contexts ?? [])]
        // 配置值直接来自快照（options.config）；旧快照只有字段名时退回名字列表。
        const configRows = Array.isArray(entry.configEntries) ? entry.configEntries : []
        const configNode = configRows.length
          ? h(
              'ul',
              { className: 'ptConfigList' },
              configRows.map((row) => h(
                'li',
                { key: row.key },
                h('code', { className: 'ptConfigKey' }, row.key),
                h('span', { className: 'ptConfigEquals' }, '='),
                h('code', { className: 'ptConfigValue' }, row.value),
              )),
            )
          : (entry.configKeys?.length ? h('code', null, entry.configKeys.join(', ')) : null)

        // 控制是唯一会写宿主状态的一段：先算好节点，再和分隔线一起放到最后。
        const controlNode = control?.renderControlSection?.(entry, { control, sessions, reload }) ?? null

        return h(
          'div',
          { className: 'ptDetail', id: anchorId ?? undefined },
          h('div', { className: 'ptDetailClose' }, textButton('收起', onClose)),
          h(
            'div',
            { className: 'ptDetailGrid' },
            h(
              'div',
              { className: 'ptSection' },
              h('p', { className: 'ptSectionTitle' }, '基本信息'),
              entry.modeOnly
                ? h('p', { className: 'ptSub' }, `只由模式挂载（${(entry.modeIds ?? []).join('、')}），没有自己的 Loader 行；工具与提示词来自源码扫描。`)
                : null,
              h(
                'dl',
                { className: 'ptFacts' },
                fact('组合行 id', h('code', null, entry.rowId), FACT_TIPS.rowId),
                entry.entryId !== entry.rowId ? fact('运行时 id', h('code', null, entry.entryId), FACT_TIPS.entryId) : null,
                fact('加载序', typeof entry.loadIndex === 'number' ? '#' + (entry.loadIndex + 1) + '（Loader 声明顺序）' : null, FACT_TIPS.loadIndex),
                fact('模块', h('code', null, entry.moduleName), FACT_TIPS.module),
                fact('包名', entry.packageName ? h('code', null, entry.packageName) : null, FACT_TIPS.packageName),
                fact('版本', entry.version, FACT_TIPS.version),
                fact('包目录', entry.packageDir ? h('code', null, entry.packageDir) : null, FACT_TIPS.packageDir),
                fact('面', entry.face === 'both' ? 'host + client（双面）' : 'host', FACT_TIPS.face),
                fact('描述', entry.description, FACT_TIPS.description),
                entry.metaError ? fact('元信息诊断', h('span', { className: 'ptError' }, entry.metaError), FACT_TIPS.metaError) : null,
              ),
            ),
            h(
              'div',
              { className: 'ptSection' },
              h('p', { className: 'ptSectionTitle' }, '状态'),
              h(
                'dl',
                { className: 'ptFacts' },
                fact('有效启用', entry.enabled ? '是' : '否', FACT_TIPS.enabled),
                entry.inheritedDisabled ? fact('禁用来源', '祖先 group 被禁用', FACT_TIPS.inheritedDisabled) : null,
                entry.disabledExpr ? fact('禁用表达式', h('code', null, entry.disabledExpr), FACT_TIPS.disabledExpr) : null,
                entry.disabledExpr ? fact('表达式求值', entry.disabledValue ? 'true（禁用）' : 'false（启用）', FACT_TIPS.disabledValue) : null,
                fact('fiber 阶段', entry.phase ?? '无存活 fiber', FACT_TIPS.phase),
                entry.diagnostic ? fact('失败诊断', h('span', { className: 'ptError' }, entry.diagnostic), FACT_TIPS.diagnostic) : null,
                configNode ? fact('配置字段', configNode, FACT_TIPS.config) : null,
              ),
            ),
            h(
              'div',
              { className: 'ptSection' },
              h('p', { className: 'ptSectionTitle' }, '组合链（加载与覆盖）'),
              h(
                'div',
                { className: 'ptFlow' },
                h('div', { className: 'ptFlowStep', title: FACT_TIPS.source }, h('span', { className: 'ptFlowKey' }, '来源'), h('span', { className: 'ptFlowValue' }, entry.userInserted ? 'profile patch 插入' : layerLabel(entry.layer))),
                h('div', { className: 'ptFlowStep', title: FACT_TIPS.layerVersion }, h('span', { className: 'ptFlowKey' }, '层版本'), h('span', { className: 'ptFlowValue' }, entry.layerVersion ? `${layerLabel(entry.layer)}@${entry.layerVersion}` : layerLabel(entry.layer))),
                h('div', { className: 'ptFlowStep', title: FACT_TIPS.rowId }, h('span', { className: 'ptFlowKey' }, '组合行 id'), h('span', { className: 'ptFlowValue' }, entry.rowId)),
                h('div', { className: 'ptFlowStep', title: FACT_TIPS.entryId }, h('span', { className: 'ptFlowKey' }, '运行时 id'), h('span', { className: 'ptFlowValue' }, entry.entryId, typeof entry.loadIndex === 'number' ? h('span', { title: FACT_TIPS.loadIndex }, `（加载序 #${entry.loadIndex + 1}）`) : null)),
                entry.overriddenBy.length
                  ? h('div', { className: 'ptFlowStep', 'data-tone': 'muted', title: FACT_TIPS.override }, h('span', { className: 'ptFlowKey' }, '覆盖'), h('span', { className: 'ptFlowValue' }, entry.overriddenBy.join(' → ')))
                  : null,
              ),
            ),
            h(
              'div',
              { className: 'ptSection' },
              h('p', { className: 'ptSectionTitle' }, `依赖与提供（${serviceCounts}）`),
              hasServices
                ? h(
                    React.Fragment,
                    null,
                    requires.length ? h('p', { className: 'ptSub', style: { margin: 0 }, title: FACT_TIPS.requires }, '需要（inject）') : null,
                    requires.length ? depList(requires) : null,
                    provides.length ? h('p', { className: 'ptSub', style: { margin: 0 }, title: FACT_TIPS.provides }, '提供（provisions）') : null,
                    provides.length ? depList(provides) : null,
                    clientDeps.length ? h('p', { className: 'ptSub', style: { margin: 0 }, title: FACT_TIPS.clientDeps }, '客户端模块') : null,
                    clientDeps.length ? depList(clientDeps) : null,
                  )
                : h('p', { className: 'ptSub', style: { margin: 0 } }, '没有任何依赖、客户端模块或提供项。'),
            ),
            // 先给「它给了你什么」（注册项），再给框架层的「行为」记录；后者更抽象。
            regTools.length + regSections.length
              ? h(
                  'div',
                  { className: 'ptSection' },
                  h('p', { className: 'ptSectionTitle' }, `注册的工具与提示词（${regTools.length + regSections.length}）`),
                  regTools.length
                    ? h(
                        'div',
                        { className: 'ptChipGroup' },
                        h('span', { className: 'ptSub' }, `工具 ${regTools.length}`),
                        regTools.map((name) => h(
                          'button',
                          { key: name, type: 'button', className: 'ptTag ptLink', title: '在「工具」页查看该工具', onClick: () => onOpenTool(name) },
                          name,
                        )),
                      )
                    : null,
                  regSections.length
                    ? h(
                        'div',
                        { className: 'ptChipGroup' },
                        h('span', { className: 'ptSub' }, `提示词区块 ${regSections.length}`),
                        regSections.map((name) => h(
                          'button',
                          { key: name, type: 'button', className: 'ptTag ptLink', title: '在「提示词」页查看该段落', onClick: () => onOpenSection(name) },
                          name,
                        )),
                      )
                    : null,
                )
              : null,
            h(
              'div',
              { className: 'ptSection' },
              h('p', { className: 'ptSectionTitle', title: FACT_TIPS.behavior }, `行为（${entry.effects?.length ?? 0}）`),
              effects.effectsList(entry.effects ?? []),
            ),
            // 观测在读事实之后：先知道它注册了什么，再看最近 7 天实际被调用了多少。
            activity?.renderPluginActivity?.(entry, usage, activityStatus, activityError) ?? null,
            controlNode === null
              ? null
              : h(React.Fragment, null, h('hr', { className: 'ptDivider' }), controlNode),
          ),
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
