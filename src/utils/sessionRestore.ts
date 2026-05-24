import { feature } from 'bun:bundle'
import type { UUID } from 'node:crypto'
import { dirname } from 'node:path'
import {
  getMainLoopModelOverride,
  getSessionId,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  setOriginalCwd,
  switchSession,
} from '../bootstrap/state.js'
import { clearSystemPromptSections } from '../constants/systemPromptSections.js'
import { restoreCostStateForSession } from '../cost-tracker.js'
import type { AppState } from '../state/AppState.js'
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js'
import {
  type AgentDefinition,
  type AgentDefinitionsResult,
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
} from '../tools/AgentTool/loadAgentsDir.js'
import { TODO_WRITE_TOOL_NAME } from '../tools/TodoWriteTool/constants.js'
import { asSessionId } from '../types/ids.js'
import type {
  AttributionSnapshotMessage,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  PersistedWorktreeSession,
} from '../types/logs.js'
import type { Message } from '../types/message.js'
import { renameRecordingForSession } from './asciicast.js'
import {
  type AttributionState,
  attributionRestoreStateFromLog,
  restoreAttributionStateFromSnapshots,
} from './commitAttribution.js'
import { updateSessionName } from './concurrentSessions.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import type { FileHistorySnapshot } from './fileHistory.js'
import { fileHistoryRestoreStateFromLog } from './fileHistory.js'
import { createSystemMessage } from './messages.js'
import { parseUserSpecifiedModel } from 'src/services/model/model.js'
import { getPlansDirectory } from './plans.js'
import { setCwd } from './Shell.js'
import {
  adoptResumedSessionFile,
  recordContentReplacement,
  resetSessionFilePointer,
  restoreSessionMetadata,
  saveMode,
  saveWorktreeState,
} from './sessionStorage.js'
import { isTodoV2Enabled } from './tasks.js'
import type { TodoList } from 'src/services/todo/types.js'
import { TodoListSchema } from 'src/services/todo/types.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'
import { getCurrentWorktreeSession, restoreWorktreeSession } from './worktree.js'
import { clearMemoryFileCaches } from './zymd.js'

type ResumeResult = {
  messages?: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
}

/**
 * 扫描对话记录，找到最后一个 TodoWrite tool_use 块并返回其 todos。
 * 用于在 SDK --resume 时恢复 AppState.todos，使模型的 todo 列表
 * 在 session 重启后无需文件持久化即可保留。
 */
function extractTodosFromTranscript(messages: Message[]): TodoList {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type !== 'assistant') {
      continue
    }
    const content = Array.isArray(msg.message.content) ? msg.message.content : []
    const toolUse = content.find(
      (block) => block.type === 'tool_call' && block.name === TODO_WRITE_TOOL_NAME,
    )
    if (!toolUse || toolUse.type !== 'tool_call') {
      continue
    }
    const input = toolUse.input
    if (input === null || typeof input !== 'object') {
      return []
    }
    const parsed = TodoListSchema().safeParse((input as Record<string, unknown>).todos)
    return parsed.success ? parsed.data : []
  }
  return []
}

/**
 * 在恢复 session 时从日志中还原 session 状态（文件历史、归因、todos）。
 * 供 SDK（print.ts）和交互式（REPL.tsx、main.tsx）恢复路径共同使用。
 */
