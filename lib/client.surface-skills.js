/**
 * 能力面 · 技能段：清单、来源与调用性、正文按需展开。
 *
 * 只渲染服务端给出的运行时事实：`path` / `source` / `provider` / `invocation`
 * / `resourceBase`。正文不在清单响应里，展开时才请求；失败只影响那一行。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.surface-skills.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.surface-skills.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { textButton, fact, search } = deps

      /**
       * DSH 的 `source` 桶 → 界面词汇。
       *
       * 只翻译 DSH 的固定桶（项目 / 本机 / DSH / 配置 / 运行时）；provider 自定义的
       * source 原样显示，不硬归到某一层。原始值仍出现在悬浮提示与展开后的 `source` 行，
       * 翻译只负责回答「这条技能属于哪一层、改哪里」。
       */
      const SOURCE_LAYERS = {
        'project-dsh': { label: '项目', title: '来源是当前选定工作区里的 skills 目录（source: project-*）' },
        'project-agents': { label: '项目', title: '来源是当前选定工作区里的 skills 目录（source: project-*）' },
        'user-dsh': { label: '本机', title: '来源是本机的用户 skills 目录（如 ~/.dsh/skills）（source: user-*）' },
        'user-agents': { label: '本机', title: '来源是本机的用户 skills 目录（如 ~/.dsh/skills）（source: user-*）' },
        bundled: { label: 'DSH', title: '随 DSH 安装包分发（source: bundled）' },
        custom: { label: '配置', title: '来源是 profile / 模式配置的 skills 目录（例如标准模式自带的技能）（source: custom）' },
        runtime: { label: '运行时', title: '由插件在加载时注册，随插件启停，没有可定位的技能目录或路径（source: runtime）' },
      }

      /**
       * 取一条 `source` 的展示词汇。
       * @param {string} source - 原始 source 值。
       * @returns {{ label: string, title: string }} 标签文字与悬浮提示。
       */
      function sourceLayer(source) {
        const known = SOURCE_LAYERS[source]
        if (known !== undefined) return known
        return source.length === 0
          ? { label: '未知来源', title: '发现来源未知' }
          : { label: source, title: `发现来源：${source}（provider 自定义，未归入固定层级）` }
      }

      /**
       * 文件位置：优先指令文件路径；provider 不报路径时退回资源基座，
       * 并用「目录 · 」/「URL · 」标明它不是指令文件。
       * @param {object} skill - 技能行。
       * @returns {object | string | null} React 节点、文本或空。
       */
      function locationNode(skill) {
        if (typeof skill.path === 'string') return h('code', null, skill.path)
        const base = skill.resourceBase
        if (base?.kind === 'directory') {
          return h('span', { title: 'provider 未报告指令文件路径；显示的是技能相对资源的基座目录' }, '目录 · ', h('code', null, base.path))
        }
        if (base?.kind === 'url') {
          return h('span', { title: 'provider 未报告指令文件路径；显示的是技能相对资源的基座 URL' }, 'URL · ', h('code', null, base.url))
        }
        return null
      }

      /**
       * 使用方式的界面词汇：标签与展开项共用，避免两处用词漂移。
       * @param {object} invocation - `{ modelInvocable, userInvocable }`。
       * @returns {string} 标签文字。
       */
      function invocationLabel(invocation) {
        const model = invocation?.modelInvocable === true
        const user = invocation?.userInvocable === true
        return model && user ? '模型/手动' : model ? '仅模型' : user ? '仅手动' : '不可调用'
      }

      /**
       * 使用方式标签：模型与手动是两个独立开关，合成一个标签但写清两边。
       * @param {object} invocation - `{ modelInvocable, userInvocable }`。
       * @returns {object} React 节点。
       */
      function invocationTag(invocation) {
        const model = invocation?.modelInvocable === true
        const user = invocation?.userInvocable === true
        return h('span', {
          className: 'ptTag',
          'data-tone': model || user ? undefined : 'warn',
          title: '模型 = 会出现在 skill-catalog 与 skill 工具里可供模型调取；手动 = 会出现在斜杠命令里',
        }, invocationLabel(invocation))
      }

      /**
       * 归属：能解析就跳插件页；解析不到时给原因，不显示成空。
       * 匹配方式（provider / 源码扫描）不占正文，挂在「归属插件」标题的悬停提示上。
       * @param {object} skill - 技能行。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function ownersNode(skill, vc) {
        if (Array.isArray(skill.owners) && skill.owners.length > 0) {
          return h(
            'span',
            { className: 'ptChipGroup' },
            skill.owners.map((rowId) => h(
              'button',
              {
                key: rowId,
                type: 'button',
                className: 'ptTag ptLink',
                title: '在插件页展开这一行',
                onClick: () => vc.gotoPlugin(rowId),
              },
              rowId,
            )),
          )
        }
        return h('span', { className: 'ptSub' }, skill.ownerReason ?? '未归属')
      }

      /**
       * 正文区：展开后读取，读取中 / 失败各有独立文案。
       * @param {object} skill - 技能行。
       * @param {object} surface - 能力面状态。
       * @returns {object} React 节点。
       */
      function contentNode(skill, surface) {
        const state = surface.skillContents?.[skill.name]
        if (state === undefined) return h('p', { className: 'ptSub', style: { margin: '10px 0 0' } }, '展开摘要后读取正文。')
        if (state.status === 'loading') return h('p', { className: 'ptSub', style: { margin: '10px 0 0' } }, '读取正文…')
        if (state.status === 'empty' || state.status === 'error') {
          return h(
            'p',
            { className: 'ptSub', style: { margin: '10px 0 0' } },
            state.reason,
            ' ',
            textButton('重试', () => void surface.loadSkillContent(skill.name), { title: '按当前条件重新读取' }),
          )
        }
        const data = state.data ?? {}
        const content = typeof data.content === 'string' ? data.content : ''
        // 检索只覆盖这一条正文：状态按技能名存在能力面 store，和高亮器一次只喂一个搜索框。
        const entry = surface.skillSearches?.[skill.name]
        const open = entry?.open === true
        const items = open
          ? [{ id: 'skill-search', no: 1, slot: 0, text: typeof entry?.text === 'string' ? entry.text : '', cursor: entry?.cursor ?? 0 }]
          : []
        const hl = search.createHighlighter(items)
        const body = hl.text(content)
        const total = hl.counts[0] ?? 0
        const cursor = total === 0 ? 0 : Math.min(entry?.cursor ?? 0, total - 1)
        /**
         * 在命中之间循环定位。
         *
         * 滚动范围限定在这条正文的容器里：多条技能同时开着检索时，`data-box` 编号会重复，
         * 用文档级查询会滚到别的正文。
         * @param {object} event - 触发事件。
         * @param {number} delta - +1 下一处 / -1 上一处。
         */
        const go = (event, delta) => {
          if (total === 0) return
          const next = (cursor + delta + total) % total
          surface.setSkillSearchCursor?.(skill.name, next)
          const root = typeof event?.currentTarget?.closest === 'function' ? event.currentTarget.closest('.ptSkillBody') : null
          search.scrollToHit(1, next, root)
        }
        return h(
          'div',
          { className: 'ptSkillBody', style: { marginTop: '10px' } },
          h(
            'div',
            { className: 'ptSectionHead' },
            h('span', { className: 'ptSub' }, `正文 ${data.length ?? 0} 字`),
            h(
              'div',
              { className: 'ptActions' },
              textButton(open ? '关闭检索' : '检索正文内容', () => surface.toggleSkillSearch?.(skill.name), {
                title: open ? '收起这条正文的检索' : '只在这条技能的正文里查找文字',
              }),
            ),
          ),
          open
            ? h(
                'div',
                { className: 'ptSearchItem', style: { margin: '8px 0' } },
                h('input', {
                  className: 'ptSearch ptSearchInline',
                  type: 'search',
                  value: typeof entry?.text === 'string' ? entry.text : '',
                  placeholder: '在这条正文里查找…',
                  autoFocus: true,
                  'aria-label': '检索技能正文',
                  onChange: (event) => surface.setSkillSearchText?.(skill.name, event.target.value),
                  onKeyDown: (event) => {
                    // 输入法确认候选词时也会发 Enter / Escape（keyCode 229），必须原样交给输入法。
                    if (event.nativeEvent?.isComposing === true || event.keyCode === 229) return
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      go(event, event.shiftKey ? -1 : 1)
                      return
                    }
                    if (event.key !== 'Escape') return
                    // Esc 只清空这个词；不让页面级 Esc 接手。
                    event.stopPropagation()
                    surface.setSkillSearchText?.(skill.name, '')
                  },
                }),
                h('span', { className: 'ptSearchCount', title: '当前第几处 / 命中总数' }, total === 0 ? '0 处' : (cursor + 1) + '/' + total),
                h(
                  'span',
                  { className: 'ptSearchNav' },
                  h('button', { type: 'button', className: 'ptTextBtn ptSearchNavBtn', disabled: total === 0, 'aria-label': '上一个命中', title: '上一个命中', onClick: (event) => go(event, -1) }, '↑'),
                  h('button', { type: 'button', className: 'ptTextBtn ptSearchNavBtn', disabled: total === 0, 'aria-label': '下一个命中', title: '下一个命中', onClick: (event) => go(event, 1) }, '↓'),
                ),
                textButton('×', () => surface.toggleSkillSearch?.(skill.name), { title: '关闭检索' }),
              )
            : null,
          hl.capped
            ? h('p', { className: 'ptSectionNote' }, '命中过多，只标出前 500 处；把检索词写得更具体可以缩小范围')
            : null,
          h('pre', { className: 'ptPromptText' }, body),
        )
      }

      /**
       * 一行技能。
       * @param {object} skill - 技能行。
       * @param {object} vc - 视图上下文。
       * @param {string} query - 页头搜索词。
       * @returns {object} React 节点。
       */
      function skillRow(skill, vc, query) {
        const surface = vc.surface
        const layer = sourceLayer(typeof skill.source === 'string' ? skill.source : '')
        // 匹配方式只在命中时有意义；放在「归属插件」标题的悬停提示里，不占正文一行。
        const ownerTitle = Array.isArray(skill.owners) && skill.owners.length > 0
          ? (skill.via === 'provider' ? '按 provider 匹配' : '按源码扫描匹配')
          : undefined
        return h(
          'li',
          { key: skill.name },
          h(
            'details',
            {
              // 条件变化后重挂载：旧正文已经清空，展开需要重新触发读取。
              key: skill.name + '|' + (surface.workspacePath ?? '') + '|' + (surface.presetId ?? ''),
              className: 'ptFold ptFoldable',
              onToggle: (event) => {
                if (event.currentTarget.open !== true) return
                if (surface.skillContents?.[skill.name] !== undefined) return
                void surface.loadSkillContent(skill.name)
              },
            },
            h(
              'summary',
              { title: skill.description },
              h('span', { className: 'ptFoldChevron' }, '▶'),
              h('span', { className: 'ptPromptName' }, search.markQuery(skill.name, query)),
              h('span', { className: 'ptTag', title: layer.title }, layer.label),
              h('span', { className: 'ptTag', title: '提供方：决定正文与资源的权限边界' }, skill.provider || '未知 provider'),
              invocationTag(skill.invocation),
            ),
            h(
              'div',
              { style: { padding: '10px 12px' } },
              h(
                'dl',
                { className: 'ptFacts', style: { margin: 0 } },
                fact('文件位置', locationNode(skill)),
                fact('source', skill.source || null),
                fact('provider', skill.provider ? h('code', null, skill.provider) : null),
                fact('使用方式', invocationLabel(skill.invocation)),
                fact('何时使用', skill.whenToUse ?? null),
                fact('归属插件', ownersNode(skill, vc), ownerTitle),
              ),
              contentNode(skill, surface),
            ),
          ),
        )
      }

      /**
       * 技能段正文。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderSkillsSegment(vc) {
        const surface = vc.surface
        const state = surface.skills ?? { status: 'idle' }
        const query = vc.query ?? ''
        const focus = surface.focusName ?? null

        if (state.status === 'loading') return h('div', { className: 'ptEmpty' }, '读取技能目录…')
        if (state.status === 'error') {
          return h(
            'div',
            { className: 'ptEmpty' },
            state.error ?? '读取失败',
            h('div', { style: { marginTop: '10px' } }, textButton('重试', () => void surface.loadSkills(), { title: '按当前条件重新读取' })),
          )
        }
        const data = state.data
        if (data === null || data === undefined) return h('div', { className: 'ptEmpty' }, '选择条件后读取技能目录。')
        if (data.available === false) {
          return h(
            'div',
            { className: 'ptEmpty' },
            data.reason ?? '技能目录不可用',
            (data.warnings ?? []).length > 0
              ? h('ul', { className: 'ptList', style: { marginTop: '10px', textAlign: 'left' } }, (data.warnings ?? []).map((line) => h('li', { key: line, className: 'ptHint' }, line)))
              : null,
          )
        }

        const all = Array.isArray(data.skills) ? data.skills : []
        const filtered = all.filter((skill) => {
          if (focus !== null && skill.name !== focus) return false
          if (search.normalizeQuery(query) === '') return true
          return search.matchesQuery(query, [skill.name, skill.description, skill.whenToUse, skill.provider, skill.source, skill.path])
        })
        const counts = data.counts ?? { total: all.length, model: 0, user: 0, bySource: {} }
        // 页头与行内用同一套层级词：project-dsh 与 project-agents 合并成「项目」。
        const sourceGroups = new Map()
        for (const [source, count] of Object.entries(counts.bySource ?? {})) {
          const label = sourceLayer(source).label
          sourceGroups.set(label, (sourceGroups.get(label) ?? 0) + count)
        }
        const warnings = [...new Set(data.warnings ?? [])]

        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'ptChipGroup', style: { marginBottom: '8px' } },
            h('span', { className: 'ptCount', title: '当前条件下可见的技能总数' }, `共 ${counts.total} 个`),
            h('span', { className: 'ptCount', title: '会出现在模型目录与 skill 工具里的技能' }, `模型可见 ${counts.model}`),
            h('span', { className: 'ptCount', title: '会在 / 目录里出现的技能' }, `人工可调用 ${counts.user}`),
            [...sourceGroups].map(([label, count]) => h(
              'span',
              { key: label, className: 'ptTag', title: '按来源层级计数' },
              `${label} ${count}`,
            )),
          ),
          data.complete === false
            ? h('p', { className: 'ptHint', style: { color: 'var(--pt-warn)' } }, '发现不完整：有 provider 未能确认，列表可能缺少条目。')
            : null,
          warnings.map((line) => h('p', { key: line, className: 'ptHint' }, line)),
          focus !== null
            ? h(
                'p',
                { className: 'ptHint' },
                `只看技能「${focus}」`,
                ' ',
                textButton('查看全部', surface.clearFocus),
              )
            : null,
          filtered.length === 0
            ? (search.normalizeQuery(query) === ''
                ? h('p', { className: 'ptHint' }, focus === null ? '这个条件下没有 skill。' : '这个条件下没有名为「' + focus + '」的 skill。')
                : search.renderQueryEmpty({ noun: '技能', onClear: () => vc.setQuery?.('') }))
            : h('ul', { className: 'ptList' }, filtered.map((skill) => skillRow(skill, vc, query))),
        )
      }

      return { renderSkillsSegment }
    }
  },
})
