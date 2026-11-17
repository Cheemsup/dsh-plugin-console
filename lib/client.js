/**
 * 插件控制台 client 半：侧边栏入口 + 主面板。
 *
 * 产物必须是客户端模块系统认识的 lazy-CJS 工厂：执行时只注册 id 与工厂，
 * 模块体（含样式注入）在首次 materialize 时才运行。可用基线模块见宿主种子表，
 * 这里只用到 react。
 *
 * 本文件只做五件事：注册 icon、注册入口、懒加载面板与各视图 chunk、
 * 组装它们的依赖、把面板挂到 main。面板与各视图的实现见
 * `client.page.js` / `client.*.js`，结构见 README.md 的「代码结构」。
 */
window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect, useState } = React

    /** 侧边栏入口与主面板共享的 id。 */
    const PANEL_ID = 'plugin-console'

    /**
     * 插件自己的浏览器上下文。
     *
     * apply() 拿到之后存在这里，页面组件就用它按需 `get` 宿主客户端服务——
     * 而不是把 `sessions` / `uiWorkspace` / `conversation` 写进 `inject`。
     * 写进 inject 等于声明硬依赖：任一服务缺席整块面板都不出现，而这三个
     * 只在点「应用」那一刻才真的需要。
     */
    let runtimeCtx = null

    /** 侧边栏图标：一棵两层节点的小树。 */
    function PluginConsoleIcon({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', { x: 1.25, y: 1.25, width: 4.5, height: 3.5, rx: 1, stroke: 'currentColor', strokeWidth: 1.1 }),
        h('rect', { x: 1.25, y: 10.25, width: 4.5, height: 3.5, rx: 1, stroke: 'currentColor', strokeWidth: 1.1 }),
        h('rect', { x: 10.25, y: 6.25, width: 4.5, height: 3.5, rx: 1, stroke: 'currentColor', strokeWidth: 1.1 }),
        h('path', { d: 'M5.75 3H8.5v5.5M5.75 12H8.5V8.5', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }),
      )
    }

    /**
     * 取出面板与各视图 chunk，组装成页面组件。
     *
     * 顺序要求只有一条：`client.page.js` 最后取——它的工厂需要其余 chunk
     * 已经就绪。其余几个互不依赖，一起并发取。
     * @returns {Promise<Function>} 页面组件。
     */
    async function loadPanel() {
      const [styles, shared, workspacePickerChunk, searchChunk, previewRawChunk, plugins, pluginFiltersChunk, sessions, tools, preview, previewStoreChunk, previewMessagesChunk, previewToolsChunk, editorChunk, applyChain, store, draftChunk, dialogChunk, templateCardChunk, cleanupChunk, influenceChunk, activityChunk, changesChunk, controlChunk, effectsChunk, sessionDetailChunk, editorStoreChunk, editorMessagesChunk, schemaChunk] = await Promise.all([
        require.async('./client.styles.js'),
        require.async('./client.shared.js'),
        require.async('./client.workspace-picker.js'),
        require.async('./client.search.js'),
        require.async('./client.preview-raw.js'),
        require.async('./client.plugins.js'),
        require.async('./client.plugin-filters.js'),
        require.async('./client.sessions.js'),
        require.async('./client.tools.js'),
        require.async('./client.preview.js'),
        require.async('./client.preview-store.js'),
        require.async('./client.preview-messages.js'),
        require.async('./client.preview-tools.js'),
        require.async('./client.editor.js'),
        require.async('./client.apply.js'),
        require.async('./client.store.js'),
        require.async('./client.draft.js'),
        require.async('./client.dialog.js'),
        require.async('./client.template-card.js'),
        require.async('./client.cleanup.js'),
        require.async('./client.influence.js'),
        require.async('./client.activity.js'),
        require.async('./client.changes.js'),
        require.async('./client.control.js'),
        require.async('./client.effects.js'),
        require.async('./client.session-detail.js'),
        require.async('./client.editor-store.js'),
        require.async('./client.editor-messages.js'),
        require.async('./client.schema.js'),
      ])

      // 样式先注入，再挂面板：骨架屏也依赖这些类名。
      styles.ensureStyles()

      const baseHelpers = shared()
      // 工作区选择控件单独一个 chunk：它要拿 shared 的样式类与控制、再合并给所有视图。
      const helpers = { ...baseHelpers, ...workspacePickerChunk() }
      // 草稿的纯函数先组装好，编辑器和 store 共用同一份实例。
      const draft = draftChunk
      // 清理 chunk 同时提供 store 与定制页卡片，二者必须是同一份实例。
      const cleanup = cleanupChunk({ shared: helpers })
      const templateCard = templateCardChunk({ ...helpers, dialog: dialogChunk.renderDialog })
      // 三处 schema 视图共用同一份解析与版式；实例只造一次。
      const schema = schemaChunk({ ...helpers })
      // 页内多词搜索：状态 hook 给页面，渲染与匹配给两个长文本视图。
      const search = searchChunk()
      const previewRaw = previewRawChunk({ ...helpers, search })
      // 预演视图先造好：定制页的「预览定制结果」复用同一套四个标签。
      const previewView = preview({ ...helpers, previewTools: previewToolsChunk({ ...helpers, schema }), previewMessages: previewMessagesChunk({ ...helpers, search }), previewRaw, search })
      const editorMessages = editorMessagesChunk({ ...helpers, search })
      const editor = editorChunk({ ...helpers, draft, cleanupUi: cleanup, templateCard, messageEditors: editorMessages, previewView, search })
      const editorStore = editorStoreChunk({ draft, browserTimeZone: helpers.browserTimeZone })
      const influence = influenceChunk({ ...helpers, schema, search })
      const activity = activityChunk(helpers)
      const changes = changesChunk(helpers)
      const control = controlChunk(helpers)
      const effects = effectsChunk()
      const sessionDetail = sessionDetailChunk({ ...helpers, influence })
      const createPage = await require.async('./client.page.js')
      return createPage({
        runtimeCtx,
        styles,
        shared: helpers,
        influence,
        activity,
        changes,
        control,
        store: store({
          shared: helpers,
          applyChain: applyChain(helpers),
          cleanup,
        }),
        plugins: plugins({ ...helpers, activity, changes, control, effects, search }),
        pluginFilters: pluginFiltersChunk({ ...helpers }),
        sessions: sessions({ ...helpers, sessionDetail, search }),
        tools: tools({ ...helpers, activity, schema, search }),
        preview: previewView,
        previewStore: previewStoreChunk({ shared: helpers }),
        editor,
        editorStore,
        search,
      })
    }

    /**
     * 面板外壳：在页面 chunk 到位之前渲染骨架。
     *
     * 不用 `React.lazy`：少一层 Suspense 依赖，也让加载失败能降级成一行提示，
     * 而不是让整个 slot 条目崩掉。
     */
    function PanelHost() {
      const [Page, setPage] = useState(null)
      const [failure, setFailure] = useState(null)

      useEffect(() => {
        let live = true
        loadPanel()
          .then((component) => {
            if (live) setPage(() => component)
          })
          .catch((error) => {
            if (live) setFailure(error instanceof Error ? error.message : String(error))
          })
        return () => { live = false }
      }, [])

      if (failure !== null) {
        return h('p', { className: 'ptNotice ptError', style: { margin: '24px 32px' } }, '插件控制台面板加载失败：' + failure)
      }
      if (Page === null) {
        return h(
          'div',
          { 'aria-busy': 'true', style: { padding: '24px 32px' } },
          Array.from({ length: 10 }, (_v, index) => h('div', { key: index, className: 'ptSkeleton' })),
        )
      }
      return h(Page, {})
    }

    /**
     * 注册侧边栏入口与主面板。
     * @param {object} ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      // 页面组件要用宿主客户端服务（sessions / uiWorkspace / conversation），
      // 但那些只在点「应用」时才真的需要，不该进 inject 变成硬依赖。
      // 存在这里，组件按需 get；缺席就自己报错，面板照常显示。
      runtimeCtx = ctx

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 30,
            label: '插件控制台',
          },
          PluginConsoleIcon,
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
          },
          PanelHost,
        ),
      )
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = ['slots']
    return module.exports
  },
})
