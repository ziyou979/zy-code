import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPatch } from 'diff'
import type { AgentId } from 'src/types/ids.js'
import type { Message } from 'src/types/message.js'
import { logForDebugging } from 'src/services/infra/debug.js'
import { djb2Hash } from 'src/utils/hash.js'
import { logError } from 'src/services/infra/log.js'
import { getZyTempDir } from 'src/services/permissions/scratchpadStorage.js'
import { jsonStringify } from 'src/services/infra/slowOperations.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { TextBlock, ToolDefinition } from '../../types/llm.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'

function getCacheBreakDiffPath(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)]
  }
  return join(getZyTempDir(), `cache-break-${suffix}.diff`)
}

type PreviousState = {
  systemHash: number
  toolsHash: number
  /** 保留 cache_control 的 system block 哈希，用于捕获 stripCacheControl 会从 systemHash
   *  中抹除的 scope/TTL 变化（global↔org、1h↔5m）。 */
  cacheControlHash: number
  toolNames: string[]
  /** 每个 tool 的 schema 哈希。当 toolSchemasChanged 但 added=removed=0 时，通过差异指出
   *  哪个 tool 的描述发生变化（根据 2026-03-22 的 BQ 数据，占 tool 缓存失效的 77%）。
   *  AgentTool/SkillTool 会嵌入动态 agent/command 列表。 */
  perToolHashes: Record<string, number>
  systemCharCount: number
  model: string
  /** `tool_based`、`system_prompt` 或 `none`；发现或移除 MCP tool 时会变化。 */
  globalCacheStrategy: string
  /** 排序后的 beta header 列表；通过差异展示新增或移除的 header。 */
  betas: string[]
  /** 是否存在 AFK_MODE_BETA_HEADER。现在不应再破坏缓存，因为 zy.ts 会锁存开启状态；
   *  保留跟踪以验证修复。 */
  autoModeActive: boolean
  /** overage 状态变化。现在不应再破坏缓存，因为 TTL 由 settings.promptCacheTTL 配置，
   *  不受 overage 状态影响；保留跟踪以验证修复。 */
  isUsingOverage: boolean
  /** 是否存在 cache-editing beta header。现在不应再破坏缓存，因为 zy.ts 会锁存开启状态；
   *  保留跟踪以验证修复。 */
  cachedMCEnabled: boolean
  /** 解析后的 effort（env → options → 模型默认值），映射关系为 reasoningEffort →
   *  Anthropic output_config.effort / OpenAI reasoning_effort。 */
  effortValue: string
  /** getExtraBodyParams() 的哈希，用于捕获 ZY_CODE_EXTRA_BODY 和 anthropic_internal 变化。 */
  extraBodyHash: number
  callCount: number
  pendingChanges: PendingChanges | null
  prevCacheReadTokens: number | null
  /** cached microcompact 发送 cache_edits 删除项时设置。cache read 合理下降属于预期行为，
   *  不代表缓存失效。 */
  cacheDeletionsPending: boolean
  buildDiffableContent: () => string
}

type PendingChanges = {
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  modelChanged: boolean
  cacheControlChanged: boolean
  globalCacheStrategyChanged: boolean
  betasChanged: boolean
  autoModeChanged: boolean
  overageChanged: boolean
  cachedMCChanged: boolean
  effortChanged: boolean
  extraBodyChanged: boolean
  addedToolCount: number
  removedToolCount: number
  systemCharDelta: number
  addedTools: string[]
  removedTools: string[]
  changedToolSchemas: string[]
  previousModel: string
  newModel: string
  prevGlobalCacheStrategy: string
  newGlobalCacheStrategy: string
  addedBetas: string[]
  removedBetas: string[]
  prevEffortValue: string
  newEffortValue: string
  buildPrevDiffableContent: () => string
}

const previousStateBySource = new Map<string, PreviousState>()

// 限制跟踪的 source 数量，防止内存无限增长。每项存储约 300KB 以上的 diffableContent
// 字符串（序列化的 system prompt 和 tool schema）。若不设上限，启动大量各自具有唯一
// agentId key 的 subagent 会使该 map 持续增长。
const MAX_TRACKED_SOURCES = 10

const TRACKED_SOURCE_PREFIXES = [
  'repl_main_thread',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
]

