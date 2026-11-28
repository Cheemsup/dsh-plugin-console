/**
 * 插件详情 · 能力面归属（运行时）：只列 owners 里含本行的条目。
 *
 * 快照只带源码扫描出来的名字，运行时清单按工作区 / 模式 / 会话懒取，所以这一段
 * 默认收起，展开时才读技能、命令、网络三条路由。归属口径与能力面完全一致：
 * host 的 `surface-owners` 解析出 `owners`，这里只按行 id 过滤，不重新猜。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.plugin-surface.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.plugin-surface.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useState } = React

    return function create(deps) {
      const {
        fetchJson, textButton, formatSessionId, ownerLabel,
        SKILLS_ROUTE, COMMANDS_ROUTE, NETWORK_ROUTE,
      } = deps

      /** 归属方式的界面词：回答「这条为什么算在这个插件名下」。 */
      const VIA_LABELS = {
        provider: '按 provider 匹配',
        definitionId: '按 definitionId 匹配',
        config: '按配置项匹配',
        scan: '按源码扫描匹配',
      }

      /**
       * 拼查询串。
       *
       * 不用 `URLSearchParams`：客户端 chunk 在自检里跑在最小 vm 上下文里，
       * 只保证有标准编码函数；手工拼也更容易看清哪些空条件被丢掉了。
       * @param {object} params - 键值；空串与 undefined 不参与。
       * @returns {string} `?a=b` 或空串。
       */
      function queryOf(params) {
        const parts = Object.keys(params)
          .filter((key) => typeof params[key] === 'string' && params[key].length > 0)
          .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(params[key]))
        return parts.length === 0 ? '' : '?' + parts.join('&')
      }

      /**
       * 行是否归属本插件。
       *
       * 两个 id 都试：快照的 `entryId` 带 `include:` 前缀，能力面的 owners 统一
       * 用的是去掉前缀的行 id；同一行被两种 id 引用时都能命中。
       * @param {object} row - 带 owners 的能力面行。
       * @param {string[]} ids - 本行的 rowId / entryId。
       * @returns {boolean} 是否归属。
       */
      function ownedBy(row, ids) {
        if (!Array.isArray(row?.owners)) return false
        return ids.some((id) => row.owners.includes(id))
      }

      /**
       * 把三条路由的结果收敛成这个插件的清单。
       *
       * 纯函数：自检直接喂三份响应即可验证过滤口径，不需要发请求。
       * 技能入口（命令段里的 user-invocable skill）不重复收：技能段已经全量覆盖。
       * 网络只收运行时注册表与入站路由；源码调用点在上方「网络（源码扫描）」组。
       * @param {{skills: object, commands: object, network: object}} source - 三段状态。
       * @param {string[]} ids - 本行的 rowId / entryId。
       * @returns {object} 分离好的清单。
       */
      function filterSurfaceForOwner(source, ids) {
        const skills = source?.skills?.data?.skills ?? []
        const commands = [
          ...(source?.commands?.data?.commands ?? []),
          ...(source?.commands?.data?.scanOnly ?? []),
        ]
        const llm = source?.network?.data?.llm?.providers ?? []
        const searchProviders = source?.network?.data?.web?.search?.providers ?? []
        const fetchProviders = source?.network?.data?.web?.fetch?.providers ?? []
        const servers = source?.network?.data?.mcp?.servers ?? []
        const routes = source?.network?.data?.inbound?.routes ?? []
        return {
          skills: skills.filter((row) => ownedBy(row, ids)),
          commands: commands.filter((row) => ownedBy(row, ids)),
          providers: [
            ...llm.map((row) => ({ ...row, type: '模型' })),
            ...searchProviders.map((row) => ({ ...row, type: '搜索' })),
            ...fetchProviders.map((row) => ({ ...row, type: '抓取' })),
          ].filter((row) => ownedBy(row, ids)),
          servers: servers.filter((row) => ownedBy(row, ids)),
          routes: routes.filter((row) => ownedBy(row, ids)),
        }
      }

      /**
       * 归属方式的悬停说明；没有 via 的旧响应不硬写。
       * @param {object} row - 能力面行。
       * @returns {string} 说明。
       */
      function viaText(row) {
        const label = VIA_LABELS[row?.via]
        return label === undefined ? '归属方式未记录' : label
      }

      /**
       * 运行时段。
       *
       * 只有展开才发请求；三段各自更新，技能目录慢不会拖住命令与网络。
       * @param {object} props - `entry / snapshot / surface / onOpenSurface`。
       * @returns {object} React 节点。
       */
      function RuntimeSurface({ entry, snapshot, surface, onOpenSurface }) {
        const [skills, setSkills] = useState({ status: 'idle' })
        const [commands, setCommands] = useState({ status: 'idle' })
        const [network, setNetwork] = useState({ status: 'idle' })
        const [loaded, setLoaded] = useState(false)

        const workspace = typeof surface?.workspacePath === 'string' ? surface.workspacePath : undefined
        const preset = typeof surface?.presetId === 'string' ? surface.presetId : undefined
        const sessionId = typeof surface?.sessionId === 'string' ? surface.sessionId : undefined
        // 有会话时宿主按会话自己的预设读；这里如实把 shown 的那个传过去。
        const sessionPreset = typeof surface?.sessionPreset === 'string' ? surface.sessionPreset : preset
        const ids = [entry.rowId, entry.entryId].filter((id) => typeof id === 'string' && id.length > 0)
        const owner = entry.rowId
        // 空态文案用界面名，不把 Loader 行 id 当成插件名直接念出来。
        const ownerName = ownerLabel(snapshot, owner)

        /** 读一段；路由不可用也写进状态，界面才能解释为什么空。 */
        const read = (route, params, set) => {
          if (typeof fetchJson !== 'function' || typeof route !== 'string') {
            set({ status: 'error', reason: '当前环境不支持读取能力面' })
            return
          }
          set({ status: 'loading' })
          Promise.resolve(fetchJson(route + queryOf(params)))
            .then((data) => set({ status: 'ready', data }))
            .catch((error) => set({ status: 'error', reason: error instanceof Error ? error.message : String(error) }))
        }

        /** 展开时读一次；之后收起再展开沿用同一份结果，条件变了详情会重挂载。 */
        const load = () => {
          if (loaded) return
          setLoaded(true)
          read(SKILLS_ROUTE, { workspace, preset }, setSkills)
          read(COMMANDS_ROUTE, { session: sessionId, preset: sessionPreset, workspace }, setCommands)
          read(NETWORK_ROUTE, {}, setNetwork)
        }

        const filtered = filterSurfaceForOwner({ skills, commands, network }, ids)
        const allReady = skills.status === 'ready' && commands.status === 'ready' && network.status === 'ready'
        const settled = [skills, commands, network].every((state) => state.status === 'ready' || state.status === 'error')
        const total = filtered.skills.length + filtered.commands.length
          + filtered.providers.length + filtered.servers.length + filtered.routes.length

        const summary = !loaded
          ? '展开后按能力面当前条件读取'
          : settled
            ? `技能 ${filtered.skills.length} · 命令 ${filtered.commands.length} · 网络 ${filtered.providers.length + filtered.servers.length + filtered.routes.length}`
              + (allReady ? '' : '（部分读取失败）')
            : '读取中…'

        /**
         * 一段的标题与内容：状态、不可用原因、空态由调用方给，条目渲染也由调用方给。
         * @param {string} title - 段标题。
         * @param {object} state - 该路由状态。
         * @param {number} count - 已过滤条目数。
         * @param {string} empty - 空态文案。
         * @param {Function} items - 返回条目节点。
         * @returns {object} React 节点。
         */
        const group = (title, state, count, empty, items) => h(
          'div',
          { className: 'ptSubSection', style: { marginTop: '8px' } },
          h('p', { className: 'ptSubTitle' }, `${title}（${count}）`),
          state.status === 'loading'
            ? h('p', { className: 'ptHint' }, '读取中…')
            : state.status === 'error'
              ? h('p', { className: 'ptHint', style: { color: 'var(--pt-warn)' } }, state.reason)
              : state.status !== 'ready'
                ? null
                : state.data?.available === false
                  ? h('p', { className: 'ptHint', style: { color: 'var(--pt-warn)' } }, state.data.reason ?? '服务不可用')
                  : count === 0
                    ? h('p', { className: 'ptHint' }, empty)
                    : items(),
        )

        /** 一个跳到能力面的标签；`name` 只在运行时行确实存在时传。 */
        const jumpTag = (key, label, segment, name, title) => h(
          'button',
          {
            key,
            type: 'button',
            className: 'ptTag ptLink',
            title,
            onClick: () => onOpenSurface(segment, name === undefined ? { owner } : { owner, name }),
          },
          label,
        )

        const conditions = [
          workspace === undefined ? '工作区 未指定' : '工作区 ' + workspace,
          preset === undefined ? '模式 默认' : '模式 ' + preset,
          sessionId === undefined ? null : '会话 ' + formatSessionId(sessionId),
        ].filter((part) => part !== null).join(' · ')

        return h(
          'div',
          { className: 'ptSection' },
          h(
            'p',
            {
              className: 'ptSectionTitle',
              title: '按能力面当前条件懒取，只列 owners 里含本行的条目；源码扫描的登记名见上方两组',
            },
            '能力面归属（运行时）',
          ),
          h(
            'details',
            {
              className: 'ptFold ptFoldable',
              onToggle: (event) => {
                if (event.currentTarget.open === true) load()
              },
            },
            h(
              'summary',
              null,
              h('span', { className: 'ptFoldChevron' }, '▶'),
              h('span', { className: 'ptSub', title: '能力面的条件由该页的条件栏决定；这里沿用同一份，读的是同一个部署事实' }, summary),
            ),
            h(
              'div',
              { className: 'ptFoldBody' },
              h('p', { className: 'ptSub', style: { margin: '0 0 6px' } }, '按能力面当前条件：', conditions),
              group(
                '技能',
                skills,
                filtered.skills.length,
                `当前条件下没有归属插件「${ownerName}」的技能。`,
                () => h(
                  'div',
                  { className: 'ptChipGroup' },
                  filtered.skills.map((skill) => jumpTag(
                    'skill:' + skill.name,
                    skill.name,
                    'skills',
                    skill.name,
                    `${viaText(skill)} · provider ${skill.provider || '未知'} · 来源 ${skill.source || '未知'}`
                      + (typeof skill.description === 'string' && skill.description.length > 0 ? ' · ' + skill.description : ''),
                  )),
                ),
              ),
              group(
                '斜杠命令',
                commands,
                filtered.commands.length,
                `当前条件下没有归属插件「${ownerName}」的斜杠命令。`,
                () => h(
                  'div',
                  { className: 'ptChipGroup' },
                  filtered.commands.map((command) => jumpTag(
                    'command:' + command.name,
                    '/' + command.name,
                    'commands',
                    command.name,
                    `${viaText(command)} · ${command.evidence === 'scan' ? '源码扫描' : '运行时目录'}`
                      + (typeof command.description === 'string' && command.description.length > 0 ? ' · ' + command.description : ''),
                  )),
                ),
              ),
              h(
                'div',
                { className: 'ptSubSection', style: { marginTop: '8px' } },
                h(
                  'div',
                  { className: 'ptSectionHead' },
                  h('span', { className: 'ptSubTitle' }, '网络（受控出口与入站）'),
                  textButton('在能力面查看', () => onOpenSurface('network', { owner }), {
                    title: '在能力面网络段只看归属这个插件的条目',
                  }),
                ),
                network.status === 'loading'
                  ? h('p', { className: 'ptHint' }, '读取中…')
                  : network.status === 'error'
                    ? h('p', { className: 'ptHint', style: { color: 'var(--pt-warn)' } }, network.reason)
                    : network.status !== 'ready'
                      ? null
                      : h(
                          React.Fragment,
                          null,
                          network.data?.llm?.available === false
                            || network.data?.web?.search?.available === false
                            || network.data?.web?.fetch?.available === false
                            || network.data?.mcp?.available === false
                            ? h('p', { className: 'ptHint', style: { color: 'var(--pt-warn)' } }, '部分网络服务不可用，下面只列出能读到的部分。')
                            : null,
                          group(
                            'Provider',
                            { status: 'ready', data: network.data },
                            filtered.providers.length,
                            '当前条件下没有归属这个插件的 provider。',
                            () => h(
                              'div',
                              { className: 'ptChipGroup' },
                              filtered.providers.map((row) => jumpTag(
                                'provider:' + row.type + ':' + row.id,
                                row.type + ' · ' + row.id,
                                'network',
                                undefined,
                                `${viaText(row)} · 运行时 provider 注册表`,
                              )),
                            ),
                          ),
                          group(
                            'MCP server',
                            { status: 'ready', data: network.data },
                            filtered.servers.length,
                            '当前条件下没有归属这个插件的 MCP server。',
                            () => h(
                              'div',
                              { className: 'ptChipGroup' },
                              filtered.servers.map((row) => jumpTag(
                                'mcp:' + row.name,
                                row.name,
                                'network',
                                undefined,
                                `${viaText(row)} · 运行时 mcpManager.list()`,
                              )),
                            ),
                          ),
                          group(
                            '入站路由',
                            { status: 'ready', data: network.data },
                            filtered.routes.length,
                            '当前条件下没有归属这个插件的入站路由。',
                            () => h(
                              'div',
                              { className: 'ptChipGroup' },
                              filtered.routes.map((row) => jumpTag(
                                'route:' + row.path,
                                row.path,
                                'network',
                                undefined,
                                `${row.evidence === 'label' ? 'effect label 所在行' : '源码 path 字面量'} · 入站路由`,
                              )),
                            ),
                          ),
                          allReady && total === 0
                            ? h('p', { className: 'ptHint' }, '当前条件下没有归属这个插件的运行时能力面条目；源码扫描到的登记名见上方两组。')
                            : null,
                        ),
              ),
              total > 0
                ? h(
                    'p',
                    { style: { margin: '8px 0 0' } },
                    textButton(
                      '在能力面按此插件查看',
                      () => onOpenSurface(
                        filtered.skills.length > 0 ? 'skills' : filtered.commands.length > 0 ? 'commands' : 'network',
                        { owner },
                      ),
                      { title: '跳到能力面并只看归属这个插件的条目' },
                    ),
                  )
                : null,
            ),
          ),
        )
      }

      return { RuntimeSurface, filterSurfaceForOwner }
    }
  },
})
