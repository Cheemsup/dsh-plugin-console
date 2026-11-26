/**
 * 能力面的技能清单：按「工作区 + 模式」读取 `ctx.skills` 的完整元数据。
 *
 * 与 `preview-skills.js` 的分工：那边只渲染首请求里的 `skill-catalog` 消息，
 * 并且按 `modelInvocable` 过滤；这里回答「这台部署有哪些 skill、各在哪」，
 * 因此 `path`、`invocation`、`resourceBase`、发现完整性都要保留。
 *
 * 所有读取都是运行时事实；读不到时返回 `available:false + reason`，不把
 * 「服务缺席」显示成「没有技能」。正文按需单独读取并截断。
 * @module dsh-plugin-console/host/surface-skills
 */

import { acquirePresetScope } from './assembly-preview.js'
import { readWorkspace } from './preview-conditions.js'
import { ownersForSkill, readSurfaceOwnerIndex } from './surface-owners.js'

/** 目录快照的上限：与首请求预演一致，cwd 扫描可能真的去读磁盘。 */
const SNAPSHOT_TIMEOUT_MS = 3000

/** 正文展示上限；清单不该被单条技能拖大。 */
export const SKILL_CONTENT_LIMIT = 4000

/** 只有在宿主支持时才有取消信号；没有就退回不取消。 */
function timeoutSignal() {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) : undefined
}

/**
 * 从快照里取一条技能的展示字段。
 * @param {object} skill - `ctx.skills.snapshot()` 的一行。
 * @returns {object} 投影后的行。
 */
function projectSkill(skill) {
  const invocation = skill?.invocation ?? {}
  return {
    name: typeof skill?.name === 'string' ? skill.name : '',
    description: typeof skill?.description === 'string' ? skill.description : '',
    ...(typeof skill?.whenToUse === 'string' ? { whenToUse: skill.whenToUse } : {}),
    ...(typeof skill?.path === 'string' ? { path: skill.path } : {}),
    source: typeof skill?.source === 'string' ? skill.source : '',
    provider: typeof skill?.provider === 'string' ? skill.provider : '',
    invocation: {
      modelInvocable: invocation.modelInvocable === true,
      userInvocable: invocation.userInvocable === true,
    },
    ...(skill?.resourceBase === undefined ? {} : { resourceBase: skill.resourceBase }),
    evidence: 'runtime',
  }
}

/**
 * 统计来源分布；界面用一行读数回答「这批 skill 是从哪扫出来的」。
 * @param {Array<object>} rows - 投影后的技能行。
 * @returns {object} 计数。
 */
function countOf(rows) {
  const bySource = {}
  let model = 0
  let user = 0
  let withPath = 0
  for (const row of rows) {
    bySource[row.source] = (bySource[row.source] ?? 0) + 1
    if (row.invocation.modelInvocable) model += 1
    if (row.invocation.userInvocable) user += 1
    if (typeof row.path === 'string') withPath += 1
  }
  return { total: rows.length, model, user, withPath, bySource }
}

/**
 * 读技能清单。
 * @param {object} ctx - host 插件上下文。
 * @param {object} [options] - 条件。
 * @param {string} [options.workspacePath] - 工作区路径；省略表示没有 cwd。
 * @param {string} [options.presetId] - 模式 id；省略表示宿主默认模式。
 * @returns {Promise<object>} `{ available, conditions, complete, counts, skills, warnings }`。
 */
