/**
 * 提示词注册表的读取。
 *
 * 名字与顺序以注册表为准（`systemPrompt.layers`），不靠源码猜；源码只用来回答
 * 「谁写的」。文本则优先取 `assemble()` —— 它给出的是模型真正收到的东西，
 * 包含 `text` 是函数时求值后的结果。
 * @module dsh-plugin-console/host/prompt
 */

/**
 * 读取提示词注册表里此刻真正存在的区块与上下文。
 * @param {object} ctx - host 插件上下文。
 * @param {symbol} [scope] - agent scope；省略表示全局层。
 * @returns {Promise<{sections: Array<object>, contexts: Array<object>, tools?: Array<object>} | undefined>} 注册内容。
 */
export function readPromptRegistry(ctx, scope) {
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) return undefined

  // 优先用 assemble：它给出的是模型真正会收到的东西，
  // 包含 `text` 是函数时求值后的结果、以及按 toolOrder 排好的完整工具 schema。
  // assemble 给文本与工具 schema（函数形态的 text 已求值），但它不返回 order；
  // 注册表给 order、interpolate、complete。两者按 name 合并。
  const registry = readLayerRegistry(systemPrompt)
  if (typeof systemPrompt.assemble !== 'function') return registry

  return Promise.resolve(systemPrompt.assemble({ ...(scope === undefined ? {} : { scope }) }))
    .then((result) => {
      const normalized = normalizeAssembly(result)
      if (normalized === undefined) return registry
      // 同一个名字可以既注册成 section 又注册成 context（harness:source 就是这样），
      // 两张表必须分开索引，否则 context 的 order 会盖掉 section 的。
      const indexOf = (rows) => new Map((rows ?? []).map((row) => [row.name, row]))
      const sectionMeta = indexOf(registry?.sections)
      const contextMeta = indexOf(registry?.contexts)
      /** 把注册表里的静态字段补回 assemble 的行上。 */
      const merge = (row, meta) => {
        if (meta === undefined) return row
        return {
          ...row,
          ...(meta.order === undefined ? {} : { order: meta.order }),
          ...(meta.interpolate === undefined ? {} : { interpolate: meta.interpolate }),
          ...(meta.provider === true ? { provider: true } : {}),
        }
      }
      return {
        sections: normalized.sections.map((row) => merge(row, sectionMeta.get(row.name))),
        contexts: normalized.contexts.map((row) => merge(row, contextMeta.get(row.name))),
        tools: normalized.tools,
      }
    })
    .catch(() => registry)
}

/**
 * 把 assemble 的结果整理成可传输的形状。
 *
 * 与直接读注册表的区别：`text` 字段可能是函数（运行时才知道内容），
 * assemble 已经把它求值成字符串，因此这里拿到的是**渲染前的完整文本**，
 * 而不是 160 字的预览。
 * @param {object} assembly - `systemPrompt.assemble()` 的结果。
 * @returns {{sections: Array<object>, contexts: Array<object>, tools: Array<object>} | undefined} 归一化结果。
 */
export function normalizeAssembly(assembly) {
  if (assembly === undefined || assembly === null) return undefined
  const text = (value) => (typeof value === 'string' ? value : undefined)
  return {
    sections: (assembly.sections ?? []).map((section) => ({
      name: section.name,
      text: text(section.text),
      length: typeof section.text === 'string' ? section.text.length : undefined,
      interpolate: section.interpolate === false ? false : undefined,
    })),
    contexts: (assembly.contexts ?? []).map((context) => ({
      name: context.name,
      text: text(context.text),
      length: typeof context.text === 'string' ? context.text.length : undefined,
      required: context.required === true ? true : undefined,
    })),
    tools: (assembly.tools ?? []).map((tool) => ({
      name: tool.name,
      description: text(tool.description),
      parameters: tool.parameters,
      deferLoading: tool.deferLoading === true ? true : undefined,
    })),
  }
}

/**
 * 回退路径：直接读 `layers.global` 的注册表。
 *
 * 只在 `assemble` 不可用或抛错时使用。这条路径拿不到函数形态的 `text`
 * （那是运行时才求值的），所以文本会缺失——这是降级，不是常态。
 * @param {object} systemPrompt - systemPrompt 服务。
 * @returns {{sections: Array<object>, contexts: Array<object>} | undefined} 注册内容。
 */
