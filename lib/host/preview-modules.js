/**
 * 预演用的「这条 pre-step 插件到底会不会运行」判定。
 *
 * **不能只看宿主 Loader 行。** web/desktop profile 会在 bundle patch 里把
 * `agent-instructions` 与 `tool-skill` 的宿主行显式 `disabled: true`，改由 agent
 * preset 在独立的内存 Loader 树里挂载；`time-context` 更是只有 preset 声明、
 * 连宿主行都没有。只查 `ctx.loader.entries()` 会把「模式里正 active 的插件」说成
 * 「插件已禁用」，于是三条注入消息永远不出现——这正是本模块存在的原因。
 *
 * 判定口径是「宿主启用了 **或** 当前模式挂载了」：两者任一成立，这条 pre-step
 * 监听器都会对新会话生效。
 *
 * 配置始终取宿主行：`compositionInventory()` 只暴露 entryId / moduleName /
 * enabled / condition，不暴露 preset 行的 config。取不到时由各采集器退回 DSH
 * 缺省值（见各自的 DEFAULTS），页面据此把「按缺省值推导」和「实测」分开标。
 * @module dsh-plugin-console/host/preview-modules
 */

/** 预演真正消费的模块；条件挂载的警告只针对这几个，不淹没其它条件行。 */
const TRACKED = [
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-time-context',
  '@deepseek-ai/dsh-skill-filesystem',
]

/** 模型看得到的短名；警告与 skipped 原因里用它，而不是整条包名。 */
const LABELS = {
  '@deepseek-ai/dsh-agent-instructions': 'agent-instructions',
  '@deepseek-ai/dsh-tool-skill': 'tool-skill',
  '@deepseek-ai/dsh-time-context': 'time-context',
  '@deepseek-ai/dsh-skill-filesystem': 'skill-filesystem',
}

/**
 * @param {string} moduleName - 包名。
 * @returns {string} 展示名。
 */
function labelOf(moduleName) {
  return LABELS[moduleName] ?? moduleName
}

/**
 * 一条模块判定结果。
 * @param {object} init - 字段。
 * @returns {object} 判定记录。
 */
function record(init) {
  return {
    name: init.name,
    available: init.available,
    /** `host` / `preset` / `both`；不可用时为 null。 */
    source: init.source ?? null,
    config: init.config,
    /** 模式里按 `!!js` 条件挂载：会不会生效取决于运行时条件。 */
    conditional: init.conditional === true,
    reason: init.reason,
  }
}

/**
 * 读宿主 Loader 行：模块名 → `{ enabled, config }`。
 *
 * 同名多行（例如 profile 的 `include:` 行与 bundle 行）时，只要有一行启用就算
 * 启用；配置取第一份带配置的，避免后一个空配置盖掉真正的值。
 * @param {object} ctx - host 插件上下文。
 * @returns {Map<string, {enabled: boolean, config: object | undefined}>} 宿主行。
 */
function hostRows(ctx) {
  const rows = new Map()
  let entries = []
  try {
    entries = ctx.loader?.entries?.() ?? []
  } catch {
    entries = []
  }
  for (const entry of entries) {
    const name = entry?.options?.name
    if (typeof name !== 'string') continue
    let enabled = true
    try {
      enabled = !entry.disabled
    } catch {
      enabled = true
    }
    const known = rows.get(name)
    rows.set(name, {
      enabled: enabled || known?.enabled === true,
      config: known?.config ?? entry.options?.config,
    })
  }
  return rows
}

/**
 * 读当前模式的声明组合：模块名 → `{ enabled, conditional }`。
 *
 * 只有 `compositionInventory()` 是公开且带启用状态的来源；`enabled` 为
 * `'conditional'` 表示这一行带 `!!js` 条件，预演不知道条件结果，按「挂载了但
 * 可能不生效」处理并留警告。
 * @param {object} ctx - host 插件上下文。
 * @param {string | undefined} presetId - 目标模式。
 * @returns {Promise<{rows: Map<string, {enabled: boolean, conditional: boolean}> | null, id: string | undefined, warning: string | undefined}>} 组合与诊断。
 */
