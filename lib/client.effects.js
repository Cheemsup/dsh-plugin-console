/**
 * 插件「行为」段的渲染：把 Cordis 的 effect 标签归并成可读的类别。
 *
 * 这是框架给的元数据（`fiber.getEffects()`），不是实际调用记录。原始标签
 * 不单独展示：它们多是 `ctx.plugin()` / `tools.register()` 这类样板，具体
 * 注册项已经在「依赖与提供」「注册的工具与提示词」里列过。活动数字在
 * 「活动」段。单独成一个 chunk，是为了让插件详情只负责组织事实。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.effects.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.effects.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create() {
      /** 类别说明：悬停在计数标签上时回答「这类行为意味着什么」。 */
      const KIND_NOTES = {
        注册工具: '向工具表注册的条目数，具体名单见「注册的工具与提示词」',
        限制工具: '对当前 scope 提交的 restrict 过滤数',
        提供服务: '向 Cordis 注册的服务数，消费关系见「依赖与提供」',
        派生访问器: 'ctx.accessor / ctx.mixin 派生的访问器数',
        监听事件: '订阅的事件数',
        注册界面槽位: '注册的界面槽位或面板数',
        挂载子插件: '运行时挂载的子 fiber 数',
        注入提示词: '注入的提示词段、上下文或变量数',
        '注册 Remote 方法': 'typert 注册的 Remote 方法数',
        注册会话投影: '注册的会话投影数',
        '注册 Web 能力': '注册的 Web provider 数',
        注册命令: '注册的命令数',
        监听配置热更新: '监听的配置热更新路径数',
        注册模型适配: '注册的模型适配数',
        写入状态: '写入状态的次数',
      }

      /**
       * 插件注册的副作用摘要。
       * @param {Array<{label: string}>} effects - 副作用元数据。
       * @returns {object} React 节点。
       */
      function effectsList(effects) {
        if (!effects.length) {
          return h('p', { className: 'ptSub', style: { margin: 0 } }, '没有登记带标签的副作用（或 fiber 未激活）。')
        }
        return h(
          'div',
          { className: 'ptChipGroup' },
          summarizeEffects(effects).map((row) =>
            h('span', {
              key: row.kind,
              className: 'ptTag',
              title: KIND_NOTES[row.kind] === undefined
                ? `${row.kind}：${row.count} 处`
                : `${row.kind}：${KIND_NOTES[row.kind]}（${row.count} 处）`,
            }, `${row.kind} ${row.count}`),
          ),
        )
      }

      /**
       * 把副作用按「做了什么」归类。
       *
       * 只统计顶层 effect：`getEffects()` 的 children 是嵌套 effect，已经被父条目
       * 代表；再计一次会让分类计数之和与标题里的「行为（N）」对不上。
       * @param {Array<{label: string}>} effects - 副作用元数据。
       * @returns {Array<{kind: string, count: number}>} 按次数降序的类别计数。
       */
      function summarizeEffects(effects) {
        const counts = new Map()
        for (const effect of effects) {
          const kind = effectKind(effect.label)
          counts.set(kind, (counts.get(kind) ?? 0) + 1)
        }
        return [...counts.entries()]
          .map(([kind, count]) => ({ kind, count }))
          .sort((left, right) => right.count - left.count)
      }

      /**
       * 从一个 Cordis effect label 提取行为类别。
       *
       * 归一表覆盖本机实测出现过的全部前缀；归一表之外的原样保留前缀，不猜。
       * @param {string} label - 形如 `ctx.on("x")`、`tools.register()` 的标签。
       * @returns {string} 类别名。
       */
      function effectKind(label) {
        const text = String(label)
        const rules = [
          [/^tools\.register/, '注册工具'],
          [/^tools\.restrict/, '限制工具'],
          [/^ctx\.provide|^.*\.provide\(/, '提供服务'],
          [/^ctx\.accessor|^ctx\.mixin/, '派生访问器'],
          [/^ctx\.on\(|^ctx\.once\(|^ctx\.bail\(|^ctx\.waterfall\(/, '监听事件'],
          [/^ctx\.slots|slots\.register/, '注册界面槽位'],
          [/^ctx\.plugin/, '挂载子插件'],
          [/^systemPrompt\.(section|context|variable|tools)/, '注入提示词'],
          [/^typert\.register/, '注册 Remote 方法'],
          [/^sessionProjections\.register/, '注册会话投影'],
          [/^web\.registerProvider/, '注册 Web 能力'],
          [/^commands\.register|^command\b/, '注册命令'],
          [/^hmr\.watch/, '监听配置热更新'],
          [/^llm\.register/, '注册模型适配'],
          [/^session\.append|^ctx\.set/, '写入状态'],
        ]
        for (const [pattern, kind] of rules) if (pattern.test(text)) return kind
        return text.replace(/\(.*$/, '') || '其他'
      }

      return { effectsList, summarizeEffects, effectKind }
    }
  },
})
