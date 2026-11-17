/**
 * 通用二次操作弹窗：标题、说明、可选输入控件与确认/取消。
 *
 * 用 fixed 覆盖层而不是面板内的卡片：二次操作要打断当前动作，留在文流里
 * 容易被当成又一段说明滚过去。Esc、点遮罩与「取消」都算取消；没有输入控件时
 * 默认焦点落在「取消」上——危险动作不该一按回车就执行。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.dialog.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.dialog.js',
  factory: (require) => {
    const React = require('react')
    const { createElement: h } = React

    /**
     * 渲染一个弹窗。
     * @param {object} options - 弹窗内容。
     * @param {string} options.id - 标题节点 id，供 `aria-labelledby` 引用。
     * @param {string} options.title - 弹窗标题。
     * @param {string} options.detail - 影响说明。
     * @param {object} [options.body] - 输入控件；没有时默认焦点落在「取消」。
     * @param {string} options.confirmLabel - 确认按钮文字。
     * @param {boolean} [options.danger] - 确认按钮是否是危险动作。
     * @param {boolean} [options.confirmDisabled] - 是否禁用确认。
     * @param {Function} options.onConfirm - 确认回调。
     * @param {Function} options.onCancel - 取消回调。
     * @returns {object} React 节点。
     */
    function renderDialog(options) {
      const { id, title, detail, body, confirmLabel, danger, confirmDisabled, onConfirm, onCancel } = options
      return h(
        'div',
        {
          className: 'ptModalOverlay',
          onClick: onCancel,
          onKeyDown: (event) => {
            if (event.key === 'Escape') onCancel()
          },
        },
        h(
          'div',
          {
            className: 'ptModal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': id,
            onClick: (event) => event.stopPropagation(),
          },
          h('p', { className: 'ptModalTitle', id }, title),
          h('p', { className: 'ptHint', style: { margin: 0 } }, detail),
          body ?? null,
          h(
            'div',
            { className: 'ptModalActions' },
            h('button', { type: 'button', className: 'ptBtn', autoFocus: body === undefined, onClick: onCancel }, '取消'),
            h(
              'button',
              {
                type: 'button',
                className: 'ptBtn',
                'data-tone': danger === true ? 'danger' : undefined,
                disabled: confirmDisabled === true,
                onClick: onConfirm,
              },
              confirmLabel,
            ),
          ),
        ),
      )
    }

    return { renderDialog }
  },
})
