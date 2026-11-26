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
      const { rowEnd, textButton, fact, search } = deps

      /**
       * 资源基座的一句话说明。
       * @param {object | undefined} base - `resourceBase`。
       * @returns {string} 说明。
       */
      function resourceText(base) {
        if (base === undefined || base === null) return '由 provider 托管'
        if (base.kind === 'directory') return '目录 · ' + base.path
        if (base.kind === 'url') return 'URL · ' + base.url
        if (base.kind === 'opaque') return base.description ?? 'provider 自定义'
        return String(base.kind ?? '未知')
      }

      /**
       * 调用性标签：模型与人工是两个独立开关，合成一个标签但写清两边。
       * @param {object} invocation - `{ modelInvocable, userInvocable }`。
       * @returns {object} React 节点。
       */
      function invocationTag(invocation) {
        const model = invocation?.modelInvocable === true
        const user = invocation?.userInvocable === true
        const label = model && user ? '模型/人工' : model ? '仅模型' : user ? '仅人工' : '不可调用'
        return h('span', {
          className: 'ptTag',
          'data-tone': model || user ? undefined : 'warn',
          title: '模型可见 = 会出现在 skill-catalog 与 skill 工具里；人工可调用 = 会出现在 / 目录里',
        }, label)
      }

      /**
       * 归属：能解析就跳插件页；解析不到时给原因，不显示成空。
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
            h('span', { className: 'ptSub', style: { marginLeft: '6px' } }, skill.via === 'provider' ? '按 provider 匹配' : '按源码扫描匹配'),
          )
        }
        return h('span', { className: 'ptSub' }, skill.ownerReason ?? '未归属')
      }

      /**
       * 正文区：展开后读取，读取中 / 失败 / 截断各有独立文案。
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
        return h(
          'div',
          { style: { marginTop: '10px' } },
          h(
            'p',
            { className: 'ptSub', style: { margin: '0 0 4px' } },
            `正文 ${data.length ?? 0} 字`,
            data.truncated === true ? ' · 已按展示上限截断' : '',
          ),
          h('pre', { className: 'ptPromptText' }, typeof data.content === 'string' ? data.content : ''),
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
        const fileTag = typeof skill.path === 'string' ? '文件' : '虚拟'
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
              h('span', { className: 'ptTag', title: '发现的来源目录' }, skill.source || '未知来源'),
              h('span', { className: 'ptTag', title: '提供方：决定正文与资源的权限边界' }, skill.provider || '未知 provider'),
              invocationTag(skill.invocation),
              rowEnd(
                h('span', { className: 'ptCount', title: typeof skill.path === 'string' ? skill.path : '没有指令文件（虚拟技能）' }, fileTag),
              ),
            ),
            h(
              'div',
              { style: { padding: '10px 12px' } },
              h(
                'dl',
                { className: 'ptFacts', style: { margin: 0 } },
                fact('指令文件', typeof skill.path === 'string' ? h('code', null, skill.path) : null),
                fact('来源', skill.source || null),
                fact('provider', skill.provider ? h('code', null, skill.provider) : null),
                fact('调用性', `${skill.invocation?.modelInvocable === true ? '模型可见' : '模型不可见'} · ${skill.invocation?.userInvocable === true ? '人工可调用' : '人工不可调用'}`),
                fact('资源基座', skill.resourceBase === undefined ? null : resourceText(skill.resourceBase)),
                fact('何时使用', skill.whenToUse ?? null),
                fact('归属', ownersNode(skill, vc)),
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
        const counts = data.counts ?? { total: all.length, model: 0, user: 0, withPath: 0, bySource: {} }
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
            h('span', { className: 'ptCount', title: '带指令文件路径的技能' }, `文件 ${counts.withPath}`),
            Object.entries(counts.bySource ?? {}).map(([source, count]) => h(
              'span',
              { key: source, className: 'ptTag', title: '按发现来源计数' },
              `${source} ${count}`,
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