export async function readSurfaceSkills(ctx, options = {}) {
  const warnings = []
  let workspace = null
  try {
    workspace = await readWorkspace(ctx, options.workspacePath, warnings, '检查')
  } catch (error) {
    warnings.push(`工作区解析失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const conditions = {
    workspace,
    presetId: typeof options.presetId === 'string' && options.presetId.length > 0 ? options.presetId : null,
    scope: 'global',
  }

  const skills = ctx.get('skills')
  if (skills === undefined || typeof skills.snapshot !== 'function') {
    return {
      available: false,
      reason: '宿主没有 skills 服务：无法读取技能目录',
      conditions,
      complete: false,
      counts: { total: 0, model: 0, user: 0, withPath: 0, bySource: {} },
      skills: [],
      warnings,
    }
  }

  let scope
  try {
    scope = await acquirePresetScope(ctx, conditions.presetId ?? undefined)
  } catch (error) {
    return {
      available: false,
      reason: `模式 scope 获取失败：${error instanceof Error ? error.message : String(error)}`,
      conditions,
      complete: false,
      counts: { total: 0, model: 0, user: 0, withPath: 0, bySource: {} },
      skills: [],
      warnings,
    }
  }

  conditions.presetId = scope.presetId ?? conditions.presetId
  conditions.scope = scope.scopeKey === undefined ? 'global' : 'preset'
  warnings.push(...scope.warnings)

  try {
    const signal = timeoutSignal()
    const snapshot = await skills.snapshot({
      ...(workspace?.path === undefined ? {} : { cwd: workspace.path }),
      ...(scope.scopeKey === undefined ? {} : { scope: scope.scopeKey }),
      ...(signal === undefined ? {} : { signal }),
    })
    const index = await readSurfaceOwnerIndex(ctx)
    const rows = (snapshot?.skills ?? []).map((skill) => ({
      ...projectSkill(skill),
      ...ownersForSkill(skill, index),
    }))
    return {
      available: true,
      conditions,
      complete: snapshot?.complete === true,
      counts: countOf(rows),
      skills: rows,
      warnings,
    }
  } catch (error) {
    return {
      available: false,
      reason: `skill 目录读取失败：${error instanceof Error ? error.message : String(error)}`,
      conditions,
      complete: false,
      counts: { total: 0, model: 0, user: 0, withPath: 0, bySource: {} },
      skills: [],
      warnings,
    }
  } finally {
    await scope.dispose()
  }
}

/**
 * 读一条技能的正文。
 *
 * 只走 `ctx.skills.get()`：provider 才知道权限与资源基座，插件不去猜文件路径。
 * 失败返回 `found:false + reason`，不抛给路由层。
 * @param {object} ctx - host 插件上下文。
 * @param {object} options - 条件。
 * @param {string} options.name - 技能名。
 * @param {string} [options.workspacePath] - 工作区路径。
 * @param {string} [options.presetId] - 模式 id。
 * @returns {Promise<object>} `{ found, ... }`。
 */
export async function readSurfaceSkillContent(ctx, options = {}) {
  const name = typeof options.name === 'string' ? options.name.trim() : ''
  if (name.length === 0) return { found: false, reason: '缺少技能名' }

  const ctxSkills = ctx.get('skills')
  if (ctxSkills === undefined || typeof ctxSkills.get !== 'function') {
    return { found: false, reason: '宿主没有 skills 服务：无法读取技能正文' }
  }

  const warnings = []
  let workspace = null
  try {
    workspace = await readWorkspace(ctx, options.workspacePath, warnings, '检查')
  } catch (error) {
    warnings.push(`工作区解析失败：${error instanceof Error ? error.message : String(error)}`)
  }

  let scope
  try {
    scope = await acquirePresetScope(ctx, typeof options.presetId === 'string' && options.presetId.length > 0 ? options.presetId : undefined)
  } catch (error) {
    return { found: false, reason: `模式 scope 获取失败：${error instanceof Error ? error.message : String(error)}`, warnings }
  }

  try {
    const signal = timeoutSignal()
    const skill = await ctxSkills.get(name, {
      ...(workspace?.path === undefined ? {} : { cwd: workspace.path }),
      ...(scope.scopeKey === undefined ? {} : { scope: scope.scopeKey }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (skill === undefined || skill === null) {
      return { found: false, reason: `没有找到名为「${name}」的技能（或它不在当前条件下可见）`, warnings }
    }
    const content = typeof skill.content === 'string' ? skill.content : ''
    return {
      found: true,
      name: skill.name,
      provider: skill.provider,
      source: skill.source,
      ...(typeof skill.path === 'string' ? { path: skill.path } : {}),
      ...(skill.resourceBase === undefined ? {} : { resourceBase: skill.resourceBase }),
      content: content.slice(0, SKILL_CONTENT_LIMIT),
      length: content.length,
      truncated: content.length > SKILL_CONTENT_LIMIT,
      evidence: 'runtime',
      warnings,
    }
  } catch (error) {
    return { found: false, reason: `技能正文读取失败：${error instanceof Error ? error.message : String(error)}`, warnings }
  } finally {
    await scope.dispose()
  }
}
