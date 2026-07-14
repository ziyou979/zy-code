import { feature } from 'bun:bundle'
import { stat } from 'node:fs/promises'
import {
  getMainLoopModel,
  getPublicModelDisplayName,
  getPublicModelName,
} from 'src/services/model/model.js'
import { getClientType } from 'src/bootstrap/runtime/runtimeContext.js'
import { getRemoteSessionUrl, isRemoteSessionLocal, PRODUCT_URL } from '../constants/product.js'
import { TERMINAL_OUTPUT_TAGS } from '../constants/xml.js'
import type { AppState } from '../state/AppStateStore.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import type { Entry } from '../types/logs.js'
import {
  type AttributionData,
  calculateCommitAttribution,
  isInternalModelRepo,
  isInternalModelRepoCached,
  sanitizeModelName,
} from './commitAttribution.js'
import { logForDebugging } from './debug.js'
import { isInternalBuild } from './envUtils.js'
import { parseJSONL } from './json.js'
import { logError } from './log.js'
import { isMemoryFileAccess } from './sessionFileAccessHooks.js'
import { getTranscriptPath } from '../services/sessionStorage.js'
import { readTranscriptForLoad } from './sessionStoragePortable.js'
import { getInitialSettings } from '../services/settings/settings.js'
import { isUndercover } from './undercover.js'
export type AttributionTexts = {
  commit: string
  pr: string
}

/**
 * 根据用户设置返回 commit 和 PR 的署名文本。
 * 处理以下场景：
 * - 通过 getPublicModelName() 动态获取模型名称
 * - 自定义署名设置（settings.attribution.commit/pr）
 * - 向后兼容已废弃的 includeCoAuthoredBy 设置
 * - 远程模式：返回会话 URL 作为署名
 */
export function getAttributionTexts(): AttributionTexts {
  if (isInternalBuild() && isUndercover()) {
    return { commit: '', pr: '' }
  }

  if (getClientType() === 'remote') {
    const remoteSessionId = process.env.ZY_CODE_REMOTE_SESSION_ID
    if (remoteSessionId) {
      const ingressUrl = process.env.SESSION_INGRESS_URL
      // 本地开发环境跳过 — URL 不会持久化
      if (!isRemoteSessionLocal(remoteSessionId, ingressUrl)) {
        const sessionUrl = getRemoteSessionUrl(remoteSessionId, ingressUrl)
        return { commit: sessionUrl, pr: sessionUrl }
      }
    }
    return { commit: '', pr: '' }
  }

  // @[MODEL LAUNCH]: 更新下方硬编码的回退模型名称（防止代号泄漏）。
  // 对内部仓库，使用真实模型名称。对外部仓库，
  // 无法识别的模型回退到 "ZY (qwen3.6-plus)" 以避免泄漏代号。
  const model = getMainLoopModel()!
  const isKnownPublicModel = getPublicModelDisplayName(model) !== null
  const modelName =
    isInternalModelRepoCached() || isKnownPublicModel ? getPublicModelName(model) : 'ZY (unknown)'
  const defaultAttribution = `🤖 Generated with [ZY Code](${PRODUCT_URL})`
  const defaultCommit = `Co-Authored-By: ${modelName}`

  const settings = getInitialSettings()

  // 新的 attribution 设置优先于已废弃的 includeCoAuthoredBy
  if (settings.attribution) {
    return {
      commit: settings.attribution.commit ?? defaultCommit,
      pr: settings.attribution.pr ?? defaultAttribution,
    }
  }

  // 向后兼容：已废弃的 includeCoAuthoredBy 设置
  if (settings.includeCoAuthoredBy === false) {
    return { commit: '', pr: '' }
  }

  return { commit: defaultCommit, pr: defaultAttribution }
}

/**
 * 检查消息内容字符串是否为终端输出而非用户提示。
 * 终端输出包括 bash 输入/输出标签和关于本地命令的附带说明消息。
 */
function isTerminalOutput(content: string): boolean {
  for (const tag of TERMINAL_OUTPUT_TAGS) {
    if (content.includes(`<${tag}>`)) {
      return true
    }
  }
  return false
}

/**
 * 统计非 sidechain 消息列表中包含可见文本内容的用户消息数。
 * 排除 tool_result 块、终端输出和空消息。
 *
 * 调用方应传入已过滤掉 sidechain 消息的列表。
 */
