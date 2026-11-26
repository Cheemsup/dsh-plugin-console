/**
 * 技能清单与正文：GET ?workspace=&preset= 与 ?name=&workspace=&preset=。
 *
 * 两条都是只读投影：条件只影响 provider 的 cwd / scope 选择，不写任何注册表。
 * 本文件只做参数校验与序列化；读取逻辑见 `host/surface-skills.js`。
 * @module dsh-plugin-console/host/routes/surface-skills
 */

import { jsonError, jsonOk, searchParam } from '../http.js'
import { readSurfaceSkillContent, readSurfaceSkills } from '../surface-skills.js'

/** 工作区路径上限：这是路径，不是请求体。 */
const MAX_PATH = 1000

/** 技能名上限；注册表只接受短标识。 */
const MAX_NAME = 200

/**
 * 读一个可选字符串条件并校验长度。
 * @param {Request} request - 请求。
 * @param {string} name - 参数名。
 * @param {number} max - 长度上限。
 * @returns {{value?: string, error?: string}} 条件。
 */
function condition(request, name, max) {
  const raw = searchParam(request, name)
  if (raw === undefined || raw.length === 0) return {}
  if (raw.length > max) return { error: `${name} 超过 ${max} 个字符` }
  return { value: raw }
}

/**
 * 技能清单。
 * @param {object} ctx - host 插件上下文。
 * @returns {Function} fetch 处理函数。
 */
export function createSurfaceSkillsRoute(ctx) {
  return async (request) => {
    const workspace = condition(request, 'workspace', MAX_PATH)
    if (workspace.error !== undefined) return jsonError(400, workspace.error)
    const preset = condition(request, 'preset', MAX_NAME)
    if (preset.error !== undefined) return jsonError(400, preset.error)
    return jsonOk(await readSurfaceSkills(ctx, {
      workspacePath: workspace.value,
      presetId: preset.value,
    }))
  }
}

/**
 * 技能正文（按需读取）。
 * @param {object} ctx - host 插件上下文。
 * @returns {Function} fetch 处理函数。
 */
export function createSurfaceSkillContentRoute(ctx) {
  return async (request) => {
    const name = condition(request, 'name', MAX_NAME)
    if (name.value === undefined) return jsonError(400, 'missing name')
    if (name.error !== undefined) return jsonError(400, name.error)
    const workspace = condition(request, 'workspace', MAX_PATH)
    if (workspace.error !== undefined) return jsonError(400, workspace.error)
    const preset = condition(request, 'preset', MAX_NAME)
    if (preset.error !== undefined) return jsonError(400, preset.error)
    return jsonOk(await readSurfaceSkillContent(ctx, {
      name: name.value,
      workspacePath: workspace.value,
      presetId: preset.value,
    }))
  }
}
