/**
 * 模板存储的打开与表句柄。
 *
 * 存储域不可用时降级为内存表——绝不写 sidecar 文件，那不是持久化契约。
 * 表句柄把「域的表」和「内存 Map」抹平成同一组方法，上层不必知道当前是哪种。
 * @module dsh-plugin-console/host/templates/store
 */

/**
 * 模板域的声明。
 *
 * 域名必须匹配 /^[a-z][a-z0-9_]*$/：storage 拿它当文件名与 SQL 标识符。
 * tables 里的每张表只需一个带 parse 的 schema——storage-domain 在读出时调用它，
 * 失败会抛 invalid-record 并（配置了的话）把坏记录备份移走。
 * @returns {object} 域声明。
 */
export function templateDomain() {
  /** 一个最小的结构校验器：只检查必填字段类型，够挡住损坏的记录。 */
  const shape = (checks) => ({
    parse(value) {
      if (value === null || typeof value !== 'object') throw new Error('record must be an object')
      for (const [key, test] of Object.entries(checks)) {
        if (!test(value[key])) throw new Error('field "' + key + '" has the wrong type')
      }
      return value
    },
  })
  const isString = (value) => typeof value === 'string'
  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
  const isObject = (value) => value !== null && typeof value === 'object'
  const isBoolean = (value) => typeof value === 'boolean'
  const isArray = (value) => Array.isArray(value)

  return {
    name: 'plugin_console_templates',
    version: 1,
    tables: {
      templates: { valueSchema: shape({ id: isString, name: isString, latestRevision: isNumber, createdAt: isNumber, updatedAt: isNumber }) },
      revisions: { valueSchema: shape({ templateId: isString, revision: isNumber, schemaVersion: isNumber, recipe: isObject, createdAt: isNumber }) },
      manifests: { valueSchema: shape({ schemaVersion: isNumber, sessionId: isString, recipe: isObject, createdAt: isNumber }) },
      // 每会话的启用状态。
      //
      // 与 manifest 分表是刻意的：manifest 记「应该怎么改」，是会话创建时的
      // 不可变快照；activation 记「现在要不要应用」，是频繁变动的开关。
      // 混在一起会让「会话自有、不可变」这条语义失效，也会让每次开关都重写
      // 整份 manifest（含 recipe 全文）。
      //
      // 没有记录 = 启用。所以关闭是显式写一条 enabled: false。
      activations: { valueSchema: shape({ sessionId: isString, enabled: isBoolean, updatedAt: isNumber }) },
      // 会话级贡献掩码：某会话隐藏某个插件的工具贡献。
      // 与 manifest 分开：manifest 是模板快照，掩码是诊断/控制动作，二者可共存。
      masks: { valueSchema: shape({ sessionId: isString, rowId: isString, createdAt: isNumber, tools: isArray }) },
      // 控制审计：谁在什么时候对哪个目标做了什么，结果如何。
      operations: { valueSchema: shape({ id: isString, time: isNumber, action: isString, scope: isString, target: isString, before: isObject, after: isObject, result: isString }) },
    },
  }
}

/** 生成一个模板 id。 */
export function newTemplateId() {
  return 'tpl-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

/**
 * 新建一份存储状态：域、内存降级、以及打开中的 promise 都挂在这里。
 * @returns {object} 状态对象。
 */
export function createTemplateState() {
  return { domain: undefined, memory: undefined, ready: undefined }
}

/**
 * 打开（或复用）模板存储。
 * @param {object} ctx - host 插件上下文。
 * @param {object} state - 本插件持有的状态（缓存已打开的域）。
 * @returns {Promise<void>} 打开完成。
 */
export async function ensureTemplateStore(ctx, state) {
  if (state.ready !== undefined) return state.ready
  state.ready = (async () => {
    const facility = ctx.get('storageDomain')
    if (facility === undefined || typeof facility.open !== 'function') {
      state.memory = { templates: new Map(), revisions: new Map(), manifests: new Map(), activations: new Map(), masks: new Map(), operations: new Map() }
      ctx.logger?.warn?.('plugin-console: storageDomain 不可用，模板降级为内存存储（不持久化）')
      return
    }
    state.domain = await facility.open(templateDomain())
  })()
  return state.ready
}

/**
 * 取一张逻辑表。域可用时走域，否则走内存 Map 的同名接口。
 * @param {object} state - 插件状态。
 * @param {string} name - 表名。
 * @returns {object} 表句柄。
 */
export function templateTable(state, name) {
  if (state.domain !== undefined) return state.domain.table(name)
  const map = state.memory[name]
  return {
    get: (key) => map.get(key),
    put: async (key, value) => { map.set(key, value) },
    delete: async (key) => { map.delete(key) },
    entries: () => map.entries(),
    keys: () => map.keys(),
  }
}

/**
 * 关闭模板存储；重复关闭或从未打开都安全。
 * @param {object} state - 插件状态。
 * @returns {void}
 */
export function closeTemplateStore(state) {
  if (state.domain !== undefined) void state.domain.close()
}

/**
 * 把存储状态退回「从未打开」。
 *
 * 只在关闭域之后调用：清空重开时文件已被删除，旧的域与已解析的 ready 都必须
 * 丢掉，下一次 `ensureTemplateStore` 才会重新打开并读到空单元。
 * @param {object} state - 插件状态。
 * @returns {void}
 */
export function resetTemplateStore(state) {
  state.domain = undefined
  state.memory = undefined
  state.ready = undefined
}
