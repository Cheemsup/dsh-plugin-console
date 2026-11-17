/**
 * 会话展开后的详情：追溯链、提示词定制模板绑定、本会话已挂载，以及实际请求摘要。
 *
 * 这些内容与「会话列表行」分开，是因为它们都在回答「这一行背后是什么」：
 *   - 追溯链：全局插件 ← 模式要求的插件 ← 本会话已挂载；
 *   - 提示词定制模板绑定：上面看这份配方改了什么，下面放开关与本会话清理；
 *   - 本会话已挂载：本进程真正 ACTIVE 的模块；
 *   - 实际请求：来自 session log 的最终构造。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.session-detail.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.session-detail.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { modeTitle, shortModule, switchButton, textButton, influence } = deps

      /**
       * 会话绑定的提示词模板怎么显示。
       * @param {object} binding - 会话的提示词模板绑定。
       * @returns {string} 展示用的提示词模板名。
       */
      function templateLabelOf(binding) {
        if (typeof binding.templateName === 'string' && binding.templateName.length > 0) return binding.templateName
        if (typeof binding.templateId === 'string' && binding.templateId.length > 0) {
          const id = binding.templateId
          const shown = id.length <= 16 ? id : id.slice(0, 12) + '…'
          // 调用处已经写了「提示词定制模板」前缀，这里再带一次会读成两遍模板。
          return '已删除（' + shown + '）'
        }
        return '已删除'
      }

      /**
       * 一份已应用配方的改动清单。
       *
       * manifest 里存的是**差异**而不是全文：追加的段落、被改写的段落（完整新文本）、
       * 被禁用的工具。空字符串的改写表示把这一段清空，不是「没改」。
       * @param {object} recipe - 会话 manifest 里的配方。
       * @returns {{append: string, overrides: Array<[string, string]>, disabled: string[], empty: boolean}} 改动清单。
       */
      function changesOf(recipe) {
        const prompt = recipe?.prompt ?? {}
        const append = typeof prompt.appendText === 'string' ? prompt.appendText : ''
        const overrides = Object.entries(prompt.sectionOverrides ?? {})
          .filter(([, text]) => typeof text === 'string')
        const disabled = (Array.isArray(recipe?.tools?.disabled) ? recipe.tools.disabled : [])
          .filter((name) => typeof name === 'string')
        const contexts = Object.entries(recipe?.contexts ?? {})
          .filter(([, text]) => typeof text === 'string')
        const messages = Object.entries(recipe?.messages ?? {})
          .filter(([, spec]) => spec !== null && typeof spec === 'object')
        return {
          append,
          overrides,
          disabled,
          contexts,
          messages,
          empty: append.length === 0 && overrides.length === 0 && disabled.length === 0
            && contexts.length === 0 && messages.length === 0,
        }
      }

      /** 一条消息覆盖的界面说法。 */
      function messageAction(spec) {
        if (spec?.hidden === true) return '隐藏整条'
        if (typeof spec?.text === 'string') return '整段改写'
        if (Array.isArray(spec?.hiddenEntries) || spec?.descriptions !== undefined) return '目录条目调整'
        return '覆盖'
      }

      /** 折叠头右侧的结论：改了几段、禁了几个工具，让人不展开也能判断值不值得看。 */
      function changesSummary(changes) {
        const parts = []
        if (changes.append.length > 0) parts.push('追加 1 段')
        if (changes.overrides.length > 0) parts.push('改写 ' + changes.overrides.length + ' 段')
        if (changes.disabled.length > 0) parts.push('禁用 ' + changes.disabled.length + ' 个工具')
        if (changes.contexts.length > 0) parts.push('上下文 ' + changes.contexts.length + ' 段')
        if (changes.messages.length > 0) parts.push('消息 ' + changes.messages.length + ' 项')
        return parts.length === 0 ? '无改动' : parts.join(' · ')
      }

      /**
       * 信息区：这份提示词模板对会话做了什么改动。
       *
       * 默认收起。它回答「这个会话的提示词/工具为什么和别的不一样」，属于诊断信息；
       * 开关与清理是操作，单独放一行——说明和动作混在一起时，动作会被读成说明的一部分。
       * @param {object} binding - 会话的提示词模板绑定。
       * @returns {object} React 节点。
       */
      function changesBlock(binding) {
        const changes = changesOf(binding.recipe)
        return h(
          'details',
          { className: 'ptFold ptFoldable' },
          h(
            'summary',
            null,
            h('span', null, '应用的改动'),
            h('span', { className: 'ptFoldMeta' }, changesSummary(changes)),
          ),
          h(
            'div',
            { className: 'ptFoldBody ptChangeList' },
            changes.append.length > 0
              ? h(
                  'div',
                  { className: 'ptSubSection' },
                  h('p', { className: 'ptSubTitle' }, '追加的提示词段落'),
                  h('pre', { className: 'ptChangeText' }, changes.append),
                )
              : null,
            changes.overrides.length > 0
              ? h(
                  'div',
                  { className: 'ptSubSection' },
                  h('p', { className: 'ptSubTitle' }, '改写的提示词段（' + changes.overrides.length + '）'),
                  changes.overrides.map(([name, text]) =>
                    h(
                      'details',
                      { key: name, className: 'ptFold' },
                      h(
                        'summary',
                        null,
                        h('span', { className: 'ptPromptName' }, name),
                        h('span', { className: 'ptFoldMeta' }, text.length === 0 ? '隐藏该段' : text.length + ' 字'),
                      ),
                      text.length === 0
                        ? h('p', { className: 'ptSectionNote', style: { padding: '8px 12px' } }, '这一段的文本被清空，模型不再收到它。')
                        : h('pre', { className: 'ptChangeText', style: { margin: '8px 12px' } }, text),
                    ),
                  ),
                )
              : null,
            changes.contexts.length > 0
              ? h(
                  'div',
                  { className: 'ptSubSection' },
                  h('p', { className: 'ptSubTitle' }, '改写的运行时上下文（' + changes.contexts.length + '）'),
                  h(
                    'ul',
                    { className: 'ptDepList' },
                    changes.contexts.map(([name, text]) => h(
                      'li',
                      { key: name },
                      h('span', { className: 'ptDepKey' }, name),
                      h('span', { className: 'ptCount', style: { marginLeft: '6px' } }, text.length === 0 ? '隐藏该段' : text.length + ' 字'),
                    )),
                  ),
                )
              : null,
            changes.messages.length > 0
              ? h(
                  'div',
                  { className: 'ptSubSection' },
                  h('p', { className: 'ptSubTitle' }, '改写的消息（' + changes.messages.length + '）'),
                  h(
                    'ul',
                    { className: 'ptDepList' },
                    changes.messages.map(([kind, spec]) => h(
                      'li',
                      { key: kind },
                      h('span', { className: 'ptDepKey' }, kind),
                      h('span', { className: 'ptCount', style: { marginLeft: '6px' } }, messageAction(spec)),
                    )),
                  ),
                )
              : null,
            changes.disabled.length > 0
              ? h(
                  'div',
                  { className: 'ptSubSection' },
                  h('p', { className: 'ptSubTitle' }, '禁用的工具（' + changes.disabled.length + '）'),
                  h(
                    'ul',
                    { className: 'ptDepList' },
                    changes.disabled.map((name) => h('li', { key: name }, h('span', { className: 'ptDepKey' }, name))),
                  ),
                )
              : null,
            changes.empty
              ? h('p', { className: 'ptSectionNote' }, '这份配方没有改动任何提示词段或工具，应用后与基础组合一致。')
              : null,
          ),
        )
      }

      /**
       * 快照语义：绑定来自哪、和谁隔离。
       *
       * 这两句解释的是整段绑定的性质，不属于某一条改动，所以不再占用正文一行，
       * 收进标题的 `title`：`.ptSectionTitle[title]` 会给出 help 光标，悬停才展开。
       * 子 Agent 比普通会话多一句继承来源，换行后由原生 tooltip 分行显示。
       * @param {object} binding - 会话的提示词模板绑定。
       * @returns {string} 悬停说明。
       */
      function snapshotNoteText(binding) {
        const notes = [typeof binding.templateName === 'string'
          ? '本会话使用的是提示词定制模板的复制快照，彼此相互隔离'
          : '模板定义已删除；这份配方随会话保留，仍可开关。']
        if (typeof binding.inheritedFrom === 'string') {
          notes.push('本会话模板快照从父会话 ' + binding.inheritedFrom + ' 复制继承')
        }
        return notes.join('\n')
      }

      /**
       * 一次确认弹窗。
       *
       * 用 fixed 覆盖层而不是面板内的卡片：确认要打断当前动作，留在文流里容易被当成
       * 又一段说明滚过去。Esc、点遮罩与「取消」都算取消，默认焦点落在取消上——
       * 这两个动作都有账单或删除代价，不该一按回车就执行。
       * @param {string} id - 标题节点 id，供 `aria-labelledby` 引用。
       * @param {string} title - 要确认的问题。
       * @param {string} detail - 代价与影响的说明。
       * @param {string} confirmLabel - 确认按钮文字。
       * @param {Function} onConfirm - 确认回调。
       * @param {Function} onCancel - 取消回调。
       * @param {object} [opts] - `{ disabled }`。
       * @returns {object} React 节点。
       */
      function confirmDialog(id, title, detail, confirmLabel, onConfirm, onCancel, opts) {
        return h(
          'div',
          {
            className: 'ptModalOverlay',
            onClick: onCancel,
            onKeyDown: (event) => {
              if (event.key === 'Escape') onCancel()
            },
          },
          h(
            'div',
            {
              className: 'ptModal',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': id,
              onClick: (event) => event.stopPropagation(),
            },
            h('p', { className: 'ptModalTitle', id }, title),
            h('p', { className: 'ptHint', style: { margin: 0 } }, detail),
            h(
              'div',
              { className: 'ptModalActions' },
              h('button', { type: 'button', className: 'ptBtn', autoFocus: true, onClick: onCancel }, '取消'),
              h(
                'button',
                { type: 'button', className: 'ptBtn', 'data-tone': 'danger', disabled: opts?.disabled === true, onClick: onConfirm },
                confirmLabel,
              ),
            ),
          ),
        )
      }

      /**
       * 开关前的二次确认。
       *
       * 模板改的是请求体最前面的工具定义与系统提示词；缓存按前缀匹配，前缀一变，
       * 后面全部失效，所以这次操作有直接的账单代价。这句话必须在发请求之前说。
       * @param {object} session - 会话记录。
       * @param {{enabled: boolean}} target - 待确认的目标状态。
       * @param {boolean} busy - 是否有提交正在进行。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function activationConfirm(session, target, busy, vc) {
        return confirmDialog(
          'pt-activation-confirm-title',
          '开关模板可能影响提示词缓存，造成Token账单花费增加，是否继续？',
          '模板改写的工具定义与系统提示词位于请求体最前面；开关会让这段前缀变化，缓存按前缀匹配，因此会整体失效。',
          target.enabled ? '确认开启' : '确认关闭',
          () => { void vc.toggleActivation(session.id, target.enabled, session.preset ?? null) },
          vc.cancelActivation,
          { disabled: busy },
        )
      }

      /** 清理本会话绑定前的二次确认。 */
      function cleanupConfirm(target, busy, vc) {
        return confirmDialog(
          'pt-cleanup-confirm-title',
          '删除这个会话的提示词定制模板绑定？',
          '会删除绑定、开关与掩码；提示词模板定义与其他会话不受影响，运行中的注册也不受影响。',
          '确认清理',
          () => { void vc.runCleanup(target) },
          vc.cancelCleanup,
          { disabled: busy },
        )
      }

      /**
       * 会话的提示词定制模板绑定：上面是信息（改了什么），下面是操作（开关 + 本会话清理）。
       *
       * 开关只控制「提示词模板是否生效」；清理删除的是持久绑定本身。二者都在动
       * 请求体最前面的装配前缀，所以开关先弹缓存代价的确认。
       * @param {object} session - 会话记录。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function bindingSection(session, vc) {
        const binding = (vc.snapshot?.bindings ?? {})[session.id]
        const cleanupPending = vc.cleanupPending?.scope === 'session' && vc.cleanupPending.sessionId === session.id
        const cleanupBusy = vc.cleanupBusy === 'session:' + session.id
        const target = { scope: 'session', sessionId: session.id }

        if (binding === undefined) {
          return h(
            'div',
            { className: 'ptSection' },
            h('p', { className: 'ptSectionTitle' }, '提示词定制模板绑定'),
            h('p', { className: 'ptSectionNote' }, '这个会话没有绑定提示词定制模板，不会应用任何提示词或工具改动'),
          )
        }

        const toggling = vc.togglingSession?.get?.(session.id)
        const toggleBusy = toggling !== undefined
        const label = templateLabelOf(binding)
        const activated = vc.activationPending?.sessionId === session.id ? vc.activationPending : null
        return h(
          'div',
          { className: 'ptSection' },
          h('p', { className: 'ptSectionTitle', title: snapshotNoteText(binding) }, '提示词定制模板绑定'),
          changesBlock(binding),
          // 信息区是「改了什么」，下面是「能对它做什么」：一条 hairline 把读与写分开。
          h('hr', { className: 'ptDivider' }),
          // 操作区：开关与清理分成两行。破坏性动作不和主开关挤在同一行，
          // 也为以后新增的会话级动作留出位置。
          h(
            'div',
            { className: 'ptBindingActions' },
            h(
              'div',
              { className: 'ptBindingRow', style: { padding: 0 } },
              switchButton(binding.enabled, '提示词定制模板 ' + label, () => {
                if (toggleBusy) return
                vc.requestActivation(session.id, !binding.enabled, session.preset ?? null)
              }, {
                disabled: toggleBusy,
                title: binding.enabled
                  ? '关闭后会话将不再应用相关提示词定制模板快照的改动行为'
                  : '打开会按绑定的提示词定制模板快照重新应用改动行为',
              }),
              toggleBusy
                ? h('span', { className: 'ptMeta' }, toggling ? '开启中…' : '关闭中…')
                : h('span', { className: 'ptMeta' }, binding.enabled ? (binding.materialized ? '注册生效中' : '登记为启用，当前无注册') : '基础组合'),
              // 冷会话的生效时机与活会话不同，仍需写清楚；活会话的「下一步生效」
              // 是恒定的实现细节，占一行反而不如不写。
              session.live ? null : h('span', { className: 'ptMeta' }, '冷会话 · resume 时决定'),
            ),
            h(
              'div',
              { className: 'ptBindingRow', style: { padding: 0 } },
              textButton('清理本会话提示词模板', () => { vc.requestCleanup(target) }, {
                tone: 'danger',
                disabled: cleanupBusy,
                title: '删除本会话绑定的提示词定制模板快照',
              }),
            ),
          ),
          binding.enabled
            ? null
            : h('p', { className: 'ptSectionNote' }, '提示词模板登记为未启用；打开后下一步重新注册。清理会删除这条持久绑定。'),
          // 同一时刻只弹一个确认框。两个待确认状态正常不会同时存在，这里仍按优先级取舍。
          activated !== null
            ? activationConfirm(session, activated, toggleBusy, vc)
            : cleanupPending
              ? cleanupConfirm(target, cleanupBusy, vc)
              : null,
        )
      }

      /**
       * 会话的插件组合：全局条目 → 模式要求的插件 → 本会话实际挂载。
       *
       * 不再单独列一节「本会话已挂载」：模式清单上的圆点已经表示每一行是否挂载，
       * 唯一不在清单里的是全局层额外挂载的模块，作为一个小分组列在清单下方。
       * @param {object} session - 会话记录。
       * @param {Map<string, object>} presetsById - 模式索引。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderSessionTrace(session, presetsById, vc) {
        const mode = presetsById.get(session.preset)
        const runtime = session.runtime ?? null
        const runtimeNames = new Set(runtime?.modules ?? [])
        const declaredRows = mode?.rows ?? []

        const resolved = declaredRows.map((row) => ({
          row,
          live: runtimeNames.has(row.moduleName),
        }))
        const declaredModules = new Set(declaredRows.map((row) => row.moduleName))
        // 模式清单之外、却在本会话里活着的模块，只能来自全局层。
        const fromGlobal = runtime === null ? [] : [...(runtime.modules ?? [])].filter((name) => !declaredModules.has(name))
        // 没有模式清单也没有全局层额外模块时，不渲染空的子区块容器。
        const hasCompositionDetail = mode !== undefined || fromGlobal.length > 0

        return h(
          'div',
          { className: 'ptDetail' },
          // 与插件详情一致：展开的详情总是可以原地收起，不必回列表找一个已被滚走的行。
          h('div', { className: 'ptDetailClose' }, textButton('收起', () => vc.setOpenSession(null))),
          h(
            'div',
            { className: 'ptSection' },
            h(
              'p',
              {
                className: 'ptSectionTitle',
                // 说明收进标题悬停：模式清单是声明值，这句话每行都读得到会盖过清单本身。
                title: mode === undefined
                  ? undefined
                  : runtime === null
                    ? '本模式要求挂载的插件集，冷会话没有 fiber 所以不显示挂载状态、也无法判断运行时全局层是否注入其他模块'
                    : '本模式要求挂载的插件集以及挂载状态',
              },
              '插件组合',
            ),
            h(
              'div',
              { className: 'ptChain' },
              h('span', { className: 'ptTag' }, '全局插件'),
              h('span', { className: 'ptChainArrow' }, '→'),
              h('span', { className: 'ptTag' }, '模式 ' + labelOf(mode, session.preset)),
              h('span', { className: 'ptChainArrow' }, '→'),
              h('span', { className: 'ptTag', 'data-tone': runtime === null ? undefined : 'user' }, runtime === null ? '会话未激活' : '本会话'),
            ),
            mode === undefined
              ? h('p', { className: 'ptSectionNote' }, '该会话记录的模式不在当前 roster 里，无法列出它要求的插件。')
              : null,
            runtime !== null && runtime.leakedServices.length
              ? h('p', { className: 'ptSectionNote' }, h('span', { className: 'ptError' }, '服务泄漏：' + runtime.leakedServices.join('、')))
              : null,
          ),
          hasCompositionDetail
            ? h(
                'div',
                { className: 'ptSubBlocks' },
                mode !== undefined
                  ? h(
                      'details',
                      { className: 'ptFold ptFoldable', open: declaredRows.length <= 12 ? true : undefined },
                      h(
                        'summary',
                        null,
                        h('span', null, '模式要求的插件'),
                        h('span', { className: 'ptFoldMeta' }, declaredRows.length + ' 个'),
                      ),
                      h(
                        'ul',
                        { className: 'ptDepList', style: { padding: '6px 12px 10px' } },
                        resolved.map(({ row, live }) =>
                          h(
                            'li',
                            { key: row.entryId ?? row.moduleName },
                            runtime !== null
                              ? h('span', { className: 'ptDot', 'data-phase': live ? 'active' : 'none', role: 'img', 'aria-label': live ? '运行时已挂载' : '运行时未挂载' })
                              : null,
                            h('span', { className: 'ptDepKey' }, shortModule(row.moduleName)),
                            row.conditional ? h('span', { className: 'ptTag', 'data-tone': 'warn', title: row.condition === undefined || row.condition === '' ? '条件满足时才挂载' : '挂载条件：' + row.condition }, '条件挂载') : null,
                            live ? h('span', { className: 'ptTag', 'data-tone': 'user', title: '已挂载：会话运行时存在这个插件的 fiber' }, '已挂载') : null,
                          ),
                        ),
                      ),
                    )
                  : null,
                fromGlobal.length
                  ? h(
                      'div',
                      { className: 'ptSubSection' },
                      h('p', { className: 'ptSubTitle' }, '全局层额外挂载（' + fromGlobal.length + '）'),
                      h('p', { className: 'ptSectionNote' }, '这些模块不在上面的模式要求里，由全局层继承而来。'),
                      h(
                        'ul',
                        { className: 'ptDepList' },
                        fromGlobal.map((name) => h('li', { key: name }, h('span', { className: 'ptDepKey' }, shortModule(name)))),
                      ),
                    )
                  : null,
              )
            : null,
          bindingSection(session, vc),
          influence?.renderSessionInfluence?.(session, vc) ?? null,
        )
      }

      /** 模式展示名；roster 里没有时退回 id。 */
      function labelOf(mode, fallback) {
        if (mode !== undefined) return modeTitle(mode)
        return typeof fallback === 'string' ? fallback : '未记录'
      }

      return { renderSessionTrace, templateLabelOf }
    }
  },
})
