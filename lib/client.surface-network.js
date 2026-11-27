/**
 * 能力面 · 网络段：模型 / 搜索 provider、MCP 连接、入站路由声明、源码调用点。
 *
 * 前四组读运行时注册表与注册标签；最后一组是源码静态扫描，补运行时注册表
 * 看不到的直接请求。任何一组不可用都显示原因，不让其它组消失。
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
      const { rowEnd, textButton, UNOWNED_REASON } = deps

      /** 源码规则族 → 展示分组。 */
      const GROUP_LABELS = {
        http: 'HTTP',
        socket: 'Socket',
        websocket: 'WebSocket',
        browser: '浏览器',
        config: '配置',
      }

      /**
       * 归属 chip。
       * @param {object} row - 带 owners 的行。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function ownersNode(row, vc) {
        if (Array.isArray(row.owners) && row.owners.length > 0) {
          return row.owners.map((rowId) => h(
            'button',
            {
              key: rowId,
              type: 'button',
              className: 'ptTag ptLink',
              title: '来源插件',
              onClick: () => vc.gotoPlugin(rowId),
            },
            rowId,
          ))
        }
        return [h('span', { className: 'ptTag', 'data-tone': 'warn', title: row.ownerReason ?? UNOWNED_REASON }, '未归属')]
      }

      /**
       * 一个 provider。
       * @param {object} row - provider 行。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function providerRow(row, vc) {
        return h(
          'li',
          { key: row.id, className: 'ptSurfaceRow' },
          h(
            'span',
            { className: 'ptName' },
            h('code', null, row.id),
            (row.name ?? row.title) !== undefined
              ? h('span', { className: 'ptModule', style: { display: 'block' }, title: typeof (row.name ?? row.title) === 'string' ? (row.name ?? row.title) : undefined }, row.name ?? row.title)
              : null,
          ),
          row.description !== undefined
            ? h('span', { className: 'ptSub', title: typeof row.description === 'string' ? row.description : undefined }, row.description)
            : null,
          h('span', { className: 'ptTag', title: '来自运行时注册表' }, '运行时'),
          rowEnd(...ownersNode(row, vc)),
        )
      }

      /**
       * 一个 MCP server。
       * @param {object} row - server 行。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function mcpRow(row, vc) {
        const state = row.status?.state ?? 'unknown'
        const tone = state === 'failed' ? 'error' : state === 'disabled' ? undefined : 'warn'
        const detail = row.status?.lastError ?? row.status?.reason
        return h(
          'li',
          { key: row.name, className: 'ptSurfaceRow' },
          h(
            'span',
            { className: 'ptName' },
            row.name,
            detail !== undefined
              ? h('span', { className: 'ptModule', style: { display: 'block' }, title: typeof detail === 'string' ? detail : undefined }, detail)
              : null,
          ),
          h('span', { className: 'ptTag' }, row.configured ? '已配置' : '仅注册'),
          h('span', { className: 'ptTag', 'data-tone': tone, title: 'MCP 连接状态' }, state),
          rowEnd(...ownersNode(row, vc)),
        )
      }

      /**
       * 一条入站路由。
       * @param {object} row - 路由行。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function routeRow(row, vc) {
        return h(
          'li',
          { key: row.path + '|' + row.owners.join(','), className: 'ptSurfaceRow' },
          h('span', { className: 'ptName' }, h('code', null, row.path)),
          h(
            'span',
            { className: 'ptTag', title: row.evidence === 'label' ? '注册时写下的 effect label' : '源码里的字面量路径' },
            row.evidence === 'label' ? '注册标签' : '源码扫描',
          ),
          rowEnd(...ownersNode(row, vc)),
        )
      }

      /**
       * 一条源码网络调用点。
       * @param {object} row - 调用点行。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function sourceRow(row, vc) {
        return h(
          'li',
          { key: [row.file, row.line, row.label, row.kind, row.target ?? ''].join('|'), className: 'ptSurfaceRow' },
          h(
            'span',
            { className: 'ptName' },
            h('code', null, row.label),
            h('span', { className: 'ptModule', style: { display: 'block' } }, row.file + ':' + row.line),
          ),
          row.target !== undefined
            ? h('span', { className: 'ptSub', title: row.target }, row.target)
            : null,
          h('span', { className: 'ptTag', title: '调用形状来自源码匹配' }, GROUP_LABELS[row.group] ?? row.group),
          h('span', { className: 'ptTag', title: '静态扫描，不证明请求真的发生过' }, row.kind === 'config' ? '配置' : '调用'),
          rowEnd(...ownersNode(row, vc)),
        )
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

        const llmProviders = data.llm?.providers ?? []
        const searchProviders = data.web?.search?.providers ?? []
        const fetchProviders = data.web?.fetch?.providers ?? []
        const servers = data.mcp?.servers ?? []
        const routes = data.inbound?.routes ?? []
        const sourceSites = data.source?.sites ?? []

        return h(
          React.Fragment,
          null,
          (data.notes ?? []).map((line) => h('p', { key: line, className: 'ptHint' }, line)),
          (data.warnings ?? []).map((line) => h('p', { key: line, className: 'ptHint', style: { color: 'var(--pt-warn)' } }, line)),
          h('p', { className: 'ptSubTitle' }, `模型 provider（${llmProviders.length}）`),
          data.llm?.available === false ? unavailable(data.llm.reason) : llmProviders.length === 0
            ? h('p', { className: 'ptHint' }, '没有注册模型 provider。')
            : h('ul', { className: 'ptList' }, llmProviders.map((row) => providerRow(row, vc))),

          h('p', { className: 'ptSubTitle' }, `Web 搜索 provider（${searchProviders.length}）`),
          data.web?.search?.available === false ? unavailable(data.web.search.reason ?? data.web?.reason) : searchProviders.length === 0
            ? h('p', { className: 'ptHint' }, '没有注册搜索 provider。')
            : h('ul', { className: 'ptList' }, searchProviders.map((row) => providerRow(row, vc))),

          h('p', { className: 'ptSubTitle' }, `Web 抓取 provider（${fetchProviders.length}）`),
          data.web?.fetch?.available === false ? unavailable(data.web.fetch.reason ?? data.web?.reason) : fetchProviders.length === 0
            ? h('p', { className: 'ptHint' }, '没有注册抓取 provider。')
            : h('ul', { className: 'ptList' }, fetchProviders.map((row) => providerRow(row, vc))),

          h('p', { className: 'ptSubTitle' }, `MCP server（${servers.length}）`),
          data.mcp?.available === false ? unavailable(data.mcp.reason) : servers.length === 0
            ? h('p', { className: 'ptHint' }, '没有配置或注册 MCP server。')
            : h('ul', { className: 'ptList' }, servers.map((row) => mcpRow(row, vc))),

          h('p', { className: 'ptSubTitle', title: '来自注册时写入的 effect label 与源码里的 path 字面量' }, `入站路由（${routes.length}）`),
          routes.length === 0
            ? h('p', { className: 'ptHint' }, '没有识别到入站路由声明。')
            : h('ul', { className: 'ptList' }, routes.map((row) => routeRow(row, vc))),

          h('p', { className: 'ptSubTitle', title: '源码里写的 fetch / axios / node:http / WebSocket / 配置键；静态扫描，不证明请求真的发生过' }, `源码网络调用（${sourceSites.length}${data.source?.truncated === true ? '+' : ''}）`),
          sourceSites.length === 0
            ? h('p', { className: 'ptHint' }, '没有在源码里识别到网络调用点。')
            : h(
                React.Fragment,
                null,
                h('ul', { className: 'ptList' }, sourceSites.slice(0, 120).map((row) => sourceRow(row, vc))),
                sourceSites.length > 120
                  ? h('p', { className: 'ptHint' }, `只显示前 120 条，共 ${sourceSites.length} 条。`)
                  : null,
              ),
        )
      }

      return { renderNetworkSegment }
    }
  },
})