export function restoreSessionStateFromLog(
  result: ResumeResult,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  // 恢复文件历史状态
  if (result.fileHistorySnapshots && result.fileHistorySnapshots.length > 0) {
    fileHistoryRestoreStateFromLog(result.fileHistorySnapshots, (newState) => {
      setAppState((prev) => ({ ...prev, fileHistory: newState }))
    })
  }

  // 恢复归因状态（仅限 ant 的功能）
  if (
    feature('COMMIT_ATTRIBUTION') &&
    result.attributionSnapshots &&
    result.attributionSnapshots.length > 0
  ) {
    attributionRestoreStateFromLog(result.attributionSnapshots, (newState) => {
      setAppState((prev) => ({ ...prev, attribution: newState }))
    })
  }

  // 恢复 context-collapse 提交日志和暂存快照。必须在第一次 query() 之前运行，
  // 这样 projectView() 才能从恢复的 Message[] 重建折叠视图。即使 entries
  // 为 undefined/空也无条件调用，因为 restoreFromEntries 会先重置 store
  // ——否则，在 session 内 /resume 到一个没有 commits 的 session 时，
  // 会遗留上一个 session 的过期提交日志。
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    ;(
      require('../services/contextCollapse/persist.js') as typeof import('../services/contextCollapse/persist.js')
    ).restoreFromEntries(
      (result.contextCollapseCommits as any) ?? [],
      result.contextCollapseSnapshot as any,
    )
    /* eslint-enable @typescript-eslint/no-require-imports */
  }

  // 从对话记录中恢复 TodoWrite 状态（仅用于 SDK/非交互模式）。
  // 交互模式使用基于文件的 v2 任务，因此 AppState.todos 在交互模式中不使用。
  if (!isTodoV2Enabled() && result.messages && result.messages.length > 0) {
    const todos = extractTodosFromTranscript(result.messages)
    if (todos.length > 0) {
      const agentId = getSessionId()
      setAppState((prev) => ({
        ...prev,
        todos: { ...prev.todos, [agentId]: todos },
      }))
    }
  }
}

/**
 * 从日志快照中计算恢复后的归因状态。
 * 用于在渲染前计算初始状态（例如 main.tsx --continue）。
 * 当归因功能禁用或没有快照时返回 undefined。
 */
export function computeRestoredAttributionState(
  result: ResumeResult,
): AttributionState | undefined {
  if (
    feature('COMMIT_ATTRIBUTION') &&
    result.attributionSnapshots &&
    result.attributionSnapshots.length > 0
  ) {
    return restoreAttributionStateFromSnapshots(result.attributionSnapshots)
  }
  return undefined
}

/**
 * 为 session 恢复计算独立 agent 上下文（名称/颜色）。
 * 用于在渲染前计算初始状态（遵循 CLAUDE.md 规范）。
 * 当 session 未设置名称/颜色时返回 undefined。
 */
export function computeStandaloneAgentContext(
  agentName: string | undefined,
  agentColor: string | undefined,
): AppState['standaloneAgentContext'] | undefined {
  if (!agentName && !agentColor) {
    return undefined
  }
  return {
    name: agentName ?? '',
    color: (agentColor === 'default' ? undefined : agentColor) as AgentColorName | undefined,
  }
}

/**
 * 从恢复的 session 中还原 agent 设置。
 *
 * 当恢复一个使用了自定义 agent 的对话时，重新应用 agent 类型和模型覆盖
 * （除非用户在 CLI 上指定了 --agent）。
 * 通过 setMainThreadAgentType / setMainLoopModelOverride 修改引导状态。
 *
 * 返回恢复的 agent 定义及其 agentType 字符串，如果没有恢复 agent 则返回 undefined。
 */
export function restoreAgentFromSession(
  agentSetting: string | undefined,
  currentAgentDefinition: AgentDefinition | undefined,
  agentDefinitions: AgentDefinitionsResult,
): {
  agentDefinition: AgentDefinition | undefined
  agentType: string | undefined
} {
  // 如果用户已在 CLI 上指定了 --agent，则保留该定义
  if (currentAgentDefinition) {
    return { agentDefinition: currentAgentDefinition, agentType: undefined }
  }

  // 如果 session 没有 agent，则清除过期的引导状态
  if (!agentSetting) {
    setMainThreadAgentType(undefined)
    return { agentDefinition: undefined, agentType: undefined }
  }

  const resumedAgent = agentDefinitions.activeAgents.find(
    (agent) => agent.agentType === agentSetting,
  )
  if (!resumedAgent) {
    logForDebugging(
      `Resumed session had agent "${agentSetting}" but it is no longer available. Using default behavior.`,
    )
    setMainThreadAgentType(undefined)
    return { agentDefinition: undefined, agentType: undefined }
  }

  setMainThreadAgentType(resumedAgent.agentType)

  // 如果用户未指定模型，则应用 agent 的模型
  if (!getMainLoopModelOverride() && resumedAgent.model && resumedAgent.model !== 'inherit') {
    setMainLoopModelOverride(parseUserSpecifiedModel(resumedAgent.model))
  }

  return { agentDefinition: resumedAgent, agentType: resumedAgent.agentType }
}

