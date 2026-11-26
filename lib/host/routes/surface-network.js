/**
 * 网络能力与连接：GET /api/plugin-console/network。
 *
 * 只读：不探测、不连接、不执行，只投影当前注册表与声明。单项服务缺席或失败
 * 由 `surface-network.js` 降级成带原因的分组，路由永远返回 200。
 * @module dsh-plugin-console/host/routes/surface-network
 */

import { jsonOk } from '../http.js'
import { readSurfaceNetwork } from '../surface-network.js'

/**
 * @param {object} ctx - host 插件上下文。
 * @returns {Function} fetch 处理函数。
 */
export function createSurfaceNetworkRoute(ctx) {
  return async () => jsonOk(await readSurfaceNetwork(ctx))
}