// 触发缓存失效警告所需的最小 token 绝对降幅。正常波动也可能造成数千 token 的小幅下降，
// 无需为此告警。
const MIN_CACHE_MISS_TOKENS = 2_000

// 待检测的 Anthropic 服务端 prompt cache TTL 阈值。超过这些时长后发生缓存失效，
// 更可能由 TTL 到期而非客户端变化导致。
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000
export const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000

// 排除在缓存失效检测之外的模型，例如 haiku 的缓存行为不同
function isExcludedModel(model: string): boolean {
  return model.includes('haiku')
}

/**
 * 返回 querySource 的跟踪 key；不跟踪时返回 null。Compact 与 repl_main_thread 使用相同的
 * 服务端缓存（cacheSafeParams 相同），因此共享跟踪状态。
 *
 * 对 querySource 受跟踪的 subagent，使用唯一 agentId 隔离跟踪状态，避免同类 agent 的
 * 多个实例并发运行时产生缓存失效误报。
 *
 * speculation、session_memory、prompt_suggestion 等不跟踪的 source 都是短生命周期的
 * forked agent，通常只运行 1 至 3 轮且每次使用新的 agentId，缺少有意义的比较基线，
 * 因此缓存失效检测没有价值。其缓存指标仍通过 zy_api_success 记录供 analytics 使用。
 */
function getTrackingKey(querySource: QuerySource, agentId?: AgentId): string | null {
  if (querySource === 'compact') {
    return 'repl_main_thread'
  }
  for (const prefix of TRACKED_SOURCE_PREFIXES) {
    if (querySource.startsWith(prefix)) {
      return agentId || querySource
    }
  }
  return null
}

function stripCacheControl(items: ReadonlyArray<Record<string, unknown>>): unknown[] {
  return items.map((item) => {
    if (!('cache_control' in item)) {
      return item
    }
    const { cache_control: _, ...rest } = item
    return rest
  })
}

function computeHash(data: unknown): number {
  const str = jsonStringify(data)
  if (typeof Bun !== 'undefined') {
    const hash = Bun.hash(str)
    // Bun.hash 对大输入可能返回 bigint，此处安全转换为 number
    return typeof hash === 'bigint' ? Number(hash & 0xffffffffn) : hash
  }
  // 非 Bun 运行时的后备方案，例如通过 npm 全局安装后使用 Node.js
  return djb2Hash(str)
}

/** MCP tool 名称由用户控制（来自 server config），可能泄露文件路径，因此统一折叠为 `mcp`；
 *  内置名称则来自固定词表。 */
function sanitizeToolName(name: string): string {
  return name.startsWith('mcp__') ? 'mcp' : name
}

function computePerToolHashes(
  strippedTools: ReadonlyArray<unknown>,
  names: string[],
): Record<string, number> {
  const hashes: Record<string, number> = {}
  for (let i = 0; i < strippedTools.length; i++) {
    hashes[names[i] ?? `__idx_${i}`] = computeHash(strippedTools[i])
  }
  return hashes
}

function getSystemCharCount(system: TextBlock[]): number {
  let total = 0
  for (const block of system) {
    total += block.text.length
  }
  return total
}

function buildDiffableContent(system: TextBlock[], tools: ToolDefinition[], model: string): string {
  const systemText = system.map((b) => b.text).join('\n\n')
  const toolDetails = tools
    .map((t) => {
      if (!('name' in t)) {
        return 'unknown'
      }
      const desc = 'description' in t ? t.description : ''
      const schema = 'inputSchema' in t ? jsonStringify(t.inputSchema) : ''
      return `${t.name}\n  description: ${desc}\n  inputSchema: ${schema}`
    })
    .sort()
    .join('\n\n')
  return `Model: ${model}\n\n=== System Prompt ===\n\n${systemText}\n\n=== Tools (${tools.length}) ===\n\n${toolDetails}\n`
}

/** 扩展跟踪快照，包含客户端可观察到且可能影响服务端缓存 key 的所有内容。所有字段均可选，
 *  便于调用方逐步补充；undefined 字段在比较时视为稳定。 */
export type PromptStateSnapshot = {
  system: TextBlock[]
  toolSchemas: ToolDefinition[]
  querySource: QuerySource
  model: string
  agentId?: AgentId
  globalCacheStrategy?: string
  betas?: readonly string[]
  autoModeActive?: boolean
  isUsingOverage?: boolean
  cachedMCEnabled?: boolean
  effortValue?: string | number
  extraBodyParams?: unknown
}

