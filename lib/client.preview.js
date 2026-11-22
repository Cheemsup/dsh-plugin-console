/**
 * 预演视图：选一个模式，看「首条消息发出前」模型会收到的完整构造。
 *
 * 数据来自一次真实的 `systemPrompt.assemble()`——与 loop 的首次装配同源，
 * 只是 scope 用的是 preset scope 而不是某个具体 agent 的 scope。
 * 所以这是**预演**（预拼接 / 预计算 / 模拟）而不是记录：它不产生任何会话事件，
 * 也不改变注册表。
 *
 * 原先独立的「提示词」页已经并进来：系统提示词与运行时上下文都在这里，
 * 每段带 DSH 的 order、来源插件与完整原文。与全局注册表的关系直接标在行内
 * （本模式替换 / 本模式追加），没进装配的全局段只在列表末尾留一行名字标签。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.preview.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.preview.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { modeTitle, tabButton, formatBytes, selectField, workspaceField, inlineMeta, rowEnd, previewTools, previewMessages, previewRaw, textButton, foldNodes, setDetailsOpen, search } = deps

      /**
       * 折叠动作行：一次开关当前标签里的全部内容块。
       *
       * 折叠是浏览器的显示状态，用 `setDetailsOpen` 直接改 DOM 属性比把每一段提升成
       * 受控 state 便宜，也与「请求结构」标签和定制编辑器保持同一套按钮与口径。
       * @param {string} meta - 左侧那句版式说明。
       * @returns {object} React 节点。
       */
      function foldRow(meta) {
        return h(
          'div',
          { className: 'ptSectionHead' },
          h('span', { className: 'ptMeta' }, meta),
          h(
            'div',
            { className: 'ptActions' },
            textButton('折叠全部', () => setDetailsOpen(foldNodes(), false), { title: '收起本标签里的全部内容块' }),
            textButton('展开全部', () => setDetailsOpen(foldNodes(), true), { title: '展开本标签里的全部内容块' }),
          ),
        )
      }


      /** 从快照的提示词注册表里取一段系统提示词的归属；没有就返回空。 */
      function sectionRegistry(snapshot) {
        return new Map((snapshot?.prompt?.sections ?? []).map((row) => [row.name, row]))
      }

      /** 来源插件标签；点击跳到插件页。所有来源都按同一形态展示，含义见悬停。 */
      function ownerTags(owners, vc) {
        if (!Array.isArray(owners) || owners.length === 0) {
          return h('span', { className: 'ptTag', 'data-tone': 'warn', title: '未归属：源码扫描没有找到注册点' }, '未归属')
        }
        // 注册表里的 owners 可能因为多个注册点指向同一插件而重复；标签只留一份。
        return [...new Set(owners)].map((owner) => h(
          'button',
          {
            key: owner,
            type: 'button',
            className: 'ptTag ptLink',
            title: '可能的插件来源，点击跳转查看',
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              vc.gotoPlugin(owner)
            },
          },
          owner,
        ))
      }

      /**
       * 一段与全局注册表的关系。
       *
       * 「替换」= 全局有同名段、当前模式重新注册了一份；「追加」= 全局没有、
       * 只在这个模式出现。名字来自 `chainLayers(scopeKey)`，是名字级事实。
       * @param {object} overrides - `preview.scopeOverrides.sections`。
       * @param {string} name - 段名。
       * @returns {'replaced' | 'added' | null} 关系；两层都没有时为 null。
       */
      function scopeRelation(overrides, name) {
        if ((overrides?.overridden ?? []).some((row) => row.name === name)) return 'replaced'
        if ((overrides?.added ?? []).some((row) => row.name === name)) return 'added'
        return null
      }

      /** 覆盖计数：替换多少段、追加多少段。 */
      function scopeCounts(overrides) {
        return { replaced: overrides?.overridden?.length ?? 0, added: overrides?.added?.length ?? 0 }
      }

      /**
       * 计数行：当前模式相对全局改了几段。
       *
       * 每段自己的「替换 / 追加」标签在行内；这一行只给规模，没有改动时不占位置。
       */
      function scopeCountLine(counts) {
        if (counts.replaced === 0 && counts.added === 0) return null
        return h(
          'p',
          {
            className: 'ptMeta',
            style: { margin: '0 0 6px' },
            title: '替换 = 全局有同名段、本模式重新注册了一份；追加 = 全局没有、只在本模式出现。下方已装配的段用行内标签标出属于哪种',
          },
          `本模式替换 ${counts.replaced} 段 · 追加 ${counts.added} 段`,
        )
      }

      function renderPreviewView(vc) {
        const { previewStatus, previewError, preview, runPreview, previewPreset } = vc
        if (previewStatus === 'loading') {
          return h('div', { 'aria-busy': 'true' }, Array.from({ length: 6 }, (_v, index) => h('div', { key: index, className: 'ptSkeleton' })))
        }
        if (previewStatus === 'error') {
          return h(
            'div',
            { className: 'ptNotice' },
            h('p', { className: 'ptError' }, previewError),
            h('button', { type: 'button', className: 'ptBtn', onClick: () => void runPreview(previewPreset), style: { marginTop: '12px' } }, '重试'),
          )
        }
        if (preview === null) return h('p', { className: 'ptEmpty' }, '尚未预演。')

        const {
          snapshot, previewTab, setPreviewTab, query, previewOnlyUnowned,
          loadTemplates, editPreview, editPreset, setEditing, loadBaseline, dirty, setPendingPreset,
        } = vc
        const sectionMeta = sectionRegistry(snapshot)
        const matches = (name, text, meta) => {
          const owners = meta?.owners ?? []
          if (previewOnlyUnowned && owners.length > 0) return false
          return search.matchesQuery(query, [name, text])
        }
        const sections = preview.sections.filter((section) => matches(section.name, section.rendered ?? section.text, sectionMeta.get(section.name)))
        const tools = preview.tools.filter((tool) => search.matchesQuery(query, [tool.name, tool.description]))

        const computed = preview.systemText.length
        const guidedTools = new Set(
          preview.sections
            .filter((section) => section.name.startsWith('tool:'))
            .map((section) => section.name.slice(5)),
        )
        const toolChars = preview.stats.toolSchemaChars
        // 合计按请求真实的三块算；旧响应没有 `totalChars` 时退回「system + tools」。
        const systemChars = preview.stats.systemTextChars ?? computed
        const total = preview.stats.totalChars ?? (computed + toolChars)
        const messageCount = preview.stats.messageCount ?? (preview.messages?.length ?? 0)
        const messageChars = preview.stats.messageChars ?? (preview.messages ?? []).reduce((sum, message) => sum + message.length, 0)
        const modeLabel = modeTitle((snapshot.modes ?? []).find((mode) => mode.id === preview.presetId) ?? { id: preview.presetId ?? '默认' })
        const sectionScope = scopeCounts(preview.scopeOverrides?.sections)
        const sectionNames = new Set(preview.sections.map((section) => section.name))
        const excludedSections = (snapshot.prompt?.sections ?? []).filter((row) => !sectionNames.has(row.name))

        return h(
          'div',
          null,
          preview.warnings?.length
            ? h('p', { className: 'ptSub' }, h('span', { className: 'ptError' }, preview.warnings.join(' ')))
            : null,
          // 从插件页/禁用预演跳进来时说明来源：预演展示的是当前模式的首请求装配，
          // 不是「这个插件在任意作用域注册了什么」。
          vc.focusOrigin !== null && vc.focusOrigin !== undefined
            ? h(
                'p',
                { className: 'ptHint' },
                `从「${vc.focusOrigin.label}」的「${vc.focusOrigin.name}」跳转；这里只展示当前模式的首请求装配结果，不代表该名字在其它作用域也生效。`,
              )
            : null,
          h(
            'div',
            { style: { margin: '0 0 10px' } },
            // 第一行回答「这条请求发到哪、按什么条件发」；第二行才是内容规模。
            // 正常值用文字，只有缺失/未知这种异常才套胶囊——否则一眼全是标签。
            inlineMeta([
              h('span', { className: 'ptMetaStrong' }, modeLabel),
              preview.conditions?.workspace ? '工作区 ' + preview.conditions.workspace.title : '未指定工作区',
              preview.conditions?.permission?.preset ? '权限 ' + preview.conditions.permission.preset : null,
              preview.envelope?.provider
                ? preview.envelope.provider + ' / ' + preview.envelope.model
                : h('span', { className: 'ptTag', 'data-tone': 'warn', title: '默认模型服务不可用，{{model}} / {{provider}} 无法解析' }, '模型未知'),
              preview.envelope?.contextWindow ? '窗口 ' + preview.envelope.contextWindow.toLocaleString() : null,
            ], true),
            h(
              'div',
              { style: { marginTop: '4px' } },
              inlineMeta([
                '提示词 ' + preview.stats.sections + ' 段',
                '消息 ' + messageCount + ' 条',
                '工具 ' + preview.stats.tools,
                // 合计曾经只算 system + tools，把四条 user 消息整段漏掉。组成挂在「合计」的悬停
                // 提示上而不是另起一行：三块的数字不必常驻，标题这一行仍只回答「这条请求有多大」。
                h(
                  'span',
                  { title: `system ${systemChars.toLocaleString()} · tools ${toolChars.toLocaleString()} · messages ${messageChars.toLocaleString()}` },
                  '合计 ' + total.toLocaleString() + ' 字符',
                ),
              ], true),
            ),
          ),
          h(
            'div',
            { className: 'ptTabs ptTabsSmall', role: 'tablist', 'aria-label': '上下文预演内容' },
            tabButton('prompt', `系统提示词（${formatBytes(computed)}）`, previewTab, setPreviewTab, undefined, { prefix: 'pt-subtab-' }),
            // 与请求的真实结构一致：system → tools → messages；会话页的「首次请求分析」也是这个顺序。
            tabButton('tools', `工具 schema（${preview.stats.tools}）`, previewTab, setPreviewTab, undefined, { prefix: 'pt-subtab-' }),
            // runtime-context 是 messages 里的一条，所以它的注册表视图也归在这个标签下，
            // 不再单独开一个「运行时上下文」标签——那会把它摆成 messages 的兄弟。
            tabButton('messages', `运行时消息与注入（${preview.messages?.length ?? 0}）`, previewTab, setPreviewTab, undefined, { prefix: 'pt-subtab-' }),
            tabButton('raw', '请求结构', previewTab, setPreviewTab, undefined, { prefix: 'pt-subtab-' }),
          ),
          previewTab === 'raw'
            ? previewRaw.renderRawStructure(preview, vc)
            : null,
          previewTab === 'prompt'
            ? h(
                'div',
                null,
                preview.completeSection !== null && preview.completeSection !== undefined
                  ? h(
                      'p',
                      { className: 'ptHint' },
                      h('span', { className: 'ptTag', 'data-tone': 'warn' }, '独占提示词'),
                      ` 这个模式的「${preview.completeSection}」声明了 complete，它成为整份提示词，其余段落全部不进模型上下文。所以这里只有 1 段——不是漏了；其余段落会在下方标出「没有进入本次装配」，这次不会生效。`,
                    )
                  : null,
                scopeCountLine(sectionScope),
                vc.focusKind !== 'context' && vc.focusSection !== null && vc.focusSection !== undefined && !preview.sections.some((section) => section.name === vc.focusSection)
                  ? h('p', { className: 'ptSub' }, '要跳转的段落「' + vc.focusSection + '」不在当前模式的装配结果里：可能被 complete 独占段挡住、该模式没有包含它，或它只在会话 / 子代理 / 条件作用域注册（首请求预演不覆盖）。')
                  : null,
                sections.length ? foldRow('按 order 排列，逐段可折叠') : null,
                sections.length
                  ? h(
                      'ul',
                      { className: 'ptList' },
                      sections.map((section, index) => previewSectionRow(section, index, vc, sectionMeta.get(section.name))),
                    )
                  : search.renderQueryEmpty({
                      noun: '提示词段',
                      onClear: search.normalizeQuery(query) === '' ? undefined : () => vc.setQuery(''),
                      extra: previewOnlyUnowned ? textButton('清除未归属筛选', () => vc.setPreviewOnlyUnowned(false)) : undefined,
                    }),
                excludedLine(excludedSections),
              )
            : null,
          previewTab === 'tools'
            ? h(
                'div',
                null,
                tools.length
                  ? previewTools.renderToolScopeGroups({
                      tools,
                      toolSet: preview.toolSet,
                      guided: guidedTools,
                      snapshot,
                      vc,
                    })
                  : search.renderQueryEmpty({
                      noun: '工具',
                      onClear: search.normalizeQuery(query) === '' ? undefined : () => vc.setQuery(''),
                    }),
              )
            : null,
          previewTab === 'messages'
            ? previewMessages.renderMessagesView(vc)
            : null,
          // 未注入的消息类型放到页底、紧挨「定制上下文」：它是读完全部消息后的补充说明。
          previewTab === 'messages'
            ? previewMessages.renderSkippedLine(preview.skippedMessages)
            : null,
          // 定制是这一页的下一步，放在页底并居中，避免和筛选器抢位置。
          // 这一页没有提交动作，所以用 soft 色调底而不是实底：实底留给真正提交的那个按钮。
          // 定制页的「预览定制结果」复用这份视图，但它已经在编辑器里，不再给入口。
          vc.appliedPreview === true
            ? null
            : h(
                'div',
                { className: 'ptBottomAction' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ptBtn ptBtnLarge',
                    'data-tone': 'soft',
                    onClick: () => {
                      // 进入编辑器时继承预演页当前看着的模式，并载入它的整份基线。
                      void loadTemplates()
                      const target = preview.presetId ?? previewPreset
                      if (dirty && editPreset !== target) {
                        setEditing(true)
                        setPendingPreset(target)
                        return
                      }
                      setEditing(true)
                      if (editPreview === null || editPreset !== target) {
                        void loadBaseline(target)
                      }
                    },
                  },
                  '定制上下文',
                ),
              ),
        )
      }

      /**
       * 全局注册表里有、但没进入这次装配的段。
       *
       * 正常情况下两边一一对应；出现差额只可能是 complete 独占段把其余段挡掉，
       * 或注册条件没有满足。这里不展开清单，只留名字标签，order 与来源收进悬停。
       */
      function excludedLine(rows) {
        if (rows.length === 0) return null
        return h(
          'p',
          { className: 'ptHint', style: { marginTop: '10px' } },
          `全局注册表里另有 ${rows.length} 个提示词段没有进入本次装配（可能被 complete 独占段挡住，或注册条件未满足）：`,
          ...rows.map((row) => h(
            'span',
            {
              key: row.name,
              className: 'ptTag',
              style: { marginLeft: '4px' },
              title: `${row.name} · ${typeof row.order === 'number' ? 'order ' + row.order : '无 order'} · 来源 ${(row.owners ?? []).length > 0 ? row.owners.join('、') : '未归属'}`,
            },
            row.name,
          )),
        )
      }

      /** 预演里的一段提示词。 */
      function previewSectionRow(section, index, vc, meta) {
        const rendered = section.rendered ?? section.text ?? ''
        const unresolved = section.unresolved ?? []
        const focused = vc.focusSection === section.name
        // 命中段自动展开：搜索的结果是「这一段的正文里有这个词」，收起状态下只看到一个
        // 段名，用户还得自己再点一下才能确认。空词不算命中——`matchesQuery` 对空词恒真，
        // 直接用它会让没搜索时全部展开。
        // 其余段落默认全部收起：系统提示词动辄几万字，全展开会把列表撑成一篇长文，
        // 先让人看清「有哪些段、多长、谁注册的」，再按需展开某一段。
        const hit = search.normalizeQuery(vc.query) !== '' && search.matchesQuery(vc.query, [section.name, rendered])
        const relation = scopeRelation(vc.preview?.scopeOverrides?.sections, section.name)
        // 全局注册表里没有的名字（本模式追加）没有 meta，owner 从源码扫描索引兜底——
        // 否则 tool:* 这类只由模式注册的段会全部显示「未归属」。
        const owners = (meta?.owners?.length ?? 0) > 0
          ? meta.owners
          : vc.snapshot?.prompt?.nameOwners?.[section.name] ?? []
        return h(
          'li',
          { key: `${section.name}-${index}` },
          h(
            'details',
            {
              className: 'ptPromptBlock ptFold ptFoldable',
              ...(focused ? { open: true, id: 'pt-section-focus' } : (hit ? { open: true } : {})),
            },
            h(
              'summary',
              null,
              h('span', { className: 'ptCount', style: { minWidth: '28px', display: 'inline-block' } }, '#' + (index + 1)),
              h('span', { className: 'ptPromptName' }, search.markQuery(section.name, vc.query)),
              relation === 'replaced'
                ? h('span', { className: 'ptTag', 'data-tone': 'warn', title: '与全局的关系：全局有同名段，当前模式重新注册了一份并作覆盖' }, '本模式替换')
                : relation === 'added'
                  ? h('span', { className: 'ptTag', title: '与全局的关系：全局注册表里没有这个名字，只由当前模式注册' }, '本模式追加')
                  : null,
              ownerTags(owners, vc),
              unresolved.length
                ? h('span', { className: 'ptTag', 'data-tone': 'warn', title: `变量缺失：未解析 ${unresolved.join('、')}；这些值由 agent-loop 在真实请求前提供` }, `${unresolved.length} 个变量缺失`)
                : null,
              // 顺序与大小是读数，统一靠右，正文左侧只留「这是什么」。
              rowEnd(
                typeof section.order === 'number'
                  ? h('span', { className: 'ptCount', title: '顺序：DSH order，决定它在最终提示词里的先后' }, 'order ' + section.order)
                  : null,
                section.length !== undefined
                  ? h('span', { className: 'ptCount', title: '长度：这一段提示词的字符数（按 B / KB 显示）' }, formatBytes(section.length))
                  : null,
              ),
            ),
            rendered.length
              ? h('pre', { className: 'ptPromptText' }, search.markQuery(rendered, vc.query))
              : h('p', { className: 'ptSub', style: { margin: 0, padding: '10px 12px' } }, '该段落渲染为空'),
          ),
        )
      }

      /**
       * 预演页筛选：选一个预设模式 + 重新预计算。
       *
       * 选择会立即触发一次新的预计算——scope 变了，沿链收集到的贡献也就变了。
       */
      function renderPreviewFilters(vc) {
        const { snapshot, editing, previewPreset, setPreviewPreset, runPreview, previewStatus, preview } = vc
        const {
          previewWorkspaces, previewWorkspacePath, setPreviewWorkspacePath,
          previewPermissionPreset, setPreviewPermissionPreset, workspacePicker,
        } = vc
        // 编辑器自带工具栏；两条并列会让「模式选择」和「提示词模板选择」看起来是同级筛选。
        if (editing) return null
        const modes = snapshot.modes ?? []
        const current = previewPreset ?? preview?.presetId ?? ''
        const unknown = current !== '' && !modes.some((mode) => mode.id === current)
        // 权限选项来自宿主的预设表：部署配了哪些预设，这里就只可能选哪些。
        const permissionOptions = preview?.conditions?.permission?.options ?? []
        return h(
          React.Fragment,
          null,
          // 选项只写模式名：order 是排序依据，不是选模式时要比较的信息。
          selectField('模式', current, [
            ...(unknown ? [{ value: current, label: current }] : []),
            ...modes.map((mode) => ({ value: mode.id, label: modeTitle(mode) })),
          ], (value) => {
            if (value === current) return
            setPreviewPreset(value)
            void runPreview(value)
          }),
          // 工作区与权限不是「显示偏好」而是条件：它们直接决定模型收到的 cwd、sandbox、
          // approval 文字，以及下一阶段的 skill 目录与指令链。已创建工作区直接选，
          // 「新建工作区…」走系统选择器并登记到 DSH。
          workspaceField('工作区', previewWorkspacePath, previewWorkspaces, (value) => {
            setPreviewWorkspacePath(value)
          }, workspacePicker?.preview, {
            title: '首请求的 cwd：skill 目录、AGENTS.md 链与 cwd / sandbox / approval 文本都由它决定；「新建工作区…」会把选中的目录登记为 DSH 工作区',
            ariaLabel: '工作区',
            busy: workspacePicker?.busy === true,
            error: workspacePicker?.error ?? null,
          }),
          permissionOptions.length > 0
            ? selectField('权限预设', previewPermissionPreset ?? '', permissionOptions.map((option) => ({ value: option.value, label: option.name })), (value) => {
                if (value === previewPermissionPreset) return
                setPreviewPermissionPreset(value)
              }, { title: 'sandbox 与 approval 会写进 runtime-context，模型看到的就是这段文字' })
            : null,
          h(
            'div',
            { className: 'ptActions' },
            h(
              'button',
              {
                type: 'button',
                className: 'ptBtn',
                disabled: previewStatus === 'loading',
                onClick: () => void runPreview(previewPreset),
              },
              previewStatus === 'loading' ? '求值中…' : '重新预计算',
            ),
          ),
        )
      }

      return { renderPreviewView, renderPreviewFilters, previewSectionRow }
    }
  },
})
