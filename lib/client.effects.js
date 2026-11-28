/**
 * 插件「运行时登记」段的渲染：把 Cordis 的 effect 标签归并成可读的类别。
 *
 * 这是框架给的元数据（`fiber.getEffects()`），不是实际调用记录，也不等于源码扫描：
 * 事件监听、界面槽位、Remote 方法等只在这里出现；注册工具 / 注入提示词 / 注册命令 /
 * 提供服务 / Web / 模型适配的名单已经在上面的「能力贡献」与「依赖与提供」里列过，
 * 这里只保留运行时计数，避免同一份内容出现两次。活动数字在「活动」段。
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
      /**
       * 已经在其它区块列出名单的类别。
       *
       * 只藏名单、不藏事实：运行时登记的数量仍以一行「已在上面列出」保留，
       * 用户仍能看出运行时注册量与源码扫描量是否一致。
       */
      const COVERED_KINDS = new Set([
        '注册工具',
        '注入提示词',
        '注册命令',
        '提供服务',
        '注册 Web 能力',
        '注册模型适配',
      ])

      /** 类别说明：悬停在计数标签上时回答「这类行为意味着什么」。 */
      const KIND_NOTES = {
        注册工具: '向工具表注册的条目数，具体名单见「能力贡献 · 工具」',
        限制工具: '对当前 scope 提交的 restrict 过滤数',
        提供服务: '向 Cordis 注册的服务数，消费关系见「依赖与提供」',
        派生访问器: 'ctx.accessor / ctx.mixin 派生的访问器数',
        监听事件: '订阅的事件数',
        注册界面槽位: '注册的界面槽位或面板数',
        挂载子插件: '运行时挂载的子 fiber 数',
        注入提示词: '注入的提示词段、上下文或变量数，名单见「能力贡献 · 上下文注入」',
        '注册 Remote 方法': 'typert 注册的 Remote 方法数',
        注册会话投影: '注册的会话投影数',
        '注册 Web 能力': '注册的 Web provider 数，名单见「能力贡献 · 网络」',
        注册命令: '注册的命令数，名单见「能力贡献 · 技能与命令」',
        监听配置热更新: '监听的配置热更新路径数',
        注册模型适配: '注册的模型适配数，名单见「能力贡献 · 网络」',
        写入状态: '写入状态的次数',
      }

      /** 一组类别标签。 */
      function chipsOf(rows) {
        return h(
          'div',
          { className: 'ptChipGroup' },
          rows.map((row) => h('span', {
            key: row.kind,
            className: 'ptTag',
            title: KIND_NOTES[row.kind] === undefined
              ? `${row.kind}：${row.count} 处`
              : `${row.kind}：${KIND_NOTES[row.kind]}（${row.count} 处）`,
          }, `${row.kind} ${row.count}`)),
        )
      }

      /**
       * 插件运行时登记摘要。
       *
       * 与「能力贡献」重叠的类别只留计数；独有类别才作为标签。没有任何 effect
       * 时明确写「未激活 / 无标签」，不把空当成「没有行为」。
       * @param {Array<{label: string}>} effects - 副作用元数据。
       * @returns {object} React 节点。
       */
      function runtimeList(effects) {
        if (!effects.length) {
          return h('p', { className: 'ptSub', style: { margin: 0 } }, '没有登记带标签的副作用（或 fiber 未激活）。')
        }
        const rows = summarizeEffects(effects)
        const unique = rows.filter((row) => !COVERED_KINDS.has(row.kind))
        const covered = rows.filter((row) => COVERED_KINDS.has(row.kind))
        return h(
          React.Fragment,
          null,
          unique.length > 0 ? chipsOf(unique) : null,
          covered.length > 0
            ? h(
                'p',
                {
                  className: 'ptHint',
                  style: unique.length > 0 ? { margin: '6px 0 0' } : { margin: 0 },
                  title: '这些类别的名单来自源码扫描，已在上面的「能力贡献」或「依赖与提供」里列出；这里保留运行时计数，两者不一致时说明有扫描盲区',
                },
                '已在上面列出（源码扫描）：',
                covered.map((row) => `${row.kind} ${row.count}`).join(' · '),
              )
            : null,
        )
      }

      /**
       * 把副作用按「做了什么」归类。
       *
       * 只统计顶层 effect：`getEffects()` 的 children 是嵌套 effect，已经被父条目
       * 代表；再计一次会让分类计数之和与标题里的「运行时登记（N）」对不上。
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

      return { runtimeList, summarizeEffects, effectKind }
    }
  },
})
