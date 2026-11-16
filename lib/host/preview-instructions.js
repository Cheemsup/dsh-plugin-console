/**
 * 预测首请求里的 `agent-instructions` 消息。
 *
 * 这条消息不进系统提示词：它由 `@deepseek-ai/dsh-agent-instructions` 在
 * `agent/pre-step` 里读工作区文件、渲染成一条 user 消息再插进请求。所以预演必须
 * 自己重算一遍，包括发现顺序、去重与字节预算。
 *
 * **这是移植，不是调用 DSH。** 已安装的 DSH 在 `app.asar` 里，ESM 动态导入不可靠，
 * 包的内部文件布局也不是稳定接口。下面的算法抄自已安装版本 `0.2.2-rc.1` 的
 * `lib/index.js`（`render` 与 `files` 两段），逐字正确性由
 * `scripts/fixtures/first-request-dsh.json` 的 19,014 字原文保证。
 *
 * @module dsh-plugin-console/host/preview-instructions
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { readTextFile, statFile } from './fs.js'
import { hostModuleResolver } from './preview-modules.js'

/** 这条 pre-step 监听的包名；是否启用由 {@link hostModuleResolver} / `resolveModules()` 判定。 */
const MODULE = '@deepseek-ai/dsh-agent-instructions'

/** 行未配置时的缺省值，与已安装版 `Config` 的缺省一致。 */
const DEFAULTS = {
  maxBytes: 65536,
  maxSourceBytes: 1048576,
  projectRootMarkers: ['.git'],
  instructionFileCandidates: ['AGENTS.md', 'CLAUDE.md'],
  localInstructionFileCandidates: ['AGENTS.local.md', 'CLAUDE.local.md'],
}

const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'
const AGENT_INSTRUCTIONS_INTRO = 'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.'
const COMPACT_AGENT_INSTRUCTIONS_INTRO = 'Workspace instructions were omitted or truncated to fit the configured byte budget.'

/** 用户全局候选的两个根：先 harness home，再共享 agents 根。 */
const USER_GLOBAL_DIRECTORIES = ['user-global', 'agents-global']
const USER_GLOBAL_FILE = 'AGENTS.md'

/**
 * 解析用户数据根。
 *
 * 与 `@deepseek-ai/dsh-home-paths` 同一规则：显式配置 > 环境变量 > `~/`。
 * 展示名只在等于默认根时用 `~/…`，否则用 `$DSH_HOME` / `$DSH_AGENTS_HOME`——
 * 模型看到的就是这两个符号，预演必须给出同一串字符。
 * @param {NodeJS.ProcessEnv} env - 进程环境。
 * @returns {{dshHome: string, agentsHome: string, dshDisplay: string, agentsDisplay: string}} 根与展示名。
 */
function resolveHomes(env) {
  const home = homedir()
  const pick = (configured, envName, fallback) => {
    const fromEnv = env[envName]
    return resolve(fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : fallback)
  }
  const dshHome = pick(undefined, 'DSH_HOME', join(home, '.dsh'))
  const agentsHome = pick(undefined, 'DSH_AGENTS_HOME', join(home, '.agents'))
  return {
    dshHome,
    agentsHome,
    dshDisplay: dshHome === resolve(join(home, '.dsh')) ? '~/.dsh' : '$DSH_HOME',
    agentsDisplay: agentsHome === resolve(join(home, '.agents')) ? '~/.agents' : '$DSH_AGENTS_HOME',
  }
}

/** 把一条候选文件名从 displayPath 还原成它所属的候选组。 */
function candidateGroup(displayPath, homes) {
  const globalDisplays = [
    `${homes.dshDisplay}/${USER_GLOBAL_FILE}`,
    `$DSH_HOME/${USER_GLOBAL_FILE}`,
    `${homes.agentsDisplay}/${USER_GLOBAL_FILE}`,
    `$DSH_AGENTS_HOME/${USER_GLOBAL_FILE}`,
  ]
  if (globalDisplays.includes(displayPath)) return 'user-global'
  return dirname(displayPath)
}

