/**
 * 工具参数 schema 的阅读视图。
 *
 * 模型收到的 `parameters` 是 JSON Schema。照原文读，决定「怎么调用」的只有
 * properties / required / description 三项，其余大多是 `type: object` 这类骨架；
 * 所以默认视图只留这三项，把默认值、枚举、范围收进一张「标签 + 值」的小表，
 * 原文按工具单独切回。三处调用方（工具页、预演工具、会话首次请求）共用这一份。
 *
 * 版式约束：名字、类型、必填标记在头行，说明必须另起一行。早先把说明放在同一
 * 个 grid 行里，长名字会被挤到每个字占一行；现在类型和标记紧跟名字，整行放不下
 * 时它们折到下一行，不会反过来压缩名字列。
 *
 * 切回原文的状态由页面持有：`vc.schemaRaw` 是 `source:name` 的集合。同一工具
 * 在不同视图里各切各的——会话日志里的 schema 是发送时的定义，可能与当前注册表
 * 不同，不能按名字共用。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.schema.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-console',
  chunk: 'client.schema.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { textButton, toggleIn } = deps

      /** 嵌套最多展开三层：再深就只留一句提示，避免一个参数撑满一页。 */
      const MAX_DEPTH = 3
      /** 枚举最多平铺 12 个值；再多就收进原文，避免取值表本身变成一面墙。 */
      const MAX_ENUM = 12

      /** 一个普通对象（schema 节点）；数组与 null 都不算。 */
      function isRecord(value) {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
      }

      /** 把默认值、枚举这类字面量变成一行可读文本；对象最多截 80 字。 */
      function valueText(value) {
        if (typeof value === 'string') return value
        if (value === null) return 'null'
        if (typeof value === 'number' || typeof value === 'boolean') return String(value)
        try {
          const text = JSON.stringify(value)
          if (typeof text !== 'string') return String(value)
          return text.length > 80 ? text.slice(0, 77) + '…' : text
        } catch {
          return String(value)
        }
      }

      /**
       * 类型列：优先 `type`，其次 oneOf / anyOf 的分支类型，再退回 enum / const。
       * 读不到就留空，不用「未知」占位——空列比一句废话更容易扫。
       */
      function typeLabel(schema) {
        if (!isRecord(schema)) return ''
        if (typeof schema.type === 'string') return schema.type
        if (Array.isArray(schema.type)) {
          const names = schema.type.filter((name) => typeof name === 'string')
          if (names.length > 0) return names.join(' | ')
        }
        for (const key of ['oneOf', 'anyOf']) {
          const variants = schema[key]
          if (!Array.isArray(variants)) continue
          const names = [...new Set(variants.map((variant) => typeLabel(variant)).filter(Boolean))]
          if (names.length > 0) return names.join(' | ')
        }
        if (Array.isArray(schema.enum)) return 'enum'
        if (schema.const !== undefined) {
          if (schema.const === null) return 'null'
          return typeof schema.const === 'string' ? 'string' : typeof schema.const
        }
        return ''
      }

      /** 数值范围；只认数字形态的 minimum / exclusiveMinimum。 */
      function rangeText(schema) {
        const min = typeof schema.minimum === 'number'
          ? schema.minimum
          : (typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : undefined)
        const max = typeof schema.maximum === 'number'
          ? schema.maximum
          : (typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum : undefined)
        if (min === undefined && max === undefined) return ''
        return (min === undefined ? '−∞' : String(min)) + '–' + (max === undefined ? '∞' : String(max))
      }

      /** 长度约束：字符串与数组共用一套写法。 */
      function lengthText(schema) {
        const min = typeof schema.minLength === 'number' ? schema.minLength : schema.minItems
        const max = typeof schema.maxLength === 'number' ? schema.maxLength : schema.maxItems
        if (min === undefined && max === undefined) return ''
        return (min === undefined ? '0' : String(min)) + '–' + (max === undefined ? '∞' : String(max))
      }

      /**
       * 约束项，渲染成「标签 + 值」的两列表。
       *
       * 每一项独占一行：几个约束挤在同一行时，长的枚举会把范围、格式推到看不见
       * 的地方；分行的代价只是两三个像素的行高。
       * @param {object} schema - 一个属性节点。
       * @returns {Array<object>} `{ label, text }` 或 `{ label, values, more }`。
       */
      function factsOf(schema) {
        const facts = []
        if (schema.default !== undefined) facts.push({ label: '默认', text: valueText(schema.default) })
        if (Array.isArray(schema.enum)) {
          const values = schema.enum.map((value) => valueText(value))
          facts.push({
            label: '可选值',
            values: values.slice(0, MAX_ENUM),
            more: Math.max(0, values.length - MAX_ENUM),
            total: values.length,
          })
        }
        if (typeof schema.format === 'string') facts.push({ label: '格式', text: schema.format })
        const range = rangeText(schema)
        if (range !== '') facts.push({ label: '范围', text: range })
        const length = lengthText(schema)
        if (length !== '') facts.push({ label: '长度', text: length })
        if (typeof schema.pattern === 'string') facts.push({ label: '匹配', text: schema.pattern })
        if (typeof schema.$ref === 'string') facts.push({ label: '引用', text: schema.$ref })
        return facts
      }

      /**
       * 把一层 properties 解析成参数项；对象属性与数组元素各自成一棵子树。
       *
       * 路径只用于 React key 与悬停：界面上靠缩进表达层级，不把完整路径写进
       * 头行——那会让名字列变成最长的那一项。
       * @param {object} schema - 当前层 schema。
       * @param {number} depth - 当前层级。
       * @param {string} path - 父级路径，空串表示顶层。
       * @returns {Array<object>} 参数项。
       */
      function rowsOf(schema, depth, path) {
        const properties = schema?.properties
        if (!isRecord(properties)) return []
        const required = new Set(
          Array.isArray(schema.required) ? schema.required.filter((name) => typeof name === 'string') : [],
        )
        const rows = []
        for (const [name, child] of Object.entries(properties)) {
          if (!isRecord(child)) continue
          const rowPath = path === '' ? name : path + '.' + name
          const row = {
            path: rowPath,
            name,
            type: typeLabel(child),
            required: required.has(name),
            description: typeof child.description === 'string' ? child.description.trim() : '',
            facts: factsOf(child),
            childGroups: [],
            truncated: false,
          }
          rows.push(row)
          if (depth >= MAX_DEPTH) {
            if (isRecord(child.properties) || isRecord(child.items)) row.truncated = true
            continue
          }
          const childRows = rowsOf(child, depth + 1, rowPath)
          if (childRows.length > 0) row.childGroups.push({ kind: 'object', rows: childRows })
          if (isRecord(child.items)) {
            const itemRows = rowsOf(child.items, depth + 1, rowPath + '[]')
            if (itemRows.length > 0) row.childGroups.push({ kind: 'items', rows: itemRows })
          }
        }
        return rows
      }

      /**
       * 一份 parameters 的可展示摘要。
       *
       * 只有「具名 object 属性」才值得结构化；`{ type: 'object' }`、`$ref`、
       * 顶层 oneOf 这类读不出字段的 schema 返回 opaque，由调用方原样显示，
       * 不猜、也不把空结果说成「没有参数」。
       * @param {object | undefined} parameters - 工具 schema 的 parameters。
       * @returns {{kind: 'object', rows: Array<object>, count: number, requiredCount: number} | {kind: 'opaque'} | {kind: 'none'}} 摘要。
       */
      function parseSchema(parameters) {
        if (!isRecord(parameters)) return { kind: 'none' }
        const properties = parameters.properties
        if (!isRecord(properties) || Object.keys(properties).length === 0) return { kind: 'opaque' }
        const rows = rowsOf(parameters, 0, '')
        return {
          kind: 'object',
          rows,
          count: Object.keys(properties).length,
          requiredCount: rows.filter((row) => row.required).length,
        }
      }

      /** 切换状态的 key：视图来源 + 工具名。 */
      function schemaKey(source, name) {
        return source + ':' + name
      }

      /** 这个工具当前是否显示原文；状态缺席时按结构化处理。 */
      function isRaw(vc, key) {
        const raw = vc?.schemaRaw
        return typeof raw?.has === 'function' && raw.has(key)
      }

      /** 结构化 / 原文的切换按钮；标签写下一步会切到哪一边。 */
      function schemaToggle(vc, key) {
        const raw = isRaw(vc, key)
        return textButton(raw ? '点击查看结构化结果' : '点击查看原文', () => {
          if (typeof vc?.setSchemaRaw === 'function') toggleIn(vc.setSchemaRaw, key)
        }, {
          title: raw ? '换回提炼后的参数视图' : '查看模型收到的原始 JSON schema',
        })
      }

      /** 约束的两列表：左列标签按内容宽，右列吃满剩余宽度并自行折行。 */
      function factsTable(facts) {
        return h(
          'dl',
          { className: 'ptSchemaFacts' },
          facts.flatMap((fact) => [
            h('dt', { key: fact.label }, fact.label),
            h(
              'dd',
              { key: fact.label + ':value' },
              fact.values === undefined
                ? fact.text
                : h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { className: 'ptSchemaEnumList' },
                      fact.values.map((value, index) => h('span', { key: index, className: 'ptSchemaEnum' }, value)),
                    ),
                    fact.more > 0
                      ? h('span', { className: 'ptSchemaMore' }, `另有 ${fact.more} 个（共 ${fact.total} 个），见原文`)
                      : null,
                  ),
            ),
          ]),
        )
      }

      /** 子参数块：缩进 + 左侧竖线，层级由容器表达而不是每行加 padding。 */
      function childGroup(group, key) {
        return h(
          'div',
          { key, className: 'ptSchemaChildren' },
          group.kind === 'items' ? h('p', { className: 'ptSchemaGroupLabel' }, '数组元素') : null,
          h('ul', { className: 'ptSchemaRows' }, group.rows.map((row) => schemaRow(row))),
        )
      }

      /**
       * 一个参数项：头行（名字 / 类型 / 必填）与正文（说明、约束、子参数）分开。
       *
       * 头行 `flex-wrap`：类型与标记紧跟名字；整行放不下时它们折到下一行，
       * 而不是把名字挤成一列单字。
       */
      function schemaRow(row) {
        return h(
          'li',
          { key: row.path, className: 'ptSchemaItem' },
          h(
            'div',
            { className: 'ptSchemaLine' },
            h('span', { className: 'ptSchemaName', title: row.path }, row.name),
            row.type !== '' ? h('span', { className: 'ptSchemaType' }, row.type) : null,
            row.required ? h('span', { className: 'ptSchemaReq', title: '必填参数' }, '必填') : null,
            row.truncated
              ? h('span', { className: 'ptSchemaMore', title: '更深的层级请查看原文' }, '更深层级')
              : null,
          ),
          row.description !== '' ? h('p', { className: 'ptSchemaDesc' }, row.description) : null,
          row.facts.length > 0 ? factsTable(row.facts) : null,
          row.childGroups.map((group, index) => childGroup(group, group.kind + ':' + index)),
        )
      }

      /**
       * 一个工具的参数区：默认结构化，按工具切回原文。
       *
       * `parameters === undefined` 时返回 null，由各视图保留自己的「无参数 schema」
       * 文案：三处原本就不一致（会话页不显示），统一反而会多出一行。
       * @param {object} tool - 至少含 `name`，通常含 `parameters`。
       * @param {object} ctx - `{ vc, source }`；`source` 区分工具页 / 预演 / 会话日志。
       * @returns {object | null} React 节点。
       */
      function renderParameters(tool, ctx) {
        const parameters = tool?.parameters
        if (parameters === undefined) return null
        const { vc, source } = ctx
        const key = schemaKey(source, tool.name)
        const raw = isRaw(vc, key)
        const parsed = parseSchema(parameters)

        if (parsed.kind === 'opaque') {
          return h(
            'div',
            { className: 'ptSchema' },
            h('p', { className: 'ptSchemaNote' }, '这份 schema 没有声明具名参数，按原文显示。'),
            h('pre', { className: 'ptPromptText', style: { marginTop: '6px' } }, JSON.stringify(parameters, null, 2)),
          )
        }

        return h(
          'div',
          { className: 'ptSchema' },
          h(
            'div',
            { className: 'ptSchemaHead' },
            h('span', { className: 'ptSchemaSummary' }, `参数 ${parsed.count} · 必填 ${parsed.requiredCount}`),
            h('span', { className: 'ptSchemaSpacer' }),
            schemaToggle(vc, key),
          ),
          raw
            ? h('pre', { className: 'ptPromptText', style: { marginTop: '6px' } }, JSON.stringify(parameters, null, 2))
            : h('ul', { className: 'ptSchemaRows' }, parsed.rows.map((row) => schemaRow(row))),
        )
      }

      return { parseSchema, renderParameters, schemaKey }
    }
  },
})
