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

    return { routeEdges, pathOf }
  },
})
