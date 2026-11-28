/**
 * 能力面 · 网络段：部署视角的网络面。
 *
 * 页面按三个问题组织，而不是按数据来源平铺：
 *   1. 受控出口：经 Cordis 内核注册或配置的受控通道；
 *   2. 直连出口：源码里直接构建的调用点，静态扫描发现，可能绕过 DSH 受控出口；
 *   3. 入站入口：本机对外开放的路由。
 * 三段都是整段可折叠的 `ptSectionFold`，默认展开：并列的段用同一种容器形态，
 * 直连与入站内部再按插件分组（每个插件一个可折叠容器）。
 * 规模只放在各段段头：顶部不再重复一份总览，也不放证据图例——每一行自带证据标签。
 * 不展示 endpoint、headers、env、args。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.surface-network.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.surface-network.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { rowEnd, textButton, UNOWNED_REASON, setDetailsOpen, foldNodes } = deps

      /** 源码规则族 → 展示分组。 */
      const GROUP_LABELS = {
        http: 'HTTP',
        socket: 'Socket',
        websocket: 'WebSocket',
        browser: '浏览器',
        config: '配置',
      }

      /**
       * 标签按性质分色：颜色只表达可信度，类别靠文字区分。
       *   类别（中性）：模型 / 搜索 / 抓取，HTTP / Socket / WebSocket / 浏览器 / 配置；
       *   证据（accent）：运行时 / 注册标签 / 源码扫描；
       *   留意（warn）：推断（未提供受控通道）与缺失（未归属）；
       *   故障（error）：MCP 连接失败。
       * `data-tone=user` 是主题里唯一的 accent 色，这里只当「证据」用，与「用户改动」无关。
       * 数量一律走 `ptCount` 文本，不做胶囊。
       */

      /** provider 类型的悬停说明；写清它由哪个注册表登记。 */
      const PROVIDER_TIPS = {
        模型: 'LLM provider：由 ctx.llm 注册',
        搜索: 'web 搜索 provider：由 ctx.web.registerSearchProvider 注册',
        抓取: 'web 抓取 provider：由 ctx.web.registerFetchProvider 注册',
      }

      /** 源码调用与配置键的悬停说明；静态证据的边界由页底 note 统一说明，不在每个条目里重复。 */
      const SITE_TIPS = {
        http: '源码里的 HTTP 调用（fetch / axios / node:http 等）',
        socket: '源码里的套接字调用（net / tls / dgram / http2）',
        websocket: '源码里的 WebSocket 客户端（ws / socket.io-client）',
        browser: '源码里的浏览器请求 API（XMLHttpRequest / EventSource / sendBeacon）',
        config: '源码里的网络配置键（baseURL / endpoint / host / url 等）',
      }

      /** MCP 连接状态：文字用中文，原始值留在悬停里。 */
      const MCP_STATES = {
        ready: { text: '就绪' },
        starting: { text: '启动中', tone: 'warn' },
        failed: { text: '失败', tone: 'error' },
        disabled: { text: '已禁用' },
        stopped: { text: '已停止', tone: 'warn' },
        unknown: { text: '未知', tone: 'warn' },
      }

      /**
       * 类别标签：中性色，回答「这条东西是什么」。
       * @param {string} text - 标签文字。
       * @param {string} title - 悬停说明。
       * @returns {object} React 节点。
       */
      function kindTag(text, title) {
        return h('span', { className: 'ptTag', title }, text)
      }

      /**
       * 证据标签：accent 色，回答「这个事实从哪来」。
       * @param {string} text - 标签文字。
       * @param {string} title - 悬停说明（「证据：」前缀按需由调用方给出，这里不自动添加）。
       * @returns {object} React 节点。
       */
      function evidenceTag(text, title) {
        return h('span', { className: 'ptTag', 'data-tone': 'user', title }, text)
      }

      /**
       * 留意标签：warn 色，只用于推断结论或缺失数据。
       * @param {string} text - 标签文字。
       * @param {string} title - 悬停说明。
       * @returns {object} React 节点。
       */
      function attentionTag(text, title) {
        return h('span', { className: 'ptTag', 'data-tone': 'warn', title }, text)
      }

      /**
       * MCP 连接状态标签：颜色跟严重程度走，文字用中文。
       * @param {string} state - 运行时状态值。
       * @returns {object} React 节点。
       */
      function mcpStateTag(state) {
        const known = MCP_STATES[state]
        const title = known === undefined
          ? 'MCP 运行时连接状态（未识别的状态值）'
          : `MCP 运行时连接状态（原始值：${state}）`
        return h('span', { className: 'ptTag', 'data-tone': known?.tone, title }, known?.text ?? state)
      }

      /**
       * rowId / entryId → Loader 行；同一行被两种 id 引用时都能查到。
       * @param {object} vc - 视图上下文。
       * @returns {Map<string, object>} 行索引。
       */
      function entryNameMap(vc) {
        const map = new Map()
        const add = (key, entry) => {
          if (typeof key !== 'string' || key.length === 0 || map.has(key)) return
          map.set(key, entry)
        }
        for (const entry of vc.snapshot?.entries ?? []) {
          add(entry.rowId, entry)
          add(entry.entryId, entry)
        }
        return map
      }

      /**
       * 展示名优先用本地化标题，再退包名与模块名；最后才是 Loader id。
       * @param {Map<string, object>} entries - 行索引。
       * @param {string} rowId - Loader 行 id。
       * @returns {string} 展示名。
       */
      function displayName(entries, rowId) {
        const entry = entries.get(rowId)
        if (typeof entry?.title === 'string' && entry.title.length > 0) return entry.title
        if (typeof entry?.packageName === 'string' && entry.packageName.length > 0) return entry.packageName
        if (typeof entry?.moduleName === 'string' && entry.moduleName.length > 0) return entry.moduleName
        return rowId
      }

      /**
       * 模块名；分组头的技术说明用，缺失时退回 Loader id。
       * @param {Map<string, object>} entries - 行索引。
       * @param {string} rowId - Loader 行 id。
       * @returns {string} 模块名。
       */
      function moduleNameOf(entries, rowId) {
        const entry = entries.get(rowId)
        return typeof entry?.moduleName === 'string' && entry.moduleName.length > 0 ? entry.moduleName : rowId
      }

      /**
       * 是否为控制台自己；它的直连是读自己的 API，不按「未提供受控通道」标注。
       * @param {Map<string, object>} entries - 行索引。
       * @param {string} rowId - Loader 行 id。
       * @returns {boolean} 是否控制台自己。
       */
      function isConsoleEntry(entries, rowId) {
        const entry = entries.get(rowId)
        const label = String(entry?.moduleName ?? '') + ' ' + String(entry?.packageName ?? '')
        return rowId === 'plugin-console' || label.includes('dsh-plugin-console')
      }

      /**
       * 是否为 DSH 自带的包；用于把内置入口和用户插件分开。
       * @param {Map<string, object>} entries - 行索引。
       * @param {string} rowId - Loader 行 id。
       * @returns {boolean} 是否 DSH 内置。
       */
      function isBuiltinEntry(entries, rowId) {
        const entry = entries.get(rowId)
        const moduleName = String(entry?.moduleName ?? '')
        const packageName = String(entry?.packageName ?? '')
        return moduleName.startsWith('@deepseek-ai/') || packageName.startsWith('@deepseek-ai/')
      }

      /**
       * 分组排序：第三方插件 → DSH 内置 → 本控制台 → 未归属。
       * @param {object} group - 已归一化的插件分组。
       * @returns {number} 排序权重。
       */
      function groupRank(group) {
        if (group.rowId.length === 0) return 3
        if (group.console) return 2
        if (group.builtin) return 1
        return 0
      }

      /**
       * 归属 chip：显示插件名，悬停保留 loader id，点击跳到插件页。
       * @param {object} row - 带 owners 的行。
       * @param {object} vc - 视图上下文。
       * @param {Map<string, object>} entries - 行索引。
       * @returns {Array<object>} React 节点。
       */
      function ownerChips(row, vc, entries) {
        if (Array.isArray(row.owners) && row.owners.length > 0) {
          return row.owners.map((rowId) => h(
            'button',
            {
              key: rowId,
              type: 'button',
              className: 'ptTag ptLink',
              title: '来源插件：' + rowId,
              onClick: () => vc.gotoPlugin(rowId),
            },
            displayName(entries, rowId),
          ))
        }
        return [attentionTag('未归属', row.ownerReason ?? UNOWNED_REASON)]
      }

      /**
       * 一个 provider。
       * @param {object} row - provider 行。
       * @param {object} vc - 视图上下文。
       * @param {Map<string, object>} entries - 行索引。
       * @param {string} type - 模型 / 搜索 / 抓取。
       * @returns {object} React 节点。
       */
      function providerRow(row, vc, entries, type) {
        const detail = row.name ?? row.title
        return h(
          'li',
          { key: type + ':' + row.id, className: 'ptSurfaceRow' },
          h(
            'span',
            { className: 'ptName' },
            h('code', null, row.id),
            typeof detail === 'string'
              ? h('span', { className: 'ptModule', style: { display: 'block' }, title: detail }, detail)
              : null,
          ),
          row.description !== undefined
            ? h('span', { className: 'ptSub', title: typeof row.description === 'string' ? row.description : undefined }, row.description)
            : null,
          kindTag(type, PROVIDER_TIPS[type] ?? ('provider 类型：' + type)),
          evidenceTag('运行时', '证据：来自运行时服务注册表'),
          rowEnd(...ownerChips(row, vc, entries)),
        )
      }

      /**
       * 一个 MCP server。
       * @param {object} row - server 行。
       * @param {object} vc - 视图上下文。
       * @param {Map<string, object>} entries - 行索引。
       * @returns {object} React 节点。
       */
      function mcpRow(row, vc, entries) {
        const state = row.status?.state ?? 'unknown'
        const detail = row.status?.lastError ?? row.status?.reason
        return h(
          'li',
          { key: 'mcp:' + row.name, className: 'ptSurfaceRow' },
          h(
            'span',
            { className: 'ptName' },
            row.name,
            detail !== undefined
              ? h('span', { className: 'ptModule', style: { display: 'block' }, title: typeof detail === 'string' ? detail : undefined }, detail)
              : null,
          ),
          kindTag(
            row.configured ? '已配置' : '仅注册',
            row.configured ? '配置里声明了这个 server' : '配置里没有它，只在运行时注册',
          ),
          evidenceTag('运行时', '证据：来自运行时 mcpManager.list()'),
          mcpStateTag(state),
          rowEnd(...ownerChips(row, vc, entries)),
        )
      }

      /**
       * 从可读端点里取站点：绝对地址取 scheme + host，裸主机名原样，相对路径归为本地。
       * @param {string | undefined} target - 脱敏后的端点。
       * @returns {string} 站点标签。
       */
      function originOf(target) {
        if (typeof target !== 'string' || target.length === 0) return '（未识别端点）'
        const absolute = /^([a-z][a-z0-9+.-]*:\/\/)([^/]+)/i.exec(target)
        if (absolute !== null) return (absolute[1] + absolute[2]).toLowerCase()
        if (target.startsWith('//')) {
          const relative = /^\/\/([^/]+)/.exec(target)
          return relative === null ? '（未识别端点）' : ('//' + relative[1]).toLowerCase()
        }
        const host = /^([\w.-]+(?::\d+)?)(?:\/|$)/.exec(target)
        if (host !== null) return host[1].toLowerCase()
        if (target.startsWith('/')) return '（本地路径）'
        return '（未识别端点）'
      }

      /**
       * 站点排序：外部站点在前，本地路径与未识别端点在后。
       * @param {string} origin - 站点。
       * @returns {number} 排序权重。
       */
      function originRank(origin) {
        if (!origin.startsWith('（')) return 0
        return origin === '（本地路径）' ? 1 : 2
      }

      /**
       * 组内只展示站点之后的路径，避免每行重复站点；完整值仍在 title 里。
       * @param {string | undefined} target - 脱敏端点。
       * @param {string} origin - 组站点。
       * @returns {string | undefined} 展示值。
       */
      function targetDetail(target, origin) {
        if (typeof target !== 'string' || target.length === 0) return undefined
        if (target === origin) return '/'
        if (target.startsWith(origin + '/')) return target.slice(origin.length)
        return target
      }

      /**
       * 一条源码调用点。
       * @param {object} site - 调用点。
       * @param {string} origin - 组站点。
       * @param {string} prefix - 组 key，用于 React key 去重。
       * @returns {object} React 节点。
       */
      function siteLine(site, origin, prefix) {
        const detail = targetDetail(site.target, origin)
        // 模块名 + 包内路径 + 行号：一行就能拿去定位文件。只用包内相对路径会
        // 丢掉「哪个包」，同名文件在多个插件里无法区分。
        const address = (typeof site.moduleName === 'string' && site.moduleName.length > 0
          ? site.moduleName + '/'
          : '') + site.file + ':' + site.line
        return h(
          'div',
          { key: [prefix, site.file, site.line, site.label, site.kind].join('|'), className: 'ptSurfaceRow' },
          h(
            'span',
            { className: 'ptName' },
            h('code', null, site.label),
            h(
              'span',
              { className: 'ptModule', style: { display: 'inline-block', marginLeft: '6px', maxWidth: '100%', verticalAlign: 'bottom' }, title: address },
              address,
            ),
          ),
          detail !== undefined
            ? h('span', { className: 'ptSub', title: site.target }, detail)
            : null,
          kindTag(
            GROUP_LABELS[site.group] ?? site.group,
            SITE_TIPS[site.group] ?? '源码里匹配到的网络调用点',
          ),
        )
      }

      /**
       * 受控通道的提供者：运行时 provider / MCP 的 owner，加上源码里注册过它们的行。
       * 只用于给直连分组加「推断」标签，不代表调用真的绕过了通道。
       * @param {Map<string, object>} entries - 行索引。
       * @param {Array<object>} providers - 运行时 provider 行。
       * @param {Array<object>} servers - 运行时 MCP 行。
       * @returns {Set<string>} Loader 行 id。
       */
      function managedOwnerSet(entries, providers, servers) {
        const owners = new Set()
        for (const row of [...providers, ...servers]) {
          for (const owner of row.owners ?? []) owners.add(owner)
        }
        for (const entry of new Set(entries.values())) {
          const regs = entry.registrations ?? {}
          const count = (regs.llmProviders?.length ?? 0)
            + (regs.webSearch?.length ?? 0)
            + (regs.webFetch?.length ?? 0)
            + (regs.mcpServers?.length ?? 0)
          if (count === 0) continue
          if (typeof entry.rowId === 'string') owners.add(entry.rowId)
          if (typeof entry.entryId === 'string') owners.add(entry.entryId)
        }
        return owners
      }

      /**
       * 按插件聚合源码调用点；插件内部再按站点分子组，所有调用点都留在容器里。
       * @param {Array<object>} sites - `source.sites`。
       * @param {Map<string, object>} entries - 行索引。
       * @param {Set<string>} managed - 受控通道提供者。
       * @returns {Array<object>} 插件分组。
       */
      function groupSourcePlugins(sites, entries, managed) {
        const plugins = new Map()
        for (const site of sites) {
          const rowId = Array.isArray(site.owners) && site.owners.length > 0 ? site.owners[0] : ''
          let plugin = plugins.get(rowId)
          if (plugin === undefined) {
            const consoleEntry = rowId.length > 0 && isConsoleEntry(entries, rowId)
            plugin = {
              rowId,
              name: rowId.length > 0 ? displayName(entries, rowId) : '未归属',
              console: consoleEntry,
              builtin: rowId.length > 0 && !consoleEntry && isBuiltinEntry(entries, rowId),
              managed: rowId.length > 0 && managed.has(rowId),
              sites: new Map(),
              count: 0,
            }
            plugins.set(rowId, plugin)
          }
          plugin.count += 1
          const origin = originOf(site.target)
          let group = plugin.sites.get(origin)
          if (group === undefined) {
            group = { origin, sites: [], calls: 0, configs: 0 }
            plugin.sites.set(origin, group)
          }
          group.sites.push(site)
          if (site.kind === 'config') group.configs += 1
          else group.calls += 1
        }
        return [...plugins.values()]
          .map((plugin) => ({
            ...plugin,
            siteGroups: [...plugin.sites.values()].sort((left, right) => originRank(left.origin) - originRank(right.origin)
              || left.origin.localeCompare(right.origin)),
            // 内置包的直连是宿主自己的实现：再标「未提供受控通道」等于说宿主自己的包绕过宿主，
            // 与同一行的「DSH 内置」自相矛盾，所以这条推断只给第三方插件。
            externalUnmanaged: plugin.rowId.length > 0
              && !plugin.console
              && !plugin.builtin
              && !plugin.managed
              && [...plugin.sites.keys()].some((origin) => !origin.startsWith('（')),
          }))
          .sort((left, right) => groupRank(left) - groupRank(right)
            || right.count - left.count
            || left.name.localeCompare(right.name))
      }

      /**
       * 按所有者聚合入站路由；插件内部按路径排序。
       * @param {Array<object>} routes - `inbound.routes`。
       * @param {Map<string, object>} entries - 行索引。
       * @returns {Array<object>} 插件分组。
       */
      function groupRoutes(routes, entries) {
        const groups = new Map()
        for (const route of routes) {
          const rowId = Array.isArray(route.owners) && route.owners.length > 0 ? route.owners[0] : ''
          const key = rowId.length > 0 ? rowId : '∅'
          let group = groups.get(key)
          if (group === undefined) {
            group = { rowId, routes: [] }
            groups.set(key, group)
          }
          group.routes.push(route)
        }
        return [...groups.values()]
          .map((group) => {
            const consoleEntry = group.rowId.length > 0 && isConsoleEntry(entries, group.rowId)
            return {
              ...group,
              name: group.rowId.length > 0 ? displayName(entries, group.rowId) : '未归属',
              console: consoleEntry,
              builtin: group.rowId.length > 0 && !consoleEntry && isBuiltinEntry(entries, group.rowId),
              routes: [...group.routes].sort((left, right) => left.path.localeCompare(right.path)),
            }
          })
          .sort((left, right) => groupRank(left) - groupRank(right)
            || right.routes.length - left.routes.length
            || left.name.localeCompare(right.name))
      }

      /**
       * 一个插件的直连容器：默认展开，标题可跳到插件详情。
       * @param {object} plugin - 插件分组。
       * @param {object} vc - 视图上下文。
       * @param {Map<string, object>} entries - 行索引。
       * @returns {object} React 节点。
       */
      function sourcePluginNode(plugin, vc, entries) {
        const owned = plugin.rowId.length > 0
        const moduleName = owned ? moduleNameOf(entries, plugin.rowId) : '没有找到归属'
        return h(
          'details',
          { key: 'direct:' + (plugin.rowId || 'unowned'), className: 'ptOwnerGroup ptNetworkDirect', open: true },
          h(
            'summary',
            { className: 'ptOwnerHead' },
            h('span', { className: 'ptChevron', 'aria-hidden': 'true' }, '▶'),
            owned
              ? h('button', {
                  type: 'button',
                  className: 'ptOwnerName',
                  title: moduleName + ' · 点击查看插件',
                  onClick: (event) => {
                    event.stopPropagation()
                    vc.gotoPlugin(plugin.rowId)
                  },
                }, plugin.name)
              : h('span', { className: 'ptOwnerName', title: UNOWNED_REASON }, '未归属'),
            h('span', { className: 'ptMeta ptMetaWrap' }, moduleName),
            plugin.console
              ? kindTag('本控制台', '本控制台自己发起的调用')
              : plugin.builtin
                ? kindTag('DSH 内置', '来自 @deepseek-ai 包，非第三方插件')
                : null,
            // 「未提供」是注册事实：名下没有 provider / MCP server。它只能说明这个插件
            // 自己没有可归属的受控通道，不能据此断定下面的直连调用绕过了 DSH——多数插件
            // 是通道的使用者而不是提供者。
            plugin.externalUnmanaged
              ? attentionTag('未提供受控通道', '该插件中存在非受控出口的网络行为，可能存在绕过DSH的直连行为')
              : null,
            h('span', { className: 'ptCount' }, `${plugin.siteGroups.length} 站点 · ${plugin.count} 处`),
          ),
          h(
            'div',
            { className: 'ptOwnerBody' },
            plugin.siteGroups.map((group) => h(
              'div',
              { key: group.origin, className: 'ptSubSection', style: { marginTop: '8px' } },
              h(
                'div',
                { className: 'ptSurfaceRow' },
                // 组头展示的是从调用点字面量里提取出的站点，不是调用名；加前缀避免被读成
                // 又一条「名字 + 数量」的聚合行。
                h('span', { className: 'ptSub' }, '请求端点：'),
                h('span', { className: 'ptName' }, h('code', null, group.origin)),
                h('span', { className: 'ptCount' }, [
                  group.sites.length + ' 处',
                  group.calls > 0 ? '调用 ' + group.calls : null,
                  group.configs > 0 ? '配置 ' + group.configs : null,
                ].filter((part) => part !== null).join(' · ')),
              ),
              h('div', { className: 'ptSubBlocks' }, group.sites.map((site) => siteLine(site, group.origin, plugin.rowId + '|' + group.origin))),
            )),
          ),
        )
      }

      /**
       * 一条入站路由。
       * @param {object} route - 路由行。
       * @returns {object} React 节点。
       */
      function routeRow(route) {
        return h(
          'li',
          { key: route.path + '|' + route.evidence, className: 'ptSurfaceRow' },
          // 路径是路由声明的结论，原始 label 才是证据本身：label 里的 token 可能是前缀，
          // 悬停保留原文，读者能自己判断这条路径是完整路由还是前缀。
          h(
            'span',
            { className: 'ptName', title: typeof route.label === 'string' ? '原始 label：' + route.label : undefined },
            h('code', null, route.path),
          ),
          evidenceTag(
            route.evidence === 'label' ? '注册标签' : '源码扫描',
            route.evidence === 'label'
              ? '运行时 effect label 里的路由声明'
              : '包源码里 fetch.register / webServer.register 的 path 字面量（作为 label 未覆盖路径的补充，不代表运行时注册状态）',
          ),
        )
      }

      /**
       * 一个插件的入站容器：默认展开，标题可跳到插件详情。
       * @param {object} group - 插件分组。
       * @param {object} vc - 视图上下文。
       * @param {Map<string, object>} entries - 行索引。
       * @returns {object} React 节点。
       */
      function routePluginNode(group, vc, entries) {
        const owned = group.rowId.length > 0
        const moduleName = owned ? moduleNameOf(entries, group.rowId) : '没有找到归属'
        return h(
          'details',
          { key: 'inbound:' + (group.rowId || 'unowned'), className: 'ptOwnerGroup ptNetworkRoute', open: true },
          h(
            'summary',
            { className: 'ptOwnerHead' },
            h('span', { className: 'ptChevron', 'aria-hidden': 'true' }, '▶'),
            owned
              ? h('button', {
                  type: 'button',
                  className: 'ptOwnerName',
                  title: moduleName + ' · 点击查看插件',
                  onClick: (event) => {
                    event.stopPropagation()
                    vc.gotoPlugin(group.rowId)
                  },
                }, group.name)
              : h('span', { className: 'ptOwnerName', title: UNOWNED_REASON }, '未归属'),
            h('span', { className: 'ptMeta ptMetaWrap' }, moduleName),
            group.console
              ? kindTag('本控制台', '本控制台自己注册的路由')
              : group.builtin
                ? kindTag('DSH 内置', '来自 @deepseek-ai 包，非第三方插件')
                : null,
            h('span', { className: 'ptCount' }, group.routes.length + ' 条'),
          ),
          h(
            'div',
            { className: 'ptOwnerBody' },
            h('ul', { className: 'ptList' }, group.routes.map((route) => routeRow(route))),
          ),
        )
      }

      /**
       * 一键展开/收起某个区块里的插件容器；缺 DOM 或 setter 时静默。
       * @param {string} selector - 只选这个区块的插件容器。
       * @param {boolean} open - 展开还是收起。
       */
      function foldPluginGroups(selector, open) {
        if (typeof setDetailsOpen !== 'function' || typeof foldNodes !== 'function') return
        setDetailsOpen(foldNodes(selector), open)
      }

      /**
       * 一组不可用原因。
       * @param {string} reason - 原因。
       * @returns {object} React 节点。
       */
      function unavailable(reason) {
        return h('p', { className: 'ptHint', style: { color: 'var(--pt-warn)' } }, reason)
      }

      /**
       * 网络段正文。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderNetworkSegment(vc) {
        const surface = vc.surface
        const state = surface.network ?? { status: 'idle' }
        if (state.status === 'loading') return h('div', { className: 'ptEmpty' }, '读取网络能力…')
        if (state.status === 'error') {
          return h(
            'div',
            { className: 'ptEmpty' },
            state.error ?? '读取失败',
            h('div', { style: { marginTop: '10px' } }, textButton('重试', () => void surface.loadNetwork(), { title: '重新读取网络事实' })),
          )
        }
        const data = state.data
        if (data === null || data === undefined) return h('div', { className: 'ptEmpty' }, '读取网络能力与连接。')

        const entries = entryNameMap(vc)
        // 插件筛选只收窄视图，不重读路由；选中的行没出现在结果里就是空区段。
        const selected = typeof surface.networkPlugin === 'string' && surface.networkPlugin.length > 0
          ? surface.networkPlugin
          : null
        const matchesOwner = (row) => selected === null
          || (Array.isArray(row.owners) && row.owners.includes(selected))
        const llmProviders = (data.llm?.providers ?? []).filter(matchesOwner)
        const searchProviders = (data.web?.search?.providers ?? []).filter(matchesOwner)
        const fetchProviders = (data.web?.fetch?.providers ?? []).filter(matchesOwner)
        const servers = (data.mcp?.servers ?? []).filter(matchesOwner)
        const routes = (data.inbound?.routes ?? []).filter(matchesOwner)
        const sourceSites = (data.source?.sites ?? []).filter(matchesOwner)
        const providerRows = [
          ...llmProviders.map((row) => ({ row, type: '模型' })),
          ...searchProviders.map((row) => ({ row, type: '搜索' })),
          ...fetchProviders.map((row) => ({ row, type: '抓取' })),
        ]
        const managed = managedOwnerSet(entries, providerRows.map((item) => item.row), servers)
        const sourcePlugins = groupSourcePlugins(sourceSites, entries, managed)
        const routeGroups = groupRoutes(routes, entries)
        const sourceTruncated = data.source?.truncated === true
        const providerIssues = [...new Set([
          data.llm?.available === false ? data.llm.reason ?? '模型 provider 不可用' : undefined,
          data.web?.search?.available === false ? data.web.search.reason ?? data.web?.reason ?? '搜索 provider 不可用' : undefined,
          data.web?.fetch?.available === false ? data.web.fetch.reason ?? data.web?.reason ?? '抓取 provider 不可用' : undefined,
        ].filter((line) => typeof line === 'string' && line.length > 0))]

        return h(
          React.Fragment,
          null,
          selected !== null
            ? h(
                'p',
                { className: 'ptHint' },
                `只看插件「${displayName(entries, selected)}」 `,
                textButton('查看全部', () => surface.setNetworkPlugin?.(null), { title: '清除插件筛选' }),
              )
            : null,
          (data.warnings ?? []).map((line) => h('p', { key: line, className: 'ptHint', style: { color: 'var(--pt-warn)' } }, line)),

          h(
            'details',
            { key: 'controlled-out', className: 'ptSectionFold', open: true },
            h(
              'summary',
              { className: 'ptSectionHead' },
              h('span', { className: 'ptChevron', 'aria-hidden': 'true' }, '▶'),
              h('span', { className: 'ptSectionTitle', title: '经 Cordis 内核注册或配置的受控通道' }, '受控出口'),
              h('span', { className: 'ptCount' }, `${providerRows.length} provider · ${servers.length} MCP`),
            ),
            h(
              'div',
              { className: 'ptSectionBody' },
              h('p', { className: 'ptSubTitle' }, `Provider（${providerRows.length}）`),
              providerIssues.map((line, index) => h('div', { key: 'provider-issue:' + index }, unavailable(line))),
              providerRows.length === 0 && providerIssues.length === 0
                ? h('p', { className: 'ptHint' }, selected === null ? '没有注册 provider。' : '这个插件没有注册 provider。')
                : providerRows.length > 0
                  ? h('ul', { className: 'ptList' }, providerRows.map((item) => providerRow(item.row, vc, entries, item.type)))
                  : null,
              h('p', { className: 'ptSubTitle', style: { marginTop: '10px' } }, `MCP server（${servers.length}）`),
              data.mcp?.available === false ? unavailable(data.mcp.reason) : servers.length === 0
                ? h('p', { className: 'ptHint' }, selected === null ? '没有发现符合条件的 MCP server' : '这个插件没有 MCP server')
                : h('ul', { className: 'ptList' }, servers.map((row) => mcpRow(row, vc, entries))),
            ),
          ),

          h(
            'details',
            { key: 'direct-out', className: 'ptSectionFold', open: true },
            h(
              'summary',
              { className: 'ptSectionHead' },
              h('span', { className: 'ptChevron', 'aria-hidden': 'true' }, '▶'),
              h('span', { className: 'ptSectionTitle', title: '源码里直接构建的调用点，可能绕过 DSH 受控出口，通过静态扫描发现（不记录行为是否发生），相对路径与运行时变量不计入扫描结果' }, '直连出口'),
              h('span', { className: 'ptCount' }, `${sourcePlugins.length} 个来源 · ${sourceSites.length}${sourceTruncated ? '+' : ''} 处`),
              h(
                'span',
                { className: 'ptActions', onClick: (event) => event.stopPropagation() },
                textButton('折叠全部', () => foldPluginGroups('.ptBody details.ptNetworkDirect', false), { title: '收起「直连出口」里的所有插件分组' }),
                textButton('展开全部', () => foldPluginGroups('.ptBody details.ptNetworkDirect', true), { title: '展开「直连出口」里的所有插件分组' }),
              ),
            ),
            h(
              'div',
              { className: 'ptSectionBody' },
              sourceSites.length === 0
                ? h('p', { className: 'ptHint', style: { margin: 0 } }, selected === null ? '没有在源码里识别到网络调用点。' : '这个插件在源码里没有网络调用点。')
                : h(
                    React.Fragment,
                    null,
                    sourcePlugins.map((plugin) => sourcePluginNode(plugin, vc, entries)),
                    sourceTruncated
                      ? h('p', { className: 'ptHint', style: { color: 'var(--pt-warn)' } }, '源码调用点总数超过 150 条，已截断。')
                      : null,
                    data.source?.partial === true
                      ? h('p', { className: 'ptHint', style: { color: 'var(--pt-warn)' } }, '部分包的单包调用点上限（60 条）已截断。')
                      : null,
                  ),
            ),
          ),

          h(
            'details',
            { key: 'inbound', className: 'ptSectionFold', open: true },
            h(
              'summary',
              { className: 'ptSectionHead' },
              h('span', { className: 'ptChevron', 'aria-hidden': 'true' }, '▶'),
              h('span', { className: 'ptSectionTitle', title: '本机对外开放的路由' }, '入站入口'),
              h('span', { className: 'ptCount' }, `${routes.length} 条 · ${routeGroups.length} 个来源`),
              h(
                'span',
                { className: 'ptActions', onClick: (event) => event.stopPropagation() },
                textButton('折叠全部', () => foldPluginGroups('.ptBody details.ptNetworkRoute', false), { title: '收起「入站入口」里的所有插件分组' }),
                textButton('展开全部', () => foldPluginGroups('.ptBody details.ptNetworkRoute', true), { title: '展开「入站入口」里的所有插件分组' }),
              ),
            ),
            h(
              'div',
              { className: 'ptSectionBody' },
              routes.length === 0
                ? h('p', { className: 'ptHint', style: { margin: 0 } }, selected === null ? '没有识别到入站路由声明。' : '这个插件没有入站路由。')
                : routeGroups.map((group) => routePluginNode(group, vc, entries)),
            ),
          ),
        )
      }

      return { renderNetworkSegment }
    }
  },
})
