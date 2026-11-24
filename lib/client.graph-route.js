/**
 * 分层图的走线：把布局给出的「节点链」变成正交折线、SVG 路径、箭头与标签锚点。
 *
 * 为什么和布局分开：布局只回答「谁在哪一层、层内第几个」；走线回答「线怎么绕」。
 * 两者的失败模式完全不同（前者是交叉与层级，后者是撞节点与通道重叠），分开才能
 * 各自断言。
 *
 * 正交走线的安全性来自一条构造性质：竖段永远落在某个节点自己的 x 跨度内，横段
 * 永远落在两层之间的空隙里，所以线段不可能穿过任何方块——不需要通用避障。
 *
 * 标签不浮在线的旁边，而是**嵌在线里**：在标签所在的段上挖掉一段，文字填进缺口。
 * 水平段够长就横着开缺口；只有竖段够长时，在竖段上开一个一行高的口，文字仍横排
 * 居中。旁边浮一个字会与相邻通道的线打架，嵌进去之后「这条线写的是哪个服务」不再
 * 需要靠位置去猜。
 * @module dsh-plugin-console/client-graph-route
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.graph-route.js',
  factory: () => {
    /** 拐角半径；超过相邻段长度一半时会被截断，避免弧线回折。 */
    const CORNER_RADIUS = 5
    /** 箭头长度与半宽。 */
    const ARROW_LENGTH = 6
    const ARROW_HALF = 3.5
    /** 嵌字时线在文字两侧各让出的空白；太小会贴上字形。 */
    const LABEL_PADDING = 6
    /** 一个字符的估算宽度：12px 字号下西文约 6.6px、汉字约 13px（见 `textWidth`）。 */
    const LABEL_CHAR_WIDTH = 6.6

    /** 路径里的坐标保留一位小数：避免浮点尾数把 d 写得很长。 */
    function format(value) {
      return String(Math.round(value * 10) / 10)
    }

    /** 去掉连续重复点；退化的水平/竖直段会让路径出现零长度线段。 */
    function dedupe(points) {
      const list = []
      for (const point of points) {
        const last = list[list.length - 1]
        if (last !== undefined && Math.abs(last[0] - point[0]) < 0.01 && Math.abs(last[1] - point[1]) < 0.01) continue
        list.push(point)
      }
      return list
    }

    /**
     * 正交折线 → 带圆角的 SVG path。
     *
     * 圆角用二次贝塞尔：在每个拐点前后各退 `radius`，控制点就是拐点本身。
     * 半径受两侧线段长度约束，否则短段会被截成反向的弧。
     * @param {Array<number[]>} points - 折线点。
     * @returns {string} SVG path 的 `d`。
     */
    function pathOf(points) {
      if (points.length < 2) return ''
      let cursor = points[0]
      let d = `M${format(cursor[0])} ${format(cursor[1])}`
      for (let index = 1; index + 1 < points.length; index++) {
        const corner = points[index]
        const next = points[index + 1]
        const inLength = Math.abs(corner[0] - cursor[0]) + Math.abs(corner[1] - cursor[1])
        const outLength = Math.abs(next[0] - corner[0]) + Math.abs(next[1] - corner[1])
        const inDx = Math.sign(Math.round(corner[0] - cursor[0]))
        const inDy = Math.sign(Math.round(corner[1] - cursor[1]))
        const outDx = Math.sign(Math.round(next[0] - corner[0]))
        const outDy = Math.sign(Math.round(next[1] - corner[1]))
        const radius = Math.min(CORNER_RADIUS, inLength / 2, outLength / 2)
        if (radius < 0.2 || (inDx === outDx && inDy === outDy)) {
          d += ` L${format(corner[0])} ${format(corner[1])}`
          cursor = corner
          continue
        }
        const beforeX = corner[0] - inDx * radius
        const beforeY = corner[1] - inDy * radius
        const afterX = corner[0] + outDx * radius
        const afterY = corner[1] + outDy * radius
        d += ` L${format(beforeX)} ${format(beforeY)}`
          + ` Q${format(corner[0])} ${format(corner[1])} ${format(afterX)} ${format(afterY)}`
        cursor = [afterX, afterY]
      }
      const last = points[points.length - 1]
      d += ` L${format(last[0])} ${format(last[1])}`
      return d
    }

    /**
     * 任意方向上的箭头三角形。
     *
     * 正交走线用 `Math.sign` 把方向吸到四个轴上就够了；曲线必须用真实切线，
     * 否则斜向的边会得到一个横着或竖着的箭头，看起来像插错了地方。
     */
    function arrowVector(tip, fromX, fromY) {
      const dx = tip[0] - fromX
      const dy = tip[1] - fromY
      const length = Math.hypot(dx, dy)
      if (!(length > 1e-6)) return null
      const ux = dx / length
      const uy = dy / length
      const baseX = tip[0] - ux * ARROW_LENGTH
      const baseY = tip[1] - uy * ARROW_LENGTH
      const leftX = baseX - uy * ARROW_HALF
      const leftY = baseY + ux * ARROW_HALF
      const rightX = baseX + uy * ARROW_HALF
      const rightY = baseY - ux * ARROW_HALF
      return `${format(tip[0])},${format(tip[1])} ${format(leftX)},${format(leftY)} ${format(rightX)},${format(rightY)}`
    }

    /** 箭头三角形：尖端落在最后一点，底边沿来向后退，方向由最后一小段决定。 */
    function arrowOf(points) {
      const tip = points[points.length - 1]
      const previous = points[points.length - 2]
      const dx = Math.sign(Math.round(tip[0] - previous[0]))
      const dy = Math.sign(Math.round(tip[1] - previous[1]))
      const baseX = tip[0] - dx * ARROW_LENGTH
      const baseY = tip[1] - dy * ARROW_LENGTH
      // 与来向垂直的方向：(-dy, dx)。
      const leftX = baseX - dy * ARROW_HALF
      const leftY = baseY + dx * ARROW_HALF
      const rightX = baseX + dy * ARROW_HALF
      const rightY = baseY - dx * ARROW_HALF
      return `${format(tip[0])},${format(tip[1])} ${format(leftX)},${format(leftY)} ${format(rightX)},${format(rightY)}`
    }

    /** 文本宽度估算：汉字按 13px、其余按 6.6px；与布局里折行的口径保持一致。 */
    function textWidth(text) {
      let width = 0
      for (const char of String(text ?? '')) {
        width += /[⺀-鿿豈-﫿＀-￯]/.test(char) ? 13 : LABEL_CHAR_WIDTH
      }
      return width
    }

    /** 文字基线相对线段 / 缺口中心的偏移：字高约 12px，基线在中心偏下 4px。 */
    const BASELINE_SHIFT = 4
    /** 嵌在竖段上时，缺口要够放下一行字（字高 + 上下留白）。 */
    const LABEL_LINE_HEIGHT = 15
    /** 曲线采样数：越多越不容易漏判，但每条边都要乘一遍方块数。 */
    const CURVE_SAMPLES = 16
    /** 避障时给方块留的外扩量：贴着边框走也算撞，否则视觉上仍是压线。 */
    const CURVE_INFLATE = 6
    /** 曲线两端各陷进方块边缘多少：让线从边框里长出来，不留抗锯齿的缝。 */
    const CURVE_INSET = 8

    /**
     * 标签要嵌进哪一段、缺口挖多大。
     *
     * 优先水平段：文字横排，缺口只需「文字宽 + 两侧留白」，读起来也最自然。
     * 横向跨度不够（直落的边、跨距很小的扇出）时改嵌竖段：竖段上挖一个「文字宽 +
     * 两侧留白 × 一行字高」的小口，文字仍横排居中——这样每条带标签的边都有断开处，
     * 不会出现「字浮在线的旁边、不知道属于哪条线」。
     *
     * 两种情况都放不下（整条边没有够长的段）时返回 null，调用方不画文字。
     */
    function labelSlotOf(points, text) {
      const width = textWidth(text)
      const neededX = width + LABEL_PADDING * 2
      let horizontal = null
      let vertical = null
      for (let index = 0; index + 1 < points.length; index++) {
        const from = points[index]
        const to = points[index + 1]
        const dx = Math.abs(to[0] - from[0])
        const dy = Math.abs(to[1] - from[1])
        if (dy < 0.01 && (horizontal === null || dx > horizontal.length)) {
          horizontal = { from, to, length: dx, index }
        }
        if (dx < 0.01 && (vertical === null || dy > vertical.length)) {
          vertical = { from, to, length: dy, index }
        }
      }
      if (horizontal !== null && neededX <= horizontal.length) {
        const middleX = (horizontal.from[0] + horizontal.to[0]) / 2
        return {
          inline: true,
          x: middleX,
          y: horizontal.from[1] + BASELINE_SHIFT,
          index: horizontal.index,
          // 缺口沿水平段切：起点、终点都在同一 y 上。
          axis: 'x',
          start: middleX - width / 2 - LABEL_PADDING,
          end: middleX + width / 2 + LABEL_PADDING,
        }
      }
      // 竖段只需放下一行字、并在线两端各留 2px：留太多会把「直落的边」排除在外，
      // 而那些边恰恰最需要文字（它们只有一条竖线，没有别的线索）。
      if (vertical !== null && vertical.length >= LABEL_LINE_HEIGHT + 4) {
        const middleY = (vertical.from[1] + vertical.to[1]) / 2
        return {
          inline: true,
          // 文字压在竖线中间：视觉上仍是一条线上断开的一小段。
          x: vertical.from[0],
          y: middleY + BASELINE_SHIFT,
          index: vertical.index,
          axis: 'y',
          start: middleY - LABEL_LINE_HEIGHT / 2,
          end: middleY + LABEL_LINE_HEIGHT / 2,
        }
      }
      return null
    }

    /**
     * 在一条段上挖掉 `[start, end]`，返回剩下的折线。
     *
     * 缺口一定落在某一段内部（`labelSlotOf` 已保证长度够），所以左/上残留段的末点
     * 与右/下残留段的首点都还在原来的坐标轴上，线仍然是正交的。
     */
    function cutSegment(points, slot) {
      if (slot === null) return [points]
      const from = points[slot.index]
      const to = points[slot.index + 1]
      const axis = slot.axis
      const ascending = to[axis === 'x' ? 0 : 1] > from[axis === 'x' ? 0 : 1]
      const before = points.slice(0, slot.index + 1)
      const after = points.slice(slot.index + 1)
      const edge = (value) => (axis === 'x' ? [value, from[1]] : [from[0], value])
      const head = [...before, edge(ascending ? slot.start : slot.end)]
      const tail = [edge(ascending ? slot.end : slot.start), ...after]
      // 退化段（缺口顶到端点）直接丢掉，否则会留下零长度线段。
      const cleaned = []
      for (const part of [head, tail]) {
        const list = dedupe(part)
        if (list.length >= 2) cleaned.push(list)
      }
      return cleaned
    }

    /**
     * 把每条边的节点链走成折线。
     *
     * 布局已经给出每一段的「出端口 x / 入端口 x / 通道号」，这里只负责把段拼成
     * 折线：出 → 通道 → 横移 → 入。竖段落在节点自己的 x 跨度内，横段落在两层之间
     * 的空隙里，所以线段不可能穿过方块。长边在 dummy 处逐层穿过，不绕画布边缘。
     *
     * @param {object} layout - `client.graph-layout.js` 的返回值。
     * @param {Map<string, string>} [labels] - 边 id → 要嵌进线里的文字；不传或没有
     *   文字时只走线、不挖缺口。
     * @returns {Array<object>} 每条的 `{ id, segments, points, d, arrow, label, labelX, labelY, back }`。
     */
    function routeEdges(layout, labels) {
      const boxes = new Map()
      for (const node of layout?.nodes ?? []) boxes.set(node.id, { ...node, dummy: false })
      for (const node of layout?.dummies ?? []) boxes.set(node.id, { ...node, dummy: true })
      const gaps = layout?.gaps ?? []
      const routes = []
      for (const chain of layout?.chains ?? []) {
        const chainSegments = Array.isArray(chain.segments) ? chain.segments : []
        if (chainSegments.length === 0) continue
        const points = []
        for (const segment of chainSegments) {
          const from = boxes.get(segment.from)
          const to = boxes.get(segment.to)
          if (from === undefined || to === undefined) continue
          const exitY = from.dummy ? from.y + from.height / 2 : from.y + from.height
          const entryY = to.dummy ? to.y + to.height / 2 : to.y
          points.push([segment.fromX, exitY])
          if (Math.abs(segment.fromX - segment.toX) < 0.5) {
            // 两端对齐：直落一条竖线，不占用通道。
            points.push([segment.toX, entryY])
            continue
          }
          const gap = gaps[segment.gap]
          const channelY = gap === undefined
            ? (exitY + entryY) / 2
            : (segment.track >= 0 && gap.tracks > 0
              ? gap.y + gap.pad + (segment.track + 0.5) * ((gap.height - 2 * gap.pad) / gap.tracks)
              : gap.y + gap.height / 2)
          points.push([segment.fromX, channelY])
          points.push([segment.toX, channelY])
          points.push([segment.toX, entryY])
        }
        // 回边在布局里是翻转方向走的；把点序倒回来，箭头才会落在真正的目标上。
        const ordered = chain.reversed ? points.slice().reverse() : points
        const list = dedupe(ordered)
        if (list.length < 2) continue
        const text = typeof labels === 'function' ? labels(chain) : labels?.get(chain.id)
        // 文字一律嵌进线里：水平段够长就横着开缺口，否则在竖段上开一个一行高的口。
        const slot = text ? labelSlotOf(list, text) : null
        const segments = cutSegment(list, slot)
        routes.push({
          id: chain.id,
          points: list,
          segments,
          d: segments.map((part) => pathOf(part)).join(' '),
          arrow: arrowOf(list),
          label: slot === null ? null : text,
          labelX: slot === null ? 0 : slot.x,
          labelY: slot === null ? 0 : slot.y,
          back: chain.reversed === true,
        })
      }
      return { edges: routes }
    }

    /**
     * 候选偏移：以「节点对角尺寸的中位数」为单位的斐波那契式倍数。
     *
     * 单位按节点尺寸给，而不是写死像素：视口里最终看到的是「弯 / 节点」的比例，
     * 绝对像素在大画布上会被节点群吞掉（等于没有弯），在小图上又会把边甩出画布。
     * 中位数而不是均值：少数超宽行（组合行 id）不该决定整张图的尺度。
     */
    function offsetCandidates(nodes) {
      const sizes = (Array.isArray(nodes) ? nodes : [])
        .map((node) => (Number(node.width) + Number(node.height)) / 2)
        .filter((size) => Number.isFinite(size) && size > 0)
        .sort((left, right) => left - right)
      const median = sizes.length > 0 ? sizes[sizes.length >> 1] : 120
      // 夹住：过小则弯不出方块，过大则一条边就要占半个画布。
      const unit = Math.max(72, Math.min(236, median))
      return [0, 0.35, -0.35, 0.7, -0.7, 1.1, -1.1, 1.6, -1.6, 2.2, -2.2].map((factor) => factor * unit)
    }

    /**
     * 网状布局的走线：两端按各自方块边界裁切，中间一条二次贝塞尔。
     *
     * 分层那边能用正交折线，是因为「竖段只落在端点自己的 x 跨度内、横段只落在层间
     * 空隙」这条构造性质；网状的节点任意摆放，这条性质不存在，所以改成「先裁切、
     * 再按法向偏移试几条曲线、谁不撞方块用谁」。
     *
     * 避障只是**采样否决**，不是几何保证：候选曲线按等参数采点，任一点落进非端点
     * 方块就换下一个偏移；偏移全部否决时退回**直线**。宁可偶尔压到一个方块，也不让
     * 边在画布上绕出更难读的大弧线。
     *
     * 两条容易踩的边界：
     * 1. 退回的直线必须是一条**画得出来**的曲线（有中间采样点）。只给两个端点时
     *    `curvePathOf` 会当成退化曲线返回空 `d`——节点看起来没有任何连边，也就是
     *    「孤岛」。稠密图里绝大多数长边都走这条退路，这个坑不是偶发。
     * 2. 候选偏移按节点尺寸成比例，不用绝对像素：同样的 200px，在 200 节点的画布上
     *    还在节点群内部，等于没有弯。越界的候选取样会被画布裁掉，所以给 `bounds`
     *    时一并否决。
     *
     * @param {Array<object>} nodes - `{ id, x, y, width, height }`。
     * @param {Array<object>} edges - `{ id, from, to, label }`；`label` 可由调用方补。
     * @param {object} [options] - `{ candidates, bounds }`：法向偏移试探顺序，以及画布
     *   `{ width, height }`（取样越界的候选不采用）。
     * @returns {Array<object>} 与 `routeEdges` 对齐的走线行。
     */
    function routeCurves(nodes, edges, options) {
      // 候选按「弯得越少越优先」排：0 是直线，之后按节点尺度成倍数左右交替加大。
      const candidates = Array.isArray(options?.candidates)
        ? options.candidates
        : offsetCandidates(nodes)
      const bounds = options?.bounds
      const boxes = new Map((nodes ?? []).map((node) => [node.id, node]))
      const routes = []
      for (const edge of Array.isArray(edges) ? edges : []) {
        const from = boxes.get(edge.from)
        const to = boxes.get(edge.to)
        if (from === undefined || to === undefined || from === to) continue
        const points = curveOf(from, to, boxes, candidates, bounds)
        if (points === null) continue
        const text = typeof edge.label === 'string' && edge.label !== '' ? edge.label : null
        const middle = points[Math.floor(points.length / 2)]
        routes.push({
          id: edge.id,
          points,
          d: curvePathOf(points),
          // 用采样出的真实切线，而不是正交箭头那种四向吸附。短边去重后可能只剩两点，
          // 这时退回到端点本身；`arrowVector` 距离退化时再退回到四向吸附。
          arrow: arrowVector(
            points[points.length - 1],
            points[Math.max(0, points.length - 3)][0],
            points[Math.max(0, points.length - 3)][1],
          ) ?? arrowOf(points),
          label: text,
          // 文字放在曲线的参数中点，压在线上一小块底色上；分层那边是「断线填字」，
          // 曲线断成两截会变成两个弧段，读起来反而更碎。
          labelX: middle[0],
          labelY: middle[1] + BASELINE_SHIFT,
          labelBg: text === null
            ? null
            : {
              x: middle[0] - textWidth(text) / 2 - LABEL_PADDING,
              y: middle[1] - LABEL_LINE_HEIGHT / 2,
              width: textWidth(text) + LABEL_PADDING * 2,
              height: LABEL_LINE_HEIGHT,
            },
          back: false,
          fromKey: edge.from,
          toKey: edge.to,
        })
      }
      return routes
    }

    /** 射线从方块中心出发，与矩形边界的交点。 */
    function boxExit(box, dx, dy) {
      const halfWidth = box.width / 2
      const halfHeight = box.height / 2
      const scaleX = Math.abs(dx) < 1e-9 ? Infinity : halfWidth / Math.abs(dx)
      const scaleY = Math.abs(dy) < 1e-9 ? Infinity : halfHeight / Math.abs(dy)
      const scale = Math.min(scaleX, scaleY)
      if (!Number.isFinite(scale)) return { x: box.x + halfWidth, y: box.y + halfHeight }
      return { x: box.x + halfWidth + dx * scale, y: box.y + halfHeight + dy * scale }
    }

    /** 二次贝塞尔在 t 处的点。 */
    function quadAt(start, control, end, t) {
      const u = 1 - t
      return [
        u * u * start[0] + 2 * u * t * control[0] + t * t * end[0],
        u * u * start[1] + 2 * u * t * control[1] + t * t * end[1],
      ]
    }

    /** 二次贝塞尔 → SVG path；曲线不需要圆角处理。 */
    function curvePathOf(points) {
      // 两点是「退化但仍然可画」的直线：不能返回空串，否则整条边在页面上消失，
      // 两端节点看起来像互不相连的孤岛。
      if (points.length === 2) {
        return `M${format(points[0][0])} ${format(points[0][1])} L${format(points[1][0])} ${format(points[1][1])}`
      }
      if (points.length < 3) return ''
      const start = points[0]
      const end = points[points.length - 1]
      const control = points[Math.floor(points.length / 2)]
      return `M${format(start[0])} ${format(start[1])} Q${format(control[0])} ${format(control[1])} ${format(end[0])} ${format(end[1])}`
    }

    /** 采样点是否落进「非端点」方块（inflate 一点，贴边也算撞）。 */
    function hitsBox(point, boxes, allowed, inflate) {
      for (const box of boxes.values()) {
        if (allowed.has(box.id)) continue
        if (point[0] > box.x - inflate && point[0] < box.x + box.width + inflate
          && point[1] > box.y - inflate && point[1] < box.y + box.height + inflate) return true
      }
      return false
    }

    /**
     * 在两个方块之间挑一条不撞别的方块的曲线；全部候选都被否决时用直线。
     *
     * 二次贝塞尔的端点**不**从方块边缘出发，而是两端各陷进方块边缘 8px 再开始画：
     * 箭头要落在方块上、线也要贴着方块出来，端点若正好在边框上，抗锯齿后仍会看到
     * 一条缝。陷进去的一小段被方块盖住，视觉上就是「从方块的边出发」。
     *
     * 控制点取「连线中点 + 法向偏移」，偏移为 0 时控制点落在中点，贝塞尔退化成
     * 直线——候选顺序里 0 排第一，所以简单图（无遮挡）永远是直线。
     *
     * 直线退路也要**采样成曲线**（17 个点）：两点的折线在 `curvePathOf` 里曾经
     * 被当成退化输入，`d` 为空，稠密图里就成片出现「没有连边的孤岛」。
     */
    function curveOf(from, to, boxes, candidates, bounds) {
      const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
      const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 }
      const dx = toCenter.x - fromCenter.x
      const dy = toCenter.y - fromCenter.y
      const length = Math.hypot(dx, dy)
      if (!(length > 1e-6)) return null
      const ux = dx / length
      const uy = dy / length
      const allowed = new Set([from.id, to.id])
      const startEdge = boxExit(from, ux, uy)
      const endEdge = boxExit(to, -ux, -uy)
      const start = [startEdge.x - ux * CURVE_INSET, startEdge.y - uy * CURVE_INSET]
      const end = [endEdge.x + ux * CURVE_INSET, endEdge.y + uy * CURVE_INSET]
      const middleX = (start[0] + end[0]) / 2
      const middleY = (start[1] + end[1]) / 2
      // 法向：与连线垂直；偏移为正时往一侧弯，负值往另一侧。
      const normalX = -uy
      const normalY = ux
      for (const offset of candidates) {
        const control = [middleX + normalX * offset, middleY + normalY * offset]
        if (curveHits(control, start, end, boxes, allowed, bounds)) continue
        return sampleCurve(control, start, end)
      }
      // 全部候选都撞：退回直线。直线也撞时仍然画出来——「有遮挡」比「没有线」好读。
      return sampleCurve([middleX, middleY], start, end)
    }

    /** 曲线是否撞到非端点方块（或越出画布）；端点附近不查，否则会把自己算成遮挡。 */
    function curveHits(control, start, end, boxes, allowed, bounds) {
      for (let step = 2; step <= CURVE_SAMPLES - 2; step++) {
        const point = quadAt(start, control, end, step / CURVE_SAMPLES)
        if (outOfBounds(point, bounds)) return true
        if (hitsBox(point, boxes, allowed, CURVE_INFLATE)) return true
      }
      return false
    }

    /** 采样点是否越出画布：越界的弧线会被裁掉一截，看起来像断线。 */
    function outOfBounds(point, bounds) {
      if (bounds === undefined || bounds === null) return false
      const width = Number(bounds.width)
      const height = Number(bounds.height)
      if (!(width > 0) || !(height > 0)) return false
      return point[0] < 0 || point[1] < 0 || point[0] > width || point[1] > height
    }

    /** 按固定步长采样曲线并保留一位小数；渲染与自检都吃这份折线。 */
    function sampleCurve(control, start, end) {
      const points = [start]
      for (let step = 1; step < CURVE_SAMPLES; step++) {
        points.push(quadAt(start, control, end, step / CURVE_SAMPLES))
      }
      points.push(end)
      return dedupe(points.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]))
    }

    return { routeEdges, pathOf, routeCurves }
  },
})
