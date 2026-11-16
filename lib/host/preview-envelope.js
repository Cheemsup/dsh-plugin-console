/**
 * 请求信封：一条请求自身的元信息——发给哪个 provider / model、窗口多大、带多少工具。
 *
 * 与 sections / tools 分开的理由：它们回答「内容是什么」，信封回答「发给谁、装得下吗」。
 * 页面顶部那行元信息就是它。
 * @module dsh-plugin-console/host/preview-envelope
 */

/**
 * @param {object} assembly - `previewAssembly()` 的结果。
 * @param {object} conditions - `resolveConditions()` 的结果。
 * @returns {object} `{ provider, model, contextWindow, toolCount, toolSchemaChars, confidence, unknown }`。
 */
export function previewEnvelope(assembly, conditions) {
  const provider = conditions?.model?.provider ?? null
  const model = conditions?.model?.model ?? null
  const contextWindow = typeof conditions?.contextWindow === 'number' ? conditions.contextWindow : null
  const unknown = []
  if (provider === null || model === null) unknown.push('model')
  if (contextWindow === null) unknown.push('contextWindow')
  return {
    provider,
    model,
    contextWindow,
    toolCount: assembly?.stats?.tools ?? 0,
    toolSchemaChars: assembly?.stats?.toolSchemaChars ?? 0,
    // 工具与段来自实测的装配结果，模型与窗口来自服务推导；只要有一项未知就整体标未知。
    confidence: unknown.includes('model') ? 'unknown' : 'derived',
    unknown,
  }
}
