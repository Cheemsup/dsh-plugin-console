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
 * 关系图用固定几何的树布局（`client.impact-tree.js`）。图下不再附等价的
 * 文字明细：下游插件已由「受影响的下游插件」逐行给出，再列一遍只是同源
 * 信息的第二次搬运。
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
        DISABLE_PREVIEW_ROUTE,
        fact,
        fetchJson,
        formatSessionId,
        relationGraph,
        rowEnd,
        search,
        shortName,
        textButton,
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

      /** 因果路径的读法；起点、服务、终点各是链条里的哪种节点。 */
      const PATH_HINT = '影响传导链：起点 → 服务 → 节点1 → 服务 → 节点2 → … → 终点'

      /** 服务影响标题：每行是什么，以及声明值的边界。 */
      const SERVICE_IMPACT_HINT = '条目：“服务名   提供者 · 声明依赖该服务的插件数”。依赖来自 fiber.inject 声明，包含已禁用与已 pending 的条目，不等于实际会停的数量'

      /** 逐层 config 的读法：列的是每层声明值与读取状态，不是合并结果。 */
      const CONFIG_LAYERS_HINT = '按覆盖链顺序显示每一层写出的 config 内容'

      /** 一个状态标签；`tone` 走 `.ptTag` 的四档。 */
      function tag(text, tone, title) {
        return h('span', { className: 'ptTag', 'data-tone': tone, title }, text)
      }

      /** 顶层区块下的子块：左侧竖线 + 降一级标题，避免把每个子问题都升成顶级标题。 */
      function subBlock(title, children, hint) {
        return h(
          'div',
          { className: 'ptSubBlocks' },
          h('p', { className: 'ptSubTitle' }, hint === undefined ? title : h('span', { title: hint }, title)),
          children,
        )
      }

      /**
       * 一级标题 + 降一级内容。
       *
       * 与 `subBlock` 的区别是标题不缩进、字号与顶层区块一致；用于区块内部
       * 还带两层结构的答案（如「会失去的提示词与消息内容」）。
       */
      function firstLevelBlock(title, children) {
        return h(
          'div',
          { className: 'ptSection' },
          h('p', { className: 'ptSectionTitle' }, title),
          h('div', { className: 'ptSubBlocks' }, children),
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
        // 制图区两种视图：默认看禁用影响，切换后看以目标为中心的完整依赖链。
        const [graphMode, setGraphMode] = useState('impact')
        // 图缩放只影响显示尺寸，不重新布局；切换目标或视图时保留当前比例。
        const [graphZoom, setGraphZoom] = useState(1)
        // 插件选择器：展开时输入框用于筛选，关闭时显示当前选择。
        const [targetQuery, setTargetQuery] = useState('')
        const [targetOpen, setTargetOpen] = useState(false)
        const [targetIndex, setTargetIndex] = useState(-1)
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

        return {
          rowId,
          data,
          status,
          error,
          choose,
          reload,
          graphMode,
          setGraphMode,
          graphZoom,
          setGraphZoom,
          targetPicker: {
            query: targetQuery,
            open: targetOpen,
            index: targetIndex,
            setQuery: setTargetQuery,
            setOpen: setTargetOpen,
            setIndex: setTargetIndex,
          },
        }
      }

      /** 可输入选择器在缺省状态下的空实现：视图被单独渲染（自检）时也能工作。 */
      const EMPTY_TARGET_PICKER = {
        query: '',
        open: false,
        index: -1,
        setQuery: () => {},
        setOpen: () => {},
        setIndex: () => {},
      }

      /**
       * 页头工具条：可输入的插件选择器 + 重新加载。
       *
       * 输入框同时是列表的筛选条件：聚焦时展开完整列表，输入即过滤；
       * 关闭时输入框显示当前选中的插件名。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderDisablePreviewFilters(vc) {
        const { entries, disablePreview } = vc
        const picker = disablePreview.targetPicker ?? EMPTY_TARGET_PICKER
        const chosen = disablePreview.rowId ?? ''
        const all = (entries ?? [])
          .slice()
          .sort((left, right) => shortName(left).localeCompare(shortName(right), 'zh-CN'))
          .map((entry) => ({
            value: entry.rowId,
            label: shortName(entry) + (entry.isGroup ? '（分组）' : entry.modeOnly ? '（模式专属）' : ''),
            search: `${shortName(entry)} ${entry.rowId ?? ''} ${entry.moduleName ?? ''}`.toLowerCase(),
          }))
        const needle = picker.query.trim().toLowerCase()
        const items = needle === ''
          ? [{ value: '', label: '选择插件…', search: '' }, ...all]
          : all.filter((item) => item.search.includes(needle))
        const selected = all.find((item) => item.value === chosen)
        const active = items.length === 0 ? -1 : Math.min(picker.index, items.length - 1)
        /** 收起列表并清空筛选词；输入框随后显示当前选中项。 */
        const close = () => {
          picker.setOpen(false)
          picker.setQuery('')
          picker.setIndex(-1)
        }
        const choose = (value) => {
          close()
          disablePreview.choose(value)
        }
        const onKeyDown = (event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            picker.setOpen(true)
            if (items.length === 0) {
              picker.setIndex(-1)
              return
            }
            const step = event.key === 'ArrowDown' ? 1 : -1
            const start = picker.index
            picker.setIndex(start < 0
              ? (step > 0 ? 0 : items.length - 1)
              : (start + step + items.length) % items.length)
          } else if (event.key === 'Enter' && picker.open === true && active >= 0) {
            event.preventDefault()
            choose(items[active].value)
          } else if (event.key === 'Escape') {
            close()
          }
        }
        return h(
          Fragment,
          null,
          h(
            'div',
            { className: 'ptField' },
            h('span', { className: 'ptFieldLabel' }, '选择禁用插件'),
            h(
              'div',
              { className: 'ptCombo' },
              h('input', {
                type: 'text',
                className: 'ptSelect ptComboInput',
                placeholder: '选择插件…',
                value: picker.open === true ? picker.query : (selected?.label ?? ''),
                role: 'combobox',
                'aria-label': '选择禁用插件',
                'aria-expanded': picker.open === true,
                'aria-controls': 'pt-disable-target-options',
                'aria-autocomplete': 'list',
                'aria-activedescendant': picker.open === true && active >= 0 ? `pt-disable-target-option-${active}` : undefined,
                onFocus: () => {
                  picker.setOpen(true)
                  picker.setQuery('')
                  picker.setIndex(-1)
                },
                onChange: (event) => {
                  picker.setOpen(true)
                  picker.setQuery(event.target.value)
                  picker.setIndex(0)
                },
                // 已经聚焦时再点一次也要能重新展开（例如刚按过 Esc）。
                onClick: () => {
                  if (picker.open === true) return
                  picker.setOpen(true)
                  picker.setQuery('')
                  picker.setIndex(-1)
                },
                onKeyDown,
                onBlur: () => picker.setOpen(false),
              }),
              picker.open === true
                ? h(
                    'div',
                    { id: 'pt-disable-target-options', className: 'ptComboList', role: 'listbox' },
                    items.length === 0
                      ? h('p', { className: 'ptComboEmpty' }, '没有匹配的插件')
                      : items.map((item, index) => h(
                          'button',
                          {
                            key: item.value === '' ? '__none' : item.value,
                            id: `pt-disable-target-option-${index}`,
                            type: 'button',
                            className: 'ptComboOption',
                            role: 'option',
                            'data-active': index === active,
                            'aria-selected': item.value === chosen,
                            // 按下时不抢输入框焦点，click 才能正常命中。
                            onMouseDown: (event) => event.preventDefault(),
                            onClick: () => choose(item.value),
                          },
                          item.label,
                        )),
                  )
                : null,
            ),
          ),
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
          fact('失去提示词与上下文', scale.lostSections + scale.lostContexts === 0 ? '无' : `段 ${scale.lostSections} · 上下文 ${scale.lostContexts}`),
          fact('受影响的下游插件', scale.blockedEntries === 0 ? '无' : `${scale.blockedEntries} 个 · 最深第 ${scale.chainDepth} 层`),
          fact('影响范围', `模式 ${scale.modes} · 活会话 ${scale.liveSessions} · 冷会话 ${scale.coldSessionCount}`),
          fact('生效', data.hmr === true ? 'HMR 可用，可能立即生效' : '未检测到 HMR；可能需要重启'),
        )
      }

      /**
       * 一组名字：失去 / 共享 / 未归属 / 不在全局注册表各一段。
       *
       * 「不在全局注册表」与「未归属」不是一回事：前者是名字在源码里扫得到、
       * 当前全局注册表却没有（多为会话内或条件注册）；后者是注册表里有这一项、
       * 但扫描不到 owner。两者都不并入「失去」，但原因必须分开写。
       */
      function renderNameGroup(title, bucket, options) {
        const rows = bucket.rows ?? []
        const query = options.query ?? ''
        // 搜索时没有命中的分组整块省略：留一行「没有注册项」只会把命中项推远。
        if (rows.length === 0 && search.normalizeQuery(query) !== '') return null
        const allSections = [
          { key: 'lost', label: '失去' },
          { key: 'shared', label: '共享' },
          { key: 'unknown', label: '未归属' },
          { key: 'registryMissing', label: '不在全局注册表' },
        ]
        // 没有这一类行时不显示计数，避免每个分组都多出一段「… 0」。
        const sections = allSections.filter((group) => (
          group.key !== 'registryMissing' || rows.some((row) => row.registryMissing === true)
        ))
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
                  ? h('span', { className: 'ptDepKey' }, search.markQuery(row.name, query))
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'ptTag ptLink',
                        title: options.openTitle,
                        onClick: () => options.onOpen(row.name),
                      },
                      search.markQuery(row.name, query),
                    ),
                options.extra === undefined ? null : options.extra(row),
                rowEnd(options.end === undefined ? null : options.end(row)),
              )),
            ),
          )
        }
        const summary = sections.map((group, index) => `${group.label} ${counts[index]}`).join(' · ')
        return h(
          'div',
          null,
          h('p', { className: 'ptSub', style: { margin: 0 } }, `${title}（${summary}）`),
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
              h('span', { title: CONFIG_LAYERS_HINT }, '逐层 config'),
              rowEnd(`${config.layers.filter((layer) => layer.readable === true).length} 层可读`),
            ),
            h(
              'div',
              { className: 'ptConfigLayers' },
              config.layers.map((layer) => h(
                'div',
                { key: layer.layerId, className: 'ptConfigLayer' },
                h(
                  'p',
                  { className: 'ptSubTitle ptConfigLayerHead' },
                  h('span', null, `${layer.label} · `),
                  h('span', { className: 'ptConfigKind' }, layer.kind),
                ),
                h(
                  'div',
                  { className: 'ptConfigLayerBody' },
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
                    ? h('pre', { className: 'ptConfigRaw' }, layer.rawText)
                    : null,
                ),
              )),
            ),
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
        if (keys.size === 0 || visible.length === 0) return null
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

      /** 诊断列表；调用方只在有诊断时渲染这个子块。 */
      function renderDiagnosticsBody(diagnostics) {
        return h(
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

      /** 受影响的下游插件与完整因果路径。 */
      function renderChainBody(chain, vc) {
        const rows = chain?.blocked ?? []
        const openPlugin = typeof vc.gotoPlugin === 'function' ? vc.gotoPlugin : () => {}
        const searching = search.normalizeQuery(vc.query) !== ''
        if (rows.length === 0) {
          return h('p', { className: 'ptSub', style: { margin: 0 } }, searching
            ? '没有匹配的下游插件'
            : '没有其他插件会因为这次禁用而失去必需服务')
        }
        return h(
          Fragment,
          null,
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
                search.markQuery(row.title, vc.query),
              ),
              tag(row.alreadyPending ? '已 pending' : '将不可用', 'warn'),
              h(
                'span',
                { className: 'ptDepValue', title: PATH_HINT },
                row.path.map((part) => (part.kind === 'service' ? `〔${part.name}〕` : part.title)).join(' → '),
              ),
              rowEnd(`第 ${row.distance} 层`),
            )),
          ),
        )
      }

      /**
       * 服务行的提供者状态。
       *
       * `soleInSet` 是「全部声明提供者都不可用」，不是「只有一个提供者」；
       * 唯一提供者也可能来自链路里被带停的其他插件，所以不能一律写「本插件」。
       */
      function serviceProviderState(row, targetRowId) {
        const providers = Array.isArray(row.providers) ? row.providers : []
        if (row.soleInSet === true) {
          if (providers.length === 1) {
            const provider = providers[0]
            const isTarget = provider.rowId === targetRowId
            return {
              text: isTarget ? '本插件是唯一提供者' : `唯一提供者：${provider.title ?? provider.rowId ?? '未知插件'}`,
              tag: isTarget ? '唯一提供者' : '链路内唯一提供',
              tone: 'warn',
            }
          }
          return { text: `提供者全部不可用（${providers.length} 个）`, tag: '提供者全失', tone: 'warn' }
        }
        if (providers.length === 0) return { text: '未登记提供者', tag: null, tone: undefined }
        return { text: `提供者 ${providers.length} 个（仍有可用）`, tag: null, tone: undefined }
      }

      /** 服务影响：机制细节，默认收起，避免挤占「受影响的下游插件」正文。 */
      function renderServiceDetails(services, targetRowId, query) {
        const rows = (services.rows ?? []).filter((row) => row.soleInSet || (row.consumers ?? []).length > 0)
        const searching = search.normalizeQuery(query) !== ''
        return h(
          'details',
          { className: 'ptFold ptFoldable' },
          h(
            'summary',
            null,
            h('span', { title: SERVICE_IMPACT_HINT }, '服务影响'),
            rowEnd(`提供者全失 ${services.soleProviders.length} · pending ${services.pending.length}`),
          ),
          rows.length === 0
            ? h('p', { className: 'ptSub', style: { margin: 0 } }, searching ? '没有匹配的服务' : '这个条目没有提供任何服务')
            : h(
                'ul',
                { className: 'ptDepList' },
                rows.map((row) => {
                  const state = serviceProviderState(row, targetRowId)
                  const consumers = (row.consumers ?? []).length
                  return h(
                    'li',
                    { key: row.name },
                    h('span', { className: 'ptDepKey' }, search.markQuery(row.name, query)),
                    h('span', { className: 'ptDepValue' }, `${state.text} · 声明依赖的插件 ${consumers} 个`),
                    state.tag === null ? null : tag(state.tag, state.tone),
                  )
                }),
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
                    h('span', { className: 'ptDepKey' }, search.markQuery(row.title, query)),
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

      /** 运行时消息注入（整条消息，推断），作为「会失去的提示词与消息内容」里的一个分组。 */
      function renderInjectionGroup(injections, query) {
        // 搜索没有命中时整组省略；没有注入数据（available=false）仍保留说明。
        if (injections.rows.length === 0 && search.normalizeQuery(query) !== '') return null
        return h(
          'div',
          null,
          h('p', { className: 'ptSub', style: { margin: 0 } }, `运行时消息注入（整条消息 · 推断 ${injections.rows.length}）`),
          injections.rows.length === 0
            ? h('p', { className: 'ptSub', style: { margin: 0 } }, injections.note)
            : h(
                'ul',
                { className: 'ptDepList' },
                injections.rows.map((row) => h(
                  'li',
                  { key: row.sourceKind },
                  h('span', { className: 'ptDepKey' }, search.markQuery(row.label, query)),
                  h('span', { className: 'ptDepValue' }, row.sourceKind),
                  tag('推断', undefined, '归属按包名映射，不是运行时实测'),
                )),
              ),
        )
      }

      /** 证据与边界：按页面区块逐条标注来源与限制，折叠在页尾。 */
      function renderEvidence(data) {
        const notes = Array.isArray(data.notes) ? data.notes : []
        return h(
          'details',
          { className: 'ptFold ptFoldable' },
          h('summary', null, h('span', null, '证据与边界'), rowEnd(`${notes.length} 项`)),
          h(
            'ul',
            { className: 'ptDepList' },
            notes.map((note) => h(
              'li',
              { key: note.id },
              h('span', { className: 'ptDepKey' }, note.area),
              h('span', { className: 'ptDepValue' }, note.text),
            )),
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
        const searching = search.normalizeQuery(query) !== ''
        const config = data.config
        const diagnostics = (config?.diagnostics ?? []).filter((row) => query === '' || matches(row.message) || matches(row.kind))
        // 没有可对照的键、没有诊断时整块省略：空标题比空内容更占注意力。
        const keysBody = renderConfigKeysBody(config, matches)
        const diagnosticsBody = diagnostics.length === 0 ? null : renderDiagnosticsBody(diagnostics)
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
        // 页头搜索也筛下游插件链：这里只留下命中的行，图仍作为结构总览保留。
        const chainRows = (data.chain?.blocked ?? []).filter((row) => !searching || search.matchesQuery(query, [
          row.title,
          row.rowId,
          row.moduleName,
          row.causeService,
          ...(row.missingServices ?? []),
          ...(row.path ?? []).flatMap((part) => [part.name, part.title]),
        ]))
        const chainTotal = data.chain?.blocked?.length ?? 0
        const chain = { ...data.chain, blocked: chainRows }
        const promptRows = tools.length + sections.length
        const messageRows = contexts.length + injections.rows.length
        const nothingMatched = searching
          && promptRows + messageRows + services.rows.length + services.pending.length
            + chainRows.length + diagnostics.length === 0
          && keysBody === null
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
          nothingMatched
            ? search.renderQueryEmpty({
                noun: '影响项、配置键或诊断',
                onClear: typeof vc.setQuery === 'function' ? () => vc.setQuery('') : undefined,
              })
            : null,
          h(
            'div',
            { className: 'ptSection' },
            h('p', { className: 'ptSectionTitle' }, '连锁反应'),
            renderReactionSummary(data),
            firstLevelBlock(
              '会失去的提示词与消息内容',
              h(
                Fragment,
                null,
                searching && promptRows === 0 ? null : h(
                  'div',
                  { className: 'ptLayer' },
                  h('p', { className: 'ptSubTitle' }, '系统提示词（模型收到的 system message）'),
                  h(
                    'div',
                    { className: 'ptSubSection' },
                    renderNameGroup('工具', { ...data.tools, rows: tools }, {
                      query,
                      onOpen: typeof gotoTool === 'function' ? gotoTool : undefined,
                      openTitle: '在「工具」页查看',
                      extra: (row) => (row.shared
                        ? tag('共享', undefined, row.owners.join('、'))
                        : row.chainOnly ? tag('链路', 'warn', '由依赖链连带失去') : null),
                      end: (row) => (row.unknown ? '未归属' : row.scopes.includes('global') ? '全局' : `${row.scopes.length} 个范围`),
                    }),
                    renderNameGroup('提示词段', { ...data.prompt.sections, rows: sections }, {
                      query,
                      onOpen: typeof gotoSection === 'function' ? gotoSection : undefined,
                      openTitle: '在「上下文预演」页查看该段落',
                      extra: (row) => (row.shared
                        ? tag('共享', undefined, row.owners.join('、'))
                        : row.chainOnly ? tag('链路', 'warn', '由依赖链连带失去') : null),
                      end: (row) => (row.registryMissing
                        ? h('span', { className: 'ptDepValue', title: row.reason }, '可能仅会话内注册')
                        : row.unknown ? h('span', { className: 'ptDepValue', title: row.reason }, '未归属') : null),
                    }),
                  ),
                ),
                searching && messageRows === 0 ? null : h(
                  'div',
                  { className: 'ptLayer' },
                  h('p', { className: 'ptSubTitle' }, '会话消息（首请求里的 user-role 消息）'),
                  h(
                    'div',
                    { className: 'ptSubSection' },
                    renderNameGroup('运行时上下文段', { ...data.prompt.contexts, rows: contexts }, {
                      query,
                      onOpen: typeof gotoSection === 'function' ? gotoSection : undefined,
                      openTitle: '在「上下文预演」页查看该上下文',
                      extra: (row) => (row.shared
                        ? tag('共享', undefined, row.owners.join('、'))
                        : row.chainOnly ? tag('链路', 'warn', '由依赖链连带失去') : null),
                      end: (row) => (row.registryMissing
                        ? h('span', { className: 'ptDepValue', title: row.reason }, '可能仅会话内注册')
                        : row.unknown ? h('span', { className: 'ptDepValue', title: row.reason }, '未归属') : null),
                    }),
                    renderInjectionGroup(injections, query),
                  ),
                ),
              ),
            ),
            subBlock(
              `受影响的下游插件（${searching && chainRows.length !== chainTotal ? `${chainRows.length} / ${chainTotal}` : chainTotal} 个）`,
              h(
                Fragment,
                null,
                renderServiceDetails(services, data.target.rowId, query),
                renderChainBody(chain, vc),
                (data.modes?.length ?? 0) + (data.liveSessions?.length ?? 0) + (data.coldSessionCount ?? 0) > 0
                  ? renderScopeLine(data)
                  : null,
              ),
              data.chain?.note,
            ),
          ),
          relationGraph.renderRelations(vc, data),
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
                  keysBody === null ? null : subBlock('配置逐层对照', keysBody),
                  diagnosticsBody === null ? null : subBlock(`配置诊断（${diagnostics.length}）`, diagnosticsBody),
                ),
          ),
          renderEvidence(data),
        )
      }

      return { useDisablePreviewStore, renderDisablePreviewFilters, renderDisablePreviewView }
    }
  },
})
