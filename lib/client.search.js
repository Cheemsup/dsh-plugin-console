/**
 * 搜索：页头筛选的匹配口径与页内多词标记。
 *
 * 两层搜索分工不同：页头**筛掉**不匹配的条目，页内「文本检索」**不隐藏任何内容**，
 * 只把长文本里的命中底色改掉并标上搜索框编号。所以页头用的是
 * `normalizeQuery` / `matchesQuery` / `searchHint` / `renderQueryEmpty`，
 * 页内用的是搜索词列表、`createHighlighter` 与上下定位。
 *
 * 匹配口径（字面子串、忽略大小写、去首尾空格）只在这里定义一次：五个页面原先各写一份
 * `query.toLowerCase().includes(...)`，尾部空格的差异让同一句话在不同页面上结果不同。
 *
 * 渲染层是纯函数：匹配结果只由 (文本, 搜索词 / query) 决定，视图仍然是纯函数。
 * 本文件是一个包内 chunk：入口用 `require.async('./client.search.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.search.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useRef, useState } = React

    /** 颜色槽数量：与 client.styles.js 里的 [data-search="0..5"] 一一对应。 */
    const SLOT_COUNT = 6
    /** 单个文本块最多渲染的命中数；超长提示词里搜单字时保护 DOM 与输入流畅度。 */
    const MAX_HITS_PER_TEXT = 500

    /**
     * 页头筛选的归一化：去首尾空格 + 小写。
     *
     * 只做这两件事：正则、模糊与全词匹配都不在范围内。非字符串归一成空串，
     * 让「还没输过字」与「输了几个空格」走同一条路径。
     * @param {unknown} value - 输入框里的原文。
     * @returns {string} 归一后的搜索词。
     */
    function normalizeQuery(value) {
      return typeof value === 'string' ? value.trim().toLowerCase() : ''
    }

    /**
     * 判断一组字段里有没有命中。
     *
     * 空词命中一切；非字符串字段直接跳过——`title`、`description` 在快照里经常缺席，
     * 让调用方逐个写 `typeof value === 'string'` 只会把同一段代码复制五遍。
     * @param {unknown} query - 页头搜索框原文。
     * @param {unknown[]} fields - 这一条目参与匹配的可见字段。
     * @returns {boolean} 是否命中。
     */
    function matchesQuery(query, fields) {
      const needle = normalizeQuery(query)
      if (needle === '') return true
      if (!Array.isArray(fields)) return false
      return fields.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))
    }

    /**
     * 把一段文本里的页头命中切成 `<mark class="ptQueryMark">`。
     *
     * 与页内检索的彩色编号徽标区分开：这里是单色、无编号、不改变行高，
     * 只回答「这一行为什么留下」。命中上限与页内检索共用同一个常量。
     * @param {string} value - 原文。
     * @param {unknown} query - 页头搜索框原文。
     * @returns {string | Array} 无命中时原样返回字符串，便于直接当 React children 用。
     */
    function markQuery(value, query) {
      const needle = normalizeQuery(query)
      if (typeof value !== 'string' || value.length === 0 || needle === '') return value
      const haystack = value.toLowerCase()
      const out = []
      let at = 0
      let rendered = 0
      while (rendered < MAX_HITS_PER_TEXT) {
        const found = haystack.indexOf(needle, at)
        if (found < 0) break
        if (found > at) out.push(value.slice(at, found))
        out.push(h('mark', { key: 'q-' + found, className: 'ptQueryMark' }, value.slice(found, found + needle.length)))
        at = found + needle.length
        rendered += 1
      }
      if (out.length === 0) return value
      if (at < value.length) out.push(value.slice(at))
      return out
    }

    /**
     * 页头占位符：只说这个标签真的能筛什么。
     *
     * 占位符是契约的一部分。旧实现按主视图给字，预演页于是承诺了「提示词段、
     * 运行时上下文或工具」，但其中两个子标签根本不读 query。占位符说了筛不到的东西，
     * 就是在教用户不信任这个输入框。
     * @param {{view?: string, editing?: boolean, previewTab?: string}} [scope] - 当前位置。
     * @returns {string} 占位符。
     */
    function searchHint(scope) {
      const { view, editing, previewTab } = scope ?? {}
      if (editing) return '筛选段落、消息或工具…'
      if (view === 'sessions') return '筛选会话…'
      if (view === 'plugins') return '筛选插件…'
      if (view === 'tools') return '筛选工具…'
      if (view === 'disable') return '筛选影响项、配置键或诊断…'
      if (view !== 'preview') return '筛选…'
      if (previewTab === 'prompt') return '筛选提示词段…'
      if (previewTab === 'tools') return '筛选工具…'
      // 请求结构没有可筛的列表，只有下方文本检索；页头不装作能筛，回车把词交棒下去。
      if (previewTab === 'raw') return '此标签用下方文本检索'
      // 消息标签按消息与分段筛：只说它真的会筛的东西。
      return '筛选消息、分段或 skill…'
    }

    /**
     * 页头筛选的统一空状态。
     *
     * 搜索框在页头、结果在正文，打完字看到空白时用户分不清「没命中」与「页面坏了」。
     * 所以固定给「没有匹配的 X」和一个清除出口；`extra` 留给同页还有别的筛选条件的场合。
     * @param {{noun?: string, onClear?: Function, extra?: object}} [opts] - 名词、清除回调、附加节点。
     * @returns {object} React 节点。
     */
    function renderQueryEmpty(opts) {
      const { noun, onClear, extra } = opts ?? {}
      const hasAction = typeof onClear === 'function'
      return h(
        'div',
        { className: 'ptEmpty' },
        '没有匹配的' + (noun ?? '条目') + '。',
        !hasAction && extra === undefined
          ? null
          : h(
              'div',
              { style: { marginTop: '10px' } },
              hasAction
                ? h('button', { type: 'button', className: 'ptTextBtn', onClick: onClear }, '清除搜索')
                : null,
              extra ?? null,
            ),
      )
    }

    return function create() {
      /**
       * 生成一个搜索框。
       *
       * 颜色槽优先用空的，用满后按编号取模复用；编号 `no` 只增不减，
       * 删除中间的搜索框不会让后面的编号重排——用户记住的「2 号搜索」始终指同一个框。
       * @param {object[]} items - 现有搜索框。
       * @param {number} no - 新搜索框编号。
       * @param {string} [text] - 可选的初始搜索词（页头交棒用）。
       * @returns {object} 新搜索框。
       */
      function makeSearchItem(items, no, text) {
        const used = new Set(items.map((item) => item.slot))
        let slot = 0
        while (slot < SLOT_COUNT && used.has(slot)) slot++
        return { id: 'search-' + no, no, slot: slot % SLOT_COUNT, text: typeof text === 'string' ? text : '', cursor: 0 }
      }

      /** 一份页内搜索列表：会话页与预演页各调用一次，互不影响。 */
      function useSearchState() {
        const [items, setItems] = useState([])
        // 编号放在 ref 里：state updater 可能被 React 重放，计数器不能写进 updater。
        const nextNo = useRef(1)
        // 删除搜索框后焦点要回到「＋ 添加搜索」：按钮的 ref 由渲染层挂上。
        const addButtonRef = useRef(null)
        /**
         * 添加一个搜索框。
         * @param {string} [text] - 可选的初始搜索词：页头会把「请求结构」标签里的词交棒进来。
         */
        const add = useCallback((text) => {
          const no = nextNo.current++
          setItems((prev) => [...prev, makeSearchItem(prev, no, text)])
        }, [])
        const update = useCallback((id, text) => {
          // 改词后回到第 1 处：旧游标对新的命中集合没有意义。
          setItems((prev) => prev.map((item) => (item.id === id ? { ...item, text, cursor: 0 } : item)))
        }, [])
        const setCursor = useCallback((id, cursor) => {
          setItems((prev) => prev.map((item) => (item.id === id ? { ...item, cursor } : item)))
        }, [])
        const remove = useCallback((id) => {
          setItems((prev) => prev.filter((item) => item.id !== id))
          // 等 React 把被删的输入框卸载掉再聚焦，否则焦点会在卸载时掉回 body。
          const focusAdd = () => {
            const button = addButtonRef.current
            if (button !== null && button !== undefined && typeof button.focus === 'function') button.focus()
          }
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusAdd)
          else focusAdd()
        }, [])
        return { items, add, update, setCursor, remove, addButtonRef }
      }

      /**
       * 一段文本里的命中区间。
       *
       * 字面子串、不区分大小写；空搜索词与纯空白不参与匹配。重叠时按
       * 「起点更早 → 更长 → 列表靠前」取舍，保证不会产生嵌套的 <mark>。
       * @param {string} text - 文本。
       * @param {object[]} items - 搜索框列表。
       * @returns {{start: number, end: number, qi: number}[]} 命中区间。
       */
      function findHits(text, items) {
        if (typeof text !== 'string' || text.length === 0) return []
        const haystack = text.toLowerCase()
        const hits = []
        items.forEach((item, qi) => {
          const needle = typeof item.text === 'string' ? item.text.trim() : ''
          if (needle === '') return
          const target = needle.toLowerCase()
          let from = 0
          while (from <= haystack.length - target.length) {
            const at = haystack.indexOf(target, from)
            if (at < 0) break
            hits.push({ start: at, end: at + target.length, qi })
            from = at + target.length
          }
        })
        hits.sort((left, right) => left.start - right.start || right.end - left.end || left.qi - right.qi)
        const kept = []
        let cursor = 0
        for (const hit of hits) {
          if (hit.start < cursor) continue
          kept.push(hit)
          cursor = hit.end
        }
        return kept
      }

      /**
       * 高亮器：跨多个文本块共用同一份计数。
       *
       * 徽标写的是**搜索框编号**而不是命中序号，所以渲染顺序不影响编号；
       * 计数仍然跨块累加，工具行上的「N 处」才是整段文本的总数。
       * @param {object[]} items - 搜索框列表。
       * @returns {{text: Function, counts: number[], capped: boolean}} 高亮器。
       */
      function createHighlighter(items) {
        const counts = items.map(() => 0)
        let capped = false
        /**
         * 一处命中。
         *
         * 做成组件而不是直接建 `<mark>`，是因为「当前那一处」要等所有文本块都过一遍才定得下来：
         * 游标可能指到已经不存在的位置（内容变短、切换会话），读数会夹紧到最后一处，
         * 描边必须跟着夹紧。组件在父视图返回之后才真正渲染，此时 `counts` 已经是最终值。
         */
        function QueryMark({ item, qi, index, text: hitText }) {
          const total = counts[qi]
          const current = total > 0 && Math.min(item.cursor ?? 0, total - 1) === index
          return h('mark', {
            className: 'ptSearchMark',
            'data-search': item.slot,
            'data-box': item.no,
            'data-current': current ? 'true' : undefined,
            title: `搜索 ${item.no}「${String(item.text).trim()}」`,
          }, hitText)
        }
        /** 把一段文本切成「普通文本 / 命中标记」的 children。 */
        function text(value) {
          if (typeof value !== 'string' || value.length === 0) return value ?? ''
          const hits = findHits(value, items)
          if (hits.length === 0) return value
          const out = []
          let at = 0
          let rendered = 0
          for (const hit of hits) {
            if (rendered >= MAX_HITS_PER_TEXT) {
              capped = true
              break
            }
            if (hit.start > at) out.push(value.slice(at, hit.start))
            out.push(h(QueryMark, {
              key: 'hit-' + hit.start,
              item: items[hit.qi],
              qi: hit.qi,
              index: counts[hit.qi],
              text: value.slice(hit.start, hit.end),
            }))
            counts[hit.qi] += 1
            at = hit.end
            rendered += 1
          }
          if (at < value.length) out.push(value.slice(at))
          return out
        }
        return {
          text,
          counts,
          get capped() { return capped },
        }
      }

      /**
       * 把第 index 处命中滚进视野。
       *
       * 命中可能落在折叠块里：先把祖先 `<details>` 打开，否则 scrollIntoView 只会滚到一个
       * 不可见的节点。与「折叠全部」一样，这是页面内的显示状态，不改数据。
       * @param {number} no - 搜索框编号。
       * @param {number} index - 0 基命中序号。
       */
      function scrollToHit(no, index) {
        if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
        const nodes = document.querySelectorAll('.ptSearchMark[data-box="' + no + '"]')
        if (nodes.length === 0) return
        const node = nodes[Math.max(0, Math.min(index, nodes.length - 1))]
        let parent = node.parentElement
        while (parent !== null && parent !== undefined) {
          if (parent.tagName === 'DETAILS' && parent.open !== true) parent.open = true
          parent = parent.parentElement
        }
        node.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }

      /**
       * 搜索工具行：标题 + 永远存在的添加按钮 + 每个搜索框一行。
       *
       * 每行带 PDF 式的上/下定位：按 DOM 顺序在命中之间循环，当前命中加描边。
       * 循环而不是在两端停住，是为了让「下一处」在最后一处之后仍能继续读。
       * @param {{items: object[], add: Function, update: Function, setCursor: Function, remove: Function}} state - 搜索状态。
       * @param {number[]} counts - 每个搜索框的命中数。
       * @param {boolean} capped - 是否有文本块达到命中上限。
       * @returns {object} React 节点。
       */
      function renderSearchBar(state, counts, capped) {
        const { items, add, update, setCursor, remove } = state
        return h(
          'div',
          // 有搜索框时把整块工具行吸在滚动容器顶部：长文本下滑后仍能改词与上/下定位。
          // 只有「＋ 添加搜索」时保持普通文档流，不占住正文的顶部。
          { className: 'ptSearchTools', role: 'group', 'aria-label': '页内多词检索', 'data-docked': items.length > 0 ? 'true' : undefined },
          h(
            'div',
            { className: 'ptSearchToolsHead' },
            h('span', { className: 'ptSearchToolsTitle', title: '同时标出多个词：每个搜索框一种颜色，命中右上角的数字是搜索框编号' }, '文本检索'),
            h('button', { type: 'button', className: 'ptBtn', ref: state.addButtonRef, onClick: add, title: '添加一个搜索框；可以同时添加多个' }, '＋ 添加搜索'),
          ),
          items.length === 0
            ? null
            : h(
                'div',
                { className: 'ptSearchList' },
                items.map((item, index) => {
                  const total = counts?.[index] ?? 0
                  const cursor = total === 0 ? 0 : Math.min(item.cursor ?? 0, total - 1)
                  /** 在命中之间循环定位；空结果时按钮禁用，不跳。 */
                  const go = (delta) => {
                    if (total === 0) return
                    const next = (cursor + delta + total) % total
                    setCursor?.(item.id, next)
                    scrollToHit(item.no, next)
                  }
                  return h(
                    'div',
                    { key: item.id, className: 'ptSearchItem' },
                    h('span', { className: 'ptSearchSwatch', 'data-search': item.slot, title: `搜索 ${item.no} 的颜色与编号` }, String(item.no)),
                    h('input', {
                      className: 'ptSearch ptSearchInline',
                      type: 'search',
                      value: item.text,
                      placeholder: '输入要标出的文字…',
                      autoFocus: index === items.length - 1,
                      'aria-label': '搜索 ' + item.no,
                      onChange: (event) => update(item.id, event.target.value),
                      onKeyDown: (event) => {
                        // 输入法确认候选词时也会发 Enter / Escape（keyCode 229）。
                        // 那不是定位更不是清空，必须原样交给输入法。
                        if (event.nativeEvent?.isComposing === true || event.keyCode === 229) return
                        if (event.key === 'Enter') {
                          // Enter / Shift+Enter 与 PDF 查看器一致：下一处 / 上一处。
                          event.preventDefault()
                          go(event.shiftKey ? -1 : 1)
                          return
                        }
                        if (event.key !== 'Escape') return
                        // Esc 只清空这个词；不让页面级 Esc（收起详情/清空全局搜索）接手。
                        event.stopPropagation()
                        update(item.id, '')
                      },
                    }),
                    h(
                      'span',
                      { className: 'ptSearchNav' },
                      h('span', { className: 'ptSearchCount', title: '当前第几处 / 该搜索框的命中总数' }, total === 0 ? '0 处' : (cursor + 1) + '/' + total),
                      h('button', { type: 'button', className: 'ptTextBtn ptSearchNavBtn', disabled: total === 0, 'aria-label': `上一个命中（搜索 ${item.no}）`, title: '上一个命中', onClick: () => go(-1) }, '↑'),
                      h('button', { type: 'button', className: 'ptTextBtn ptSearchNavBtn', disabled: total === 0, 'aria-label': `下一个命中（搜索 ${item.no}）`, title: '下一个命中', onClick: () => go(1) }, '↓'),
                    ),
                    h('button', { type: 'button', className: 'ptTextBtn', 'aria-label': '删除搜索 ' + item.no, title: '删除这个搜索框', onClick: () => remove(item.id) }, '×'),
                  )
                }),
              ),
          capped
            ? h('p', { className: 'ptSectionNote' }, `命中过多，每个文本块只标出前 ${MAX_HITS_PER_TEXT} 处；把搜索词写得更具体可以缩小范围`)
            : null,
        )
      }

      return {
        useSearchState,
        makeSearchItem,
        findHits,
        createHighlighter,
        renderSearchBar,
        normalizeQuery,
        matchesQuery,
        markQuery,
        searchHint,
        renderQueryEmpty,
      }
    }
  },
})