export function readLayerRegistry(systemPrompt) {
  const layers = systemPrompt?.layers
  if (layers === undefined || layers.global === undefined) return undefined

  const rowsOf = (table) => {
    const out = []
    if (table === undefined || typeof table.entries !== 'function') return out
    for (const [name, value] of table.entries()) {
      const literal = typeof value?.text === 'string' ? value.text : undefined
      out.push({
        name,
        order: typeof value?.order === 'number' ? value.order : undefined,
        text: literal,
        length: literal === undefined ? undefined : literal.length,
        provider: typeof value?.text === 'function' ? true : undefined,
      })
    }
    return out
  }

  return {
    sections: rowsOf(layers.global.sections),
    contexts: rowsOf(layers.global.contexts),
  }
}

/**
 * 逐层枚举一个 scope 链，找出全局提示词段/上下文的同名替换与 scope 追加。
 *
 * `chainLayers(scope)` 返回的是「已存在的 scope 覆盖层」，按由远到近排列，不含全局层。
 * 同名条目在更近的层里再次出现时，近者胜——所以这里用 Map 记最后出现的那个层，
 * 而不是第一次出现的层。
 *
 * 这是**名字级**事实：只说明「这个名字被 scope 层重新注册了」，不说明是谁注册的；
 * owner 由调用方用现有源码扫描索引回填。
 * @param {object} ctx - host 插件上下文。
 * @param {symbol | string | undefined} scopeKey - `systemPrompt.layers` 的 scope 标识。
 * @returns {{layerCount: number, sections: object, contexts: object} | undefined} 覆盖摘要；读不到时 undefined。
 */
export function readScopePromptOverrides(ctx, scopeKey) {
  if (scopeKey === undefined || scopeKey === null) return undefined
  const layers = ctx.get('systemPrompt')?.layers
  if (layers === undefined || layers.global === undefined || typeof layers.chainLayers !== 'function') return undefined

  let chain
  try {
    chain = layers.chainLayers(scopeKey)
  } catch {
    return undefined
  }
  if (!Array.isArray(chain)) return undefined

  const rowsOf = (layer, table) => {
    const entries = layer?.[table]
    if (entries === undefined || typeof entries.entries !== 'function') return []
    return [...entries.entries()]
  }

  /** 一张注册表（sections 或 contexts）的替换 / 追加摘要。 */
  const summarize = (table) => {
    const globalNames = new Set(rowsOf(layers.global, table).map(([name]) => name))
    const overridden = new Map()
    const added = new Map()
    const perLayer = []
    chain.forEach((layer, index) => {
      const rows = rowsOf(layer, table)
      perLayer.push({ index: index + 1, names: rows.map(([name]) => name) })
      for (const [name, value] of rows) {
        const row = {
          name,
          layer: index + 1,
          ...(typeof value?.order === 'number' ? { order: value.order } : {}),
          ...(value?.complete === true ? { complete: true } : {}),
        }
        // 由远到近遍历，后写的覆盖先写的：更近的层才是最终生效者。
        if (globalNames.has(name)) overridden.set(name, row)
        else added.set(name, row)
      }
    })
    return { overridden: [...overridden.values()], added: [...added.values()], layers: perLayer }
  }

  try {
    return {
      layerCount: chain.length,
      sections: summarize('sections'),
      contexts: summarize('contexts'),
    }
  } catch {
    return undefined
  }
}

/**
 * 读出某个 scope 链上「独占型」提示词段的名字（`complete: true` 的那一段）。
 *
 * 独占段一旦生效，`assemble` 会把 sections 收窄成只有它一段——别的段（包括
 * 追加段落）都不会出现在模型看到的内容里。所以：
 *   - 覆盖它时必须带着 `complete` 注册回去，否则独占语义消失；
 *   - 追加段落想让它生效，只能并进这一段里，不能再单独注册一段。
 * @param {object} ctx - 带 scope 的上下文（agent.ctx）。
 * @param {Function} scopeKeyOf - scope 标识解析器（避免本模块反向依赖 fiber）。
 * @returns {string | undefined} 独占段名字；没有则 undefined。
 */
export function completeSectionOf(ctx, scopeKeyOf) {
  const layers = ctx?.systemPrompt?.layers
  if (layers === undefined || typeof layers.merge !== 'function') return undefined
  try {
    // 必须作为方法调用：merge 内部用 this.chainLayers。
    for (const [name, section] of layers.merge(scopeKeyOf(ctx), (layer) => layer.sections)) {
      if (section?.complete === true) return name
    }
  } catch {
    // 读不到就当没有独占段
  }
  return undefined
}
