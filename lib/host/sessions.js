/**
 * 会话、工作区与派发树。
 *
 * 会话的模式来自持久化 header（冷会话不必打开正文）；工作区本身不记录模式，
 * 它只记录成员会话。活会话额外带 runtime——那是本进程里真实挂载的组合。
 * @module dsh-plugin-console/host/sessions
 */

import { listDir, readTextFile, statFile } from './fs.js'
import { readRuntimeComposition } from './modes.js'

/**
 * 从会话 header 的派发字段构建父子树。
 *
 * `parentSession` 指向父会话 id。父会话可能不在当前列表里（已被清理、或属于
 * 另一个 profile），这种节点升级为根并标记 `orphan`，不静默丢弃。
 * `depth` 以实际父子链重算，而不是直接采信 `delegationDepth`：父会话消失后
 * 记录值仍是 1，但在这棵树里它就是根。
 * @param {Array<object>} sessions - 会话列表（含 parentSession / origin / delegationDepth）。
 * @returns {{roots: Array<object>, nodes: Array<object>, orphanCount: number, childCount: number}} 树。
 */
export function buildDispatchTree(sessions) {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const childrenOf = new Map()

  for (const session of sessions) {
    const parentId = session.parentSession
    if (typeof parentId !== 'string' || !byId.has(parentId)) continue
    const list = childrenOf.get(parentId) ?? []
    list.push(session.id)
    childrenOf.set(parentId, list)
  }

  /** 递归构建一个节点及其子树。 */
  const build = (id, depth, seen) => {
    const session = byId.get(id)
    // 防御环：header 写入时不做环检测，读取方必须自己挡
    if (session === undefined || seen.has(id)) return null
    const nextSeen = new Set(seen)
    nextSeen.add(id)
    const children = (childrenOf.get(id) ?? [])
      .map((childId) => build(childId, depth + 1, nextSeen))
      .filter((node) => node !== null)
    return {
      id,
      title: session.title,
      preset: session.preset,
      cwd: session.cwd,
      createdAt: session.createdAt,
      live: session.live === true,
      origin: session.origin,
      recordedDepth: session.delegationDepth,
      depth,
      childCount: children.length,
      orphan: typeof session.parentSession === 'string' && !byId.has(session.parentSession),
      parentId: typeof session.parentSession === 'string' ? session.parentSession : undefined,
      children,
    }
  }

  const roots = []
  for (const session of sessions) {
    const parentId = session.parentSession
    if (typeof parentId === 'string' && byId.has(parentId)) continue
    const node = build(session.id, 0, new Set())
    if (node !== null) roots.push(node)
  }

  /** 摊平所有节点，便于前端按 id 查找。 */
  const flatten = (node, out) => {
    out.push(node)
    for (const child of node.children) flatten(child, out)
    return out
  }
  const nodes = []
  for (const root of roots) flatten(root, nodes)

  return {
    roots,
    nodes,
    orphanCount: nodes.filter((node) => node.orphan).length,
    childCount: nodes.filter((node) => node.parentId !== undefined).length,
  }
}

/**
 * 读取一批会话的标题。
 *
 * 两条路，按可靠性排序：
 * 1. `sessionProjections`：对活会话直接读已折叠的 `title` 投影（无需打开日志）；
 * 2. 投影缓存文件：冷会话的投影被 checkpoint 到 `<home>/storages/session_projcache`，
 *    结构是 `{ version, record: { rows: { title: { val } } } }`。
 *
 * 拿不到就返回 undefined，由前端退回会话 id——不编造标题。
 * @param {object} ctx - host 插件上下文。
 * @param {Array<string>} sessionIds - 会话 id 列表。
 * @param {object} profile - profile 信息（提供 home 路径）。
 * @returns {Promise<Map<string, string>>} 会话 id → 标题。
 */
export async function readSessionTitles(ctx, sessionIds, profile) {
  const titles = new Map()
  if (sessionIds.length === 0) return titles

  const projections = ctx.get('sessionProjections')
  const sessions = ctx.get('sessions')
  if (projections !== undefined && sessions !== undefined && typeof projections.stateOf === 'function') {
    for (const id of sessionIds) {
      try {
        const session = sessions.get?.(id)
        if (session === undefined) continue
        const title = projections.stateOf(session, 'title')
        if (typeof title === 'string' && title.length > 0) titles.set(id, title)
      } catch {
        // 单个会话读失败不影响其它会话
      }
    }
  }

  const missing = sessionIds.filter((id) => !titles.has(id))
  if (missing.length === 0) return titles

  const home = typeof profile?.home === 'string' ? profile.home : undefined
  if (home === undefined) return titles

  const dir = `${home}/storages/session_projcache/sessions`
  const files = await listDir(dir)
  if (files.length === 0) return titles
  const wanted = new Set(missing)
  for (const file of files) {
    const id = file.replace(/\.json$/, '')
    if (!wanted.has(id)) continue
    const text = await readTextFile(`${dir}/${file}`)
    if (text === null) continue
    try {
      const parsed = JSON.parse(text)
      const value = parsed?.record?.rows?.title?.val
      if (typeof value === 'string' && value.length > 0) titles.set(id, value)
    } catch {
      // 缓存文件损坏时跳过
    }
  }
  return titles
}

/**
 * 读取工作区与会话，并把每个会话归属到它的工作区。
 *
 * 会话的 `agentPreset` 来自持久化 header（冷会话不必打开正文），
 * 工作区只记录成员，本身不携带模式。
 * @param {object} ctx - host 插件上下文。
 * @param {object} profile - profile 信息（提供 home 路径）。
 * @returns {Promise<object>} 工作区列表与压平后的会话列表。
 */
