/**
 * 会话视图：从这个会话往上追它的插件是哪来的。
 *
 * 三段追溯链：`全局插件 → 模式要求的插件 → 本会话已挂载`。前两段是「记录/要求」，
 * 第三段才是在跑的东西——只有活着的会话有第三层。
 * 绑了提示词模板的会话会多一行开关（`activationRow`），那是「这个会话出了问题时
 * 先把提示词模板关掉」的安全阀。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.sessions.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.sessions.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const {
        modeTitle, formatSessionId, formatAge, resultText, rowEnd,
        selectField, textButton, inlineMeta, toggleIn, setAll, activateOnKey,
        sessionDetail, search,
      } = deps

      /**
       * 判断一个会话能否作为一组的渲染根。
       *
       * 默认口径：没有父，或父不在索引里（子会话会作为父行的子行出现，不能重复渲染）。
       * 搜索激活时传 `visible`：父不在可见集合里也算根——父被裁掉之后，命中会话
       * 得自己顶上，否则它既不是根、又接不到任何树上。
       * @param {object} session - 会话记录。
       * @param {Map<string, object>} allSessions - 全部会话索引。
       * @param {Set<string> | null} [visible] - 搜索激活时的可见集合。
       * @returns {boolean} 是否是渲染根。
       */
      function isTreeRoot(session, allSessions, visible) {
        const parentId = session.parentSession
        if (typeof parentId !== 'string') return true
        const parent = allSessions.get(parentId)
        if (parent === undefined) return true
        if (visible === null || visible === undefined) return false
        return !visible.has(parent.id)
      }

      /**
       * 会话字段是否命中搜索。
       *
       * 模式既匹配显示名也匹配 id：界面写「标准模式」，用户就会搜「标准」，
       * 而记录里只有 `standard`。cwd 与 id 一并参与：它们都在行上看得见。
       * @param {object} session - 会话记录。
       * @param {Map<string, object>} presetsById - 模式索引。
       * @param {string} query - 页头搜索词。
       * @returns {boolean} 是否命中。
       */
      function sessionMatches(session, presetsById, query) {
        const mode = presetsById.get(session.preset)
        const modeLabel = session.preset ? modeTitle(mode ?? { id: session.preset }) : undefined
        return search.matchesQuery(query, [session.title, session.id, session.cwd, session.preset, modeLabel])
      }

      /**
       * 沿 parentSession 向上补祖先链。
       *
       * 命中的是子会话时，它自己不是派发树的根；不补祖先，这一行根本没有位置可渲染。
       * @param {object} session - 会话记录。
       * @param {Map<string, object>} allSessions - 全部会话索引。
       * @returns {object[]} 从父到根的祖先。
       */
      function ancestorsOf(session, allSessions) {
        const out = []
        const seen = new Set([session.id])
        let id = session.parentSession
        while (typeof id === 'string' && !seen.has(id)) {
          const parent = allSessions.get(id)
          if (parent === undefined) break
          out.push(parent)
          seen.add(id)
          id = parent.parentSession
        }
        return out
      }

      /**
       * 派发树里挂在某个会话下面的全部后代（可以跨工作区）。
       * @param {object} session - 会话记录。
       * @param {object} snapshot - 快照。
       * @returns {string[]} 后代 id。
       */
      function descendantsOf(session, snapshot) {
        const nodes = snapshot.dispatch?.nodes ?? []
        const out = []
        const queue = [session.id]
        while (queue.length > 0) {
          const parentId = queue.shift()
          for (const node of nodes) {
            if (node.parentId !== parentId) continue
            out.push(node.id)
            queue.push(node.id)
          }
        }
        return out
      }

      /**
       * 一次筛选的完整结果：时间、工作区与搜索同时生效。
       *
       * 视图与工具条共用这一份：工具条要显示「显示 N / M 个会话」，视图要用同一个
       * 可见集合决定哪些行留下。分两处各算一次，读数与列表迟早会对不上。
       *
       * 搜索是两级命中：工作区字段命中→整组保留；会话字段命中→只留命中会话，
       * 连同它的子树与祖先链。
       * @param {object} vc - 视图上下文。
       * @returns {{groups: object[], visible: Set<string>|null, context: Set<string>, pinnedOpen: string|null, searching: boolean, shown: number, total: number, inRange: Function}} 筛选结果。
       */
      function selectSessionGroups(vc) {
        const { snapshot, query, recentDays, workspaceFilter, allSessions, openSession } = vc
        const presetsById = new Map((snapshot.modes ?? []).map((mode) => [mode.id, mode]))
        const filterKey = workspaceFilterOf(snapshot, workspaceFilter)

        // 时间过滤先于分组：一个工作区可能只剩部分会话命中。
        const cutoff = recentDays === 0 ? 0 : Date.now() - recentDays * 86400000
        const inRange = (session) => cutoff === 0 || (typeof session.createdAt === 'number' && session.createdAt >= cutoff)

        const groups = [
          ...(snapshot.workspaces ?? []).map((workspace) => {
            const all = (workspace.sessions ?? []).filter(inRange)
            return {
              key: workspace.id,
              title: workspace.title || workspace.path || workspace.id,
              path: workspace.path,
              all,
              owned: workspace.sessions ?? [],
              workspaceLastActiveAt: workspace.lastActiveAt,
            }
          }),
          {
            key: '__ungrouped',
            title: '未归属工作区的会话',
            path: undefined,
            all: (snapshot.ungroupedSessions ?? []).filter(inRange),
            owned: snapshot.ungroupedSessions ?? [],
          },
        ]
          .map((group) => ({
            ...group,
            // 最近活跃的工作区排前面。
            lastActiveAt: group.workspaceLastActiveAt ?? latestOf(group.all),
          }))
          .filter((group) => filterKey === null || group.key === filterKey)
          .sort((left, right) => {
            if (left.key === '__ungrouped') return 1
            if (right.key === '__ungrouped') return -1
            return (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0)
          })

        const searching = search.normalizeQuery(query) !== ''
        const visible = searching ? new Set() : null
        const context = new Set()
        if (searching) {
          // 工作区字段命中：用户找的是工作区，整组会话都保留。
          for (const group of groups) {
            if (!search.matchesQuery(query, [group.title, group.path])) continue
            for (const session of group.all) {
              visible.add(session.id)
              for (const id of descendantsOf(session, snapshot)) visible.add(id)
            }
          }
          // 会话字段命中：只留命中会话与它的子树；子会话命中时沿祖先链补位置。
          for (const group of groups) {
            for (const session of group.all) {
              if (!sessionMatches(session, presetsById, query)) continue
              visible.add(session.id)
              for (const id of descendantsOf(session, snapshot)) visible.add(id)
              for (const ancestor of ancestorsOf(session, allSessions)) {
                if (!inRange(ancestor)) continue
                visible.add(ancestor.id)
                context.add(ancestor.id)
              }
            }
          }
        }
        // 正在读的详情不因输入而消失：它可能是此刻唯一要对照的东西。
        const open = typeof openSession === 'string' ? allSessions.get(openSession) : undefined
        const pinnedOpen = searching && open !== undefined && !visible.has(open.id) ? open.id : null
        if (pinnedOpen !== null) {
          visible.add(open.id)
          for (const ancestor of ancestorsOf(open, allSessions)) {
            if (!inRange(ancestor)) continue
            visible.add(ancestor.id)
            context.add(ancestor.id)
          }
        }

        const shownGroups = groups
          .map((group) => ({
            ...group,
            // 能画出来的根：可见、且没有可见祖先的那些会话。
            //
            // 父被时间范围或搜索裁掉时，命中会话自己成为这一组的根——否则它既不是根、
            // 又接不到任何树上，明明命中了却整组消失。
            roots: group.all
              .filter((session) => visible === null || visible.has(session.id))
              .filter((session) => isTreeRoot(session, allSessions, visible))
              .sort((left, right) => lastOf(right) - lastOf(left)),
          }))
          .filter((group) => group.roots.length > 0)
        const total = groups.reduce((sum, group) => sum + group.all.length, 0)
        const shown = visible === null
          ? total
          : groups.reduce((sum, group) => sum + group.all.filter((session) => visible.has(session.id)).length, 0)
        return { groups: shownGroups, visible, context, pinnedOpen, searching, shown, total, inRange }
      }

      /**
       * 会话视图：从会话往上追插件来源。
       *
       * 这是回答「这个会话的插件是哪来的」的唯一入口——别的视图看不出模式这一层。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderSessionsView(vc) {
        const {
          recentDays, setWorkspaceFilter, setRecentDays, setQuery,
          collapsedWorkspaces, setCollapsedWorkspaces,
          activationNotice, cleanupNotice, query,
        } = vc
        const presetsById = new Map((vc.snapshot.modes ?? []).map((mode) => [mode.id, mode]))
        const selection = selectSessionGroups(vc)
        const groups = selection.groups

        if (!groups.length) {
          return h(
            'div',
            { className: 'ptEmpty' },
            recentDays === 0 ? '没有匹配的会话。' : `最近 ${recentDays} 天内没有会话。`,
            // 工作区、时间与搜索是三个独立条件；空结果时给一个一次清空三者的出口。
            h(
              'div',
              { style: { marginTop: '10px' } },
              textButton('清除筛选', () => {
                setWorkspaceFilter(null)
                setRecentDays(0)
                setQuery('')
              }),
            ),
          )
        }

        return h(
          'div',
          null,
          activationNotice !== null
            ? h('p', { className: 'ptNotice', style: { margin: '0 0 10px' } }, activationNotice)
            : null,
          cleanupNotice !== null && cleanupNotice !== undefined
            ? h('p', { className: 'ptNotice', style: { margin: '0 0 10px' } }, cleanupNotice)
            : null,
          groups.map((group) => {
            // 搜索激活时忽略折叠：命中藏在收起的组里，页面看起来就是空的。
            const open = selection.searching || !collapsedWorkspaces.has(group.key)
            const inGroup = selection.visible === null
              ? group.all.length
              : group.all.filter((session) => selection.visible.has(session.id)).length
            return h(
              'section',
              { key: group.key, style: { marginBottom: '14px' } },
              h(
                'div',
                {
                  className: selection.searching ? 'ptGroupHead' : 'ptGroupHead ptGroupHeadClickable',
                  role: selection.searching ? undefined : 'button',
                  tabIndex: selection.searching ? undefined : 0,
                  'aria-expanded': open ? 'true' : 'false',
                  onClick: selection.searching ? undefined : () => toggleIn(setCollapsedWorkspaces, group.key),
                  onKeyDown: selection.searching ? undefined : (event) => activateOnKey(event, () => toggleIn(setCollapsedWorkspaces, group.key)),
                },
                h('span', { className: 'ptChevron', 'data-open': open ? 'true' : 'false' }, '▶'),
                h('span', null, search.markQuery(group.title, query)),
                h(
                  'span',
                  { className: 'ptCount', title: selection.searching ? '筛选中：本组命中的会话 / 本组会话' : undefined },
                  selection.searching ? `${inGroup} / ${group.all.length} 个会话` : group.all.length + ' 个会话',
                ),
                // 最近活跃与路径都是读数，统一放在右端；标题行只留「这是哪个工作区、有多少会话」。
                rowEnd(
                  typeof group.lastActiveAt === 'number'
                    ? h('span', { className: 'ptMeta', title: '这个工作区最近一次会话写入的时间' }, '最近活跃 ' + formatAge(group.lastActiveAt))
                    : null,
                  group.path ? h('span', { className: 'ptMeta' }, search.markQuery(group.path, query)) : null,
                ),              ),
              open
                ? h(
                    'ul',
                    { className: 'ptList' },
                    group.roots.flatMap((session) => sessionTreeRows(session, presetsById, vc.snapshot, 0, selection, vc)),
                  )
                : null,
            )
          }),
        )
      }

      /** 一个会话的最近活跃时间；宿主没给时退回创建时间。 */
      function lastOf(session) {
        if (typeof session?.lastActiveAt === 'number') return session.lastActiveAt
        return typeof session?.createdAt === 'number' ? session.createdAt : 0
      }

      /** 一组会话里最晚的活跃时间。 */
      function latestOf(sessions) {
        let latest = 0
        for (const session of sessions ?? []) latest = Math.max(latest, lastOf(session))
        return latest
      }

      /** 会话页筛选：时间范围 + 工作区 + 分组折叠 + 结果数。 */
      function renderSessionFilters(vc) {
        const {
          snapshot, recentDays, setRecentDays, workspaceFilter, setWorkspaceFilter,
          setCollapsedWorkspaces,
        } = vc
        const keys = [...(snapshot.workspaces ?? []).map((workspace) => workspace.id), '__ungrouped']
        const ungroupedCount = (snapshot.ungroupedSessions ?? []).length
        // 结果数与视图共用同一份筛选结果：两处各算一次，数字和列表会对不上。
        const selection = selectSessionGroups(vc)
        return h(
          React.Fragment,
          null,
          selectField('时间', String(recentDays), [
            { value: '0', label: '全部时间' },
            { value: '1', label: '今天' },
            { value: '7', label: '近 7 天' },
            { value: '30', label: '近 30 天' },
          ], (value) => setRecentDays(Number(value))),
          selectField('工作区', workspaceFilterOf(snapshot, workspaceFilter) ?? '', [
            { value: '', label: '不限工作区' },
            ...(snapshot.workspaces ?? []).map((workspace) => ({
              value: workspace.id,
              label: (workspace.title || workspace.path || workspace.id) + '（' + (workspace.sessions ?? []).length + '）',
            })),
            ungroupedCount > 0 ? { value: '__ungrouped', label: '未归属工作区（' + ungroupedCount + '）' } : null,
          ], (value) => setWorkspaceFilter(value === '' ? null : value), {
            title: '只显示所选工作区的会话，与时间、搜索同时生效',
          }),
          resultText(selection.shown, selection.total, ' 个会话'),
          h(
            'div',
            { className: 'ptActions' },
            textButton('折叠全部', () => setAll(setCollapsedWorkspaces, keys, true)),
            textButton('展开全部', () => setAll(setCollapsedWorkspaces, [], false)),
          ),
        )
      }

      /**
       * 工作区筛选的有效值。
       *
       * 快照刷新后选中的工作区可能已经不存在（或未归属组变空）；这时按「不限」处理，
       * 否则下拉框会停在一个没有对应 `option` 的值上，看起来像筛选失效。
       * @param {object} snapshot - 快照。
       * @param {string | null} workspaceFilter - 状态里的筛选值。
       * @returns {string | null} 仍然存在的组 key；`null` 表示不限。
       */
      function workspaceFilterOf(snapshot, workspaceFilter) {
        if (workspaceFilter === null || workspaceFilter === undefined) return null
        if (workspaceFilter === '__ungrouped') {
          return (snapshot.ungroupedSessions ?? []).length > 0 ? '__ungrouped' : null
        }
        const exists = (snapshot.workspaces ?? []).some((workspace) => workspace.id === workspaceFilter)
        return exists ? workspaceFilter : null
      }

      /**
       * 把一棵派发子树摊成行：父在前，子缩进。
       *
       * 子会话可能属于别的工作区（父在工作区 A、子在 B），所以不能依赖分组已经
       * 把它们放在一起——这里按 `dispatch.nodes` 的 parentId 反查，跨组也能接上。
       * @param {object} session - 当前行对应的会话。
       * @param {Map<string, object>} presetsById - 模式索引。
       * @param {object} snapshot - 快照。
       * @param {number} depth - 缩进层级。
       * @param {object} selection - `selectSessionGroups` 的结果：时间谓词与可见集合。
       * @param {object} vc - 视图上下文。
       * @returns {Array<object>} React 节点数组。
       */
      function sessionTreeRows(session, presetsById, snapshot, depth, selection, vc) {
        const row = sessionRow(session, presetsById, snapshot, depth, selection, vc)
        const nodes = snapshot.dispatch?.nodes ?? []
        const children = nodes
          .filter((node) => node.parentId === session.id)
          .map((node) => node.id)
          .map((id) => vc.allSessions.get(id))
          .filter((child) => child !== undefined && selection.inRange(child))
          // 命中会话的子树已整体保留；其余子会话按可见集合裁掉。
          .filter((child) => selection.visible === null || selection.visible.has(child.id))
        return [row, ...children.flatMap((child) => sessionTreeRows(child, presetsById, snapshot, depth + 1, selection, vc))]
      }

      /**
       * 一个会话行：默认收起，展开后是完整追溯链。
       * @param {object} session - 会话记录。
       * @param {Map<string, object>} presetsById - 模式索引。
       * @param {object} snapshot - 快照。
       * @param {number} depth - 缩进层级。
       * @param {object} selection - 筛选结果：用来标出上下文行与「当前打开」行。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function sessionRow(session, presetsById, snapshot, depth = 0, selection, vc) {
        const { openSession, setOpenSession } = vc
        const mode = presetsById.get(session.preset)
        const isOpen = openSession === session.id
        const label = session.preset ? modeTitle(mode ?? { id: session.preset }) : null
        const dispatched = typeof session.parentSession === 'string'
        const childCount = (snapshot.dispatch?.nodes ?? []).filter((node) => node.parentId === session.id).length
        // 这个会话有没有绑提示词模板。没绑就不出现开关——开关只管「提示词模板要不要生效」，
        // 无中生有一个开关只会让人以为是别的东西。
        const binding = (snapshot.bindings ?? {})[session.id]
        return h(
          'li',
          { key: session.id },
          h(
            'button',
            {
              type: 'button',
              className: 'ptRow',
              'data-selected': isOpen ? 'true' : 'false',
              'aria-expanded': isOpen ? 'true' : 'false',
              title: session.live ? '本进程仍持有这个会话，展开可看运行时实测' : '会话未激活，展开只看记录与声明',
              onClick: () => setOpenSession(isOpen ? null : session.id),
            },
            h('span', { className: 'ptIndent', style: { width: (depth * 16) + 'px' } }),
            h('span', {
              className: 'ptDot',
              'data-phase': session.live ? 'active' : 'none',
              role: 'img',
              'aria-label': session.live ? '本进程内会话仍存活' : '这个会话不在本进程内',
            }),
            h(
              'span',
              { className: 'ptName' },
              // 主标题用 DSH 侧边栏同一个值（session/title 投影）；没有标题时才退回 id。
              search.markQuery(session.title !== undefined ? session.title : formatSessionId(session.id), vc.query),
              h(
                'span',
                { className: 'ptModule', style: { display: 'block' } },
                search.markQuery(session.cwd ?? '（无 cwd 记录）', vc.query),
              ),
            ),
            dispatched
              ? session.origin === 'subagent'
                ? h('span', { className: 'ptTag', title: 'subagent：由父会话使用 subagent 工具时创建' }, 'subagent')
                : h('span', { className: 'ptTag', title: '分叉：从父会话中复制某些轮次然后新建会话（header.isSeeded = true）' }, '分叉')
              : null,
            childCount > 0 ? h('span', { className: 'ptTag', title: '有 ' + childCount + ' 个会话挂在它下面' }, '父会话') : null,
            binding !== undefined
              ? h('span', {
                  className: 'ptTag',
                  'data-tone': binding.enabled ? 'user' : 'warn',
                  // 继承来源放在句末：先回答「绑了什么」，再补「从哪继承」。
                  title: '这个会话绑定了提示词定制模板：' + sessionDetail.templateLabelOf(binding)
                    + (typeof binding.inheritedFrom === 'string' ? '（继承自 ' + binding.inheritedFrom + '）' : ''),
                }, binding.enabled ? (binding.materialized ? '提示词定制生效中' : '提示词定制已启用') : '提示词定制已停用')
              : null,
            // 读数与搜索期的临时标记统一靠右：左边只留「这个会话是什么」。
            rowEnd(
              selection.context.has(session.id)
                ? h('span', { className: 'ptTag', title: '命中会话的祖先，补进来只为保住派发树里的位置' }, '上下文')
                : null,
              selection.pinnedOpen === session.id
                ? h('span', { className: 'ptTag', 'data-tone': 'warn', title: '搜索没有命中它，但它正在被阅读，仍然留在列表里' }, '当前打开（不在结果中）')
                : null,
              inlineMeta([
                label !== null ? search.markQuery(label, vc.query) : h('span', { className: 'ptError' }, '未记录模式'),
                session.lastActiveAt ? h('span', { title: '最近活跃：会话日志最后写入时间 ' + new Date(session.lastActiveAt).toLocaleString() }, '活跃 ' + formatAge(session.lastActiveAt)) : null,
                session.createdAt ? h('span', { title: '创建时间：' + new Date(session.createdAt).toLocaleString() }, '创建 ' + formatAge(session.createdAt)) : null,
                session.runtime ? '实测 ' + session.runtime.modules.length : null,
              ]),
            ),
          ),
          isOpen ? sessionDetail.renderSessionTrace(session, presetsById, vc) : null,
        )
      }

      /** 模式展示名；roster 里没有时退回 id。 */
      function labelOf(mode, fallback) {
        if (mode !== undefined) return modeTitle(mode)
        return typeof fallback === 'string' ? fallback : '未记录'
      }

      return { renderSessionsView, renderSessionFilters, isTreeRoot, labelOf }
    }
  },
})
