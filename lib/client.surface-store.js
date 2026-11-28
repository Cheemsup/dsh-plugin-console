/**
 * 能力面的条件与请求状态：工作区 + 模式，命令段另加一个该工作区内的会话。
 *
 * 与 `client.preview-store.js` 分开：预演的三个条件会互相触发整页重算，
 * 能力面只按当前段懒取一份清单，失败也只影响这一页。工作区默认取最近活跃的，
 * 与预演页一致；条件栏直接显示 roster 的默认模式，请求仍可省略 preset——
 * 宿主按同一规则（isDefault，否则第一条）解析，两边指向同一个模式。
 *
 * 命令段的三层优先级：会话 > 模式 > 部署默认。选中会话时模式只显示该会话的
 * 预设（活会话取运行时值，未运行的会话取 header），请求里的 preset 也换成它；
 * 会话已结束时宿主只能按预设 scope 回退，结果里带 `sessionState` 说明。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.surface-store.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.surface-store.js',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    return function create(deps) {
      const { fetchJson, SKILLS_ROUTE, SKILL_CONTENT_ROUTE, COMMANDS_ROUTE, NETWORK_ROUTE } = deps.shared

      /**
       * 按 owner 聚合技能与命令的数量。
       *
       * 插件行的读数只需要数量，不把整份目录塞进页面状态。命令只数运行时目录
       * 与源码扫描补出的名字，不数 user-invocable skill 入口：那些由技能段覆盖，
       * 再数一次会让同一个技能在「技能」和「命令」两个读数里重复。
       * @param {object} skills - `SKILLS_ROUTE` 的响应。
       * @param {object} commands - `COMMANDS_ROUTE` 的响应。
       * @returns {{skills: object, commands: object}} owner → 数量。
       */
      function ownerCountsOf(skills, commands) {
        const countRows = (rows) => {
          // 无原型：owner 是 Loader 行 id，不能因为叫 `constructor` / `__proto__`
          // 就读到 Object 上的同名属性。
          const counts = Object.create(null)
          for (const row of rows) {
            for (const owner of Array.isArray(row?.owners) ? row.owners : []) {
              if (typeof owner !== 'string' || owner.length === 0) continue
              counts[owner] = (counts[owner] ?? 0) + 1
            }
          }
          return counts
        }
        return {
          skills: countRows(Array.isArray(skills?.skills) ? skills.skills : []),
          commands: countRows([
            ...(Array.isArray(commands?.commands) ? commands.commands : []),
            ...(Array.isArray(commands?.scanOnly) ? commands.scanOnly : []),
          ]),
        }
      }

      /** 查询串后缀；空条件不拼问号。手工拼是为了在最小自检上下文里也能跑。 */
      function querySuffix(params) {
        const parts = Object.keys(params)
          .filter((key) => typeof params[key] === 'string' && params[key].length > 0)
          .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(params[key]))
        return parts.length > 0 ? '?' + parts.join('&') : ''
      }

      /**
       * @param {object} options - 视图条件。
       * @param {object[]} options.workspaces - 快照里的工作区（含各自的会话），已按最近活跃排序。
       * @param {boolean} options.active - 当前是否停在插件能力面标签。
       * @param {object[]} [options.ungroupedSessions] - 未归属任何工作区的会话。
       * @returns {object} 条件、按段状态与动作。
       */
      function useSurfaceStore({ workspaces, active, ungroupedSessions }) {
        const [segment, setSegment] = useState('tools')
        const [preset, setPreset] = useState(null)
        // undefined = 还没选过（默认取最近活跃的工作区）；null 是「显式清空」。
        const [workspace, setWorkspace] = useState(undefined)
        const workspacePath = workspace === undefined ? (workspaces?.[0]?.path ?? null) : workspace
        const defaultWorkspacePath = workspaces?.[0]?.path ?? null
        const [skills, setSkills] = useState({ status: 'idle', data: null, error: null })
        // undefined = 还没选过（默认取该工作区里第一个活会话）；null = 显式「不指定会话」。
        const [session, setSession] = useState(undefined)
        // 会话只能在选中的工作区里挑：命令目录按 Agent 的 scope 链 + cwd 读，
        // 跨工作区的会话在这里既不属于这份 cwd，也没有对应的项目技能。
        // 未归属工作区的会话没有自己的分组可挑，兜底并进默认工作区，并由视图标「未归属」。
        const workspaceSessions = useMemo(() => {
          const owned = (workspaces ?? []).find((entry) => entry.path === workspacePath)?.sessions ?? []
          const ungrouped = workspacePath === defaultWorkspacePath
            ? (ungroupedSessions ?? []).map((row) => ({ ...row, ungrouped: true }))
            : []
          return [...owned, ...ungrouped].sort((left, right) => (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0))
        }, [workspaces, ungroupedSessions, workspacePath, defaultWorkspacePath])
        const autoSession = workspaceSessions.find((row) => row.live === true)?.id ?? null
        const sessionId = session === undefined
          ? autoSession
          : (session !== null && workspaceSessions.some((row) => row.id === session) ? session : null)
        const sessionRow = sessionId === null ? undefined : workspaceSessions.find((row) => row.id === sessionId)
        // 选中会话时模式由会话决定：活会话取运行时预设，未运行的会话取 header 记录的预设。
        const sessionPreset = sessionRow === undefined
          ? null
          : (sessionRow.runtime?.preset ?? sessionRow.preset ?? null)
        // 宿主只在没有活会话时读 preset：冷会话与无会话都按这条回退。
        const effectivePreset = sessionId === null ? preset : sessionPreset
        const [commands, setCommands] = useState({ status: 'idle', data: null, error: null })
        const [network, setNetwork] = useState({ status: 'idle', data: null, error: null })
        // 插件页行读数用的 owner 计数：只按当前条件取技能 + 命令两份目录，聚合后
        // 不保留条目本身。条件变化时按 key 重取，避免行的数字与能力面条件脱节。
        const [summary, setSummary] = useState({ status: 'idle', counts: null, error: null })
        const summaryTicket = useRef(0)
        const summaryKey = [workspacePath ?? '', preset ?? '', sessionId ?? '', effectivePreset ?? ''].join('\u0000')
        const summaryKeyRef = useRef(null)
        // 统一插件条件：null = 全部插件；选择只影响视图，不重新读路由。
        // 可输入选择器的展开态、检索词与键盘游标；与 disable-preview 同一套交互。
        const [ownerPickerQuery, setOwnerPickerQuery] = useState('')
        const [ownerPickerOpen, setOwnerPickerOpen] = useState(false)
        const [ownerPickerIndex, setOwnerPickerIndex] = useState(-1)
        const [contents, setContents] = useState({})
        // 每条技能正文各自的检索：`{ [name]: { open, text, cursor } }`。
        // 与页面级页内检索分开——技能正文的检索只覆盖这一条正文。
        const [skillSearches, setSkillSearches] = useState({})
        const [focusName, setFocusName] = useState(null)
        // 从插件页跳进来时按插件收窄：技能 / 命令 / 工具 / 注入 / 网络五段共用这一份。
        // owner 是 Loader 行 id，与能力面的 owners 同口径；'__none' 表示未归属。
        const [focusOwner, setFocusOwner] = useState(null)
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

        /**
         * 读当前条件下的斜杠命令目录。
         *
         * 条件只有会话、模式与工作区：工作区既筛会话，也是会话已结束（或没选会话）
         * 时技能入口的 cwd；活会话的 cwd 由会话自己带，工作区不参与。
         */
        const loadCommands = useCallback(async () => {
          const mine = ++ticket.current
          setCommands({ status: 'loading', data: null, error: null })
          try {
            const query = new URLSearchParams()
            if (typeof sessionId === 'string' && sessionId.length > 0) query.set('session', sessionId)
            if (typeof effectivePreset === 'string' && effectivePreset.length > 0) query.set('preset', effectivePreset)
            if (typeof workspacePath === 'string' && workspacePath.length > 0) query.set('workspace', workspacePath)
            const suffix = query.toString()
            const data = await fetchJson(COMMANDS_ROUTE + (suffix.length > 0 ? '?' + suffix : ''))
            if (mine !== ticket.current) return
            setCommands({ status: 'ready', data, error: null })
          } catch (error) {
            if (mine !== ticket.current) return
            setCommands({ status: 'error', data: null, error: error instanceof Error ? error.message : String(error) })
          }
        }, [fetchJson, sessionId, effectivePreset, workspacePath])

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

        /**
         * 读一份「owner → 技能 / 命令数量」摘要，供插件页行读数使用。
         *
         * 只在插件页需要时调用；同一组条件只取一次（key 相同直接返回）。失败会
         * 清掉 key，下一次进入插件页或快照刷新时重试；行读数在此期间退回源码数量。
         */
        const loadSummary = useCallback(async () => {
          const key = summaryKey
          if (summaryKeyRef.current === key) return
          summaryKeyRef.current = key
          const mine = ++summaryTicket.current
          setSummary({ status: 'loading', counts: null, error: null })
          try {
            const [skillData, commandData] = await Promise.all([
              fetchJson(SKILLS_ROUTE + querySuffix({ workspace: workspacePath, preset })),
              fetchJson(COMMANDS_ROUTE + querySuffix({
                session: sessionId,
                preset: effectivePreset,
                workspace: workspacePath,
              })),
            ])
            // 条件在请求途中变了就丢掉这份结果，别让行读数显示另一组条件的数字。
            if (mine !== summaryTicket.current || summaryKeyRef.current !== key) return
            setSummary({ status: 'ready', counts: ownerCountsOf(skillData, commandData), error: null })
          } catch (error) {
            if (mine !== summaryTicket.current || summaryKeyRef.current !== key) return
            // 允许下一次插件页进入 / 快照刷新时重试；行读数在此期间退回源码数量。
            summaryKeyRef.current = null
            setSummary({ status: 'error', counts: null, error: error instanceof Error ? error.message : String(error) })
          }
        }, [summaryKey, fetchJson, workspacePath, preset, sessionId, effectivePreset])

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
          // 换工作区后旧的会话选择不再属于这份目录：回到「默认取该工作区的活会话」。
          setSession(undefined)
        }, [])

        const choosePreset = useCallback((id) => {
          setPreset(typeof id === 'string' && id.length > 0 ? id : null)
        }, [])

        /**
         * 归属 id 归一：空串 → null，去掉 include: 前缀，'__none' 保留。
         *
         * 快照的 entryId 带 `include:` 前缀，宿主的 owners 不带；同一条目被两种
         * id 引用时都要命中。'__none' 是「未归属」的筛选值，不是一个真实行 id。
         * @param {unknown} value - 选择器或跳转给出的值。
         * @returns {string | null} 归一后的 owner。
         */
        function normalizeOwner(value) {
          if (typeof value !== 'string') return null
          const trimmed = value.trim()
          if (trimmed === '') return null
          if (trimmed === '__none') return '__none'
          return trimmed.replace(/^include:/, '')
        }

        /** 选一个插件；空串回到「全部插件」。选择器随即关闭。 */
        const chooseFocusOwner = useCallback((rowId) => {
          setFocusOwner(normalizeOwner(rowId))
          setOwnerPickerOpen(false)
          setOwnerPickerQuery('')
          setOwnerPickerIndex(-1)
        }, [])

        /**
         * 切段时只清名字聚焦、保留插件条件。
         *
         * owner 是跨段共同的收窄条件（「这个插件贡献了什么」），留着才能连续看五段；
         * name 是段内名字（工具名、段名），带到别的段只会把清单滤成空。
         */
        const chooseSegment = useCallback((id) => {
          setSegment(id)
          setFocusName(null)
          setOwnerPickerOpen(false)
          setOwnerPickerQuery('')
          setOwnerPickerIndex(-1)
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

        /**
         * 按插件收窄技能 / 命令两段。
         *
         * `name` 只在从插件详情点具体条目时带上，方便把那一行留在视野里；
         * 两段共用同一份 owner + name 条件，切段时不必重新说明来源。
         * @param {string | null} rowId - Loader 行 id；null 表示取消。
         * @param {string} [name] - 可选的条目名。
         */
        const focusOwnerOf = useCallback((rowId, name) => {
          setFocusOwner(normalizeOwner(rowId))
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

        const clearFocus = useCallback(() => {
          setFocusName(null)
          setFocusOwner(null)
        }, [])

        const chooseSession = useCallback((id) => {
          if (typeof id !== 'string' || id.length === 0) {
            setSession(null)
            return
          }
          // 从会话页跳进来时，工作区要跟着会话走：会话清单本身按工作区筛，
          // 不切工作区的话这次选择会被当成「不在当前工作区」而丢掉。
          // 未归属的会话没有自己的分组，回到默认工作区（它们只在那一档里出现）。
          const owner = (workspaces ?? []).find((entry) => (entry.sessions ?? []).some((row) => row.id === id))
          if (owner !== undefined && typeof owner.path === 'string' && owner.path.length > 0) {
            setWorkspace(owner.path)
          } else if ((ungroupedSessions ?? []).some((row) => row.id === id) && defaultWorkspacePath !== null) {
            setWorkspace(defaultWorkspacePath)
          }
          setSession(id)
        }, [workspaces, ungroupedSessions, defaultWorkspacePath])

        return {
          segment,
          setSegment: chooseSegment,
          workspacePath,
          setWorkspace: chooseWorkspace,
          presetId: preset,
          setPreset: choosePreset,
          commands,
          loadCommands,
          network,
          loadNetwork,
          setFocusOwner: chooseFocusOwner,
          ownerPicker: {
            query: ownerPickerQuery,
            open: ownerPickerOpen,
            index: ownerPickerIndex,
            setQuery: setOwnerPickerQuery,
            setOpen: setOwnerPickerOpen,
            setIndex: setOwnerPickerIndex,
          },
          sessions: workspaceSessions,
          sessionId,
          sessionPreset,
          setSession: chooseSession,
          skills,
          loadSkills,
          summary,
          loadSummary,
          skillContents: contents,
          loadSkillContent,
          skillSearches,
          toggleSkillSearch,
          setSkillSearchText,
          setSkillSearchCursor,
          focusName,
          focusOwner,
          focusOwnerOf,
          clearFocus,
        }
      }

      return { useSurfaceStore }
    }
  },
})
