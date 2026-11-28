/**
 * 提示词贡献：源码里注册的提示词段与运行时上下文。
 *
 * 插件详情回答「这一行贡献了哪些注入」，能力面的「上下文注入」段回答「每个插件
 * 贡献了哪些注入」——两处是同一份事实，模型与折叠视图都放在这里，避免各写一份
 * 后标签、落点判断与文案漂移。
 *
 * 数据口径分三级：`entry.registrationSites` 是源码扫描的注册点（文件/行/接收者/
 * 字面量文本），`snapshot.prompt` 是全局注册表的装配结果（模型最终收到的正文），
 * 两者按名字对齐。能定位到全局注册表的名字才提供「预演」；扫不到注册包袱的名字
 * 标「未归属」，不硬凑。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.prompt-contribution.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.prompt-contribution.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect, useState } = React

    return function create(deps) {
      const { textButton, rowEnd, fetchJson, REGISTRATION_SITE_ROUTE, UNOWNED_REASON } = deps

      /** 接收者三档的界面文案；与 host 的 receiverKind 同名。 */
      const RECEIVER_LABELS = {
        own: '本作用域',
        other: '其它作用域',
        unknown: '作用域未知',
      }

      /**
       * 首请求预演一定会推导的会话上下文。
       *
       * 这三段由 `host/preview-contexts.js` 按工作区 / 权限条件重算，注册接收者
       * 往往是 `scope`（agent scope），不能按「其它作用域」一律排除。名单之外的
       * session-scope 上下文仍然只给注册点，避免凭名字猜。
       */
      const DERIVED_CONTEXTS = new Set(['working-directory:current', 'sandbox:policy', 'approval:policy'])

      /**
       * 模板名与具体名的匹配：`tool:${name}` 只做前后缀检查。
       *
       * 不把它当 JavaScript 模板求值：变量值在运行时才知道，这里只回答
       * 「源码里的模板可能落到哪些实际名字」。匹配到多个时调用方不得瞎选。
       * @param {string} pattern - 源码里的名字（可能含 `${}`）。
       * @param {string} actual - 注册表/预演里的实际名字。
       * @returns {boolean} 是否可能匹配。
       */
      function templateMatches(pattern, actual) {
        const cut = pattern.indexOf('${')
        if (cut < 0) return pattern === actual
        const close = pattern.indexOf('}', cut)
        if (close < 0) return false
        const prefix = pattern.slice(0, cut)
        const tail = pattern.slice(close + 1)
        if (actual.length < prefix.length + tail.length) return false
        return actual.startsWith(prefix) && actual.endsWith(tail)
      }

      /**
       * 把源码名解析成唯一的具体名。
       *
       * 精确命中优先；模板命中只有**恰好一个**结果时才采用。`tool:${toolName}`
       * 会命中所有 `tool:*`，这种歧义必须保留成「未解析」，不能猜一个。
       * @param {string[]} names - 注册表/预演里的名字。
       * @param {string} display - 展示名（已展开的名字或原名）。
       * @param {string} raw - 源码里的原名。
       * @returns {string | undefined} 具体名或 undefined。
       */
      function concreteNameOf(names, display, raw) {
        if (names.includes(display)) return display
        if (names.includes(raw)) return raw
        const matches = names.filter((name) => templateMatches(raw, name))
        return matches.length === 1 ? matches[0] : undefined
      }

      /** 预演里当前可见的名字：系统段、装配上下文，以及 runtime-context 的消息分段。 */
      function previewNamesOf(preview, kind) {
        if (preview === null || preview === undefined) return []
        if (kind === 'context') {
          const names = (preview.contexts ?? []).map((row) => row.name)
          for (const message of preview.messages ?? []) {
            for (const part of message.parts ?? []) {
              if (typeof part.name === 'string') names.push(part.name)
            }
          }
          return names
        }
        return (preview.sections ?? []).map((row) => row.name)
      }

      /** 全局注册表里的名字。 */
      function globalNamesOf(snapshot, kind) {
        const table = kind === 'context' ? snapshot?.prompt?.contexts : snapshot?.prompt?.sections
        return (table ?? []).map((row) => row.name)
      }

      /** 某个条目对某个名字的注册点；`resolvedName` 也接受，方便按展开后的名字查。 */
      function sitesFor(entry, kind, name) {
        const sites = (entry?.registrationSites ?? []).filter((site) => (
          site.kind === kind && (site.name === name || site.resolvedName === name)
        ))
        // 与片段服务同向：非入口的 types/*.js 更短，通常更完整，排在 entry bundle 前面。
        const entryRank = (file) => (/(^|\/)index\.(?:mjs|cjs|js)$/.test(file) ? 1 : 0)
        return sites.sort((left, right) => (
          entryRank(left.file) - entryRank(right.file)
          || left.file.localeCompare(right.file)
          || left.line - right.line
        ))
      }

      /** 展示名：能展开的模板优先用真实名字，否则保留源码名并让界面标「模板名」。 */
      function displayNameOf(name, sites) {
        return sites.find((site) => typeof site.resolvedName === 'string')?.resolvedName ?? name
      }

      /**
       * 一段注入的正文来源。
       *
       * 优先级刻意是「源码字面量 → 全局注册表装配文本 → 运行时表达式」：
       * 源码文本回答「这段注册写了什么」，装配文本回答「模型现在真正收到什么」，
       * 两者不是同一件事，界面必须标出来源；运行时求值没有可展示文本，只给表达式。
       * @param {object[]} sites - 某个名字的注册点。
       * @param {object | undefined} registryRow - 全局注册表里的同名行。
       * @returns {{kind: 'literal'|'constant'|'registry'|'runtime'|'none', value?: string, expression?: string, truncated?: boolean, registryProvider?: boolean}} 正文来源。
       */
      function promptTextOf(sites, registryRow) {
        const valued = sites.filter((site) => site.text !== undefined && typeof site.text.value === 'string')
        // 本作用域的注册点通常就是真正生效的那一份；有多个时优先它。
        const site = valued.find((candidate) => candidate.receiverKind === 'own') ?? valued[0]
        if (site !== undefined) {
          return {
            kind: site.text.kind === 'constant' ? 'constant' : 'literal',
            value: site.text.value,
            ...(site.text.truncated === true ? { truncated: true } : {}),
          }
        }
        const runtimeSite = sites.find((candidate) => candidate.text !== undefined
          && (candidate.text.kind === 'function' || candidate.text.kind === 'expression'))
        if (runtimeSite !== undefined) {
          return {
            kind: 'runtime',
            expression: runtimeSite.text.expression ?? '',
            ...(runtimeSite.text.truncated === true ? { truncated: true } : {}),
          }
        }
        if (registryRow !== undefined && typeof registryRow.text === 'string' && registryRow.text.length > 0) {
          return { kind: 'registry', value: registryRow.text }
        }
        if (registryRow?.provider === true) {
          // 注册表只标记了「text 是函数」，但没有给出求值结果（assemble 不可用时）。
          return { kind: 'none', registryProvider: true }
        }
        return { kind: 'none' }
      }

      /**
       * 一个名字的完整贡献模型。
       *
       * `evidence` 只放事实，界面自己决定用哪些标签：`uniqueSource` 是「按当前扫描
       * 范围」的结论，不是宿主保证；`externalOnly` 说明注册点不在首请求 scope 内；
       * `sameName` 说明全局注册表里另有一个同名条目。
       * @param {object} entry - 贡献所属的条目。
       * @param {'section'|'context'} kind - 贡献种类。
       * @param {string} rawName - 源码里的名字。
       * @param {object} snapshot - 快照。
       * @param {object | null} preview - 当前首请求预演；可为空。
       * @returns {object} Row。
       */
      function promptRowOf(entry, kind, rawName, snapshot, preview) {
        const sites = sitesFor(entry, kind, rawName)
        const display = displayNameOf(rawName, sites)
        const derived = kind === 'context' && DERIVED_CONTEXTS.has(display)
        const externalOnly = !derived && sites.length > 0 && sites.every((site) => site.receiverKind === 'other')
        const globalTarget = concreteNameOf(globalNamesOf(snapshot, kind), display, rawName)
        const previewTarget = concreteNameOf(previewNamesOf(preview, kind), display, rawName)
        const target = externalOnly ? undefined : (globalTarget ?? previewTarget ?? (derived ? display : undefined))
        // 旧快照没有 registrationSites；那种情况下退回「按全局注册表判断」的旧行为，
        // 不能因为缺数据把整块注册项都变成死链。
        const hasSiteData = Array.isArray(entry.registrationSites)
        const linkable = !externalOnly && (hasSiteData ? target !== undefined : true)
        const table = kind === 'context' ? snapshot?.prompt?.contexts : snapshot?.prompt?.sections
        const registryRow = (table ?? []).find((row) => row.name === (globalTarget ?? display))
        const ownerIds = [...new Set([
          ...(snapshot?.prompt?.nameOwners?.[display] ?? []),
          ...(snapshot?.prompt?.nameOwners?.[rawName] ?? []),
        ])]
        const uniqueSource = ownerIds.length === 1
          && ownerIds[0] === entry?.rowId
          && sites.length > 0
          && sites.every((site) => site.receiverKind === 'own')
          && !rawName.includes('${')
        return {
          owner: entry?.rowId ?? null,
          kind,
          rawName,
          display,
          sites,
          registryRow,
          text: promptTextOf(sites, registryRow),
          target,
          linkable,
          evidence: {
            uniqueSource,
            externalOnly,
            derived,
            template: rawName.includes('${'),
            sameName: registryRow !== undefined && !uniqueSource,
            noSiteData: !hasSiteData,
            noSite: hasSiteData && sites.length === 0,
            unowned: false,
          },
        }
      }

      /**
       * 一个条目的两组合成。
       * @param {object} entry - 条目。
       * @param {object} snapshot - 快照。
       * @param {object | null} preview - 首请求预演。
       * @returns {{sections: object[], contexts: object[]}} 行模型。
       */
      function promptRowsOf(entry, snapshot, preview) {
        const regs = entry?.registrations ?? {}
        return {
          sections: (regs.sections ?? []).map((name) => promptRowOf(entry, 'section', name, snapshot, preview)),
          contexts: (regs.contexts ?? []).map((name) => promptRowOf(entry, 'context', name, snapshot, preview)),
        }
      }

      /**
       * 全局注册表里有、但源码扫描定位不到注册者的行。
       *
       * 它们是真实存在的注入（模型收得到），只是归属未知；单独成组而不是丢掉。
       * @param {object} snapshot - 快照。
       * @returns {{sections: object[], contexts: object[]}} 行模型。
       */
      function registryContributionsOf(snapshot) {
        const rowsOf = (kind) => {
          const table = kind === 'context' ? snapshot?.prompt?.contexts : snapshot?.prompt?.sections
          return (table ?? [])
            .filter((row) => (row.owners ?? []).length === 0)
            .map((row) => ({
              owner: null,
              kind,
              rawName: row.name,
              display: row.name,
              sites: [],
              registryRow: row,
              text: promptTextOf([], row),
              target: row.name,
              linkable: true,
              evidence: {
                uniqueSource: false,
                externalOnly: false,
                derived: false,
                template: false,
                sameName: false,
                noSiteData: false,
                noSite: false,
                unowned: true,
              },
            }))
        }
        return { sections: rowsOf('section'), contexts: rowsOf('context') }
      }

      /** 组内排序：注册表 order 优先，其次名字；没有 order 的排后面。 */
      function sortRows(rows) {
        return [...rows].sort((left, right) => {
          const lo = left.registryRow?.order
          const ro = right.registryRow?.order
          if (typeof lo === 'number' && typeof ro === 'number' && lo !== ro) return lo - ro
          if (typeof lo === 'number' && typeof ro !== 'number') return -1
          if (typeof lo !== 'number' && typeof ro === 'number') return 1
          return left.display.localeCompare(right.display, 'zh-CN')
        })
      }

      /**
       * 按插件分组的注入清单。
       *
       * 组按注入数降序、未归属最后；组内先提示词段后运行时上下文。未归属组里
       * 与某个条目同名的行会被去掉，避免同一个名字既算在插件名下又算未归属。
       * @param {object} snapshot - 快照。
       * @param {object | null} [preview] - 首请求预演；只影响可定位性。
       * @returns {object[]} 分组。
       */
      function promptGroupsOf(snapshot, preview) {
        const groups = []
        const seen = new Set()
        for (const entry of snapshot?.entries ?? []) {
          if (entry === null || entry === undefined || entry.isGroup === true) continue
          const rows = promptRowsOf(entry, snapshot, preview ?? null)
          if (rows.sections.length + rows.contexts.length === 0) continue
          for (const row of [...rows.sections, ...rows.contexts]) {
            seen.add(row.display)
            seen.add(row.rawName)
          }
          groups.push({
            owner: entry.rowId,
            entry,
            unowned: false,
            sections: sortRows(rows.sections),
            contexts: sortRows(rows.contexts),
            count: rows.sections.length + rows.contexts.length,
          })
        }
        const unowned = registryContributionsOf(snapshot)
        const sections = sortRows(unowned.sections.filter((row) => !seen.has(row.display)))
        const contexts = sortRows(unowned.contexts.filter((row) => !seen.has(row.display)))
        if (sections.length + contexts.length > 0) {
          groups.push({
            owner: '__none',
            entry: undefined,
            unowned: true,
            sections,
            contexts,
            count: sections.length + contexts.length,
          })
        }
        groups.sort((left, right) => (
          Number(left.unowned) - Number(right.unowned)
          || right.count - left.count
          || String(left.owner).localeCompare(String(right.owner), 'zh-CN')
        ))
        return groups
      }

      /**
       * 证据标签。只在事实成立时出现；文案与顺序沿用插件详情的既有词汇。
       * @param {object} row - 行模型。
       * @returns {object[]} 标签节点。
       */
      function evidenceOf(row) {
        const tags = []
        if (row.evidence.unowned) {
          tags.push(h('span', { key: 'unowned', className: 'ptTag', 'data-tone': 'warn', title: UNOWNED_REASON }, '未归属'))
        }
        if (row.evidence.uniqueSource) {
          tags.push(h('span', { key: 'unique', className: 'ptTag', 'data-tone': 'user', title: '源码扫描只找到这一个注册者，且注册点在本作用域；按当前扫描范围可视为唯一来源' }, '唯一来源'))
        }
        if (row.evidence.externalOnly) {
          tags.push(h('span', { key: 'scope', className: 'ptTag', 'data-tone': 'warn', title: '首请求不覆盖这段注册' }, '其它作用域'))
        }
        if (row.evidence.derived) {
          tags.push(h('span', { key: 'derived', className: 'ptTag', title: '这段上下文由预演按工作区 / 权限条件推导，不在源码注册点里' }, '推导'))
        }
        if (row.evidence.template) {
          tags.push(h('span', { key: 'template', className: 'ptTag', title: `源码里写的是模板 ${row.rawName}` }, '模板名'))
        }
        if (row.evidence.sameName) {
          tags.push(h('span', { key: 'same', className: 'ptTag', title: '全局注册表里有同名条目，预演展示的是运行时生效不一定是本条' }, '同名'))
        }
        if (row.evidence.noSiteData) {
          tags.push(h('span', { key: 'nodata', className: 'ptTag', 'data-tone': 'warn', title: '旧快照、扫描失败或站点被上限截断' }, '无注册点数据'))
        }
        if (row.evidence.noSite) {
          tags.push(h('span', { key: 'empty', className: 'ptTag', 'data-tone': 'warn', title: '源码扫描没有给出注册点' }, '无注册点'))
        }
        return tags
      }

      /** 一个不可定位贡献的原因；按外部作用域、上下文种类、缺数据逐级解释。 */
      function reasonOf(row, kind) {
        if (row.evidence.unowned) return '这段注入在全局注册表里，但源码扫描没有定位到注册它的插件'
        if (row.evidence.noSiteData) return '这次快照没有带注册点数据，无法判断作用域，上下文预演里也没有这个名字'
        if (row.evidence.externalOnly) {
          const receivers = [...new Set(row.sites.map((site) => site.receiver ?? '未识别'))].join('、')
          return `这段注册挂在 ${receivers} 上，不在首请求上下文预演的 global + preset scope 内`
            + (row.registryRow === undefined ? '' : '，全局注册表里的同名条目来自其它注册点')
        }
        if (kind === 'context') return '这是运行时上下文（消息层注入），可能只在会话或子代理作用域注册'
        return '这个名字只出现在源码扫描里，全局注册表与上下文预演都没有它，可能由模式、会话或条件作用域注册'
      }

      /**
       * 按需读取注册点源码片段。
       *
       * 只在展开本地注册点时才挂载；请求失败不阻塞详情，只把原因显示在片段位置。
       * @param {object} props - `moduleName / kind / name`。
       * @returns {object} React 节点。
       */
      function PromptSnippet({ moduleName, kind, name }) {
        const [state, setState] = useState({ status: 'loading' })
        const [mode, setMode] = useState('focus')
        useEffect(() => {
          let live = true
          if (typeof fetchJson !== 'function' || typeof REGISTRATION_SITE_ROUTE !== 'string') {
            setState({ status: 'unavailable', reason: '当前环境不支持读取源码片段' })
            return undefined
          }
          setState({ status: 'loading' })
          fetchJson(REGISTRATION_SITE_ROUTE, {
            method: 'POST',
            body: JSON.stringify({ moduleName, kind, name, mode }),
          })
            .then((data) => {
              if (!live) return
              if (data?.found === true && Array.isArray(data.sites)) setState({ status: 'ready', sites: data.sites })
              else setState({ status: 'empty', reason: typeof data?.reason === 'string' ? data.reason : '没有找到源码片段' })
            })
            .catch((error) => {
              if (live) setState({ status: 'error', reason: error instanceof Error ? error.message : String(error) })
            })
          return () => { live = false }
        }, [moduleName, kind, name, mode])

        if (state.status === 'loading') return h('p', { className: 'ptSub', style: { margin: '8px 0 0' } }, '读取源码片段…')
        if (state.status !== 'ready') {
          return h('p', { className: 'ptSub', style: { margin: '8px 0 0' } }, state.reason)
        }
        return h(
          'div',
          { style: { marginTop: '8px' } },
          h(
            'p',
            { className: 'ptSub', style: { margin: '0 0 4px' }, title: '来自包源码的静态扫描，不是运行时装配结果' },
            mode === 'file' ? '源码片段（完整文件）' : '源码片段（注册点前后 16 行）',
          ),
          h(
            'div',
            { className: 'ptSubBlocks' },
            state.sites.map((site) => h(
              'div',
              { key: `${site.file}-${site.line}` },
              h(
                'p',
                { className: 'ptSub', style: { margin: '0 0 4px' } },
                h('code', null, `${site.file}:${site.line}`),
                site.receiver === undefined ? null : ' · 接收者 ' + site.receiver,
              ),
              h('pre', { className: 'ptPromptText' }, site.snippet?.text ?? ''),
              site.snippet?.truncated === true
                ? h('p', { className: 'ptSub', style: { margin: '4px 0 0' } }, '片段已按大小上限截断')
                : null,
            )),
          ),
          h(
            'p',
            { style: { margin: '6px 0 0' } },
            textButton(
              mode === 'file' ? '只看注册点' : '查看完整文件',
              () => setMode(mode === 'file' ? 'focus' : 'file'),
              { title: mode === 'file' ? '回到注册点前后的短窗口' : '读取整份文件（有独立大小上限）' },
            ),
          ),
        )
      }

      /**
       * 二级展开：何时展示、注册点与源码片段。
       *
       * 默认收起；只有用户主动展开才挂载 `PromptSnippet`，避免一打开详情就为一堆
       * 名字发请求。未归属行没有可读的包，不挂片段请求。
       * @param {object} props - 原因、站点与源码定位信息。
       * @returns {object} React 节点。
       */
      function PromptSource({ reason, sites, moduleName, kind, rawName, hasSiteData }) {
        const [open, setOpen] = useState(false)
        const canReadCode = typeof moduleName === 'string' && moduleName.length > 0
        return h(
          'details',
          {
            className: 'ptFold ptFoldable',
            style: { marginTop: '8px' },
            onToggle: (event) => setOpen(event.currentTarget.open === true),
          },
          h('summary', null, h('span', { className: 'ptSub' }, `何时展示 / 注册点与源码（${sites.length} 个注册点）`)),
          open
            ? h(
                'div',
                { className: 'ptSubBlocks', style: { marginTop: '6px' } },
                h('p', { className: 'ptSub', style: { margin: '0 0 6px' } }, reason),
                hasSiteData === false
                  ? h('p', { className: 'ptSub', style: { margin: '0 0 6px' } }, '没有注册点数据（旧快照、扫描失败或站点被上限截断）。')
                  : null,
                sites.length
                  ? sites.map((site) => h(
                      'p',
                      { key: `${site.file}-${site.line}`, className: 'ptSub', style: { margin: 0 } },
                      '注册点 ',
                      h('code', null, `${site.file}:${site.line}`),
                      ' · 接收者 ',
                      h('code', null, site.receiver ?? '未识别'),
                      ' · ',
                      h('span', { className: 'ptTag' }, RECEIVER_LABELS[site.receiverKind] ?? '作用域未知'),
                    ))
                  : null,
                canReadCode && sites.length > 0
                  ? h(PromptSnippet, { moduleName, kind, name: rawName })
                  : null,
              )
            : null,
        )
      }

      /**
       * 一条注入贡献。
       *
       * 摘要回答「这个落点是什么、可不可定位、有多少注册点」，展开回答「注入了什么
       * 文本、为什么这样判断」。名字可以是跳转按钮（插件详情 → 上下文注入），
       * 也可只是文本（已经站在上下文注入段里）。
       * @param {object} props - `row / moduleName / hasSiteData / onPreview / onSearch / onNameClick / focused`。
       * @returns {object} React 节点。
       */
      function PromptFold({ row, moduleName, hasSiteData, onPreview, onSearch, onNameClick, focused }) {
        const [open, setOpen] = useState(false)
        const text = row.text ?? { kind: 'none' }
        const nameNode = typeof onNameClick === 'function'
          ? h('button', {
              type: 'button',
              className: 'ptPromptName ptLink',
              title: '在插件能力面 · 上下文注入查看这个插件名下的注入',
              onClick: (event) => {
                event.preventDefault()
                event.stopPropagation()
                onNameClick()
              },
            }, row.display)
          : h('span', { className: 'ptPromptName' }, row.display)
        return h(
          'li',
          null,
          h(
            'details',
            {
              className: 'ptPromptBlock ptFold ptFoldable',
              ...(focused === true ? { open: true, 'data-surface-focus': 'true' } : {}),
              onToggle: (event) => setOpen(event.currentTarget.open === true),
            },
            h(
              'summary',
              {
                title: row.evidence.unowned || text.kind === 'registry'
                  ? '来自全局注册表的装配结果；源码扫描没有定位到注册者'
                  : '来自包源码的静态扫描，不是模型在当前首请求里实际收到的正文',
              },
              nameNode,
              ...evidenceOf(row),
              row.linkable && typeof onPreview === 'function'
                ? textButton(
                    '预演',
                    (event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      onPreview(row.target ?? row.display, row.kind)
                    },
                    { title: '在上下文预演中查看这个落点' },
                  )
                : null,
              rowEnd(
                h('span', { className: 'ptCount', title: '源码里的注册点数量' }, `注册点 ${row.sites.length}`),
              ),
            ),
            open || focused === true
              ? h(
                  'div',
                  { style: { padding: '10px 12px' } },
                  textBodyOf(text),
                  text.kind === 'registry'
                    ? h('p', { className: 'ptSub', style: { margin: '4px 0 0' }, title: '来自全局注册表的装配结果，不是源码字面量' }, '正文来源：全局注册表装配文本')
                    : null,
                  text.truncated === true
                    ? h('p', { className: 'ptSub', style: { margin: '4px 0 0' } }, '文本已截断')
                    : null,
                  row.linkable || typeof onSearch !== 'function'
                    ? null
                    : h(
                        'p',
                        { style: { margin: '6px 0 0' } },
                        textButton('去预演中搜索同名段', onSearch, { title: '跳到预演页尝试查找本段' }),
                      ),
                  h(PromptSource, {
                    reason: reasonOf(row, row.kind),
                    sites: row.sites,
                    moduleName,
                    kind: row.kind,
                    rawName: row.rawName,
                    hasSiteData,
                  }),
                )
              : null,
          ),
        )
      }

      /**
       * 注入正文的三种形态：可读文本 / 运行时表达式 / 没有正文。
       * @param {object} text - `promptTextOf` 的结果。
       * @returns {object} React 节点。
       */
      function textBodyOf(text) {
        if (text.kind === 'literal' || text.kind === 'constant' || text.kind === 'registry') {
          if (typeof text.value === 'string' && text.value.length > 0) {
            return h('pre', { className: 'ptPromptText' }, text.value)
          }
          return h(
            'p',
            { className: 'ptSub', style: { margin: 0 }, title: '这段注册的 text 是空字符串；真实装配时不会给模型带来正文' },
            '暂无注入文本：这段注册的 text 是空字符串。',
          )
        }
        if (text.kind === 'runtime') {
          return h(
            React.Fragment,
            null,
            h('p', { className: 'ptSub', style: { margin: 0 } }, '运行时求值：', h('code', null, text.expression ?? '')),
            h(
              'p',
              { className: 'ptSub', style: { margin: '4px 0 0' }, title: 'DSH 在 assemble() 时才调用 text 函数或者读取运行时变量' },
              '这段文本是函数或运行时表达式，由 DSH 在真实会话 / 子代理创建时计算',
            ),
          )
        }
        if (text.registryProvider === true) {
          return h(
            'p',
            { className: 'ptSub', style: { margin: 0 }, title: '全局注册表把这一段标记为运行时求值，但没有给出可读文本' },
            '注册表标记为运行时求值，没有可读正文。',
          )
        }
        return h(
          'p',
          { className: 'ptSub', style: { margin: 0 }, title: '源码扫描没有在这个注册对象里找到 text 字段；可能是扫描盲区，也可能这段注册本来就不带正文' },
          '暂无可解析的注入文本：源码里没有找到 text 字段，可能是扫描不到注册点。',
        )
      }

      return {
        templateMatches,
        concreteNameOf,
        sitesFor,
        displayNameOf,
        promptTextOf,
        promptRowOf,
        promptRowsOf,
        registryContributionsOf,
        promptGroupsOf,
        evidenceOf,
        reasonOf,
        PromptSnippet,
        PromptSource,
        PromptFold,
      }
    }
  },
})
