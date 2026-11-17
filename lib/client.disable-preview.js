/**
 * 「插件禁用预演」页：被禁用的插件、连锁反应、依赖关系图、配置与覆盖。
 *
 * 页面正文只回答两个问题：被禁用的是谁；禁用后失去了哪些工具与提示词（含下游连带贡献），
 * 以及哪些下游插件会跟着不可用。依赖图与配置分层收在后面的独立区块里。
 *
 * 数据只来自两处：快照（插件、服务、工具、会话）与 `disable-preview` 路由
 * （级联影响 + 逐层 config + 诊断）。页面本身**不执行任何写操作**，也不猜测
 * 合并语义——「生效配置里没有」与「值与某层不同」是事实，原因属于推断。
 *
 * 关系图用固定几何的树布局（`client.impact-tree.js`），下面始终保留一份可
 * 折叠的文字明细，供窄屏、无图形环境与自检使用。
 * @module dsh-plugin-console/client-disable-preview
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.disable-preview.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, Fragment, useCallback, useRef, useState } = React

    return function create(deps) {
      const {
        activateOnKey,
        DISABLE_PREVIEW_ROUTE,
        fact,
        fetchJson,
        formatSessionId,
        rowEnd,
        search,
        selectField,
        shortName,
        textButton,
        impactTree,
      } = deps

      /** 证据级别 → 界面说法；与 README 的「数据可信度」保持同一套词。 */
      const EVIDENCE_LABELS = {
        runtime: '运行时事实',
        file: '文件事实',
        source: '源码扫描',
        inference: '推断',
        unknown: '未知',
      }

      /** 诊断的严重度 → 标签文案。 */
      const SEVERITY_LABELS = { warn: '警告', info: '提示' }

      /** 一个状态标签；`tone` 走 `.ptTag` 的四档。 */
      function tag(text, tone, title) {
        return h('span', { className: 'ptTag', 'data-tone': tone, title }, text)
      }

      /** 图表/节点里的定长截断；不改变数据，只影响文本节点。 */
      function clip(text, limit) {
        const value = typeof text === 'string' ? text : String(text ?? '')
        return value.length > limit ? value.slice(0, limit - 1) + '…' : value
      }

      /** 顶层区块下的子块：左侧竖线 + 降一级标题，避免把每个子问题都升成顶级标题。 */
      function subBlock(title, children) {
        return h(
          'div',
          { className: 'ptSubBlocks' },
          h('p', { className: 'ptSubTitle' }, title),
          children,
        )
      }

      /**
       * 禁用预演的状态。
       *
       * 每次请求带一个 ticket：快速切换目标时只有最后一次响应能落进状态，
       * 避免旧目标的影响面盖住新目标。失败不自动重试，交给页面上的「重试」。
       * @returns {object} `{rowId, data, status, error, choose, reload}`。
       */
      function useDisablePreviewStore() {
        const [rowId, setRowId] = useState(null)
        const [data, setData] = useState(null)
        const [status, setStatus] = useState('idle')
        const [error, setError] = useState(null)
        const ticket = useRef(0)
        const current = useRef(null)

        const load = useCallback(async (target) => {
          const id = typeof target === 'string' ? target : current.current
          if (typeof id !== 'string' || id === '') return
          current.current = id
          const mine = ++ticket.current
          setStatus('loading')
          setError(null)
          try {
            const encoded = typeof encodeURIComponent === 'function' ? encodeURIComponent(id) : id
            const next = await fetchJson(DISABLE_PREVIEW_ROUTE + '?id=' + encoded)
            if (mine !== ticket.current) return
            setData(next)
            setStatus('ready')
          } catch (cause) {
            if (mine !== ticket.current) return
            setError(cause instanceof Error ? cause.message : String(cause))
            setStatus('error')
          }
        }, [fetchJson])

        /** 选择目标；传空表示回到未选择状态。 */
        const choose = useCallback((id) => {
          if (typeof id !== 'string' || id === '') {
            current.current = null
            ticket.current++
            setRowId(null)
            setData(null)
            setStatus('idle')
            setError(null)
            return
          }
          current.current = id
          setRowId(id)
          setData(null)
          void load(id)
        }, [load])

        const reload = useCallback(() => {
          void load(current.current)
        }, [load])

        return { rowId, data, status, error, choose, reload }
      }

      /**
       * 页头工具条：插件选择器 + 重新加载。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderDisablePreviewFilters(vc) {
        const { entries, disablePreview } = vc
        const options = [
          { value: '', label: '选择插件…' },
          ...(entries ?? [])
            .slice()
            .sort((left, right) => shortName(left).localeCompare(shortName(right), 'zh-CN'))
            .map((entry) => ({
              value: entry.rowId,
              label: shortName(entry) + (entry.isGroup ? '（分组）' : entry.modeOnly ? '（模式专属）' : ''),
            })),
        ]
        return h(
          Fragment,
          null,
          selectField('选择禁用插件', disablePreview.rowId ?? '', options, (value) => disablePreview.choose(value), {
            title: '选择要预演禁用的插件；分组行会按 Loader 层级带出子行',
          }),
          textButton('重新加载', () => disablePreview.reload(), {
            disabled: disablePreview.rowId === null || disablePreview.status === 'loading',
            title: '按当前快照重新计算',
          }),
        )
      }

      /** 「连锁反应」的摘要：只回答失去多少、波及谁，明细放在下面的子块里。 */
      function renderReactionSummary(data) {
        const { scale } = data
        return h(
          'dl',
          { className: 'ptFacts' },
          fact('失去工具', scale.lostTools === 0 ? '无' : `${scale.lostTools}${scale.lostToolsViaChain > 0 ? `（其中链路 ${scale.lostToolsViaChain}）` : ''}`),
          fact('失去提示词', scale.lostSections + scale.lostContexts === 0 ? '无' : `段 ${scale.lostSections} · 上下文 ${scale.lostContexts}`),
          fact('受影响的下游插件', scale.blockedEntries === 0 ? '无' : `${scale.blockedEntries} 个 · 最深第 ${scale.chainDepth} 层`),
          fact('影响范围', `模式 ${scale.modes} · 活会话 ${scale.liveSessions} · 冷会话 ${scale.coldSessionCount}`),
          fact('生效', data.hmr === true ? 'HMR 可用，可能立即生效' : '未检测到 HMR；可能需要重启'),
        )
      }

      /** 一组名字：失去 / 共享 / 未归属各一段；未归属不并入失去。 */
      function renderNameGroup(title, bucket, options) {
        const rows = bucket.rows ?? []
        const sections = [
          { key: 'lost', label: '失去' },
          { key: 'shared', label: '共享' },
          { key: 'unknown', label: '未归属' },
        ]
        const counts = sections.map((group) => rows.filter((row) => row[group.key] === true).length)
        const nodes = []
        for (const group of sections) {
          const list = rows.filter((row) => row[group.key] === true)
          if (list.length === 0) continue
          nodes.push(
            h('p', { key: group.key, className: 'ptSub', style: { margin: 0 } }, `${group.label}（${list.length}）`),
            h(
              'ul',
              { key: group.key + ':list', className: 'ptDepList' },
              list.map((row) => h(
                'li',
                { key: group.key + ':' + row.name },
                options.onOpen === undefined
                  ? h('span', { className: 'ptDepKey' }, row.name)
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'ptTag ptLink',
                        title: options.openTitle,
                        onClick: () => options.onOpen(row.name),
                      },
                      row.name,
                    ),
                options.extra === undefined ? null : options.extra(row),
                rowEnd(options.end === undefined ? null : options.end(row)),
              )),
            ),
          )
        }
        return h(
          'div',
          null,
          h('p', { className: 'ptSub', style: { margin: 0 } }, `${title}（失去 ${counts[0]} · 共享 ${counts[1]} · 未归属 ${counts[2]}）`),
          nodes.length === 0
            ? h('p', { className: 'ptSub', style: { margin: 0 } }, '没有注册项')
            : nodes,
        )
      }

      /** 覆盖链：按真实应用顺序列出层，并可展开逐层 config。 */
      function renderLayersBody(config) {
        if (config?.available !== true) {
          return h('p', { className: 'ptSub', style: { margin: 0 } }, config?.reason ?? '配置分层不可用')
        }
        return h(
          Fragment,
          null,
          h('p', { className: 'ptSub', style: { margin: 0 } }, `共 ${config.layers.length} 层，按 bundle → profile → home → 启动覆盖 → 生效排列`),
          h(
            'div',
            { className: 'ptFlow' },
            config.layers.map((layer) => h(
              'div',
              { key: layer.layerId, className: 'ptFlowStep', 'data-tone': layer.readable === true ? undefined : 'muted' },
              h('span', { className: 'ptFlowKey' }, layer.kind === 'effective' ? '生效' : layer.kind),
              h('span', { className: 'ptFlowValue' }, layer.label + (layer.version ? `@${layer.version}` : '')),
              layer.readable === true ? null : tag('不可读', 'warn', layer.reason),
              rowEnd((layer.configKeys ?? []).length === 0 ? null : `config ${layer.configKeys.length}`),
            )),
          ),
          h(
            'details',
            { className: 'ptFold ptFoldable' },
            h(
              'summary',
              null,
              h('span', null, '逐层 config'),
              rowEnd(`${config.layers.filter((layer) => layer.readable === true).length} 层可读`),
            ),
            config.layers.map((layer) => h(
              'div',
              { key: layer.layerId },
              h('p', { className: 'ptSub', style: { margin: 0 } }, `${layer.label} · ${layer.kind}`),
              layer.readable !== true
                ? h('p', { className: 'ptSub', style: { margin: 0 } }, layer.reason ?? '文件不可读')
                : (layer.configKeys ?? []).length === 0
                  ? h('p', { className: 'ptSub', style: { margin: 0 } }, layer.note ?? '这一层没有写出 config 键')
                  : h(
                      'ul',
                      { className: 'ptConfigList' },
                      layer.configKeys.map((key) => h(
                        'li',
                        { key },
                        h('code', { className: 'ptConfigKey' }, key),
                        h('span', { className: 'ptConfigEquals' }, '='),
                        h('code', { className: 'ptConfigValue' }, layer.values?.[key] ?? '（未解析）'),
                      )),
                    ),
              layer.parsed === false
                ? h('p', { className: 'ptSub', style: { margin: 0 } }, '未解析：' + (layer.reason ?? '不支持的 YAML 写法') + (layer.rawText ? '；原文见下' : ''))
                : null,
              layer.parsed === false && layer.rawText
                ? h('div', null, h('code', { className: 'ptConfigValue' }, layer.rawText))
                : null,
            )),
          ),
          config.diagnostics.some((row) => row.kind === 'layers-truncated')
            ? h('p', { className: 'ptHint', style: { margin: 0 } }, '覆盖链过长，只展示了前若干层与生效层。')
            : null,
        )
      }

      /** 以 config 键为轴，逐层对照。 */
      function renderConfigKeysBody(config, matches) {
        if (config?.available !== true) return null
        const keys = new Set()
        for (const layer of config.layers) {
          for (const key of layer.configKeys ?? []) keys.add(key)
        }
        const visible = [...keys].filter((key) => (
          matches(key)
          || config.layers.some((layer) => (
            (layer.configKeys ?? []).includes(key)
            && (matches(layer.label) || matches(layer.values?.[key] ?? ''))
          ))
        ))
        if (keys.size === 0) {
          return h('p', { className: 'ptSub', style: { margin: 0 } }, '这个条目没有可对照的 config 键。')
        }
        const effective = config.layers.find((layer) => layer.kind === 'effective')
        return h(
          Fragment,
          null,
          h('p', { className: 'ptSub', style: { margin: 0 } }, `共 ${keys.size} 个键，当前显示 ${visible.length} 个`),
          visible.sort().map((key) => {
            const declaring = config.layers
              .filter((layer) => layer.kind !== 'effective' && layer.readable === true && (layer.configKeys ?? []).includes(key))
              .map((layer) => ({ layer, value: layer.values?.[key] }))
            const diagnostics = config.diagnostics.filter((row) => row.key === key)
            return h(
              'details',
              { key, className: 'ptFold ptFoldable' },
              h(
                'summary',
                null,
                h('code', { className: 'ptConfigKey' }, key),
                diagnostics.some((row) => row.severity === 'warn') ? tag('差异', 'warn') : null,
                rowEnd(`${declaring.length} 层声明`),
              ),
              h(
                'ul',
                { className: 'ptDepList' },
                declaring.map((item) => h(
                  'li',
                  { key: item.layer.layerId },
                  h('span', { className: 'ptDepKey' }, item.layer.label),
                  h('code', { className: 'ptConfigValue' }, item.value ?? '（未解析）'),
                )),
                h(
                  'li',
                  { key: 'effective' },
                  h('span', { className: 'ptDepKey' }, '生效（运行时）'),
                  effective?.configKeys?.includes(key) === true
                    ? h('code', { className: 'ptConfigValue' }, effective.values?.[key] ?? '')
                    : h('span', { className: 'ptDepValue ptMissing' }, '（生效配置里没有这个键）'),
                ),
              ),
              diagnostics.map((row) => h('p', { key: row.id, className: row.severity === 'warn' ? 'ptError' : 'ptSub', style: { margin: 0 } }, row.message)),
            )
          }),
        )
      }

      /** 诊断列表。 */
      function renderDiagnosticsBody(diagnostics) {
        return diagnostics.length === 0
          ? h('p', { className: 'ptSub', style: { margin: 0 } }, '没有发现配置声明与生效值之间的差异。')
          : h(
              'ul',
              { className: 'ptDepList' },
              diagnostics.map((row) => h(
                'li',
                { key: row.id },
                tag(SEVERITY_LABELS[row.severity] ?? row.severity, row.severity === 'warn' ? 'warn' : undefined),
                h('span', { className: 'ptDepValue' }, row.message),
                rowEnd(EVIDENCE_LABELS[row.evidence] ?? row.evidence),
              )),
            )
      }

      /** 节点副标题：一句话说清它和目标的边。 */
      function nodeSubtitle(node, data) {
        if (node.side === 'root') return `工具 ${data.tools.owned.length} · 段 ${data.prompt.sections.owned.length} · 服务 ${data.target.provides.length}`
        if (node.blocked === true) {
          const missing = (node.missingServices ?? []).join('、')
          return `失去 ${missing || node.edgeLabel || '必需服务'}` + (node.distance ? ` · 第 ${node.distance} 层` : '')
        }
        if (node.edgeKind === 'config-reference') return `config.${node.edgeLabel} 引用了它`
        if (node.edgeKind === 'group-child') return '同组子行'
        if (node.side === 'upstream') return `提供 ${node.edgeLabel}` + (node.again ? ' · 已在上方' : '')
        return `需要 ${node.edgeLabel}` + (node.again ? ' · 已在上方' : '')
      }

      /** 受影响的下游插件与完整因果路径。 */
      function renderChainBody(chain, vc) {
        const rows = chain?.blocked ?? []
        const openPlugin = typeof vc.gotoPlugin === 'function' ? vc.gotoPlugin : () => {}
        if (rows.length === 0) {
          return h('p', { className: 'ptSub', style: { margin: 0 } }, '没有其他插件会因为这次禁用而失去必需服务')
        }
        return h(
          Fragment,
          null,
          h('p', { className: 'ptHint', style: { margin: 0 } }, chain.note),
          h(
            'ul',
            { className: 'ptDepList' },
            rows.map((row) => h(
              'li',
              { key: row.entryId },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ptTag ptLink',
                  title: '在插件页展开 ' + row.title,
                  onClick: () => openPlugin(row.rowId),
                },
                row.title,
              ),
              tag(row.alreadyPending ? '已 pending' : '将不可用', 'warn'),
              h(
                'span',
                { className: 'ptDepValue' },
                row.path.map((part) => (part.kind === 'service' ? `〔${part.name}〕` : part.title)).join(' → '),
              ),
              rowEnd(`第 ${row.distance} 层`),
            )),
          ),
        )
      }

      /** 上下游树状图 + 可折叠的文字明细。 */
      function renderRelations(vc, data) {
        const tree = impactTree.buildRelationTree(vc.snapshot, data.target, {
          depth: 2,
          chain: data.chain,
          groupChildren: data.descendants,
          chainDepth: 4,
          maxNodes: 80,
        })
        const layout = impactTree.layoutRelationTree(tree)
        const rows = impactTree.flattenRelationTree(tree)
        const pending = new Set((data.services?.pending ?? []).map((row) => row.rowId))
        const hasGraph = tree.root !== null && layout.nodes.length > 1
        const openPlugin = typeof vc.gotoPlugin === 'function' ? vc.gotoPlugin : () => {}
        return h(
          'div',
          { className: 'ptSection' },
          h('p', { className: 'ptSectionTitle' }, '依赖关系图'),
          hasGraph
            ? h(
                'div',
                { className: 'ptGraphWrap' },
                h(
                  'svg',
                  {
                    className: 'ptGraph',
                    viewBox: `0 0 ${layout.width} ${layout.height}`,
                    role: 'group',
                    'aria-label': `插件关系图：目标 ${data.target.title}，上游 ${tree.upstream.length} 个，下游受阻链路 ${tree.downstream.length} 个。下方有等价的文字明细。`,
                  },
                  layout.edges.map((edge) => h(
                    'g',
                    { key: edge.key },
                    h('path', { className: 'ptGraphEdge', 'data-kind': edge.kind, d: edge.d }),
                    h('polygon', { className: 'ptGraphArrow', points: edge.arrow }),
                    edge.label
                      ? h('text', { className: 'ptGraphEdgeLabel', x: edge.labelX, y: edge.labelY, textAnchor: 'middle' }, clip(edge.label, 18))
                      : null,
                  )),
                  layout.nodes.map((node) => h(
                    'g',
                    {
                      key: node.key,
                      className: 'ptGraphNode',
                      'data-tone': node.side === 'root' ? 'target' : node.blocked === true || pending.has(node.rowId) ? 'pending' : undefined,
                      role: 'button',
                      tabIndex: 0,
                      'aria-label': `${node.title}：${nodeSubtitle(node, data)}，点击在插件页打开`,
                      onClick: () => openPlugin(node.rowId),
                      onKeyDown: (event) => activateOnKey(event, () => openPlugin(node.rowId)),
                    },
                    h('title', null, `${node.title} · ${nodeSubtitle(node, data)}`),
                    h('rect', { x: node.x, y: node.y, width: node.width, height: node.height, rx: 8 }),
                    h('text', { className: 'ptGraphLabel', x: node.x + 10, y: node.y + 18 }, clip(node.title, 18)),
                    h('text', { className: 'ptGraphSub', x: node.x + 10, y: node.y + 34 }, clip(nodeSubtitle(node, data), 24)),
                  )),
                ),
              )
            : h('p', { className: 'ptEmpty' }, '没有可绘制的上下游关系'),
          tree.notes.length > 0
            ? h('div', null, tree.notes.map((note) => h('p', { key: note, className: 'ptHint', style: { margin: 0 } }, note)))
            : null,
          h(
            'details',
            { className: 'ptFold ptFoldable' },
            h('summary', null, h('span', null, '关系明细'), rowEnd(`${rows.length} 项`)),
            h(
              'ul',
              { className: 'ptDepList' },
              rows.map((row) => h(
                'li',
                { key: row.key },
                h('span', { className: 'ptDepKey' }, row.side === 'root' ? '目标' : row.side === 'upstream' ? '上游' : '下游'),
                h('span', { className: 'ptDepValue' }, row.title
                  + (row.blocked ? ` · 失去 ${row.missingServices.join('、') || row.edgeLabel || '必需服务'}` : '')
                  + (row.again ? '（已在上方出现）' : '')),
                typeof row.rowId === 'string'
                  ? textButton('打开', () => openPlugin(row.rowId), { title: '在插件页展开' })
                  : null,
              )),
            ),
          ),
        )
      }

      /** 服务影响：机制细节，默认收起，避免挤占「受影响的下游插件」正文。 */
      function renderServiceDetails(services) {
        const rows = (services.rows ?? []).filter((row) => row.soleInSet || (row.consumers ?? []).length > 0)
        return h(
          'details',
          { className: 'ptFold ptFoldable' },
          h(
            'summary',
            null,
            h('span', null, '服务影响'),
            rowEnd(`唯一提供 ${services.soleProviders.length} · pending ${services.pending.length}`),
          ),
          rows.length === 0
            ? h('p', { className: 'ptSub', style: { margin: 0 } }, '这个条目没有提供任何服务')
            : h(
                'ul',
                { className: 'ptDepList' },
                rows.map((row) => h(
                  'li',
                  { key: row.name },
                  h('span', { className: 'ptDepKey' }, row.name),
                  h(
                    'span',
                    { className: 'ptDepValue' },
                    row.soleInSet
                      ? `唯一提供；消费者 ${row.consumers.length} 个`
                      : `提供者 ${row.providers.length} 个；消费者 ${row.consumers.length} 个`,
                  ),
                  row.soleInSet ? tag('唯一提供', 'warn') : null,
                )),
              ),
          services.pending.length === 0
            ? null
            : h(
                Fragment,
                null,
                h('p', { className: 'ptSub', style: { margin: 0 } }, `会停在 pending（${services.pending.length}）`),
                h(
                  'ul',
                  { className: 'ptDepList' },
                  services.pending.map((row) => h(
                    'li',
                    { key: row.rowId },
                    h('span', { className: 'ptDepKey' }, row.title),
                    h('span', { className: 'ptDepValue' }, `需要 ${row.services.join('、')}`),
                    tag(row.alreadyPending ? '已 pending' : '将停在 pending', 'warn'),
                  )),
                ),
              ),
        )
      }

      /** 模式与会话的一句话摘要，放在下游子块里，不再单开一节。 */
      function renderScopeLine(data) {
        const modes = (data.modes ?? []).map((mode) => mode.name).join('、') || '无'
        const live = (data.liveSessions ?? []).map((row) => formatSessionId(row.sessionId)).join('、') || '无'
        return h(
          'p',
          { className: 'ptSub', style: { margin: 0 } },
          `受影响模式：${modes} · 活会话：${live} · 冷会话：${data.coldSessionCount}`,
        )
      }

      /** 运行时消息注入（推断），作为「会失去的工具与提示词」里的一个分组。 */
      function renderInjectionGroup(injections) {
        return h(
          'div',
          null,
          h('p', { className: 'ptSub', style: { margin: 0 } }, `运行时消息注入（推断 ${injections.rows.length}）`),
          injections.rows.length === 0
            ? h('p', { className: 'ptSub', style: { margin: 0 } }, injections.note)
            : h(
                'ul',
                { className: 'ptDepList' },
                injections.rows.map((row) => h(
                  'li',
                  { key: row.sourceKind },
                  h('span', { className: 'ptDepKey' }, row.label),
                  h('span', { className: 'ptDepValue' }, row.sourceKind),
                  tag('推断', undefined, '归属按包名映射，不是运行时实测'),
                )),
              ),
        )
      }

      /** 证据与边界：折叠在页尾，不占正文。 */
      function renderEvidence(data) {
        return h(
          'details',
          { className: 'ptFold ptFoldable' },
          h('summary', null, h('span', null, '证据与边界'), rowEnd(`${data.evidence.length} 条`)),
          h(
            'ul',
            { className: 'ptDepList' },
            data.evidence.map((row) => h(
              'li',
              { key: row.id },
              h('span', { className: 'ptDepKey' }, EVIDENCE_LABELS[row.level] ?? row.level),
              h('span', { className: 'ptDepValue' }, row.label + '：' + row.detail),
            )),
            data.limits.map((text) => h('li', { key: text }, h('span', { className: 'ptDepValue' }, text))),
          ),
        )
      }

      /** 空态：还没选目标。 */
      function renderEmpty() {
        return h(
          'div',
          { className: 'ptEmpty' },
          '选择一个插件查看禁用影响。',
          h('p', { className: 'ptHint', style: { margin: '8px 0 0' } }, '在上方选择插件，或在插件详情里点「预演禁用」。本页只读，不会执行禁用。'),
        )
      }

      /**
       * 页面正文。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderDisablePreviewView(vc) {
        const { disablePreview, query, gotoTool, gotoSection } = vc
        if (disablePreview.rowId === null) return renderEmpty()
        if (disablePreview.status === 'error') {
          return h(
            'div',
            { className: 'ptNotice' },
            h('p', { className: 'ptError' }, disablePreview.error),
            textButton('重试', () => disablePreview.reload()),
          )
        }
        if (disablePreview.data === null) {
          return h('div', { 'aria-busy': 'true' }, Array.from({ length: 6 }, (_value, index) => h('div', { key: index, className: 'ptSkeleton' })))
        }
        const data = disablePreview.data
        if (data.found !== true) {
          return h('div', { className: 'ptNotice' }, h('p', { className: 'ptError' }, data.reason ?? '找不到这个插件条目'))
        }
        const matches = (value) => search.matchesQuery(query, [value])
        const config = data.config
        const diagnostics = (config?.diagnostics ?? []).filter((row) => query === '' || matches(row.message) || matches(row.kind))
        const tools = data.tools.rows.filter((row) => query === '' || matches(row.name))
        const sections = data.prompt.sections.rows.filter((row) => query === '' || matches(row.name))
        const contexts = data.prompt.contexts.rows.filter((row) => query === '' || matches(row.name))
        const services = {
          ...data.services,
          rows: (data.services.rows ?? []).filter((row) => query === '' || matches(row.name)),
          pending: (data.services.pending ?? []).filter((row) => query === '' || matches(row.title) || matches(row.services.join(' '))),
        }
        const injections = {
          ...data.injections,
          rows: (data.injections.rows ?? []).filter((row) => query === '' || matches(row.label) || matches(row.sourceKind)),
        }
        return h(
          Fragment,
          null,
          h(
            'div',
            { className: 'ptSection' },
            h('p', { className: 'ptSectionTitle' }, '预禁用的插件信息'),
            h(
              'dl',
              { className: 'ptFacts' },
              fact('插件', data.target.title),
              fact('组合行 id', h('code', null, data.target.rowId)),
              data.target.entryId !== data.target.rowId ? fact('运行时 id', h('code', null, data.target.entryId)) : null,
              fact('模块', data.target.moduleName ? h('code', null, data.target.moduleName) : null),
              fact('层', data.target.layer),
              data.target.isGroup ? fact('分组', `子行 ${data.descendants.length} 个`) : null,
            ),
          ),
          h(
            'div',
            { className: 'ptSection' },
            h('p', { className: 'ptSectionTitle' }, '连锁反应'),
            renderReactionSummary(data),
            subBlock(
              '会失去的工具与提示词',
              h(
                Fragment,
                null,
                renderNameGroup('工具', { ...data.tools, rows: tools }, {
                  onOpen: typeof gotoTool === 'function' ? gotoTool : undefined,
                  openTitle: '在「工具」页查看',
                  extra: (row) => (row.shared
                    ? tag('共享', undefined, row.owners.join('、'))
                    : row.chainOnly ? tag('链路', 'warn', '由依赖链连带失去') : null),
                  end: (row) => (row.unknown ? '未归属' : row.scopes.includes('global') ? '全局' : `${row.scopes.length} 个范围`),
                }),
                renderNameGroup('提示词段', { ...data.prompt.sections, rows: sections }, {
                  onOpen: typeof gotoSection === 'function' ? gotoSection : undefined,
                  openTitle: '在「上下文预演」页查看该段落',
                  extra: (row) => (row.shared
                    ? tag('共享', undefined, row.owners.join('、'))
                    : row.chainOnly ? tag('链路', 'warn', '由依赖链连带失去') : null),
                  end: (row) => (row.unknown ? '未归属' : null),
                }),
                renderNameGroup('运行时上下文', { ...data.prompt.contexts, rows: contexts }, {
                  onOpen: typeof gotoSection === 'function' ? gotoSection : undefined,
                  openTitle: '在「上下文预演」页查看该上下文',
                  extra: (row) => (row.shared
                    ? tag('共享', undefined, row.owners.join('、'))
                    : row.chainOnly ? tag('链路', 'warn', '由依赖链连带失去') : null),
                  end: (row) => (row.unknown ? '未归属' : null),
                }),
                renderInjectionGroup(injections),
              ),
            ),
            subBlock(
              `受影响的下游插件（${data.chain?.blocked?.length ?? 0} 个）`,
              h(
                Fragment,
                null,
                renderChainBody(data.chain, vc),
                (data.modes?.length ?? 0) + (data.liveSessions?.length ?? 0) + (data.coldSessionCount ?? 0) > 0
                  ? renderScopeLine(data)
                  : null,
                renderServiceDetails(services),
              ),
            ),
          ),
          renderRelations(vc, data),
          h(
            'div',
            { className: 'ptSection' },
            h('p', { className: 'ptSectionTitle' }, '配置与覆盖'),
            config?.available !== true
              ? h('p', { className: 'ptSub', style: { margin: 0 } }, config?.reason ?? '配置分层不可用')
              : h(
                  Fragment,
                  null,
                  subBlock('覆盖链', renderLayersBody(config)),
                  subBlock('配置逐层对照', renderConfigKeysBody(config, matches)),
                  subBlock(`配置诊断（${diagnostics.length}）`, renderDiagnosticsBody(diagnostics)),
                ),
          ),
          renderEvidence(data),
        )
      }

      return { useDisablePreviewStore, renderDisablePreviewFilters, renderDisablePreviewView }
    }
  },
})