/**
 * 项目内路径的展示形式。
 *
 * 首段恰好叫 `user-global` / `agents-global` 的目录会与两个全局 scope 撞名，加一个
 * `./` 前缀把它留在项目 scope 里。
 * @param {string} relativePath - 相对项目根的路径。
 * @returns {string} 模型可见路径。
 */
function escapeProjectDisplayPath(relativePath) {
  const index = relativePath.search(/[\\/]/)
  const first = index < 0 ? relativePath : relativePath.slice(0, index)
  return USER_GLOBAL_DIRECTORIES.includes(first) ? '.' + sep + relativePath : relativePath
}

/**
 * 从 cwd 向上找到第一个含根标记的目录；找不到就用 cwd 本身。
 * @param {string} cwd - 工作目录。
 * @param {string[]} markers - 根标记文件名。
 * @returns {Promise<string>} 项目根。
 */
async function findProjectRoot(cwd, markers) {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (await statFile(join(current, marker)) !== null) return current
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * 根 → cwd 的目录链（从宽到窄）。
 * @param {string} root - 项目根。
 * @param {string} cwd - 工作目录。
 * @returns {string[]} 目录列表。
 */
function ancestorChain(root, cwd) {
  const chain = []
  let current = resolve(cwd)
  const target = resolve(root)
  while (current !== target) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  chain.push(target)
  return chain.reverse()
}

/**
 * 候选文件名只允许是同一个目录里的普通名字。
 *
 * DSH 会把空串、`.`、`..` 和带分隔符的名字过滤掉；这一步是**读取边界**，不是排版：
 * 少了它，一行配置里的 `..\..\x.md` 就能让预演读到工作区之外。
 * @param {string[]} candidates - 配置里的候选名。
 * @param {string[]} fallback - 缺省候选名。
 * @returns {string[]} 可用的候选名。
 */
function sanitizeCandidates(candidates, fallback) {
  const usable = (candidates ?? fallback).filter((name) => name !== '' && name !== '.' && name !== '..' && !/[\\/]/.test(name))
  return usable.length > 0 ? usable : fallback
}

/**
 * 按 DSH 的顺序发现候选文件：先两个用户全局根，再项目根到 cwd 的每一层。
 * @param {object} config - 归一化配置。
 * @param {string} cwd - 工作目录。
 * @param {object} homes - 已解析的用户数据根。
 * @returns {Promise<Array<{absolutePath: string, displayPath: string, size?: number}>>} 未读内容的候选。
 */
async function discoverFiles(config, cwd, homes) {
  const files = []
  const seen = new Set()
  const add = (file) => {
    if (seen.has(file.absolutePath)) return
    seen.add(file.absolutePath)
    files.push(file)
  }
  for (const [home, display] of [[homes.dshHome, homes.dshDisplay], [homes.agentsHome, homes.agentsDisplay]]) {
    const absolutePath = join(home, USER_GLOBAL_FILE)
    const info = await statFile(absolutePath)
    if (info !== null) add({ absolutePath, displayPath: `${display}/${USER_GLOBAL_FILE}`, size: info.size })
  }
  const projectRoot = await findProjectRoot(cwd, config.projectRootMarkers)
  for (const dir of ancestorChain(projectRoot, cwd)) {
    for (const candidates of [config.instructionFileCandidates, config.localInstructionFileCandidates]) {
      for (const candidate of candidates) {
        const absolutePath = join(dir, candidate)
        const info = await statFile(absolutePath)
        if (info === null) continue
        // 先于读取去重：DSH 在这一步只按绝对路径去重，内容去重发生在读完以后。
        add({ absolutePath, displayPath: escapeProjectDisplayPath(relative(projectRoot, absolutePath)), size: info.size })
      }
    }
  }
  return files
}

/** 一个文件的字节数。 */
function byteLength(value) {
  return Buffer.byteLength(value, 'utf8')
}

/** 按 UTF-8 字节截断，且不切在多字节字符中间。 */
function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.trunc(maxBytes))
  while (end > 0 && (bytes.readUInt8(end) & 192) === 128) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

/** 帧内正文不能自带闭合标签，否则模型会以为提醒提前结束。 */
function escapeFrameBody(body) {
  return body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>')
}

function sectionText(file) {
  return `Instructions from: ${file.displayPath}\n\n${file.content}`
}

