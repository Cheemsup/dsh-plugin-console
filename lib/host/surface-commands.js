/**
 * 能力面的斜杠命令目录。
 *
 * 数据来源分三层，界面必须区分：
 *   1. 活会话：`ctx.commands.list(agent)`——宿主按该 Agent 的 scope 链合并后的有效目录；
 *   2. 预设 scope：没有活会话时用 `agentPresets.acquireScope()` 的 scope key 只读；
 *      `list()` 的签名写的是 Agent，这里只把它当 scope 键用，失败即降级；
 *   3. 源码扫描：`commands.register({ name })` 的字面量名字，只补名字与归属。
 *
 * `/` 目录在客户端还会合并 client 侧贡献（ui-commands）与技能源；宿主侧看不到
 * 前者，所以返回里固定带一条说明，不把它伪装成完整目录。
 * @module dsh-plugin-console/host/surface-commands
 */

import { acquirePresetScope } from './assembly-preview.js'
import { builtinOf } from './command-builtins.js'
import { scopeKeyOf } from './fiber.js'
import { ownersForCommand, ownersForSkill, readSurfaceOwnerIndex } from './surface-owners.js'

/** 目录读取的上限：命令表是内存注册表，正常远小于这个数。 */
const SKILL_TIMEOUT_MS = 3000

/** 宿主支持时才带取消信号。 */
function timeoutSignal() {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(SKILL_TIMEOUT_MS) : undefined
}

/**
 * 从运行时描述符里取展示字段。
 * @param {object} command - `commands.list()` 的一行。
 * @returns {object} 投影后的行。
 */
function projectCommand(command) {
  const input = command?.input
  const builtin = builtinOf(command?.definitionId)
  return {
    name: command.name,
    description: typeof command.description === 'string' ? command.description : '',
    ...(input === undefined || input === null
      ? {}
      : { input: { ...(typeof input.hint === 'string' ? { hint: input.hint } : {}), ...(input.attachments === true ? { attachments: true } : {}) } }),
    ...(typeof command.definitionId === 'string' ? { definitionId: command.definitionId } : {}),
    ...(builtin === undefined ? {} : { builtin }),
  }
}

/**
 * 读斜杠命令目录。
 * @param {object} ctx - host 插件上下文。
 * @param {object} [options] - 条件。
 * @param {string} [options.sessionId] - 活会话；省略时按预设 scope 读。
 * @param {string} [options.presetId] - 模式 id；省略表示部署默认模式。
 * @param {string} [options.workspacePath] - 工作区路径；没有会话 cwd 时用于技能目录。
 * @returns {Promise<object>} 目录结果。
 */
export async function readSurfaceCommands(ctx, options = {}) {
  const warnings = []
  const sessionId = typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : null
  const presetId = typeof options.presetId === 'string' && options.presetId.length > 0 ? options.presetId : null
  const commands = ctx.get('commands')
  const skills = ctx.get('skills')
  const notes = ['客户端侧命令贡献（ui-commands）与客户端技能源不在此表：它们只在浏览器里注册。']

  let agent
  if (sessionId !== null) {
    try {
      agent = ctx.get('agents')?.get?.(sessionId)
    } catch {
      agent = undefined
    }
  }

  let scope = 'scan-only'
  let offContract = false
  let runtimeRows = []
  let scopeKey = agent === undefined ? undefined : scopeKeyOf(agent?.ctx)
  let cwd = typeof options.workspacePath === 'string' && options.workspacePath.length > 0 ? options.workspacePath : undefined
  const sessionCwd = agent?.session?.header?.cwd
  if (typeof sessionCwd === 'string' && sessionCwd.length > 0) cwd = sessionCwd
  let reason

  let lease
  if (agent !== undefined) {
    if (typeof commands?.list !== 'function') {
      reason = '宿主没有 commands 服务：只能给出源码扫描结果'
    } else {
      try {
        runtimeRows = [...(await Promise.resolve(commands.list(agent)))]
        scope = 'session'
      } catch (error) {
        reason = `会话命令目录读取失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
  } else if (sessionId !== null) {
    reason = '会话不活跃：命令目录只在活会话里可读；下面是源码扫描结果'
  } else {
    // 没有指定会话：按选中的（或部署默认的）模式只读预设 scope。
    try {
      lease = await acquirePresetScope(ctx, presetId ?? undefined)
      scopeKey = lease.scopeKey
      warnings.push(...lease.warnings)
    } catch (error) {
      reason = `模式 scope 获取失败：${error instanceof Error ? error.message : String(error)}`
    }
    if (scopeKey === undefined) {
      reason = reason ?? '没有可用的模式 scope：只保留源码扫描结果'
    } else if (typeof commands?.list !== 'function') {
      reason = '宿主没有 commands 服务：只能给出源码扫描结果'
    } else {
      try {
        runtimeRows = [...(await Promise.resolve(commands.list(scopeKey)))]
        scope = 'preset'
        offContract = true
        notes.push('预设 scope 以 scope key 读取：宿主 API 的签名以 Agent 为参数，这里只读列表；失败会降级为源码扫描。')
      } catch (error) {
        reason = `预设命令目录读取失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  try {
    const index = await readSurfaceOwnerIndex(ctx)
    const seen = new Set()
    const commandRows = []
    for (const command of runtimeRows) {
      const name = command?.name
      if (typeof name !== 'string' || name.length === 0) continue
      if (seen.has(name)) {
        warnings.push(`命令 /${name} 在同一目录里重复出现：保留第一条`)
        continue
      }
      seen.add(name)
      commandRows.push({
        ...projectCommand(command),
        evidence: 'runtime',
        ...ownersForCommand(command, index),
      })
    }

    // / 目录里的技能源：只列 userInvocable，模型目录已经由技能段完整覆盖。
    const skillRows = []
    if (typeof skills?.snapshot === 'function') {
      const signal = timeoutSignal()
      try {
        const snapshot = await skills.snapshot({
          ...(cwd === undefined ? {} : { cwd }),
          ...(scopeKey === undefined ? {} : { scope: scopeKey }),
          ...(signal === undefined ? {} : { signal }),
        })
        for (const skill of snapshot?.skills ?? []) {
          if (skill?.invocation?.userInvocable !== true) continue
          skillRows.push({
            name: skill.name,
            description: typeof skill.description === 'string' ? skill.description : '',
            evidence: 'runtime',
            ...ownersForSkill(skill, index),
          })
        }
      } catch (error) {
        warnings.push(`技能目录读取失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // 源码扫描：只补运行时目录里没有的名字，按名字合并所有者。
    const scanOnly = []
    const scanned = new Map()
    for (const row of index) {
      for (const name of row.registrations?.commands ?? []) {
        if (typeof name !== 'string' || name.length === 0 || seen.has(name)) continue
        const owners = scanned.get(name) ?? []
        if (!owners.includes(row.rowId)) owners.push(row.rowId)
        scanned.set(name, owners)
      }
    }
    for (const [name, owners] of scanned) {
      scanOnly.push({ name, owners, via: 'scan', evidence: 'scan' })
    }

    return {
      available: true,
      scope,
      offContract,
      sessionId,
      presetId,
      conditions: { workspacePath: cwd ?? null },
      commands: commandRows,
      skills: skillRows,
      scanOnly,
      counts: {
        commands: commandRows.length,
        skills: skillRows.length,
        scanOnly: scanOnly.length,
      },
      notes,
      ...(reason === undefined ? {} : { reason }),
      warnings,
    }
  } finally {
    if (lease !== undefined) await lease.dispose()
  }
}
