window.__ModuleLoader__.load({
  id: 'dsh-plugin-console',
  chunk: 'client.control.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    return function create(deps) {
      const { fetchJson, formatSessionId, textButton, IMPACT_ROUTE, CONTROL_ROUTE, OPERATIONS_ROUTE } = deps

      /** 控制接口：影响预览、执行、审计。 */
      function useControlStore() {
        const [operations, setOperations] = useState([])
        const [operationsError, setOperationsError] = useState(null)

        const loadOperations = useCallback(async () => {
          try {
            const data = await fetchJson(OPERATIONS_ROUTE)
            setOperations(Array.isArray(data.operations) ? data.operations : [])
            setOperationsError(null)
          } catch (cause) {
            setOperationsError(cause instanceof Error ? cause.message : String(cause))
          }
        }, [fetchJson])

        const preview = useCallback(async (rowId) => {
          const encoded = typeof encodeURIComponent === 'function' ? encodeURIComponent(rowId) : rowId
          return fetchJson(IMPACT_ROUTE + '?id=' + encoded)
        }, [fetchJson])

        const execute = useCallback(async (payload) => fetchJson(CONTROL_ROUTE, {
          method: 'POST',
          body: JSON.stringify(payload),
        }), [fetchJson])

        return { operations, operationsError, loadOperations, preview, execute }
      }

      /** 影响预览里的一行。 */
      function line(label, value) {
        return h(React.Fragment, { key: label }, h('dt', null, label), h('dd', null, value))
      }

      /**
       * 插件详情里的控制段。
       * @param {object} entry - 目标插件。
       * @param {object} options - `{ control, sessions, reload }`。
       * @returns {object} React 节点。
       */
      function renderControlSection(entry, options) {
        return h(ControlPanel, { entry, ...options })
      }

      function ControlPanel({ entry, control, sessions, reload }) {
        const sessionList = Array.isArray(sessions) ? sessions : []
        const [sessionId, setSessionId] = useState(sessionList[0]?.id ?? '')
        const [pending, setPending] = useState(null)
        const [busy, setBusy] = useState(false)
        const [notice, setNotice] = useState(null)

        useEffect(() => { void control.loadOperations() }, [control.loadOperations])

        const start = async (action) => {
          setBusy(true)
          setNotice(null)
          try {
            const impact = await control.preview(entry.rowId)
            if (impact.found !== true) {
              setNotice({ tone: 'error', text: impact.reason ?? '影响预览不可用' })
              return
            }
            setPending({ action, impact })
          } catch (cause) {
            setNotice({ tone: 'error', text: '影响预览失败：' + (cause instanceof Error ? cause.message : String(cause)) })
          } finally {
            setBusy(false)
          }
        }

        const confirm = async () => {
          if (pending === null) return
          setBusy(true)
          try {
            const result = await control.execute({
              action: pending.action,
              rowId: entry.rowId,
              ...(pending.action === 'mask' || pending.action === 'unmask' ? { sessionId } : {}),
              confirmed: true,
            })
            if (result.ok === true) {
              setNotice({
                tone: 'ok',
                text: result.restartRequired === true
                  ? '已写入 profile；当前没有可用的 HMR，重启后生效。'
                  : result.result?.live === false
                    ? '已记录；会话未激活，resume 时生效。'
                    : '已执行；快照与活动会重新读取。',
              })
              setPending(null)
              if (typeof reload === 'function') void reload()
              void control.loadOperations()
            } else {
              setNotice({ tone: 'error', text: result.reason ?? '控制失败' })
            }
          } catch (cause) {
            setNotice({ tone: 'error', text: '控制失败：' + (cause instanceof Error ? cause.message : String(cause)) })
          } finally {
            setBusy(false)
          }
        }

        const impact = pending?.impact
        const blocked = pending?.action === 'mask' && (impact?.tools?.shared?.length ?? 0) > 0
        const isSelf = entry.rowId === 'plugin-console' || entry.moduleName === 'dsh-plugin-console'
        const canGlobal = !isSelf && entry.modeOnly !== true
        const hasTools = (entry.registrations?.tools ?? []).length > 0

        return h(
          'div',
          { className: 'ptSection' },
          h('p', { className: 'ptSectionTitle' }, '控制'),
          h(
            'div',
            { className: 'ptCardRow' },
            h(
              'button',
              {
                type: 'button',
                className: 'ptBtn',
                'data-tone': entry.enabled ? 'danger' : 'primary',
                disabled: busy || !canGlobal,
                title: isSelf
                  ? '不能在这里关闭插件控制台自身'
                  : entry.modeOnly === true
                    ? '只由模式挂载，不能通过 profile 启停'
                    : '影响所有会话；执行前会显示影响预览',
                onClick: () => void start(entry.enabled ? 'disable' : 'enable'),
              },
              entry.enabled ? '禁用（全局）' : '启用（全局）',
            ),
            h(
              'label',
              { className: 'ptField' },
              h('span', { className: 'ptFieldLabel' }, '会话'),
              h(
                'select',
                {
                  className: 'ptSelect',
                  value: sessionId,
                  disabled: busy || sessionList.length === 0,
                  onChange: (event) => setSessionId(event.target.value),
                },
                sessionList.length === 0
                  ? h('option', { value: '' }, '没有可读会话')
                  : sessionList.map((session) => h(
                      'option',
                      { key: session.id, value: session.id },
                      formatSessionId(session.id) + (session.live ? ' · 运行中' : ' · 冷会话'),
                    )),
              ),
            ),
            textButton('屏蔽到会话', () => void start('mask'), {
              disabled: busy || sessionId === '' || !hasTools,
              title: hasTools ? '只隐藏这个插件的工具贡献；不卸载插件，不影响其他会话' : '这个插件没有工具型贡献，暂不支持会话掩码',
            }),
            textButton('解除该会话屏蔽', () => void start('unmask'), {
              disabled: busy || sessionId === '',
              title: '移除这个会话上针对当前插件的掩码',
            }),
          ),
          h('p', { className: 'ptHint', style: { margin: 0 } },
            '全局启停委托 plugin-manager；会话掩码只隐藏工具贡献，不卸载插件、不停服务、不移除事件监听。当前版本掩码不处理提示词段。'),

          pending === null
            ? null
            : h(
                'div',
                { className: 'ptCard', style: { margin: '6px 0 0' } },
                h('p', { className: 'ptCardTitle' }, '影响预览'),
                h(
                  'dl',
                  { className: 'ptFacts' },
                  line('目标', entry.title || entry.packageName || entry.moduleName),
                  line('范围', pending.action === 'mask' || pending.action === 'unmask' ? '会话 ' + formatSessionId(sessionId) : '全局（所有会话）'),
                  line('失去工具', (impact.tools?.lost ?? []).join('、') || '无'),
                  line('共享工具', (impact.tools?.shared ?? []).join('、') || '无'),
                  line('失去提示词段', (impact.sections?.lost ?? []).join('、') || '无'),
                  line('唯一提供', (impact.services?.soleProviders ?? []).join('、') || '无'),
                  line('受影响消费者', (impact.services?.affectedConsumers ?? []).join('、') || '无'),
                  line('模式', (impact.modes ?? []).map((mode) => mode.name).join('、') || '无'),
                  line('活会话 / 冷会话', `${(impact.liveSessions ?? []).length} / ${impact.coldSessionCount ?? 0}`),
                  line('生效', impact.hmr === true ? 'HMR 可用，可能立即生效' : '未检测到 HMR；可能需要重启'),
                ),
                blocked
                  ? h('p', { className: 'ptError', style: { margin: 0 } }, '这些工具与其他插件重名，按名字 deny 会连带隐藏对方的同名工具；请先改用按工具名选择，或不要做会话掩码。')
                  : null,
                h(
                  'div',
                  { className: 'ptCardActions' },
                  textButton('取消', () => setPending(null), { disabled: busy }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ptBtn',
                      'data-tone': 'danger',
                      disabled: busy || blocked,
                      onClick: () => void confirm(),
                    },
                    busy ? '执行中…' : '确认执行',
                  ),
                ),
              ),

          notice === null
            ? null
            : h('p', { className: notice.tone === 'error' ? 'ptError' : 'ptSub', style: { margin: 0 } }, notice.text),

          control.operations.length > 0
            ? h(
                'details',
                { className: 'ptFold ptFoldable', style: { marginTop: '4px' } },
                h('summary', null, h('span', null, '最近控制'), h('span', { className: 'ptFoldMeta' }, control.operations.length + ' 条')),
                h(
                  'ul',
                  { className: 'ptDepList', style: { padding: '8px 12px' } },
                  control.operations.slice(0, 8).map((operation) => h(
                    'li',
                    { key: operation.id },
                    h('span', { className: 'ptDepKey' }, operation.action),
                    h('span', { className: 'ptDepValue' }, `${operation.target} · ${operation.result} · ${new Date(operation.time).toLocaleString()}`),
                  )),
                ),
              )
            : null,
        )
      }

      return { useControlStore, renderControlSection }
    }
  },
})
