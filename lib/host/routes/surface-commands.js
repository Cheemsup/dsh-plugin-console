/**
 * 斜杠命令目录：GET ?session=&preset=&workspace=。
 *
 * 三个条件都是可选的：给了活会话就读会话目录；只给模式就读预设 scope；
 * 都不给就按部署默认模式读预设 scope。失败不会变成 500——目录读取是诊断，
 * 降级结果与原因一起返回。
 * @module dsh-plugin-console/host/routes/surface-commands
 */

import { jsonError, jsonOk, searchParam } from '../http.js'
import { readSurfaceCommands } from '../surface-commands.js'

/** 会话 id / 模式 id 的长度上限。 */
const MAX_ID = 300

/** 工作区路径上限。 */
const MAX_PATH = 1000

/**
 * 读一个可选条件并校验长度。
 * @param {Request} request - 请求。
 * @param {string} name - 参数名。
 * @param {number} max - 上限。
 * @returns {{value?: string, error?: string}} 条件。
 */
function condition(request, name, max) {
  const raw = searchParam(request, name)
  if (raw === undefined || raw.length === 0) return {}
  if (raw.length > max) return { error: `${name} 超过 ${max} 个字符` }
  return { value: raw }
}

/**
 * @param {object} ctx - host 插件上下文。
 * @returns {Function} fetch 处理函数。
 */
export function createSurfaceCommandsRoute(ctx) {
  return async (request) => {
    const session = condition(request, 'session', MAX_ID)
    if (session.error !== undefined) return jsonError(400, session.error)
    const preset = condition(request, 'preset', MAX_ID)
    if (preset.error !== undefined) return jsonError(400, preset.error)
    const workspace = condition(request, 'workspace', MAX_PATH)
    if (workspace.error !== undefined) return jsonError(400, workspace.error)
    return jsonOk(await readSurfaceCommands(ctx, {
      sessionId: session.value,
      presetId: preset.value,
      workspacePath: workspace.value,
    }))
  }
}
