/**
 * 插件活动：按需读取最近几天的工具调用，并把工具级数字接到插件/工具视图。
 *
 * 活动不是快照的一部分：读 session log 的成本随会话长度增长，所以只在插件
 * 或工具视图可见时懒加载。读取失败只影响活动栏，不影响整页快照。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.activity.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.activity.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useState } = React

    return function create(deps) {
      const { fetchJson, ACTIVITY_ROUTE, formatAge } = deps

      /** 活动状态：一次读取最近 7 天、最多 20 个会话。 */
      function useActivityStore() {
        const [status, setStatus] = useState('idle')
        const [data, setData] = useState(null)
        const [error, setError] = useState(null)

        const load = useCallback(async (options = {}) => {
          setStatus('loading')
          setError(null)
          const days = Number.isFinite(options.days) ? options.days : 7
          const limit = Number.isFinite(options.limit) ? options.limit : 20
          try {
            const next = await fetchJson(`${ACTIVITY_ROUTE}?days=${days}&limit=${limit}`)
            setData(next)
            setStatus('ready')
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
            setStatus('error')
          }
        }, [fetchJson])

        return { status, data, error, load }
      }

      /** 错误率：样本为 0 时不显示百分比。 */
      function formatRate(rate) {
        return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 100) + '%' : '0%'
      }

      /** 耗时：毫秒级显示 ms，超过一秒显示 s。 */
      function formatDuration(ms) {
        if (!Number.isFinite(ms)) return '—'
        return ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's'
      }

      /** 最后使用时间；没有调用时返回 —。 */
      function formatLastUsed(timestamp) {
        return typeof timestamp === 'number' && timestamp > 0 ? formatAge(timestamp) : '—'
      }

      /** 把 host 的一行工具活动归一成视图好用的形状。 */
      function normalizeTool(name, row) {
        return {
          name,
          calls: row?.calls ?? 0,
          results: row?.results ?? 0,
          errors: row?.errors ?? 0,
          errorRate: row?.errorRate ?? 0,
          p50Ms: row?.p50Ms ?? null,
          p95Ms: row?.p95Ms ?? null,
          lastUsed: row?.lastUsed,
          sessions: Array.isArray(row?.sessions) ? row.sessions : [],
        }
      }

      /** 单个工具的活动；数据未加载时 undefined，加载了但没有调用时返回 0 值。 */
      function toolUsage(activity, name) {
        if (activity === null || activity === undefined || activity.tools === undefined) return undefined
        return normalizeTool(name, activity.tools[name])
      }

      /**
       * 一个插件的活动：把它的工具行汇总。
       *
       * p95 不能跨工具相加，这里取「最慢工具 p95」并在标签上写明。
       * @param {object} entry - 插件条目。
       * @param {object} activity - 活动响应。
       * @returns {object | undefined} 汇总；活动未加载时 undefined。
       */
      function pluginUsage(entry, activity) {
        if (activity === null || activity === undefined || activity.tools === undefined) return undefined
        const tools = (entry?.registrations?.tools ?? [])
          .map((name) => toolUsage(activity, name))
          .filter((row) => row !== undefined)
        const sessions = new Set()
        let calls = 0
        let results = 0
        let errors = 0
        let lastUsed
        let maxP95Ms = null
        for (const row of tools) {
          calls += row.calls
          results += row.results
          errors += row.errors
          for (const id of row.sessions) sessions.add(id)
          if (row.lastUsed !== undefined && (lastUsed === undefined || row.lastUsed > lastUsed)) lastUsed = row.lastUsed
          if (Number.isFinite(row.p95Ms) && (maxP95Ms === null || row.p95Ms > maxP95Ms)) maxP95Ms = row.p95Ms
        }
        tools.sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name))
        return {
          tools,
          calls,
          results,
          errors,
          errorRate: results > 0 ? errors / results : 0,
          p95Ms: maxP95Ms,
          lastUsed,
          sessions: sessions.size,
        }
      }

      /**
       * 行内的用量读数：只在真有调用/错误时出现，避免 209 行都挂一个 0。
       *
       * 次数是读数而不是状态，所以不给胶囊；错误用正文色标出，位置仍由调用方
       * 统一放进右簇（`.ptEnd`）。`note` 是活动来源的一句补充（例如模式挂载）。
       */
      function renderUsageTags(usage, note) {
        if (usage === undefined || usage === null) return null
        const tags = []
        if (usage.calls > 0) {
          tags.push(h('span', {
            key: 'calls',
            className: 'ptCount',
            title: `最近 7 天 ${usage.calls} 次调用，最后 ${formatLastUsed(usage.lastUsed)}${note ? `；${note}` : ''}`,
          }, '调用 ' + usage.calls))
        }
        if (usage.errors > 0) {
          tags.push(h('span', {
            key: 'errors',
            className: 'ptCount ptError',
            title: `${usage.errors} 次调用错误（包含参数错误）`,
          }, '错误 ' + usage.errors))
        }
        return tags.length ? h(React.Fragment, null, ...tags) : null
      }

      /** 详情里的一行事实；`ptFacts` 是 dt/dd 网格，所以一行必须成对。 */
      function factRow(label, value) {
        return h(React.Fragment, { key: label }, h('dt', null, label), h('dd', null, value))
      }

      /** 插件详情里的活动段；`note` 解释调用为什么不能直接归到这一行。 */
      function renderPluginActivity(entry, usage, status, error, note) {
        const title = h('p', { className: 'ptSectionTitle' }, '活动（最近 7 天）')
        if (status === 'loading') {
          return h('div', { className: 'ptSection' }, title, h('p', { className: 'ptSub', style: { margin: 0 } }, '正在读取会话活动…'))
        }
        if (status === 'error') {
          return h('div', { className: 'ptSection' }, title, h('p', { className: 'ptError', style: { margin: 0 } }, '活动读取失败：' + (error ?? '未知错误')))
        }
        if (status === 'idle') {
          return h('div', { className: 'ptSection' }, title, h('p', { className: 'ptSub', style: { margin: 0 } }, '打开插件页或插件能力面的工具段时读取活动'))
        }
        if (usage === undefined) {
          return h('div', { className: 'ptSection' }, title, h('p', { className: 'ptSub', style: { margin: 0 } }, '这个部署没有可读的会话活动'))
        }
        if ((entry?.registrations?.tools ?? []).length === 0) {
          return h('div', { className: 'ptSection' }, title, h('p', { className: 'ptSub', style: { margin: 0 } }, '这个插件没有工具型贡献，活动不可观测（但这不代表它没有运行）'))
        }
        if (usage.calls === 0) {
          return h('div', { className: 'ptSection' }, title, h('p', { className: 'ptSub', style: { margin: 0 } }, '最近 7 天没有观测到它的工具被调用'))
        }

        const activeTools = usage.tools.filter((row) => row.calls > 0).slice(0, 12)
        return h(
          'div',
          { className: 'ptSection' },
          title,
          h(
            'dl',
            { className: 'ptFacts' },
            factRow('调用', String(usage.calls)),
            factRow('结果', String(usage.results)),
            factRow('错误', `${usage.errors}（${formatRate(usage.errorRate)}）`),
            factRow('最慢 p95', formatDuration(usage.p95Ms)),
            factRow('最后使用', formatLastUsed(usage.lastUsed)),
            factRow('会话', String(usage.sessions)),
          ),
          activeTools.length
            ? h(
                'details',
                { className: 'ptFold ptFoldable', style: { marginTop: '4px' } },
                h('summary', null, h('span', null, '逐工具'), h('span', { className: 'ptFoldMeta' }, activeTools.length + ' 个有调用')),
                h(
                  'ul',
                  { className: 'ptDepList', style: { padding: '8px 12px' } },
                  activeTools.map((row) => h(
                    'li',
                    { key: row.name },
                    h('span', { className: 'ptDepKey' }, row.name),
                    h('span', { className: 'ptDepValue' }, `${row.calls} 次 · 错 ${row.errors} · p95 ${formatDuration(row.p95Ms)} · ${formatLastUsed(row.lastUsed)}`),
                  )),
                ),
              )
            : null,
          note ? h('p', { className: 'ptSub', style: { margin: 0 } }, note) : null,
          h('p', { className: 'ptSub', style: { margin: 0 } }, '调用与错误来自 session log 的 tool/call / tool/result，未观测到活动不代表插件没有运行'),
        )
      }

      return {
        useActivityStore,
        toolUsage,
        pluginUsage,
        formatRate,
        formatDuration,
        formatLastUsed,
        renderUsageTags,
        renderPluginActivity,
      }
    }
  },
})
