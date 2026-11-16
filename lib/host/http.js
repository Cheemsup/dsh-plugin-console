/**
 * 路由层的公共 HTTP 小工具。
 *
 * 每个路由只做三件事：解析参数 → 调一个服务函数 → 序列化结果。
 * 三件里的第一件和第三件在这里，第二件在各自的模块里。
 * @module dsh-plugin-console/host/http
 */

/** 成功响应：200，JSON，不缓存。 */
export function jsonOk(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** 客户端错误：4xx，带一句可读的原因。 */
export function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * 把一次路由执行包起来：任何抛出都变成 500 + `{error}`。
 *
 * 路由里不写 try/catch 的理由：这段是唯一需要它的地方，重复六遍只会淹没业务。
 * @param {Function} handler - 真正的实现。
 * @returns {Function} fetch 处理函数。
 */
export function jsonRoute(handler) {
  return async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return jsonError(500, message)
    }
  }
}

/**
 * 读 JSON 请求体；空体或坏 JSON 一律当 `{}`。
 * @param {Request} request - 请求。
 * @returns {Promise<any>} 请求体。
 */
export async function readJsonBody(request) {
  const body = await request?.json?.().catch(() => ({}))
  return body ?? {}
}

/**
 * 读 Query 参数。
 * @param {Request} request - 请求。
 * @param {string} name - 参数名。
 * @returns {string | undefined} 参数值。
 */
export function searchParam(request, name) {
  const value = new URL(request.url).searchParams.get(name)
  return typeof value === 'string' ? value : undefined
}