function markerText(maxBytes, omitted, truncated) {
  if (omitted.length === 0 && truncated.length === 0) return ''
  const parts = []
  if (omitted.length > 0) parts.push(`omitted ${omitted.map((file) => file.displayPath).join(', ')}`)
  if (truncated.length > 0) {
    parts.push(`truncated ${truncated.map((item) => `${item.displayPath} from ${item.originalBytes} to ${item.includedBytes} bytes`).join(', ')}`)
  }
  return `Workspace instruction budget ${maxBytes} bytes: ${parts.join('; ')}`
}

function buildInstructionText(files, maxBytes, omitted, truncated, style) {
  return [
    SYSTEM_REMINDER_OPEN,
    escapeFrameBody([
      markerText(maxBytes, omitted, truncated),
      style.intro,
      ...files.map((file) => style.section(file)),
    ].filter((block) => block.length > 0).join('\n\n')),
    SYSTEM_REMINDER_CLOSE,
  ].join('\n')
}

function withTruncatedContent(file, includedBytes) {
  return { ...file, content: truncateUtf8(file.content, includedBytes) }
}

function truncateToFit(file, includedFiles, maxBytes, omitted, style) {
  const originalBytes = byteLength(file.content)
  let low = 0
  let high = originalBytes
  let best = withTruncatedContent(file, 0)
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = withTruncatedContent(file, mid)
    const truncated = [{ displayPath: file.displayPath, originalBytes, includedBytes: byteLength(candidate.content) }]
    if (byteLength(buildInstructionText([...includedFiles, candidate], maxBytes, omitted, truncated, style)) <= maxBytes) {
      best = candidate
      low = mid + 1
    } else high = mid - 1
  }
  return best
}

function isDisabledBudget(maxBytes) {
  return maxBytes <= 0 || !Number.isFinite(maxBytes)
}

/**
 * 单条链的预算渲染：先整份，超了就丢最宽的若干文件，再不行就截断最后一个。
 * @param {Array<object>} files - 从宽到窄。
 * @param {number} maxBytes - 字节预算。
 * @param {object} style - `{ intro, section }`。
 * @returns {object} 渲染结果与预算诊断。
 */
function renderInstructionContext(files, maxBytes, style) {
  if (isDisabledBudget(maxBytes)) return { text: '', omitted: files, truncated: [], represented: [], sections: [], intro: undefined }
  const fullText = buildInstructionText(files, maxBytes, [], [], style)
  if (byteLength(fullText) <= maxBytes) {
    return { text: fullText, omitted: [], truncated: [], represented: files, sections: files, intro: style.intro }
  }
  for (let start = 1; start < files.length; start += 1) {
    const included = files.slice(start)
    const omitted = files.slice(0, start).map((file) => ({ absolutePath: file.absolutePath, displayPath: file.displayPath }))
    const suffixText = buildInstructionText(included, maxBytes, omitted, [], style)
    if (byteLength(suffixText) <= maxBytes) {
      return { text: suffixText, omitted, truncated: [], represented: included, sections: included, intro: style.intro }
    }
  }
  const mostSpecific = files.at(-1)
  if (mostSpecific === undefined) return { text: '', omitted: [], truncated: [], represented: [], sections: [], intro: undefined }
  const omitted = files.slice(0, -1).map((file) => ({ absolutePath: file.absolutePath, displayPath: file.displayPath }))
  const originalBytes = byteLength(mostSpecific.content)
  for (const candidateStyle of [style, { ...style, intro: COMPACT_AGENT_INSTRUCTIONS_INTRO }]) {
    const truncatedFile = truncateToFit(mostSpecific, [], maxBytes, omitted, candidateStyle)
    const includedBytes = byteLength(truncatedFile.content)
    const truncated = [{ displayPath: mostSpecific.displayPath, originalBytes, includedBytes }]
    const text = buildInstructionText([truncatedFile], maxBytes, omitted, truncated, candidateStyle)
    if (byteLength(text) <= maxBytes) {
      return {
        text,
        omitted,
        truncated,
        represented: includedBytes > 0 || originalBytes === 0 ? [mostSpecific] : [],
        sections: [truncatedFile],
        intro: candidateStyle.intro,
      }
    }
  }
  const truncated = [{ displayPath: mostSpecific.displayPath, originalBytes, includedBytes: 0 }]
  const compactNotice = escapeFrameBody(markerText(maxBytes, omitted, truncated))
  const heading = withTruncatedContent(mostSpecific, 0)
  const compactWithHeading = escapeFrameBody([compactNotice, style.section(heading)].join('\n\n'))
  if (byteLength(compactWithHeading) <= maxBytes) {
    return { text: compactWithHeading, omitted, truncated, represented: originalBytes === 0 ? [mostSpecific] : [], sections: [heading], intro: undefined }
  }
  return {
    text: byteLength(compactNotice) <= maxBytes ? compactNotice : truncateUtf8(compactNotice, maxBytes),
    omitted,
    truncated,
    represented: [],
    sections: [],
    intro: undefined,
  }
}