export async function readSessions(ctx, profile) {
  /** @type {Map<string, object>} */
  const sessionMap = new Map()
  /** 会话日志文件路径：只有它能给出「最近活跃」所需的写入时间。 */
  const logPaths = new Map()

  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined && typeof persistence.list === 'function') {
    try {
      for (const snapshot of await persistence.list()) {
        const header = snapshot?.header
        if (!header || typeof header.id !== 'string') continue
        const logPath = snapshot?.location?.path
        if (typeof logPath === 'string') logPaths.set(header.id, logPath)
        // 派发关系来自 header：origin 标记子 Agent，parentSession 指回父会话。
        sessionMap.set(header.id, {
          id: header.id,
          cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
          preset: typeof header.agentPreset === 'string' ? header.agentPreset : null,
          createdAt: typeof header.createdAt === 'number' ? header.createdAt : undefined,
          sizeBytes: typeof snapshot.sizeBytes === 'number' ? snapshot.sizeBytes : undefined,
          parentSession: typeof header.parentSession === 'string' ? header.parentSession : undefined,
          origin: header.origin === 'subagent' ? 'subagent' : undefined,
          delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : undefined,
          isSeeded: header.isSeeded === true ? true : undefined,
        })
      }
    } catch {
      // 读取失败时保留 live 会话（下面补），不让整个快照失败
    }
  }

  // 本轮进程里活着的会话一定存在磁盘上的 header 之外——补上没被 list() 覆盖的。
  const sessions = ctx.get('sessions')
  if (sessions !== undefined && typeof sessions.list === 'function') {
    for (const session of sessions.list()) {
      const known = sessionMap.get(session.id)
      if (known !== undefined) {
        known.live = true
        continue
      }
      let preset
      try {
        preset = ctx.get('agentPresets')?.presetForSession?.(session) ?? undefined
      } catch {
        preset = undefined
      }
      sessionMap.set(session.id, { id: session.id, preset: preset ?? null, live: true })
    }
  }

  // 运行时常驻：给每个活会话补上它此刻真正加载的插件集合
  const agents = ctx.get('agents')
  if (agents !== undefined && typeof agents.get === 'function') {
    for (const [sessionId, record] of sessionMap) {
      if (record.live !== true) continue
      let agent
      try {
        agent = agents.get(sessionId)
      } catch {
        agent = undefined
      }
      if (agent === undefined) continue
      record.runtime = readRuntimeComposition(ctx, agent) ?? null
    }
  }

  // 最近活跃时间来自会话日志文件的修改时间；读不到时退回 createdAt。
  // 活会话即使日志暂时没变也不算「从未活跃」，所以两者取较晚的一个。
  const mtimes = new Map()
  await Promise.all([...logPaths].map(async ([id, file]) => {
    const info = await statFile(file)
    if (info !== null) mtimes.set(id, info.mtimeMs)
  }))
  for (const [id, session] of sessionMap) {
    const stamp = Math.max(mtimes.get(id) ?? 0, typeof session.createdAt === 'number' ? session.createdAt : 0)
    session.lastActiveAt = stamp > 0 ? stamp : (session.live === true ? Date.now() : undefined)
  }

  const workspaces = []
  const claimed = new Set()
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined && typeof registry.list === 'function') {
    for (const workspace of registry.list()) {
      const ids = workspace.sessionIds ?? []
      for (const id of ids) claimed.add(id)
      workspaces.push({
        id: workspace.id,
        path: workspace.path,
        title: workspace.title,
        sessions: ids.map((id) => sessionMap.get(id) ?? { id, preset: null }),
      })
    }
  }

  // 不属于任何工作区的会话仍要能查到模式
  const ungrouped = [...sessionMap.values()].filter((session) => !claimed.has(session.id))

  // 标题：DSH 侧边栏显示的是它，不是 session id。拿不到就留空，前端退回 id。
  const titles = await readSessionTitles(ctx, [...sessionMap.keys()], profile)
  for (const [id, title] of titles) {
    const session = sessionMap.get(id)
    if (session !== undefined) session.title = title
  }
  // workspaces / ungrouped 里的对象可能就是 sessionMap 里的同一批对象，
  // 但缺省的占位对象（{ id, preset: null }）需要单独补。
  for (const list of [...workspaces.map((workspace) => workspace.sessions), ungrouped]) {
    for (const session of list) {
      const title = titles.get(session.id)
      if (title !== undefined && session.title === undefined) session.title = title
    }
  }

  // 工作区的最近活跃 = 成员会话里最晚的一次（含派生子会话）。
  for (const workspace of workspaces) {
    workspace.lastActiveAt = latestActiveAt(workspace.sessions)
  }

  // 派发树最后构建：节点会带上 title / live 的快照，
  // 因此必须等这些字段都写完了再建。
  const dispatch = buildDispatchTree([...sessionMap.values()])

  return {
    workspaces,
    ungrouped,
    ungroupedLastActiveAt: latestActiveAt(ungrouped),
    sessions: [...sessionMap.values()],
    dispatch,
  }
}

/** 一组会话里最晚的活跃时间；没有可用时间时 undefined。 */
function latestActiveAt(sessions) {
  let latest
  for (const session of sessions) {
    if (typeof session?.lastActiveAt !== 'number') continue
    if (latest === undefined || session.lastActiveAt > latest) latest = session.lastActiveAt
  }
  return latest
}
