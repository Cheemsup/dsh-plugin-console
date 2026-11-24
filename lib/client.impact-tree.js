/**
 * 禁用预演的上下游关系树：纯计算，不碰 React。
 *
 * 为什么是树而不是三列清单：插件的依赖可以往下走很多层（一个服务有多个消费者，
 * 消费者又提供别的服务），扁平的「上游 / 目标 / 下游」清单表达不了层级，也容易
 * 把「第二层受影响」误读成「直接依赖」。
 *
 * 两张图回答不同问题，模型也分开：
 * - 影响图只读 host 闭包（目标 + 随父行失效的子行 + 受阻条目），不画声明概览；
 * - 完整图沿 `provides` / `requires` 展开全部上下游，再把生成树丢掉的服务边作为
 *   cross edge 补回来，并附加子行边与 config 引用边。
 *
 * 节点身份统一为 `entryId`；`rowId` 只用于展示与点击跳转。几何全部交给
 * `client.graph-layout.js`（分层/排序/坐标）与 `client.graph-route.js`（正交走线）：
 * 上游在上、目标居中、下游在下，没有力导向与随机数，同一份数据永远得到同一张图。
 * @module dsh-plugin-console/client-impact-tree
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.impact-tree.js',
  factory: () => (deps) => {
    const graphLayout = deps?.graphLayout
    const graphRoute = deps?.graphRoute
    const graphNet = deps?.graphNet
    /** 上游默认展示两层（目标 → 直接依赖 → 再下一层）；下游按 host 闭包完整展开。 */
    const DEFAULT_DEPTH = 2

    /** 结构行（cordis:include / cordis:group）不进入插件关系图。 */
    function isStructural(entry) {
      return typeof entry?.moduleName === 'string' && entry.moduleName.startsWith('cordis:')
    }

    /** 行的父行 id：优先 Loader 给的 parentEntryId，缺省时按 id 路径推导。 */
    function parentOf(entry) {
      if (typeof entry?.parentEntryId === 'string') return entry.parentEntryId
      if (typeof entry?.entryId !== 'string') return null
      const index = entry.entryId.lastIndexOf(':')
      return index > 0 ? entry.entryId.slice(0, index) : null
    }

    /** entryId / rowId 双向索引，以及按父行分组的子行。 */
    function indexEntries(entries) {
      const byEntryId = new Map()
      const byRowId = new Map()
      const children = new Map()
      for (const entry of entries) {
        byEntryId.set(entry.entryId, entry)
        const list = byRowId.get(entry.rowId) ?? []
        list.push(entry)
        byRowId.set(entry.rowId, list)
        const parent = parentOf(entry)
        if (parent === null) continue
        const siblings = children.get(parent) ?? []
        siblings.push(entry)
        children.set(parent, siblings)
      }
      return { byEntryId, byRowId, children }
    }

    /** 节点展示名：组合行 id；快照里找不到条目时退回原始 id。 */
    function titleOf(entry, fallback) {
      if (entry === undefined) return String(fallback)
      return entry.rowId || entry.entryId || entry.title || entry.packageName || entry.moduleName || String(fallback)
    }

    /** 新建一个树节点；`again` 是「已经在上方出现过」的回边叶子。 */
    function makeNode(entry, side, depth, edgeKind, edgeLabel, fallback, again, prefix = '') {
      return {
        key: `${prefix}${side}#${fallback ?? entry?.entryId ?? 'unknown'}#${depth}#${edgeKind ?? 'none'}`,
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

    /**
     * 建服务声明关系树（完整图骨架 / 旧影响图）。
     *
     * @param {object} snapshot - 当前快照。
     * @param {object} target - `data.target`（至少含 rowId / entryId）。
     * @param {object} [options] - `{ depth, maxNodes, full, serviceOnly }`；`full` 表示上下游都递归到底。
     * @returns {{root: object | null, upstream: Array<object>, downstream: Array<object>, truncated: boolean, notes: string[]}} 关系树。
     */
    function buildRelationTree(snapshot, target, options = {}) {
      const full = options.full === true
      const depthLimit = full ? Infinity : Math.min(4, Math.max(1, Number.isInteger(options.depth) ? options.depth : DEFAULT_DEPTH))
      const maxNodes = Number.isInteger(options.maxNodes) ? Math.max(8, options.maxNodes) : Infinity
      const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : []
      const services = snapshot?.services ?? {}
      const index = indexEntries(entries)
      const rootEntry = target?.entryId === undefined ? undefined : index.byEntryId.get(target.entryId)
      if (rootEntry === undefined && (target?.rowId === undefined || target?.rowId === null)) {
        return { root: null, upstream: [], downstream: [], truncated: false, notes: ['找不到目标条目'] }
      }
      const rootId = target.rowId ?? rootEntry?.rowId
      const rootEntryId = target.entryId ?? rootEntry?.entryId ?? rootId
      const root = {
        key: 'root',
        rowId: rootId,
        entryId: rootEntryId,
        title: titleOf(rootEntry, target.rowId ?? target.title ?? rootId),
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
      const make = (entry, side, depth, edgeKind, edgeLabel, fallback, again) => {
        sequence++
        const node = makeNode(entry, side, depth, edgeKind, edgeLabel, fallback, again, `${sequence}:`)
        return node
      }
      const canAdd = () => {
        if (count < maxNodes) return true
        truncated = true
        return false
      }

      /** 两侧各自去重：同一个 entryId 只画一次，避免 DAG 被摊成重复节点。 */
      const seenUp = new Set([rootEntryId])
      const seenDown = new Set([rootEntryId])

      /** 上游：目标需要的服务由谁提供，再顺着提供者的需求往上走。 */
      const walkUp = (entry, depth, ancestors) => {
        const children = []
        for (const service of entry?.requires ?? []) {
          for (const providerId of services[service]?.providers ?? []) {
            if (!canAdd()) return children
            const provider = index.byEntryId.get(providerId)
            const key = provider?.entryId ?? providerId
            if (ancestors.has(key)) {
              children.push(make(provider, 'upstream', depth, 'service', service, provider?.rowId ?? providerId, true))
              count++
              continue
            }
            if (seenUp.has(key)) continue
            const node = make(provider, 'upstream', depth, 'service', service, provider?.rowId ?? providerId, false)
            seenUp.add(key)
            count++
            children.push(node)
            if (depth < depthLimit) {
              node.children = walkUp(provider ?? { requires: [] }, depth + 1, new Set([...ancestors, key]))
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
            const key = consumer?.entryId ?? consumerId
            if (ancestors.has(key)) {
              children.push(make(consumer, 'downstream', depth, 'service', service, consumer?.rowId ?? consumerId, true))
              count++
              continue
            }
            if (seenDown.has(key)) continue
            const node = make(consumer, 'downstream', depth, 'service', service, consumer?.rowId ?? consumerId, false)
            seenDown.add(key)
            count++
            children.push(node)
            if (depth < depthLimit) {
              node.children = walkDown(consumer ?? { provides: [] }, depth + 1, new Set([...ancestors, key]))
            }
          }
        }
        return children
      }

      const upstreamRoots = walkUp(rootEntry ?? { requires: target.requires ?? [] }, 1, new Set([rootEntryId]))
      if (!full && upstreamRoots.length > 0) notes.push('影响图聚焦与选定插件最相邻的插件以及下游插件')
      const chainRows = full ? [] : (Array.isArray(options.chain?.blocked) ? options.chain.blocked : [])
      const graphChainDepth = Number.isInteger(options.chainDepth) ? options.chainDepth : Infinity
      let downstreamRoots

      if (chainRows.length > 0) {
        // 旧的影响链模式：下游只画「真的会不可用」的条目。新代码走 buildImpactGraph，
        // 这里保留给旧的调用方与自检。
        downstreamRoots = []
        const nodesById = new Map()
        for (const child of options.groupChildren ?? []) {
          if (!canAdd()) break
          const entry = index.byEntryId.get(child.entryId)
          const node = make(
            entry ?? { rowId: child.rowId, entryId: child.entryId, title: child.title, moduleName: null },
            'downstream', 1, 'group-child', '子行', child.rowId, false,
          )
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
          if (nodesById.has(row.entryId)) continue
          const entry = index.byEntryId.get(row.entryId)
          const node = make(
            entry ?? { rowId: row.rowId, entryId: row.entryId, title: row.title, moduleName: row.moduleName },
            'downstream', row.distance, row.causedByParent === true ? 'group-child' : 'service',
            row.causedByParent === true ? '随父行' : (row.causeService ?? '服务'), row.rowId, false,
          )
          node.blocked = row.causedByParent !== true
          node.causedByParent = row.causedByParent === true
          node.distance = row.distance
          node.missingServices = Array.isArray(row.missingServices) ? row.missingServices : []
          count++
          const parent = typeof row.viaEntryId === 'string' && row.viaEntryId !== rootEntryId
            ? nodesById.get(row.viaEntryId)
            : undefined
          if (parent !== undefined) parent.children.push(node)
          else downstreamRoots.push(node)
          nodesById.set(row.entryId, node)
        }
        if (depthCut) notes.push(`链条较深：图只画到第 ${graphChainDepth} 层，完整链路见「影响链路」。`)
      } else {
        downstreamRoots = walkDown(rootEntry ?? { provides: target.provides ?? [] }, 1, new Set([rootEntryId]))

        if (options.serviceOnly !== true) {
          // 配置引用：config 值里**完全等于**目标 id / 模块名 / 包名的行。
          // 不做子串匹配——那会把 `dsh-tool-a-extra` 误算成 `dsh-tool-a` 的引用。
          const identifiers = new Set(
            [target.rowId, target.entryId, target.moduleName, target.packageName].filter((name) => typeof name === 'string' && name !== ''),
          )
          for (const entry of entries) {
            if (entry.entryId === rootEntryId) continue
            if (seenDown.has(entry.entryId)) continue
            const hit = (entry.configEntries ?? []).find((row) => identifiers.has(row.value))
            if (hit === undefined) continue
            if (!canAdd()) break
            count++
            seenDown.add(entry.entryId)
            downstreamRoots.push(make(entry, 'downstream', 1, 'config-reference', hit.key, entry.rowId, false))
          }

          // 子行：按 Loader id 前缀推断；条件禁用与动态挂载可能不同，界面会写明。
          if (typeof rootEntryId === 'string') {
            for (const entry of entries) {
              if (!entry.entryId.startsWith(rootEntryId + ':')) continue
              if (seenDown.has(entry.entryId)) continue
              if (isStructural(entry)) continue
              if (!canAdd()) break
              count++
              seenDown.add(entry.entryId)
              downstreamRoots.push(make(entry, 'downstream', 1, 'group-child', '子行', entry.rowId, false))
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
     * @param {object} snapshot - 当前快照。
     * @param {object} target - `data.target`。
     * @param {object} [options] - 透传的选项。
     * @returns {object} 同 `buildRelationTree` 的树。
     */
    function buildFullChain(snapshot, target, options = {}) {
      return buildRelationTree(snapshot, target, { ...options, full: true, serviceOnly: true })
    }

    /** 收集树里的全部节点与父节点，供完整图补边使用。 */
    function collectTreeNodes(tree) {
      const rows = [{ node: tree.root, parent: null, side: 'root' }]
      const walk = (node, parent, side) => {
        rows.push({ node, parent, side })
        for (const child of node.children ?? []) walk(child, node, side)
      }
      for (const node of tree.upstream ?? []) walk(node, tree.root, 'upstream')
      for (const node of tree.downstream ?? []) walk(node, tree.root, 'downstream')
      return rows
    }

    /**
     * 完整图：服务声明骨架 + 子行 + config 引用 + cross edge。
     *
     * 生成树仍然是布局骨架；被 `seen*` 丢掉的服务边不会消失，而是作为 cross edge
     * 补回来。箭头统一「提供者 → 消费者」。
     * @param {object} snapshot - 当前快照（`data.graph`）。
     * @param {object} target - `data.target`。
     * @returns {object} 关系树，额外带 `crossEdges`。
     */
    function buildFullRelationGraph(snapshot, target) {
      const tree = buildRelationTree(snapshot, target, { full: true, serviceOnly: true })
      if (tree.root === null) return tree
      const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : []
      const services = snapshot?.services ?? {}
      const index = indexEntries(entries)
      const root = tree.root
      const notes = [...tree.notes]
      const crossEdges = []
      const crossSeen = new Set()
      let count = collectTreeNodes(tree).length

      /** 树上已经存在的有向边；cross edge 只补这些之外的边。 */
      const treeEdges = new Set()
      for (const { node, parent, side } of collectTreeNodes(tree)) {
        if (parent === null || typeof node.entryId !== 'string' || typeof parent.entryId !== 'string') continue
        const from = side === 'upstream' ? node.entryId : parent.entryId
        const to = side === 'upstream' ? parent.entryId : node.entryId
        treeEdges.add(`${from}>${to}`)
      }

      /** 已展示的节点：entryId → 节点；同一条目只取第一次出现的位置。 */
      const displayed = new Map()
      for (const { node } of collectTreeNodes(tree)) {
        if (typeof node.entryId !== 'string' || displayed.has(node.entryId)) continue
        displayed.set(node.entryId, node)
      }

      const addCross = (fromEntryId, toEntryId, kind, label) => {
        if (fromEntryId === toEntryId) return
        const key = `${fromEntryId}>${toEntryId}:${kind}`
        if (treeEdges.has(`${fromEntryId}>${toEntryId}`) || crossSeen.has(key)) return
        crossSeen.add(key)
        crossEdges.push({ fromEntryId, toEntryId, kind, label })
      }

      /**
       * 子行：只从目标与下游节点向下展开，并沿父链递归。
       *
       * 上游提供者的子行不影响「目标依赖谁」，把它们塞进右侧又会让箭头方向失真，
       * 所以完整图只展开目标这一侧的嵌套结构。
       */
      const addChildren = (parentNode) => {
        const children = index.children.get(parentNode.entryId) ?? []
        for (const child of children) {
          if (isStructural(child)) continue
          const existing = displayed.get(child.entryId)
          if (existing !== undefined) {
            addCross(parentNode.entryId, existing.entryId, 'group-child', '子行')
            continue
          }
          const node = makeNode(child, 'downstream', parentNode.depth + 1, 'group-child', '子行', child.rowId, false, `${count}:`)
          node.causedByParent = true
          node.distance = parentNode.depth + 1
          if (parentNode === root) tree.downstream.push(node)
          else parentNode.children.push(node)
          treeEdges.add(`${parentNode.entryId}>${child.entryId}`)
          displayed.set(child.entryId, node)
          count++
          addChildren(node)
        }
      }
      addChildren(root)
      for (const { node, side } of collectTreeNodes(tree)) {
        if (side === 'downstream') addChildren(node)
      }

      // config 引用：只认与目标标识**完全相等**的值，不扩展成任意节点对。
      const identifiers = new Set(
        [target?.rowId, target?.entryId, target?.moduleName, target?.packageName]
          .filter((name) => typeof name === 'string' && name !== ''),
      )
      for (const entry of entries) {
        if (entry.entryId === root.entryId || isStructural(entry)) continue
        const hit = (entry.configEntries ?? []).find((row) => identifiers.has(row.value))
        if (hit === undefined) continue
        const existing = displayed.get(entry.entryId)
        if (existing !== undefined) {
          addCross(root.entryId, existing.entryId, 'config-reference', hit.key)
          continue
        }
        const node = makeNode(entry, 'downstream', 1, 'config-reference', hit.key, entry.rowId, false, `${count}:`)
        tree.downstream.push(node)
        treeEdges.add(`${root.entryId}>${entry.entryId}`)
        displayed.set(entry.entryId, node)
        count++
      }

      // 服务边全量：已展示节点之间、生成树之外的所有「提供者 → 消费者」。
      for (const [name, record] of Object.entries(services)) {
        const providers = (record?.providers ?? []).filter((id) => displayed.has(id))
        if (providers.length === 0) continue
        const consumers = (record?.consumers ?? []).filter((id) => displayed.has(id))
        for (const provider of providers) {
          for (const consumer of consumers) {
            addCross(provider, consumer, 'cross', name)
          }
        }
      }

      notes.push('实线＝服务依赖 · 短虚线＝子行 · 点线＝config 引用（推断） · 长虚线＝同一批声明里的另一条路径')
      return { ...tree, crossEdges, notes }
    }

    /**
     * 影响图：严格来自 host 闭包，只展示确定不可用的条目。
     *
     * 不调用 `walkUp` / `walkDown`，不读 config 引用；没有可展示的影响时只返回根，
     * 由视图显示空态并指向完整图。
     * @param {object} snapshot - 当前快照（`data.graph`）。
     * @param {object} data - 禁用预演响应（含 `target` / `descendants` / `chain`）。
     * @returns {object} 关系树，`crossEdges` 固定为空。
     */
    function buildImpactGraph(snapshot, data) {
      const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : []
      const index = indexEntries(entries)
      const target = data?.target ?? {}
      const rootEntry = index.byEntryId.get(target.entryId)
      if (target.rowId === undefined && target.entryId === undefined) {
        return { root: null, upstream: [], downstream: [], truncated: false, notes: ['找不到目标条目'], crossEdges: [] }
      }
      const rootId = target.rowId ?? rootEntry?.rowId
      const root = {
        key: 'root',
        rowId: rootId,
        entryId: target.entryId ?? rootEntry?.entryId,
        title: titleOf(rootEntry, target.title ?? rootId),
        moduleName: target.moduleName ?? rootEntry?.moduleName,
        side: 'root',
        depth: 0,
        edgeKind: null,
        edgeLabel: null,
        children: [],
      }
      const descendants = Array.isArray(data?.descendants) ? data.descendants : []
      const chainRows = Array.isArray(data?.chain?.blocked) ? data.chain.blocked : []
      const byParent = new Map()
      for (const row of descendants) {
        const parent = typeof row.parentEntryId === 'string' ? row.parentEntryId : parentOf(row)
        if (parent === null) continue
        const list = byParent.get(parent) ?? []
        list.push(row)
        byParent.set(parent, list)
      }
      const nodesById = new Map()
      let sequence = 0
      const make = (entry, depth, edgeKind, edgeLabel, fallback) => {
        sequence++
        return makeNode(entry, 'downstream', depth, edgeKind, edgeLabel, fallback, false, `impact${sequence}:`)
      }
      const attachDescendants = (parentNode) => {
        for (const row of byParent.get(parentNode.entryId) ?? []) {
          if (nodesById.has(row.entryId)) continue
          const entry = index.byEntryId.get(row.entryId) ?? {
            rowId: row.rowId, entryId: row.entryId, title: row.title, moduleName: null,
          }
          const node = make(entry, parentNode.depth + 1, 'group-child', '子行', row.rowId)
          node.distance = 0
          node.causedByParent = true
          parentNode.children.push(node)
          nodesById.set(row.entryId, node)
          attachDescendants(node)
        }
      }
      attachDescendants(root)

      const sorted = chainRows
        .slice()
        .sort((left, right) => (left.distance ?? 0) - (right.distance ?? 0))
      for (const row of sorted) {
        if (nodesById.has(row.entryId)) continue
        const entry = index.byEntryId.get(row.entryId) ?? {
          rowId: row.rowId, entryId: row.entryId, title: row.title, moduleName: row.moduleName,
        }
        const parent = row.viaEntryId === root.entryId
          ? root
          : (nodesById.get(row.viaEntryId) ?? root)
        const causedByParent = row.causedByParent === true
        const node = make(
          entry,
          parent.depth + 1,
          causedByParent ? 'group-child' : 'service',
          causedByParent ? '随父行' : (row.causeService ?? '服务'),
          row.rowId,
        )
        node.blocked = !causedByParent
        node.causedByParent = causedByParent
        node.distance = row.distance ?? parent.depth + 1
        node.missingServices = Array.isArray(row.missingServices) ? row.missingServices : []
        parent.children.push(node)
        nodesById.set(row.entryId, node)
      }

      const notes = []
      if (root.children.length === 0) notes.push('没有插件会因为这次禁用失去必需服务')
      notes.push('只展示禁用并重载/重启后确定不可用的条目；上游与 config 引用见完整链路图')
      return { root, upstream: [], downstream: root.children, truncated: false, notes, crossEdges: [] }
    }

    /**
     * 估算一个字符占几格：汉字/全角按 2，其余按 1。
     * SVG 没有自动换行，只能按近似宽度自己折行。
     */
    function charWidth(char) {
      return /[⺀-鿿豈-﫿＀-￯]/.test(char) ? 2 : 1
    }

    /**
     * 节点宽度：按标题的显示宽度算，夹在 [160, 280] 之间。
     *
     * 12px 字号下一个西文字符约 6.6px、汉字约 13px；左右各留 10px 内边距。
     * 太窄会让两行装不下、太宽会让一行短名字留一片空白，所以上下都设了界。
     * @param {string} title - 插件名。
     * @returns {number} 节点宽度（px）。
     */
    function graphNodeWidth(title) {
      let units = 0
      for (const char of String(title ?? '')) units += charWidth(char)
      const text = units * 6.9
      return Math.round(Math.min(280, Math.max(160, text + 24)))
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
     * 分层 DAG 布局。
     *
     * 数据 → 引擎 → 走线：先把树的父子边与 cross edge 合成一张有向图（节点身份仍是
     * `entryId`），交给 `client.graph-layout.js` 排层与布点，再交给
     * `client.graph-route.js` 走成正交折线。这里只做适配，不写几何。
     *
     * 节点高度由标题折行数决定（一行 48、两行 64）：方块高度跟着文字走，短名字不再
     * 留一大片空白，长名字也不会被压成两行贴边。
     * @param {object} tree - `buildImpactGraph()` / `buildFullRelationGraph()` 的结果。
     * @param {object} [options] - `{ layout: 'layered' | 'net' }`；缺省分层。
     * @returns {{nodes: Array<object>, edges: Array<object>, crossEdges: Array<object>, width: number, height: number}} 布局。
     */
    function layoutRelationTree(tree, options) {
      if (tree?.root === null || tree?.root === undefined) {
        return {
          nodes: [], edges: [], crossEdges: [], width: 0, height: 0,
        }
      }
      const model = graphModelOf(tree)
      return options?.layout === 'net'
        ? layoutNet(model, tree)
        : layoutLayeredGraph(model, tree)
    }

    /**
     * 树 → 与几何无关的图模型：节点、量好的宽高、去重后的有向边。
     *
     * 两种几何（分层 / 网状）拿的是**同一份**模型——节点集合与连边集合完全一致，
     * 这是「换布局不换关系」能成立的前提，也是自检里最重要的那条断言。
     * @param {object} tree - 关系树。
     * @returns {object} `{ nodes, linesOf, heightOf, graphEdges, nodeByIdentity }`。
     */
    function graphModelOf(tree) {
      // 收集节点：DFS 序就是模型序（同一提供者的消费者天然相邻），排序阶段直接用它。
      const records = collectTreeNodes(tree)
      const nodes = []
      const nodeByIdentity = new Map()
      const seen = new Set()
      for (const { node } of records) {
        if (node === null || node === undefined || seen.has(node.key)) continue
        seen.add(node.key)
        nodes.push(node)
        const identity = typeof node.entryId === 'string'
          ? node.entryId
          : (typeof node.rowId === 'string' ? node.rowId : node.key)
        if (!nodeByIdentity.has(identity)) nodeByIdentity.set(identity, node)
      }

      // 宽度与折行一起定：宽度跟着标题长度走，短名字不留一大片空白，长名字仍最多两行。
      // 节点等宽会把 9 个短名插件撑到 1600px 宽，缩放到视口后字就被压没了。
      const linesOf = new Map()
      const heightOf = new Map()
      for (const node of nodes) {
        const lines = wrapGraphTitle(node.title, 2, graphNodeWidth(node.title))
        linesOf.set(node.key, lines)
        heightOf.set(node.key, lines.length > 1 ? 64 : 48)
      }

      // 合成图：树边统一成「提供者 → 消费者」，cross edge 只补生成树之外的声明路径。
      const graphEdges = []
      const pairSeen = new Set()
      const pushEdge = (from, to, kind, label, cross) => {
        if (from === undefined || to === undefined || from.key === to.key) return
        const pair = `${from.key}>${to.key}`
        if (pairSeen.has(pair)) return
        pairSeen.add(pair)
        graphEdges.push({
          id: `${pair}:${kind ?? 'service'}`,
          from,
          to,
          kind: kind ?? 'service',
          label,
          cross: cross === true,
        })
      }
      for (const { node, parent, side } of records) {
        if (node === null || parent === null) continue
        if (side === 'upstream') pushEdge(node, parent, node.edgeKind, node.edgeLabel, false)
        else pushEdge(parent, node, node.edgeKind, node.edgeLabel, false)
      }
      for (const edge of Array.isArray(tree.crossEdges) ? tree.crossEdges : []) {
        pushEdge(
          nodeByIdentity.get(edge.fromEntryId),
          nodeByIdentity.get(edge.toEntryId),
          edge.kind,
          edge.label,
          true,
        )
      }
      return { nodes, linesOf, heightOf, graphEdges, nodeByIdentity }
    }

    /** 两种几何共用的输入：节点尺寸与边。 */
    function engineInput(model) {
      return {
        nodes: model.nodes.map((node, index) => ({
          id: node.key,
          width: graphNodeWidth(node.title),
          height: model.heightOf.get(node.key),
          order: index,
        })),
        edges: model.graphEdges.map((edge) => ({
          id: edge.id,
          from: edge.from.key,
          to: edge.to.key,
          label: edge.label,
        })),
      }
    }

    /**
     * 合并：把引擎给出的坐标与走线还原成渲染器认识的节点行与边行。
     *
     * 两种几何输出的行形状必须一致，否则视图与自检会按布局分叉。`rank` 在网状下
     * 仍然取分层结果（它表示「离目标几层」，与摆法无关）。
     */
    function decorate(model, layout, routes, ranks) {
      const boxById = new Map(layout.nodes.map((box) => [box.id, box]))
      const routeById = new Map(routes.map((route) => [route.id, route]))
      const outputNodes = []
      for (const node of model.nodes) {
        const box = boxById.get(node.key)
        if (box === undefined) continue
        outputNodes.push({
          key: node.key,
          rowId: node.rowId,
          entryId: node.entryId,
          title: node.title,
          moduleName: node.moduleName,
          side: node.side,
          rank: ranks.get(node.key) ?? 0,
          depth: node.depth,
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          lines: model.linesOf.get(node.key),
          edgeKind: node.edgeKind,
          edgeLabel: node.edgeLabel,
          again: node.again === true,
          blocked: node.blocked === true,
          causedByParent: node.causedByParent === true,
          missingServices: node.missingServices ?? [],
          distance: node.distance ?? node.depth,
          hasChildren: (node.children ?? []).length > 0,
        })
      }
      const edges = []
      const crossEdges = []
      for (const edge of model.graphEdges) {
        const route = routeById.get(edge.id)
        if (route === undefined) continue
        const row = {
          key: edge.id,
          fromKey: edge.from.key,
          toKey: edge.to.key,
          kind: edge.kind,
          // `label` 是真正画出来的文字（文字处线已断开）；`fullLabel` 始终是边自身的
          // 语义标签，供悬浮说明使用。
          label: route.label,
          fullLabel: edge.label,
          d: route.d,
          arrow: route.arrow,
          labelX: route.labelX,
          labelY: route.labelY,
          // 曲线走线用底色块压住文字（分层是断线填字，这里没有 `labelBg`）。
          labelBg: route.labelBg ?? null,
          points: route.points,
          back: route.back === true,
        }
        if (edge.cross) crossEdges.push(row)
        else edges.push(row)
      }
      return { nodes: outputNodes, edges, crossEdges, width: layout.width, height: layout.height }
    }

    /** 分层几何：原路径，行为与输出逐字节不变。 */
    function layoutLayeredGraph(model, tree) {
      const input = engineInput(model)
      const layout = graphLayout.layoutLayered({ ...input, rootId: tree.root.key })
      const labels = new Map()
      for (const edge of model.graphEdges) {
        if (edge.label === undefined || edge.label === null || edge.label === '') continue
        labels.set(edge.id, edge.label)
      }
      const routed = graphRoute.routeEdges(layout, labels)
      const ranks = new Map(layout.nodes.map((box) => [box.id, box.layer]))
      return decorate(model, layout, routed.edges, ranks)
    }

    /**
     * 网状几何：先分层拿初值与秩，再用应力优化松弛成网。
     *
     * 分层结果在这里有两个用途：`rank`（离目标几层，与摆法无关）与应力优化的初值。
     * 用分层当起点比按顺序摆圆环稳定得多，也省掉了随机数。
     */
    function layoutNet(model, tree) {
      if (typeof graphNet?.layoutStress !== 'function') return layoutLayeredGraph(model, tree)
      const input = engineInput(model)
      const layered = graphLayout.layoutLayered({ ...input, rootId: tree.root.key })
      const ranks = new Map(layered.nodes.map((box) => [box.id, box.layer]))
      const initial = new Map(layered.nodes.map((box) => [
        box.id,
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      ]))
      const layout = graphNet.layoutStress({ ...input, initial })
      const routed = graphRoute.routeCurves(layout.nodes, input.edges)
      return decorate(model, layout, routed, ranks)
    }

    /**
     * 摊平成节点列表；视图用它统计上下游客数与受阻节点数。
     * @param {object} tree - `buildImpactGraph()` / `buildFullRelationGraph()` 的结果。
     * @returns {Array<object>} 深度优先的节点列表。
     */
    function flattenRelationTree(tree) {
      const rows = []
      if (tree?.root === null || tree?.root === undefined) return rows
      rows.push({
        key: 'root',
        rowId: tree.root.rowId,
        entryId: tree.root.entryId,
        title: tree.root.title,
        side: 'root',
        depth: 0,
        edgeKind: null,
        edgeLabel: null,
        again: false,
        blocked: false,
        causedByParent: false,
        missingServices: [],
        distance: 0,
        hasChildren: (tree.upstream?.length ?? 0) + (tree.downstream?.length ?? 0) > 0,
      })
      const walk = (node) => {
        rows.push({
          key: node.key,
          rowId: node.rowId,
          entryId: node.entryId,
          title: node.title,
          side: node.side,
          depth: node.depth,
          edgeKind: node.edgeKind,
          edgeLabel: node.edgeLabel,
          again: node.again === true,
          blocked: node.blocked === true,
          causedByParent: node.causedByParent === true,
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

    return {
      buildRelationTree,
      buildFullChain,
      buildFullRelationGraph,
      buildImpactGraph,
      layoutRelationTree,
      flattenRelationTree,
      wrapGraphTitle,
      graphNodeWidth,
    }
  },
})
