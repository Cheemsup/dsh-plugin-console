/**
 * 注册点源码片段：POST `{ moduleName, kind, name }` → 包内注册点附近的一小段源码。
 *
 * 这是只读诊断，不是资源枚举：客户端不能传路径，服务端按模块名解析包目录，
 * 再校验文件落在包目录内。本文件只做参数校验与序列化，读取逻辑见
 * `host/registration-site.js`。
 * @module dsh-plugin-console/host/routes/registration-site
 */

import { jsonError, jsonOk, readJsonBody } from '../http.js'
import { readRegistrationSnippet } from '../registration-site.js'

/** 模块名 / 名字的长度上限：注册名是代码里的短标识，不需要任意长字符串。 */
const MAX_MODULE_LENGTH = 300
const MAX_NAME_LENGTH = 500

/** 允许的种类；与源码扫描的 prompt 三类一致。 */
const KINDS = new Set(['section', 'context', 'variable'])

/** 片段模式：注册点短窗口（默认）或完整文件。 */
const MODES = new Set(['focus', 'file'])

/**
 * @param {object} ctx - host 插件上下文。
 * @returns {Function} fetch 处理函数。
 */
export function createRegistrationSiteRoute(ctx) {
  return async (request) => {
    const body = await readJsonBody(request)
    const moduleName = body?.moduleName
    const kind = body?.kind
    const name = body?.name
    const mode = body?.mode ?? 'focus'
    if (typeof moduleName !== 'string' || moduleName.length === 0 || moduleName.length > MAX_MODULE_LENGTH) {
      return jsonError(400, 'moduleName 不合法')
    }
    // 模块名允许 scope 斜杠，但不允许路径穿越。
    if (moduleName.includes('..')) return jsonError(400, 'moduleName 不合法')
    if (typeof kind !== 'string' || !KINDS.has(kind)) return jsonError(400, 'kind 不合法')
    if (typeof mode !== 'string' || !MODES.has(mode)) return jsonError(400, 'mode 不合法')
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
      return jsonError(400, 'name 不合法')
    }
    try {
      return jsonOk(await readRegistrationSnippet(ctx, { moduleName, kind, name, mode }))
    } catch (error) {
      // 片段是补充证据，读不到不该让详情页报错；把原因交给前端显示。
      return jsonOk({ found: false, reason: error instanceof Error ? error.message : String(error) })
    }
  }
}
