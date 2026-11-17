/**
 * 工作区选择控件：已创建的工作区下拉 + 「新建工作区…」。
 *
 * 工作区是首请求的条件。已创建的工作区直接选；「新建工作区…」打开系统文件夹选择器，
 * 选中后通过 DSH 的 `workspaces.create({ path })` 幂等登记（与 DSH 自己的「添加工作区」
 * 同一条路径），再把该路径作为条件。插件不把这项能力放进 `inject`：选择器缺席时下拉
 * 仍然可用，只是新建会失败并写原因。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.workspace-picker.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.workspace-picker.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useState } = React

    return function create() {
      /** 「新建工作区…」只用于触发选择器，不是可停留的选项。 */
      const NEW_WORKSPACE = '__pt_new_workspace__'

      /**
       * 读一个客户端服务。插件没有 inject 这些服务：缺席时只是少一个入口。
       * @param {object | null} ctx - 浏览器插件上下文。
       * @param {string} name - 服务名。
       * @returns {unknown} 服务实例或 undefined。
       */
      function serviceOf(ctx, name) {
        try {
          return typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name]
        } catch {
          return undefined
        }
      }

      /**
       * 取 DSH 自己的目录选择能力。
       *
       * 优先用 `uiWorkspace.pickDirectory()`——它就是「添加工作区」走的同一条路径，
       * 错误与取消语义已经处理好；服务缺席时再退到 `remote.directoryPicker.pick()`。
       * @param {object | null} ctx - 浏览器插件上下文。
       * @returns {object | null} `{ pick: () => Promise<string | null> }`。
       */
      function directoryPickerOf(ctx) {
        const uiWorkspace = serviceOf(ctx, 'uiWorkspace')
        if (typeof uiWorkspace?.pickDirectory === 'function') {
          return { pick: () => uiWorkspace.pickDirectory() }
        }
        const picker = serviceOf(ctx, 'remote')?.directoryPicker
        if (typeof picker?.pick === 'function') {
          return {
            pick: async () => {
              const result = await picker.pick()
              if (result?.ok !== true) throw new Error(result?.error?.message ?? '目录选择失败')
              return result.value
            },
          }
        }
        return null
      }

      /**
       * 「新建工作区」的完整动作：打开选择器 → 幂等登记 → 返回路径。
       *
       * 取消返回 null（不是错误）；登记失败把原因留在 `error` 里。一次只允许一个
       * 选择器在跑：原生对话框无法从浏览器关闭，重复点击只会叠出多个。
       * @param {object | null} runtimeCtx - 浏览器插件上下文。
       * @returns {object} `{ pick, busy, error }`。
       */
      function useWorkspacePicker(runtimeCtx) {
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState(null)
        const pick = useCallback(async () => {
          if (busy) return null
          const picker = directoryPickerOf(runtimeCtx)
          if (picker === null) {
            setError('目录选择器不可用：无法新建工作区')
            return null
          }
          setBusy(true)
          setError(null)
          try {
            const picked = await picker.pick()
            if (typeof picked !== 'string' || picked.length === 0) return null
            // 幂等：目录已经是工作区时，Host 直接返回那一个。
            const workspaces = serviceOf(runtimeCtx, 'workspaces')
            if (typeof workspaces?.create === 'function') {
              try {
                await workspaces.create({ path: picked })
              } catch (cause) {
                throw new Error('新建工作区失败：' + (cause instanceof Error ? cause.message : String(cause)))
              }
            }
            return picked
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
            return null
          } finally {
            setBusy(false)
          }
        }, [runtimeCtx, busy])
        return { pick, busy, error }
      }

      /**
       * 比较两个路径是否指向同一位置。
       *
       * 宿主按平台口径比较；浏览器拿不到条件的比较键，所以在客户端也做一次，
       * 用于把「刚选中的路径」映射回下拉里的已创建工作区。只归一化分隔符与末尾斜杠，
       * Windows 盘符或 UNC 路径再折成小写——POSIX 路径保持大小写敏感。
       * @param {string} left - 一个路径。
       * @param {string} right - 另一个路径。
       * @returns {boolean} 是否相同。
       */
      function samePath(left, right) {
        const normalize = (value) => String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '')
        const a = normalize(left)
        const b = normalize(right)
        if (a.length === 0 || b.length === 0) return a === b
        const windowsish = /^[a-zA-Z]:/.test(a) || a.startsWith('//')
        return windowsish ? a.toLowerCase() === b.toLowerCase() : a === b
      }

      /**
       * 工作区条件：一个下拉，选项是已创建工作区 + 「新建工作区…」。
       *
       * 当前路径不在下拉里时（刚选完、快照还没刷新，或路径来自旧状态）补一个当前项，
       * 否则受控 select 会显示成别的项。选中「新建工作区…」立即回弹，不等异步结果。
       * @param {string} label - 字段名。
       * @param {string | null} value - 当前条件路径。
       * @param {object[]} workspaces - 已创建工作区。
       * @param {Function} onChange - 选了一个已创建工作区。
       * @param {Function} onNew - 选了「新建工作区…」。
       * @param {object} [opts] - `{ title, busy, error, newLabel, ariaLabel }`。
       * @returns {object} React 节点。
       */
      function workspaceField(label, value, workspaces, onChange, onNew, opts) {
        const current = typeof value === 'string' ? value : ''
        const entries = (workspaces ?? [])
          .filter((workspace) => typeof workspace?.path === 'string' && workspace.path.length > 0)
          .map((workspace) => ({
            value: workspace.path,
            // 没有独立标题时只写路径，不重复成「路径 · 路径」。
            label: typeof workspace.title === 'string' && workspace.title.length > 0 && workspace.title !== workspace.path
              ? workspace.title + ' · ' + workspace.path
              : workspace.path,
          }))
        const matched = entries.find((entry) => samePath(entry.value, current))
        if (current.length > 0 && matched === undefined) {
          entries.unshift({ value: current, label: '当前选择 · ' + current })
        }
        if (current.length === 0) {
          entries.unshift({ value: '', label: '未选择工作区', disabled: true })
        }
        const selected = matched?.value ?? current
        const canCreate = typeof onNew === 'function'
        return h(
          'label',
          { className: 'ptField', title: opts?.title },
          h('span', { className: 'ptFieldLabel' }, label),
          h(
            'select',
            {
              className: 'ptSelect',
              value: selected,
              disabled: opts?.busy === true,
              'aria-busy': opts?.busy === true ? 'true' : undefined,
              'aria-label': opts?.ariaLabel ?? label,
              onChange: (event) => {
                const next = event.target.value
                if (canCreate && next === NEW_WORKSPACE) {
                  // 「新建工作区…」不是可停留的选项：立刻回到当前项，结果由 onNew 决定。
                  event.target.value = selected
                  void onNew()
                  return
                }
                if (next === selected) return
                onChange(next)
              },
            },
            entries.map((entry) => h('option', {
              key: entry.value,
              value: entry.value,
              disabled: entry.disabled === true,
            }, entry.label)),
            canCreate
              ? h('option', { key: NEW_WORKSPACE, value: NEW_WORKSPACE }, opts?.newLabel ?? '新建工作区…')
              : null,
          ),
          opts?.error
            ? h('span', {
                className: 'ptError',
                style: { fontSize: '11px', maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                title: opts.error,
              }, opts.error)
            : null,
        )
      }

      return { workspaceField, samePath, useWorkspacePicker }
    }
  },
})
