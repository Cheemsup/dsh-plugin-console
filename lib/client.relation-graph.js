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
        const layout = impactTree.layoutRelationTree(tree)
        const rows = impactTree.flattenRelationTree(tree)
        const pending = new Set((data.services?.pending ?? []).map((row) => row.rowId))
        const blockedCount = rows.filter((row) => row.blocked === true).length
        const cascadeCount = rows.filter((row) => row.causedByParent === true).length
        const upstreamCount = rows.filter((row) => row.side === 'upstream').length
        const downstreamCount = rows.filter((row) => row.side === 'downstream').length
        const crossCount = layout.crossEdges.length
        const hasGraph = tree.root !== null && layout.nodes.length > 1
        const openPlugin = typeof vc.gotoPlugin === 'function' ? vc.gotoPlugin : () => {}
        // 换目标或换视图时回到居中；同一张图内的缩放与平移保留。
        const viewKey = `${graphMode}|${data.target?.rowId ?? ''}|${layout.width}x${layout.height}`
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
        const crossToggle = graphMode === 'full' && setGraphCross !== undefined && layout.crossEdges.length > 0
          ? textButton(
              showCross ? '隐藏非树边' : '显示非树边',
              () => setGraphCross(!showCross),
              { title: '非树边是生成树之外的另一条声明路径；隐藏后只保留树形骨架' },
            )
          : null
        const actions = zoomControls === null && modeControl === null && crossToggle === null
          ? null
          : h('span', { className: 'ptActions ptGraphTools' }, modeControl, crossToggle, zoomControls)
        const targetName = data.target.rowId ?? data.target.title ?? data.target.entryId ?? '未知插件'
        const graphLabel = graphMode === 'full'
          ? `插件完整关系图：目标 ${targetName}，上游 ${upstreamCount} 个，下游 ${downstreamCount} 个，非树边 ${crossCount} 条。`
          : `插件影响图：目标 ${targetName}，受阻 ${blockedCount} 个，随父行 ${cascadeCount} 个。`
        const emptyText = graphMode === 'impact'
          ? '没有插件会因为这次禁用失去必需服务'
          : '没有可绘制的声明关系'
        const emptyActions = graphMode === 'impact' && setGraphMode !== undefined
          ? textButton('在完整链路图中查看声明关系', () => setGraphMode('full'))
          : null
        const noteText = [
          ...(Array.isArray(tree.notes) ? tree.notes : []),
          !showCross && crossCount > 0 ? '非树边已隐藏' : '',
        ].filter((note) => note !== '').join('；')
        return h(
          'div',
          { className: 'ptSection' },
          h(
            'div',
            { className: 'ptSectionHead' },
            h('p', { className: 'ptSectionTitle' }, '依赖关系图'),
            actions,
          ),
          hasGraph
            ? h(
                'div',
                {
                  className: 'ptGraphViewport',
                  ref: setGraphViewport,
                  title: '按住 Ctrl 滚动滚轮缩放，按住拖拽平移',
                  // 关键布局也写在行内：即使宿主还挂着旧样式，图也不会跑出固定区域。
                  style: { position: 'relative', overflow: 'hidden', flex: 'none', height: GRAPH_VIEWPORT_HEIGHT, minHeight: GRAPH_VIEWPORT_MIN_HEIGHT },
                  onPointerDown: startGraphPan,
                  onPointerMove: moveGraphPan,
                  onPointerUp: endGraphPan,
                  onPointerLeave: () => { if (graphPan.moved !== true) graphPan.active = false },
                  onPointerCancel: endGraphPan,
                },
                h(
                  'div',
                  {
                    className: 'ptGraphStage',
                    ref: setGraphStage,
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
                      role: 'group',
                      'aria-label': graphLabel,
                    },
                    // 标签嵌在线里：路径在文字处已断开，这里只把文字填进缺口。
                    layout.edges.map((edge) => h(
                      'g',
                      { key: edge.key },
                      h('path', { className: 'ptGraphEdge', 'data-kind': edge.kind, d: edge.d }),
                      h('polygon', { className: 'ptGraphArrow', points: edge.arrow }),
                      edge.label
                        ? h('text', { className: 'ptGraphEdgeLabel', x: edge.labelX, y: edge.labelY, textAnchor: 'middle' }, clip(edge.label, 18))
                        : null,
                    )),
                    layout.crossEdges.map((edge) => showCross ? h(
                      'g',
                      { key: edge.key },
                      h('path', { className: 'ptGraphEdge', 'data-kind': edge.kind, 'data-cross': 'true', d: edge.d }),
                      h('polygon', { className: 'ptGraphArrow', points: edge.arrow }),
                      edge.label
                        ? h('text', { className: 'ptGraphEdgeLabel', x: edge.labelX, y: edge.labelY, textAnchor: 'middle' }, clip(edge.label, 18))
                        : null,
                    ) : null),
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
                          'aria-label': `${node.title}：${tooltip}，点击在插件页打开`,
                          onClick: () => {
                            if (graphPan.moved === true) return
                            openPlugin(node.rowId)
                          },
                          onKeyDown: (event) => activateOnKey(event, () => openPlugin(node.rowId)),
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
