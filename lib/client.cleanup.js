/**
 * 提示词模板数据清理的状态与动作。
 *
 * 单独成一个 chunk：它只依赖 shared 的请求函数和若干回调，不需要编辑器状态；
 * `client.store.js` 把「刷新快照 / 重取提示词模板列表 / 清空编辑器」作为参数传进来。
 *
 * 三种范围：
 *   - session：只清该会话的绑定与开关；
 *   - workspace：只清该工作区的绑定与开关，提示词模板定义保留；
 *   - all：清空全部并删除存储文件。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.cleanup.js')` 取它。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-console',
  chunk: 'client.cleanup.js',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useState } = React

    return function create(deps) {
      const { shared } = deps
      const { fetchJson, CLEANUP_ROUTE, selectField, h } = shared

      /** 清理目标的稳定标识，用来判断两次点击是不是同一个目标。 */
      function keyOf(target) {
        if (target === null) return null
        if (target.scope === 'session') return 'session:' + target.sessionId
        return target.scope === 'workspace' ? 'workspace:' + target.workspaceId : 'all'
      }

      /** 把接口结果说成一句人话。 */
      function describe(data) {
        if (data.scope === 'session') {
          return [
            '已清理会话 ' + data.sessionId,
            '绑定 ' + (data.removedManifests ?? 0) + ' 条',
            '开关 ' + (data.removedActivations ?? 0) + ' 条',
            '掩码 ' + (data.removedMasks ?? 0) + ' 条',
            '提示词模板定义保留（' + (data.keptTemplates ?? 0) + ' 个）',
            '运行中的会话不受影响',
          ].join(' · ')
        }
        if (data.scope === 'workspace') {
          const notes = [
            '已清理 ' + (data.touchedSessions ?? 0) + ' 个会话',
            '绑定 ' + (data.removedManifests ?? 0) + ' 条',
            '开关 ' + (data.removedActivations ?? 0) + ' 条',
            '提示词模板定义保留（' + (data.keptTemplates ?? 0) + ' 个）',
          ]
          if (data.liveSessionsUntouched === true) notes.push('运行中的会话不受影响')
          return notes.join(' · ')
        }
        const notes = [
          '已清除 ' + (data.removedTemplates ?? 0) + ' 个提示词模板',
          (data.removedRevisions ?? 0) + ' 条历史',
          '绑定 ' + (data.removedManifests ?? 0) + ' 条',
          '开关 ' + (data.removedActivations ?? 0) + ' 条',
        ]
        notes.push(data.fileDeleted === true
          ? '提示词模板文件已删除'
          : '提示词模板文件删除失败：' + (data.fileError ?? '原因未知'))
        if (data.liveSessionsUntouched === true) notes.push('运行中的会话不受影响')
        return notes.join(' · ')
      }

      /**
       * 清理状态。
       * @param {object} options - 回调。
       * @param {Function} options.reloadSnapshot - 重取快照。
       * @param {Function} options.loadTemplates - 重取提示词模板列表。
       * @param {Function} options.onClearedAll - 全局清理后把编辑器退回纯基线。
       * @returns {object} 清理状态与动作。
       */
      function useCleanupStore({ reloadSnapshot, loadTemplates, onClearedAll }) {
        const [cleanupPending, setCleanupPending] = useState(null)
        const [cleanupBusy, setCleanupBusy] = useState(null)
        const [cleanupNotice, setCleanupNotice] = useState(null)

        const runCleanup = useCallback(async (target) => {
          setCleanupBusy(keyOf(target))
          setCleanupNotice(null)
          try {
            const data = await fetchJson(CLEANUP_ROUTE, {
              method: 'POST',
              body: JSON.stringify(target.scope === 'session'
                ? { scope: 'session', sessionId: target.sessionId }
                : target.scope === 'workspace'
                  ? { scope: 'workspace', workspaceId: target.workspaceId }
                  : { scope: 'all' }),
            })
            setCleanupPending(null)
            setCleanupNotice(describe(data))
            await loadTemplates()
            if (target.scope === 'all') onClearedAll()
            await reloadSnapshot()
          } catch (cause) {
            setCleanupNotice('清理失败：' + (cause instanceof Error ? cause.message : String(cause)))
          } finally {
            setCleanupBusy(null)
          }
        }, [reloadSnapshot, loadTemplates, onClearedAll])

        const requestCleanup = useCallback((target) => {
          if (cleanupPending !== null && keyOf(cleanupPending) === keyOf(target)) {
            void runCleanup(target)
            return
          }
          setCleanupPending(target)
          setCleanupNotice(null)
        }, [cleanupPending, runCleanup])

        const cancelCleanup = useCallback(() => {
          setCleanupPending(null)
          setCleanupNotice(null)
        }, [])

        return {
          cleanupPending,
          cleanupBusy,
          cleanupNotice,
          requestCleanup,
          runCleanup,
          cancelCleanup,
        }
      }

      /**
       * 定制页底部的「清除提示词定制模板快照数据」卡片。
       *
       * 会话页只保留单会话清理；工作区与全部清理收在这里，因为它们动的是
       * 提示词模板存储本身，而不是某个会话的开关。两种范围都沿用两段式确认。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderCleanupCard(vc) {
        return h(CleanupCard, { vc })
      }

      function CleanupCard({ vc }) {
        const { snapshot, cleanupPending, cleanupBusy, cleanupNotice, requestCleanup, runCleanup, cancelCleanup } = vc
        const workspaces = snapshot?.workspaces ?? []
        const [scope, setScope] = useState('workspace')
        const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '')
        const effectiveWorkspace = workspaceId !== '' ? workspaceId : (workspaces[0]?.id ?? '')
        const target = scope === 'all'
          ? { scope: 'all' }
          : { scope: 'workspace', workspaceId: effectiveWorkspace }
        const pending = cleanupPending !== null && cleanupPending !== undefined && keyOf(cleanupPending) === keyOf(target)
        const busy = cleanupBusy !== null && cleanupBusy !== undefined
        const boundCount = countWorkspaceBindings(snapshot, effectiveWorkspace, vc.allSessions)
        const disabled = busy || (scope === 'workspace' && effectiveWorkspace === '')
        const label = scope === 'all' ? '清理全部提示词模板数据' : '清理本工作区绑定'
        // 范围不同、影响面也不同：说明收进标题的悬停里，不占正文行。
        const explain = scope === 'all'
          ? '会删除全部提示词定制模板、历史、绑定、开关、掩码与控制审计，并删除 plugin_console_templates.json。运行中的会话不受影响。'
          : '删除工作区会话（含派生子 Agent）的相关快照文件，运行中会话不受影响'

        return h(
          // 破坏性操作不常驻版面：收起时只留一行居中小字，点开才是真正的清理卡。
          // 用 details 而不是受控 state：展开/收起是纯显示状态，浏览器自己管更省事，
          // 也让键盘与无障碍行为保持原生。
          'details',
          { className: 'ptCleanupFold' },
          h(
            'summary',
            {
              className: 'ptCleanupSummary',
              title: '清理快照数据：展开后可以清理单个工作区的绑定，或删除全部提示词模板数据',
            },
            h('span', null, '清理快照数据'),
            h('span', { className: 'ptCleanupCaret', 'aria-hidden': 'true' }),
          ),
          h(
            'div',
            { className: 'ptCard ptDangerCard' },
            h(
              'div',
              { className: 'ptCardHead' },
              h('p', { className: 'ptCardTitle', title: explain }, '清除提示词定制模板快照数据'),
            ),
            h(
              'div',
              { className: 'ptCardRow' },
              selectField('范围', scope, [
                { value: 'workspace', label: '单个工作区的绑定' },
                { value: 'all', label: '全部提示词模板数据' },
              ], setScope),
              scope === 'workspace'
                ? selectField('工作区', effectiveWorkspace, workspaces.map((workspace) => ({
                    value: workspace.id,
                    label: (workspace.title ?? workspace.path ?? workspace.id) + (typeof workspace.lastActiveAt === 'number' ? ' · 最近活跃 ' + ageText(workspace.lastActiveAt) : ''),
                  })), setWorkspaceId)
                : null,
              scope === 'workspace'
                ? h('span', { className: 'ptMeta' }, `该工作区 ${boundCount} 个会话绑定了提示词模板`)
                : null,
              h(
                'div',
                { className: 'ptCardActions' },
                pending
                  ? h(
                      React.Fragment,
                      null,
                      h('button', {
                        type: 'button',
                        className: 'ptBtn',
                        'data-tone': 'danger',
                        disabled,
                        onClick: () => { void runCleanup(target) },
                      }, '确认' + label),
                      h('button', {
                        type: 'button',
                        className: 'ptBtn',
                        disabled,
                        onClick: cancelCleanup,
                      }, '取消'),
                    )
                  : h('button', {
                      type: 'button',
                      className: 'ptBtn',
                      'data-tone': 'danger',
                      disabled,
                      onClick: () => { requestCleanup(target) },
                    }, label),
              ),
            ),
            cleanupNotice !== null && cleanupNotice !== undefined
              ? h('p', { className: 'ptSub', style: { margin: 0 } }, cleanupNotice)
              : null,
          ),
        )
      }

      /** 工作区里绑了提示词模板的会话数（沿 parentSession 把派生会话也算进来）。 */
      function countWorkspaceBindings(snapshot, workspaceId, allSessions) {
        const workspace = (snapshot?.workspaces ?? []).find((candidate) => candidate.id === workspaceId)
        if (workspace === undefined) return 0
        const owned = new Set((workspace.sessions ?? []).map((session) => session.id))
        return Object.keys(snapshot?.bindings ?? {}).filter((sessionId) => {
          let cursor = allSessions?.get?.(sessionId)
          const seen = new Set()
          while (cursor !== undefined && !seen.has(cursor.id)) {
            if (owned.has(cursor.id)) return true
            seen.add(cursor.id)
            cursor = typeof cursor.parentSession === 'string' ? allSessions.get(cursor.parentSession) : undefined
          }
          return false
        }).length
      }

      /** 只用于卡片里的相对时间，避免再引一份格式化工具。 */
      function ageText(timestamp) {
        const delta = Date.now() - timestamp
        if (!Number.isFinite(delta) || delta < 0) return '—'
        const minutes = Math.floor(delta / 60000)
        if (minutes < 1) return '刚刚'
        if (minutes < 60) return minutes + ' 分钟前'
        const hours = Math.floor(minutes / 60)
        if (hours < 24) return hours + ' 小时前'
        return Math.floor(hours / 24) + ' 天前'
      }

      // 这个 chunk 的主出口仍是 store 工厂（`cleanup(...)`）；清理卡片作为
      // 它的属性导出，避免 store 与编辑器各拿一份不同的实例。
      useCleanupStore.renderCleanupCard = renderCleanupCard
      return useCleanupStore
    }
  },
})