/**
 * Phase 1（调用前）：记录当前 prompt/tool 状态并检测变化。不触发事件，仅保存待处理变化供
 * Phase 2 使用。
 */
export function recordPromptState(snapshot: PromptStateSnapshot): void {
  try {
    const {
      system,
      toolSchemas,
      querySource,
      model,
      agentId,
      globalCacheStrategy = '',
      betas = [],
      autoModeActive = false,
      isUsingOverage = false,
      cachedMCEnabled = false,
      effortValue,
      extraBodyParams,
    } = snapshot
    const key = getTrackingKey(querySource, agentId)
    if (!key) {
      return
    }

    const strippedSystem = stripCacheControl(
      system as unknown as ReadonlyArray<Record<string, unknown>>,
    )
    const strippedTools = stripCacheControl(
      toolSchemas as unknown as ReadonlyArray<Record<string, unknown>>,
    )

    const systemHash = computeHash(strippedSystem)
    const toolsHash = computeHash(strippedTools)
    // 对包含 cache_control 的完整 system 数组计算哈希，以捕获精简哈希因文本内容相同而无法
    // 发现的 scope（global↔org/none）和 TTL（1h↔5m）变化。
    const cacheControlHash = computeHash(
      system.map((b) => ('cache_control' in b ? b.cache_control : null)),
    )
    const toolNames = toolSchemas.map((t) => ('name' in t ? t.name : 'unknown'))
    // 仅在聚合值变化时计算逐 tool 哈希；tools 未变化的常见路径可省去 N 次 jsonStringify 调用。
    const computeToolHashes = () => computePerToolHashes(strippedTools, toolNames)
    const systemCharCount = getSystemCharCount(system)
    const lazyDiffableContent = () => buildDiffableContent(system, toolSchemas, model)
    const sortedBetas = [...betas].sort()
    const effortStr = effortValue === undefined ? '' : String(effortValue)
    const extraBodyHash = extraBodyParams === undefined ? 0 : computeHash(extraBodyParams)

    const prev = previousStateBySource.get(key)

    if (!prev) {
      // map 达到容量上限时淘汰最旧项
      while (previousStateBySource.size >= MAX_TRACKED_SOURCES) {
        const oldest = previousStateBySource.keys().next().value
        if (oldest !== undefined) {
          previousStateBySource.delete(oldest)
        }
      }

      previousStateBySource.set(key, {
        systemHash,
        toolsHash,
        cacheControlHash,
        toolNames,
        systemCharCount,
        model,
        globalCacheStrategy,
        betas: sortedBetas,
        autoModeActive,
        isUsingOverage,
        cachedMCEnabled,
        effortValue: effortStr,
        extraBodyHash,
        callCount: 1,
        pendingChanges: null,
        prevCacheReadTokens: null,
        cacheDeletionsPending: false,
        buildDiffableContent: lazyDiffableContent,
        perToolHashes: computeToolHashes(),
      })
      return
    }

    prev.callCount++

    const systemPromptChanged = systemHash !== prev.systemHash
    const toolSchemasChanged = toolsHash !== prev.toolsHash
    const modelChanged = model !== prev.model
    const cacheControlChanged = cacheControlHash !== prev.cacheControlHash
    const globalCacheStrategyChanged = globalCacheStrategy !== prev.globalCacheStrategy
    const betasChanged =
      sortedBetas.length !== prev.betas.length || sortedBetas.some((b, i) => b !== prev.betas[i])
    const autoModeChanged = autoModeActive !== prev.autoModeActive
    const overageChanged = isUsingOverage !== prev.isUsingOverage
    const cachedMCChanged = cachedMCEnabled !== prev.cachedMCEnabled
    const effortChanged = effortStr !== prev.effortValue
    const extraBodyChanged = extraBodyHash !== prev.extraBodyHash

    if (
      systemPromptChanged ||
      toolSchemasChanged ||
      modelChanged ||
      cacheControlChanged ||
      globalCacheStrategyChanged ||
      betasChanged ||
      autoModeChanged ||
      overageChanged ||
      cachedMCChanged ||
      effortChanged ||
      extraBodyChanged
    ) {
      const prevToolSet = new Set(prev.toolNames)
      const newToolSet = new Set(toolNames)
      const prevBetaSet = new Set(prev.betas)
      const newBetaSet = new Set(sortedBetas)
      const addedTools = toolNames.filter((n) => !prevToolSet.has(n))
      const removedTools = prev.toolNames.filter((n) => !newToolSet.has(n))
      const changedToolSchemas: string[] = []
      if (toolSchemasChanged) {
        const newHashes = computeToolHashes()
        for (const name of toolNames) {
          if (!prevToolSet.has(name)) {
            continue
          }
          if (newHashes[name] !== prev.perToolHashes[name]) {
            changedToolSchemas.push(name)
          }
        }
        prev.perToolHashes = newHashes
      }
      prev.pendingChanges = {
        systemPromptChanged,
        toolSchemasChanged,
        modelChanged,
        cacheControlChanged,
        globalCacheStrategyChanged,
        betasChanged,
        autoModeChanged,
        overageChanged,
        cachedMCChanged,
        effortChanged,
        extraBodyChanged,
        addedToolCount: addedTools.length,
        removedToolCount: removedTools.length,
        addedTools,
        removedTools,
        changedToolSchemas,
        systemCharDelta: systemCharCount - prev.systemCharCount,
        previousModel: prev.model,
        newModel: model,
        prevGlobalCacheStrategy: prev.globalCacheStrategy,
        newGlobalCacheStrategy: globalCacheStrategy,
        addedBetas: sortedBetas.filter((b) => !prevBetaSet.has(b)),
        removedBetas: prev.betas.filter((b) => !newBetaSet.has(b)),
        prevEffortValue: prev.effortValue,
        newEffortValue: effortStr,
        buildPrevDiffableContent: prev.buildDiffableContent,
      }
    } else {
      prev.pendingChanges = null
    }

    prev.systemHash = systemHash
    prev.toolsHash = toolsHash
    prev.cacheControlHash = cacheControlHash
    prev.toolNames = toolNames
    prev.systemCharCount = systemCharCount
    prev.model = model
    prev.globalCacheStrategy = globalCacheStrategy
    prev.betas = sortedBetas
    prev.autoModeActive = autoModeActive
    prev.isUsingOverage = isUsingOverage
    prev.cachedMCEnabled = cachedMCEnabled
    prev.effortValue = effortStr
    prev.extraBodyHash = extraBodyHash
    prev.buildDiffableContent = lazyDiffableContent
  } catch (e: unknown) {
    logError(e)
  }
}

