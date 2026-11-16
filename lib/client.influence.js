/**
 * 会话影响视图：一个会话的**首次请求**实际收到了什么。
 *
 * 提示词页读注册表；这里读会话日志，回答「谁加了这条 user-role 消息」「实际工具集与
 * 预测差在哪」「额外 LLM 请求有哪些」，并按日志 seq 还原 system / tools / messages 的顺序。
 * 本文件是一个包内 chunk：入口用 `require.async('./client.influence.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-console',
  chunk: 'client.influence.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useState } = React

    return function create(deps) {
      const { formatBytes, shortModule, fetchJson, rowEnd, SESSION_INFLUENCE_ROUTE, schema, search } = deps

      /** 插件名标签；优先短名，title 保留全名。 */
      function ownerTags(owners) {
        if (!Array.isArray(owners) || owners.length === 0) {
          return h('span', { className: 'ptTag', 'data-tone': 'warn', title: '未归属：源码扫描没有找到注册点' }, '未归属')
        }
        return owners.map((owner) =>
          h('span', { key: owner, className: 'ptTag', title: '注册插件：' + owner }, shortModule(owner)),
        )
      }

      /**
       * 一个可折叠的文本块。
       * @param {Function} hl - 页内搜索高亮器；正文命中会按搜索框颜色与编号标出。
       */
      function textFold(key, title, meta, text, hl, open = false) {
        return h(
          'li',
          { key },
          h(
            'details',
            { className: 'ptPromptBlock ptFold ptFoldable', ...(open ? { open: true } : {}) },
            h(
              'summary',
              null,
              h('span', { className: 'ptPromptName' }, hl.text(title)),
              rowEnd(meta !== undefined
                ? h('span', { className: 'ptCount', title: '长度：这份文本的字符数（按 B / KB 显示）' }, meta)
                : null),
            ),
            // 单段原文不再各自限高：外层「首次请求分析」已经给整块 320px 窗口，
            // 里面再套一层小窗口会变成两层滚动条。
            h('pre', { className: 'ptPromptText' }, hl.text(text || '（空）')),
          ),
        )
      }

      /**
       * 实际请求下的子区块。
       *
       * 标题必须比「实际请求」低一级并缩进，否则读起来像同一页的并列区块；
       * 这是版式约束，不是样式偏好。
       * @param {string} title - 子区块标题。
       * @param {...object} children - 子区块内容。
       * @returns {object} React 节点。
       */
      function subSection(title, ...children) {
        return h(
          'div',
          { className: 'ptSubSection' },
          h('p', { className: 'ptSubTitle' }, title),
          ...children,
        )
      }

      /**
       * 一条工具 schema：默认收起，展开是描述与结构化参数；序号就是 request/header 的数组顺序。
       * @param {object} tool - 工具定义。
       * @param {number} index - 发送顺序。
       * @param {object} vc - 视图上下文（原文开关按会话日志里的工具记）。
       * @param {Function} hl - 页内搜索高亮器：只标描述，不标参数表里的字段说明。
       * @returns {object} React 节点。
       */
      function toolSchemaRow(tool, index, vc, hl) {
        return h('li', { key: tool.name },
          h('details', { className: 'ptToolBlock ptFold ptFoldable' },
            h('summary', null,
              // 工具名也是用户会去搜的可见文字：只标描述的话，搜 `read` 会显示 0 处，
              // 而屏幕上明明写着 `#1 read`。名字与描述都过一遍高亮。
              h('span', { className: 'ptDepKey' }, hl.text('#' + index + ' ' + tool.name)),
              tool.deferLoading ? h('span', { className: 'ptTag', title: '延迟加载：模型真正需要时才载入这份 schema' }, 'lazy') : null,
            ),
            h('div', { className: 'ptFoldBody' },
              tool.description
                ? h('p', { className: 'ptToolDesc', style: { margin: 0 } }, hl.text(tool.description))
                : h('p', { className: 'ptSub', style: { margin: 0 } }, '（无描述）'),
              tool.parameters !== undefined
                ? schema.renderParameters(tool, { vc, source: 'session' })
                : null,
            ),
          ),
        )
      }

      /**
       * 首次请求里的工具定义：schema 来自 request/header，按数组顺序原样展示。
       *
       * 会话页只回答「模型收到了什么」；工具归属与 scope 分层属于推断，工具页已经按来源分组，
       * 这里不再重复，也不重排顺序。
       */
      function toolSetSection(data, vc, hl) {
        const header = data.request?.header
        const schemas = Array.isArray(header?.toolSchemas) ? header.toolSchemas : []
        if (schemas.length === 0) return null
        return subSection(
          '2 · 工具定义（tools，' + schemas.length + ' 个，按发送顺序）',
          h('div', { className: 'ptWindow' },
            h('ul', { className: 'ptList' }, schemas.map((tool, index) => toolSchemaRow(tool, index + 1, vc, hl))),
          ),
        )
      }

      /**
       * 渲染一个会话的首次请求摘要：system → tools → messages，再排诊断。
       * @param {object} session - 会话记录。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderSessionInfluence(session, vc) {
        const data = vc.sessionInfluence?.get?.(session.id)
        const status = vc.sessionInfluenceStatus?.get?.(session.id)
        const head = h('p', { className: 'ptSectionTitle' }, '首次请求分析')

        if (data === undefined) {
          return h(
            'div',
            { className: 'ptSection' },
            head,
            h('p', { className: 'ptSub', style: { margin: 0 } }, status === 'error' ? '读取失败。' : '正在读取会话日志…'),
          )
        }
        if (data.available !== true) {
          return h(
            'div',
            { className: 'ptSection' },
            head,
            h('p', { className: 'ptSub', style: { margin: 0 } }, h('span', { className: 'ptError' }, data.reason ?? '没有可读的会话数据。')),
          )
        }

        const request = data.request ?? {}
        const header = request.header
        const context = request.context
        const nameOwners = vc.snapshot?.prompt?.nameOwners ?? {}
        const runtimeSections = data.runtimeContext?.sections ?? []
        // 页内搜索只覆盖「首次请求分析」这一块正文；外层的额外 LLM 请求是另一份请求，不共用。
        const searchState = vc.sessionSearch
        const hl = search.createHighlighter(Array.isArray(searchState?.items) ? searchState.items : [])
        const sourceLabel = data.source === 'live' ? '活会话内存' : 'session log'
        const facts = [
          sourceLabel,
          context?.provider !== undefined ? context.provider + ' / ' + context.model : null,
          context?.contextWindow !== undefined ? '窗口 ' + context.contextWindow : null,
          '系统提示词 ' + formatBytes(data.system?.length ?? 0),
          header !== undefined ? '实际工具 ' + header.toolCount : null,
        ].filter((value) => value !== null)
        // 日志里没有的类别不再单独列提示：缺失内容在对应位置自然为空，避免再加一行说明。

        // 首次请求正文的顺序：system → tools → messages。消息块按日志 seq 排：
        // 同一步里 user / agent-instructions / runtime-context / skill-catalog /
        // time-context 的真实先后由服务端写入顺序决定，不能按注册顺序猜。
        const at = (value) => (typeof value === 'number' ? value : Number.MAX_SAFE_INTEGER)
        const messageBlocks = []
        if (data.firstUser !== undefined) {
          messageBlocks.push({
            seq: at(data.firstUser.seq),
            render: (index) => subSection(
              '消息 ' + index + ' · 首条用户消息（' + data.firstUser.blocks?.length + ' 块）',
              h('ul', { className: 'ptList' }, (data.firstUser.blocks ?? []).map((block, index) =>
                h('li', { key: index },
                  h('details', { className: 'ptPromptBlock ptFold ptFoldable', open: block.injection !== undefined ? true : undefined },
                    h('summary', null,
                      h('span', { className: 'ptPromptName' }, '块 ' + (index + 1) + ' · ' + block.type),
                      block.injection !== undefined
                        ? h('span', { className: 'ptTag', 'data-tone': 'user', title: '由子 Agent 派发链追加；父会话的 tool/call 参数里没有这段' }, '派发指引')
                        : null,
                      ownerTags(block.injectedBy === undefined ? [] : [block.injectedBy]),
                      rowEnd(h('span', { className: 'ptCount', title: '长度：这个块的字符数（按 B / KB 显示）' }, formatBytes(block.length ?? 0))),
                    ),
                    h('pre', { className: 'ptPromptText' }, hl.text(block.text ?? ('[' + block.type + ']'))),
                  ),
                ),
              )),
            ),
          })
        }
        if (runtimeSections.length) {
          messageBlocks.push({
            seq: at(data.runtimeContext?.seq),
            render: (index) => subSection(
              h('span', null,
                '消息 ' + index + ' · ',
                h('span', { title: '作为user message的一部分注入上下文，注册表中无此内容' }, '运行时上下文'),
                '（' + runtimeSections.length + ' 段）',
              ),
              h('ul', { className: 'ptList' }, runtimeSections.map((section, index) =>
                h('li', { key: String(section.name ?? index) },
                  h('details', { className: 'ptPromptBlock ptFold ptFoldable' },
                    h('summary', null,
                      h('span', { className: 'ptPromptName' }, hl.text(section.name ?? '（未命名）')),
                      ownerTags(nameOwners[section.name] ?? data.runtimeContext?.owner),
                      rowEnd(h('span', { className: 'ptCount', title: '长度：这一段的字符数（按 B / KB 显示）' }, formatBytes(section.length ?? 0))),
                    ),
                    h('pre', { className: 'ptPromptText' }, hl.text(section.text ?? '')),
                  ),
                ),
              )),
            ),
          })
        }
        if (data.skillCatalog !== undefined) {
          messageBlocks.push({
            seq: at(data.skillCatalog.seq),
            render: (index) => subSection(
              h('span', null,
                '消息 ' + index + ' · ',
                h('span', { title: 'skills目录信息作为user message一部分注入上下文' }, 'skill 目录'),
                '（' + data.skillCatalog.entries.length + '）',
              ),
              h('ul', { className: 'ptList' }, data.skillCatalog.entries.map((entry, entryIndex) =>
                toolSchemaRow({ name: entry.name, description: entry.description }, entryIndex + 1, vc, hl),
              )),
            ),
          })
        }
        if (data.timeContext !== undefined) {
          messageBlocks.push({
            seq: at(data.timeContext.seq),
            render: (index) => subSection(
              '消息 ' + index + ' · 时间快照（' + data.timeContext.count + ' 次）',
              h('ul', { className: 'ptList' }, (data.timeContext.sections ?? []).map((section, index) =>
                textFold('time-' + index, section.name ?? 'time-context', formatBytes(section.length ?? 0), section.text ?? '', hl),
              )),
            ),
          })
        }
        if ((data.injections ?? []).length) {
          messageBlocks.push({
            seq: at(data.injections[0].seq),
            render: (index) => subSection(
              '消息 ' + index + ' · 其它消息注入（' + data.injections.length + '）',
              h('ul', { className: 'ptList' }, data.injections.map((message, index) =>
                textFold(
                  'msg-' + index,
                  message.sourceKind + (message.form === undefined ? '' : ' · ' + message.form),
                  formatBytes(message.length ?? 0),
                  message.text ?? '',
                  hl,
                ),
              )),
            ),
          })
        }
        messageBlocks.sort((left, right) => left.seq - right.seq)
        const messageCount = [data.firstUser, data.runtimeContext, data.skillCatalog, data.timeContext]
          .filter((value) => value !== undefined).length + (data.injections ?? []).length
        if (messageCount > 0) facts.push('消息 ' + messageCount + ' 条')
        // 子区块统一装进一个带左竖线的容器：标题降一级，才不会被读成并列区块。
        const body = h(
          'div',
          { className: 'ptSubBlocks' },
          // 1. system：首次请求实际发送的最终文本（host 已锚定到首个 request/header）。
          data.system?.text
            ? subSection(
                '1 · 系统提示词（system prompt）',
                h('pre', { className: 'ptPromptText ptWindow' }, hl.text(data.system.text)),
                data.system.truncated ? h('p', { className: 'ptSectionNote', style: { margin: '6px 0 0' } }, '日志里的系统提示词超过展示上限（' + (data.system.limit ?? 200000) + ' 字），下面是前 ' + data.system.text.length + ' 字，完整 ' + data.system.length + ' 字。') : null,
              )
            : null,
          // 2. tools：日志里本来就有完整 schema，不是只有名字。
          toolSetSection(data, vc, hl),
          // 3. messages：按日志 seq 排列，system 与 tools 在它们之前。
          messageBlocks.length
            ? subSection(
                '3 · 消息（' + messageCount + ' 条，按发送顺序）',
                h('div', { className: 'ptWindow ptMessageList' }, messageBlocks.map((block, index) => block.render(index + 1))),
              )
            : null,
        )
        // 工具行在正文构建完成后才生成：此时 hl.counts 已统计完 system / tools / messages。
        const searchBar = searchState
          ? search.renderSearchBar(searchState, hl.counts, hl.capped)
          : null
        const auxiliaryBlock = (data.auxiliary ?? []).length
          ? h('details', { className: 'ptFold ptFoldable' },
              h('summary', null, h('span', null, '额外 LLM 请求（' + data.auxiliary.length + ' 个）')),
              h('div', { className: 'ptFoldBody' },
                h('ul', { className: 'ptList' }, data.auxiliary.map((request, index) =>
                  h('li', { key: index },
                    h('details', { className: 'ptPromptBlock ptFold ptFoldable' },
                      h('summary', null,
                        h('span', { className: 'ptPromptName' }, request.type),
                        ownerTags(request.owner),
                        rowEnd(h('span', { className: 'ptCount', title: '长度：这次请求 system 文本的字符数（按 B / KB 显示）' }, formatBytes(request.system?.length ?? 0))),
                      ),
                      h('pre', { className: 'ptPromptText' }, request.system?.text ?? ''),
                      h('p', { className: 'ptSub', style: { margin: '6px 0 0' } },
                        'route ' + JSON.stringify(request.route ?? null) + ' · maxTokens ' + (request.maxTokens ?? '—') + ' · 消息 ' + request.messageCount + ' 条',
                      ),
                    ),
                  ),
                )),
              ),
            )
          : null

        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'ptSection' },
            head,
            h('p', { className: 'ptSub', style: { margin: '2px 0 6px' } }, facts.join(' · ')),
            searchBar,
            body,
          ),
          auxiliaryBlock,
        )
      }

      /**
       * 单会话的实际请求摘要。
       *
       * 按会话懒读：日志可能很长，没必要在打开面板时把所有会话都读一遍。
       * 状态也按会话记，因为用户可能展开一个又切到另一个。
       */
      function useSessionInfluenceStore() {
        const [influenceById, setInfluenceById] = useState(() => new Map())
        const [statusById, setStatusById] = useState(() => new Map())

        const loadSessionInfluence = useCallback(async (sessionId) => {
          if (typeof sessionId !== 'string') return
          setStatusById((prev) => new Map(prev).set(sessionId, 'loading'))
          try {
            const data = await fetchJson(SESSION_INFLUENCE_ROUTE + '?id=' + encodeURIComponent(sessionId))
            setInfluenceById((prev) => new Map(prev).set(sessionId, data))
            setStatusById((prev) => new Map(prev).set(sessionId, 'ready'))
          } catch (cause) {
            setInfluenceById((prev) => new Map(prev).set(sessionId, {
              available: false,
              reason: cause instanceof Error ? cause.message : String(cause),
            }))
            setStatusById((prev) => new Map(prev).set(sessionId, 'error'))
          }
        }, [])

        return { influenceById, statusById, loadSessionInfluence }
      }

      return { renderSessionInfluence, useSessionInfluenceStore }
    }
  },
})
