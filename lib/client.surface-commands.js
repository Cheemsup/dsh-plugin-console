/**
 * 能力面 · 斜杠命令段：运行时命令目录 + 源码扫描补出的名字（合成一张表）+ 人工可调用技能。
 *
 * 这一页只回答「哪个插件提供了哪些斜杠命令」：命令的来源是运行时还是源码扫描不分区，
 * 每行只保留可跳转的归属。技能入口单独一组，因为它们是技能而不是注册的命令；
 * 没有归属行时用来源层级（项目 / 本机 / DSH / 配置 / 运行时）说明它们从哪来。
 * 客户端贡献不在宿主侧：这句边界收在来源标签的悬停说明里，正文只讲组装链条，
 * 避免把这张表当成完整的 `/` 菜单，也不让每次都要读一句免责声明。
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
      const { rowEnd, search, textButton, skillSourceLayer, UNOWNED_REASON, ownerLabel } = deps

      /**
       * 把来源层级的一句话拆成「正文 + 尾注」。
       *
       * 层级标题都以 `（source: …）` 收尾。悬停要把「是否由插件注册」插在尾注之前，
       * 保持一整句，而不是再拼一个分号短句。
       * @param {string} title - 层级标题。
       * @returns {{ body: string, note: string }} 去掉尾注的正文与尾注本身。
       */
      function splitSourceNote(title) {
        const match = /（[^（）]*）$/.exec(title)
        if (match === null) return { body: title, note: '' }
        return { body: title.slice(0, match.index), note: match[0] }
      }

      /**
       * 技能入口的来源标签。
       *
       * 技能不是注册制：目录发现、随包资产与运行时注册都没有「注册它的插件」这个
       * 概念，所以没有归属行是常态。这里给层级词（项目 / 本机 / DSH / 配置 /
       * 运行时），悬停用一句话说明位置与是否由插件注册，不把正常状态写成「未归属」。
       * @param {object} row - 技能行。
       * @returns {object} React 节点。
       */
      function skillSourceTag(row) {
        const raw = typeof row.source === 'string' ? row.source : ''
        const layer = skillSourceLayer(raw)
        const { body, note } = splitSourceNote(layer.title)
        // 运行时注册确实由插件写入，措辞跟目录型 / 随包型分开。
        const registered = raw === 'runtime' || row.provider === 'runtime'
        const title = registered
          ? `由插件在运行时注册，未定位到注册包${note}`
          : `${body}，不由插件注册${note}`
        return h('span', { className: 'ptTag', title }, layer.label)
      }

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
              title: '来源插件：' + rowId + ' · 点击在插件页查看',
              onClick: () => vc.gotoPlugin(rowId),
            },
            ownerLabel(vc.snapshot, rowId),
          ))
        }
        return [h('span', { className: 'ptTag', 'data-tone': 'warn', title: row.ownerReason ?? UNOWNED_REASON }, '未归属')]
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
          { key: command.name, className: 'ptSurfaceRow ptSurfaceRowStacked' },
          // 标题与标签固定在同一行：名字块吃掉剩余宽度并截断，标签不会换到下一行。
          h(
            'div',
            { className: 'ptSurfaceRowHead' },
            h('span', { className: 'ptName' }, h('code', null, '/' + command.name)),
            // 用法标签与归属都收进同一个右簇。
            // definitionId 是身份、不是来源：有归属行时它只会和 owner 重复，
            // 没有归属时 ownerReason 里已经带上它。
            rowEnd(
              builtin !== undefined
                ? h('span', { className: 'ptTag', title: '内置命令的中文拼写' }, '/' + builtin.tokens.zh)
                : null,
              command.input?.hint !== undefined
                ? h('span', { className: 'ptTag', title: '输入提示' }, command.input.hint)
                : null,
              ...ownersNode(command, vc),
            ),
          ),
          command.description.length > 0
            // 描述会在行内截断：悬停给出完整原文，不用为了看全而横向滚动。
            ? h('span', { className: 'ptModule', style: { display: 'block' }, title: command.description }, search.markQuery(command.description, query))
            : null,
        )
      }

      /**
       * 一个人工可调用技能入口。
       * @param {object} skill - 技能行。
       * @param {object} vc - 视图上下文。
       * @param {string} query - 页头搜索词。
       * @returns {object} React 节点。
       */
      function skillRow(skill, vc, query) {
        // 有归属行仍然跳插件页；没有时由来源层级接管，不显示警告色标签。
        const owners = Array.isArray(skill.owners) && skill.owners.length > 0
          ? ownersNode(skill, vc)
          : [skillSourceTag(skill)]
        return h(
          'li',
          { key: 'skill:' + skill.name, className: 'ptSurfaceRow ptSurfaceRowStacked' },
          h(
            'div',
            { className: 'ptSurfaceRowHead' },
            h('span', { className: 'ptName' }, h('code', null, '/' + skill.name)),
            rowEnd(...owners),
          ),
          skill.description.length > 0
            // 与命令描述同一种高亮与悬停：命中时看得出命中在哪，截断时悬停看全。
            ? h('span', { className: 'ptModule', style: { display: 'block' }, title: skill.description }, search.markQuery(skill.description, query))
            : null,
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

        // 会话已结束但仍在看它的目录：来源只能是「按它的模式 + 工作区拼出的预设 scope」，
        // 不能写成「预设 scope 目录」了事，否则会以为这就是该会话真实看到的目录。
        const scopeLabel = data.sessionState === 'inactive'
          ? '会话已结束 · 预设 scope 回退'
          : data.scope === 'session'
            ? '活会话目录'
            : data.scope === 'preset'
              ? '预设 scope 目录（只读回退）'
              : '仅源码扫描'
        // 这一页只回答「哪个插件提供了哪些斜杠命令」：运行时目录与源码扫描补出的
        // 名字合成一张表，按名字排序；来源是运行时还是扫描不再分成两个分区。
        const merged = [
          ...(data.commands ?? []),
          ...(data.scanOnly ?? []).map((row) => ({ ...row, description: '' })),
        ].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        // 从插件详情或某一行跳进来时按插件 / 名字收窄；两个条件同时给就都要满足。
        const focusOwner = typeof surface.focusOwner === 'string' && surface.focusOwner.length > 0
          ? surface.focusOwner
          : null
        const focusName = typeof surface.focusName === 'string' && surface.focusName.length > 0
          ? surface.focusName
          : null
        const matchesFocus = (row) => {
          if (focusOwner !== null && !(Array.isArray(row.owners) && row.owners.includes(focusOwner))) return false
          if (focusName !== null && row.name !== focusName) return false
          return true
        }
        // 行内看得见的字段都参与检索：内置别名与输入提示之前只显示、搜不到。
        const commands = merged.filter((row) => matchesFocus(row) && (query === ''
          || search.matchesQuery(query, [
            row.name,
            row.description,
            row.definitionId,
            row.builtin?.tokens?.zh,
            row.builtin?.tokens?.en,
            row.input?.hint,
            ...(row.owners ?? []),
            ...(row.owners ?? []).map((rowId) => ownerLabel(vc.snapshot, rowId)),
          ])))
        const skills = (data.skills ?? []).filter((row) => matchesFocus(row) && (query === ''
          || search.matchesQuery(query, [
            row.name,
            row.description,
            ...(row.owners ?? []),
            ...(row.owners ?? []).map((rowId) => ownerLabel(vc.snapshot, rowId)),
          ])))

        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'ptChipGroup', style: { marginBottom: '8px' } },
            h('span', { className: 'ptCount', title: '目录来源：目前只包括Cordis核心的路径来源，一些情况下可能缺失来源于客户端的命令' }, scopeLabel),
            h('span', { className: 'ptCount', title: '斜杠命令数（运行时目录 + 源码扫描补出的名字）' }, `命令 ${merged.length}`),
            h('span', { className: 'ptCount', title: '人工可调用技能入口数' }, `技能入口 ${data.counts?.skills ?? 0}`),
          ),
          (data.notes ?? []).map((line) => h('p', { key: line, className: 'ptHint' }, line)),
          (data.warnings ?? []).map((line) => h('p', { key: line, className: 'ptHint' }, line)),

          // 降级原因贴着命令表说：它解释的是「这张表的条目为什么少了」，
          // 不是页头条件的说明，所以排在标题前而不是计数上方。
          data.reason !== undefined
            ? h('p', { className: 'ptHint', style: { color: 'var(--pt-warn)' } }, data.reason)
            : null,
          focusName !== null || focusOwner !== null
            ? h(
                'p',
                { className: 'ptHint' },
                focusName !== null
                  ? `只看命令「/${focusName}」`
                  : `只看插件「${ownerLabel(vc.snapshot, focusOwner)}」的命令与技能入口`,
                focusName !== null && focusOwner !== null
                  ? `（归属插件「${ownerLabel(vc.snapshot, focusOwner)}」）`
                  : null,
                ' ',
                textButton('查看全部', surface.clearFocus),
              )
            : null,
          h('p', { className: 'ptSubTitle' }, `斜杠命令（${commands.length}）`),
          commands.length === 0
            ? h(
                'p',
                { className: 'ptHint' },
                data.scope === 'scan-only'
                  ? '运行时目录不可读，源码扫描也没有补出名字。'
                  : focusName !== null
                    ? `当前条件下没有名为「/${focusName}」的命令。`
                    : focusOwner !== null
                      ? `当前条件下没有归属插件「${ownerLabel(vc.snapshot, focusOwner)}」的斜杠命令。`
                      : '这个条件下没有命令。',
              )
            : h('ul', { className: 'ptList' }, commands.map((row) => commandRow(row, vc, query))),

          skills.length > 0 || (focusOwner !== null && focusName === null)
            ? h(
                React.Fragment,
                null,
                h('p', { className: 'ptSubTitle' }, `技能入口（${skills.length}）`),
                skills.length === 0
                  ? h(
                      'p',
                      { className: 'ptHint' },
                      `当前条件下没有归属插件「${ownerLabel(vc.snapshot, focusOwner)}」的技能入口。`,
                    )
                  : h('ul', { className: 'ptList' }, skills.map((row) => skillRow(row, vc, query))),
              )
            : null,
        )
      }

      return { renderCommandsSegment }
    }
  },
})
