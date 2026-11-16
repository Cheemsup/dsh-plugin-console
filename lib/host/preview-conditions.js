/**
 * 预演条件：把「在哪个工作区、用哪套权限、什么模型、什么时区」解析成可展示的值。
 *
 * 为什么这些要单独成文件：首请求里有一半内容不是 `assemble()` 产出的，而是
 * loop 与 pre-step 监听器按会话状态注入的（cwd、sandbox、approval、skill 目录、
 * 时间快照）。那些东西在「只选一个模式」的预演里根本没有输入，页面只能显示
 * 空——把一个条件缺失说成「模型没收到」，结论正好相反。所以条件必须先被显式解析，
 * 解析不出来就标未知并写原因，不留空。
 *
 * 所有采集都降级：任何一段读不到只影响它自己，绝不抛错——除了 `assemble()` 本身。
 * @module dsh-plugin-console/host/preview-conditions
 */

import { isAbsolute, resolve } from 'node:path'
import { isDirectory } from './fs.js'

/** 路径比较在 Windows 上大小写不敏感；这是比较口径，不是路径改写。 */
const WINDOWS = process.platform === 'win32'

/** 模型信息查询的上限：适配器可能访问网络，预演不该被它拖住。 */
const MODEL_INFO_TIMEOUT_MS = 2000

/** 客户端时区的合理长度上限；超长说明不是 IANA 时区名。 */
const MAX_TIME_ZONE_LENGTH = 64

/** 列举可用的 permissionPresets 选项时要保留的字段。 */
function presetOption(option) {
  return {
    value: String(option?.value ?? ''),
    name: typeof option?.name === 'string' ? option.name : String(option?.value ?? ''),
    ...(typeof option?.description === 'string' ? { description: option.description } : {}),
  }
}

/**
 * 归一化路径用于**比较**：统一分隔符、去掉尾部分隔符，Windows 上折成小写。
 * 不改写任何展示路径——注册表里的 `path` 才是权威写法。
 * @param {unknown} value - 待比较的路径。
 * @returns {string} 比较键。
 */
function pathKey(value) {
  const text = String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  return WINDOWS ? text.toLowerCase() : text
}

/**
 * 解析工作区条件。
 *
 * 已注册的工作区优先用注册表记录（id / title 是权威值）；未注册但真实存在的绝对路径
 * 按「自定义目录」预演——预演需要看任意目录的 AGENTS.md 与 skill 目录，不能只限注册表。
 * 自定义目录只用于推导：它没有工作区 id，不会被拿去建会话。
 * @param {object} ctx - host 插件上下文。
 * @param {string | undefined} requested - 客户端选择的工作区路径。
 * @param {string[]} warnings - 收集警告。
 * @returns {Promise<object | null>} `{ id, path, title, source }`；无法解析时为 null。
 */