/**
 * 在 coordinator/normal 模式切换后刷新 agent 定义。
 *
 * 当恢复的 session 处于不同模式（coordinator 对比 normal）时，
 * 内置 agent 需要重新派生以匹配新模式。CLI 提供的 agent（通过 --agents 标志）会被合并回来。
 */
export async function refreshAgentDefinitionsForModeSwitch(
  modeWasSwitched: boolean,
  currentCwd: string,
  cliAgents: AgentDefinition[],
  currentAgentDefinitions: AgentDefinitionsResult,
): Promise<AgentDefinitionsResult> {
  if (!feature('COORDINATOR_MODE') || !modeWasSwitched) {
    return currentAgentDefinitions
  }

  // 模式切换后重新派生 agent 定义，使内置 agent 反映新的 coordinator/normal 模式
  getAgentDefinitionsWithOverrides.cache.clear?.()
  const freshAgentDefs = await getAgentDefinitionsWithOverrides(currentCwd)
  const freshAllAgents = [...freshAgentDefs.allAgents, ...cliAgents]
  return {
    ...freshAgentDefs,
    allAgents: freshAllAgents,
    activeAgents: getActiveAgentsFromList(freshAllAgents),
  }
}

/**
 * 处理恢复/继续对话后用于渲染的结果。
 */
export type ProcessedResume = {
  messages: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  contentReplacements?: ContentReplacementRecord[]
  agentName: string | undefined
  agentColor: AgentColorName | undefined
  restoredAgentDef: AgentDefinition | undefined
  initialState: AppState
}

/**
 * session 恢复所需的 coordinator 模式模块 API 子集。
 */
type CoordinatorModeApi = {
  matchSessionMode(mode?: string): string | undefined
  isCoordinatorMode(): boolean
}

/**
 * 加载的对话数据（loadConversationForResume 的返回类型）。
 */
