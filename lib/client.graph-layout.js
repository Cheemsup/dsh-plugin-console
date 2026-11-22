/**
 * 分层 DAG 布局引擎：破环 → 分层 → dummy → 层内排序 → 坐标。
 *
 * 为什么单独成一个 chunk：布局是纯几何，不该认识「插件 / 服务 / config」；上层
 * `client.impact-tree.js` 只负责把树摊成有向图再调这里。拆开后两边都能单独读、
 * 单独断言。
 *
 * 阶段划分照搬 ELK Layered（Cycle Breaking / Layer Assignment /
 * Crossing Minimization / Node Placement / Edge Routing），只保留与「提供者在上、
 * 消费者在下」这一种读法有关的部分：不做端口约束与层次化图，不做力导向。
 * 走线不在这里：拿到坐标与节点链之后由 `client.graph-route.js` 负责。
 *
 * 一条硬约束：本文件不读全局状态、不用随机数与 `localeCompare`（后者依赖 ICU，
 * 同一份数据在不同运行时可能排出不同顺序）。同一输入永远得到同一张图。
 * @module dsh-plugin-console/client-graph-layout
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.graph-layout.js',
  factory: () => {
    /**
     * 默认几何。
     *
     * 层间空隙不是常数：走线通道数决定空隙高度（每个通道 12px + 上下各 10px 留白），
     * 只有一条竖线时退回 40px 的最小值。空隙随真实重叠深度增长，而不是随边数线性
     * 增长——20 条边若能共用 4 条通道，空隙就只按 4 条算。
     */
    const DEFAULTS = {
      padding: 20,
      nodeGap: 24,
      /** 没有横向走线时的最小层间空隙。 */
      layerGapBase: 40,
      layerGapMax: 220,
      /** 每个走线通道的高度与空隙上下留白；通道多时空隙随之加高。 */
      trackGap: 12,
      trackPad: 10,
      sweeps: 8,
      transposeRounds: 4,
      /** dummy 只占一个「过路点」，但仍要留出宽度，否则并列的长边会贴在一起。 */
      dummySize: 10,
    }

    /** 不用 localeCompare：ICU 版本会影响顺序，图必须跨环境可复现。 */
    function compareText(left, right) {
      return left < right ? -1 : (left > right ? 1 : 0)
    }

    /** 中位数；空集合返回 null，由调用方决定退化策略。 */
    function median(values) {
      if (values.length === 0) return null
      const sorted = values.slice().sort((left, right) => left - right)
      const middle = sorted.length >> 1
      return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
    }

    /**
     * 严格逆序对计数（双层交叉数）。
     *
     * 调用方把同一上层的出边按 (上层位置, 下层位置) 升序排好，所以同源边之间
     * 的 j 序列天然升序，不会被算成交叉；两条边同源或同目标不算交叉。
     * @param {number[]} values - 排好序的下层位置序列。
     * @returns {number} 交叉数。
     */
    function countInversions(values) {
      if (values.length < 2) return 0
      let count = 0
      const sort = (list) => {
        if (list.length < 2) return list
        const middle = list.length >> 1
        const left = sort(list.slice(0, middle))
        const right = sort(list.slice(middle))
        const merged = []
        let i = 0
        let j = 0
        while (i < left.length && j < right.length) {
          if (left[i] <= right[j]) merged.push(left[i++])
          else {
            count += left.length - i
            merged.push(right[j++])
          }
        }
        while (i < left.length) merged.push(left[i++])
        while (j < right.length) merged.push(right[j++])
        return merged
      }
      sort(values)
      return count
    }

    /**
     * 破环：DFS 里指向「还在栈上」的节点的边就是回边。
     *
     * 依赖图本来大多是 DAG；回边只出现在互相依赖与「已在上方出现过」的重复节点上。
     * 用迭代 DFS 而不是递归：真实 profile 的链路可以超过 200 层。
     * @param {Array<object>} nodes - 真实节点（含 index）。
     * @param {Array<object>} links - 边，回边会被就地标 `reversed`。
     */
    function reverseBackEdges(nodes, links) {
      const outgoing = new Map(nodes.map((node) => [node.id, []]))
      for (const link of links) outgoing.get(link.from.id).push(link)
      const roots = nodes.slice().sort((left, right) => left.index - right.index || compareText(left.id, right.id))
      // 0 = 未访问，1 = 在栈上，2 = 已完成。
      const state = new Map()
      for (const root of roots) {
        if (state.has(root.id)) continue
        state.set(root.id, 1)
        const stack = [{ node: root, edges: outgoing.get(root.id), cursor: 0 }]
        while (stack.length > 0) {
          const frame = stack[stack.length - 1]
          if (frame.cursor >= frame.edges.length) {
            state.set(frame.node.id, 2)
            stack.pop()
            continue
          }
          const link = frame.edges[frame.cursor++]
          const seen = state.get(link.to.id)
          if (seen === 1) {
            link.reversed = true
            continue
          }
          if (seen === 2) continue
          state.set(link.to.id, 1)
          stack.push({ node: link.to, edges: outgoing.get(link.to.id), cursor: 0 })
        }
      }
    }

    /**
     * 分层：以根为中心的双向最长路。
     *
     * 不能用「所有源点 rank 0 + 最短/最长路」：目标的上游若是「直接提供者 + 一条
     * 更长的提供链」，直接提供者会被压到最顶层，和目标之间凭空拉出一条多层边。
     * 这里对正向（root 的后继）与反向（root 的前驱）分别求最长路，上游取负秩：
     * 这等价于约束系统 `rank(v) ≥ rank(u)+1` 的逐分量最小解，也就顺带最小化了
     * 总边长——不需要 network simplex。
     *
     * 多层边随后由 dummy 拆开，这正是 ELK / dot 的常规做法。
     * @param {Array<object>} nodes - 真实节点。
     * @param {Array<object>} links - 已标好 `reversed` 的边。
     * @param {string} rootId - 目标节点 id。
     * @returns {object} `{ layer, succ, pred }`。
     */
    function assignLayers(nodes, links, rootId) {
      const indegree = new Map(nodes.map((node) => [node.id, 0]))
      const succ = new Map(nodes.map((node) => [node.id, []]))
      const pred = new Map(nodes.map((node) => [node.id, []]))
      for (const link of links) {
        // 分层方向永远是「上游 → 下游」；回边在布局里按翻转后的方向参与。
        const tail = link.reversed ? link.to : link.from
        const head = link.reversed ? link.from : link.to
        link.tail = tail
        link.head = head
        succ.get(tail.id).push(head)
        pred.get(head.id).push(tail)
        indegree.set(head.id, indegree.get(head.id) + 1)
      }
      const byIndex = (left, right) => left.index - right.index || compareText(left.id, right.id)
      const topo = []
      const ready = nodes.filter((node) => indegree.get(node.id) === 0).sort(byIndex)
      let head = 0
      while (head < ready.length) {
        const node = ready[head++]
        topo.push(node)
        for (const next of succ.get(node.id)) {
          indegree.set(next.id, indegree.get(next.id) - 1)
          if (indegree.get(next.id) === 0) ready.push(next)
        }
      }
      if (topo.length < nodes.length) {
        // 理论上破环之后不会走到这里；真走到时也不能丢节点，按模型序补在末尾。
        const listed = new Set(topo.map((node) => node.id))
        for (const node of nodes.slice().sort(byIndex)) if (!listed.has(node.id)) topo.push(node)
      }

      const layer = new Map()
      const root = nodes.find((node) => node.id === rootId)
      if (root !== undefined) {
        const forward = new Map([[root.id, 0]])
        for (const node of topo) {
          const base = forward.get(node.id)
          if (base === undefined) continue
          for (const next of succ.get(node.id)) {
            const value = base + 1
            if (!forward.has(next.id) || forward.get(next.id) < value) forward.set(next.id, value)
          }
        }
        const backward = new Map([[root.id, 0]])
        for (let index = topo.length - 1; index >= 0; index--) {
          const node = topo[index]
          const base = backward.get(node.id)
          if (base === undefined) continue
          for (const other of pred.get(node.id)) {
            const value = base + 1
            if (!backward.has(other.id) || backward.get(other.id) < value) backward.set(other.id, value)
          }
        }
        for (const node of nodes) {
          if (forward.has(node.id)) layer.set(node.id, forward.get(node.id))
          else if (backward.has(node.id)) layer.set(node.id, -backward.get(node.id))
        }
      }
      // 两个方向都到不了的节点（旁支）：贴在它自己的前驱下面，不推高其它层。
      for (const node of topo) {
        if (layer.has(node.id)) continue
        let value = 0
        for (const other of pred.get(node.id)) {
          if (layer.has(other.id)) value = Math.max(value, layer.get(other.id) + 1)
        }
        layer.set(node.id, value)
      }
      return { layer, succ, pred }
    }

    /**
     * 把所有节点按层收集并排序；dummy 与真实节点一视同仁。
     *
     * 初始顺序用模型序（调用方的 DFS 序，业务语义是「同一提供者的消费者相邻」），
     * 不用标题字典序：标题与图结构无关，还会随语言变化。
     */
    function buildLayerLists(nodes, layerCount) {
      const layers = Array.from({ length: layerCount }, () => [])
      for (const node of nodes) {
        if (layers[node.layer] === undefined) layers[node.layer] = []
        layers[node.layer].push(node)
      }
      for (const list of layers) {
        list.sort((left, right) => left.order - right.order || left.seq - right.seq || compareText(left.id, right.id))
      }
      return layers
    }

    /** 建立上下邻居表；同一条边在 chain 里只出现一次，这里仍去重以防水合边权重失真。 */
    function buildNeighbours(nodes, chains) {
      const up = new Map(nodes.map((node) => [node.id, new Set()]))
      const down = new Map(nodes.map((node) => [node.id, new Set()]))
      for (const chain of chains) {
        for (let index = 0; index + 1 < chain.steps.length; index++) {
          const from = chain.steps[index]
          const to = chain.steps[index + 1]
          down.get(from).add(to)
          up.get(to).add(from)
        }
      }
      return { up, down }
    }

    /**
     * 层内排序：median 上下扫描 + transpose，保留交叉最少的一轮。
     *
     * 只做重心排序会在「扇出 + 汇合」上停在一个局部极小值；transpose 用相邻交换
     * 做局部修补，两者交替才接近 dot 的 mincross 效果。每轮都记录交叉数，最后
     * 回到最优的那一轮，避免某一轮把顺序改坏后无法回头。
     */
    function orderLayers(nodes, neighbours, layerCount, options) {
      const layers = buildLayerLists(nodes, layerCount)
      const { up, down } = neighbours
      const slot = new Map()
      const layerOf = new Map()
      const sync = () => {
        for (let index = 0; index < layers.length; index++) {
          const list = layers[index]
          for (let position = 0; position < list.length; position++) {
            slot.set(list[position].id, position)
            layerOf.set(list[position].id, index)
          }
        }
      }
      sync()

      /** 空隙两侧的出边：按 (上层位置, 下层位置) 排序后可直接数逆序。 */
      const pairsOf = (gap) => {
        const pairs = []
        for (const node of layers[gap] ?? []) {
          const from = slot.get(node.id)
          for (const id of down.get(node.id) ?? []) {
            // dummy 链保证长边被拆成逐层段，所以这里正常只会看到相邻层；仍校验一次。
            if (layerOf.get(id) !== gap + 1) continue
            const to = slot.get(id)
            if (to !== undefined) pairs.push([from, to])
          }
        }
        pairs.sort((left, right) => left[0] - right[0] || left[1] - right[1])
        const values = new Array(pairs.length)
        for (let index = 0; index < pairs.length; index++) values[index] = pairs[index][1]
        return values
      }
      const totalCrossings = () => {
        let total = 0
        for (let gap = 0; gap + 1 < layers.length; gap++) total += countInversions(pairsOf(gap))
        return total
      }
      /** 只数某一层两侧：transpose 只看这次交换影响到的局部。 */
      const localCrossings = (index) => {
        let total = 0
        if (index > 0) total += countInversions(pairsOf(index - 1))
        if (index + 1 < layers.length) total += countInversions(pairsOf(index))
        return total
      }

      const sweep = (indices, adjacent, step) => {
        for (const index of indices) {
          const list = layers[index]
          const scored = list.map((node, position) => {
            const values = []
            for (const id of adjacent.get(node.id) ?? []) {
              // 只看相邻层：跨层的原始边（长边两端）若参与打分，会用远端层的序号
              // 把节点拖向无关位置——扇出图就是被这样排错的。
              if (layerOf.get(id) !== index + step) continue
              const other = slot.get(id)
              if (other !== undefined) values.push(other)
            }
            const score = median(values)
            return { node, score: score === null ? position : score, position }
          })
          scored.sort((left, right) => left.score - right.score || left.position - right.position)
          layers[index] = scored.map((row) => row.node)
          sync()
        }
      }

      const transpose = () => {
        for (let round = 0; round < options.transposeRounds; round++) {
          let improved = false
          for (let index = 0; index < layers.length; index++) {
            const list = layers[index]
            for (let position = 0; position + 1 < list.length; position++) {
              const before = localCrossings(index)
              const left = list[position]
              list[position] = list[position + 1]
              list[position + 1] = left
              sync()
              const after = localCrossings(index)
              if (after < before) improved = true
              else {
                list[position + 1] = list[position]
                list[position] = left
                sync()
              }
            }
          }
          if (!improved) break
        }
      }

      let best = layers.map((list) => list.slice())
      let bestCrossings = totalCrossings()
      for (let pass = 0; pass < options.sweeps; pass++) {
        const descending = pass % 2 === 0
        if (descending) {
          const indices = []
          for (let index = 1; index < layers.length; index++) indices.push(index)
          sweep(indices, up, -1)
        } else {
          const indices = []
          for (let index = layers.length - 2; index >= 0; index--) indices.push(index)
          sweep(indices, down, 1)
        }
        transpose()
        const crossings = totalCrossings()
        if (crossings < bestCrossings) {
          bestCrossings = crossings
          best = layers.map((list) => list.slice())
        }
      }
      return { layers: best, crossings: bestCrossings }
    }

    /**
     * Brandes-Köpf 水平坐标（TB 下就是层内 x）。
     *
     * 四遍「对齐 + 压实」：向上/向下对齐 × 向左/向右让位。每遍把节点与它的中位
     * 邻居串成块、块内共用一个 x，再用块图的 longest path 求相对坐标；四遍结果先
     * 同竖向平均、再两组平均。作用不是「排得均匀」，而是让尽量多的长边变成一条
     * 竖直直线——层内顺序已经由交叉最小化定好，这里只负责把它画直。
     *
     * 参考 Brandes & Köpf, Fast and Simple Horizontal Coordinate Assignment (GD 2001)；
     * 这里省掉 sink/shift 的类别优化，直接对块图求最长路，结果一致且更好读。
     * @param {Array<Array<object>>} layers - 层内已排好序的节点。
     * @param {object} neighbours - `{ up, down }` 邻居表。
     * @param {object} options - 几何参数。
     * @returns {Map<string, number>} 节点 id → 中心 x（相对坐标，最小值为 0）。
     */
    function brandesKoepf(layers, neighbours, options) {
      const position = new Map()
      const layerOf = new Map()
      for (let index = 0; index < layers.length; index++) {
        const list = layers[index]
        for (let slot = 0; slot < list.length; slot++) {
          position.set(list[slot].id, slot)
          layerOf.set(list[slot].id, index)
        }
      }
      const sizeOf = new Map()
      for (const list of layers) for (const node of list) sizeOf.set(node.id, node.width)

      /** 一遍：`adjacent` 是「对齐方向」的邻居表。 */
      const onePass = (adjacent, upward, toLeft) => {
        const root = new Map()
        const align = new Map()
        for (const list of layers) {
          for (const node of list) {
            root.set(node.id, node.id)
            align.set(node.id, node.id)
          }
        }
        // 从上往下对齐上游 / 从下往上对齐下游；同层内再按偏置决定谁先挑邻居。
        const order = []
        if (upward) for (let index = 0; index < layers.length; index++) order.push(index)
        else for (let index = layers.length - 1; index >= 0; index--) order.push(index)
        for (const index of order) {
          const list = layers[index]
          const sequence = toLeft ? list : list.slice().reverse()
          let limit = toLeft ? -1 : Number.MAX_SAFE_INTEGER
          for (const node of sequence) {
            // 一个节点在一个块里只能有一条对齐边，已经对齐的不能再被别人对齐。
            if (align.get(node.id) !== node.id) continue
            const candidates = []
            for (const id of adjacent.get(node.id) ?? []) {
              const slot = position.get(id)
              if (slot !== undefined) candidates.push({ id, slot })
            }
            if (candidates.length === 0) continue
            candidates.sort((left, right) => left.slot - right.slot)
            const count = candidates.length
            const medians = count % 2 === 1
              ? [candidates[(count - 1) >> 1]]
              : [candidates[(count >> 1) - 1], candidates[count >> 1]]
            for (const median of medians) {
              if (align.get(node.id) !== node.id) break
              if (toLeft ? median.slot <= limit : median.slot >= limit) continue
              align.set(median.id, node.id)
              root.set(node.id, root.get(median.id))
              align.set(node.id, root.get(median.id))
              limit = median.slot
            }
          }
        }

        const x = new Map()
        /**
         * 块内迭代：同一个块的所有节点共用块根的坐标。
         *
         * 沿 `align` 链走完整块，把「同层左侧邻居所在块」当作前驱，取最长路。
         * 四遍都按"从左往右"压实，左/右偏置只影响对齐阶段的冲突取舍——这是
         * dagre 的做法：把右偏置表达成不同的对齐，而不是反向压实，免得坐标系混乱。
         * 递归深度最多是一层的节点数，不会跟着链路长度走。
         */
        const placeBlock = (start) => {
          if (x.has(start)) return
          x.set(start, 0)
          let current = start
          do {
            const list = layers[layerOf.get(current)]
            const slot = position.get(current)
            const adjacentNode = list[slot - 1]
            if (adjacentNode !== undefined) {
              const other = root.get(adjacentNode.id)
              placeBlock(other)
              const gap = (sizeOf.get(adjacentNode.id) + sizeOf.get(current)) / 2 + options.nodeGap
              x.set(start, Math.max(x.get(start), x.get(other) + gap))
            }
            current = align.get(current)
          } while (current !== start)
        }
        for (const list of layers) {
          for (const node of list) {
            if (root.get(node.id) === node.id) placeBlock(node.id)
          }
        }
        const result = new Map()
        let min = Number.MAX_SAFE_INTEGER
        for (const list of layers) {
          for (const node of list) {
            const value = x.get(root.get(node.id)) ?? 0
            result.set(node.id, value)
            min = Math.min(min, value)
          }
        }
        // 四遍必须共用原点，平均才有意义。
        if (Number.isFinite(min) && min !== 0) {
          for (const [id, value] of result) result.set(id, value - min)
        }
        return result
      }

      // 顺序固定为「上左、上右、下左、下右」，同竖向配对后再合并，避免系统性偏置。
      const upLeft = onePass(neighbours.up, true, true)
      const upRight = onePass(neighbours.up, true, false)
      const downLeft = onePass(neighbours.down, false, true)
      const downRight = onePass(neighbours.down, false, false)
      const blend = (left, right) => {
        const out = new Map()
        for (const [id, value] of left) out.set(id, (value + (right.get(id) ?? value)) / 2)
        return out
      }
      return blend(blend(upLeft, upRight), blend(downLeft, downRight))
    }

    /**
     * 坐标与通道分配。
     *
     * 顺序不能反：层内 x 先定（Brandes-Köpf + 向正方向推行一次，保证同层相邻节点
     * 间距不小于 `nodeGap`——四遍平均必然破坏最小间距，这一步是正确性而非美化），
     * 端口才能按对端中心扇出；端口定了，空隙里的通道数才算得出来；通道数决定空隙
     * 高度，最后才排各层的 y。走线本身（点序与圆角）在 `client.graph-route.js`，
     * 这里只分配「从哪个端口出、走哪条通道」。
     */
    function placeLayers(layers, neighbours, chains, options) {
      const rowHeights = layers.map((list) => {
        let height = 0
        for (const node of list) height = Math.max(height, node.height)
        return height
      })
      const layerById = new Map()
      const widthOf = new Map()
      for (let index = 0; index < layers.length; index++) {
        for (const node of layers[index]) {
          layerById.set(node.id, index)
          widthOf.set(node.id, node.width)
        }
      }

      const centers = brandesKoepf(layers, neighbours, options)
      // dummy 只是「过路人」，不该占真实节点的整段间距：它的空隙按 dummy 自己的宽度算。
      const separation = (leftId, rightId) => (
        (widthOf.get(leftId) + widthOf.get(rightId)) / 2 + options.nodeGap
      )
      for (const list of layers) {
        for (let index = 1; index < list.length; index++) {
          const previous = list[index - 1]
          const node = list[index]
          const least = centers.get(previous.id) + separation(previous.id, node.id)
          if (centers.get(node.id) < least) centers.set(node.id, least)
        }
      }
      // 整体平移到 padding：相对坐标的最小值不一定是方块左缘。
      let leftmost = Number.MAX_SAFE_INTEGER
      for (const list of layers) {
        for (const node of list) leftmost = Math.min(leftmost, centers.get(node.id) - node.width / 2)
      }
      const offset = options.padding - leftmost
      const centerOf = new Map()
      const sizeOf = new Map()
      for (const list of layers) {
        for (const node of list) {
          centerOf.set(node.id, centers.get(node.id) + offset)
          sizeOf.set(node.id, node.width)
        }
      }

      // 端口：同一侧的多条边按对端中心 x 排序后均分，扇出就不会在层内互穿。
      const outgoing = new Map()
      const incoming = new Map()
      const segmentsByGap = new Map()
      for (const chain of chains) {
        chain.segments = []
        for (let index = 0; index + 1 < chain.steps.length; index++) {
          const from = chain.steps[index]
          const to = chain.steps[index + 1]
          const gap = layerById.get(from) ?? 0
          const segment = { from, to, fromX: 0, toX: 0, track: -1, gap }
          chain.segments.push(segment)
          if (!outgoing.has(from)) outgoing.set(from, [])
          outgoing.get(from).push(segment)
          if (!incoming.has(to)) incoming.set(to, [])
          incoming.get(to).push(segment)
          if (!segmentsByGap.has(gap)) segmentsByGap.set(gap, [])
          segmentsByGap.get(gap).push(segment)
        }
      }
      const spread = (list, nodeId, key) => {
        const center = centerOf.get(nodeId) ?? 0
        const size = sizeOf.get(nodeId) ?? 0
        // 边缘留 12px：端口贴着圆角时箭头会像插进卡片里；dummy 宽度不足时退化为单点。
        const usable = Math.max(0, size / 2 - Math.min(12, size / 2))
        const count = list.length
        list.forEach((segment, index) => {
          const ratio = count <= 1 ? 0.5 : index / (count - 1)
          segment[key] = center - usable + ratio * usable * 2
        })
      }
      for (const [nodeId, list] of outgoing) {
        list.sort((left, right) => (centerOf.get(left.to) ?? 0) - (centerOf.get(right.to) ?? 0)
          || compareText(left.to, right.to))
        spread(list, nodeId, 'fromX')
      }
      for (const [nodeId, list] of incoming) {
        list.sort((left, right) => (centerOf.get(left.from) ?? 0) - (centerOf.get(right.from) ?? 0)
          || compareText(left.from, right.from))
        spread(list, nodeId, 'toX')
      }

      // 通道：同一通道上只要 x 区间不重叠就可以复用。
      // 「每条边一条通道」会让 20 条边撑出上千像素的空隙；区间贪心分配既是最少
      // 通道数（区间图的贪心最优），也让空隙高度只跟真实重叠深度走。
      const trackCounts = new Map()
      for (const [gapIndex, list] of segmentsByGap) {
        const horizontal = list.filter((segment) => Math.abs(segment.fromX - segment.toX) >= 0.5)
        horizontal.sort((left, right) => Math.min(left.fromX, left.toX) - Math.min(right.fromX, right.toX)
          || Math.max(left.fromX, left.toX) - Math.max(right.fromX, right.toX)
          || compareText(`${left.from}>${left.to}`, `${right.from}>${right.to}`))
        const ends = []
        for (const segment of horizontal) {
          const left = Math.min(segment.fromX, segment.toX)
          const right = Math.max(segment.fromX, segment.toX)
          let track = -1
          for (let index = 0; index < ends.length; index++) {
            if (ends[index] + options.trackGap <= left) {
              track = index
              break
            }
          }
          if (track < 0) {
            track = ends.length
            ends.push(right)
          } else {
            ends[track] = right
          }
          segment.track = track
        }
        trackCounts.set(gapIndex, ends.length)
      }
      const gapHeights = []
      for (let index = 0; index + 1 < layers.length; index++) {
        const tracks = trackCounts.get(index) ?? 0
        const needed = tracks === 0 ? 0 : options.trackPad * 2 + tracks * options.trackGap
        gapHeights.push(Math.min(options.layerGapMax, Math.max(options.layerGapBase, needed)))
      }

      const rows = []
      let y = options.padding
      for (let index = 0; index < layers.length; index++) {
        rows.push({ index, y, height: rowHeights[index] })
        y += rowHeights[index] + (gapHeights[index] ?? 0)
      }
      let rightmost = 0
      for (let index = 0; index < layers.length; index++) {
        for (const node of layers[index]) {
          const center = centerOf.get(node.id)
          node.x = center - node.width / 2
          node.y = rows[index].y + (rowHeights[index] - node.height) / 2
          rightmost = Math.max(rightmost, node.x + node.width)
        }
      }
      const gaps = []
      for (let index = 0; index + 1 < layers.length; index++) {
        gaps.push({
          index,
          y: rows[index].y + rows[index].height,
          height: gapHeights[index],
          edges: segmentsByGap.get(index)?.length ?? 0,
          tracks: trackCounts.get(index) ?? 0,
          pad: options.trackPad,
        })
      }
      return {
        rows,
        gaps,
        width: rightmost + options.padding,
        height: options.padding * 2 + rowHeights.reduce((sum, height) => sum + height, 0)
          + gapHeights.reduce((sum, height) => sum + height, 0),
      }
    }

    /**
     * 主入口：把抽象有向图排成分层布局。
     *
     * @param {object} input - `{ nodes, edges, options }`。
     *   节点：`{ id, width, height, order }`；边：`{ id, from, to }`。
     * @returns {object} 坐标、层、空隙、每条边的节点链与交叉数。
     */
    function layoutLayered(input) {
      const options = { ...DEFAULTS, ...(input?.options ?? {}) }
      const real = []
      const byId = new Map()
      const rawNodes = Array.isArray(input?.nodes) ? input.nodes : []
      for (let index = 0; index < rawNodes.length; index++) {
        const raw = rawNodes[index]
        if (raw === null || raw === undefined || typeof raw.id !== 'string') continue
        if (byId.has(raw.id)) continue
        const node = {
          id: raw.id,
          width: Math.max(1, Number(raw.width) || 1),
          height: Math.max(1, Number(raw.height) || 1),
          order: Number.isFinite(raw.order) ? raw.order : index,
          seq: index,
          layer: 0,
          x: 0,
          y: 0,
          dummy: false,
        }
        real.push(node)
        byId.set(node.id, node)
      }
      const links = []
      for (const raw of Array.isArray(input?.edges) ? input.edges : []) {
        const from = byId.get(raw?.from)
        const to = byId.get(raw?.to)
        if (from === undefined || to === undefined || from === to) continue
        links.push({ id: raw.id, from, to, reversed: false })
      }
      if (real.length === 0) {
        return { nodes: [], dummies: [], chains: [], layers: [], gaps: [], crossings: 0, width: 0, height: 0 }
      }

      reverseBackEdges(real, links)
      const state = assignLayers(real, links, input?.rootId)
      // 分层只确定相对顺序；平移到 0 起点，最上层的节点贴住画布上缘。
      let topLayer = Infinity
      for (const value of state.layer.values()) topLayer = Math.min(topLayer, value)
      if (!Number.isFinite(topLayer) || topLayer === 0) topLayer = 0
      for (const node of real) node.layer = state.layer.get(node.id) - topLayer

      // 跨层边拆成逐层的 dummy 链；链的方向是分层方向（回边已翻转）。
      const all = real.slice()
      const chains = []
      let dummySeq = 0
      for (const link of links) {
        const tail = link.tail
        const head = link.head
        const steps = [tail.id]
        const fromLayer = tail.layer
        const toLayer = head.layer
        const span = toLayer - fromLayer
        for (let layer = fromLayer + 1; layer < toLayer; layer++) {
          // 初始模型序按两端插值：dummy 一开始就落在「源与目标之间」，层内排序只需
          // 微调。若照抄源的序，所有 dummy 都会挤到层首，长边就贴到画布边缘。
          const ratio = span <= 0 ? 0 : (layer - fromLayer) / span
          const dummy = {
            id: `~d${dummySeq}`,
            width: options.dummySize,
            height: options.dummySize,
            order: tail.order + (head.order - tail.order) * ratio,
            seq: all.length,
            layer,
            x: 0,
            y: 0,
            dummy: true,
          }
          dummySeq++
          all.push(dummy)
          steps.push(dummy.id)
        }
        steps.push(head.id)
        chains.push({ id: link.id, from: link.from.id, to: link.to.id, reversed: link.reversed, steps })
      }

      const layerCount = all.reduce((max, node) => Math.max(max, node.layer + 1), 1)

      // 邻居表只建一次：排序（median）与坐标（Brandes-Köpf）用的是同一份。
      const neighbours = buildNeighbours(all, chains)
      const ordered = orderLayers(all, neighbours, layerCount, options)
      const placed = placeLayers(ordered.layers, neighbours, chains, options)
      const dummies = []
      for (const node of all) {
        if (!node.dummy) continue
        dummies.push({
          id: node.id,
          layer: node.layer,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
        })
      }
      return {
        nodes: real.map((node) => ({
          id: node.id,
          layer: node.layer,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
        })),
        dummies,
        chains,
        layers: placed.rows.map((row) => ({ index: row.index, y: row.y, height: row.height })),
        gaps: placed.gaps,
        crossings: ordered.crossings,
        width: placed.width,
        height: placed.height,
      }
    }

    return { layoutLayered, countInversions }
  },
})
