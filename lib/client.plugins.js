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
    const { createElement: h, useEffect, useMemo, useState } = React

    return function create(deps) {
      const {
        shortName, layerLabel, depList, fact, shortId, textButton, rowEnd, missingServicesOf, modeMountsOf,
        CATEGORY_LABELS, toggleIn, activateOnKey, activity, changes, control, effects, search,
        fetchJson, REGISTRATION_SITE_ROUTE,
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
        rowId: '插件声明使用的id；同一个包被挂载成多行时，列表与选择器靠它区分',
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
        modeMounts: '这一行在全局层面没有启动，但同一个包由这些模式的预设在会话里挂载，调用与工具可见性来自那一份',
        inheritedDisabled: '插件自身没有禁用，但祖先 group 被禁用',
        disabledExpr: '组合文件里的条件禁用表达式',
        disabledValue: 'true 表示禁用，false 表示启用',
        phase: 'active = 已激活；pending = 等待依赖；loading / unloading = 正在切换；failed = 启动失败；无存活 fiber = 未挂载',
        diagnostic: 'fiber 启动失败时的错误信息',
        config: '插件收到的生效配置，可能包含凭据',
        source: '来源： profile patch（插件市场等 ） / base / web-app / profile / 运行时挂载 / 模式挂载等',
        layerVersion: '插件所属的组合包（bundle）以及版本',
        override: 'patch 层按行id覆盖 config、disabled 等的键内容',
        requires: '插件生效前需要等待的服务，没有提供者时会停在 pending；由宿主上下文提供的服务不算缺失',
        provides: '插件注册和对外提供的服务，停掉后消费者会失去依赖',
        clientDeps: '页面浏览方面（dsh.client）声明需要的的模块依赖',
        behavior: 'Cordis 登记的副作用（注册工具、监听事件、提供服务等）',
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
                onPreviewDisable: props.onPreviewDisable,
                anchorId: focused ? 'pt-focused' : undefined,
                onClose: () => onSelect(null),
              })
            : null,
        )
      }

      /** 选中行的若干段事实。 */
      function Detail({ entry, snapshot, modeMounts, preview, byId, onOpenTool, onOpenSection, onOpenPlugin, onPreviewDisable, anchorId, onClose, usage, activityStatus, activityError, control, sessions, reload }) {
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

        // 全局行禁用但模式里另有挂载时，「禁用」与「有调用」说的是两份东西。
        const mounts = (modeMounts ?? modeMountsOf(snapshot)).get(entry.moduleName) ?? []
        const mountLabels = mounts.map((mount) => (mount.conditional ? `${mount.label}（条件）` : mount.label))
        const presetActivity = !entry.enabled && mounts.length > 0

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
              title: '在插件页展开 ' + (target.rowId ?? target.entryId ?? target.moduleName),
              onClick: () => onOpenPlugin?.(target.rowId),
            }, shortId(id, byId)),
          )
        })

        /** 接收者三档的界面文案；与 host 的 receiverKind 同名。 */
        const RECEIVER_LABELS = {
          own: '本作用域',
          other: '其它作用域',
          unknown: '作用域未知',
        }

        /**
         * 首请求预演一定会推导的会话上下文。
         *
         * 这三段由 `preview-contexts.js` 按工作区 / 权限条件重算，注册接收者往往是
         * `scope`（agent scope），不能按「其它作用域」一律排除。名单之外的
         * session-scope 上下文仍然只给注册点，避免凭名字猜。
         */
        const DERIVED_CONTEXTS = new Set(['working-directory:current', 'sandbox:policy', 'approval:policy'])

        /**
         * 模板名与具体名的匹配：`tool:${name}` 只做前后缀检查。
         *
         * 不把它当 JavaScript 模板求值：变量值在运行时才知道，这里只回答
         * 「源码里的模板可能落到哪些实际名字」。匹配到多个时调用方不得瞎选。
         * @param {string} pattern - 源码里的名字（可能含 `${}`）。
         * @param {string} actual - 注册表/预演里的实际名字。
         * @returns {boolean} 是否可能匹配。
         */
        function templateMatches(pattern, actual) {
          const cut = pattern.indexOf('${')
          if (cut < 0) return pattern === actual
          const close = pattern.indexOf('}', cut)
          if (close < 0) return false
          const prefix = pattern.slice(0, cut)
          const tail = pattern.slice(close + 1)
          if (actual.length < prefix.length + tail.length) return false
          return actual.startsWith(prefix) && actual.endsWith(tail)
        }

        /**
         * 把源码名解析成唯一的具体名。
         *
         * 精确命中优先；模板命中只有**恰好一个**结果时才采用。`tool:${toolName}`
         * 会命中所有 `tool:*`，这种歧义必须保留成「未解析」，不能猜一个。
         * @param {string[]} names - 注册表/预演里的名字。
         * @param {string} display - 展示名（已展开的名字或原名）。
         * @param {string} raw - 源码里的原名。
         * @returns {string | undefined} 具体名或 undefined。
         */
        function concreteNameOf(names, display, raw) {
          if (names.includes(display)) return display
          if (names.includes(raw)) return raw
          const matches = names.filter((name) => templateMatches(raw, name))
          return matches.length === 1 ? matches[0] : undefined
        }

        /** 预演里当前可见的名字：系统段、装配上下文，以及 runtime-context 的消息分段。 */
        function previewNamesOf(preview, kind) {
          if (preview === null || preview === undefined) return []
          if (kind === 'context') {
            const names = (preview.contexts ?? []).map((row) => row.name)
            for (const message of preview.messages ?? []) {
              for (const part of message.parts ?? []) {
                if (typeof part.name === 'string') names.push(part.name)
              }
            }
            return names
          }
          return (preview.sections ?? []).map((row) => row.name)
        }

        /** 全局注册表里的名字。 */
        function globalNamesOf(snapshot, kind) {
          const table = kind === 'context' ? snapshot?.prompt?.contexts : snapshot?.prompt?.sections
          return (table ?? []).map((row) => row.name)
        }

        /** 某个条目对某个名字的注册点；`resolvedName` 也接受，方便按展开后的名字查。 */
        function sitesFor(entry, kind, name) {
          const sites = (entry.registrationSites ?? []).filter((site) => (
            site.kind === kind && (site.name === name || site.resolvedName === name)
          ))
          // 与片段服务同向：非入口的 types/*.js 更短，通常更完整，排在 entry bundle 前面。
          const entryRank = (file) => (/(^|\/)index\.(?:mjs|cjs|js)$/.test(file) ? 1 : 0)
          return sites.sort((left, right) => (
            entryRank(left.file) - entryRank(right.file)
            || left.file.localeCompare(right.file)
            || left.line - right.line
          ))
        }

        /** 展示名：能展开的模板优先用真实名字，否则保留源码名并让界面标「模板名」。 */
        function displayNameOf(name, sites) {
          return sites.find((site) => typeof site.resolvedName === 'string')?.resolvedName ?? name
        }

        /**
         * 按需读取注册点源码片段。
         *
         * 只在展开本地注册点时才挂载；请求失败不阻塞详情，只把原因显示在片段位置。
         * @param {object} props - `moduleName / kind / name`。
         * @returns {object} React 节点。
         */
        const RegistrationSnippet = useMemo(() => function RegistrationSnippet({ moduleName, kind, name }) {
          const [state, setState] = useState({ status: 'loading' })
          const [mode, setMode] = useState('focus')
          useEffect(() => {
            let live = true
            if (typeof fetchJson !== 'function' || typeof REGISTRATION_SITE_ROUTE !== 'string') {
              setState({ status: 'unavailable', reason: '当前环境不支持读取源码片段' })
              return undefined
            }
            setState({ status: 'loading' })
            fetchJson(REGISTRATION_SITE_ROUTE, {
              method: 'POST',
              body: JSON.stringify({ moduleName, kind, name, mode }),
            })
              .then((data) => {
                if (!live) return
                if (data?.found === true && Array.isArray(data.sites)) setState({ status: 'ready', sites: data.sites })
                else setState({ status: 'empty', reason: typeof data?.reason === 'string' ? data.reason : '没有找到源码片段' })
              })
              .catch((error) => {
                if (live) setState({ status: 'error', reason: error instanceof Error ? error.message : String(error) })
              })
            return () => { live = false }
          }, [moduleName, kind, name, mode])

          if (state.status === 'loading') return h('p', { className: 'ptSub', style: { margin: '8px 0 0' } }, '读取源码片段…')
          if (state.status !== 'ready') {
            return h('p', { className: 'ptSub', style: { margin: '8px 0 0' } }, state.reason)
          }
          return h(
            'div',
            { style: { marginTop: '8px' } },
            h(
              'p',
              { className: 'ptSub', style: { margin: '0 0 4px' }, title: '来自包源码的静态扫描，不是运行时装配结果' },
              mode === 'file' ? '源码片段（完整文件）' : '源码片段（注册点前后 16 行）',
            ),
            h(
              'div',
              { className: 'ptSubBlocks' },
              state.sites.map((site) => h(
                'div',
                { key: `${site.file}-${site.line}` },
                h(
                  'p',
                  { className: 'ptSub', style: { margin: '0 0 4px' } },
                  h('code', null, `${site.file}:${site.line}`),
                  site.receiver === undefined ? null : ' · 接收者 ' + site.receiver,
                ),
                h('pre', { className: 'ptPromptText' }, site.snippet?.text ?? ''),
                site.snippet?.truncated === true
                  ? h('p', { className: 'ptSub', style: { margin: '4px 0 0' } }, '片段已按大小上限截断')
                  : null,
              )),
            ),
            h(
              'p',
              { style: { margin: '6px 0 0' } },
              textButton(
                mode === 'file' ? '只看注册点' : '查看完整文件',
                () => setMode(mode === 'file' ? 'focus' : 'file'),
                { title: mode === 'file' ? '回到注册点前后的短窗口' : '读取整份文件（有独立大小上限）' },
              ),
            ),
          )
        }, [])

        /**
         * 二级展开：何时展示、注册点与源码片段。
         *
         * 默认收起；只有用户主动展开才挂载 `RegistrationSnippet`，避免一打开详情
         * 就为一堆名字发请求。源码片段只取注册点前后的短窗口，完整文件需要再点。
         * @param {object} props - 原因、站点与源码定位信息。
         * @returns {object} React 节点。
         */
        const RegistrationSource = useMemo(() => function RegistrationSource({ reason, sites, moduleName, kind, rawName, hasSiteData }) {
          const [open, setOpen] = useState(false)
          return h(
            'details',
            {
              className: 'ptFold ptFoldable',
              style: { marginTop: '8px' },
              onToggle: (event) => setOpen(event.currentTarget.open === true),
            },
            h('summary', null, h('span', { className: 'ptSub' }, `何时展示 / 注册点与源码（${sites.length} 个注册点）`)),
            open
              ? h(
                  'div',
                  { className: 'ptSubBlocks', style: { marginTop: '6px' } },
                  h('p', { className: 'ptSub', style: { margin: '0 0 6px' } }, reason),
                  hasSiteData === false
                    ? h('p', { className: 'ptSub', style: { margin: '0 0 6px' } }, '没有注册点数据（旧快照、扫描失败或站点被上限截断）。')
                    : null,
                  sites.length
                    ? sites.map((site) => h(
                        'p',
                        { key: `${site.file}-${site.line}`, className: 'ptSub', style: { margin: 0 } },
                        '注册点 ',
                        h('code', null, `${site.file}:${site.line}`),
                        ' · 接收者 ',
                        h('code', null, site.receiver ?? '未识别'),
                        ' · ',
                        h('span', { className: 'ptTag' }, RECEIVER_LABELS[site.receiverKind] ?? '作用域未知'),
                      ))
                    : null,
                  h(RegistrationSnippet, { moduleName, kind, name: rawName }),
                )
              : null,
          )
        }, [])

        /**
         * 一个没有可用装配落点的提示词贡献。
         *
         * 主视图先回答「注入了什么文本」，再给一个二级展开回答「何时注入、注册点在哪」。
         * 默认收起；展开后按需读源码片段。这里不使用跳转：预演页答不了
         * 「子代理创建时注册了什么」，点过去只会得到死链。
         * @param {object} props - 名字、站点、标签与原因。
         * @returns {object} React 节点。
         */
        const RegistrationFold = useMemo(() => function RegistrationFold({ display, rawName, kind, sites, tags, reason, moduleName, hasSiteData, linkable, onOpen, onSearch }) {
          const [open, setOpen] = useState(false)
          const textSite = sites.find((site) => site.text !== undefined && typeof site.text.value === 'string')
          const runtimeSite = sites.find((site) => site.text !== undefined
            && (site.text.kind === 'function' || site.text.kind === 'expression'))
          return h(
            'li',
            null,
            h(
              'details',
              {
                className: 'ptPromptBlock ptFold ptFoldable',
                onToggle: (event) => setOpen(event.currentTarget.open === true),
              },
              h(
                'summary',
                { title: '来自包源码的静态扫描，不是模型在当前首请求里实际收到的正文' },
                h('span', { className: 'ptPromptName' }, display),
                ...tags,
                linkable && typeof onOpen === 'function'
                  ? textButton(
                      '预演',
                      (event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        onOpen()
                      },
                      { title: '在上下文预演中查看这个落点' },
                    )
                  : null,
                rowEnd(
                  h('span', { className: 'ptCount', title: '源码里的注册点数量' }, `注册点 ${sites.length}`),
                ),
              ),
              open
                ? h(
                    'div',
                    { style: { padding: '10px 12px' } },
                    textSite === undefined
                      ? runtimeSite === undefined
                        ? h(
                            'p',
                            { className: 'ptSub', style: { margin: 0 }, title: '源码扫描没有在这个注册对象里找到 text 字段；可能是扫描盲区，也可能这段注册本来就不带正文' },
                            '暂无可解析的注入文本：源码里没有找到 text 字段，可能是扫描不到注册点。',
                          )
                        : h(
                            React.Fragment,
                            null,
                            h(
                              'p',
                              { className: 'ptSub', style: { margin: 0 } },
                              '运行时求值：',
                              h('code', null, runtimeSite.text.expression ?? ''),
                            ),
                            h(
                              'p',
                              {
                                className: 'ptSub',
                                style: { margin: '4px 0 0' },
                                title: 'DSH 在 assemble() 时才调用 text 函数或者读取运行时变量',
                              },
                              '这段文本是函数或运行时表达式，由 DSH 在真实会话 / 子代理创建时计算',
                            ),
                            runtimeSite.text.truncated === true
                              ? h('p', { className: 'ptSub', style: { margin: '4px 0 0' } }, '表达式已截断')
                              : null,
                          )
                      : textSite.text.value.length > 0
                        ? h('pre', { className: 'ptPromptText' }, textSite.text.value)
                        : h(
                            'p',
                            { className: 'ptSub', style: { margin: 0 }, title: '源码里的 text 是空字符串；真实装配时这一段不会给模型带来正文' },
                            '暂无注入文本：源码里的 text 是空字符串。',
                          ),
                    textSite?.text.truncated === true
                      ? h('p', { className: 'ptSub', style: { margin: '4px 0 0' } }, '文本已截断')
                      : null,
                    linkable
                      ? null
                      : h(
                          'p',
                          { style: { margin: '6px 0 0' } },
                          textButton('去预演中搜索同名段', onSearch, { title: '跳到预演页尝试查找本段' }),
                        ),
                    h(RegistrationSource, { reason, sites, moduleName, kind, rawName, hasSiteData }),
                  )
                : null,
            ),
          )
        }, [])

        const hostRequires = new Set(entry.hostRequires ?? [])
        const requires = entry.requires.map((name) => {
          const providers = snapshot.services[name]?.providers ?? []
          const hostProvided = hostRequires.has(name)
          return {
            key: name,
            node: h(
              React.Fragment,
              null,
              h('span', { className: 'ptDepKey' }, name),
              providers.length
                ? h('span', { className: 'ptDepValue' }, '← ', linksOf(providers))
                // Loader 自己的服务与宿主在挂树之前 provide() 的服务没有 Loader 行；
                // 能解析出来就说明不缺失，不能因为索引里没有就写成 pending。
                : hostProvided
                  ? h(
                      'span',
                      {
                        className: 'ptDepValue',
                        title: '由宿主上下文提供，没有对应的 Loader 行',
                      },
                      '← 宿主上下文（不在 Loader 树里）',
                    )
                  : h('span', { className: 'ptDepValue ptMissing' }, '← 无提供者（停在 pending）'),
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
        const regSectionNames = regs.sections ?? []
        const regContextNames = regs.contexts ?? []
        // 旧快照没有 registrationSites；那种情况下退回「按全局注册表判断」的旧行为，
        // 不能因为缺数据把整块注册项都变成死链。
        const hasSiteData = Array.isArray(entry.registrationSites)
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
        const controlNode = control?.renderControlSection?.(entry, { control, sessions, reload, onPreviewDisable }) ?? null

        /** 一个不可定位贡献的原因；按外部作用域、上下文种类、缺数据逐级解释。 */
        const reasonOf = (row, kind) => {
          if (hasSiteData === false) return '这次快照没有带注册点数据，无法判断作用域，上下文预演里也没有这个名字'
          if (row.externalOnly) {
            const receivers = [...new Set(row.sites.map((site) => site.receiver ?? '未识别'))].join('、')
            // 「同名条目」只在全局表里确实有时才说；否则这句话会变成假事实。
            return `这段注册挂在 ${receivers} 上，不在首请求上下文预演的 global + preset scope 内`
              + (row.globalRow === undefined ? '' : '，全局注册表里的同名条目来自其它注册点')
          }
          if (kind === 'context') {
            return '这是运行时上下文（消息层注入），可能只在会话或子代理作用域注册'
          }
          return '这个名字只出现在源码扫描里，全局注册表与上下文预演都没有它，可能由模式、会话或条件作用域注册'
        }

        /**
         * 渲染一组提示词贡献。
         *
         * 可定位 → 普通链接；不可定位 → 可展开的注册点。两组分开，避免 A 组有落点
         * 就把 B 组也渲染成蓝色链接，让人误以为都能跳。
         * @param {'section' | 'context'} kind - 贡献种类。
         * @param {string[]} names - 源码扫描出的名字。
         * @param {string} label - 组标题。
         * @param {string} note - 组标题的悬停说明。
         * @returns {object | null} React 节点。
         */
        const renderContributionGroup = (kind, names, label, note) => {
          if (names.length === 0) return null
          const rows = names.map((rawName) => {
            const sites = sitesFor(entry, kind, rawName)
            const display = displayNameOf(rawName, sites)
            // 预演会按条件重算的三段会话上下文：即使接收者是 `scope`，也应当可定位。
            const derived = kind === 'context' && DERIVED_CONTEXTS.has(display)
            const externalOnly = !derived && sites.length > 0 && sites.every((site) => site.receiverKind === 'other')
            const globalTarget = concreteNameOf(globalNamesOf(snapshot, kind), display, rawName)
            const previewTarget = concreteNameOf(previewNamesOf(preview, kind), display, rawName)
            const target = externalOnly ? undefined : (globalTarget ?? previewTarget ?? (derived ? display : undefined))
            const linkable = !externalOnly && (hasSiteData ? target !== undefined : true)
            const table = kind === 'context' ? snapshot?.prompt?.contexts : snapshot?.prompt?.sections
            const globalRow = (table ?? []).find((row) => row.name === (globalTarget ?? display))
            // 唯一来源：名字级索引恰好只有本行，注册点全在本作用域，且名字不是模板。
            // 这是「按当前扫描范围」的结论，不是宿主运行时保证。
            const ownerIds = [...new Set([
              ...(snapshot?.prompt?.nameOwners?.[display] ?? []),
              ...(snapshot?.prompt?.nameOwners?.[rawName] ?? []),
            ])]
            const uniqueSource = ownerIds.length === 1
              && ownerIds[0] === entry.rowId
              && sites.length > 0
              && sites.every((site) => site.receiverKind === 'own')
              && !rawName.includes('${')
            return { rawName, display, sites, derived, externalOnly, globalTarget, previewTarget, target, linkable, globalRow, uniqueSource }
          })
          return h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'ptChipGroup', style: { marginTop: '6px' } },
              h('span', { className: 'ptSub', title: note }, `${label} ${names.length}`),
            ),
            h(
              'ul',
              { className: 'ptList', style: { marginTop: '4px' } },
              rows.map((row) => {
                const tags = []
                if (row.uniqueSource) {
                  tags.push(h('span', { key: 'unique', className: 'ptTag', 'data-tone': 'user', title: '源码扫描只找到这一个注册者，且注册点在本作用域；按当前扫描范围可视为唯一来源' }, '唯一来源'))
                }
                if (row.externalOnly) {
                  tags.push(h('span', { key: 'scope', className: 'ptTag', 'data-tone': 'warn', title: '首请求不覆盖这段注册' }, '其它作用域'))
                }
                if (row.rawName.includes('${')) {
                  tags.push(h('span', { key: 'template', className: 'ptTag', title: `源码里写的是模板 ${row.rawName}` }, '模板名'))
                }
                if (row.globalRow !== undefined && !row.uniqueSource) {
                  tags.push(h('span', { key: 'same', className: 'ptTag', title: '全局注册表里有同名条目，预演展示的是运行时生效不一定是本条' }, '同名'))
                }
                if (hasSiteData === false) {
                  tags.push(h('span', { key: 'nodata', className: 'ptTag', 'data-tone': 'warn', title: '旧快照、扫描失败或站点被上限截断' }, '无注册点数据'))
                }
                if (hasSiteData && row.sites.length === 0) {
                  tags.push(h('span', { key: 'empty', className: 'ptTag', 'data-tone': 'warn', title: '源码扫描没有给出注册点' }, '无注册点'))
                }
                return h(RegistrationFold, {
                  key: row.rawName,
                  display: row.display,
                  rawName: row.rawName,
                  kind,
                  sites: row.sites,
                  tags,
                  reason: row.linkable
                    ? '当前首请求预演里有这个落点；下面是源码注册点'
                    : reasonOf(row, kind),
                  moduleName: entry.moduleName,
                  hasSiteData,
                  linkable: row.linkable,
                  onOpen: row.linkable ? () => onOpenSection(row.target ?? row.display, kind, entry.moduleName) : undefined,
                  onSearch: () => onOpenSection(row.target ?? row.display, kind, entry.moduleName),
                })
              }),
            ),
          )
        }

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
                presetActivity
                  ? fact('模式内挂载', mountLabels.join('、'), FACT_TIPS.modeMounts)
                  : null,
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
            regTools.length + regSectionNames.length + regContextNames.length
              ? h(
                  'div',
                  { className: 'ptSection' },
                  h('p', { className: 'ptSectionTitle' }, `注册的工具与提示词（${regTools.length + regSectionNames.length + regContextNames.length}）`),
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
                  renderContributionGroup('section', regSectionNames, '提示词段', '系统提示词段；可定位 = 全局注册表或当前预演里有这个落点'),
                  renderContributionGroup('context', regContextNames, '运行时上下文', '以 runtime-context 消息注入，不属于系统提示词；可定位 = 当前预演的消息分段里有这个名字'),
                )
              : null,
            h(
              'div',
              { className: 'ptSection' },
              h('p', { className: 'ptSectionTitle', title: FACT_TIPS.behavior }, `行为（${entry.effects?.length ?? 0}）`),
              effects.effectsList(entry.effects ?? []),
            ),
            // 观测在读事实之后：先知道它注册了什么，再看最近 7 天实际被调用了多少。
            activity?.renderPluginActivity?.(
              entry,
              usage,
              activityStatus,
              activityError,
              presetActivity ? '调用按工具名统计，可能来自模式预设里的同名挂载' : undefined,
            ) ?? null,
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