type ResumeLoadResult = {
  messages: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contentReplacements?: ContentReplacementRecord[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
  sessionId: UUID | undefined
  agentName?: string
  agentColor?: string
  agentSetting?: string
  customTitle?: string
  tag?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

/**
 * 在恢复时还原 worktree 工作目录。对话记录保存了最后一次 worktree 进入/退出；
 * 如果 session 在 worktree 内崩溃（最后一条记录 = session 对象，而非 null），则 cd 回该目录。
 *
 * process.chdir 是 TOCTOU 安全的存在性检查——如果 /exit 对话框删除了该目录，
 * 或者用户在两次 session 之间手动删除了它，则会抛出 ENOENT。
 *
 * 当 --worktree 已经创建了一个新的 worktree 时，新的优先于恢复 session 的状态。
 * restoreSessionMetadata 刚刚用过期的对话记录值覆盖了 project.currentSessionWorktree，
 * 因此在 adoptResumedSessionFile 写入磁盘之前，在此处重新确认新的 worktree。
 */
export function restoreWorktreeForResume(
  worktreeSession: PersistedWorktreeSession | null | undefined,
): void {
  const fresh = getCurrentWorktreeSession()
  if (fresh) {
    saveWorktreeState(fresh)
    return
  }
  if (!worktreeSession) {
    return
  }

  try {
    process.chdir(worktreeSession.worktreePath)
  } catch {
    // 目录已不存在。覆盖过期缓存，使下一次 reAppendSessionMetadata
    // 记录"已退出"，而不是重新持久化一个不存在的路径。
    saveWorktreeState(null)
    return
  }

  setCwd(worktreeSession.worktreePath)
  setOriginalCwd(getCwd())
  // 此处有意不设置 projectRoot。对话记录不记录 worktree 是通过 --worktree
  // （会设置 projectRoot）还是 EnterWorktreeTool（不会设置）进入的。
  // 保持 projectRoot 稳定与 EnterWorktreeTool 的行为一致——skills/history
  // 保持锚定在原始项目上。
  restoreWorktreeSession(worktreeSession)
  // /resume 斜杠命令在 session 中途调用此函数，此时缓存已基于旧的 cwd 填充。
  // 对于 CLI 标志路径来说是廉价的空操作（那里缓存尚未填充）。
  clearMemoryFileCaches()
  clearSystemPromptSections()
  getPlansDirectory.cache.clear?.()
}

/**
 * 在 session 中途 /resume 切换到另一个 session 之前，撤销 restoreWorktreeForResume。
 * 如果没有这一步，从 worktree session /resume 到非 worktree session 时，
 * 用户会留在旧的 worktree 目录中，且 currentWorktreeSession 仍指向先前的 session。
 * /resume 到一个*不同的* worktree 则会完全失败——上面的 getCurrentWorktreeSession()
 * 守卫会阻止切换。
 *
 * CLI --resume/--continue 不需要此操作：它们在启动时只运行一次，
 * 此时 getCurrentWorktreeSession() 仅在使用了 --worktree 时为真
 * （新 worktree 应优先，由上面的重新确认逻辑处理）。
 */
export function exitRestoredWorktree(): void {
  const current = getCurrentWorktreeSession()
  if (!current) {
    return
  }

  restoreWorktreeSession(null)
  // worktree 状态已更改，因此引用它的缓存提示词片段已过期，
  // 无论下面的 chdir 是否成功。
  clearMemoryFileCaches()
  clearSystemPromptSections()
  getPlansDirectory.cache.clear?.()

  try {
    process.chdir(current.originalCwd)
  } catch {
    // 原始目录已不存在（罕见情况）。保持当前位置——如果有目标 worktree，
    // restoreWorktreeForResume 接下来会 cd 进去。
    return
  }
  setCwd(current.originalCwd)
  setOriginalCwd(getCwd())
}

/**
 * 处理已加载的对话用于恢复/继续。
 *
 * 处理 coordinator 模式匹配、session ID 设置、agent 还原、
 * 模式持久化和初始状态计算。供 main.tsx 中的 --continue 和 --resume 路径共同调用。
 */
export async function processResumedConversation(
  result: ResumeLoadResult,
  opts: {
    forkSession: boolean
    sessionIdOverride?: string
    transcriptPath?: string
    includeAttribution?: boolean
  },
  context: {
    modeApi: CoordinatorModeApi | null
    mainThreadAgentDefinition: AgentDefinition | undefined
    agentDefinitions: AgentDefinitionsResult
    currentCwd: string
    cliAgents: AgentDefinition[]
    initialState: AppState
  },
): Promise<ProcessedResume> {
  // 将 coordinator/normal 模式匹配到恢复的 session
  let modeWarning: string | undefined
  if (feature('COORDINATOR_MODE')) {
    modeWarning = context.modeApi?.matchSessionMode(result.mode)
    if (modeWarning) {
      // @ts-expect-error
      result.messages.push(createSystemMessage(modeWarning, 'warning'))
    }
  }

  // 复用恢复 session 的 ID，除非指定了 --fork-session
  if (!opts.forkSession) {
    const sid = opts.sessionIdOverride ?? result.sessionId
    if (sid) {
      // 从不同的项目目录恢复时（git worktrees、跨项目），
      // transcriptPath 指向实际文件；其 dirname 即为项目目录。
      // 否则 session 位于当前项目中。
      switchSession(asSessionId(sid), opts.transcriptPath ? dirname(opts.transcriptPath) : null)
      // 重命名 asciicast 录制文件以匹配恢复的 session ID，
      // 使 getSessionRecordingPaths() 在 /share 时能够发现它
      await renameRecordingForSession()
      await resetSessionFilePointer()
      restoreCostStateForSession(sid)
    }
  } else if (result.contentReplacements?.length) {
    // --fork-session 保留新启动的 session ID。useLogMessages 会通过
    // recordTranscript 将源消息复制到新的 JSONL 中，但 content-replacement
    // 条目是仅由 recordContentReplacement 写入的独立条目类型（query.ts 对
    // newlyReplaced 调用，而非预加载的记录）。没有这个种子，`zy -r {newSessionId}`
    // 会在消息中找到源 tool_use_ids 但没有匹配的替换记录
    // -> 它们被归类为 FROZEN -> 发送完整内容（缓存未命中，永久超额）。
    // insertContentReplacement 设置 sessionId = getSessionId() = 新 ID，
    // 因此 loadTranscriptFile 的键控查找将匹配。
    await recordContentReplacement(result.contentReplacements)
  }

  // 恢复 session 元数据，使 /status 显示保存的名称，
  // 且元数据在 session 退出时被重新追加。Fork 不拥有原始 session 的
  // worktree——fork 退出对话框上的"Remove"会删除原始 session 仍引用的
  // worktree——因此从 fork 路径中剥离 worktreeSession 使缓存保持未设置。
  restoreSessionMetadata(opts.forkSession ? { ...result, worktreeSession: undefined } : result)

  if (!opts.forkSession) {
    // cd 回 session 上次退出时所在的 worktree。
    // 在 restoreSessionMetadata（缓存对话记录中的 worktree 状态）之后执行，
    // 这样如果目录已不存在，我们可以在 adoptResumedSessionFile 写入之前覆盖缓存。
    restoreWorktreeForResume(result.worktreeSession)

    // 将 sessionFile 指向恢复的对话记录并立即重新追加元数据。
    // 上面的 resetSessionFilePointer 将其置空（防止旧的新建 session 路径泄漏），
    // 但这会阻止 reAppendSessionMetadata——遇到 null 时会跳过——在退出清理
    // 处理器中运行。对于 fork，useLogMessages 在 REPL 挂载时通过 recordTranscript
    // 填充一个*新*文件；正常的延迟物化路径在那里是正确的。
    adoptResumedSessionFile()
  }

  // 恢复 context-collapse 提交日志和暂存快照。交互式 /resume 路径
  // 通过 restoreSessionStateFromLog（REPL.tsx）处理；CLI --continue/--resume
  // 通过此处处理。无条件调用——原因见上面 restoreSessionStateFromLog 调用处的说明。
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    ;(
      require('../services/contextCollapse/persist.js') as typeof import('../services/contextCollapse/persist.js')
    ).restoreFromEntries(
      (result.contextCollapseCommits as any) ?? [],
      result.contextCollapseSnapshot as any,
    )
    /* eslint-enable @typescript-eslint/no-require-imports */
  }

  // 从恢复的 session 中还原 agent 设置
  const { agentDefinition: restoredAgent, agentType: resumedAgentType } = restoreAgentFromSession(
    result.agentSetting,
    context.mainThreadAgentDefinition,
    context.agentDefinitions,
  )

  // 持久化当前模式，使后续恢复知道此 session 处于何种模式
  if (feature('COORDINATOR_MODE')) {
    saveMode(context.modeApi?.isCoordinatorMode() ? 'coordinator' : 'normal')
  }

  // 在渲染前计算初始状态（遵循 CLAUDE.md 规范）
  const restoredAttribution = opts.includeAttribution
    ? computeRestoredAttributionState(result)
    : undefined
  const standaloneAgentContext = computeStandaloneAgentContext(result.agentName, result.agentColor)
  void updateSessionName(result.agentName)
  const refreshedAgentDefs = await refreshAgentDefinitionsForModeSwitch(
    !!modeWarning,
    context.currentCwd,
    context.cliAgents,
    context.agentDefinitions,
  )

  return {
    messages: result.messages,
    fileHistorySnapshots: result.fileHistorySnapshots,
    contentReplacements: result.contentReplacements,
    agentName: result.agentName,
    agentColor: (result.agentColor === 'default' ? undefined : result.agentColor) as
      | AgentColorName
      | undefined,
    restoredAgentDef: restoredAgent,
    initialState: {
      ...context.initialState,
      ...(resumedAgentType && { agent: resumedAgentType }),
      ...(restoredAttribution && { attribution: restoredAttribution }),
      ...(standaloneAgentContext && { standaloneAgentContext }),
      agentDefinitions: refreshedAgentDefs,
    },
  }
}
