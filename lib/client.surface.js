/**
 * 能力面：模型工具之外，这台部署还提供了哪些可浏览的能力。
 *
 * 第一阶段只有「技能」一段；条件与状态在 `client.surface-store.js`，
 * 技能段正文在 `client.surface-skills.js`。页面只负责段控件、条件栏与空态出口。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.surface.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.surface.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    return function create(deps) {
      const { selectField, workspaceField, modeTitle, formatSessionId } = deps
      const { renderSkillsSegment } = deps.surfaceSkills
      const { renderCommandsSegment } = deps.surfaceCommands
      const { renderNetworkSegment } = deps.surfaceNetwork

      /** 已实现的段；后续阶段在这里追加，不提前放不可用的按钮。 */
      const SEGMENTS = [
        ['skills', '技能'],
        ['commands', '斜杠命令'],
        ['network', '网络'],
      ]

      /**
       * 能力面的条件栏：技能段是模式 + 工作区，命令段另加会话，网络段只有重读。
       * @param {object} vc - 视图上下文。
       * @returns {object | null} React 节点。
       */
      function renderSurfaceFilters(vc) {
        const surface = vc.surface
        if (surface === undefined) return null
        const modes = vc.snapshot?.modes ?? []
        const current = surface.presetId ?? ''
        const unknown = current !== '' && !modes.some((mode) => mode.id === current)
        const commandsMode = surface.segment === 'commands'
        const networkMode = surface.segment === 'network'
        const currentSession = surface.sessionId ?? ''
        const unknownSession = currentSession !== '' && !(surface.liveSessions ?? []).some((session) => session.id === currentSession)
        return h(
          React.Fragment,
          null,
          commandsMode
            ? selectField('会话', currentSession, [
                { value: '', label: '不指定会话（按模式 scope）' },
                ...(unknownSession ? [{ value: currentSession, label: formatSessionId(currentSession) + ' · 不在活会话列表' }] : []),
                ...(surface.liveSessions ?? []).map((session) => ({
                  value: session.id,
                  label: formatSessionId(session.id) + (typeof session.preset === 'string' ? ' · ' + session.preset : ''),
                })),
              ], (value) => surface.setSession(value), {
                title: '命令目录按 Agent 的 scope 链合并；只有活会话能读到运行时目录',
              })
            : null,
          networkMode
            ? null
            : selectField('模式', current, [
                { value: '', label: '部署默认模式' },
                ...(unknown ? [{ value: current, label: current }] : []),
                ...modes.map((mode) => ({ value: mode.id, label: modeTitle(mode) })),
              ], (value) => surface.setPreset(value), {
                title: '模式决定 preset scope：同一工作区换个模式，技能目录可能不同',
              }),
          networkMode
            ? null
            : workspaceField('工作区', surface.workspacePath, vc.previewWorkspaces, (value) => {
                surface.setWorkspace(value)
              }, vc.workspacePicker?.surface, {
                title: '技能目录按 cwd 扫描：项目根的 skill 只在对应工作区出现；「新建工作区…」会把选中的目录登记为 DSH 工作区',
                ariaLabel: '工作区',
                busy: vc.workspacePicker?.busy === true,
                error: vc.workspacePicker?.error ?? null,
              }),
          h(
            'div',
            { className: 'ptActions' },
            h(
              'button',
              {
                type: 'button',
                className: 'ptBtn',
                onClick: () => void (networkMode ? surface.loadNetwork() : commandsMode ? surface.loadCommands() : surface.loadSkills()),
                disabled: networkMode ? surface.network?.status === 'loading' : commandsMode ? surface.commands?.status === 'loading' : surface.skills?.status === 'loading',
              },
              networkMode
                ? (surface.network?.status === 'loading' ? '读取中…' : '重新读取')
                : commandsMode
                  ? (surface.commands?.status === 'loading' ? '读取中…' : '重新读取')
                  : (surface.skills?.status === 'loading' ? '读取中…' : '重新读取'),
            ),
          ),
        )
      }

      /**
       * 能力面正文。
       * @param {object} vc - 视图上下文。
       * @returns {object} React 节点。
       */
      function renderSurfaceView(vc) {
        const surface = vc.surface
        if (surface === undefined) return h('div', { className: 'ptEmpty' }, '能力面状态不可用。')
        return h(
          'div',
          null,
          SEGMENTS.length > 1
            ? h(
                'div',
                { style: { marginBottom: '10px' } },
                h(
                  'span',
                  { className: 'ptSeg', role: 'group', 'aria-label': '能力面分类' },
                  SEGMENTS.map(([id, label]) => h(
                    'button',
                    {
                      key: id,
                      type: 'button',
                      className: 'ptSegBtn',
                      'aria-pressed': surface.segment === id ? 'true' : 'false',
                      onClick: () => surface.setSegment(id),
                    },
                    label,
                  )),
                ),
              )
            : null,
          surface.segment === 'skills'
            ? renderSkillsSegment(vc)
            : surface.segment === 'commands'
              ? renderCommandsSegment(vc)
              : surface.segment === 'network'
                ? renderNetworkSegment(vc)
                : h('div', { className: 'ptEmpty' }, '这一段还没有实现。'),
        )
      }

      return { renderSurfaceFilters, renderSurfaceView }
    }
  },
})
