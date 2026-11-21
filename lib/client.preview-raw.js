/**
 * 预演页的「请求结构」标签：按一次真实请求的三块结构展示 system、messages 与 tools。
 *
 * 内容会很长，所以每段独立折叠；顶部的全收 / 全开按钮直接操作 `.ptRawBlock`。
 * 页内多词搜索也从这里接入：工具行在正文构建完成后才生成，才能拿到完整命中数。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.preview-raw.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.preview-raw.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { formatBytes, textButton, rowEnd, foldNodes, setDetailsOpen, search } = deps

      /**
       * 请求结构里的一段内容：独立折叠，默认折叠。
       *
       * 这几段是「真实请求长这样」的证据，system 与 messages 动辄上万字；默认全部收起，
       * 才能先一眼看全 system → messages → tools 的结构，不必滚很久才能到下一段。
       * 每段都带箭头与右侧长度，收起时也读得出规模；要看正文再单独展开。
       * @param {string} key - React key。
       * @param {string} name - 主名，如 `messages[2]`。
       * @param {string[]} tags - 次要标签（sourceKind / role / 项数）。
       * @param {string} size - 右侧的长度读数。
       * @param {object} body - 展开后的内容。
       * @returns {object} React 节点。
       */
      function rawBlock(key, name, tags, size, body) {
        return h(
          'details',
          { key, className: 'ptPromptBlock ptFold ptFoldable ptRawBlock' },
          h(
            'summary',
            null,
            h('span', { className: 'ptFoldChevron', 'aria-hidden': 'true' }, '▶'),
            h('span', { className: 'ptPromptName' }, name),
            ...tags.map((tag) => h('span', { key: tag, className: 'ptTag' }, tag)),
            rowEnd(h('span', { className: 'ptCount', title: '长度，这段内容的字符数' }, size)),
          ),
          body,
        )
      }

      /**
       * 渲染请求结构：system → 每条消息 → tools → envelope。
       *
       * 搜索只标正文：标题、标签与 envelope 不参与，避免把结构读数当成提示词内容。
       * @param {object} preview - 预演结果。
       * @param {object} vc - 视图上下文（页内搜索状态在这里）。
       * @returns {object} React 节点。
       */
      function renderRawStructure(preview, vc) {
        const state = vc?.previewSearch
        const hl = search.createHighlighter(Array.isArray(state?.items) ? state.items : [])
        const blocks = [
          rawBlock(
            'system',
            'messages[0]',
            ['role=system'],
            formatBytes(preview.systemText.length),
            h('pre', { className: 'ptPromptText' }, hl.text(preview.systemText)),
          ),
          // 这里按**真实顺序**列出消息。早先版本把 messages[1..] 统一标成 runtime context，
          // 而实际上它们依次是 user / agent-instructions / runtime-context / skill-catalog / time-context。
          ...(preview.messages ?? []).map((message) => rawBlock(
            'message-' + message.index,
            'messages[' + message.index + ']',
            [message.sourceKind, 'role=' + message.role],
            formatBytes(message.length),
            message.length > 0
              ? h('pre', { className: 'ptPromptText' }, hl.text(message.text))
              : h('p', { className: 'ptSub', style: { margin: 0, padding: '10px 12px' } }, '（未输入首条消息）'),
          )),
          rawBlock(
            'tools',
            'tools',
            [preview.tools.length + ' 项'],
            formatBytes(preview.stats.toolSchemaChars),
            h(
              'pre',
              { className: 'ptPromptText' },
              hl.text(JSON.stringify(
                preview.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
                null,
                2,
              )),
            ),
          ),
        ]
        return h(
          'div',
          null,
          // 请求结构会很长：每一段都可折叠，顶部再给一次全收 / 全开。
          h(
            'div',
            { className: 'ptSectionHead' },
            h('span', { className: 'ptMeta' }, '按真实发送顺序，逐段可折叠'),
            h(
              'div',
              { className: 'ptActions' },
              textButton('折叠全部', () => setDetailsOpen(foldNodes('.ptBody details.ptRawBlock'), false), { title: '收起请求结构里的所有内容段' }),
              textButton('展开全部', () => setDetailsOpen(foldNodes('.ptBody details.ptRawBlock'), true), { title: '展开请求结构里的所有内容段' }),
            ),
          ),
          // 工具行放在正文之后构建：这时 hl.counts 才统计完所有块。
          state ? search.renderSearchBar(state, hl.counts, hl.capped) : null,
          ...blocks,
          preview.messages === undefined
            ? h('p', { className: 'ptSub' }, '消息未采集：这份响应来自旧版本')
            : null,
          h(
            'p',
            { className: 'ptSectionTitle', style: { marginTop: '14px' } },
            `request envelope · provider=${preview.envelope?.provider ?? '未知'} · model=${preview.envelope?.model ?? '未知'}`
            + ` · contextWindow=${preview.envelope?.contextWindow === null || preview.envelope?.contextWindow === undefined ? '未知' : preview.envelope.contextWindow.toLocaleString()}`
            + ' —— 不进 messages，是请求本身的字段',
          ),
        )
      }

      return { renderRawStructure }
    }
  },
})