async function presetRows(ctx, presetId) {
  const presets = ctx.get('agentPresetRegistry') ?? ctx.get('agentPresets')
  if (presets === undefined || typeof presets.compositionInventory !== 'function') {
    return { rows: null, id: presetId, warning: '模式注册表不可用：预演只覆盖宿主层' }
  }
  let inventory
  try {
    inventory = await presets.compositionInventory()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { rows: null, id: presetId, warning: `模式组合读取失败：${message}` }
  }
  const mode = inventory.find((row) => row?.id === presetId)
    ?? inventory.find((row) => row?.isDefault === true)
    ?? inventory[0]
  if (mode === undefined) {
    return { rows: null, id: presetId, warning: '没有可用的模式：预演只覆盖宿主层' }
  }
  const rows = new Map()
  for (const row of mode.rows ?? []) {
    const name = row?.moduleName
    if (typeof name !== 'string') continue
    const conditional = row.enabled === 'conditional'
    const enabled = row.enabled !== false
    const known = rows.get(name)
    rows.set(name, {
      enabled: enabled || known?.enabled === true,
      conditional: conditional || known?.conditional === true,
    })
  }
  return { rows, id: mode.id, warning: undefined }
}

/**
 * 只在宿主层判定（供直接调用采集器的场景使用）。
 *
 * 生产路径由 `request-preview.js` 用 `resolveModules()` 一次解析；这个同步版本
 * 只是让「没有模式上下文」的调用保持原来的语义，不静默改变行为。
 * @param {object} ctx - host 插件上下文。
 * @returns {object} 与 `resolveModules()` 同形的判定器。
 */
export function hostModuleResolver(ctx) {
  const host = hostRows(ctx)
  return {
    presetId: undefined,
    presetKnown: false,
    warnings: [],
    get(name) {
      const row = host.get(name)
      if (row === undefined) {
        return record({ name, available: false, reason: `${labelOf(name)} 未挂载` })
      }
      if (!row.enabled) {
        return record({ name, available: false, config: row.config, reason: `${labelOf(name)} 已禁用` })
      }
      return record({ name, available: true, source: 'host', config: row.config })
    },
    onlyFromPreset() {
      return false
    },
  }
}

/**
 * 解析一次预演里所有模块的可用性：宿主层 + 目标模式。
 * @param {object} ctx - host 插件上下文。
 * @param {string | undefined} presetId - 目标模式；省略时用 roster 的默认模式。
 * @returns {Promise<object>} `{ presetId, presetKnown, warnings, get, onlyFromPreset }`。
 */
export async function resolveModules(ctx, presetId) {
  const host = hostRows(ctx)
  const preset = await presetRows(ctx, presetId)

  const get = (name) => {
    const hostRow = host.get(name)
    const presetRow = preset.rows?.get(name)
    const hostEnabled = hostRow?.enabled === true
    const presetEnabled = presetRow?.enabled === true
    if (hostEnabled || presetEnabled) {
      return record({
        name,
        available: true,
        source: hostEnabled && presetEnabled ? 'both' : (presetEnabled ? 'preset' : 'host'),
        config: hostRow?.config,
        // 宿主已经无条件挂载时，模式里的条件行不再是唯一来源。
        conditional: presetRow?.conditional === true && !hostEnabled,
      })
    }
    let reason
    if (preset.rows === null) {
      reason = hostRow === undefined
        ? `${labelOf(name)} 未挂载（宿主层没有这一行）`
        : `${labelOf(name)} 已禁用`
    } else if (presetRow !== undefined) {
      reason = `${labelOf(name)} 在当前模式里被禁用`
    } else if (hostRow !== undefined) {
      reason = `${labelOf(name)} 未挂载：宿主行已禁用，当前模式也没有这一行`
    } else {
      reason = `${labelOf(name)} 未挂载：宿主与当前模式都没有这一行`
    }
    return record({ name, available: false, config: hostRow?.config, reason })
  }

  // 条件挂载只警告一次：missing 的判定仍按「挂载了」算，页面才不会被误报成缺消息。
  const conditional = TRACKED.filter((name) => get(name).conditional)
  return {
    presetId: preset.id,
    presetKnown: preset.rows !== null,
    warnings: [
      ...(preset.warning === undefined ? [] : [preset.warning]),
      ...(conditional.length === 0
        ? []
        : [`${conditional.map(labelOf).join('、')} 在当前模式里是条件挂载，实际是否生效取决于运行时条件`]),
    ],
    get,
    /**
     * 该模块是否只由模式提供。
     *
     * skill 目录依赖 `skill-filesystem` 注册进模式 scope；宿主层没有它时，
     * 拿不到模式 scope 就读不到任何提供方——这时必须标「不可用」，不能把
     * 空目录说成「这个工作区没有 skill」。
     * @param {string} name - 包名。
     * @returns {boolean} 是否只来自模式。
     */
    onlyFromPreset(name) {
      return preset.rows?.get(name)?.enabled === true && host.get(name)?.enabled !== true
    },
  }
}