export function countUserPromptsInMessages(
  messages: ReadonlyArray<{ type: string; message?: { content?: unknown } }>,
): number {
  let count = 0

  for (const message of messages) {
    if (message.type !== 'user') {
      continue
    }

    const content = message.message?.content
    if (!content) {
      continue
    }

    let hasUserText = false

    if (typeof content === 'string') {
      if (isTerminalOutput(content)) {
        continue
      }
      hasUserText = content.trim().length > 0
    } else if (Array.isArray(content)) {
      hasUserText = content.some((block) => {
        if (!block || typeof block !== 'object' || !('type' in block)) {
          return false
        }
        return (
          (block.type === 'text' &&
            typeof block.text === 'string' &&
            !isTerminalOutput(block.text)) ||
          block.type === 'image' ||
          block.type === 'document'
        )
      })
    }

    if (hasUserText) {
      count++
    }
  }

  return count
}

/**
 * 统计转录条目中非 sidechain 的用户消息数。
 * 用于计算 "steers" 数量（用户提示数 - 1）。
 *
 * 统计包含用户实际输入文本的消息，
 * 排除 tool_result 块、sidechain 消息和终端输出。
 */
function countUserPromptsFromEntries(entries: ReadonlyArray<Entry>): number {
  const nonSidechain = entries.filter(
    (entry) => entry.type === 'user' && !('isSidechain' in entry && entry.isSidechain),
  )
  return countUserPromptsInMessages(
    nonSidechain as ReadonlyArray<{ type: string; message?: { content?: unknown } }>,
  )
}

/**
 * 从提供的 AppState 的 attribution 状态获取完整的署名数据。
 * 使用 attribution 状态中的所有跟踪文件（不仅仅是暂存文件），
 * 因为对于 PR 署名，文件可能尚未暂存。
 * 如果没有可用的署名数据则返回 null。
 */
async function getPRAttributionData(appState: AppState): Promise<AttributionData | null> {
  const attribution = appState.attribution

  if (!attribution) {
    return null
  }

  // 同时处理 Map 和普通对象（序列化场景）
  const fileStates = attribution.fileStates
  const isMap = fileStates instanceof Map
  const trackedFiles = isMap ? Array.from(fileStates.keys()) : Object.keys(fileStates)

  if (trackedFiles.length === 0) {
    return null
  }

  try {
    return await calculateCommitAttribution([attribution], trackedFiles)
  } catch (error) {
    logError(error as Error)
    return null
  }
}

