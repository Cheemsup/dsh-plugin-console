/**
 * 快照：GET → 整份插件树投影（含模板绑定）。
 * @module dsh-plugin-console/host/routes/snapshot
 */

import { jsonOk } from '../http.js'
import { readSnapshot } from '../snapshot.js'
import { snapshotExtras } from '../templates/repository.js'

/**
 * @param {object} ctx - host 插件上下文。
 * @param {object} templateState - 模板存储状态。
 * @returns {Function} fetch 处理函数。
 */
export function createSnapshotRoute(ctx, templateState) {
  return async () => {
    // 模板存储不可用时只丢绑定信息，不连累其余四个视图。
    const extras = await snapshotExtras(ctx, templateState)
    return jsonOk(await readSnapshot(ctx, extras))
  }
}