/**
 * 用户全局链与项目链各自受 `maxBytes` 约束。
 *
 * 只有两段链同时存在、且合起来超预算时才拆开算；任何一段链保住了自己的帧头，
 * 合并时就用一次 intro。这与 DSH 的行为一致——两段链的上限各自独立，
 * 所以最终文本可能达到 `2 * maxBytes`。
 * @param {Array<object>} files - 从宽到窄。
 * @param {number} maxBytes - 每条链的字节预算。
 * @param {object} style - `{ intro, section }`。
 * @param {object} homes - 用于判定全局文件。
 * @returns {object} 渲染结果。
 */
function renderInstructionChains(files, maxBytes, style, homes) {
  const whole = renderInstructionContext(files, maxBytes, style)
  const isGlobal = (file) => candidateGroup(file.displayPath, homes) === 'user-global'
  const userGlobal = files.filter(isGlobal)
  const project = files.filter((file) => !isGlobal(file))
  if (isDisabledBudget(maxBytes) || userGlobal.length === 0 || project.length === 0 || (whole.omitted.length === 0 && whole.truncated.length === 0)) {
    return whole
  }
  const chains = [renderInstructionContext(userGlobal, maxBytes, style), renderInstructionContext(project, maxBytes, style)]
  const inLoadedOrder = (records) => {
    const byPath = new Map(records.map((record) => [record.absolutePath, record]))
    return files.flatMap((file) => (byPath.has(file.absolutePath) ? [byPath.get(file.absolutePath)] : []))
  }
  const omitted = inLoadedOrder(chains.flatMap((chain) => chain.omitted))
  const sections = inLoadedOrder(chains.flatMap((chain) => chain.sections))
  const represented = inLoadedOrder(chains.flatMap((chain) => chain.represented))
  const truncated = (files.findLastIndex(isGlobal) < files.findLastIndex((file) => !isGlobal(file)) ? chains : [...chains].reverse())
    .flatMap((chain) => chain.truncated)
  const intros = chains.flatMap((chain) => (chain.intro === undefined ? [] : [chain.intro]))
  const intro = intros.includes(style.intro) ? style.intro : (intros[0] ?? '')
  const text = buildInstructionText(sections, maxBytes, omitted, truncated, { ...style, intro })
  if (byteLength(text) > 2 * maxBytes) return whole
  return { text, omitted, truncated, represented, sections, intro }
}

/**
 * 读取一行配置里的数值/数组字段；坏值退回缺省。
 * @param {object | undefined} config - Loader 行配置。
 * @param {string} key - 字段名。
 * @param {unknown} fallback - 缺省值。
 * @returns {unknown} 生效值。
 */
