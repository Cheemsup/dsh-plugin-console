/**
 * host 半的常量镜像。
 *
 * 这里只有「读代码的人需要知道、但运行时不一定拿得到」的东西：Cordis 的状态
 * 枚举是跨包 const enum（没有运行时对象可 import），路由路径必须是字面量。
 * @module dsh-plugin-console/host/constants
 */

/** Fiber 状态常量镜像：cordis 的 FiberState 是跨包 const enum。 */
export const FIBER_STATE = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
}

/** Fiber 状态到公共阶段词汇的映射；已销毁折叠为 null。 */
export const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.UNLOADING]: 'unloading',
  [FIBER_STATE.DISPOSED]: null,
}

/** 预测装配路由路径。 */
export const PREVIEW_PATH = '/api/plugin-console/preview'

/** 快照路由路径。 */
export const SNAPSHOT_PATH = '/api/plugin-console/snapshot'

/** 模板列表路由。 */
export const TEMPLATES_PATH = '/api/plugin-console/templates'

/** 单模板路由（含 revision 列表）。 */
export const TEMPLATE_PATH = '/api/plugin-console/template'

/** 把模板应用到一个会话。 */
export const APPLY_PATH = '/api/plugin-console/apply'

/** 每会话的启用开关：查询与切换。 */
export const ACTIVATION_PATH = '/api/plugin-console/activation'

/** 单会话的实际请求摘要（读 session log，按会话懒取）。 */
export const SESSION_INFLUENCE_PATH = '/api/plugin-console/session-influence'

/** 最近一段时间的工具活动（读 session log，按时间窗与会话数限制）。 */
export const ACTIVITY_PATH = '/api/plugin-console/activity'

/** 控制前的影响预览。 */
export const IMPACT_PATH = '/api/plugin-console/impact'

/** 执行一次控制（全局启停 / 会话掩码）。 */
export const CONTROL_PATH = '/api/plugin-console/control'

/** 最近的控制审计。 */
export const OPERATIONS_PATH = '/api/plugin-console/operations'

/** 清理模板数据：按工作区清绑定，或清空全部并删除存储文件。 */
export const CLEANUP_PATH = '/api/plugin-console/cleanup'

/** 失败 fiber 的诊断读取上限，避免单个挂起的 fiber 拖住整次快照。 */
export const DIAGNOSTIC_TIMEOUT_MS = 250