const MEMORY_ACCESS_TOOL_NAMES = new Set([
  FILE_READ_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

/**
 * 统计转录条目中的记忆文件访问次数。
 * 使用与 PostToolUse 会话文件访问 hook 相同的检测条件。
 */
function countMemoryFileAccessFromEntries(entries: ReadonlyArray<Entry>): number {
  let count = 0
  for (const entry of entries) {
    if (entry.type !== 'assistant') {
      continue
    }
    const content = entry.message?.content
    if (!Array.isArray(content)) {
      continue
    }
    for (const block of content) {
      if (block.type !== 'tool_call' || !MEMORY_ACCESS_TOOL_NAMES.has(block.name)) {
        continue
      }
      if (isMemoryFileAccess(block.name, block.input)) {
        count++
      }
    }
  }
  return count
}

/**
 * 读取会话转录条目并计算提示数和记忆访问数。
 * 压缩前的条目会被跳过 — N-shot 计数和记忆访问计数应仅反映
 * 当前对话弧，而非压缩边界之前累积的提示。
 */
async function getTranscriptStats(): Promise<{
  promptCount: number
  memoryAccessCount: number
}> {
  try {
    const filePath = getTranscriptPath()
    const fileSize = (await stat(filePath)).size
    // 融合读取器：attr-snap 行（长会话中按字节计占 84%）在 fd 层级被跳过，
    // 因此峰值内存随输出而非文件大小扩展。EOF 处保留的那一条 attr-snap
    // 对计数函数无影响（两者都不检查 type === 'attribution-snapshot'）。
    // 当最后一个边界包含 preservedSegment 时读取器返回完整内容（不截断）；
    // 下方的 findLastIndex 仍会切片到边界之后。
    const scan = await readTranscriptForLoad(filePath, fileSize)
    const buf = scan.postBoundaryBuf
    const entries = parseJSONL<Entry>(buf)
    const lastBoundaryIdx = entries.findLastIndex(
      (e) => e.type === 'system' && 'subtype' in e && e.subtype === 'compact_boundary',
    )
    const postBoundary = lastBoundaryIdx >= 0 ? entries.slice(lastBoundaryIdx + 1) : entries
    return {
      promptCount: countUserPromptsFromEntries(postBoundary),
      memoryAccessCount: countMemoryFileAccessFromEntries(postBoundary),
    }
  } catch {
    return { promptCount: 0, memoryAccessCount: 0 }
  }
}

/**
 * 获取包含 Zy 贡献统计的增强 PR 署名文本。
 *
 * 格式："🤖 Generated with ZY Code (93% 3-shotted by qwen3.6-plus)"
 *
 * 规则：
 * - 显示来自 commit 署名的 Zy 贡献百分比
 * - 显示 N-shotted，其中 N 为提示次数（1-shotted、2-shotted 等）
 * - 显示模型短名称（例如 qwen3.6-plus）
 * - 无法计算统计时返回默认署名
 *
 * @param getAppState 获取当前 AppState 的函数（来自命令上下文）
 */
export async function getEnhancedPRAttribution(getAppState: () => AppState): Promise<string> {
  if (isInternalBuild() && isUndercover()) {
    return ''
  }

  if (getClientType() === 'remote') {
    const remoteSessionId = process.env.ZY_CODE_REMOTE_SESSION_ID
    if (remoteSessionId) {
      const ingressUrl = process.env.SESSION_INGRESS_URL
      // 本地开发环境跳过 — URL 不会持久化
      if (!isRemoteSessionLocal(remoteSessionId, ingressUrl)) {
        return getRemoteSessionUrl(remoteSessionId, ingressUrl)
      }
    }
    return ''
  }

  const settings = getInitialSettings()

  // 如果用户有自定义 PR 署名，使用自定义值
  if (settings.attribution?.pr) {
    return settings.attribution.pr
  }

  // 向后兼容：已废弃的 includeCoAuthoredBy 设置
  if (settings.includeCoAuthoredBy === false) {
    return ''
  }

  const defaultAttribution = `🤖 Generated with [ZY Code](${PRODUCT_URL})`

  // 先获取 AppState
  const appState = getAppState()

  logForDebugging(`PR Attribution: appState.attribution exists: ${!!appState.attribution}`)
  if (appState.attribution) {
    const fileStates = appState.attribution.fileStates
    const isMap = fileStates instanceof Map
    const fileCount = isMap ? fileStates.size : Object.keys(fileStates).length
    logForDebugging(`PR Attribution: fileStates count: ${fileCount}`)
  }

  // 获取署名统计（转录文件只读取一次，同时用于提示计数和记忆访问计数）
  const [attributionData, { promptCount, memoryAccessCount }, isInternal] = await Promise.all([
    getPRAttributionData(appState),
    getTranscriptStats(),
    isInternalModelRepo(),
  ])

  const ZyPercent = attributionData?.summary.ZyPercent ?? 0

  logForDebugging(
    `PR Attribution: ZyPercent: ${ZyPercent}, promptCount: ${promptCount}, memoryAccessCount: ${memoryAccessCount}`,
  )

  // 获取短模型名称，对非内部仓库进行脱敏处理
  const rawModelName = getMainLoopModel()!
  const shortModelName = isInternal ? rawModelName : sanitizeModelName(rawModelName)

  // 如果没有署名数据，返回默认值
  if (ZyPercent === 0 && promptCount === 0 && memoryAccessCount === 0) {
    logForDebugging('PR Attribution: returning default (no data)')
    return defaultAttribution
  }

  // 构建增强署名："🤖 Generated with ZY Code (93% 3-shotted by qwen3.6-plus, 2 memories recalled)"
  const memSuffix =
    memoryAccessCount > 0
      ? `, ${memoryAccessCount} ${memoryAccessCount === 1 ? 'memory' : 'memories'} recalled`
      : ''
  const summary = `🤖 Generated with [ZY Code](${PRODUCT_URL}) (${ZyPercent}% ${promptCount}-shotted by ${shortModelName}${memSuffix})`

  // 追加 trailer 行以在 squash-merge 中保留。仅适用于白名单仓库
  // （INTERNAL_MODEL_REPOS）且仅在启用 COMMIT_ATTRIBUTION 的构建中 —
  // attributionTrailer.ts 包含被排除的字符串，因此通过 feature() 后的
  // 动态 import 访问。当仓库配置为 squash_merge_commit_message=PR_BODY
  // （cli、apps）时，PR body 会原样成为 squash commit body —
  // 末尾的 trailer 行会成为 squash commit 上的正式 git trailers。
  if (feature('COMMIT_ATTRIBUTION') && isInternal && attributionData) {
    // @ts-expect-error
    const { buildPRTrailers } = await import('./attributionTrailer.js')
    const trailers = buildPRTrailers(attributionData, appState.attribution)
    const result = `${summary}\n\n${trailers.join('\n')}`
    logForDebugging(`PR Attribution: returning with trailers: ${result}`)
    return result
  }

  logForDebugging(`PR Attribution: returning summary: ${summary}`)
  return summary
}
