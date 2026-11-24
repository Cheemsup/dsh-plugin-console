/**
 * 网状布局引擎：以图论距离为目标的应力优化（stress majorization / SMACOF）。
 *
 * 与 `client.graph-layout.js` 的分工：那个回答「谁在第几层」，这个回答「谁离谁多远」。
 * 两者拿的是同一张有向图，节点与连边完全一致，只是坐标不同——阅读方向从
 * 「上游在上、下游在下」换成「相连的靠在一起」。所以本文件不认识插件语义，也不
 * 负责走线：曲线由 `client.graph-route.js` 的 `routeCurves` 生成。
 *
 * 算法取 Gansner, Koren & North 2004（Graph Drawing by Stress Majorization）的
 * **局部形式**（式 12），逐节点原地更新：
 *
 *   X_i ← Σ_j w_ij ( X_j + d_ij · (X_i − X_j) / ‖X_i − X_j‖ ) / Σ_j w_ij
 *
 * 选它而不是 Fruchterman–Reingold 的理由有两条：
 * 1. 每步都有闭式解、应力单调下降，不会像牛顿法那样振荡或发散，也不需要降温调度；
 * 2. 它需要一个「不错的初值」，而分层布局正好提供了——把分层结果松弛成网，
 *    比从随机位置冷启动稳定得多，也省掉了随机数。
 *
 * 一条硬约束：本文件不读全局状态、不用随机数与 `localeCompare`。同一输入永远
 * 得到同一张图（自检用 `JSON.stringify` 做逐字节比对）。
 * @module dsh-plugin-console/client-graph-net
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.graph-net.js',
  factory: () => {
    /**
     * 默认几何。
     *
     * `idealLength` 与 `margin` 缺省都是 `'auto'`：按节点的平均尺寸推（`idealLengthOf` /
     * `marginOf`）。绝对像素在这里是错的——图会整体缩放进视口，16px 的间隙缩放后只剩
     * 3–5px，看起来就是「贴在一起」。真正决定观感的是「间隙 / 节点尺寸」的比值，所以
     * 两者都按节点尺寸成比例给。
     *
     * `aspect` 是包围盒的期望长宽比：网状的天然产物是细长条（链条尤其明显），缩放后
     * 要么左右留白、要么上下留白，节点反而更小。归一到一个接近视口的长宽比之后，
     * 缩放只需要做一次、也不浪费画布。
     */
    const DEFAULTS = {
      padding: 20,
      idealLength: 'auto',
      margin: 'auto',
      /** 包围盒期望长宽比（宽 / 高）；`null` 表示不做归一。 */
      aspect: 1.4,
      sweeps: 64,
      tolerance: 1e-4,
      overlapPasses: 240,
    }

    /**
     * 理想边长：节点平均「对角尺寸」的 1.2 倍，夹在 [96, 240]。
     *
     * 用 `(宽 + 高) / 2` 而不是宽：竖直/水平相邻时要留的是高度，斜向相邻时要留的是
     * 两者，取平均对两种朝向都够用。夹下界避免大图被压成一团，夹上界避免少数宽节点
     * 把整体距离拉爆。
     */
    function idealLengthOf(nodes, requested) {
      if (Number.isFinite(requested)) return Math.max(24, requested)
      let sum = 0
      for (const node of nodes) sum += (node.width + node.height) / 2
      const mean = nodes.length > 0 ? sum / nodes.length : 120
      return Math.max(96, Math.min(240, mean * 1.2))
    }

    /**
     * 去重叠的最小间隙：节点平均高的 1.5 倍，夹在 [56, 112]。
     *
     * 为什么按比例而不是常数：视口把整张图缩放到固定大小，间隙在屏幕上的像素等于
     * 「间隙 / 画布宽度 × 视口宽度」。节点尺寸大约定了画布尺度，所以间隙占节点尺寸
     * 的比例才是屏幕上看起来松不松的真正变量。16px 的旧值缩放到 0.2 倍时只剩 3px，
     * 就是「贴住」的来源。
     *
     * 1.5 × 高度实测是「还能读、但明显分开」的甜点：48px 高的小方块留 72px，
     * 64px 高的留 96px，约合节点宽度的 0.45–0.5。再往上画布变大、适配比例变小，
     * 屏幕上的间隙反而停滞甚至回落（实测 104px 起不再增长）。
     */
    function marginOf(nodes, requested) {
      if (Number.isFinite(requested)) return Math.max(0, requested)
      let sum = 0
      for (const node of nodes) sum += node.height
      const mean = nodes.length > 0 ? sum / nodes.length : 48
      return Math.max(56, Math.min(112, mean * 1.5))
    }

    /** 坐标保留一位小数：画布尺寸与路径字符串都不至于带一长串浮点尾数。 */
    function quantize(value) {
      return Math.round(value * 10) / 10
    }

    /** 不用 localeCompare：ICU 版本会影响顺序，图必须跨环境可复现。 */
    function compareText(left, right) {
      return left < right ? -1 : (left > right ? 1 : 0)
    }

    /** 逐点 BFS 的跳数矩阵；不可达保持 -1，由调用方决定怎么处理。 */
    function hopDistances(adjacency) {
      const count = adjacency.length
      const hops = []
      for (let source = 0; source < count; source++) {
        const row = new Array(count).fill(-1)
        row[source] = 0
        const queue = [source]
        for (let head = 0; head < queue.length; head++) {
          const current = queue[head]
          for (const next of adjacency[current]) {
            if (row[next] !== -1) continue
            row[next] = row[current] + 1
            queue.push(next)
          }
        }
        hops.push(row)
      }
      return hops
    }

    /**
     * 应力值：Σ_{i<j} w_ij (‖X_i − X_j‖ − d_ij)²。
     *
     * 只用来判断收敛（相对下降量），不参与更新——更新有闭式解。
     */
    function stressOf(positions, target, weight) {
      const count = positions.length
      let total = 0
      for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
          const dx = positions[i].x - positions[j].x
          const dy = positions[i].y - positions[j].y
          const delta = Math.hypot(dx, dy) - target[i][j]
          total += weight[i][j] * delta * delta
        }
      }
      return total
    }

    /**
     * 初值共线/退化时把它「展开」成二维。
     *
     * 分层布局的 x 常常整列相同（同层并排、或者一条链就一列），把这个当应力优化的
     * 初值是个陷阱：`X_i − X_j` 全部落在同一条直线上，局部更新只能沿这条线移动，
     * 迭代再怎么跑也不会自己长出第二个维度——最后得到一条细长的直线，长宽比归一
     * 也只是把它拉宽。所以先做一个**确定性的**小幅展开：按节点下标给一点横向摆动，
     * 幅度远小于目标边长（不改变大方向，只把退化维度打破）。
     *
     * 只用下标与固定三角函数，不含随机数；两个维度都退化时才会用到。
     */
    function unfoldCollinear(positions, radius) {
      const count = positions.length
      if (count < 3) return
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const position of positions) {
        minX = Math.min(minX, position.x)
        maxX = Math.max(maxX, position.x)
        minY = Math.min(minY, position.y)
        maxY = Math.max(maxY, position.y)
      }
      const spreadX = maxX - minX
      const spreadY = maxY - minY
      // 判定「退化」用的是相对于整体尺度的阈值，不是绝对值：小图与大字号的图都能用。
      const threshold = Math.max(1e-6, radius * 0.05)
      const vertical = spreadX < threshold
      const horizontal = spreadY < threshold
      if (!vertical && !horizontal) return
      // 退化轴上按下标做周期性摆动；幅度取整体尺度的 8%。
      const amplitude = Math.max(threshold * 4, Math.max(spreadX, spreadY) * 0.08)
      for (let i = 0; i < count; i++) {
        const wave = Math.sin((2 * Math.PI * i) / count)
        if (vertical) positions[i].x += wave * amplitude
        if (horizontal) positions[i].y += Math.cos((2 * Math.PI * i) / count) * amplitude
      }
    }

    /**
     * 把包围盒的长宽比拉向目标值（等比缩放两个轴，面积大致守恒）。
     *
     * 做法是解 `(bw·sx) / (bh·sy) = aspect` 且 `sx·sy = 1`：面积不变的前提下，
     * 横向乘 `√(aspect·bh/bw)`、纵向除同一个数。不动节点间的相对次序，也不改变
     * 任何一对的中心方向——所以 `w = d⁻²` 里已经收敛的形状不会被破坏，只是被
     * 「压扁/拉高」。之后由去重叠修掉挤压。
     */
    function normalizeAspect(nodes, positions, aspect) {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let i = 0; i < nodes.length; i++) {
        minX = Math.min(minX, positions[i].x - nodes[i].width / 2)
        maxX = Math.max(maxX, positions[i].x + nodes[i].width / 2)
        minY = Math.min(minY, positions[i].y - nodes[i].height / 2)
        maxY = Math.max(maxY, positions[i].y + nodes[i].height / 2)
      }
      const boxWidth = Math.max(1, maxX - minX)
      const boxHeight = Math.max(1, maxY - minY)
      const scaleX = Math.sqrt((aspect * boxHeight) / boxWidth)
      if (!Number.isFinite(scaleX) || !(scaleX > 0)) return
      const scaleY = 1 / scaleX
      const centerX = (minX + maxX) / 2
      const centerY = (minY + maxY) / 2
      for (const position of positions) {
        position.x = centerX + (position.x - centerX) * scaleX
        position.y = centerY + (position.y - centerY) * scaleY
      }
    }

    /**
     * 矩形去重叠：两框相交时沿穿透较浅的轴分开。
     *
     * 应力优化只管中心点，方块尺寸被完全忽略；不做这一步，宽节点会互相压住。沿
     * 穿透较浅的轴推开是位移最小的做法，形状改动也最小。遍历顺序固定（i 升序、
     * j 升序），所以结果仍然是确定的；相邻两框用更新后的坐标参与后续比较
     * （Gauss-Seidel 式），收敛比整轮同步更快。
     */
    function removeOverlaps(nodes, positions, options) {
      const count = nodes.length
      // 包围盒已经偏「高」时优先横向推开，偏「宽」时优先纵向：推开的方向决定画布
      // 往哪边长。视口大多是横向更宽、纵向更紧，让高瘦的图横向长、不要继续往上涨，
      // 适配比例才不会一路掉到 0.2。
      const target = Number.isFinite(options.aspect) && options.aspect > 0 ? options.aspect : null
      for (let pass = 0; pass < options.overlapPasses; pass++) {
        let moved = false
        let preferX = false
        let preferY = false
        if (target !== null) {
          let minX = Infinity
          let minY = Infinity
          let maxX = -Infinity
          let maxY = -Infinity
          for (let i = 0; i < count; i++) {
            minX = Math.min(minX, positions[i].x - nodes[i].width / 2)
            maxX = Math.max(maxX, positions[i].x + nodes[i].width / 2)
            minY = Math.min(minY, positions[i].y - nodes[i].height / 2)
            maxY = Math.max(maxY, positions[i].y + nodes[i].height / 2)
          }
          const boxAspect = (maxX - minX) / Math.max(1, maxY - minY)
          preferX = boxAspect < target
          preferY = boxAspect > target
        }
        for (let i = 0; i < count; i++) {
          for (let j = i + 1; j < count; j++) {
            const overlapX = (nodes[i].width + nodes[j].width) / 2 + options.margin
              - Math.abs(positions[i].x - positions[j].x)
            const overlapY = (nodes[i].height + nodes[j].height) / 2 + options.margin
              - Math.abs(positions[i].y - positions[j].y)
            if (overlapX <= 0 || overlapY <= 0) continue
            moved = true
            // 默认沿穿透较浅的轴推开（位移最小）；带长宽比偏好时允许一个轴「多吃」
            // 一倍穿透，把包围盒往目标比例上掰。
            const useX = preferX
              ? overlapX <= overlapY * 2
              : (preferY ? overlapX * 2 <= overlapY : overlapX <= overlapY)
            // 恰好同坐标时 sign 为 0，会给出一对零位移；用下标奇偶定方向保证可复现。
            if (useX) {
              const direction = positions[i].x === positions[j].x
                ? ((i + j) % 2 === 0 ? 1 : -1)
                : Math.sign(positions[i].x - positions[j].x)
              positions[i].x += (direction * overlapX) / 2
              positions[j].x -= (direction * overlapX) / 2
            } else {
              const direction = positions[i].y === positions[j].y
                ? ((i + j) % 2 === 0 ? 1 : -1)
                : Math.sign(positions[i].y - positions[j].y)
              positions[i].y += (direction * overlapY) / 2
              positions[j].y -= (direction * overlapY) / 2
            }
          }
        }
        if (!moved) break
      }
    }

    /**
     * 主入口：把抽象有向图排成网状布局。
     *
     * @param {object} input - `{ nodes, edges, initial, options }`。
     *   `nodes`：`{ id, width, height, order }`；`edges`：`{ id, from, to }`
     *   （方向不参与距离，只影响调用方的箭头）；`initial` 是 `Map<id, {x, y}>`，
     *   通常传分层布局的中心点。缺省时按下标排在一个圆上，仍然确定。
     * @returns {{nodes: Array<object>, width: number, height: number}} 左上角坐标 + 尺寸。
     */
    function layoutStress(input) {
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
          index: real.length,
        }
        real.push(node)
        byId.set(node.id, node)
      }
      if (real.length === 0) return { nodes: [], width: 0, height: 0 }

      // 距离只关心「谁和谁相连」，方向交给箭头；重复的无向对也只算一条。
      const adjacency = real.map(() => [])
      const seenPair = new Set()
      for (const raw of Array.isArray(input?.edges) ? input.edges : []) {
        const from = byId.get(raw?.from)
        const to = byId.get(raw?.to)
        if (from === undefined || to === undefined || from === to) continue
        const pair = from.index < to.index ? `${from.index}:${to.index}` : `${to.index}:${from.index}`
        if (seenPair.has(pair)) continue
        seenPair.add(pair)
        adjacency[from.index].push(to.index)
        adjacency[to.index].push(from.index)
      }

      const count = real.length
      options.idealLength = idealLengthOf(real, options.idealLength)
      options.margin = marginOf(real, options.margin)
      const hops = hopDistances(adjacency)
      let maxHops = 1
      for (let i = 0; i < count; i++) {
        for (let j = 0; j < count; j++) {
          if (hops[i][j] > maxHops) maxHops = hops[i][j]
        }
      }
      // 不连通的两点按「比最远可达还远」处理：既不吸在一起，也不把画布撑爆。
      const unreachableHops = maxHops + 2
      const target = []
      const weight = []
      for (let i = 0; i < count; i++) {
        target.push(new Array(count).fill(0))
        weight.push(new Array(count).fill(0))
        for (let j = 0; j < count; j++) {
          if (i === j) continue
          const hop = hops[i][j] < 0 ? unreachableHops : hops[i][j]
          const distance = hop * options.idealLength
          target[i][j] = distance
          // w = d⁻²：近邻决定形状，远端只负责把视野撑开（论文推荐值）。
          weight[i][j] = 1 / (distance * distance)
        }
      }

      // 初值：优先用分层中心；没有就按顺序排在一个圆上，避免重合与除零。
      const initial = typeof input?.initial?.get === 'function' ? input.initial : null
      const circleRadius = Math.max(120, (options.idealLength * count) / (2 * Math.PI))
      const positions = []
      for (let i = 0; i < count; i++) {
        const seed = initial?.get(real[i].id)
        if (seed !== undefined && Number.isFinite(seed?.x) && Number.isFinite(seed?.y)) {
          positions.push({ x: seed.x, y: seed.y })
        } else {
          const angle = (2 * Math.PI * i) / count
          positions.push({ x: circleRadius * Math.cos(angle), y: circleRadius * Math.sin(angle) })
        }
      }
      unfoldCollinear(positions, circleRadius)

      // 初值的量级未必和目标距离一致：整体缩放到同一量级，能少迭代很多轮。
      // 夹住缩放区间，初值全部重合时不把浮点噪声放大成天文数字。
      let initialSum = 0
      let initialCount = 0
      let targetSum = 0
      let targetCount = 0
      for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
          initialSum += Math.hypot(positions[i].x - positions[j].x, positions[i].y - positions[j].y)
          initialCount++
          targetSum += target[i][j]
          targetCount++
        }
      }
      if (initialCount > 0 && targetCount > 0 && initialSum > 1e-6) {
        const scale = Math.min(4, Math.max(0.25, (targetSum / targetCount) / (initialSum / initialCount)))
        for (const position of positions) {
          position.x *= scale
          position.y *= scale
        }
      }

      // 局部应力优化：逐节点原地更新，应力单调下降，收敛靠相对下降量判断。
      let previousStress = null
      for (let sweep = 0; sweep < options.sweeps; sweep++) {
        for (let i = 0; i < count; i++) {
          let sumWeight = 0
          let sumX = 0
          let sumY = 0
          for (let j = 0; j < count; j++) {
            if (i === j) continue
            const w = weight[i][j]
            const distance = target[i][j]
            const dx = positions[i].x - positions[j].x
            const dy = positions[i].y - positions[j].y
            const length = Math.hypot(dx, dy)
            // 两点重合时方向未定义：用只依赖下标的固定单位向量，保证可复现。
            const ux = length > 1e-9
              ? dx / length
              : ((i + j) % 2 === 0 ? 1 : -1) * 0.7071067811865476
            const uy = length > 1e-9
              ? dy / length
              : ((i * 3 + j) % 2 === 0 ? 1 : -1) * 0.7071067811865476
            // w·d = d⁻¹，省掉一次乘法。
            const pull = 1 / distance
            sumWeight += w
            sumX += w * positions[j].x + pull * ux
            sumY += w * positions[j].y + pull * uy
          }
          if (sumWeight > 0) {
            positions[i].x = sumX / sumWeight
            positions[i].y = sumY / sumWeight
          }
        }
        const stress = stressOf(positions, target, weight)
        if (previousStress !== null && previousStress > 0
          && (previousStress - stress) / previousStress < options.tolerance) break
        previousStress = stress
      }

      // 长宽比归一放在去重叠之前：应力布局常把图拉成细长条（链条尤其明显），
      // 先按目标比例压扁/拉宽，再让去重叠去修被挤出来的重叠，比反过来更省位移。
      if (Number.isFinite(options.aspect) && options.aspect > 0) {
        normalizeAspect(real, positions, options.aspect)
      }
      removeOverlaps(real, positions, options)

      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let i = 0; i < count; i++) {
        minX = Math.min(minX, positions[i].x - real[i].width / 2)
        maxX = Math.max(maxX, positions[i].x + real[i].width / 2)
        minY = Math.min(minY, positions[i].y - real[i].height / 2)
        maxY = Math.max(maxY, positions[i].y + real[i].height / 2)
      }
      // 平移到 padding 起点，与分层引擎同一口径（画布左上角贴住 padding）。
      const offsetX = options.padding - minX
      const offsetY = options.padding - minY
      const nodes = real.map((node, index) => ({
        id: node.id,
        x: quantize(positions[index].x - node.width / 2 + offsetX),
        y: quantize(positions[index].y - node.height / 2 + offsetY),
        width: node.width,
        height: node.height,
      }))
      return {
        nodes,
        width: quantize(maxX - minX + options.padding * 2),
        height: quantize(maxY - minY + options.padding * 2),
      }
    }

    return { layoutStress }
  },
})
