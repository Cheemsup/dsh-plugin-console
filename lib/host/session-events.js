/**
 * 读取一个会话的事件：活会话走内存，冷会话走持久化。
 *
 * 会话影响与活动聚合都要同一份事实，所以把「从哪个入口读、怎么关句柄」
 * 收在一处，避免两套读法在错误处理上分叉。
 * @module dsh-plugin-console/host/session-events
 */

/**
 * @param {object} ctx - host 插件上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<{events: Array<object>, header: object | undefined, source: string, agent?: object} | undefined>} 事件与 header。
 */
export async function readSessionEvents(ctx, sessionId) {
  const agent = ctx.get('agents')?.get?.(sessionId)
  if (agent?.session?.snapshotEvents !== undefined) {
    return {
      events: agent.session.snapshotEvents(),
      header: agent.session.header,
      source: 'live',
      agent,
    }
  }

  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined || typeof persistence.open !== 'function') return undefined
  const handle = await persistence.open(sessionId, 'read')
  try {
    const read = await handle.read()
    const events = Array.isArray(read?.events) ? read.events : []
    return {
      events,
      header: events.find((event) => event?.type === 'session'),
      source: 'log',
    }
  } finally {
    if (typeof handle.close === 'function') await handle.close()
  }
}