function configValue(config, key, fallback) {
  const value = config?.[key]
  if (Array.isArray(fallback)) return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : fallback
  if (typeof fallback === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return value ?? fallback
}

/**
 * 预测一条首请求里的 `agent-instructions` 消息。
 * @param {object} ctx - host 插件上下文。
 * @param {object} options - 条件。
 * @param {string} options.workspacePath - 工作区路径。
 * @param {object} [options.modules] - `resolveModules()` 的结果；省略时只按宿主行判定。
 * @param {NodeJS.ProcessEnv} [options.env] - 进程环境（测试用）。
 * @returns {Promise<object>} `{ available, text, files, omitted, truncated, confidence, reason? }`。
 */
export async function previewInstructions(ctx, options) {
  const device = (options.modules ?? hostModuleResolver(ctx)).get(MODULE)
  if (!device.available) {
    return { available: false, reason: device.reason, text: '', files: [], omitted: [], truncated: [] }
  }
  if (typeof options.workspacePath !== 'string' || options.workspacePath.length === 0) {
    return { available: false, reason: '未选择工作区', text: '', files: [], omitted: [], truncated: [] }
  }

  const row = { config: device.config }
  const config = {
    maxBytes: configValue(row.config, 'maxBytes', DEFAULTS.maxBytes),
    maxSourceBytes: configValue(row.config, 'maxSourceBytes', DEFAULTS.maxSourceBytes),
    projectRootMarkers: configValue(row.config, 'projectRootMarkers', DEFAULTS.projectRootMarkers),
    instructionFileCandidates: sanitizeCandidates(configValue(row.config, 'instructionFileCandidates', DEFAULTS.instructionFileCandidates), DEFAULTS.instructionFileCandidates),
    localInstructionFileCandidates: sanitizeCandidates(configValue(row.config, 'localInstructionFileCandidates', DEFAULTS.localInstructionFileCandidates), DEFAULTS.localInstructionFileCandidates),
  }
  if (config.maxBytes <= 0 || config.maxSourceBytes <= 0) {
    return { available: false, reason: '指令字节预算被禁用', text: '', files: [], omitted: [], truncated: [] }
  }

  const homes = resolveHomes(options.env ?? process.env)
  const discovered = await discoverFiles(config, options.workspacePath, homes)
  const loaded = []
  const skipped = []
  for (const file of discovered) {
    // 先按 stat 的大小拒绝：超限文件不该被整份读进内存再丢掉。
    if (typeof file.size === 'number' && file.size > config.maxSourceBytes) {
      skipped.push({ displayPath: file.displayPath, reason: `超过 maxSourceBytes（${config.maxSourceBytes} 字节）` })
      continue
    }
    const content = await readTextFile(file.absolutePath)
    if (content === null) {
      // 读不到的文件跳过，但留下记录：预演不该把「读失败」静默成「没有这个文件」。
      skipped.push({ displayPath: file.displayPath, reason: '读取失败' })
      continue
    }
    if (byteLength(content) > config.maxSourceBytes) {
      skipped.push({ displayPath: file.displayPath, reason: `超过 maxSourceBytes（${config.maxSourceBytes} 字节）` })
      continue
    }
    loaded.push({ ...file, content })
  }

  // 同一候选组内，trim 后内容相同的文件只渲染第一份（用户全局两个根共用一组）。
  const keptDigests = new Map()
  const kept = []
  for (const file of loaded) {
    const group = candidateGroup(file.displayPath, homes)
    const digests = keptDigests.get(group) ?? new Set()
    keptDigests.set(group, digests)
    const digest = createHash('sha1').update(file.content.trim()).digest('hex')
    if (digests.has(digest)) continue
    digests.add(digest)
    kept.push(file)
  }
  if (kept.length === 0) {
    return { available: true, text: '', files: [], omitted: [], truncated: [], skipped, confidence: 'derived' }
  }

  const style = { intro: AGENT_INSTRUCTIONS_INTRO, section: sectionText }
  const rendered = renderInstructionChains(kept, config.maxBytes, style, homes)
  const represented = new Set(rendered.represented.map((file) => file.absolutePath))
  const omittedPaths = new Set(rendered.omitted.map((file) => file.absolutePath))
  const truncatedPaths = new Set(rendered.truncated.map((item) => item.displayPath))
  return {
    available: true,
    text: rendered.text,
    confidence: 'derived',
    files: kept.map((file) => ({
      displayPath: file.displayPath,
      bytes: byteLength(file.content),
      included: represented.has(file.absolutePath),
      omitted: omittedPaths.has(file.absolutePath),
      truncated: truncatedPaths.has(file.displayPath),
    })),
    omitted: rendered.omitted.map((file) => ({ displayPath: file.displayPath })),
    truncated: rendered.truncated,
    skipped,
    maxBytes: config.maxBytes,
  }
}
