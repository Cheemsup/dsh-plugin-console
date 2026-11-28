/**
 * 插件详情：选中行的若干段事实与控制区。
 *
 * 从 `client.plugins.js` 拆出，原因是后者已接近单文件 1000 行上限；行为与
 * 渲染顺序完全不变。工厂返回 `{ Detail }`，由 `client.plugins.js` 通过 deps 取用。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.plugin-detail.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect } = React

    return function create(deps) {
      const {
        shortId, textButton, rowEnd, depList, fact, layerLabel, modeMountsOf,
        effects, activity, promptContribution,
      } = deps
      // 提示词贡献的模型与折叠视图独立一个 chunk：能力面的「上下文注入」段要复用
      // 同一份，两处各写一份迟早会让标签、落点判断与文案漂移。
      const { promptRowsOf, PromptFold } = promptContribution ?? {}

      /**
       * 详情字段的一句话解释。
       *
       * 绑定在字段名的 `title` 上，悬停即见；这样同一份解读不再以
       * `ptSectionNote` 的形式长期占版面。
       */
      const FACT_TIPS = {
        rowId: '插件声明使用的id；同一个包被挂载成多行时，列表与选择器靠它区分',
        entryId: 'Loader树里的运行时实例id',
        loadIndex: '加载顺序就是组合文件的声明顺序',
        module: '这个条目加载的模块名',
        packageName: '从模块名解析出的包名',
        version: '包声明的版本',
        packageDir: '包在磁盘上的目录',
        face: 'host = 宿主/管理侧（Node/Cordis）：工具、服务、存储与权限等；client = 浏览器侧（dsh.client）：负责面板与交互',
        description: '包提供的本地化描述',
        metaError: '读取包元信息时发生的错误',
        enabled: '当自身未被禁用且祖先 group 也没有被禁用时为启用',
        modeMounts: '这一行在全局层面没有启动，但同一个包由这些模式的预设在会话里挂载，调用与工具可见性来自那一份',
        inheritedDisabled: '插件自身没有禁用，但祖先 group 被禁用',
        disabledExpr: '组合文件里的条件禁用表达式',
        disabledValue: 'true 表示禁用，false 表示启用',
        phase: 'active = 已激活；pending = 等待依赖；loading / unloading = 正在切换；failed = 启动失败；无存活 fiber = 未挂载',
        diagnostic: 'fiber 启动失败时的错误信息',
        config: '插件收到的生效配置，可能包含凭据',
        source: '来源： profile patch（插件市场等 ） / base / web-app / profile / 运行时挂载 / 模式挂载等',
        layerVersion: '插件所属的组合包（bundle）以及版本',
        override: 'patch 层按行id覆盖 config、disabled 等的键内容',
        requires: '插件生效前需要等待的服务，没有提供者时会停在 pending；由宿主上下文提供的服务不算缺失',
        provides: '插件注册和对外提供的服务，停掉后消费者会失去依赖',
        clientDeps: '页面浏览方面（dsh.client）声明需要的的模块依赖',
        behavior: 'Cordis fiber 登记的副作用，不是调用记录；与能力贡献重叠的类别只保留计数',
      }

      /** 选中行的若干段事实。 */
      function Detail({ entry, snapshot, modeMounts, preview, byId, onOpenTool, onOpenSection, onOpenPlugin, onOpenSurface, onPreviewDisable, anchorId, onClose, usage, activityStatus, activityError, control, sessions, reload }) {
        // 被跳转定位时把详情滚进视野。
        //
        // 展开发生在虚拟的高度里，浏览器不会自己滚动；而滚动容器不是 window，
        // 是外层 .ptBody（overflow:auto）。所以用 scrollIntoView 并让它自己找容器。
        useEffect(() => {
          if (anchorId === undefined) return
          const node = document.getElementById(anchorId)
          if (node === null || typeof node.scrollIntoView !== 'function') return
          node.scrollIntoView({ block: 'center', behavior: 'auto' })
        }, [anchorId])

        // 全局行禁用但模式里另有挂载时，「禁用」与「有调用」说的是两份东西。
        const mounts = (modeMounts ?? modeMountsOf(snapshot)).get(entry.moduleName) ?? []
        const mountLabels = mounts.map((mount) => (mount.conditional ? `${mount.label}（条件）` : mount.label))
        const presetActivity = !entry.enabled && mounts.length > 0

        /** 服务里的运行时条目 id 渲染成可跳转的名字；对方不是插件时退回纯文本。 */
        const linksOf = (ids) => ids.map((id, index) => {
          const target = byId.get(id)
          if (target === undefined) return h(React.Fragment, { key: id + index }, index === 0 ? null : '、', shortId(id, byId))
          return h(
            React.Fragment,
            { key: id + index },
            index === 0 ? null : '、',
            h('button', {
              type: 'button',
              className: 'ptTag ptLink',
              title: '在插件页展开 ' + (target.rowId ?? target.entryId ?? target.moduleName),
              onClick: () => onOpenPlugin?.(target.rowId),
            }, shortId(id, byId)),
          )
        })

        /**
         * 跳到插件能力面并按本行收窄。
         *
         * 组级跳转只传 owner：源码扫描的名字不一定出现在运行时清单里（可能只在
         * 别的条件、或根本没注册），落到「这个插件在那一段里的全部条目」比落到
         * 一个查不到的名字更像诊断结果。条目级跳转（提示词名）才补 name。
         * @param {'tools' | 'prompts' | 'skills' | 'commands' | 'network'} segment - 目标段。
         * @param {string} [name] - 可选的条目名。
         */
        const openSurfaceOfEntry = (segment, name) => {
          if (typeof onOpenSurface !== 'function') return
          onOpenSurface(segment, typeof name === 'string' && name.length > 0
            ? { owner: entry.rowId, name }
            : { owner: entry.rowId })
        }

        const hostRequires = new Set(entry.hostRequires ?? [])
        const requires = entry.requires.map((name) => {
          const providers = snapshot.services[name]?.providers ?? []
          const hostProvided = hostRequires.has(name)
          return {
            key: name,
            node: h(
              React.Fragment,
              null,
              h('span', { className: 'ptDepKey' }, name),
              providers.length
                ? h('span', { className: 'ptDepValue' }, '← ', linksOf(providers))
                // Loader 自己的服务与宿主在挂树之前 provide() 的服务没有 Loader 行；
                // 能解析出来就说明不缺失，不能因为索引里没有就写成 pending。
                : hostProvided
                  ? h(
                      'span',
                      {
                        className: 'ptDepValue',
                        title: '由宿主上下文提供，没有对应的 Loader 行',
                      },
                      '← 宿主上下文（不在 Loader 树里）',
                    )
                  : h('span', { className: 'ptDepValue ptMissing' }, '← 无提供者（停在 pending）'),
            ),
          }
        })
        const provides = entry.provides.map((name) => {
          const consumers = snapshot.services[name]?.consumers ?? []
          return {
            key: name,
            node: h(
              React.Fragment,
              null,
              h('span', { className: 'ptDepKey' }, name),
              h(
                'span',
                { className: 'ptDepValue' },
                consumers.length ? h(React.Fragment, null, '→ ', linksOf(consumers)) : '→ 无消费者',
              ),
            ),
          }
        })
        const clientDeps = [...entry.clientInject, ...entry.clientExternal].map((name) => ({
          key: name,
          node: h(
            React.Fragment,
            null,
            h('span', { className: 'ptDepKey' }, name),
            h('span', { className: 'ptDepValue' }, '客户端模块依赖'),
          ),
        }))
        const hasServices = requires.length + provides.length + clientDeps.length > 0
        // 客户端模块不是 host 服务，不能并进「需要」；但在标题里单独计数，
        // 读者才不会以为这一板块只有服务供需两类。
        const serviceCounts = `需要 ${requires.length} · 提供 ${provides.length}${clientDeps.length > 0 ? ` · 客户端 ${clientDeps.length}` : ''}`
        const regs = entry.registrations ?? {}
        const regTools = regs.tools ?? []
        const regSectionNames = regs.sections ?? []
        const regContextNames = regs.contexts ?? []
        const regSkills = regs.runtimeSkills ?? []
        const regCommands = regs.commands ?? []
        const regNetwork = [
          ['模型 provider', regs.llmProviders ?? []],
          ['Web 搜索', regs.webSearch ?? []],
          ['Web 抓取', regs.webFetch ?? []],
          ['MCP server', regs.mcpServers ?? []],
          ['路由', regs.routePaths ?? []],
        ].filter(([, names]) => names.length > 0)
        // 直接发请求的插件不会登记到任何注册表，只能靠源码规则表补；
        // 与上面的「注册名」分开渲染，避免把「写了调用」误读成「注册了能力」。
        const regNetworkSites = regs.networkSites ?? []
        const NETWORK_GROUP_LABELS = { http: 'HTTP', socket: 'Socket', websocket: 'WebSocket', browser: '浏览器', config: '配置' }
        // 旧快照没有 registrationSites；那种情况下退回「按全局注册表判断」的旧行为，
        // 不能因为缺数据把整块注册项都变成死链。
        const hasSiteData = Array.isArray(entry.registrationSites)
        // 配置值直接来自快照（options.config）；旧快照只有字段名时退回名字列表。
        const configRows = Array.isArray(entry.configEntries) ? entry.configEntries : []
        const configNode = configRows.length
          ? h(
              'ul',
              { className: 'ptConfigList' },
              configRows.map((row) => h(
                'li',
                { key: row.key },
                h('code', { className: 'ptConfigKey' }, row.key),
                h('span', { className: 'ptConfigEquals' }, '='),
                h('code', { className: 'ptConfigValue' }, row.value),
              )),
            )
          : (entry.configKeys?.length ? h('code', null, entry.configKeys.join(', ')) : null)

        // 控制是唯一会写宿主状态的一段：先算好节点，再和分隔线一起放到最后。
        const controlNode = control?.renderControlSection?.(entry, { control, sessions, reload, onPreviewDisable }) ?? null

        /**
         * 渲染一组提示词贡献。
         *
         * 模型与折叠视图都在 `client.prompt-contribution.js`：能力面的「上下文注入」
         * 段用的是同一份，两处才能对同一个名字给出一致的落点判断与标签。
         * @param {'section' | 'context'} kind - 贡献种类。
         * @param {string[]} names - 源码扫描出的名字。
         * @param {string} label - 组标题。
         * @param {string} note - 组标题的悬停说明。
         * @returns {object | null} React 节点。
         */
        const renderContributionGroup = (kind, names, label, note) => {
          if (names.length === 0 || typeof promptRowsOf !== 'function' || typeof PromptFold !== 'function') return null
          const rows = promptRowsOf(entry, snapshot, preview)[kind === 'context' ? 'contexts' : 'sections']
          return h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'ptChipGroup', style: { marginTop: '6px' } },
              h('span', { className: 'ptSub', title: note }, `${label} ${names.length}`),
            ),
            h(
              'ul',
              { className: 'ptList', style: { marginTop: '4px' } },
              rows.map((row) => h(PromptFold, {
                key: row.rawName,
                row,
                moduleName: entry.moduleName,
                hasSiteData,
                // 名字点击落到「上下文注入」段并按这个插件 + 名字收窄；预演是次级动作。
                onNameClick: typeof onOpenSurface === 'function'
                  ? () => openSurfaceOfEntry('prompts', row.rawName)
                  : undefined,
                onPreview: row.linkable
                  ? (name, rowKind) => onOpenSection(name, rowKind, entry.moduleName)
                  : undefined,
                onSearch: () => onOpenSection(row.target ?? row.display, kind, entry.moduleName),
              })),
            ),
          )
        }

        /**
         * 能力贡献的一个子块：统一的头行（标题 / 计数 / 跳转）+ 内容。
         *
         * 有内容的子块才用同一种形状，用户扫一眼就知道「哪里有计数、哪里能跳」；
         * 计数是读数不是状态，走右簇，不用胶囊。
         * @param {{label: string, count: string, segment: string, body: object}} props - 子块。
         * @returns {object} React 节点。
         */
        const subBlock = ({ label, count, segment, body }) => h(
          'div',
          { className: 'ptSubSection' },
          h(
            'div',
            { className: 'ptSectionHead' },
            h('span', { className: 'ptSubTitle' }, label),
            rowEnd(
              h('span', { className: 'ptCount' }, count),
              typeof onOpenSurface === 'function'
                ? textButton('在插件能力面查看', () => openSurfaceOfEntry(segment), { title: `在插件能力面只看归属这个插件的${label}` })
                : null,
            ),
          ),
          body,
        )

        /**
         * 能力贡献的子块。
         *
         * 只列这个插件真的有的能力；某类一条注册点都没有时，连标题都不出——
         * 空标题加一句「没有找到」只会把详情撑长。运行时归属不在这里重复，
         * 统一以底部一个跳转指向插件能力面。
         */
        const contributionBlocks = [
          regTools.length > 0
            ? subBlock({
                label: '工具',
                count: `${regTools.length} 个`,
                segment: 'tools',
                body: h(
                  'div',
                  { className: 'ptChipGroup' },
                  regTools.map((name) => h(
                    'button',
                    { key: name, type: 'button', className: 'ptTag ptLink', title: '在插件能力面 · 工具段查看该工具', onClick: () => onOpenTool(name) },
                    name,
                  )),
                ),
              })
            : null,
          regSectionNames.length + regContextNames.length > 0
            ? subBlock({
                label: '上下文注入',
                count: `${regSectionNames.length + regContextNames.length} 处`,
                segment: 'prompts',
                body: h(
                  React.Fragment,
                  null,
                  renderContributionGroup('section', regSectionNames, '提示词段', '系统提示词段；可定位 = 全局注册表或当前预演里有这个落点'),
                  renderContributionGroup('context', regContextNames, '运行时上下文', '以 runtime-context 消息注入，不属于系统提示词；可定位 = 当前预演的消息分段里有这个名字'),
                ),
              })
            : null,
          regSkills.length + regCommands.length > 0
            ? subBlock({
                label: '技能与命令',
                count: `技能 ${regSkills.length} · 命令 ${regCommands.length}`,
                segment: regSkills.length > 0 ? 'skills' : 'commands',
                body: h(
                  React.Fragment,
                  null,
                  regSkills.length
                    ? h(
                        'div',
                        { className: 'ptChipGroup' },
                        h('span', { className: 'ptSub' }, `技能 ${regSkills.length}`),
                        regSkills.map((name) => (typeof onOpenSurface === 'function'
                          ? h('button', {
                              key: 'skill:' + name,
                              type: 'button',
                              className: 'ptTag ptLink',
                              title: '在插件能力面 · 技能段只看归属这个插件的条目',
                              onClick: () => openSurfaceOfEntry('skills'),
                            }, name)
                          : h('span', { key: 'skill:' + name, className: 'ptTag', title: '源码里的注册名；运行时是否可见以能力面为准' }, name))),
                      )
                    : null,
                  regCommands.length
                    ? h(
                        'div',
                        { className: 'ptChipGroup', style: { marginTop: '6px' } },
                        h('span', { className: 'ptSub' }, `命令 ${regCommands.length}`),
                        regCommands.map((name) => (typeof onOpenSurface === 'function'
                          ? h('button', {
                              key: 'command:' + name,
                              type: 'button',
                              className: 'ptTag ptLink',
                              title: '在插件能力面 · 命令段只看归属这个插件的条目',
                              onClick: () => openSurfaceOfEntry('commands'),
                            }, '/' + name)
                          : h('span', { key: 'command:' + name, className: 'ptTag', title: '源码里的注册名；运行时是否可见以能力面为准' }, '/' + name))),
                      )
                    : null,
                ),
              })
            : null,
          regNetwork.length + regNetworkSites.length > 0
            ? subBlock({
                label: '网络',
                count: `注册 ${regNetwork.reduce((sum, [, names]) => sum + names.length, 0)} · 调用点 ${regNetworkSites.length}`,
                segment: 'network',
                body: h(
                  React.Fragment,
                  null,
                  regNetwork.map(([label, names]) => h(
                    'div',
                    { key: label, className: 'ptChipGroup', style: { marginTop: '6px' } },
                    h('span', { className: 'ptSub' }, label + ' ' + names.length),
                    names.map((name) => (typeof onOpenSurface === 'function'
                      ? h('button', {
                          key: label + ':' + name,
                          type: 'button',
                          className: 'ptTag ptLink',
                          title: '在插件能力面 · 网络段只看归属这个插件的条目',
                          onClick: () => openSurfaceOfEntry('network'),
                        }, name)
                      : h('span', { key: label + ':' + name, className: 'ptTag', title: '源码里的注册名；运行时以能力面为准' }, name))),
                  )),
                  regNetworkSites.length > 0
                    ? h(
                        'div',
                        { className: 'ptSubSection', style: { marginTop: '8px' } },
                        h('span', { className: 'ptSub', title: '静态扫描：只说明源码里写了这个调用，不证明请求真的发生过' }, `调用点 ${regNetworkSites.length}`),
                        h(
                          'ul',
                          { className: 'ptList' },
                          regNetworkSites.map((site) => h(
                            'li',
                            { key: [site.file, site.line, site.label, site.kind, site.target ?? ''].join('|'), className: 'ptSurfaceRow' },
                            h(
                              'span',
                              { className: 'ptName' },
                              typeof onOpenSurface === 'function'
                                ? h('button', {
                                    type: 'button',
                                    className: 'ptLink',
                                    title: '在插件能力面 · 网络段只看归属这个插件的条目',
                                    onClick: () => openSurfaceOfEntry('network'),
                                  }, h('code', null, site.label))
                                : h('code', null, site.label),
                              h('span', { className: 'ptModule', style: { display: 'block' } }, site.file + ':' + site.line),
                            ),
                            site.target !== undefined
                              ? h('span', { className: 'ptSub', title: site.target }, site.target)
                              : null,
                            h('span', { className: 'ptTag' }, NETWORK_GROUP_LABELS[site.group] ?? site.group),
                            h('span', { className: 'ptTag', title: '源码事实，不是请求流水' }, site.kind === 'config' ? '配置' : '调用'),
                          )),
                        ),
                      )
                    : null,
                ),
              })
            : null,
        ].filter((node) => node !== null)

        return h(
          'div',
          { className: 'ptDetail', id: anchorId ?? undefined },
          h('div', { className: 'ptDetailClose' }, textButton('收起', onClose)),
          h(
            'div',
            { className: 'ptDetailGrid' },
            h(
              'div',
              { className: 'ptSection' },
              h('p', { className: 'ptSectionTitle' }, '基本信息'),
              entry.modeOnly
                ? h('p', { className: 'ptSub' }, `只由模式挂载（${(entry.modeIds ?? []).join('、')}），没有自己的 Loader 行；工具与提示词来自源码扫描。`)
                : null,
              h(
                'dl',
                { className: 'ptFacts' },
                fact('组合行 id', h('code', null, entry.rowId), FACT_TIPS.rowId),
                entry.entryId !== entry.rowId ? fact('运行时 id', h('code', null, entry.entryId), FACT_TIPS.entryId) : null,
                fact('加载序', typeof entry.loadIndex === 'number' ? '#' + (entry.loadIndex + 1) + '（Loader 声明顺序）' : null, FACT_TIPS.loadIndex),
                fact('模块', h('code', null, entry.moduleName), FACT_TIPS.module),
                fact('包名', entry.packageName ? h('code', null, entry.packageName) : null, FACT_TIPS.packageName),
                fact('版本', entry.version, FACT_TIPS.version),
                fact('包目录', entry.packageDir ? h('code', null, entry.packageDir) : null, FACT_TIPS.packageDir),
                fact('面', entry.face === 'both' ? 'host + client（双面）' : 'host', FACT_TIPS.face),
                fact('描述', entry.description, FACT_TIPS.description),
                entry.metaError ? fact('元信息诊断', h('span', { className: 'ptError' }, entry.metaError), FACT_TIPS.metaError) : null,
              ),
            ),
            h(
              'div',
              { className: 'ptSection' },
              h('p', { className: 'ptSectionTitle' }, '状态'),
              h(
                'dl',
                { className: 'ptFacts' },
                fact('有效启用', entry.enabled ? '是' : '否', FACT_TIPS.enabled),
                entry.inheritedDisabled ? fact('禁用来源', '祖先 group 被禁用', FACT_TIPS.inheritedDisabled) : null,
                entry.disabledExpr ? fact('禁用表达式', h('code', null, entry.disabledExpr), FACT_TIPS.disabledExpr) : null,
                entry.disabledExpr ? fact('表达式求值', entry.disabledValue ? 'true（禁用）' : 'false（启用）', FACT_TIPS.disabledValue) : null,
                fact('fiber 阶段', entry.phase ?? '无存活 fiber', FACT_TIPS.phase),
                presetActivity
                  ? fact('模式内挂载', mountLabels.join('、'), FACT_TIPS.modeMounts)
                  : null,
                entry.diagnostic ? fact('失败诊断', h('span', { className: 'ptError' }, entry.diagnostic), FACT_TIPS.diagnostic) : null,
                configNode ? fact('配置字段', configNode, FACT_TIPS.config) : null,
              ),
            ),
            h(
              'div',
              { className: 'ptSection' },
              h('p', { className: 'ptSectionTitle' }, '组合链（加载与覆盖）'),
              h(
                'div',
                { className: 'ptFlow' },
                h('div', { className: 'ptFlowStep', title: FACT_TIPS.source }, h('span', { className: 'ptFlowKey' }, '来源'), h('span', { className: 'ptFlowValue' }, entry.userInserted ? 'profile patch 插入' : layerLabel(entry.layer))),
                h('div', { className: 'ptFlowStep', title: FACT_TIPS.layerVersion }, h('span', { className: 'ptFlowKey' }, '层版本'), h('span', { className: 'ptFlowValue' }, entry.layerVersion ? `${layerLabel(entry.layer)}@${entry.layerVersion}` : layerLabel(entry.layer))),
                h('div', { className: 'ptFlowStep', title: FACT_TIPS.rowId }, h('span', { className: 'ptFlowKey' }, '组合行 id'), h('span', { className: 'ptFlowValue' }, entry.rowId)),
                h('div', { className: 'ptFlowStep', title: FACT_TIPS.entryId }, h('span', { className: 'ptFlowKey' }, '运行时 id'), h('span', { className: 'ptFlowValue' }, entry.entryId, typeof entry.loadIndex === 'number' ? h('span', { title: FACT_TIPS.loadIndex }, `（加载序 #${entry.loadIndex + 1}）`) : null)),
                entry.overriddenBy.length
                  ? h('div', { className: 'ptFlowStep', 'data-tone': 'muted', title: FACT_TIPS.override }, h('span', { className: 'ptFlowKey' }, '覆盖'), h('span', { className: 'ptFlowValue' }, entry.overriddenBy.join(' → ')))
                  : null,
              ),
            ),
            h(
              'div',
              { className: 'ptSection' },
              h('p', { className: 'ptSectionTitle' }, `依赖与提供（${serviceCounts}）`),
              hasServices
                ? h(
                    React.Fragment,
                    null,
                    requires.length ? h('p', { className: 'ptSub', style: { margin: 0 }, title: FACT_TIPS.requires }, '需要（inject）') : null,
                    requires.length ? depList(requires) : null,
                    provides.length ? h('p', { className: 'ptSub', style: { margin: 0 }, title: FACT_TIPS.provides }, '提供（provisions）') : null,
                    provides.length ? depList(provides) : null,
                    clientDeps.length ? h('p', { className: 'ptSub', style: { margin: 0 }, title: FACT_TIPS.clientDeps }, '客户端模块') : null,
                    clientDeps.length ? depList(clientDeps) : null,
                  )
                : h('p', { className: 'ptSub', style: { margin: 0 } }, '没有任何依赖、客户端模块或提供项'),
            ),
            // 能力贡献：只列这个插件真的有的能力；空的能力不占标题。
            // 运行时归属不在这里重复清单，统一由底部跳转指向插件能力面。
            h(
              'div',
              { className: 'ptSection' },
              h('p', { className: 'ptSectionTitle', title: '来自包源码的静态扫描；没有贡献的能力不出标题' }, '能力贡献'),
              contributionBlocks.length > 0
                ? h('div', { className: 'ptSubBlocks' }, ...contributionBlocks)
                : h('p', { className: 'ptHint', style: { margin: 0 } }, '源码扫描没有找到工具、提示词、技能、命令或网络注册点'),
            ),
            (entry.effects?.length ?? 0) > 0
              ? h(
                  'div',
                  { className: 'ptSection' },
                  h('p', { className: 'ptSectionTitle', title: FACT_TIPS.behavior }, `运行时登记（${entry.effects.length}）`),
                  effects.runtimeList(entry.effects),
                )
              : null,
            // 观测在读事实之后：先知道它注册了什么，再看最近 7 天实际被调用了多少。
            activity?.renderPluginActivity?.(
              entry,
              usage,
              activityStatus,
              activityError,
              presetActivity ? '调用按工具名统计，可能来自模式预设里的同名挂载' : undefined,
            ) ?? null,
            controlNode === null
              ? null
              : h(React.Fragment, null, h('hr', { className: 'ptDivider' }), controlNode),
          ),
        )
      }

      return { Detail }
    }
  },
})
