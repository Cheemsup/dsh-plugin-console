/**
 * 插件页的筛选条：类别 / 来源 / 状态三个下拉 + 结果数 + 折叠动作。
 *
 * 从 `client.page.js` 拆出来有两个理由：页面壳已经贴着 520 行上限；筛选条只服务
 * 插件页，本来就不属于「组装页面」的职责。视图仍是纯函数，只读 `vc`。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.plugin-filters.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.plugin-filters.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { selectField, textButton, resultText, setAll } = deps

      /**
       * 插件页筛选：三个下拉 + 结果数 + 折叠动作。
       * @param {object} vc - 视图上下文。
       * @returns {object} 筛选条节点。
       */
      function renderPluginFilters(vc) {
        const {
          category, setCategory, layer, setLayer, only, setOnly,
          categories, layers, filtered, entries, statusCounts, setCollapsedCategories,
        } = vc
        const onlyOptions = [
          { value: '', label: '全部状态' },
          { value: 'disabled', label: `全局层面禁用（${statusCounts.disabled}）` },
          { value: 'failed', label: `失败（${statusCounts.failed}）` },
          { value: 'missing', label: `缺服务（${statusCounts.missing ?? 0}）` },
          { value: 'unregistered', label: `无注册（${statusCounts.unregistered}）` },
        ]
        return h(
          React.Fragment,
          null,
          selectField('类别', category, [
            { value: '', label: `全部类别（${entries.length}）` },
            ...categories.map((item) => ({ value: item.id, label: `${item.label}（${item.count}）` })),
          ], (value) => setCategory(value === '' ? null : value)),
          selectField('来源', layer, [
            { value: '', label: '全部来源' },
            ...layers.map((item) => ({ value: item.id, label: `${item.label}（${item.count}）` })),
          ], (value) => setLayer(value === '' ? null : value)),
          selectField('状态', only, onlyOptions, (value) => setOnly(value === '' ? null : value)),
          resultText(filtered.length, entries.length, ' 个插件'),
          h(
            'div',
            { className: 'ptActions' },
            textButton('折叠全部', () => setAll(setCollapsedCategories, filtered.map((entry) => entry.category), true), { title: '折叠当前筛选结果里的全部分组' }),
            textButton('展开全部', () => setAll(setCollapsedCategories, [], false)),
          ),
        )
      }

      return { renderPluginFilters }
    }
  },
})
