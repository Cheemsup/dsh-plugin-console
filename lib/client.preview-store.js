/**
 * 首请求预演的请求状态：模式 + 工作区 + 权限预设，以及一次按条件求值。
 *
 * 单独一个 chunk 而不是留在 `client.store.js`：这三个条件只服务预演页，而且条件之间
 * 会互相触发重算（换个工作区就得重跑），状态与重跑逻辑放在一起才不会漂移。
 * 快照、模板两块 store 的失败语义各不相同，也不该被预演条件拖着一起长。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.preview-store.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-console',
  chunk: 'client.preview-store.js',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useRef, useState } = React

    return function create(deps) {
      const { PREVIEW_ROUTE, browserTimeZone } = deps.shared

      /**
       * @param {object[]} workspaces - 快照里的工作区，已按最近活跃排序。
       * @returns {object} 预演状态、条件与动作。
       */
      function usePreviewStore(workspaces) {
        const [preset, setPreset] = useState(null)
        // undefined = 还没选过（默认取最近活跃的工作区）；null 不是合法值，路径总以字符串出现。
        const [workspace, setWorkspace] = useState(undefined)
        const [permission, setPermission] = useState(null)
        const [preview, setPreview] = useState(null)
        const [status, setStatus] = useState('idle')
        const [error, setError] = useState(null)
        const [tab, setTab] = useState('prompt')
        // 首条消息草稿：不进请求就不影响结果，所以只作为条件的一部分。
        const [draft, setDraft] = useState('')
        // 条件变化可能连发几次请求；只认最后一次的响应，否则旧结果会盖掉新条件。
        const ticket = useRef(0)

        /** 没选过就用最近活跃的工作区：新会话默认就落在那里。 */
        const workspacePath = workspace === undefined ? (workspaces?.[0]?.path ?? null) : workspace

        const fetchPreview = useCallback(async (conditions) => {
          const response = await fetch(new URL(PREVIEW_ROUTE, document.baseURI).href, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(conditions),
          })
          const data = await response.json()
          if (!response.ok || data.error !== undefined) throw new Error(data.error ?? `HTTP ${response.status}`)
          return data
        }, [])

        /**
         * @param {string | null} presetId - 目标模式；null 表示宿主默认模式。
         * @param {object} [overrides] - 本次请求要覆盖的条件（换工作区时用）。
         * @returns {Promise<void>} 结果写进 state。
         */
        const runPreview = useCallback(async (presetId, overrides = {}) => {
          const draftText = overrides.draft ?? draft
          const conditions = {
            presetId: presetId ?? undefined,
            // `undefined` 表示沿用当前条件；空串是「清掉工作区」这个显式选择，不能被覆盖。
            workspacePath: overrides.workspacePath !== undefined ? overrides.workspacePath : (workspacePath ?? undefined),
            permissionPreset: overrides.permissionPreset ?? permission ?? undefined,
            clientTimeZone: browserTimeZone(),
            // 空草稿与「没有草稿」是同一件事，不要往请求里塞一个空串。
            ...(draftText.trim().length > 0 ? { draft: draftText } : {}),
          }
          const mine = ++ticket.current
          setStatus('loading')
          setError(null)
          try {
            const next = await fetchPreview(conditions)
            if (mine !== ticket.current) return
            setPreview(next)
            setStatus('ready')
          } catch (cause) {
            if (mine !== ticket.current) return
            setError(cause instanceof Error ? cause.message : String(cause))
            setStatus('error')
          }
        }, [fetchPreview, workspacePath, permission, draft])

        // 工作区与权限直接改变模型看到的内容，选中即重算，不需要再点一次按钮。
        const chooseWorkspace = useCallback((path) => {
          const next = typeof path === 'string' ? path.trim() : path
          setWorkspace(next)
          void runPreview(preset, { workspacePath: next })
        }, [runPreview, preset])

        const choosePermission = useCallback((name) => {
          setPermission(name)
          void runPreview(preset, { permissionPreset: name })
        }, [runPreview, preset])

        // 草稿不随输入重算：每敲一个字都跑一次 skill 扫描与文件读取太贵，
        // 由用户决定「这条消息现在算一遍」。
        const applyDraft = useCallback(() => {
          void runPreview(preset, { draft })
        }, [runPreview, preset, draft])

        return {
          previewPreset: preset,
          setPreviewPreset: setPreset,
          preview,
          previewStatus: status,
          previewError: error,
          previewTab: tab,
          setPreviewTab: setTab,
          previewWorkspaces: workspaces ?? [],
          previewWorkspacePath: workspacePath,
          setPreviewWorkspacePath: chooseWorkspace,
          // 权限预设的默认值由宿主给出（部署默认），所以未选时先显示服务端解析结果。
          previewPermissionPreset: permission ?? preview?.conditions?.permission?.preset ?? null,
          setPreviewPermissionPreset: choosePermission,
          previewDraft: draft,
          setPreviewDraft: setDraft,
          applyDraft,
          fetchPreview,
          runPreview,
        }
      }

      return { usePreviewStore }
    }
  },
})
