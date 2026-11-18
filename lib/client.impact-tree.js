/**
 * 禁用预演的上下游关系树：纯计算，不碰 React。
 *
 * 为什么是树而不是三列清单：插件的依赖可以往下走很多层（一个服务有多个消费者，
 * 消费者又提供别的服务），扁平的「上游 / 目标 / 下游」清单表达不了层级，也容易
 * 把「第二层受影响」误读成「直接依赖」。这里按行 id 去重、按深度截断，环路只画
 * 一条回边，不重复展开。
 *
 * 图只做「谁依赖谁」与「谁覆盖谁」两种边；节点上的数量与状态由视图从快照补，
 * 不在模型里重复存一份。
 * @module dsh-plugin-console/client-impact-tree
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.impact-tree.js',
  factory: () => {
    /** 上游默认展示两层（目标 → 直接依赖 → 再下一层）；下游按 host 闭包完整展开。 */
    const DEFAULT_DEPTH = 2

    /** entryId / rowId 双向索引。 */
    function indexEntries(entries) {
      const byEntryId = new Map()
      const byRowId = new Map()
      for (const entry of entries) {
        byEntryId.set(entry.entryId, entry)
        const list = byRowId.get(entry.rowId) ?? []
        list.push(entry)
        byRowId.set(entry.rowId, list)
      }
      return { byEntryId, byRowId }
    }

    /** 节点展示名；快照里找不到条目时退回原始 id。 */
    function titleOf(entry, fallback) {
      if (entry === undefined) return String(fallback)
      return entry.title || entry.packageName || entry.moduleName || entry.entryId || String(fallback)
    }

    /** 树的最大深度（两侧各算一次）。 */
    function maxDepthOf(nodes) {
      let depth = 0
      for (const node of nodes) {
        depth = Math.max(depth, node.depth, maxDepthOf(node.children ?? []))
      }
      return depth
    }

    /**
     * 建关系树。
     *
     * @param {object} snapshot - 当前快照。
     * @param {object} target - `data.target`（至少含 rowId / entryId）。
     * @param {object} [options] - `{ depth, maxNodes, full, serviceOnly }`；`full` 表示上下游都递归到底。
     * @returns {{root: object | null, upstream: Array<object>, downstream: Array<object>, truncated: boolean, notes: string[]}} 关系树。
     */
    function buildRelationTree(snapshot, target, options = {}) {
      const full = options.full === true
      const depthLimit = full ? Infinity : Math.min(4, Math.max(1, Number.isInteger(options.depth) ? options.depth : DEFAULT_DEPTH))
      // 不传 maxNodes 表示不设总预算：下游必须能完整画出闭包里的每一个插件。
      // 显式传入时仍按旧口径截断，供需要的调用方保留概览模式。
      const maxNodes = Number.isInteger(options.maxNodes) ? Math.max(8, options.maxNodes) : Infinity
      const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : []
      const services = snapshot?.services ?? {}
      const index = indexEntries(entries)
      const rootEntry = target?.entryId === undefined ? undefined : index.byEntryId.get(target.entryId)
      if (rootEntry === undefined && (target?.rowId === undefined || target?.rowId === null)) {
        return { root: null, upstream: [], downstream: [], truncated: false, notes: ['找不到目标条目'] }
      }
      const rootId = target.rowId ?? rootEntry?.rowId
      const root = {
        key: 'root',
        rowId: rootId,
        entryId: target.entryId ?? rootEntry?.entryId,
        title: target.title ?? titleOf(rootEntry, rootId),
        moduleName: target.moduleName ?? rootEntry?.moduleName,
        side: 'root',
        depth: 0,
        edgeKind: null,
        edgeLabel: null,
        children: [],
      }
      const notes = []
      let count = 1
      let truncated = false
      let sequence = 0

      /** 新建节点；`again` 是「已经在上方出现过」的叶子。 */
      const makeNode = (entry, side, depth, edgeKind, edgeLabel, fallback, again) => {
        sequence++
        return {
          key: `${side}#${sequence}`,
          rowId: entry?.rowId ?? fallback,
          entryId: entry?.entryId ?? fallback,
          title: titleOf(entry, fallback),
          moduleName: entry?.moduleName ?? null,
          side,
          depth,
          edgeKind,
          edgeLabel,
          children: [],
          again: again === true,
        }
      }
      const canAdd = () => {
        if (count < maxNodes) return true
        truncated = true
        return false
      }

      /** 两侧各自去重：同一个行只画一次，避免 DAG 被摊成重复节点。 */
      const seenUp = new Set([rootId])
      const seenDown = new Set([rootId])

      /** 上游：目标需要的服务由谁提供，再顺着提供者的需求往上走。 */
      const walkUp = (entry, depth, ancestors) => {
        const children = []
        for (const service of entry?.requires ?? []) {
          for (const providerId of services[service]?.providers ?? []) {
            if (!canAdd()) return children
            const provider = index.byEntryId.get(providerId)
            const rowId = provider?.rowId ?? providerId
            if (ancestors.has(rowId)) {
              children.push(makeNode(provider, 'upstream', depth, 'service', service, rowId, true))
              count++
              continue
            }
            if (seenUp.has(rowId)) continue
            const node = makeNode(provider, 'upstream', depth, 'service', service, rowId, false)
            seenUp.add(rowId)
            count++
            children.push(node)
            if (depth < depthLimit) {
              node.children = walkUp(provider ?? { requires: [] }, depth + 1, new Set([...ancestors, rowId]))
            }
          }
        }
        return children
      }

      /** 下游：目标提供的服务被谁消费，再顺着消费者的提供项往下走。 */
      const walkDown = (entry, depth, ancestors) => {
        const children = []
        for (const service of entry?.provides ?? []) {
          for (const consumerId of services[service]?.consumers ?? []) {
            if (!canAdd()) return children
            const consumer = index.byEntryId.get(consumerId)
            const rowId = consumer?.rowId ?? consumerId
            if (ancestors.has(rowId)) {
              children.push(makeNode(consumer, 'downstream', depth, 'service', service, rowId, true))
              count++
              continue
            }
            if (seenDown.has(rowId)) continue
            const node = makeNode(consumer, 'downstream', depth, 'service', service, rowId, false)
            seenDown.add(rowId)
            count++
            children.push(node)
            if (depth < depthLimit) {
              node.children = walkDown(consumer ?? { provides: [] }, depth + 1, new Set([...ancestors, rowId]))
            }
          }
        }
        return children
      }

      const upstreamRoots = walkUp(rootEntry ?? { requires: target.requires ?? [] }, 1, new Set([rootId]))
      if (!full && upstreamRoots.length > 0) notes.push(`影响图聚焦与选定插件最相邻的插件以及下游插件`)
      const chainRows = full ? [] : (Array.isArray(options.chain?.blocked) ? options.chain.blocked : [])
      // 不传 chainDepth 表示下游不截断：用户要看到这次禁用波及的全部插件。
      const graphChainDepth = Number.isInteger(options.chainDepth) ? options.chainDepth : Infinity
      let downstreamRoots

      if (chainRows.length > 0) {
        // 完整依赖链模式：下游只画「真的会不可用」的条目，层级与路径都来自 host
        // 的闭包结果。分组子行是距离 0 的起点，先放进来，后续链路可以挂在它们下面。
        downstreamRoots = []
        const nodesById = new Map()
        for (const child of options.groupChildren ?? []) {
          if (!canAdd()) break
          const entry = index.byEntryId.get(child.entryId)
          const node = makeNode(
            entry ?? { rowId: child.rowId, entryId: child.entryId, title: child.title, moduleName: null },
            'downstream', 1, 'group-child', '同组子行', child.rowId, false,
          )
          node.entryId = child.entryId
          node.distance = 0
          count++
          downstreamRoots.push(node)
          nodesById.set(child.entryId, node)
        }
        let depthCut = false
        for (const row of chainRows) {
          if (row.distance > graphChainDepth) {
            depthCut = true
            break
          }
          if (!canAdd()) break
          const entry = index.byEntryId.get(row.entryId)
          const node = makeNode(
            entry ?? { rowId: row.rowId, entryId: row.entryId, title: row.title, moduleName: row.moduleName },
            'downstream', row.distance, 'blocked', row.causeService ?? '同组', row.rowId, false,
          )
          node.entryId = row.entryId
          node.blocked = true
          node.distance = row.distance
          node.missingServices = Array.isArray(row.missingServices) ? row.missingServices : []
          count++
          const parent = typeof row.viaEntryId === 'string' && row.viaEntryId !== root.entryId
            ? nodesById.get(row.viaEntryId)
            : undefined
          if (parent !== undefined) parent.children.push(node)
          else downstreamRoots.push(node)
          nodesById.set(row.entryId, node)
        }
        if (depthCut) notes.push(`链条较深：图只画到第 ${graphChainDepth} 层，完整链路见「影响链路」。`)
      } else {
        downstreamRoots = walkDown(rootEntry ?? { provides: target.provides ?? [] }, 1, new Set([rootId]))

        if (options.serviceOnly !== true) {
          // 配置引用：config 值里**完全等于**目标 id / 模块名 / 包名的行。
          // 不做子串匹配——那会把 `dsh-tool-a-extra` 误算成 `dsh-tool-a` 的引用。
          const identifiers = new Set(
            [target.rowId, target.entryId, target.moduleName, target.packageName].filter((name) => typeof name === 'string' && name !== ''),
          )
          for (const entry of entries) {
            if (entry.entryId === root.entryId) continue
            if (seenDown.has(entry.rowId)) continue
            const hit = (entry.configEntries ?? []).find((row) => identifiers.has(row.value))
            if (hit === undefined) continue
            if (!canAdd()) break
            count++
            seenDown.add(entry.rowId)
            downstreamRoots.push(makeNode(entry, 'downstream', 1, 'config-reference', hit.key, entry.rowId, false))
          }

          // 同组子行：按 Loader id 前缀推断；条件禁用与动态挂载可能不同，界面会写明。
          if (typeof root.entryId === 'string') {
            for (const entry of entries) {
              if (!entry.entryId.startsWith(root.entryId + ':')) continue
              if (seenDown.has(entry.rowId)) continue
              if (!canAdd()) break
              count++
              seenDown.add(entry.rowId)
              downstreamRoots.push(makeNode(entry, 'downstream', 1, 'group-child', '同组子行', entry.rowId, false))
            }
          }
        }
      }

      if (full) notes.push('完整链路按 provides/requires 声明展开')
      if (truncated) notes.push(`关系图最多展示 ${maxNodes} 个节点，其余上下游已省略。`)
      return { root, upstream: upstreamRoots, downstream: downstreamRoots, truncated, notes }
    }

    /**
     * 以选中节点为中心，递归展开完整的上下游依赖链。
     *
     * 与 {@link buildRelationTree} 的区别：不按受影响状态筛选下游，也不只看上游 2 层；
     * 两侧都沿 `provides` / `requires` 声明走到没有更多提供者或消费者为止。
     * @param {object} snapshot - 当前快照。
     * @param {object} target - `data.target`。
     * @param {object} [options] - 透传的选项。
     * @returns {object} 同 `buildRelationTree` 的树。
     */
    function buildFullChain(snapshot, target, options = {}) {
      return buildRelationTree(snapshot, target, { ...options, full: true, serviceOnly: true })
    }

    /**
     * 一条边：父节点在靠近目标的一侧，子节点在更外侧。
     *
     * 箭头统一表示「提供者 → 消费者」：下游是目标（或上游提供者）指向下游消费者；
     * 上游是更外侧的提供者指向靠近目标、需要该服务的消费者，所以上游箭头落在
     * 父节点一端，而不是继续朝外。
     */
    function edgeBetween(parent, child) {
      const upstream = child.side === 'upstream'
      const fromNode = upstream ? child : parent
      const toNode = upstream ? parent : child
      const fromX = fromNode.x + fromNode.width
      const toX = toNode.x
      const y1 = fromNode.y + fromNode.height / 2
      const y2 = toNode.y + toNode.height / 2
      const direction = Math.sign(toX - fromX) || 1
      const span = Math.max(20, Math.abs(toX - fromX) / 2)
      return {
        key: fromNode.key + '>' + toNode.key,
        fromKey: fromNode.key,
        toKey: toNode.key,
        kind: child.edgeKind,
        label: child.edgeLabel,
        d: `M${fromX} ${y1} C${fromX + direction * span} ${y1} ${toX - direction * span} ${y2} ${toX} ${y2}`,
        arrow: `${toX},${y2} ${toX - direction * 6},${y2 - 3.5} ${toX - direction * 6},${y2 + 3.5}`,
        labelX: (fromX + toX) / 2,
        labelY: (y1 + y2) / 2 - 5,
      }
    }

    /**
     * 估算一个字符占几格：汉字/全角按 2，其余按 1。
     * SVG 没有自动换行，只能按近似宽度自己折行。
     */
    function charWidth(char) {
      return /[⺀-鿿豈-﫿＀-￯]/.test(char) ? 2 : 1
    }

    /**
     * 按节点宽度折行，最多 `maxLines` 行，再长才省略。
     * 节点左右各留 10px；12px 字号下一个西文字符约 6.6px，约合 1 格。
     * @param {string} title - 插件名。
     * @param {number} maxLines - 最多显示几行。
     * @param {number} width - 节点宽度（px）。
     * @returns {string[]} 每行的文字。
     */
    function wrapGraphTitle(title, maxLines, width) {
      const perLine = Math.max(8, Math.floor((width - 20) / 6.6))
      const lines = []
      let line = ''
      let units = 0
      for (const char of String(title ?? '')) {
        const size = charWidth(char)
        if (line !== '' && units + size > perLine) {
          lines.push(line)
          line = ''
          units = 0
        }
        line += char
        units += size
      }
      if (line !== '') lines.push(line)
      if (lines.length <= maxLines) return lines
      // 超出最后一行的部分省略：给「…」留一格。
      let kept = ''
      let used = 0
      for (const char of lines[maxLines - 1]) {
        const size = charWidth(char)
        if (used + size > perLine - 2) break
        kept += char
        used += size
      }
      return [...lines.slice(0, maxLines - 1), kept + '…']
    }

    /**
     * 固定几何的树布局。
     *
     * 目标居中，上游向左侧按深度分列，下游向右侧分列；每侧按后序给叶子排 y，
     * 父节点取首末子节点的中点。没有力导向、没有随机数——同一份数据永远得到
     * 同一张图，便于眼动定位与自检。
     * @param {object} tree - `buildRelationTree()` 的结果。
     * @param {object} [options] - `{ nodeWidth, nodeHeight, gapX, gapY, padding }`。
     * @returns {{nodes: Array<object>, edges: Array<object>, width: number, height: number}} 布局。
     */
    function layoutRelationTree(tree, options = {}) {
      // 方块只放插件名（状态收进悬浮提示），所以把空间都给文字：两行名称、
      // 更宽的行宽。放大查看交给视图层的缩放，这里仍保持固定几何。
      const nodeWidth = options.nodeWidth ?? 240
      const nodeHeight = options.nodeHeight ?? 64
      const gapX = options.gapX ?? 96
      const gapY = options.gapY ?? 14
      const padding = options.padding ?? 8
      if (tree?.root === null || tree?.root === undefined) {
        return { nodes: [], edges: [], width: 0, height: 0 }
      }

      const upDepth = maxDepthOf(tree.upstream ?? [])
      const downDepth = maxDepthOf(tree.downstream ?? [])
      const rootX = padding + upDepth * (nodeWidth + gapX)
      const nodes = []
      const edges = []

      /** 递归排一侧；`cursor` 是对象，保证同一个引用在整棵树里累加。 */
      const assign = (node, side, cursor) => {
        const childLayouts = (node.children ?? []).map((child) => assign(child, side, cursor))
        let y
        if (childLayouts.length > 0) {
          y = (childLayouts[0].y + childLayouts[childLayouts.length - 1].y) / 2
        } else {
          y = padding + cursor.value * (nodeHeight + gapY)
          cursor.value++
        }
        const layout = {
          key: node.key,
          rowId: node.rowId,
          title: node.title,
          moduleName: node.moduleName,
          side,
          depth: node.depth,
          x: side === 'upstream' ? rootX - node.depth * (nodeWidth + gapX) : rootX + node.depth * (nodeWidth + gapX),
          y,
          width: nodeWidth,
          height: nodeHeight,
          edgeKind: node.edgeKind,
          edgeLabel: node.edgeLabel,
          again: node.again === true,
          blocked: node.blocked === true,
          missingServices: node.missingServices ?? [],
          distance: node.distance ?? node.depth,
          hasChildren: childLayouts.length > 0,
        }
        nodes.push(layout)
        for (const child of childLayouts) edges.push(edgeBetween(layout, child))
        return layout
      }

      const upCursor = { value: 0 }
      const downCursor = { value: 0 }
      const upstreamLayouts = (tree.upstream ?? []).map((node) => assign(node, 'upstream', upCursor))
      const downstreamLayouts = (tree.downstream ?? []).map((node) => assign(node, 'downstream', downCursor))

      const lowest = nodes.reduce((value, node) => Math.max(value, node.y), 0)
      const rootY = lowest === 0 ? padding : padding + (lowest - padding) / 2
      const root = {
        key: 'root',
        rowId: tree.root.rowId,
        title: tree.root.title,
        moduleName: tree.root.moduleName,
        side: 'root',
        depth: 0,
        x: rootX,
        y: rootY,
        width: nodeWidth,
        height: nodeHeight,
        edgeKind: null,
        edgeLabel: null,
        again: false,
        hasChildren: upstreamLayouts.length + downstreamLayouts.length > 0,
      }
      for (const layout of [...upstreamLayouts, ...downstreamLayouts]) edges.push(edgeBetween(root, layout))
      nodes.push(root)

      return {
        nodes,
        edges,
        width: rootX + downDepth * (nodeWidth + gapX) + nodeWidth + padding,
        height: Math.max(lowest, rootY) + nodeHeight + padding,
      }
    }

    /**
     * 摊平成节点列表；视图用它统计上下游客数与受阻节点数。
     * @param {object} tree - `buildRelationTree()` 的结果。
     * @returns {Array<object>} 深度优先的节点列表。
     */
    function flattenRelationTree(tree) {
      const rows = []
      if (tree?.root === null || tree?.root === undefined) return rows
      rows.push({
        key: 'root',
        rowId: tree.root.rowId,
        title: tree.root.title,
        side: 'root',
        depth: 0,
        edgeKind: null,
        edgeLabel: null,
        again: false,
        blocked: false,
        missingServices: [],
        distance: 0,
        hasChildren: (tree.upstream?.length ?? 0) + (tree.downstream?.length ?? 0) > 0,
      })
      const walk = (node) => {
        rows.push({
          key: node.key,
          rowId: node.rowId,
          title: node.title,
          side: node.side,
          depth: node.depth,
          edgeKind: node.edgeKind,
          edgeLabel: node.edgeLabel,
          again: node.again === true,
          blocked: node.blocked === true,
          missingServices: node.missingServices ?? [],
          distance: node.distance ?? node.depth,
          hasChildren: (node.children?.length ?? 0) > 0,
        })
        for (const child of node.children ?? []) walk(child)
      }
      for (const node of tree.upstream ?? []) walk(node)
      for (const node of tree.downstream ?? []) walk(node)
      return rows
    }

    return { buildRelationTree, buildFullChain, layoutRelationTree, flattenRelationTree, wrapGraphTitle }
  },
})
