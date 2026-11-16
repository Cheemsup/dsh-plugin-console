/**
 * 定制编辑器的「消息与注入」分区：runtime-context 逐段、agent-instructions 整段、
 * skill 目录逐条、time-context 整段。
 *
 * 这一层只渲染 `vc` 里的草稿状态，不做数据变换——草稿 → recipe 的规则在
 * `client.draft.js`，物化规则在 host 的 `templates/message-overlay.js`。
 * 视图必须能脱离页面单独渲染，`verify-views.mjs` 依赖这一点。
 *
 * **没生成的消息不画容器**：工作区没有 AGENTS.md / CLAUDE.md 时，agent-instructions
 * 压根不是一条消息，留一张空壳卡片只会让人以为「这里本来有内容」。缺失原因由预演页
 * 的「未注入的消息类型」统一交代，与这里的分区各管一件事。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.editor-messages.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-console',
  chunk: 'client.editor-messages.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { formatBytes, search } = deps

      /** 找到一条基线消息。 */
      function messageOf(preview, kind) {
        return (preview?.messages ?? []).find((message) => message.sourceKind === kind)
      }

      /** runtime-context 的逐段基线：注册表全量 + 模型实际收到的 parts。 */
      function contextRows(preview) {
        const rows = new Map()
        for (const context of preview?.contexts ?? []) {
          if (typeof context?.name !== 'string') continue
          rows.set(context.name, {
            name: context.name,
            order: context.order,
            text: typeof context.text === 'string' ? context.text : '',
            required: context.required === true,
            inMessage: false,
          })
        }
        const runtime = messageOf(preview, 'runtime-context')
        for (const part of runtime?.parts ?? []) {
          if (typeof part?.name !== 'string') continue
          rows.set(part.name, { ...(rows.get(part.name) ?? { name: part.name }), ...part, inMessage: true })
        }
        return [...rows.values()]
      }

      /** 一个可折叠的文本编辑块；与逐段原文的交互一致。 */
      function textEditor(key, title, tags, current, baseline, onChange, onReset, hint, disabled = false, metaPrefix = '') {
        // 上层选择「不注入 / 不做修改」时，这里的文本不会进入配方，也就不该标成「已改动」。
        const changed = !disabled && current !== baseline
        return h(
          'details',
          {
            key,
            className: 'ptFold ptFoldable',
            // 禁用时整条（标题 + 文本段）一起变淡：提示这段内容当前不会进配方。
            'data-disabled': disabled ? 'true' : undefined,
            ...(changed ? { open: true } : {}),
          },
          h(
            'summary',
            null,
            h('span', { className: 'ptPromptName' }, title),
            ...tags,
            changed ? h('span', { className: 'ptTag', 'data-tone': 'warn' }, current.length === 0 ? '已清空' : '已改动') : null,
            // 顺序与长度都是读数，统一放在右端；左侧只留「这一段是什么」。
            h('span', { className: 'ptFoldMeta' }, metaPrefix + formatBytes(current.length)),
            changed
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ptTextBtn',
                    onClick: (event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      onReset()
                    },
                  },
                  '还原',
                )
              : null,
          ),
          hint === undefined ? null : h('p', { className: 'ptHint', style: { margin: '8px 12px 0' } }, hint),
          h('textarea', {
            className: 'ptEditor',
            style: { minHeight: '64px', border: 0, borderRadius: 0, resize: 'vertical' },
            value: current,
            disabled,
            onChange: (event) => onChange(event.target.value),
          }),
        )
      }

      /** 一个开关行。 */
      function toggleRow(label, checked, onChange, hint) {
        return h(
          'label',
          { className: 'ptCardRow', style: { gap: '8px', cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked) }),
          h('span', { className: 'ptSub', style: { margin: 0 } }, label),
          hint === undefined ? null : h('span', { className: 'ptHint', style: { margin: 0 } }, hint),
        )
      }

      /** runtime-context：逐段编辑 + 整条隐藏。 */
      function renderRuntime(vc, needle) {
        const preview = vc.editPreview
        const runtime = messageOf(preview, 'runtime-context')
        // 整条消息没生成时不画容器：没有内容可编，空壳卡片只是占位。
        if (runtime === undefined) return null
        const rows = contextRows(preview)
        const visible = needle === ''
          ? rows
          : rows.filter((row) => {
              const text = vc.draftContexts?.[row.name] ?? row.text
              return row.name.toLowerCase().includes(needle) || text.toLowerCase().includes(needle)
            })
        const hidden = vc.draftRuntimeHidden === true
        return h(
          'div',
          { className: 'ptCard' },
          h(
            'div',
            { className: 'ptCardHead' },
            // 改写的边界收进悬停：它解释的是整块容器的语义，不占正文一行。
            h('p', {
              className: 'ptCardTitle',
              title: '改写只改变模型看到的说明文字，不改变实际的权限',
            }, `运行时上下文（${rows.length} 段）`),
            hidden ? h('span', { className: 'ptTag', 'data-tone': 'warn' }, '整条隐藏') : null,
          ),
          h('p', { className: 'ptHint', style: { margin: 0 } }, '此部分为DSH运行时自动生成和注入的消息内容，一般无需修改定制'),
          toggleRow('不注入这部分消息', hidden, (checked) => vc.setDraftRuntimeHidden(checked)),
          visible.length === 0
            ? h('p', { className: 'ptEmpty' }, '没有匹配的上下文段')
            : visible.map((row) => {
                const baseline = row.text
                const current = vc.draftContexts?.[row.name] ?? baseline
                const tags = [
                  row.confidence === 'unknown' ? h('span', { key: 'conf', className: 'ptTag', 'data-tone': 'warn' }, '未预测') : null,
                  ...(row.owners ?? []).map((owner) => h('span', { key: owner, className: 'ptTag', title: '注册插件：' + owner }, owner)),
                  row.inMessage === false ? h('span', { key: 'empty', className: 'ptTag', 'data-tone': 'warn' }, '内容为空') : null,
                ].filter(Boolean)
                // order 是读数，不进左簇；与长度一起放到折叠头右端。
                const metaPrefix = typeof row.order === 'number' ? 'order ' + row.order + ' · ' : ''
                return textEditor(
                  'ctx-' + row.name,
                  row.name,
                  tags,
                  current,
                  baseline,
                  (value) => vc.setDraftContexts((previous) => ({ ...previous, [row.name]: value })),
                  () => vc.setDraftContexts((previous) => ({ ...previous, [row.name]: baseline })),
                  hidden ? '这条消息已标记为不注入；这里的文字不会送达模型。' : undefined,
                  // 整条不注入时逐段改写不会进入配方：禁用文本段并整条变淡。
                  hidden,
                  metaPrefix,
                )
              }),
        )
      }

      /** agent-instructions：整段改写 / 隐藏；这条消息没生成时整个容器不出现。 */
      function renderInstructions(vc, needle) {
        const preview = vc.editPreview
        const message = messageOf(preview, 'agent-instructions')
        if (message === undefined) return null
        const baseline = message.text ?? ''
        const draft = vc.draftInstructions ?? { text: baseline, hidden: false }
        if (needle !== '' && !'agent-instructions'.includes(needle) && !draft.text.toLowerCase().includes(needle)) return null
        return h(
          'div',
          { className: 'ptCard' },
          h(
            'div',
            { className: 'ptCardHead' },
            h('p', { className: 'ptCardTitle' }, 'agent-instructions'),
            draft.hidden === true ? h('span', { className: 'ptTag', 'data-tone': 'warn' }, '已隐藏') : null,
          ),
          h('p', { className: 'ptHint', style: { margin: 0 } }, '改写是静态替换，之后 AGENTS.md / CLAUDE.md 变了也不会自动跟随，而是仍然使用模板的改写结果（需要跟随更新请先执行还原、再进行修改）'),
          toggleRow('隐藏本段内容', draft.hidden === true, (checked) => vc.setDraftInstructions((previous) => ({ ...previous, hidden: checked }))),
          message.parts?.length
            ? h(
                'ul',
                { className: 'ptList', style: { margin: '8px 12px 0' } },
                message.parts.map((file) => h(
                  'li',
                  { key: file.displayPath, className: 'ptSub', style: { margin: 0 } },
                  h('span', { className: 'ptDepKey' }, file.displayPath),
                  h('span', { className: 'ptCount', style: { marginLeft: '6px' } }, formatBytes(file.bytes ?? 0)),
                  file.included === false ? h('span', { className: 'ptTag', 'data-tone': 'warn', style: { marginLeft: '6px' } }, '被预算略过') : null,
                )),
              )
            : null,
          textEditor(
            'instructions',
            '整段文本',
            [],
            draft.text ?? baseline,
            baseline,
            (value) => vc.setDraftInstructions((previous) => ({ ...previous, text: value })),
            () => vc.setDraftInstructions((previous) => ({ ...previous, text: baseline })),
            undefined,
            draft.hidden === true,
          ),
        )
      }

      /** skill 目录：逐条列出/隐藏与描述；目录消息没生成时整个容器不出现。 */
      function renderCatalog(vc, needle) {
        const preview = vc.editPreview
        const message = messageOf(preview, 'skill-catalog')
        if (message === undefined) return null
        const baseline = {}
        for (const part of message.parts ?? []) baseline[part.name] = { listed: true, description: part.description ?? '' }
        const entries = vc.draftCatalog?.entries ?? baseline
        const hidden = vc.draftCatalog?.hidden === true
        const names = Object.keys(entries).filter((name) => {
          if (needle === '') return true
          const entry = entries[name]
          return name.toLowerCase().includes(needle) || (entry.description ?? '').toLowerCase().includes(needle)
        })
        return h(
          'div',
          { className: 'ptCard' },
          h(
            'div',
            { className: 'ptCardHead' },
            h('p', { className: 'ptCardTitle' }, `skill 目录（${Object.keys(entries).length} 条）`),
            hidden ? h('span', { className: 'ptTag', 'data-tone': 'warn' }, '整条隐藏') : null,
          ),
          h('p', { className: 'ptHint', style: { margin: 0 } }, '此部分定制仅影响模型读到的skills-catalog内容，被隐藏的skills仍然可以被读取（例如通过斜杆命令手动注入）'),
          toggleRow('隐藏所有skills目录内容', hidden, (checked) => vc.setDraftCatalog((previous) => ({ ...previous, hidden: checked }))),
          names.length === 0
            ? h('p', { className: 'ptEmpty' }, needle === '' ? '目录里没有条目。' : '没有匹配的 skill 条目。')
            : h(
                'ul',
                { className: 'ptList', style: { margin: '8px 12px 0' } },
                names.map((name) => {
                  const entry = entries[name] ?? baseline[name]
                  const original = baseline[name] ?? { listed: true, description: '' }
                  const changed = entry.listed !== original.listed || entry.description !== original.description
                  return h(
                    'li',
                    { key: name },
                    h(
                      'details',
                      // 与逐段原文同一种折叠：默认收起，改动过或搜索命中时自动展开。
                      {
                        className: 'ptFold ptFoldable',
                        'data-disabled': hidden ? 'true' : undefined,
                        ...(changed || needle !== '' ? { open: true } : {}),
                      },
                      h(
                        'summary',
                        null,
                        h('input', {
                          type: 'checkbox',
                          checked: entry.listed !== false,
                          disabled: hidden,
                          // 复选框嵌在 summary 里：不截断冒泡，点一下会连带展开/收起。
                          onClick: (event) => event.stopPropagation(),
                          onChange: (event) => vc.setDraftCatalog((previous) => ({
                            ...previous,
                            entries: { ...previous.entries, [name]: { ...entry, listed: event.target.checked } },
                          })),
                          title: hidden ? '整条目录已隐藏，逐条开关暂不生效' : '取消勾选 = 不把这个 skill 列进目录',
                        }),
                        h('span', { className: 'ptPromptName' }, name),
                        entry.listed === false ? h('span', { className: 'ptTag', 'data-tone': 'warn' }, '不列出') : null,
                        changed ? h('span', { className: 'ptTag', 'data-tone': 'warn' }, '已改动') : null,
                        h('span', { className: 'ptFoldMeta' }, formatBytes(entry.description?.length ?? 0)),
                        changed
                          ? h('button', {
                              type: 'button',
                              className: 'ptTextBtn',
                              disabled: hidden,
                              onClick: (event) => {
                                // 与逐段原文的「还原」一致：别顺带切换折叠状态。
                                event.preventDefault()
                                event.stopPropagation()
                                vc.setDraftCatalog((previous) => ({
                                  ...previous,
                                  entries: { ...previous.entries, [name]: original },
                                }))
                              },
                            }, '还原')
                          : null,
                      ),
                      h('textarea', {
                        className: 'ptEditor',
                        style: { minHeight: '44px', border: 0, borderRadius: 0, resize: 'vertical' },
                        value: entry.description ?? '',
                        disabled: hidden,
                        onChange: (event) => vc.setDraftCatalog((previous) => ({
                          ...previous,
                          entries: { ...previous.entries, [name]: { ...entry, description: event.target.value } },
                        })),
                      }),
                    ),
                  )
                }),
              ),
        )
      }

      /** 时间快照的三种处理方式；顺序就是界面顺序。 */
      const TIME_MODES = [
        ['hide', '隐藏'],
        ['keep', '不做修改'],
        ['rewrite', '改写'],
      ]

      /** 每种方式下面那句提示：只解释当前选中的一种，不并列其它选项。 */
      const TIME_HINTS = {
        hide: '隐藏后模型收不到时间快照',
        keep: '每次请求由 DSH 重新注入时间快照',
        rewrite: '改写后时间戳会变成静态文本，不再变化',
      }

      /** time-context：隐藏 / 不做修改 / 改写；这条消息没生成时整个容器不出现。 */
      function renderTime(vc, needle) {
        const preview = vc.editPreview
        const message = messageOf(preview, 'time-context')
        if (message === undefined) return null
        const baseline = message.text ?? ''
        const draft = vc.draftTime ?? { text: baseline, mode: 'keep', hidden: false }
        // 旧草稿只有 hidden：按它推一次，避免迁移期读到 undefined。
        const mode = draft.mode ?? (draft.hidden === true ? 'hide' : 'keep')
        if (needle !== '' && !'time-context'.includes(needle) && !(draft.text ?? '').toLowerCase().includes(needle)) return null
        return h(
          'div',
          { className: 'ptCard' },
          h(
            'div',
            { className: 'ptCardHead' },
            h('p', { className: 'ptCardTitle' }, 'time-context'),
            mode === 'hide' ? h('span', { className: 'ptTag', 'data-tone': 'warn' }, '已隐藏') : null,
          ),
          h('p', { className: 'ptHint', style: { margin: 0 } }, TIME_HINTS[mode]),
          h(
            'div',
            { className: 'ptCardRow', role: 'radiogroup', 'aria-label': '时间快照处理方式', style: { gap: '14px' } },
            TIME_MODES.map(([value, label]) => h(
              'label',
              { key: value, className: 'ptRadio' },
              h('input', {
                type: 'radio',
                name: 'pt-time-mode',
                value,
                checked: mode === value,
                onChange: () => vc.setDraftTime((previous) => ({
                  ...previous,
                  mode: value,
                  hidden: value === 'hide',
                })),
              }),
              h('span', null, label),
            )),
          ),
          textEditor(
            'time',
            '时间快照',
            [],
            draft.text ?? baseline,
            baseline,
            (value) => vc.setDraftTime((previous) => ({ ...previous, text: value })),
            () => vc.setDraftTime((previous) => ({ ...previous, text: baseline })),
            undefined,
            mode !== 'rewrite',
          ),
        )
      }

      /** 分区标题；抽出来是因为「搜索把消息全滤掉」时也要保留它。 */
      function sectionHead() {
        return h(
          'div',
          { className: 'ptSectionHead', style: { margin: '18px 0 2px' } },
          // 分区的性质收进标题悬停：正文只留可改的东西，不再用一行说明占位置。
          h('p', {
            className: 'ptSectionTitle',
            style: { margin: 0 },
            title: '此部分是运行时消息注入，请注意修改仅影响模型上下文、不涉及权限变更',
          }, '消息与注入（首请求）'),
        )
      }

      /**
       * 一整个「消息与注入」分区。
       * @param {object} vc - 视图上下文。
       * @returns {object | null} React 节点；没有基线时返回 null（编辑器自己处理错误态）。
       */
      function renderMessageEditors(vc) {
        if (vc.editPreview === null || vc.editPreview === undefined) return null
        const needle = search.normalizeQuery(vc.query)
        const nodes = [
          renderRuntime(vc, needle),
          renderInstructions(vc, needle),
          renderCatalog(vc, needle),
          renderTime(vc, needle),
        ].filter((node) => node !== null)
        // 四条消息一条都没生成时，连分区标题也不占位置。但搜索把已有内容全滤掉时要
        // 保留标题与原因：整块消失会让人以为消息区本来就没了。
        if (nodes.length === 0) {
          if (needle === '') return null
          return h('div', null, sectionHead(), search.renderQueryEmpty({ noun: '消息与注入', onClear: () => vc.setQuery('') }))
        }
        return h('div', null, sectionHead(), nodes)
      }

      return { renderMessageEditors }
    }
  },
})
