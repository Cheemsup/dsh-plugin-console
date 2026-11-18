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

    /**
     * 侧边栏图标：`icon.svg` 的等比例单色版。
     *
     * 完整路径原样保留，`currentColor` 与右侧插件名同色；16–18px 下细连接臂
     * 会自然变淡，但螺母、卡扣、机械臂与插头仍能读出来。
     *
     * client 半没有打包器，不能运行时读包内 SVG；改 `icon.svg` 后要同步这里的
     * 路径数据（缩放系数也在最后一条 path 的 transform 里）。
     */
    const ICON_PATHS = [
      { d: 'M 971 967 Q 969 970 969 987 Q 969 1004 971 1007 Q 973 1012 978 1012 L 1058 1012 Q 1075 1012 1075 986 Q 1075 976 1073 973 Q 1070 962 1021 962 L 978 962 Q 973 964 971 967 Z' },
      { d: 'M 972 866 Q 969 870 969 888 Q 969 906 970 908 Q 971 913 1018 913 L 1061 913 Q 1075 913 1075 888 Q 1075 876 1073 873 Q 1070 863 1019 863 L 976 863 Z' },
      { d: 'M 285 812 Q 283 815 283 829 Q 283 843 285 847 L 468 1027 Q 473 1030 483 1033 L 785 1033 Q 786 1046 788 1051 Q 794 1067 868 1067 Q 928 1067 934 1065 Q 950 1060 951 944 L 951 841 Q 950 826 944 823 Q 936 812 865 812 Q 809 813 803 816 Q 790 823 788 834 Q 784 863 695 863 L 602 863 L 501 763 Q 497 760 480 772 L 462 782 Q 456 787 461 793 L 584 913 Q 590 915 664 915 L 738 915 Q 740 919 740 939 L 740 959 Q 736 963 654 963 L 570 963 Q 568 962 558 952 L 415 811 Q 411 810 394 820 Q 377 829 369 832 Q 361 834 354 834 Q 346 834 339 832 Q 331 830 313 820 L 291 810 Q 287 810 285 812 Z' },
      { d: 'M 355 447 Q 349 447 343 450 L 202 529 Q 195 535 193 540 Q 191 544 191 625 Q 191 705 193 710 Q 195 714 199 718 L 340 799 Q 352 803 355 803 Q 357 803 363 802 L 510 717 Q 517 713 519 709 Q 521 704 521 625 Q 521 545 518 539 Q 515 533 510 529 L 367 450 Q 361 447 355 447 Z M 355 545 A 79.5 79.5 0 1 0 355 704 A 79.5 79.5 0 1 0 355 545 Z', fillRule: 'evenodd' },
      { d: 'M 450 457 Q 449 460 451 462 L 484 481 Q 488 483 492 480 L 544 432 L 590 382 Q 596 381 696 381 L 796 381 Q 804 378 805 374 Q 805 371 798 359 L 788 340 Q 785 333 781 330 Q 777 328 678 328 L 579 328 Q 574 329 512 393 L 450 454 Q 449 455 450 457 Z' },
      { d: 'M 302 419 Q 302 434 303 435 Q 307 438 325 429 Q 339 421 349 420 Q 358 418 367 420 Q 375 422 387 429 Q 399 435 403 435 Q 407 435 481 362 L 558 287 Q 562 285 670 285 L 782 285 Q 786 282 788 270 Q 790 261 798 246 Q 805 231 805 228 Q 805 225 803 223 Q 801 220 799 219 L 646 219 L 494 219 Q 488 221 483 224 L 392 312 L 304 400 Q 302 404 302 419 Z' },
      { d: 'M 892 180 Q 888 181 882 185 Q 875 188 855 208 Q 835 227 827 240 Q 819 253 816 261 Q 809 280 809 300 Q 809 310 812 322 Q 814 334 819 344 Q 823 354 829 363 Q 835 372 854 390 L 876 411 Q 879 413 886 416 Q 892 418 928 418 L 963 418 Q 971 416 977 413 Q 983 409 1008 385 Q 1033 360 1036 355 Q 1038 349 1038 347 Q 1038 344 1037 342 Q 1036 340 1033 339 Q 1029 337 1005 334 Q 980 330 978 331 Q 975 332 968 338 Q 954 350 944 350 Q 922 352 917 350 Q 896 344 889 331 Q 877 316 877 301 Q 877 285 882 279 Q 890 261 903 257 Q 916 249 932 249 Q 947 249 959 256 Q 969 262 979 269 Q 984 270 1009 266 Q 1033 262 1035 261 Q 1038 258 1038 256 Q 1038 247 1033 241 Q 1029 234 1008 213 L 981 188 Q 976 184 969 182 Q 962 179 929 179 Q 895 179 892 180 Z', transform: 'translate(923.5 298.5) scale(1.15) translate(-923.5 -298.5)' },
    ]

    function PluginConsoleIcon({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 1254 1254',
          fill: 'currentColor',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        ICON_PATHS.map((path, index) =>
          h('path', {
            key: index,
            d: path.d,
            fillRule: path.fillRule,
            transform: path.transform,
          }),
        ),
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
      const [styles, shared, workspacePickerChunk, searchChunk, previewRawChunk, plugins, pluginFiltersChunk, sessions, tools, preview, previewStoreChunk, previewMessagesChunk, previewToolsChunk, editorChunk, applyChain, store, draftChunk, dialogChunk, templateCardChunk, cleanupChunk, influenceChunk, activityChunk, changesChunk, controlChunk, effectsChunk, sessionDetailChunk, editorStoreChunk, editorMessagesChunk, schemaChunk, impactTreeChunk, relationGraphChunk, disablePreviewChunk] = await Promise.all([
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
        require.async('./client.impact-tree.js'),
        require.async('./client.relation-graph.js'),
        require.async('./client.disable-preview.js'),
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
      // 关系树是纯模型；关系图画布负责视口与缩放，禁用预演视图再组装两者。
      const impactTree = impactTreeChunk
      const relationGraph = relationGraphChunk({ ...helpers, impactTree })
      const disablePreview = disablePreviewChunk({ ...helpers, search, relationGraph })
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
        disablePreview,
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