async function readWorkspace(ctx, requested, warnings) {
  let list = []
  try {
    list = ctx.get('workspaceRegistry')?.list?.() ?? []
  } catch (error) {
    warnings.push(`工作区注册表不可用：${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    warnings.push('未选择工作区：skill 目录、workspace 指令与 cwd / sandbox / approval 文本都无法预测')
    return null
  }
  const requestedText = requested.trim()
  const found = list.find((workspace) => pathKey(workspace?.path) === pathKey(requestedText))
  if (found !== undefined) {
    return {
      id: found.id ?? null,
      path: found.path,
      title: found.title ?? found.path,
      source: 'registered',
    }
  }
  // 注册表里没有：只有真实存在的绝对路径才能当目录读。
  if (!isAbsolute(requestedText)) {
    warnings.push(`工作区路径「${requestedText}」不是绝对路径：无法定位目录`)
    return null
  }
  const resolved = resolve(requestedText)
  if (!(await isDirectory(resolved))) {
    warnings.push(`工作区路径「${resolved}」不存在或不是目录`)
    return null
  }
  warnings.push(`工作区「${resolved}」未注册：按自定义目录预演，仅影响推导，不用于建会话`)
  return { id: null, path: resolved, title: resolved, source: 'custom' }
}

/**
 * 组合默认的 sandbox / approval。
 *
 * 新建会话在 `permissionPresets` 缺席时会直接读到这两个值，所以它们是「没有预设时
 * 真实会生效的东西」，而不是猜测。
 * @param {object} ctx - host 插件上下文。
 * @returns {{ sandbox: string | null, approval: string }} 组合默认值。
 */
function compositionPermission(ctx) {
  let sandbox = null
  let approval = 'ask'
  try {
    const mode = ctx.get('shell')?.sandboxMode
    if (typeof mode === 'string') sandbox = mode
  } catch {
    // shell 不可用就留空，由调用方标未知
  }
  try {
    const policy = ctx.get('approval')?.config?.policy
    if (typeof policy === 'string') approval = policy
  } catch {
    // approval 不可用就用 DSH 自己的缺省
  }
  return { sandbox, approval }
}

/**
 * 解析权限预设：预设名 → `{ sandbox, approval }` 的映射由 `permissionPresets.resolve()`
 * 给出，不需要去偷读 Loader 行的私有配置。
 * @param {object} ctx - host 插件上下文。
 * @param {string | undefined} requested - 客户端选择的预设名。
 * @param {string[]} warnings - 收集警告。
 * @returns {object} `{ preset, sandbox, approval, source, options }`。
 */
function readPermission(ctx, requested, warnings) {
  const fallback = compositionPermission(ctx)
  let service
  let catalog = null
  try {
    service = ctx.get('permissionPresets')
    catalog = service?.catalog?.() ?? null
  } catch (error) {
    warnings.push(`权限预设目录不可用：${error instanceof Error ? error.message : String(error)}`)
  }
  if (catalog === null || catalog === undefined) {
    warnings.push('权限预设服务不可用：sandbox 与 approval 退回组合默认值')
    return { preset: null, ...fallback, source: 'composition', options: [] }
  }

  const options = (catalog.options ?? []).map(presetOption)
  const names = new Set(options.map((option) => option.value))
  const fallbackName = typeof catalog.defaultPreset === 'string' ? catalog.defaultPreset : null
  let preset = fallbackName
  let source = 'default'
  if (typeof requested === 'string' && requested.length > 0) {
    if (names.has(requested)) {
      preset = requested
      source = 'selected'
    } else {
      warnings.push(`未知的权限预设「${requested}」：改用部署默认值「${fallbackName ?? '无'}」`)
    }
  }

  let spec = null
  try {
    spec = service.resolve(preset)
  } catch {
    // `custom` 不是可切换目标，`resolve()` 对它必然抛错：它本身就等于「不匹配任何预设」，
    // 所以直接退回组合默认值，那正是当前会话真实生效的 sandbox / approval。
    spec = null
  }
  if (spec === null) {
    return { preset, ...fallback, source: 'composition', options }
  }
  return {
    preset,
    sandbox: typeof spec.sandbox === 'string' ? spec.sandbox : fallback.sandbox,
    approval: typeof spec.approval === 'string' ? spec.approval : fallback.approval,
    source,
    options,
  }
}

/**
 * 解析默认模型。没有它，`{{model}}` / `{{provider}}` 只能保留字面量。
 * @param {object} ctx - host 插件上下文。
 * @param {string[]} warnings - 收集警告。
 * @returns {object | null} `{ provider, model, reasoningEffort?, source }`。
 */
function readModel(ctx, warnings) {
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') {
      return {
        provider: selection.provider,
        model: selection.model,
        ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
        source: 'default',
      }
    }
  } catch (error) {
    warnings.push(`默认模型不可用：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  warnings.push('默认模型不可用：provider、model 与上下文窗口都标为未知')
  return null
}

/**
 * 解析上下文窗口。
 *
 * 适配器可能真的去问远端，所以既传 AbortSignal 又自己设一道超时——只依赖 signal 的话，
 * 不理会信号的适配器会让整次预演挂住。
 * @param {object} ctx - host 插件上下文。
 * @param {object | null} model - 已解析的模型。
 * @param {string[]} warnings - 收集警告。
 * @returns {Promise<number | null>} 窗口大小（token）。
 */
async function readContextWindow(ctx, model, warnings) {
  if (model === null) return null
  const llm = ctx.get('llm')
  if (typeof llm?.resolveModelInfo !== 'function') {
    warnings.push('llm 服务不可用：上下文窗口未知')
    return null
  }
  let timer
  try {
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), MODEL_INFO_TIMEOUT_MS)
    })
    const info = await Promise.race([
      llm.resolveModelInfo(model.provider, model.model, AbortSignal.timeout(MODEL_INFO_TIMEOUT_MS)),
      expired,
    ])
    const window = info?.context?.contextWindow
    return typeof window === 'number' && window > 0 ? window : null
  } catch (error) {
    warnings.push(`模型信息查询失败：上下文窗口未知（${error instanceof Error ? error.message : String(error)})`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 解析客户端时区：模型看到的 time-context 用的就是这个时区。
 * @param {unknown} requested - 客户端上报的 IANA 时区名。
 * @param {string[]} warnings - 收集警告。
 * @returns {{ clientTimeZone: string, clientTimeZoneSource: 'client' | 'server' }} 时区与来源。
 */
function readTimeZone(requested, warnings) {
  if (typeof requested === 'string' && requested.length > 0 && requested.length <= MAX_TIME_ZONE_LENGTH) {
    return { clientTimeZone: requested, clientTimeZoneSource: 'client' }
  }
  let fallback = 'UTC'
  try {
    fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    // 拿不到就用 UTC，不编一个时区出来
  }
  warnings.push('客户端时区缺失：退回服务端时区')
  return { clientTimeZone: fallback, clientTimeZoneSource: 'server' }
}

/**
 * 解析一次首请求预演的全部条件。
 * @param {object} ctx - host 插件上下文。
 * @param {object} options - 客户端上报的条件。
 * @param {string} [options.workspacePath] - 工作区路径：已注册路径，或任意绝对目录。
 * @param {string} [options.permissionPreset] - 权限预设名。
 * @param {string} [options.clientTimeZone] - 客户端 IANA 时区。
 * @returns {Promise<object>} 条件 + 警告。
 */
export async function resolveConditions(ctx, options = {}) {
  const warnings = []
  const workspace = await readWorkspace(ctx, options.workspacePath, warnings)
  const permission = readPermission(ctx, options.permissionPreset, warnings)
  const model = readModel(ctx, warnings)
  const contextWindow = await readContextWindow(ctx, model, warnings)
  const zone = readTimeZone(options.clientTimeZone, warnings)
  return {
    workspace,
    permission,
    model,
    contextWindow,
    clientTimeZone: zone.clientTimeZone,
    clientTimeZoneSource: zone.clientTimeZoneSource,
    warnings,
  }
}
