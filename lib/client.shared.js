/** 插件控制台 client 半的共享工具箱：路由常量、归一/格式化、请求与原子节点。 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-console',
  chunk: 'client.shared.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect, useState } = React

    /** 侧边栏入口与主面板共享的 id。 */
    const PANEL_ID = 'plugin-console'
    /** 快照路由，相对于应用 base。 */
    const SNAPSHOT_ROUTE = 'api/plugin-console/snapshot'
    /** 预测装配路由。 */
    const PREVIEW_ROUTE = 'api/plugin-console/preview'
    /** 提示词模板列表路由。 */
    const TEMPLATES_ROUTE = 'api/plugin-console/templates'
    /** 单提示词模板路由。 */
    const TEMPLATE_ROUTE = 'api/plugin-console/template'
    /** 把提示词模板物化到一个会话的路由。 */
    const APPLY_ROUTE = 'api/plugin-console/apply'
    /** 每会话启用开关路由。 */
    const ACTIVATION_ROUTE = 'api/plugin-console/activation'
    /** 清除提示词定制模板快照数据路由：按工作区清绑定，或清空全部。 */
    const CLEANUP_ROUTE = 'api/plugin-console/cleanup'
    /** 单会话实际请求摘要路由（按会话懒读取）。 */
    const SESSION_INFLUENCE_ROUTE = 'api/plugin-console/session-influence'
    const ACTIVITY_ROUTE = 'api/plugin-console/activity'
    const IMPACT_ROUTE = 'api/plugin-console/impact'
    const CONTROL_ROUTE = 'api/plugin-console/control'
    const OPERATIONS_ROUTE = 'api/plugin-console/operations'

    /** 内置模式的本地化名；自定义模式回退到它自己声明的 name，再回退到 id。 */
    const BUILTIN_MODE_LABELS = {
      standard: '标准模式',
      ptc: 'PTC 模式',
      minimal: '极简模式',
      cordis: '创造模式',
    }

    /** 面板外观：跟随 DSH、固定明亮、固定夜间。 */
    const THEMES = ['follow', 'light', 'dark']
    /** 外观偏好的本地存储键；只作用于本面板，不写宿主存储域。 */
    const THEME_STORAGE_KEY = 'dsh-plugin-console/theme'

    /**
     * 把任意存储值归一成受支持的外观。
     *
     * 旧版本、手改存储或私密窗口都可能给到别的值；退回「跟随 DSH」而不是报错，
     * 因为外观只是显示偏好，不值得让面板失去颜色。
     * @param {unknown} value - 存储里的原始值。
     * @returns {'follow' | 'light' | 'dark'} 受支持的外观。
     */
    function normalizeTheme(value) {
      return THEMES.includes(value) ? value : 'follow'
    }

    /** 读一次已保存的外观；存储不可用（私密窗口、禁 cookie）时退回跟随。 */
    function storedTheme() {
      try {
        if (typeof window === 'undefined' || window.localStorage === undefined) return 'follow'
        return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY))
      } catch {
        return 'follow'
      }
    }

    /**
     * 外观偏好：读取、切换并写回本地存储。
     *
     * 存储写入失败只影响「下次是否记得」，不影响本次切换，所以吞掉异常。
     * @returns {[string, Function]} `[theme, setTheme]`。
     */
    function useThemePreference() {
      const [theme, setTheme] = useState(storedTheme)
      useEffect(() => {
        try {
          if (typeof window === 'undefined' || window.localStorage === undefined) return
          window.localStorage.setItem(THEME_STORAGE_KEY, normalizeTheme(theme))
        } catch {
          // 存储不可用：本次切换仍然生效，只是不会记住。
        }
      }, [theme])
      return [theme, setTheme]
    }

    /** 插件能力类别：面向用户的问法，而不是包的命名。 */
    const CATEGORY_LABELS = {
      tool: '工具',
      ui: '界面',
      model: '模型',
      session: '会话与时序',
      safety: '安全与权限',
      transport: '传输与网关',
      extend: '扩展能力',
      client: '客户端内核',
      infra: '宿主基础设施',
      structure: '结构行',
      other: '其他',
    }

    /** 短名：优先本地化标题，其次去掉 scope 与前缀的模块名。 */
    function shortName(entry) {
      if (entry.moduleName && entry.moduleName.startsWith('cordis:')) {
        return entry.moduleName === 'cordis:include' ? '包含根（include）' : `分组（${entry.moduleName.slice(7)}）`
      }
      if (entry.title) return entry.title
      const raw = entry.packageName ?? entry.moduleName ?? entry.entryId
      return String(raw)
        .replace(/^@[^/]+\//, '')
        .replace(/^dsh-(client-ui-|client-|host-|api-|tool-)?/, '')
        .replace(/^cordis-plugin-/, '')
    }

    /** 结构行（cordis:include 等）不是插件，不参与状态与依赖展示。 */
    function isStructural(entry) {
      return typeof entry.moduleName === 'string' && entry.moduleName.startsWith('cordis:')
    }

    /** 焦点在输入类元素里时，全局快捷键不该抢走按键。 */
    function isTypingTarget(target) {
      if (target === null || target === undefined) return false
      const tag = target.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
    }

    /** 模式的展示名。 */
    function modeTitle(mode) {
      return BUILTIN_MODE_LABELS[mode.id] ?? mode.name ?? mode.id
    }

    /** 模式行里的模块短名。 */
    function shortModule(moduleName) {
      return String(moduleName)
        .replace(/^@[^/]+\//, '')
        .replace(/^dsh-(client-ui-|client-|host-|api-|tool-)?/, '')
        .replace(/^cordis:/, 'cordis:')
        .replace(/^cordis-plugin-/, '')
    }

    /** 层级归属的展示名。 */
    function layerLabel(layer) {
      if (!layer) return 'profile'
      if (layer === 'cordis') return 'cordis 结构行'
      if (layer === 'runtime') return '运行时挂载'
      if (layer === 'mode') return '模式挂载'
      return layer.replace(/^@[^/]+\//, '')
    }

    /**
     * 一次 JSON 请求。
     *
     * 只用于提示词模板路由：它们返回 5xx 时也带 JSON body，所以先读 body 再判状态，
     * 这样错误信息能原样透出而不是变成「HTTP 500」。
     * @param {string} route - 相对路由。
     * @param {object} [init] - fetch 选项。
     * @returns {Promise<object>} 解析后的 JSON。
     */
    async function fetchJson(route, init) {
      const response = await fetch(new URL(route, document.baseURI).href, {
        credentials: 'same-origin',
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      })
      const data = await response.json()
      if (!response.ok || data.error !== undefined) throw new Error(data.error ?? 'HTTP ' + response.status)
      return data
    }

    /** 一次快照读取。 */
    async function fetchSnapshot() {
      const url = new URL(SNAPSHOT_ROUTE, document.baseURI)
      const response = await fetch(url.href, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`快照读取失败（HTTP ${response.status}）`)
      return await response.json()
    }

    /** 详情里的一行事实；`title` 是字段名的一句话解释，悬停即见。 */
    function fact(label, value, title) {
      if (value === undefined || value === null || value === '') return null
      return h(React.Fragment, { key: label }, h('dt', { title }, label), h('dd', null, value))
    }

    /** 依赖列表：键 + 若干条目。 */
    function depList(items) {
      if (!items.length) return h('div', { className: 'ptDepValue' }, '（无）')
      return h('ul', { className: 'ptDepList' }, items.map((item) => h('li', { key: item.key }, item.node)))
    }

    /** 依赖里的运行时条目 id 压缩成短名。 */
    function shortId(entryId, byId) {
      const entry = byId.get(entryId)
      return entry ? shortName(entry) : entryId
    }

    /** 判断一个带 owners 的行是否通过当前来源筛选。 */
    function passesOwner(row, toolOwner) {
      if (toolOwner === null) return true
      const owners = row.owners ?? []
      if (toolOwner === '__none') return owners.length === 0
      return owners.includes(toolOwner)
    }

    /**
     * 一个可切换的筛选胶囊。
     * @param {string} label - 显示文本。
     * @param {boolean} active - 是否选中。
     * @param {Function} onClick - 点击回调。
     * @returns {object} React 节点。
     */
    function chip2(label, active, onClick) {
      return h(
        'button',
        { key: label, type: 'button', className: 'ptChip', 'aria-pressed': active ? 'true' : 'false', onClick },
        label,
      )
    }

    function formatBytes(bytes) {
      if (!bytes) return '0B'
      if (bytes < 1024) return `${bytes}B`
      return `${(bytes / 1024).toFixed(1)}KB`
    }

    /**
     * 主标签按钮。
     *
     * 数字是这一栏的总量，让「值不值得点进去」在点之前就能判断；
     * 左右方向键在同一组标签之间移动并切换，和原生 tablist 的预期一致。
     * @param {string} id - 视图 id。
     * @param {string} label - 显示名。
     * @param {string} current - 当前视图 id。
     * @param {Function} set - 切换视图。
     * @param {number} [count] - 可选的计数。
     * @param {object} [opts] - `{ prefix, controls }`：次级标签用另一套 id 前缀，避免与主标签撞 id。
     * @returns {object} React 节点。
     */
    function tabButton(id, label, current, set, count, opts) {
      const selected = current === id
      const domId = (opts?.prefix ?? 'pt-tab-') + id
      const controls = opts?.controls === undefined ? (opts?.prefix === undefined ? 'pt-panel' : undefined) : opts.controls
      return h(
        'button',
        {
          type: 'button',
          className: 'ptTab',
          role: 'tab',
          id: domId,
          'aria-selected': selected ? 'true' : 'false',
          'aria-controls': controls,
          tabIndex: selected ? 0 : -1,
          onClick: () => set(id),
          onKeyDown: (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            const buttons = [...event.currentTarget.parentElement.querySelectorAll('.ptTab')]
            if (!buttons.length) return
            const at = buttons.indexOf(event.currentTarget)
            const next = event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (at + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
            event.preventDefault()
            buttons[next].focus()
            buttons[next].click()
          },
        },
        label,
        count !== undefined && count !== null ? h('span', { className: 'ptTabCount' }, String(count)) : null,
      )
    }

    /** 会话 id 略缩：保留可辨识的前后段。 */
    function formatSessionId(id) {
      const text = String(id)
      if (text.length <= 32) return text
      return text.slice(0, 18) + '…' + text.slice(-6)
    }

    /**
     * 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期。
     * @param {number} timestamp - 毫秒时间戳。
     * @returns {string} 可读的相对时间。
     */
    function formatAge(timestamp) {
      const delta = Date.now() - timestamp
      if (!Number.isFinite(delta) || delta < 0) return formatTime(new Date(timestamp).toISOString())
      const minutes = Math.floor(delta / 60000)
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return minutes + ' 分钟前'
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return hours + ' 小时前'
      const days = Math.floor(hours / 24)
      if (days < 30) return days + ' 天前'
      return formatTime(new Date(timestamp).toISOString())
    }

    /** 时间戳的本地化展示；解析失败时原样返回。 */
    function formatTime(iso) {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso
      return date.toLocaleString()
    }

    /**
     * 一个带标题的下拉筛选。
     *
     * 之前每个筛选维度都是一排胶囊：类别 10 个、来源 5 个、状态 4 个，
     * 210 个插件的页面因此先被筛选条占掉三行。下拉把「当前选了什么」和
     * 「有哪些可选项」分开，默认只占一个控件的宽度。
     * @param {string} label - 控件前的说明文字。
     * @param {string | null} value - 当前值；null 归一成空串（= 全部）。
     * @param {Array<{value: string, label: string, disabled?: boolean}>} options - 选项。
     * @param {Function} onChange - 值变化回调，收到原始字符串。
     * @param {object} [opts] - `{ title, disabled }`。
     * @returns {object} React 节点。
     */
    function selectField(label, value, options, onChange, opts) {
      return h(
        'label',
        { className: 'ptField', title: opts?.title },
        label ? h('span', { className: 'ptFieldLabel' }, label) : null,
        h(
          'select',
          {
            className: 'ptSelect',
            value: value ?? '',
            disabled: opts?.disabled === true,
            'aria-label': label ?? opts?.title,
            onChange: (event) => onChange(event.target.value),
          },
          options.filter(Boolean).map((option) =>
            h('option', { key: option.value, value: option.value, disabled: option.disabled === true }, option.label),
          ),
        ),
      )
    }

    /**
     * 无边框的文字按钮，用于「展开全部」「重命名」「返回」这类次要动作。
     * @param {string} label - 显示文本。
     * @param {Function} onClick - 点击回调。
     * @param {object} [opts] - `{ title, tone, disabled }`。
     * @returns {object} React 节点。
     */
    function textButton(label, onClick, opts) {
      return h(
        'button',
        {
          type: 'button',
          className: 'ptTextBtn',
          'data-tone': opts?.tone,
          title: opts?.title,
          disabled: opts?.disabled === true,
          onClick,
        },
        label,
      )
    }

    /**
     * 一个开关。用于「每会话提示词模板是否生效」与「物化后自动发送」。
     *
     * 用 `role="switch"` 而不是把状态塞进文案：文案会跟着状态变长变短，
     * 按钮宽度一跳，整行都在晃。开关的视觉状态与 `aria-checked` 保持一致。
     * @param {boolean} checked - 是否开启。
     * @param {string} label - 开关后的说明文字。
     * @param {Function} onClick - 点击回调。
     * @param {object} [opts] - `{ title, disabled }`。
     * @returns {object} React 节点。
     */
    function switchButton(checked, label, onClick, opts) {
      return h(
        'button',
        {
          type: 'button',
          className: 'ptSwitch',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          title: opts?.title,
          disabled: opts?.disabled === true,
          onClick,
        },
        h('span', { className: 'ptSwitchTrack', 'aria-hidden': 'true' }, h('span', { className: 'ptSwitchKnob' })),
        label ? h('span', { className: 'ptSwitchLabel' }, label) : null,
      )
    }

    /**
     * 一行用「·」分隔的次要信息。比一排彩色标签安静，也更省横向空间。
     * @param {Array<object | string | null | undefined>} parts - 片段。
     * @param {boolean} [wrap] - 允许在窄屏折行（页内摘要用）；行内元信息保持单行。
     * @returns {object} React 节点。
     */
    function inlineMeta(parts, wrap) {
      const visible = parts.filter((part) => part !== null && part !== undefined && part !== false)
      return h(
        'span',
        { className: wrap ? 'ptMeta ptMetaWrap' : 'ptMeta' },
        visible.map((part, index) =>
          h(
            React.Fragment,
            { key: index },
            index === 0 ? null : h('span', { className: 'ptMetaSep' }, '·'),
            part,
          ),
        ),
      )
    }

    /**
     * 一行末尾的读数簇。
     *
     * 数量、长度、序号与时间统一靠右，且不再用胶囊包数字：左边只回答「这是什么」，
     * 右边回答「多少」。空簇返回 null，不占一行。
     * @param {...object} children - 读数节点。
     * @returns {object | null} 右簇。
     */
    function rowEnd(...children) {
      const visible = children.filter((child) => child !== null && child !== undefined && child !== false)
      return visible.length === 0 ? null : h('span', { className: 'ptEnd' }, visible)
    }

    /** 结果行：「显示 37 / 210」。unit 用于补「个会话」这类量词。 */
    function resultText(shown, total, unit) {
      return h('span', { className: 'ptResult' }, '显示 ', h('b', null, String(shown)), ' / ' + String(total) + (unit ?? ''))
    }

    /** 一次性展开或收起 `<details>`：details 的开关归浏览器，用 DOM 改比造受控状态更合适。 */
    function setDetailsOpen(nodes, open) {
      for (const node of nodes) {
        if (open) node.setAttribute('open', '')
        else node.removeAttribute('open')
      }
    }

    /**
     * 当前面板里的可折叠块。
     *
     * 默认返回所有 `ptFoldable`；传 selector 可以只作用于某一组（例如请求结构里的
     * `details.ptRawBlock`），避免「折叠全部」误伤同页其它折叠块。
     * @param {string} [selector] - CSS 选择器。
     * @returns {NodeList | Array} 可折叠节点。
     */
    function foldNodes(selector = '.ptBody details.ptFoldable') {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return []
      return document.querySelectorAll(selector)
    }

    /** 让可点的非按钮容器响应键盘：Enter / Space 等价于点击。 */
    function activateOnKey(event, action) {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      action()
    }

    /**
     * 在折叠集合里切换一个 key。
     *
     * 集合是 state，必须换新引用才会触发重渲染；就地 add/delete 不会。
     * @param {Function} setter - 该集合的 setState。
     * @param {string} key - 要切换的 key。
     */
    function toggleIn(setter, key) {
      setter((previous) => {
        const next = new Set(previous)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    }

    /**
     * 一次性折叠或展开所有分组。
     * @param {Function} setter - 折叠集合的 setState。
     * @param {Array<string>} keys - 所有分组 key。
     * @param {boolean} collapse - true 表示全部折叠。
     */
    function setAll(setter, keys, collapse) {
      setter(() => new Set(collapse ? keys : []))
    }

    /**
     * 浏览器时区。
     *
     * 模型看到的 time-context 用它解释未限定时区的时间；拿不到就不上报，
     * 由宿主退回服务端时区并在结果里标「推测」。预演页与定制页都要用同一份。
     * @returns {string | undefined} IANA 时区名。
     */
    function browserTimeZone() {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
      } catch {
        return undefined
      }
    }

    return function createShared() {
      // 视图壳只需要这一份原子集合；各视图 chunk 共用同一个对象。
      // 顶层导出与它大部分重合，只额外带上路由常量与模式标签，所以先建这份再展开。
      const viewHelpers = {
        h,
        React,
        shortName,
        isStructural,
        isTypingTarget,
        modeTitle,
        shortModule,
        layerLabel,
        fetchJson,
        fetchSnapshot,
        ACTIVITY_ROUTE,
        IMPACT_ROUTE,
        CONTROL_ROUTE,
        OPERATIONS_ROUTE,
        fact,
        depList,
        shortId,
        passesOwner,
        chip2,
        selectField,
        textButton,
        switchButton,
        inlineMeta,
        resultText,
        rowEnd,
        setDetailsOpen,
        foldNodes,
        formatBytes,
        tabButton,
        formatSessionId,
        formatAge,
        formatTime,
        activateOnKey,
        toggleIn,
        setAll,
        browserTimeZone,
        useThemePreference,
        normalizeTheme,
        THEMES,
        CATEGORY_LABELS,
      }
      return {
        ...viewHelpers,
        PANEL_ID,
        SNAPSHOT_ROUTE,
        PREVIEW_ROUTE,
        TEMPLATES_ROUTE,
        TEMPLATE_ROUTE,
        APPLY_ROUTE,
        ACTIVATION_ROUTE,
        CLEANUP_ROUTE,
        SESSION_INFLUENCE_ROUTE,
        BUILTIN_MODE_LABELS,
        helpers: viewHelpers,
      }
    }
  },
})
