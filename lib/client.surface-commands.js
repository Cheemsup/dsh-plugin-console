/**
 * 能力面 · 斜杠命令段：host 命令目录 + 人工可调用技能 + 源码扫描补集。
 *
 * 三段证据必须分开显示：活会话 / 预设 scope 是运行时目录，源码扫描只补名字。
 * 客户端贡献不在宿主侧，段头固定说明，避免把这张表当成完整的 `/` 菜单。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.surface-commands.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.surface-commands.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { rowEnd, search, textButton } = deps

      /**
       * 归属：运行时可跳插件页；源码扫描同样是行 id，也能跳。
       * @param {object} row - 命令 / 技能 / 扫描行。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function ownersNode(row, vc) {
        if (Array.isArray(row.owners) && row.owners.length > 0) {
          return row.owners.map((rowId) => h(
            'button',
            {
              key: rowId,
              type: 'button',
              className: 'ptTag ptLink',
              title: '在插件页展开这一行',
              onClick: () => vc.gotoPlugin(rowId),
            },
            rowId,
          ))
        }
        return [h('span', { className: 'ptTag', 'data-tone': 'warn', title: row.ownerReason ?? '没有找到归属' }, '未归属')]
      }

      /**
       * 一条 host 命令。
       * @param {object} command - 命令行。
       * @param {object} vc - 视图上下文。
       * @param {string} query - 页头搜索词。
       * @returns {object} React 节点。
       */
      function commandRow(command, vc, query) {
        const builtin = command.builtin
        return h(
          'li',
          { key: command.name, className: 'ptSurfaceRow' },
          h(
            'span',
            { className: 'ptName' },
            h('code', null, '/' + command.name),
            command.description.length > 0
              ? h('span', { className: 'ptModule', style: { display: 'block' } }, search.markQuery(command.description, query))
              : null,
          ),
          builtin !== undefined
            ? h('span', { className: 'ptTag', title: '内置命令的中英文拼写' }, '/' + builtin.tokens.zh + ' · /' + builtin.tokens.en)
            : null,
          command.input?.hint !== undefined
            ? h('span', { className: 'ptTag', title: '输入提示' }, command.input.hint)
            : null,
          command.definitionId !== undefined
            ? h('span', { className: 'ptTag', title: '稳定定义 id：归属的一等事实' }, command.definitionId)
            : null,
          rowEnd(...ownersNode(command, vc)),
        )
      }

      /**
       * 一个人工可调用技能入口。
       * @param {object} skill - 技能行。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function skillRow(skill, vc) {
        return h(
          'li',
          { key: 'skill:' + skill.name, className: 'ptSurfaceRow' },
          h(
            'span',
            { className: 'ptName' },
            h('code', null, '/' + skill.name),
            skill.description.length > 0
              ? h('span', { className: 'ptModule', style: { display: 'block' } }, skill.description)
              : null,
          ),
          h('span', { className: 'ptTag', title: '来自 userInvocable skill：输入 /名称 直接注入技能正文' }, '技能'),
          rowEnd(...ownersNode(skill, vc)),
        )
      }

      /**
       * 源码扫描补集：只有名字，没有运行时顺序与输入提示。
       * @param {object} row - 扫描行。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function scanRow(row, vc) {
        return h(
          'li',
          { key: 'scan:' + row.name, className: 'ptSurfaceRow' },
          h('span', { className: 'ptName' }, h('code', null, '/' + row.name)),
          h('span', { className: 'ptTag', title: '来自包源码的静态扫描，不是运行时目录' }, '源码扫描'),
          rowEnd(...ownersNode(row, vc)),
        )
      }

      /**
       * 命令段正文。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderCommandsSegment(vc) {
        const surface = vc.surface
        const state = surface.commands ?? { status: 'idle' }
        const query = vc.query ?? ''

        if (state.status === 'loading') return h('div', { className: 'ptEmpty' }, '读取斜杠命令目录…')
        if (state.status === 'error') {
          return h(
            'div',
            { className: 'ptEmpty' },
            state.error ?? '读取失败',
            h('div', { style: { marginTop: '10px' } }, textButton('重试', () => void surface.loadCommands(), { title: '按当前条件重新读取' })),
          )
        }
        const data = state.data
        if (data === null || data === undefined) return h('div', { className: 'ptEmpty' }, '选择会话或模式后读取命令目录。')

        const scopeLabel = data.scope === 'session'
          ? '活会话目录'
          : data.scope === 'preset'
            ? '预设 scope 目录（只读回退）'
            : '仅源码扫描'
        const commands = (data.commands ?? []).filter((row) => query === ''
          || search.matchesQuery(query, [row.name, row.description, row.definitionId, ...(row.owners ?? [])]))
        const skills = (data.skills ?? []).filter((row) => query === ''
          || search.matchesQuery(query, [row.name, row.description, ...(row.owners ?? [])]))
        const scanOnly = (data.scanOnly ?? []).filter((row) => query === ''
          || search.matchesQuery(query, [row.name, ...(row.owners ?? [])]))

        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'ptChipGroup', style: { marginBottom: '8px' } },
            h('span', { className: 'ptCount', title: '目录来源' }, scopeLabel),
            h('span', { className: 'ptCount', title: '运行时命令数' }, `命令 ${data.counts?.commands ?? 0}`),
            h('span', { className: 'ptCount', title: '人工可调用技能入口数' }, `技能入口 ${data.counts?.skills ?? 0}`),
            h('span', { className: 'ptCount', title: '运行时目录不可读时补出的源码扫描名字' }, `源码扫描 ${data.counts?.scanOnly ?? 0}`),
          ),
          data.reason !== undefined
            ? h('p', { className: 'ptHint', style: { color: 'var(--pt-warn)' } }, data.reason)
            : null,
          data.offContract === true
            ? h('p', { className: 'ptHint' }, '预设 scope 以 scope key 读取：签名写的是 Agent，这里只读列表。')
            : null,
          (data.notes ?? []).map((line) => h('p', { key: line, className: 'ptHint' }, line)),
          (data.warnings ?? []).map((line) => h('p', { key: line, className: 'ptHint' }, line)),

          h('p', { className: 'ptSubTitle' }, `斜杠命令（${commands.length}）`),
          commands.length === 0
            ? h('p', { className: 'ptHint' }, data.scope === 'scan-only' ? '运行时目录不可读，下面只有源码扫描结果。' : '这个条件下没有命令。')
            : h('ul', { className: 'ptList' }, commands.map((row) => commandRow(row, vc, query))),

          skills.length > 0
            ? h(
                React.Fragment,
                null,
                h('p', { className: 'ptSubTitle' }, `技能入口（${skills.length}）`),
                h('ul', { className: 'ptList' }, skills.map((row) => skillRow(row, vc))),
              )
            : null,

          scanOnly.length > 0
            ? h(
                React.Fragment,
                null,
                h('p', { className: 'ptSubTitle', title: '运行时目录里没有这些名字，或目录不可读' }, `源码扫描补集（${scanOnly.length}）`),
                h('ul', { className: 'ptList' }, scanOnly.map((row) => scanRow(row, vc))),
              )
            : null,
        )
      }

      return { renderCommandsSegment }
    }
  },
})
