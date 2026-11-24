/**
 * 「插件禁用预演」里的关系图画布：固定视口 + 缩放/拖拽。
 *
 * 单独成一个 chunk：图不是 React 状态驱动的——拖拽与滚轮每秒几十次，直接改
 * 画布的 transform 才不会把整页重渲染；固定视口让图像地图一样在内部任意移动。
 * 数据与几何仍由 `client.impact-tree.js` 纯计算，这里只负责挂上去。
 * @module dsh-plugin-console/client-relation-graph
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.relation-graph.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { activateOnKey, impactTree, textButton } = deps

      /** 关系图缩放：按钮与滚轮共用同一组边界与步长；100% 表示整图适配视口。 */
      const GRAPH_ZOOM_MIN = 0.4
      const GRAPH_ZOOM_MAX = 4
      const GRAPH_ZOOM_STEP = 0.2

      /** 视口高度：clamp(最小, 视口占比, 最大)；CSS 里同步了一份。 */
      const GRAPH_VIEWPORT_HEIGHT = 'clamp(360px,65vh,640px)'
      const GRAPH_VIEWPORT_MIN_HEIGHT = '360px'

      /** 右键菜单的兜底尺寸：只在 ref 还量不到真实尺寸时用。 */
      const GRAPH_MENU_WIDTH = 168
      const GRAPH_MENU_HEIGHT = 96
      /** 菜单锚点：被右键节点在视口里的盒子，菜单挂载后据此落位。 */
      const graphMenuAnchor = { left: 0, top: 0, right: 0, bottom: 0 }
      /** 菜单是否开着；滚轮监听是原生闭包，读这里才知道该不该缩放。 */
      let graphMenuOpen = false

      /**
       * 线型图例：线型 → 含义，顺序就是从左到右的顺序。
       *
       * 图例只列**当前画出来的**线型：没画的线型写在画面上，只会让人对着图找不到对应
       * 的线；隐藏非树边后长虚线也该一起退场。少于两种线型时不显示图例——只有实线的
       * 图不需要解释线型。
       */
      const GRAPH_LEGEND = [
        { kind: 'service', label: '服务依赖' },
        { kind: 'group-child', label: '子行' },
        { kind: 'config-reference', label: 'config 引用（推断）' },
        { kind: 'cross', label: '同一批声明里的另一条路径' },
      ]

      /** 把任意输入夹到缩放范围内；非数字回到 100%。 */
      function clampZoom(value) {
        const number = Number(value)
        if (!Number.isFinite(number)) return 1
        return Number(Math.min(GRAPH_ZOOM_MAX, Math.max(GRAPH_ZOOM_MIN, number)).toFixed(2))
      }

      /** 图表/节点里的定长截断；不改变数据，只影响文本节点。 */
      function clip(text, limit) {
        const value = typeof text === 'string' ? text : String(text ?? '')
        return value.length > limit ? value.slice(0, limit - 1) + '…' : value
      }

      /**
       * 节点的一句话说明，只出现在悬浮提示与读屏标签里。
       *
       * 方块本身只放插件名：状态、层级与服务边都收进这里，避免挤掉名称。
       * 下游页面另有「受影响的下游插件」逐行给出同样的因果路径。
       */
      function nodeTooltip(node, data) {
        if (node.side === 'root') {
          return `目标插件 · 工具 ${data.tools.owned.length} · 段 ${data.prompt.sections.owned.length} · 服务 ${data.target.provides.length}`
        }
        if (node.blocked === true) {
          const missing = (node.missingServices ?? []).join('、')
          return `失去 ${missing || node.edgeLabel || '必需服务'}${node.distance ? ` · 第 ${node.distance} 层` : ''}`
        }
        if (node.causedByParent === true) {
          return `随父行不可用${node.distance ? ` · 第 ${node.distance} 层` : ''}`
        }
        if (node.edgeKind === 'config-reference') return `config.${node.edgeLabel} 引用了它（推断，不构成依赖）`
        if (node.edgeKind === 'group-child') return '子行（随父行）'
        const relation = node.side === 'upstream' ? `上游：提供 ${node.edgeLabel}` : `下游：需要 ${node.edgeLabel}`
        return node.again === true ? `已在上方 · ${relation}` : relation
      }

      /**
       * 视口的缩放/平移状态。
       *
       * 直接改画布的 transform，不重渲染：拖拽和滚轮每秒会触发很多次，用 React
       * state 会卡；画布固定在视口内，超出部分裁掉，像地图一样任意移动。
       */
      const graphView = { x: 0, y: 0, scale: 1, key: null }
      const graphZoomControl = { zoom: 1, set: undefined }
      const graphPan = { active: false, moved: false, x: 0, y: 0 }
      /** 适配比例与画布/视口尺寸；100% 表示整张图刚好放进视口。 */
      const graphFit = { scale: 1, width: 0, height: 0, boxWidth: 0, boxHeight: 0 }
      let graphViewportElement = null
      let graphStageElement = null
      let graphWheelListener = null

      /**
       * 布局缓存：最后一次的键与结果。
       *
       * 网状布局在 90 节点上要 ~100ms（应力优化是 O(n²)·64 轮），而 `renderRelations`
       * 每渲染一次就重跑整条管线——页内搜索每敲一个字都会触发。所以按「快照对象身份
       * + 数据口径 + 几何」缓存最后一次结果。键用 `data`（store state，跨渲染稳定）而
       * 不是 `tree`：两棵树在每次渲染时都是新建对象，用它们做键永远不命中。
       */
      const layoutCache = { key: null, source: null, layout: null }

      /** 取（或重算）布局；键不变时直接复用上一次的结果。 */
      function layoutOf(tree, data, graphMode, mode) {
        const key = `${graphMode}|${mode}|${data?.target?.rowId ?? ''}`
        if (layoutCache.key === key && layoutCache.source === data) return layoutCache.layout
        const layout = impactTree.layoutRelationTree(tree, { layout: mode })
        layoutCache.key = key
        layoutCache.source = data
        layoutCache.layout = layout
        return layout
      }

      /** 量视口与画布尺寸并重算适配比例；返回视口尺寸是否变了。 */
      function measureGraph() {
        const viewport = graphViewportElement
        if (viewport === null) return false
        const boxWidth = viewport.clientWidth
        const boxHeight = viewport.clientHeight
        if (!(boxWidth > 0) || !(boxHeight > 0)) return false
        const resized = graphFit.boxWidth !== boxWidth || graphFit.boxHeight !== boxHeight
        graphFit.boxWidth = boxWidth
        graphFit.boxHeight = boxHeight
        if (graphFit.width > 0 && graphFit.height > 0) {
          graphFit.scale = Math.min(1, (boxWidth - 32) / graphFit.width, (boxHeight - 32) / graphFit.height)
        }
        return resized
      }

      /** 把整张图放到视口中央；画布左上角为原点。 */
      function centerGraph() {
        if (!(graphFit.boxWidth > 0) || !(graphFit.boxHeight > 0)) return
        graphView.x = (graphFit.boxWidth - graphFit.width * graphView.scale) / 2
        graphView.y = (graphFit.boxHeight - graphFit.height * graphView.scale) / 2
      }

      /** 画布变换：左上角原点 + 平移/缩放；视口负责裁切。 */
      function graphTransform(view, scale) {
        // 两位小数足够，避免浮点尾数把 style 字符串写得又长又难比对。
        const x = Math.round(view.x * 100) / 100
        const y = Math.round(view.y * 100) / 100
        return `translate(${x}px,${y}px) scale(${scale})`
      }

      /** 只改画布 transform，供拖拽/滚轮这类高频操作直接调用。 */
      function applyGraphView() {
        if (graphStageElement !== null) graphStageElement.style.transform = graphTransform(graphView, graphView.scale)
      }

      function setGraphStage(element) {
        graphStageElement = element
      }

      /**
       * 视口 ref。
       *
       * 滚轮必须用原生监听并 `passive:false`：React 的 onWheel 是 passive 的，
       * preventDefault 拦不住浏览器把整页滚走。普通滚轮仍归页面，Ctrl + 滚轮
       * 才缩放——与常见制图软件一致。
       */
      function setGraphViewport(element) {
        if (graphWheelListener !== null) graphViewportElement?.removeEventListener('wheel', graphWheelListener)
        graphViewportElement = element
        graphWheelListener = element === null
          ? null
          : (event) => {
              if (event.ctrlKey !== true) return
              if (typeof graphZoomControl.set !== 'function') return
              event.preventDefault()
              // 菜单开着时画布被 scrim 盖住：这时缩放只会让菜单和它贴着的节点错位。
              if (graphMenuOpen) return
              zoomGraph(element, event.clientX, event.clientY, event.deltaY < 0 ? 1 : -1)
            }
        if (graphWheelListener !== null) element.addEventListener('wheel', graphWheelListener, { passive: false })
        // 视口尺寸只有挂载后才知道：第一次拿到就按「整张图放进视口」定初始比例。
        measureGraph()
        graphView.scale = graphFit.scale * graphZoomControl.zoom
        centerGraph()
        applyGraphView()
      }

      /** 以视口内某点为锚缩放；按钮不传坐标时绕视口中心。 */
      function zoomGraph(viewport, clientX, clientY, direction) {
        const current = graphZoomControl.zoom
        if (typeof graphZoomControl.set !== 'function') return
        const next = clampZoom(current + direction * GRAPH_ZOOM_STEP)
        if (next === current) return
        const rect = viewport?.getBoundingClientRect?.()
        const previous = graphFit.scale * current
        const scale = graphFit.scale * next
        if (rect !== undefined && previous > 0) {
          // 缩放前后保持光标下的那一点不动：先把屏幕点换算成画布坐标再回推。
          const px = Number.isFinite(clientX) ? clientX - rect.left : rect.width / 2
          const py = Number.isFinite(clientY) ? clientY - rect.top : rect.height / 2
          graphView.x = px - ((px - graphView.x) / previous) * scale
          graphView.y = py - ((py - graphView.y) / previous) * scale
        }
        graphView.scale = scale
        applyGraphView()
        graphZoomControl.set(next)
      }

      /** 任意位置按下都先记起点，但只有移动超过阈值才算拖拽，点击节点仍然可用。 */
      function startGraphPan(event) {
        if (event.button !== 0) return
        graphPan.active = true
        graphPan.moved = false
        graphPan.x = event.clientX
        graphPan.y = event.clientY
      }

      /** 拖拽时增量平移画布；超过阈值才捕获指针。 */
      function moveGraphPan(event) {
        if (!graphPan.active) return
        const dx = event.clientX - graphPan.x
        const dy = event.clientY - graphPan.y
        if (!graphPan.moved) {
          if (Math.abs(dx) + Math.abs(dy) <= 4) return
          graphPan.moved = true
          event.currentTarget.setPointerCapture?.(event.pointerId)
          event.currentTarget.dataset.panning = 'true'
        }
        graphPan.x = event.clientX
        graphPan.y = event.clientY
        graphView.x += dx
        graphView.y += dy
        applyGraphView()
      }

      /** 结束平移；指针抬起或取消都要收尾，避免下次渲染还停在拖拽态。 */
      function endGraphPan(event) {
        if (!graphPan.active) return
        graphPan.active = false
        const viewport = event.currentTarget
        delete viewport.dataset.panning
        if (viewport.hasPointerCapture?.(event.pointerId) === true) viewport.releasePointerCapture(event.pointerId)
        // click 在 pointerup 之后才派发；等它过去再清掉「刚拖过」，避免误开插件。
        if (graphPan.moved) globalThis.setTimeout?.(() => { graphPan.moved = false }, 0)
      }

      /** 上下游树状图；右上角缩放，并可切换「影响图 / 完整链路」。 */
      function renderRelations(vc, data) {
        const graphMode = vc.disablePreview?.graphMode === 'full' ? 'full' : 'impact'
        const setGraphMode = typeof vc.disablePreview?.setGraphMode === 'function' ? vc.disablePreview.setGraphMode : undefined
        // 未知值一律归为分层，与 graphMode 的兜底方式一致。
        const layoutMode = vc.disablePreview?.graphLayout === 'net' ? 'net' : 'layered'
        const setGraphLayout = typeof vc.disablePreview?.setGraphLayout === 'function' ? vc.disablePreview.setGraphLayout : undefined
        const graphZoom = clampZoom(vc.disablePreview?.graphZoom ?? 1)
        const setGraphZoom = typeof vc.disablePreview?.setGraphZoom === 'function' ? vc.disablePreview.setGraphZoom : undefined
        // 非树边默认显示；线太密时可以只留生成树。
        const showCross = vc.disablePreview?.graphCross !== false
        const setGraphCross = typeof vc.disablePreview?.setGraphCross === 'function' ? vc.disablePreview.setGraphCross : undefined
        // 两张图必须共用本次预演的快照；页面级快照可能早于或晚于这次采集。
        const graphSnapshot = data.graph ?? vc.snapshot
        // 影响图只读 host 闭包；完整图走声明骨架并补 cross edge / 子行 / config 引用。
        const impactGraph = impactTree.buildImpactGraph(graphSnapshot, data)
        const fullGraph = impactTree.buildFullRelationGraph(graphSnapshot, data.target)
        const tree = graphMode === 'full' ? fullGraph : impactGraph
        const layout = layoutOf(tree, data, graphMode, layoutMode)
        const rows = impactTree.flattenRelationTree(tree)
        const pending = new Set((data.services?.pending ?? []).map((row) => row.rowId))
        const blockedCount = rows.filter((row) => row.blocked === true).length
        const cascadeCount = rows.filter((row) => row.causedByParent === true).length
        const upstreamCount = rows.filter((row) => row.side === 'upstream').length
        const downstreamCount = rows.filter((row) => row.side === 'downstream').length
        const crossCount = layout.crossEdges.length
        const hasGraph = tree.root !== null && layout.nodes.length > 1
        // 图例只解释画面上真的有的线型：隐藏非树边时，长虚线那一项一起退场。
        const drawnKinds = new Set(layout.edges.map((edge) => edge.kind))
        if (showCross) for (const edge of layout.crossEdges) drawnKinds.add(edge.kind)
        const legendEntries = GRAPH_LEGEND.filter((entry) => drawnKinds.has(entry.kind))
        const openPlugin = typeof vc.gotoPlugin === 'function' ? vc.gotoPlugin : () => {}
        // 路径聚焦：点击节点或边高亮经过它的整条依赖路径；左键不再跳转插件页。
        const focus = vc.disablePreview?.graphFocus ?? null
        const setFocus = typeof vc.disablePreview?.setGraphFocus === 'function' ? vc.disablePreview.setGraphFocus : undefined
        // 节点右键菜单：左键已用于聚焦，跳转插件页收进菜单。
        const menu = vc.disablePreview?.graphMenu ?? null
        const setMenu = typeof vc.disablePreview?.setGraphMenu === 'function' ? vc.disablePreview.setGraphMenu : undefined
        graphMenuOpen = hasGraph && menu !== null && setMenu !== undefined
        const titleByKey = new Map(layout.nodes.map((node) => [node.key, node.title]))
        const allEdges = [...layout.edges, ...layout.crossEdges]
        // 焦点只在当前画出来的边上找：非树边被隐藏时，不能靠看不见的边把高亮运过去。
        const focusInfo = impactTree.focusPathOf(layout, focus, { includeCross: showCross })
        const focusNodes = new Set(focusInfo === null ? [] : focusInfo.nodes)
        const focusEdges = new Set(focusInfo === null ? [] : focusInfo.edges)
        const focusEdge = focusInfo === null || focus?.kind !== 'edge'
          ? null
          : allEdges.find((edge) => edge.key === focus.key)
        const focusName = focusInfo === null
          ? ''
          : focusEdge === null
            ? (titleByKey.get(focus.key) ?? focus.key)
            : `${titleByKey.get(focusEdge.fromKey) ?? focusEdge.fromKey} → ${titleByKey.get(focusEdge.toKey) ?? focusEdge.toKey}`
        /** 点同一个元素是取消，点别的元素是换一条路径。 */
        const toggleFocus = (kind, key) => {
          if (setFocus === undefined) return
          setFocus(focus?.kind === kind && focus?.key === key ? null : { kind, key })
        }
        /** 节点在视口里的像素盒子：与 stage 的 `translate + scale` 用同一组数字。 */
        const anchorAt = (node) => {
          const scale = graphView.scale
          graphMenuAnchor.left = graphView.x + node.x * scale
          graphMenuAnchor.top = graphView.y + node.y * scale
          graphMenuAnchor.right = graphMenuAnchor.left + node.width * scale
          graphMenuAnchor.bottom = graphMenuAnchor.top + node.height * scale
        }
        /**
         * 打开节点的右键菜单。
         *
         * 菜单贴着**被点的方块**放，而不是跟着指针：方块才是被操作的对象，落在指针
         * 位置上会盖住刚点的那个节点。坐标取画布变换后的**视口像素**（stage 的
         * `translate + scale` 正向算一遍），所以缩放、平移过也仍然贴着方块；键盘
         * （Shift+F10 / ContextMenu）打开时没有指针，正好共用这一条路径。
         */
        const openMenu = (node) => {
          if (setMenu === undefined) return
          anchorAt(node)
          // 状态里的坐标只是首帧兜底；真实位置由 `positionMenu` 量到尺寸后再定。
          setMenu({
            key: node.key,
            rowId: node.rowId,
            title: node.title,
            x: Math.round(graphMenuAnchor.right + 8),
            y: Math.round(graphMenuAnchor.top),
          })
        }
        /**
         * 菜单挂载后按真实尺寸落位：右侧优先、左侧兜底，纵向对准方块中心，
         * 最后整体夹进视口。放在 ref 里算是因为菜单宽度随标题长短变化，
         * 打开时猜的尺寸一定会偏。
         *
         * 每次挂载都按**当前**布局重取一次锚点：菜单开着时若重渲染（窗口尺寸变了
         * 导致重新适配、数据刷新），旧锚点会把菜单留在原地，和节点错开。
         *
         * 量出来的 `offsetWidth/Height` 与 `graphFit.boxWidth/Height` 都是视口
         * 内边距盒的 CSS 像素，和菜单的 `left/top` 同一套坐标；不要换成
         * `getBoundingClientRect()` 相减——宿主若有祖先缩放，两边会差一个比例。
         */
        const positionMenu = (element) => {
          if (element === null || element === undefined) return
          const anchorNode = menu === null ? undefined : layout.nodes.find((node) => node.key === menu.key)
          if (anchorNode !== undefined) anchorAt(anchorNode)
          const width = element.offsetWidth > 0 ? element.offsetWidth : GRAPH_MENU_WIDTH
          const height = element.offsetHeight > 0 ? element.offsetHeight : GRAPH_MENU_HEIGHT
          // 视口尺寸优先用实测值；量不到时按锚点往右下多留一圈，仍然夹得回来。
          const boxWidth = graphFit.boxWidth > 0 ? graphFit.boxWidth : graphMenuAnchor.right + width + 16
          const boxHeight = graphFit.boxHeight > 0 ? graphFit.boxHeight : graphMenuAnchor.bottom + height + 16
          // 视口比菜单还窄/矮时上限会小于下限，`Math.max` 把这种情况收成「靠左上」。
          const clamp = (value, max) => Math.max(8, Math.min(value, Math.max(8, max)))
          const maxLeft = boxWidth - width - 8
          let left = graphMenuAnchor.right + 8
          if (left > maxLeft) left = graphMenuAnchor.left - width - 8
          const top = clamp((graphMenuAnchor.top + graphMenuAnchor.bottom) / 2 - height / 2, boxHeight - height - 8)
          element.style.left = `${Math.round(clamp(left, maxLeft))}px`
          element.style.top = `${Math.round(top)}px`
        }
        // 换目标、换视图或换布局时回到居中；同一张图内的缩放与平移保留。
        const viewKey = `${graphMode}|${layoutMode}|${data.target?.rowId ?? ''}|${layout.width}x${layout.height}`
        // 图换了就按新尺寸重算适配比例；视口尺寸变了也在每次渲染时跟上。
        if (graphFit.width !== layout.width || graphFit.height !== layout.height) {
          graphFit.width = layout.width
          graphFit.height = layout.height
        }
        const resized = measureGraph()
        graphView.scale = graphFit.scale * graphZoom
        graphZoomControl.zoom = graphZoom
        graphZoomControl.set = setGraphZoom
        if (graphView.key !== viewKey || resized) {
          graphView.key = viewKey
          centerGraph()
        }
        const resetGraphView = () => {
          graphView.scale = graphFit.scale
          centerGraph()
          applyGraphView()
          if (setGraphZoom !== undefined) setGraphZoom(1)
        }
        const zoomControls = setGraphZoom === undefined ? null : h(
          'span',
          { className: 'ptGraphZoom' },
          textButton('−', () => zoomGraph(graphViewportElement, undefined, undefined, -1), { disabled: graphZoom <= GRAPH_ZOOM_MIN, title: '缩小关系图（也可以按住 Ctrl 滚动滚轮）' }),
          h('span', { className: 'ptGraphZoomValue', title: '当前缩放比例；100% 表示整图适配视口，Ctrl + 滚轮可直接缩放' }, `${Math.round(graphZoom * 100)}%`),
          textButton('+', () => zoomGraph(graphViewportElement, undefined, undefined, 1), { disabled: graphZoom >= GRAPH_ZOOM_MAX, title: '放大关系图（也可以按住 Ctrl 滚动滚轮）' }),
          textButton('重置', resetGraphView, { title: '回到整图适配并居中' }),
        )
        const modeControl = setGraphMode === undefined ? null : h(
          'span',
          { className: 'ptSeg', role: 'group', 'aria-label': '关系图模式' },
          h(
            'button',
            {
              type: 'button',
              className: 'ptSegBtn',
              'aria-pressed': graphMode === 'impact',
              title: '只展示禁用并重载后确定不可用的条目',
              onClick: () => setGraphMode('impact'),
            },
            '影响图',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ptSegBtn',
              'aria-pressed': graphMode === 'full',
              title: '展示完整的声明与结构关系',
              onClick: () => setGraphMode('full'),
            },
            '完整链路图',
          ),
        )
        // 布局只换「怎么摆」，边与节点不变：分层看方向，网状看簇。
        const layoutControl = setGraphLayout === undefined ? null : h(
          'span',
          { className: 'ptSeg', role: 'group', 'aria-label': '关系图布局' },
          h(
            'button',
            {
              type: 'button',
              className: 'ptSegBtn',
              'aria-pressed': layoutMode === 'layered',
              title: '自上而下分层：上游在上、目标居中、下游在下',
              onClick: () => setGraphLayout('layered'),
            },
            '分层',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ptSegBtn',
              'aria-pressed': layoutMode === 'net',
              title: '按连接关系铺开成网：相连的靠在一起，便于看簇与密度',
              onClick: () => setGraphLayout('net'),
            },
            '网状',
          ),
        )
        const crossToggle = graphMode === 'full' && setGraphCross !== undefined && layout.crossEdges.length > 0
          ? textButton(
              showCross ? '隐藏非树边' : '显示非树边',
              () => setGraphCross(!showCross),
              { title: '非树边是生成树之外的另一条声明路径；隐藏后只保留树形骨架' },
            )
          : null
        // 控件跟着画布走：它们只作用于这张图，放在标题旁边会让人以为作用于整页。
        // 浮层钉在视口上、不随平移缩放移动，所以拖动图形时按钮始终停在右上角。
        const overlay = h(
          'div',
          {
            className: 'ptGraphOverlay',
            // 不拦 pointerdown 的话，按住按钮拖动会被当成拖动画布。
            onPointerDown: (event) => event.stopPropagation(),
            // 浮层里的按钮不应该顺手清掉画布上的路径高亮。
            onClick: (event) => event.stopPropagation(),
          },
          layoutControl,
          modeControl,
          crossToggle,
          zoomControls,
        )
        /**
         * 线型图例：钉在视口左下角，和右上角浮层同一层。
         *
         * 不参与平移缩放——它是读线的钥匙，不是图的一部分；放进 stage 会跟着缩小，
         * 字和线段都会糊。`pointer-events:none` 让图例像不存在一样：压到边或节点时
         * 点击、拖拽照常落到画布上。
         */
        const legend = hasGraph && legendEntries.length > 1
          ? h(
              'div',
              { className: 'ptGraphLegend', role: 'group', 'aria-label': '关系图图例' },
              legendEntries.map((entry) => h(
                'span',
                { key: entry.kind, className: 'ptGraphLegendItem' },
                h(
                  'svg',
                  { className: 'ptGraphLegendLine', viewBox: '0 0 26 8', 'aria-hidden': 'true' },
                  // 与画布里的边共用 `.ptGraphEdge` 的线型规则，图例不会和实际线型走偏。
                  h('path', { className: 'ptGraphEdge', 'data-kind': entry.kind, d: 'M2 4H24' }),
                ),
                entry.label,
              )),
            )
          : null
        const targetName = data.target.rowId ?? data.target.title ?? data.target.entryId ?? '未知插件'
        // 读屏要能分清两条轴：说清是哪种数据口径、用哪种摆法。
        const layoutWord = layoutMode === 'net' ? '网状布局' : '分层布局'
        const graphLabel = (graphMode === 'full'
          ? `插件完整关系图（${layoutWord}）：目标 ${targetName}，上游 ${upstreamCount} 个，下游 ${downstreamCount} 个，非树边 ${crossCount} 条。`
          : `插件影响图（${layoutWord}）：目标 ${targetName}，受阻 ${blockedCount} 个，随父行 ${cascadeCount} 个。`)
          + (focusInfo === null
            ? ''
            : `已高亮 ${focusName} 的依赖路径：${focusInfo.nodes.length} 个节点、${focusInfo.edges.length} 条边。`)
        const emptyText = graphMode === 'impact'
          ? '没有插件会因为这次禁用失去必需服务'
          : '没有可绘制的声明关系'
        const emptyActions = graphMode === 'impact' && setGraphMode !== undefined
          ? textButton('在完整链路图中查看声明关系', () => setGraphMode('full'))
          : null
        const noteText = [
          ...(Array.isArray(tree.notes) ? tree.notes : []),
          !showCross && crossCount > 0 ? '非树边已隐藏' : '',
          focusInfo === null
            ? ''
            : `已高亮 ${focusName} 的路径（${focusInfo.nodes.length} 个节点、${focusInfo.edges.length} 条边）；再点一次或点空白处取消`,
        ].filter((note) => note !== '').join('；')
        /**
         * 一条边：视觉层 + 命中层。
         *
         * 命中层是一条透明的宽描边路径——1.25px 的线根本点不到，加宽到 12px 但仍然
         * 只在描边上命中，所以不会挡住线段之间的空白。点它高亮经过这条边的整条路径。
         */
        const renderEdge = (edge, cross) => h(
          'g',
          {
            key: edge.key,
            className: 'ptGraphEdgeRow',
            'data-focus': focusInfo === null ? undefined : (focusEdges.has(edge.key) ? 'on' : 'off'),
          },
          h('path', {
            className: 'ptGraphEdge',
            'data-kind': edge.kind,
            'data-cross': cross ? 'true' : undefined,
            d: edge.d,
          }),
          h('polygon', { className: 'ptGraphArrow', points: edge.arrow }),
          edge.labelBg
            ? h('rect', {
              className: 'ptGraphLabelBg',
              x: edge.labelBg.x,
              y: edge.labelBg.y,
              width: edge.labelBg.width,
              height: edge.labelBg.height,
              rx: 3,
            })
            : null,
          edge.label
            ? h('text', { className: 'ptGraphEdgeLabel', x: edge.labelX, y: edge.labelY, textAnchor: 'middle' }, clip(edge.label, 18))
            : null,
          h('title', null, `${titleByKey.get(edge.fromKey) ?? edge.fromKey} → ${titleByKey.get(edge.toKey) ?? edge.toKey}${edge.fullLabel ? ` · ${edge.fullLabel}` : ''}；点击高亮相关路径`),
          h('path', {
            className: 'ptGraphEdgeHit',
            d: edge.d,
            onClick: (event) => {
              event.stopPropagation()
              toggleFocus('edge', edge.key)
            },
          }),
        )
        /**
         * 节点右键菜单。
         *
         * 左键已改为高亮路径，跳转插件页只能另找入口；菜单同时提供同一个聚焦开关，
         * 让键盘用户也能从「菜单 → 高亮」走通。菜单挂在视口内、用 scrim 收点击，
         * 不 portal 出去：图本身就在固定视口里，没有必要逃出裁切范围。
         *
         * 它必须是 stage 的**兄弟**而不是子节点：stage 带着 `translate + scale`，
         * 菜单的 `left/top` 是视口像素，挂在 stage 里会被叠加一次变换，于是整体
         * 漂移、字号也跟着缩放。浮层、菜单、stage 三者共用视口这块坐标系。
         */
        const menuLayer = menu === null || setMenu === undefined ? null : h(
          'div',
          {
            className: 'ptGraphMenuScrim',
            onPointerDown: (event) => event.stopPropagation(),
            onClick: (event) => {
              event.stopPropagation()
              setMenu(null)
            },
            onContextMenu: (event) => {
              event.preventDefault()
              event.stopPropagation()
              setMenu(null)
            },
          },
          h(
            'div',
            {
              className: 'ptGraphMenu',
              role: 'menu',
              'aria-label': `${menu.title} 的操作`,
              // 首帧用打开时估的位置，ref 量到真实宽高后再贴到方块旁边。
              ref: positionMenu,
              style: { left: `${menu.x}px`, top: `${menu.y}px` },
              onPointerDown: (event) => event.stopPropagation(),
              onClick: (event) => event.stopPropagation(),
              onKeyDown: (event) => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                // 只关菜单：画布还会收到同一按键，不能顺手把路径高亮也清掉。
                event.stopPropagation()
                setMenu(null)
              },
            },
            h('p', { className: 'ptGraphMenuTitle', title: menu.title }, clip(menu.title, 28)),
            h(
              'button',
              {
                type: 'button',
                role: 'menuitem',
                className: 'ptGraphMenuItem',
                autoFocus: true,
                onClick: () => {
                  setMenu(null)
                  openPlugin(menu.rowId)
                },
              },
              '在插件页打开',
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'menuitem',
                className: 'ptGraphMenuItem',
                onClick: () => {
                  setMenu(null)
                  toggleFocus('node', menu.key)
                },
              },
              focus?.kind === 'node' && focus?.key === menu.key ? '取消高亮相关路径' : '高亮相关路径',
            ),
          ),
        )
        return h(
          'div',
          { className: 'ptSection' },
          h(
            'div',
            { className: 'ptSectionHead' },
            h('p', { className: 'ptSectionTitle' }, '依赖关系图'),
          ),
          hasGraph
            ? h(
                'div',
                {
                  className: 'ptGraphViewport',
                  ref: setGraphViewport,
                  // 关键布局也写在行内：即使宿主还挂着旧样式，图也不会跑出固定区域。
                  style: { position: 'relative', overflow: 'hidden', flex: 'none', height: GRAPH_VIEWPORT_HEIGHT, minHeight: GRAPH_VIEWPORT_MIN_HEIGHT },
                  onPointerDown: startGraphPan,
                  onPointerMove: moveGraphPan,
                  onPointerUp: endGraphPan,
                  onPointerLeave: () => { if (graphPan.moved !== true) graphPan.active = false },
                  onPointerCancel: endGraphPan,
                  // 点画布空白处取消高亮；节点与边自己会拦掉冒泡，浮层也不会走到这里。
                  onClick: () => {
                    if (graphPan.moved === true) return
                    if (focusInfo !== null && setFocus !== undefined) setFocus(null)
                  },
                  // 画布没有值得保留的原生右键菜单；节点自己会拦掉这一层并打开操作菜单。
                  onContextMenu: (event) => {
                    event.preventDefault()
                    if (menu !== null && setMenu !== undefined) setMenu(null)
                  },
                  // Esc 是「取消」：菜单优先关菜单，其次取消路径高亮。
                  onKeyDown: (event) => {
                    if (event.key !== 'Escape') return
                    if (menu !== null && setMenu !== undefined) {
                      setMenu(null)
                      return
                    }
                    if (focusInfo !== null && setFocus !== undefined) setFocus(null)
                  },
                },
                // 控件浮在画布上、不与 stage 一起变换：拖动图形时按钮保持在右上角。
                overlay,
                h(
                  'div',
                  {
                    className: 'ptGraphStage',
                    ref: setGraphStage,
                    title: '按住 Ctrl 滚动滚轮缩放，按住拖拽平移',
                    style: {
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: `${layout.width}px`,
                      height: `${layout.height}px`,
                      transformOrigin: '0 0',
                      transform: graphTransform(graphView, graphView.scale),
                    },
                  },
                  h(
                    'svg',
                    {
                      className: 'ptGraph',
                      viewBox: `0 0 ${layout.width} ${layout.height}`,
                      // 聚焦态挂在这一层：CSS 按它决定「命中保持原色 / 其余降透明度」。
                      'data-focus': focusInfo === null ? undefined : 'on',
                      role: 'group',
                      'aria-label': graphLabel,
                    },
                    // 分层：标签嵌在线里，路径在文字处已断开，这里只把文字填进缺口。
                    // 网状：曲线断成两截会更碎，改用一块底色压住文字。
                    layout.edges.map((edge) => renderEdge(edge, false)),
                    layout.crossEdges.map((edge) => (showCross ? renderEdge(edge, true) : null)),
                    layout.nodes.map((node) => {
                      // 方块里只有插件名；状态、层级与服务边都收进悬浮提示。
                      const tooltip = nodeTooltip(node, data)
                      // 折行与高度由布局算好（一行 48、两行 64），这里只决定基线。
                      const titleLines = Array.isArray(node.lines)
                        ? node.lines
                        : impactTree.wrapGraphTitle(node.title, 2, node.width)
                      const lineStep = 16
                      const labelY = titleLines.length > 1
                        ? node.y + node.height / 2 - lineStep / 2 + 4
                        : node.y + node.height / 2 + 4
                      return h(
                        'g',
                        {
                          key: node.key,
                          className: 'ptGraphNode',
                          'data-tone': node.side === 'root'
                            ? 'target'
                            : node.blocked === true || node.causedByParent === true || pending.has(node.rowId)
                              ? 'pending'
                              : undefined,
                          role: 'button',
                          tabIndex: 0,
                          // 焦点命中的节点保持原色、其余降透明度；读屏也能知道哪条路径被选中。
                          'data-focus': focusInfo === null ? undefined : (focusNodes.has(node.key) ? 'on' : 'off'),
                          'aria-pressed': focusInfo === null ? undefined : focusNodes.has(node.key),
                          'aria-label': `${node.title}：${tooltip}，点击高亮依赖路径，右键打开插件页`,
                          onClick: (event) => {
                            if (graphPan.moved === true) return
                            // 不清掉冒泡的话，画布的空点击会立刻把刚点开的高亮关掉。
                            event.stopPropagation()
                            toggleFocus('node', node.key)
                          },
                          onContextMenu: (event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            openMenu(node)
                          },
                          onKeyDown: (event) => {
                            // Shift+F10 / ContextMenu 是系统级的「打开上下文菜单」。
                            if (event.key === 'ContextMenu' || (event.shiftKey === true && event.key === 'F10')) {
                              event.preventDefault()
                              openMenu(node)
                              return
                            }
                            activateOnKey(event, () => toggleFocus('node', node.key))
                          },
                        },
                        h('title', null, `${node.title} · ${tooltip}`),
                        h('rect', { x: node.x, y: node.y, width: node.width, height: node.height, rx: 8 }),
                        h(
                          'text',
                          { className: 'ptGraphLabel', x: node.x + 10, y: labelY },
                          titleLines.map((line, index) => h(
                            'tspan',
                            { key: index, x: node.x + 10, dy: index === 0 ? 0 : lineStep },
                            line,
                          )),
                        ),
                      )
                    }),
                  ),
                ),
                // 图例同样挂在视口层：它是读线的钥匙，不随画布缩放。
                legend,
                // 右键菜单与浮层一样挂在视口层，不随画布变换移动。
                menuLayer,
              )
            : h(
                'div',
                null,
                h('p', { className: 'ptEmpty' }, emptyText),
                emptyActions,
              ),
          noteText !== '' ? h('p', { className: 'ptHint', style: { margin: 0 } }, noteText) : null,
        )
      }

      return { renderRelations }
    }
  },
})
