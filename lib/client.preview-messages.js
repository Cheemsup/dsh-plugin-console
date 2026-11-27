/**
 * 预演页的「消息与注入」标签：首请求里 user-role 消息的完整清单与溯源。
 *
 * 它回答的是系统提示词标签回答不了的问题：请求里除了 system 与 tools，还有几条
 * 由 pre-step 监听器注入的 user 消息。每行给出 `#序号 · source.kind · 大小 · 归属 ·
 * 置信度`，展开是分段与完整原文；机制/依据只在还能解释模型可见内容时留在正文，
 * skill 目录与 `/name` 资源基座这类「内容从哪来」的信息收进容器标题的悬停提示。
 *
 * 置信度是这一页的立身之本：`实测` 是从活注册表/装配直接读到的，`推导` 是用同一份
 * 配置与文件算出来的，`未知` 是取决于尚未提供的输入（例如首条消息）。把推导说成
 * 实测，比不给答案更糟。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.preview-messages.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.preview-messages.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    /** 置信度的界面说法；host 那边用的是英文枚举。 */
    const CONFIDENCE = {
      measured: { label: '实测', hint: '从活注册表或装配结果直接读取' },
      derived: { label: '推导', hint: '使用配置、文件或者服务进行的确定性推导' },
      unknown: { label: '未知', hint: '取决于尚未提供的输入，例如首条消息或未选工作区' },
      unavailable: { label: '不可用', hint: '前置条件缺失，无法采集' },
    }

    /**
     * 正文里还保留「机制 · 依据」一行的消息。
     *
     * 其余消息的这行元信息要么没有信息量（user、runtime-context、time-context），
     * 要么更适合回答「内容从哪来」——skill 目录与 `/name` 资源基座收进容器标题的悬停提示。
     */
    const MECHANISM_IN_BODY = new Set(['agent-instructions'])

    /** skill 目录的获取渠道：只回答目录从哪来，不展开 pre-step 机制。 */
    const CATALOG_SOURCE_HINT = 'skill 目录来自工作区、预设与 skills-service'

    /** 段内容推不出来时的占位：不要留白，也不要假装预测到了空内容。 */
    const UNPREDICTABLE = '此项运行时内容无法预测'

    /** 「影响条件」标签里的条件代号 → 界面说法；悬停提示要靠它把 workspace 这类英文讲清楚。 */
    const BASIS_HINTS = {
      workspace: '工作区路径',
      preset: '预设模式',
      permission: '权限预设（sandbox / approval）',
      'skills-service': 'skill 服务注册的目录',
      draft: '首条消息草稿',
      'client-time-zone': '客户端时区',
    }

    return function create(deps) {
      const { formatBytes, shortModule, textButton, rowEnd, foldNodes, setDetailsOpen, search } = deps

      /** 一条消息（含它的分段 / skill 条目 / 文件清单）是否命中页头搜索。 */
      function messageMatches(message, query) {
        if (search.matchesQuery(query, [message.sourceKind, message.role, message.text])) return true
        return (message.parts ?? []).some((part) => partMatches(part, query))
      }

      /** 分段、skill 条目与文件条目：名字、说明、正文都算用户会去搜的可见文字。 */
      function partMatches(part, query) {
        return search.matchesQuery(query, [part?.name, part?.displayPath, part?.description, part?.text, part?.source])
      }

      /** 置信度标签：文字只有「实测 / 推导」，种类靠悬停标题交代。 */
      function confidenceTag(value) {
        const meta = CONFIDENCE[value]
        if (meta === undefined) return null
        return h(
          'span',
          {
            className: 'ptTag',
            'data-tone': value === 'unknown' || value === 'unavailable' ? 'warn' : undefined,
            title: '置信度：' + meta.hint,
          },
          meta.label,
        )
      }

      /**
       * 消息来源的行标签。
       *
       * 这里给出的是包名，而插件页的跳转要的是 Loader 行 id，所以先按 moduleName
       * 回查一次；查不到就只显示名字，不做一个跳不到任何地方的按钮。
       * @param {string[]} owners - 包名列表。
       * @param {object} vc - 视图上下文。
       * @returns {Array<object>} 标签节点。
       */
      function ownerTags(owners, vc) {
        if (!Array.isArray(owners) || owners.length === 0) return []
        // 注册表里的 owners 可能因为多个注册点指向同一插件而重复；标签只留一份。
        const entries = vc.snapshot?.entries ?? []
        const rowOf = (owner) => entries.find((entry) => entry.rowId === owner)
          ?? entries.find((entry) => entry.moduleName === owner)
        return [...new Set(owners)].map((owner) => {
          const row = rowOf(owner)
          if (row === undefined) return h('span', { key: owner, className: 'ptTag', title: `可能的插件来源，快照里没有这一行` }, shortModule(owner))
          return h(
            'button',
            {
              key: owner,
              type: 'button',
              className: 'ptTag ptLink',
              title: '可能的插件来源，点击跳转查看',
              onClick: (event) => {
                event.preventDefault()
                event.stopPropagation()
                vc.gotoPlugin(row.rowId ?? row.entryId)
              },
            },
            row.rowId ?? shortModule(owner),
          )
        })
      }

      /** agent-instructions 的文件清单：哪些进了预算、哪些被略过。 */
      function fileList(files, query) {
        if (!Array.isArray(files) || files.length === 0) return null
        return h(
          'ul',
          { className: 'ptList', style: { margin: '8px 12px 0' } },
          files.map((file) => h(
            'li',
            { key: file.displayPath, className: 'ptSub', style: { margin: 0 } },
            h('span', { className: 'ptDepKey' }, search.markQuery(file.displayPath, query)),
            h('span', { className: 'ptCount', style: { marginLeft: '6px' } }, formatBytes(file.bytes ?? 0)),
            file.included
              ? h('span', { className: 'ptTag', style: { marginLeft: '6px' } }, '已包含')
              : h('span', { className: 'ptTag', 'data-tone': 'warn', style: { marginLeft: '6px' } }, '被预算略过'),
            file.truncated ? h('span', { className: 'ptTag', 'data-tone': 'warn', style: { marginLeft: '4px' } }, '已截断') : null,
          )),
        )
      }

      /** 上下文分段在「本模式」里的关系：同名替换 / 只在本模式出现。 */
      function contextRelation(overrides, name) {
        if ((overrides?.overridden ?? []).some((row) => row.name === name)) return '本模式替换'
        if ((overrides?.added ?? []).some((row) => row.name === name)) return '本模式追加'
        return null
      }

      /**
       * runtime-context 的分段：每段一个可展开的子容器。
       *
       * 摘要给来源（order、大小、置信度、注册插件、影响条件），展开给这一段真正注入的文本；
       * 没有文本时写清「无法预测」，而不是留一个空容器让人以为模型收到的是空内容。
       */
      function segmentList(segments, vc, query) {
        if (!Array.isArray(segments) || segments.length === 0) return null
        const overrides = vc.preview?.scopeOverrides?.contexts
        // 实测段的归属来自上下文注册表；host 只内建了三条推导段的 owner。
        const registry = new Map((vc.snapshot?.prompt?.contexts ?? []).map((row) => [row.name, row]))
        const visible = segments.filter((segment) => partMatches(segment, query))
        if (visible.length === 0) return null
        return h(
          'ul',
          { className: 'ptList', style: { margin: '8px 12px 0' } },
          visible.map((segment, index) => {
            const relation = contextRelation(overrides, segment.name)
            const owners = (segment.owners ?? []).length > 0
              ? segment.owners
              : registry.get(segment.name)?.owners ?? []
            const text = typeof segment.text === 'string' ? segment.text : ''
            // 命中的分段自动展开，否则用户只看到一个段名，还得自己点开确认。
            // 从禁用预演跳过来的分段同样要展开，并挂上滚动锚点。
            const hit = search.matchesQuery(query, [segment.name, text])
            const focused = vc.focusSection === segment.name
            return h(
              'li',
              { key: segment.name },
              h(
                'details',
                {
                  className: 'ptToolBlock ptFold ptFoldable',
                  ...(focused ? { open: true, id: 'pt-section-focus' } : (hit ? { open: true } : {})),
                },
                h(
                  'summary',
                  null,
                  h('span', { className: 'ptDepKey', title: '名称：这一段在 DSH 上下文注册表里的名字' }, search.markQuery('#' + (index + 1) + ' ' + segment.name, query)),
                  confidenceTag(segment.confidence),
                  ...ownerTags(owners, vc),
                  relation === null
                    ? null
                    : h('span', { className: 'ptTag', title: '与全局的关系：全局有同名上下文、本模式重新注册了一份；或全局没有、只在本模式出现' }, relation),
                  (segment.basis ?? []).length > 0
                    ? h(
                        'span',
                        {
                          className: 'ptTag',
                          // 「依据」听起来像在重复「推导」。这里改答另一个问题：改哪些条件会改这段文字。
                          title: '影响条件：'
                            + segment.basis.map((token) => BASIS_HINTS[token] ?? token).join('、'),
                        },
                        segment.basis.join(' / '),
                      )
                    : null,
                  segment.reason === undefined
                    ? null
                    : h('span', { className: 'ptTag', 'data-tone': 'warn', title: '预测结果：' + segment.reason }, '未预测'),
                  // 顺序与大小是读数，统一靠右，正文左侧只留「这是什么」。
                  rowEnd(
                    typeof segment.order === 'number'
                      ? h('span', { className: 'ptCount', title: '顺序：DSH order，决定这一段在 runtime-context 快照里的先后' }, 'order ' + segment.order)
                      : null,
                    h('span', { className: 'ptCount', title: '长度：这一段注入文本的字符数（按 B / KB 显示）' }, formatBytes(segment.length ?? text.length)),
                  ),
                ),
                h(
                  'div',
                  { className: 'ptFoldBody' },
                  text.length === 0
                    ? h('p', { className: 'ptSub', style: { margin: 0 } }, UNPREDICTABLE)
                    : h('pre', { className: 'ptPromptText', style: { margin: 0 } }, search.markQuery(text, query)),
                ),
              ),
            )
          }),
        )
      }

      /**
       * 注册了、但没有进入这条 runtime-context 的上下文。
       *
       * 装配结果里文本为空的段会被 loop 过滤掉——模型收不到，所以不能说成「收到空内容」。
       * 这里把它们单独列出来并写明原因，取代旧「运行时上下文」标签里的空行；每项也是
       * 一个子容器，展开给统一的占位文案，免得「点开什么都没有」被当成渲染坏了。
       * @param {object} vc - 视图上下文。
       * @param {string} query - 页头搜索词。
       * @returns {object | null} 说明块。
       */
      function skippedContextList(vc, query) {
        const contexts = vc.preview?.contexts ?? []
        const parts = vc.preview?.messages?.find((row) => row.sourceKind === 'runtime-context')?.parts ?? []
        const inMessage = new Set(parts.map((row) => row.name))
        const assembled = contexts.filter((row) => !inMessage.has(row.name))
        const assembledNames = new Set(contexts.map((row) => row.name))
        const registry = new Map((vc.snapshot?.prompt?.contexts ?? []).map((row) => [row.name, row]))
        const unassembled = (vc.snapshot?.prompt?.contexts ?? []).filter((row) => !assembledNames.has(row.name))
        if (assembled.length === 0 && unassembled.length === 0) return null
        const rows = [
          ...assembled.map((row) => ({
            name: row.name,
            length: row.length,
            // 标签只回答「为什么没有文本」；「模型收不到」是这份列表本身的意思，不再重复。
            reason: '内容为空',
            owners: registry.get(row.name)?.owners ?? [],
          })),
          ...unassembled.map((row) => ({
            name: row.name,
            length: undefined,
            reason: '没有进入本次装配（注册条件未满足，或被 complete 独占段挡住）',
            owners: row.owners ?? [],
          })),
        ]
        const visible = rows.filter((row) => search.matchesQuery(query, [row.name, row.reason]))
        if (visible.length === 0) return null
        return h(
          'div',
          { style: { margin: '10px 12px 0' } },
          h(
            'ul',
            { className: 'ptList', style: { margin: '4px 0 0' } },
            visible.map((row) => h(
              'li',
              { key: row.name },
              h(
                'details',
                {
                  className: 'ptToolBlock ptFold ptFoldable',
                  ...(vc.focusSection === row.name ? { open: true, id: 'pt-section-focus' } : {}),
                },
                h(
                  'summary',
                  null,
                  h('span', { className: 'ptDepKey' }, search.markQuery(row.name, query)),
                  ...ownerTags(row.owners, vc),
                  h('span', { className: 'ptTag', 'data-tone': 'warn', title: '原因：' + row.reason }, row.reason),
                  row.length === undefined
                    ? null
                    : rowEnd(h('span', { className: 'ptCount', title: '长度：这一项已知部分的字符数（按 B / KB 显示）' }, formatBytes(row.length))),
                ),
                h(
                  'div',
                  { className: 'ptFoldBody' },
                  h('p', { className: 'ptSub', style: { margin: 0 } }, UNPREDICTABLE),
                ),
              ),
            )),
          ),
        )
      }

      /** skill 目录条目：与其它页面一致的 `#N 名称` 折叠行。 */
      function skillList(entries, query, vc) {
        if (!Array.isArray(entries) || entries.length === 0) return null
        const visible = entries.filter((entry) => partMatches(entry, query))
        if (visible.length === 0) return null
        return h(
          'ul',
          { className: 'ptList', style: { margin: '8px 12px 0' } },
          visible.map((entry, index) => h(
            'li',
            { key: entry.name },
            h(
              'details',
              {
                className: 'ptToolBlock ptFold ptFoldable',
                ...(search.matchesQuery(query, [entry.name, entry.description]) ? { open: true } : {}),
              },
              h(
                'summary',
                null,
                h('span', { className: 'ptDepKey' }, search.markQuery('#' + (index + 1) + ' ' + entry.name, query)),
                entry.provider === undefined ? null : h('span', { className: 'ptTag', title: '托管这个 skill 的服务的provider' }, entry.provider),
                // 来源也是目录条目的一行事实，和 provider 并排放在摘要上，展开只留描述。
                entry.source === undefined ? null : h('span', { className: 'ptTag', title: '来源，这个目录条目从哪里来' }, String(entry.source)),
                typeof vc?.gotoSurface === 'function'
                  ? textButton('查看', (event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      vc.gotoSurface('skills', { name: entry.name })
                    }, { title: '在能力面查看这个 skill 的文件、使用方式与正文' })
                  : null,
              ),
              h(
                'div',
                { className: 'ptFoldBody' },
                h('p', { className: 'ptToolDesc', style: { margin: 0 } }, search.markQuery(entry.description ?? '', query)),
              ),
            ),
          )),
        )
      }

      /** 一条消息。 */
      function messageRow(message, index, vc, query, searching) {
        const parts = message.sourceKind === 'agent-instructions'
          ? fileList(message.parts, query)
          : message.sourceKind === 'runtime-context'
            // 注册表视图并进这一条消息：它是 messages 里的一条，不是 messages 的兄弟。
            ? h(React.Fragment, null, segmentList(message.parts, vc, query), skippedContextList(vc, query))
            : message.sourceKind === 'skill-catalog'
              ? skillList(message.parts, query, vc)
              : null
        const hint = summaryHint(message)
        // 目标分段在折叠的消息里时，外层消息必须一起展开，否则锚点不可见。
        const focusedPart = vc.focusSection !== null && vc.focusSection !== undefined
          && (message.parts ?? []).some((part) => part.name === vc.focusSection)
        // user 与 time-context 只保留原文：它们的机制/依据不解释任何模型可见内容。
        const mechanism = MECHANISM_IN_BODY.has(message.sourceKind)
          ? h(
              'p',
              { className: 'ptSub', style: { margin: 0 } },
              '机制 ' + message.mechanism,
              (message.basis ?? []).length > 0 ? ' · 依据 ' + message.basis.join(' / ') : '',
              message.unavailable === undefined ? '' : ' · ' + message.unavailable.reason,
            )
          : null
        // 原文前面还有别的行时留一点间距；单独一条原文就贴着内边距。
        const text = message.length > 0
          ? h(
              'pre',
              { className: 'ptPromptText', style: { marginTop: mechanism !== null || parts !== null ? '8px' : 0 } },
              search.markQuery(message.text, query),
            )
          : null
        // 什么都没有时不留一个空的内边距块（首条消息未填写就是一个空的 user 容器）。
        const body = [mechanism, parts, text].filter((node) => node !== null && node !== undefined)
        return h(
          'li',
          { key: message.sourceKind + '-' + message.index },
          h(
            'details',
            {
              className: 'ptPromptBlock ptFold ptFoldable',
              // 筛选激活时列出来的每一条都命中过，展开才能看到命中处；平时只展开第一条。
              ...(index === 0 || searching || focusedPart ? { open: true } : {}),
            },
            h(
              'summary',
              hint === null ? null : { title: hint },
              h('span', { className: 'ptCount', style: { minWidth: '28px', display: 'inline-block' } }, '#' + message.index),
              h('span', { className: 'ptPromptName' }, search.markQuery(message.sourceKind, query)),
              h('span', { className: 'ptTag', title: '角色，这条消息在请求里的角色' }, message.role),
              ...ownerTags(message.owners, vc),
              message.incomplete === true
                ? h('span', { className: 'ptTag', 'data-tone': 'warn', title: '状态：有些 skill 没能确认；模型会看到同样的不完整提示' }, '不完整')
                : null,
              confidenceTag(message.confidence),
              // 长度是读数，统一靠右。
              rowEnd(h('span', { className: 'ptCount', title: '长度，这条消息的字符数' }, formatBytes(message.length))),
            ),
            body.length > 0 ? h('div', { className: 'ptFoldBody' }, ...body) : null,
          ),
        )
      }

      /** 没有注入的消息类型：页面必须能回答「为什么没有这一条」。 */
      function renderSkippedLine(skipped) {
        if (!Array.isArray(skipped) || skipped.length === 0) return null
        return h(
          'p',
          { className: 'ptHint', style: { marginTop: '10px' } },
          '未注入的消息类型：',
          ...skipped.map((row) => h(
            'span',
            { key: row.sourceKind, className: 'ptTag', style: { marginLeft: '4px' }, title: row.reason },
            row.sourceKind + ' · ' + row.reason,
          )),
        )
      }

      /** `/name` 带出来的 skill 把资源放在哪：目录 / URL / provider 托管。 */
      function resourceBaseText(parts) {
        const base = (parts ?? [])[0]?.resourceBase
        if (base === undefined) return '资源由 provider 托管'
        if (base.kind === 'directory') return '资源目录 ' + base.path
        if (base.kind === 'url') return '资源 URL ' + base.url
        return '资源：' + (base.description ?? '')
      }

      /** 容器标题上的悬停提示：正文里不再单独占行的来源信息。 */
      function summaryHint(message) {
        if (message.sourceKind === 'skill-catalog') return CATALOG_SOURCE_HINT
        if (message.sourceKind === 'skill-invocation') return resourceBaseText(message.parts)
        return null
      }

      /** 首条消息草稿：决定 user 消息正文与 `/name` 展开。 */
      function draftEditor(vc) {
        return h(
          'div',
          { style: { margin: '0 0 10px' } },
          h('label', { className: 'ptEditorLabel', style: { display: 'block', marginBottom: '4px' } }, '首条消息草稿（可选）'),
          h('textarea', {
            className: 'ptEditor',
            style: { minHeight: '56px' },
            value: vc.previewDraft ?? '',
            placeholder: '在此的输入可能影响运行时注入',
            onChange: (event) => vc.setPreviewDraft(event.target.value),
          }),
          h(
            'div',
            { className: 'ptActions', style: { marginTop: '6px' } },
            h(
              'button',
              {
                type: 'button',
                className: 'ptBtn',
                disabled: vc.previewStatus === 'loading',
                onClick: () => vc.applyDraft(),
              },
              vc.previewStatus === 'loading' ? '求值中…' : '按草稿重算',
            ),
          ),
        )
      }

      /**
       * @param {object} vc - 视图上下文。
       * @returns {object} 消息标签的 React 节点。
       */
      function renderMessagesView(vc) {
        const all = vc.preview?.messages ?? []
        const query = vc.query ?? ''
        // 这份标签以前完全不读 query：页头写着能搜消息，输入任何词都没有变化。
        const searching = search.normalizeQuery(query) !== ''
        const messages = searching ? all.filter((message) => messageMatches(message, query)) : all
        // 定制页的「预览定制结果」复用这份视图，但那里没有预演页的草稿输入。
        const interactive = typeof vc.setPreviewDraft === 'function'
        // 从插件页/禁用预演跳到一个 context，但它不在当前消息里：给一句原因，
        // 不能让用户以为「消息标签页里没有」等于「这个上下文不存在」。
        const focusName = vc.focusSection
        const focusMissing = typeof focusName === 'string' && vc.focusKind === 'context'
          && !(vc.preview?.contexts ?? []).some((row) => row.name === focusName)
          && !all.some((message) => (message.parts ?? []).some((part) => part.name === focusName))
        return h(
          'div',
          null,
          interactive ? draftEditor(vc) : null,
          vc.preview?.conditions?.workspace === null || vc.preview?.conditions?.workspace === undefined
            ? h(
                'p',
                { className: 'ptHint' },
                h('span', { className: 'ptTag', 'data-tone': 'warn' }, '未指定工作区'),
                ' skill 目录、workspace 指令与 cwd / sandbox / approval 文本都由工作区决定，现在无法推导。',
              )
            : null,
          focusMissing
            ? h(
                'p',
                { className: 'ptHint' },
                '要跳转的上下文段「' + focusName + '」不在当前预演的消息里。可能只在会话 / 子代理 / 条件作用域注册，或该模式没有包含它',
              )
            : null,
          messages.length > 0
            ? h(
                'div',
                null,
                // 「展开全部」连消息里的分段 / skill 条目一起打开：那是这一页真正的正文，
                // 只开外层等于让人再点一遍。折叠是显示状态，不写回任何数据。
                h(
                  'div',
                  { className: 'ptSectionHead' },
                  h('span', { className: 'ptMeta' }, '按发送顺序排列，逐条可折叠'),
                  h(
                    'div',
                    { className: 'ptActions' },
                    textButton('折叠全部', () => setDetailsOpen(foldNodes(), false), { title: '收起本标签里的全部消息与分段' }),
                    textButton('展开全部', () => setDetailsOpen(foldNodes(), true), { title: '展开本标签里的全部消息与分段' }),
                  ),
                ),
                h('ul', { className: 'ptList' }, messages.map((message, index) => messageRow(message, index, vc, query, searching))),
              )
            : searching
              ? search.renderQueryEmpty({ noun: '消息', onClear: () => vc.setQuery('') })
              : h('p', { className: 'ptEmpty' }, '没有可预测的消息。'),
        )
      }

      return { renderMessagesView, renderSkippedLine }
    }
  },
})
