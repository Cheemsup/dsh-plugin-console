/**
 * 能力面的条件与请求状态：工作区 + 模式，以及按段懒取的结果。
 *
 * 与 `client.preview-store.js` 分开：预演的三个条件会互相触发整页重算，
 * 能力面只按当前段懒取一份清单，失败也只影响这一页。工作区默认取最近活跃的，
 * 与预演页一致；模式留空表示部署默认模式，由宿主 `agentPresets` 解析。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.surface-store.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.surface-store.js',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    return function create(deps) {
      const { fetchJson, SKILLS_ROUTE, SKILL_CONTENT_ROUTE, COMMANDS_ROUTE, NETWORK_ROUTE } = deps.shared

      /**
       * @param {object} options - 视图条件。
       * @param {object[]} options.workspaces - 快照里的工作区，已按最近活跃排序。
       * @param {boolean} options.active - 当前是否停在能力面标签。
       * @param {object[]} [options.liveSessions] - 活会话（`{ id, preset }`），命令段的候选。
       * @returns {object} 条件、按段状态与动作。
       */
      function useSurfaceStore({ workspaces, active, liveSessions = [] }) {
        const [segment, setSegment] = useState('skills')
        const [preset, setPreset] = useState(null)
        // undefined = 还没选过（默认取最近活跃的工作区）；null 是「显式清空」。
        const [workspace, setWorkspace] = useState(undefined)
        const workspacePath = workspace === undefined ? (workspaces?.[0]?.path ?? null) : workspace
        const [skills, setSkills] = useState({ status: 'idle', data: null, error: null })
        // undefined = 还没选过（默认第一个活会话）；null = 显式「不指定会话」。
        const [session, setSession] = useState(undefined)
        const sessionId = session === undefined ? (liveSessions?.[0]?.id ?? null) : session
        const [commands, setCommands] = useState({ status: 'idle', data: null, error: null })
        const [network, setNetwork] = useState({ status: 'idle', data: null, error: null })
        const [contents, setContents] = useState({})
        // 每条技能正文各自的检索：`{ [name]: { open, text, cursor } }`。
        // 与页面级页内检索分开——技能正文的检索只覆盖这一条正文。
        const [skillSearches, setSkillSearches] = useState({})
        const [focusName, setFocusName] = useState(null)
        // 条件变化可能连发几次请求；只认最后一次的响应。
        const ticket = useRef(0)
        // 每个名字各自的正文请求序号；展开两条技能不会互相覆盖。
        const contentTickets = useRef(new Map())

        /** 读当前条件下的技能清单；条件变化由下面的 effect 触发。 */
        const loadSkills = useCallback(async (overrides = {}) => {
          const path = overrides.workspacePath !== undefined ? overrides.workspacePath : workspacePath
          const presetId = overrides.presetId !== undefined ? overrides.presetId : preset
          const mine = ++ticket.current
          setSkills({ status: 'loading', data: null, error: null })
          try {
            const query = new URLSearchParams()
            if (typeof path === 'string' && path.length > 0) query.set('workspace', path)
            if (typeof presetId === 'string' && presetId.length > 0) query.set('preset', presetId)
            const suffix = query.toString()
            const data = await fetchJson(SKILLS_ROUTE + (suffix.length > 0 ? '?' + suffix : ''))
            if (mine !== ticket.current) return
            setSkills({ status: 'ready', data, error: null })
          } catch (error) {
            if (mine !== ticket.current) return
            setSkills({ status: 'error', data: null, error: error instanceof Error ? error.message : String(error) })
          }
        }, [fetchJson, workspacePath, preset])

        /** 读当前条件下的斜杠命令目录；会话为空时按模式 scope 只读回退。 */
        const loadCommands = useCallback(async () => {
          const mine = ++ticket.current
          setCommands({ status: 'loading', data: null, error: null })
          try {
            const query = new URLSearchParams()
            if (typeof sessionId === 'string' && sessionId.length > 0) query.set('session', sessionId)
            if (typeof preset === 'string' && preset.length > 0) query.set('preset', preset)
            if (typeof workspacePath === 'string' && workspacePath.length > 0) query.set('workspace', workspacePath)
            const suffix = query.toString()
            const data = await fetchJson(COMMANDS_ROUTE + (suffix.length > 0 ? '?' + suffix : ''))
            if (mine !== ticket.current) return
            setCommands({ status: 'ready', data, error: null })
          } catch (error) {
            if (mine !== ticket.current) return
            setCommands({ status: 'error', data: null, error: error instanceof Error ? error.message : String(error) })
          }
        }, [fetchJson, sessionId, preset, workspacePath])

        /** 读网络能力与连接；三项事实互不依赖，路由一次返回。 */
        const loadNetwork = useCallback(async () => {
          const mine = ++ticket.current
          setNetwork({ status: 'loading', data: null, error: null })
          try {
            const data = await fetchJson(NETWORK_ROUTE)
            if (mine !== ticket.current) return
            setNetwork({ status: 'ready', data, error: null })
          } catch (error) {
            if (mine !== ticket.current) return
            setNetwork({ status: 'error', data: null, error: error instanceof Error ? error.message : String(error) })
          }
        }, [fetchJson])

        // 条件变了，旧正文属于旧目录；清掉避免展开时张冠李戴。检索词同理。
        useEffect(() => {
          setContents({})
          setSkillSearches({})
        }, [workspacePath, preset])

        // 进入能力面或换条件即重读；`active` 为假时不发请求。
        useEffect(() => {
          if (!active) return
          if (segment === 'skills') void loadSkills()
          else if (segment === 'commands') void loadCommands()
          else if (segment === 'network') void loadNetwork()
        }, [active, segment, loadSkills, loadCommands, loadNetwork])

        const chooseWorkspace = useCallback((path) => {
          setWorkspace(typeof path === 'string' && path.length > 0 ? path : null)
        }, [])

        const choosePreset = useCallback((id) => {
          setPreset(typeof id === 'string' && id.length > 0 ? id : null)
        }, [])

        /** 按需读一条技能的正文；正文永远属于当前条件。 */
        const loadSkillContent = useCallback(async (name) => {
          const mine = (contentTickets.current.get(name) ?? 0) + 1
          contentTickets.current.set(name, mine)
          setContents((current) => ({ ...current, [name]: { status: 'loading' } }))
          try {
            const query = new URLSearchParams({ name })
            if (typeof workspacePath === 'string' && workspacePath.length > 0) query.set('workspace', workspacePath)
            if (typeof preset === 'string' && preset.length > 0) query.set('preset', preset)
            const data = await fetchJson(SKILL_CONTENT_ROUTE + '?' + query.toString())
            if (contentTickets.current.get(name) !== mine) return
            setContents((current) => ({
              ...current,
              [name]: data?.found === true
                ? { status: 'ready', data }
                : { status: 'empty', reason: typeof data?.reason === 'string' ? data.reason : '没有找到正文' },
            }))
          } catch (error) {
            if (contentTickets.current.get(name) !== mine) return
            setContents((current) => ({
              ...current,
              [name]: { status: 'error', reason: error instanceof Error ? error.message : String(error) },
            }))
          }
        }, [fetchJson, workspacePath, preset])

        const focusSkill = useCallback((name) => {
          setSegment('skills')
          setFocusName(typeof name === 'string' && name.length > 0 ? name : null)
        }, [])

        /** 开关一条技能正文的检索框；重新打开时保留上次的词。 */
        const toggleSkillSearch = useCallback((name) => {
          setSkillSearches((current) => {
            const entry = current[name]
            return {
              ...current,
              [name]: { open: entry?.open !== true, text: typeof entry?.text === 'string' ? entry.text : '', cursor: 0 },
            }
          })
        }, [])

        /** 改检索词：游标回到第 1 处，旧游标对新命中集合没有意义。 */
        const setSkillSearchText = useCallback((name, text) => {
          setSkillSearches((current) => ({
            ...current,
            [name]: { open: true, text: typeof text === 'string' ? text : '', cursor: 0 },
          }))
        }, [])

        /** 定位到第 N 处命中（只存游标，滚动由视图按容器限定）。 */
        const setSkillSearchCursor = useCallback((name, cursor) => {
          setSkillSearches((current) => {
            const entry = current[name]
            if (entry === undefined) return current
            return { ...current, [name]: { ...entry, cursor } }
          })
        }, [])

        const clearFocus = useCallback(() => setFocusName(null), [])

        const chooseSession = useCallback((id) => {
          setSession(typeof id === 'string' && id.length > 0 ? id : null)
        }, [])

        return {
          segment,
          setSegment,
          workspacePath,
          setWorkspace: chooseWorkspace,
          presetId: preset,
          setPreset: choosePreset,
          commands,
          loadCommands,
          network,
          loadNetwork,
          liveSessions,
          sessionId,
          setSession: chooseSession,
          skills,
          loadSkills,
          skillContents: contents,
          loadSkillContent,
          skillSearches,
          toggleSkillSearch,
          setSkillSearchText,
          setSkillSearchCursor,
          focusName,
          focusSkill,
          clearFocus,
        }
      }

      return { useSurfaceStore }
    }
  },
})
