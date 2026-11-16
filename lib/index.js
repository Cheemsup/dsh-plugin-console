/**
 * 插件控制台 host 半：投影当前 profile 组合出的 Cordis 插件树，并提供模板的读写与应用。
 *
 * 数据来源全部是宿主已有的只读事实：
 *   - `ctx.loader.entries()`：Loader 条目、fiber 阶段、服务需求与提供；
 *   - `pluginManager.listBundles()`：每个组合包插入了哪些行、覆盖了哪些行；
 *   - profile / home 的 `cordis.patch.yml`：用户自己插入或覆盖的行；
 *   - `pluginPackages`：包身份、版本、`dsh.client` 声明、本地化标题。
 *
 * 唯一的对外出口是一组鉴权 Fetch 路由（`/api/plugin-console/snapshot` 等），
 * 与 plugin-manager、session-log-export 使用的注册方式一致。
 *
 * 两处「写」的边界说明：
 *   - **不启用/停用任何插件**，也不改 profile 的 yml——那是 plugin-manager 的事；
 *   - 模板及其每会话开关写在自己的 storage domain（`plugin_console_templates`），
 *     由 storageDomain 落到 `$DSH_HOME/storages`，不碰 session log，也不写 sidecar 文件。
 *
 * 实现分层见 README.md 的「代码结构」：本文件只做「等待 connection → 挂八条路由 → 收尾」。
 * @module dsh-plugin-console
 */

import {
  ACTIVATION_PATH,
  ACTIVITY_PATH,
  APPLY_PATH,
  CLEANUP_PATH,
  CONTROL_PATH,
  IMPACT_PATH,
  OPERATIONS_PATH,
  PREVIEW_PATH,
  SESSION_INFLUENCE_PATH,
  SNAPSHOT_PATH,
  TEMPLATE_PATH,
  TEMPLATES_PATH,
} from './host/constants.js'
import { jsonRoute } from './host/http.js'
import { createActivationRoute } from './host/routes/activation.js'
import { createActivityRoute } from './host/routes/activity.js'
import { createApplyRoute } from './host/routes/apply.js'
import { createCleanupRoute } from './host/routes/cleanup.js'
import { createControlRoute } from './host/routes/control.js'
import { createImpactRoute } from './host/routes/impact.js'
import { createOperationsRoute } from './host/routes/operations.js'
import { createPreviewRoute } from './host/routes/preview.js'
import { createSessionInfluenceRoute } from './host/routes/session-influence.js'
import { createSnapshotRoute } from './host/routes/snapshot.js'
import { createTemplateRoute } from './host/routes/template.js'
import { createTemplatesRoute } from './host/routes/templates.js'
import { installMaskInheritance } from './host/masks.js'
import { installTemplateInheritance } from './host/templates/inheritance.js'
import { closeTemplateStore, createTemplateState } from './host/templates/store.js'

/** 本插件只依赖 Loader；其余服务按需 `ctx.get()`，缺失即降级。 */
export const inject = ['loader']

/** 快照与模板数据的对外入口；复用快照逻辑给别的插件时从这里取。 */
export { readSnapshot } from './host/snapshot.js'
export { previewAssembly } from './host/assembly-preview.js'

/**
 * 注册全部路由。
 *
 * Connection 可能晚于本行就绪，因此用 `ctx.inject` 等待它，而不是在 apply 时直接取。
 * 路由随 scope 释放而撤销。
 * @param {object} ctx - host 插件上下文。
 */
export function apply(ctx) {
  const templateState = createTemplateState()

  ctx.effect(() => () => closeTemplateStore(templateState), 'plugin-console: template storage')

  // 子 Agent 的模板继承不依赖 connection：它监听 agent 注册表，必须在
  // 任何会话启动之前挂上，否则第一批 resume / subagent 会漏掉。
  installTemplateInheritance(ctx, templateState)
  // 掩码监听必须排在模板之后：模板先物化 base，掩码再把 base + mask 合成一份 plan。
  installMaskInheritance(ctx, templateState)

  ctx.inject(['connection'], (scope) => {
    /** 一条路由的通用挂载：路径、方法、请求体形态、处理函数、effect label。 */
    const mount = (path, methods, requestBody, handler, label) => {
      scope.effect(() => scope.connection.fetch.register({
        path,
        methods,
        requestBody,
        fetch: jsonRoute(handler),
      }), label)
    }

    // 预测装配用 POST：这是一次「按选择求值」的计算，不是资源读取。
    mount(PREVIEW_PATH, ['POST'], 'json', createPreviewRoute(ctx), 'plugin-console: preview route')
    mount(SNAPSHOT_PATH, ['GET'], 'buffered', createSnapshotRoute(ctx, templateState), 'plugin-console: snapshot route')
    mount(TEMPLATES_PATH, ['GET', 'POST'], 'buffered', createTemplatesRoute(ctx, templateState), 'plugin-console: templates route')
    mount(TEMPLATE_PATH, ['GET', 'POST', 'DELETE'], 'buffered', createTemplateRoute(ctx, templateState), 'plugin-console: template route')
    mount(APPLY_PATH, ['POST'], 'buffered', createApplyRoute(ctx, templateState), 'plugin-console: apply route')
    mount(ACTIVATION_PATH, ['GET', 'POST'], 'buffered', createActivationRoute(ctx, templateState), 'plugin-console: activation route')
    mount(CLEANUP_PATH, ['POST'], 'buffered', createCleanupRoute(ctx, templateState), 'plugin-console: cleanup route')
    mount(SESSION_INFLUENCE_PATH, ['GET'], 'buffered', createSessionInfluenceRoute(ctx), 'plugin-console: session influence route')
    mount(ACTIVITY_PATH, ['GET'], 'buffered', createActivityRoute(ctx), 'plugin-console: activity route')
    mount(IMPACT_PATH, ['GET'], 'buffered', createImpactRoute(ctx), 'plugin-console: impact route')
    mount(CONTROL_PATH, ['POST'], 'buffered', createControlRoute(ctx, templateState), 'plugin-console: control route')
    mount(OPERATIONS_PATH, ['GET'], 'buffered', createOperationsRoute(ctx, templateState), 'plugin-console: operations route')
  })
}
