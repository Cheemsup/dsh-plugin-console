/**
 * 快照差分：回答「自上次刷新以来，插件树变了什么」。
 *
 * 只比较用户能感知的字段：版本、启用、fiber 阶段、来源层、覆盖、工具/提示词段、
 * 服务供需、配置字段、禁用表达式，以及工具集合的增删。会话与工作区不在这里比较，
 * 它们的变化频率高，且不属于「插件树变更」。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.changes.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.changes.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { textButton } = deps

      /** 数组字段排序后再比，避免源码扫描/注册顺序造成的假变化。 */
      function sorted(values) {
        return Array.isArray(values) ? [...values].sort() : []
      }

      /** 配置摘要：现在比较生效值，旧快照只有字段名时退回名字列表。 */
      function configOf(entry) {
        const rows = Array.isArray(entry?.configEntries) ? entry.configEntries : []
        return rows.length ? rows.map((row) => [row.key, row.value]) : sorted(entry?.configKeys)
      }

      /** 一个条目的可比较摘要。 */
      function digest(entry) {
        return JSON.stringify({
          version: entry?.version ?? null,
          enabled: entry?.enabled === true,
          phase: entry?.phase ?? null,
          layer: entry?.layer ?? null,
          overriddenBy: sorted(entry?.overriddenBy),
          disabledExpr: entry?.disabledExpr ?? null,
          tools: sorted(entry?.registrations?.tools),
          sections: sorted(entry?.registrations?.sections),
          contexts: sorted(entry?.registrations?.contexts),
          requires: sorted(entry?.requires),
          provides: sorted(entry?.provides),
          config: configOf(entry),
        })
      }

      /** 一个条目具体哪些字段变了。 */
      function changedFields(before, after) {
        const fields = []
        const compare = (label, left, right) => {
          if (JSON.stringify(left) !== JSON.stringify(right)) fields.push(label)
        }
        compare('版本', before?.version ?? null, after?.version ?? null)
        compare('启用', before?.enabled === true, after?.enabled === true)
        compare('阶段', before?.phase ?? null, after?.phase ?? null)
        compare('来源层', before?.layer ?? null, after?.layer ?? null)
        compare('覆盖', sorted(before?.overriddenBy), sorted(after?.overriddenBy))
        compare('工具', sorted(before?.registrations?.tools), sorted(after?.registrations?.tools))
        compare(
          '提示词段',
          [...sorted(before?.registrations?.sections), ...sorted(before?.registrations?.contexts)],
          [...sorted(after?.registrations?.sections), ...sorted(after?.registrations?.contexts)],
        )
        compare('服务需求', sorted(before?.requires), sorted(after?.requires))
        compare('服务提供', sorted(before?.provides), sorted(after?.provides))
        compare('配置字段', configOf(before), configOf(after))
        compare('禁用表达式', before?.disabledExpr ?? null, after?.disabledExpr ?? null)
        return fields
      }

      /** 条目的展示名：组合行 id，同一个包挂载成多行时才分得清。 */
      function labelOf(entry) {
        return entry?.rowId || entry?.entryId || entry?.title || entry?.packageName || entry?.moduleName || '未知插件'
      }

      /**
       * 比较两份快照。
       * @param {object | null} previous - 上一次成功的快照。
       * @param {object | null} next - 当前快照。
       * @returns {object | null} 差集；缺少任一侧时 null。
       */
      function diffSnapshots(previous, next) {
        if (previous === null || previous === undefined || next === null || next === undefined) return null
        const beforeEntries = Array.isArray(previous.entries) ? previous.entries : []
        const afterEntries = Array.isArray(next.entries) ? next.entries : []
        const beforeById = new Map(beforeEntries.map((entry) => [entry.entryId, entry]))
        const afterById = new Map(afterEntries.map((entry) => [entry.entryId, entry]))

        const added = afterEntries.filter((entry) => !beforeById.has(entry.entryId))
        const removed = beforeEntries.filter((entry) => !afterById.has(entry.entryId))
        const changed = []
        for (const entry of afterEntries) {
          const before = beforeById.get(entry.entryId)
          if (before === undefined) continue
          if (digest(before) === digest(entry)) continue
          changed.push({ entry, fields: changedFields(before, entry) })
        }

        const beforeTools = new Set((previous.tools?.attributed ?? []).map((tool) => tool.name))
        const afterTools = new Set((next.tools?.attributed ?? []).map((tool) => tool.name))
        const toolsAdded = [...afterTools].filter((name) => !beforeTools.has(name))
        const toolsRemoved = [...beforeTools].filter((name) => !afterTools.has(name))

        const items = [
          ...added.map((entry) => ({
            kind: 'added',
            title: '新增 ' + labelOf(entry),
            detail: entry.moduleName,
            entryId: entry.entryId,
            rowId: entry.rowId,
          })),
          ...removed.map((entry) => ({
            kind: 'removed',
            title: '移除 ' + labelOf(entry),
            detail: entry.moduleName,
            entryId: entry.entryId,
          })),
          ...changed.map(({ entry, fields }) => ({
            kind: 'changed',
            title: '变化 ' + labelOf(entry),
            detail: fields.length > 0 ? fields.join('、') : '注册内容变化',
            entryId: entry.entryId,
            rowId: entry.rowId,
          })),
          ...toolsAdded.map((name) => ({ kind: 'tool-added', title: '新增工具 ' + name, toolName: name })),
          ...toolsRemoved.map((name) => ({ kind: 'tool-removed', title: '移除工具 ' + name, toolName: name })),
        ]

        return {
          from: previous.generatedAt,
          to: next.generatedAt,
          added,
          removed,
          changed,
          toolsAdded,
          toolsRemoved,
          total: items.length,
          items: items.slice(0, 40),
        }
      }

      /** 变更项的展示类型。 */
      const KIND_LABEL = {
        added: '新增',
        removed: '移除',
        changed: '变化',
        'tool-added': '工具+',
        'tool-removed': '工具-',
      }

      /**
       * 插件页顶部的变更条；没有变化时不占位置。
       * @param {object} vc - 视图上下文。
       * @returns {object | null} React 节点。
       */
      function renderChanges(vc) {
        const { changes, gotoPlugin, gotoTool } = vc
        if (changes === null || changes === undefined || changes.total === 0) return null
        return h(
          'details',
          { className: 'ptAttention ptChanges' },
          h(
            'summary',
            null,
            h('span', null, '自上次刷新'),
            h('span', { className: 'ptCount' }, `+${changes.added.length} / -${changes.removed.length} / 改 ${changes.changed.length}`),
            changes.toolsAdded.length + changes.toolsRemoved.length > 0
              ? h('span', { className: 'ptFoldMeta' }, `工具 +${changes.toolsAdded.length} / -${changes.toolsRemoved.length}`)
              : h('span', { className: 'ptFoldMeta' }, '点开看明细'),
          ),
          h(
            'ul',
            { className: 'ptAttentionList' },
            changes.items.map((item) => {
              const action = item.rowId !== undefined
                ? textButton('查看', () => gotoPlugin(item.rowId), { title: '在插件页展开这一条' })
                : item.toolName !== undefined
                  ? textButton('查看工具', () => gotoTool(item.toolName), { title: '在工具页查看这个工具' })
                  : null
              return h(
                'li',
                { key: item.kind + ':' + (item.entryId ?? item.toolName ?? item.title), className: 'ptAttentionRow', 'data-severity': 'info' },
                h('span', { className: 'ptSeverity', 'data-severity': 'info' }, KIND_LABEL[item.kind] ?? '变化'),
                h(
                  'span',
                  { className: 'ptAttentionText' },
                  h('span', { className: 'ptAttentionTitle' }, item.title),
                  item.detail ? h('span', { className: 'ptAttentionDetail' }, item.detail) : null,
                ),
                action,
              )
            }),
            changes.total > changes.items.length
              ? h('li', { className: 'ptAttentionRow', 'data-severity': 'info' }, h('span', { className: 'ptAttentionDetail' }, `还有 ${changes.total - changes.items.length} 项未列出`))
              : null,
          ),
        )
      }

      return { diffSnapshots, renderChanges }
    }
  },
})