/**
 * Phase 2（调用后）：检查 API 响应中的 cache token，判断是否确实发生缓存失效；若发生，
 * 使用 Phase 1 保存的变化解释原因。
 */
export async function checkResponseForCacheBreak(
  querySource: QuerySource,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  messages: Message[],
  agentId?: AgentId,
  requestId?: string | null,
): Promise<void> {
  try {
    const key = getTrackingKey(querySource, agentId)
    if (!key) {
      return
    }

    const state = previousStateBySource.get(key)
    if (!state) {
      return
    }

    // 跳过被排除的模型，例如 haiku 的缓存行为不同
    if (isExcludedModel(state.model)) {
      return
    }

    const prevCacheRead = state.prevCacheReadTokens
    state.prevCacheReadTokens = cacheReadTokens

    // 在 messages 数组中查找当前响应之前最近的 assistant 消息时间戳，计算距上次调用的时长，
    // 供 TTL 检测使用
    const lastAssistantMessage = messages.findLast((m) => m.type === 'assistant')
    const timeSinceLastAssistantMsg = lastAssistantMessage
      ? Date.now() - new Date(lastAssistantMessage.timestamp).getTime()
      : null

    // 首次调用没有可比较的历史值，直接跳过
    if (prevCacheRead === null) {
      return
    }

    const changes = state.pendingChanges

    // cached microcompact 的缓存删除会有意缩短缓存前缀，因此 cache read token 下降属于预期。
    // 重置基线，避免下次调用误报。
    if (state.cacheDeletionsPending) {
      state.cacheDeletionsPending = false
      logForDebugging(
        `[PROMPT CACHE] cache deletion applied, cache read: ${prevCacheRead} → ${cacheReadTokens} (expected drop)`,
      )
      // 剩余状态仍然有效，不标记为缓存失效
      state.pendingChanges = null
      return
    }

    // 缓存失效判定：cache read 较上次下降超过 5%，且绝对降幅超过最小阈值
    const tokenDrop = prevCacheRead - cacheReadTokens
    if (cacheReadTokens >= prevCacheRead * 0.95 || tokenDrop < MIN_CACHE_MISS_TOKENS) {
      state.pendingChanges = null
      return
    }

    // 根据待处理变化构造解释
    const parts: string[] = []
    if (changes) {
      if (changes.modelChanged) {
        parts.push(`model changed (${changes.previousModel} → ${changes.newModel})`)
      }
      if (changes.systemPromptChanged) {
        const charDelta = changes.systemCharDelta
        const charInfo =
          charDelta === 0 ? '' : charDelta > 0 ? ` (+${charDelta} chars)` : ` (${charDelta} chars)`
        parts.push(`system prompt changed${charInfo}`)
      }
      if (changes.toolSchemasChanged) {
        const toolDiff =
          changes.addedToolCount > 0 || changes.removedToolCount > 0
            ? ` (+${changes.addedToolCount}/-${changes.removedToolCount} tools)`
            : ' (tool prompt/schema changed, same tool set)'
        parts.push(`tools changed${toolDiff}`)
      }
      if (changes.globalCacheStrategyChanged) {
        parts.push(
          `global cache strategy changed (${changes.prevGlobalCacheStrategy || 'none'} → ${changes.newGlobalCacheStrategy || 'none'})`,
        )
      }
      if (
        changes.cacheControlChanged &&
        !changes.globalCacheStrategyChanged &&
        !changes.systemPromptChanged
      ) {
        // 仅在没有其他解释时将其报告为独立原因；否则 scope/TTL 变化只是结果，并非根因。
        parts.push('cache_control changed (scope or TTL)')
      }
      if (changes.betasChanged) {
        const added = changes.addedBetas.length ? `+${changes.addedBetas.join(',')}` : ''
        const removed = changes.removedBetas.length ? `-${changes.removedBetas.join(',')}` : ''
        const diff = [added, removed].filter(Boolean).join(' ')
        parts.push(`betas changed${diff ? ` (${diff})` : ''}`)
      }
      if (changes.autoModeChanged) {
        parts.push('auto mode toggled')
      }
      if (changes.overageChanged) {
        parts.push('overage state changed (TTL latched, no flip)')
      }
      if (changes.cachedMCChanged) {
        parts.push('cached microcompact toggled')
      }
      if (changes.effortChanged) {
        parts.push(
          `effort changed (${changes.prevEffortValue || 'default'} → ${changes.newEffortValue || 'default'})`,
        )
      }
      if (changes.extraBodyChanged) {
        parts.push('extra body params changed')
      }
    }

    // 检查时间间隔是否表明 TTL 已到期
    const lastAssistantMsgOver5minAgo =
      timeSinceLastAssistantMsg !== null && timeSinceLastAssistantMsg > CACHE_TTL_5MIN_MS
    const lastAssistantMsgOver1hAgo =
      timeSinceLastAssistantMsg !== null && timeSinceLastAssistantMsg > CACHE_TTL_1HOUR_MS

    // PR #19823 后的 BQ 分析（bq-queries/prompt-caching/cache_break_pr19823_analysis.sql）显示：
    // 当所有客户端标记均为 false 且间隔短于 TTL 时，约 90% 的失效来自服务端路由/淘汰，
    // 或 billed 与 inference 不一致。应据此标记，避免误导为需要排查 CC bug。
    let reason: string
    if (parts.length > 0) {
      reason = parts.join(', ')
    } else if (lastAssistantMsgOver1hAgo) {
      reason = 'possible 1h TTL expiry (prompt unchanged)'
    } else if (lastAssistantMsgOver5minAgo) {
      reason = 'possible 5min TTL expiry (prompt unchanged)'
    } else if (timeSinceLastAssistantMsg !== null) {
      reason = 'likely server-side (prompt unchanged, <5min gap)'
    } else {
      reason = 'unknown cause'
    }

    logEvent('zy_prompt_cache_break', {
      systemPromptChanged: changes?.systemPromptChanged ?? false,
      toolSchemasChanged: changes?.toolSchemasChanged ?? false,
      modelChanged: changes?.modelChanged ?? false,
      cacheControlChanged: changes?.cacheControlChanged ?? false,
      globalCacheStrategyChanged: changes?.globalCacheStrategyChanged ?? false,
      betasChanged: changes?.betasChanged ?? false,
      autoModeChanged: changes?.autoModeChanged ?? false,
      overageChanged: changes?.overageChanged ?? false,
      cachedMCChanged: changes?.cachedMCChanged ?? false,
      effortChanged: changes?.effortChanged ?? false,
      extraBodyChanged: changes?.extraBodyChanged ?? false,
      addedToolCount: changes?.addedToolCount ?? 0,
      removedToolCount: changes?.removedToolCount ?? 0,
      systemCharDelta: changes?.systemCharDelta ?? 0,
      // 对 tool 名称脱敏：内置名称来自固定词表，MCP tool 则统一折叠为 mcp，因为用户配置可能
      // 泄露路径。
      addedTools: (changes?.addedTools ?? [])
        .map(sanitizeToolName)
        .join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      removedTools: (changes?.removedTools ?? [])
        .map(sanitizeToolName)
        .join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      changedToolSchemas: (changes?.changedToolSchemas ?? [])
        .map(sanitizeToolName)
        .join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // Beta header 名称和缓存策略是类似枚举的固定值，不属于代码或文件路径；requestId 是服务端
      // 生成的不透明 ID。
      addedBetas: (changes?.addedBetas ?? []).join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      removedBetas: (changes?.removedBetas ?? []).join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      prevGlobalCacheStrategy: (changes?.prevGlobalCacheStrategy ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      newGlobalCacheStrategy: (changes?.newGlobalCacheStrategy ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      callNumber: state.callCount,
      prevCacheReadTokens: prevCacheRead,
      cacheReadTokens,
      cacheCreationTokens,
      timeSinceLastAssistantMsg: timeSinceLastAssistantMsg ?? -1,
      lastAssistantMsgOver5minAgo,
      lastAssistantMsgOver1hAgo,
      requestId: (requestId ?? '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    // 通过 --debug 写入 diff 文件供 ant 调试。summary 日志包含路径，便于 ant 查找；DevBar UI
    // 已移除，事件数据会可靠流入 BQ 供 analytics 使用。
    let diffPath: string | undefined
    if (changes?.buildPrevDiffableContent) {
      diffPath = await writeCacheBreakDiff(
        changes.buildPrevDiffableContent(),
        state.buildDiffableContent(),
      )
    }

    const diffSuffix = diffPath ? `, diff: ${diffPath}` : ''
    const summary = `[PROMPT CACHE BREAK] ${reason} [source=${querySource}, call #${state.callCount}, cache read: ${prevCacheRead} → ${cacheReadTokens}, creation: ${cacheCreationTokens}${diffSuffix}]`

    logForDebugging(summary, { level: 'warn' })

    state.pendingChanges = null
  } catch (e: unknown) {
    logError(e)
  }
}

/**
 * cached microcompact 发送 cache_edits 删除项时调用。下一次 API 响应中的 cache read token
 * 会下降，这是预期行为，并非缓存失效。
 */
export function notifyCacheDeletion(querySource: QuerySource, agentId?: AgentId): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) {
    state.cacheDeletionsPending = true
  }
}

/**
 * compaction 后调用以重置 cache read 基线。compaction 会合理减少消息数，因此下一次调用的
 * cache read token 自然会下降，并不代表缓存失效。
 */
export function notifyCompaction(querySource: QuerySource, agentId?: AgentId): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) {
    state.prevCacheReadTokens = null
  }
}

export function cleanupAgentTracking(agentId: AgentId): void {
  previousStateBySource.delete(agentId)
}

export function resetPromptCacheBreakDetection(): void {
  previousStateBySource.clear()
}

async function writeCacheBreakDiff(
  prevContent: string,
  newContent: string,
): Promise<string | undefined> {
  try {
    const diffPath = getCacheBreakDiffPath()
    await mkdir(getZyTempDir(), { recursive: true })
    const patch = createPatch('prompt-state', prevContent, newContent, 'before', 'after')
    await writeFile(diffPath, patch)
    return diffPath
  } catch {
    return undefined
  }
}
