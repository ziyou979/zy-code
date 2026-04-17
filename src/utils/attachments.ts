// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { logEvent, type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js';
import { toolMatchesName, type Tools, type ToolUseContext, type ToolPermissionContext } from '../Tool.js';
import { FileReadTool, MaxFileReadTokenExceededError, type Output as FileReadToolOutput, readImageWithTokenBudget } from '../tools/FileReadTool/FileReadTool.js';
import { FileTooLargeError, readFileInRange } from './readFileInRange.js';
import { expandPath } from './path.js';
import { countCharInString } from './stringUtils.js';
import { count, uniq } from './array.js';
import { getFsImplementation } from './fsOperations.js';
import { readdir, stat } from 'fs/promises';
import type { IDESelection } from '../hooks/useIdeSelection.js';
import { TODO_WRITE_TOOL_NAME } from '../tools/TodoWriteTool/constants.js';
import { TASK_CREATE_TOOL_NAME } from '../tools/TaskCreateTool/constants.js';
import { TASK_UPDATE_TOOL_NAME } from '../tools/TaskUpdateTool/constants.js';
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js';
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js';
import type { TodoList } from './todo/types.js';
import { type Task, listTasks, getTaskListId, isTodoV2Enabled } from './tasks.js';
import { getPlanFilePath, getPlan } from './plans.js';
import { getConnectedIdeName } from './ide.js';
import { getManagedAndUserConditionalRules, getMemoryFilesForNestedDirectory, getConditionalRulesForCwdLevelDirectory, type MemoryFileInfo } from './zymd.js';
import { dirname, parse, relative, resolve } from 'path';
import { getCwd } from 'src/utils/cwd.js';
import { getViewedTeammateTask } from '../state/selectors.js';
import { logError } from './log.js';
import { logAntError } from './debug.js';
import { isENOENT, toError } from './errors.js';
import type { DiagnosticFile } from '../services/diagnosticTracking.js';
import { diagnosticTracker } from '../services/diagnosticTracking.js';
import type { AttachmentMessage, Message, MessageOrigin } from 'src/types/message.js';
import { type QueuedCommand, getImagePasteIds, isValidImagePaste } from 'src/types/textInputTypes.js';
import { randomUUID, type UUID } from 'crypto';
import { getSettings_DEPRECATED } from './settings/settings.js';
import { getSnippetForTwoFileDiff } from 'src/tools/FileEditTool/utils.js';
import type { ContentBlockParam, ImageBlockParam, Base64ImageSource } from '@anthropic-ai/sdk/resources/messages.mjs';
import { maybeResizeAndDownsampleImageBlock } from './imageResizer.js';
import type { PastedContent } from './config.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { getSkillToolCommands, getMcpSkillCommands } from '../commands.js';
import type { Command } from '../types/command.js';
import uniqBy from 'lodash-es/uniqBy.js';
import { getProjectRoot } from '../bootstrap/state.js';
import { formatCommandsWithinBudget } from '../tools/SkillTool/prompt.js';
import { getContextWindowForModel } from './context.js';
import type { DiscoverySignal } from '../services/skillSearch/signals.js';
// DCE 条件加载。所有技能搜索字符串字面量，
// 否则会泄露到外部构建中，都放在这些模块内。
// 此文件中唯一的表面是：maybe() 调用（通过下方的 spread 门控）和
// skill_listing 抑制检查（使用相同的 skillSearchModules null 检查）。
// 上方的类型仅 DiscoverySignal 导入在编译时被擦除。
/* eslint-disable @typescript-eslint/no-require-imports */
const skillSearchModules = feature('EXPERIMENTAL_SKILL_SEARCH') ? {
  featureCheck: require('../services/skillSearch/featureCheck.js') as typeof import('../services/skillSearch/featureCheck.js'),
  prefetch: require('../services/skillSearch/prefetch.js') as typeof import('../services/skillSearch/prefetch.js')
} : null;
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER') ? require('./permissions/autoModeState.js') as typeof import('./permissions/autoModeState.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
import { MAX_LINES_TO_READ, FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js';
import { getDefaultFileReadingLimits } from 'src/tools/FileReadTool/limits.js';
import { cacheKeys, type FileStateCache } from './fileStateCache.js';
import { createAbortController, createChildAbortController } from './abortController.js';
import { isAbortError } from './errors.js';
import { getFileModificationTimeAsync, isFileWithinReadSizeLimit } from './file.js';
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js';
import { filterAgentsByMcpRequirements } from '../tools/AgentTool/loadAgentsDir.js';
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js';
import { formatAgentLine, shouldInjectAgentListInMessages } from '../tools/AgentTool/prompt.js';
import { filterDeniedAgents } from './permissions/permissions.js';
import { mcpInfoFromString } from '../services/mcp/mcpStringUtils.js';
import { matchingRuleForInput, pathInAllowedWorkingPath } from './permissions/filesystem.js';
import { generateTaskAttachments, applyTaskOffsetsAndEvictions } from './task/framework.js';
import { getTaskOutputPath } from './task/diskOutput.js';
import { drainPendingMessages } from '../tasks/LocalAgentTask/LocalAgentTask.js';
import type { TaskType, TaskStatus } from '../Task.js';
import { getOriginalCwd, getSessionId, getSdkBetas, getTotalCostUSD, getTotalOutputTokens, getCurrentTurnTokenBudget, getTurnOutputTokens, hasExitedPlanModeInSession, setHasExitedPlanMode, needsPlanModeExitAttachment, setNeedsPlanModeExitAttachment, needsAutoModeExitAttachment, setNeedsAutoModeExitAttachment, getLastEmittedDate, setLastEmittedDate, getKairosActive } from '../bootstrap/state.js';
import type { QuerySource } from '../constants/querySource.js';
import { getDeferredToolsDelta, isDeferredToolsDeltaEnabled, isToolSearchEnabledOptimistic, isToolSearchToolAvailable, modelSupportsToolReference, type DeferredToolsDeltaScanContext } from './toolSearch.js';
import { getMcpInstructionsDelta, isMcpInstructionsDeltaEnabled, type ClientSideInstruction } from './mcpInstructionsDelta.js';
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from './ClaudeInChrome/common.js';
import { CHROME_TOOL_SEARCH_INSTRUCTIONS } from './ClaudeInChrome/prompt.js';
import type { MCPServerConnection } from '../services/mcp/types.js';
import type { HookEvent, SyncHookJSONOutput } from 'src/entrypoints/agentSdkTypes.js';
import { checkForAsyncHookResponses, removeDeliveredAsyncHooks } from './hooks/AsyncHookRegistry.js';
import { checkForLSPDiagnostics, clearAllLSPDiagnostics } from '../services/lsp/LSPDiagnosticRegistry.js';
import { logForDebugging } from './debug.js';
import { extractTextContent, getUserMessageText, isThinkingMessage } from './messages.js';
import { isHumanTurn } from './messagePredicates.js';
import { isEnvTruthy, getZyConfigHomeDir } from './envUtils.js';
import { feature } from 'bun:bundle';
/* eslint-disable @typescript-eslint/no-require-imports */
const BRIEF_TOOL_NAME: string | null = feature('KAIROS') || feature('KAIROS_BRIEF') ? (require('../tools/BriefTool/prompt.js') as typeof import('../tools/BriefTool/prompt.js')).BRIEF_TOOL_NAME : null;
const sessionTranscriptModule = feature('KAIROS') ? require('../services/sessionTranscript/sessionTranscript.js') as typeof import('../services/sessionTranscript/sessionTranscript.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
import { hasUltrathinkKeyword, isUltrathinkEnabled } from './thinking.js';
import { tokenCountFromLastAPIResponse, tokenCountWithEstimation } from './tokens.js';
import { getEffectiveContextWindowSize, isAutoCompactEnabled } from '../services/compact/autoCompact.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js';
import { hasInstructionsLoadedHook, executeInstructionsLoadedHooks, type HookBlockingError, type InstructionsMemoryType } from './hooks.js';
import { jsonStringify } from './slowOperations.js';
import { isPDFExtension } from './pdfUtils.js';
import { getLocalISODate } from '../constants/common.js';
import { getPDFPageCount } from './pdf.js';
import { PDF_AT_MENTION_INLINE_THRESHOLD } from '../constants/apiLimits.js';
import { isAgentSwarmsEnabled } from './agentSwarmsEnabled.js';
import { findRelevantMemories } from '../memdir/findRelevantMemories.js';
import { memoryAge, memoryFreshnessText } from '../memdir/memoryAge.js';
import { getAutoMemPath, isAutoMemoryEnabled } from '../memdir/paths.js';
import { getAgentMemoryDir } from '../tools/AgentTool/agentMemory.js';
import { readUnreadMessages, markMessagesAsReadByPredicate, isShutdownApproved, isStructuredProtocolMessage, isIdleNotification } from './teammateMailbox.js';
import { getAgentName, getAgentId, getTeamName, isTeamLead } from './teammate.js';
import { isInProcessTeammate } from './teammateContext.js';
import { removeTeammateFromTeamFile } from './swarm/teamHelpers.js';
import { unassignTeammateTasks } from './tasks.js';
import { getCompanionIntroAttachment } from '../buddy/prompt.js';
import { isInternalBuild } from './envUtils.js';
export const TODO_REMINDER_CONFIG = {
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10
} as const;
export const PLAN_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5
} as const;
export const AUTO_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5
} as const;
const MAX_MEMORY_LINES = 200;
// 仅限制行数无法控制大小（200 × 500 字符行 = 100KB）。
// surfacer 每轮次通过 <system-reminder> 注入最多 5 个文件，
// 绕过每条消息的 tool-result 预算，因此严格的每文件字节上限
// 使总注入有界（5 × 4KB = 20KB/轮次）。通过 readFileInRange
// 的 truncateOnByteLimit 选项强制执行。截断意味着最相关的
// 记忆仍然可见：frontmatter + 开头上下文通常就是关键。
const MAX_MEMORY_BYTES = 4096;
export const RELEVANT_MEMORIES_CONFIG = {
  // 每轮次上限（5 × 4KB = 20KB）限制单次注入，但在
  // 长会话中，选择器会不断涌现不同文件 — 生产环境
  // 观察到的约 ~26K tokens/会话。设置累计字节上限：
  // 达到后完全停止预取。预算约为 3 次完整注入；
  // 之后最相关的记忆已在上下文中。扫描消息
  //（而不是在 toolUseContext 中追踪）意味着自然 compact 会
  // 重置计数器 — 旧附件已从上下文中消失，
  // 因此重新浮现是有效的。
  MAX_SESSION_BYTES: 60 * 1024
} as const;
export const VERIFY_PLAN_REMINDER_CONFIG = {
  TURNS_BETWEEN_REMINDERS: 10
} as const;
export type FileAttachment = {
  type: 'file';
  filename: string;
  content: FileReadToolOutput;
  /**
   * 文件是否因大小限制而被截断
   */
  truncated?: boolean;
  /** 创建时相对于 CWD 的路径，用于稳定显示 */
  displayPath: string;
};
export type CompactFileReferenceAttachment = {
  type: 'compact_file_reference';
  filename: string;
  /** 创建时相对于 CWD 的路径，用于稳定显示 */
  displayPath: string;
};
export type PDFReferenceAttachment = {
  type: 'pdf_reference';
  filename: string;
  pageCount: number;
  fileSize: number;
  /** 创建时相对于 CWD 的路径，用于稳定显示 */
  displayPath: string;
};
export type AlreadyReadFileAttachment = {
  type: 'already_read_file';
  filename: string;
  content: FileReadToolOutput;
  /**
   * 文件是否因大小限制而被截断
   */
  truncated?: boolean;
  /** 创建时相对于 CWD 的路径，用于稳定显示 */
  displayPath: string;
};
export type AgentMentionAttachment = {
  type: 'agent_mention';
  agentType: string;
};
export type AsyncHookResponseAttachment = {
  type: 'async_hook_response';
  processId: string;
  hookName: string;
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion';
  toolName?: string;
  response: SyncHookJSONOutput;
  stdout: string;
  stderr: string;
  exitCode?: number;
};
export type HookAttachment = HookCancelledAttachment | {
  type: 'hook_blocking_error';
  blockingError: HookBlockingError;
  hookName: string;
  toolUseID: string;
  hookEvent: HookEvent;
} | HookNonBlockingErrorAttachment | HookErrorDuringExecutionAttachment | {
  type: 'hook_stopped_continuation';
  message: string;
  hookName: string;
  toolUseID: string;
  hookEvent: HookEvent;
} | HookSuccessAttachment | {
  type: 'hook_additional_context';
  content: string[];
  hookName: string;
  toolUseID: string;
  hookEvent: HookEvent;
} | HookSystemMessageAttachment | HookPermissionDecisionAttachment;
export type HookPermissionDecisionAttachment = {
  type: 'hook_permission_decision';
  decision: 'allow' | 'deny';
  toolUseID: string;
  hookEvent: HookEvent;
};
export type HookSystemMessageAttachment = {
  type: 'hook_system_message';
  content: string;
  hookName: string;
  toolUseID: string;
  hookEvent: HookEvent;
};
export type HookCancelledAttachment = {
  type: 'hook_cancelled';
  hookName: string;
  toolUseID: string;
  hookEvent: HookEvent;
  command?: string;
  durationMs?: number;
};
export type HookErrorDuringExecutionAttachment = {
  type: 'hook_error_during_execution';
  content: string;
  hookName: string;
  toolUseID: string;
  hookEvent: HookEvent;
  command?: string;
  durationMs?: number;
};
export type HookSuccessAttachment = {
  type: 'hook_success';
  content: string;
  hookName: string;
  toolUseID: string;
  hookEvent: HookEvent;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  command?: string;
  durationMs?: number;
};
export type HookNonBlockingErrorAttachment = {
  type: 'hook_non_blocking_error';
  hookName: string;
  stderr: string;
  stdout: string;
  exitCode: number;
  toolUseID: string;
  hookEvent: HookEvent;
  command?: string;
  durationMs?: number;
};
export type Attachment =
/**
 * 用户 @提到了文件
 */
FileAttachment | CompactFileReferenceAttachment | PDFReferenceAttachment | AlreadyReadFileAttachment
/**
 * 一个 @提到的文件被编辑了
 */ | {
  type: 'edited_text_file';
  filename: string;
  snippet: string;
} | {
  type: 'edited_image_file';
  filename: string;
  content: FileReadToolOutput;
} | {
  type: 'directory';
  path: string;
  content: string;
  /** 创建时相对于 CWD 的路径，用于稳定显示 */
  displayPath: string;
} | {
  type: 'selected_lines_in_ide';
  ideName: string;
  lineStart: number;
  lineEnd: number;
  filename: string;
  content: string;
  /** 创建时相对于 CWD 的路径，用于稳定显示 */
  displayPath: string;
} | {
  type: 'opened_file_in_ide';
  filename: string;
} | {
  type: 'todo_reminder';
  content: TodoList;
  itemCount: number;
} | {
  type: 'task_reminder';
  content: Task[];
  itemCount: number;
} | {
  type: 'nested_memory';
  path: string;
  content: MemoryFileInfo;
  /** 创建时相对于 CWD 的路径，用于稳定显示 */
  displayPath: string;
} | {
  type: 'relevant_memories';
  memories: {
    path: string;
    content: string;
    mtimeMs: number;
    /**
     * 预计算的头部字符串（年龄 + 路径前缀）。在附件创建时
     * 计算一次，使渲染的字节在跨轮次时稳定 — 渲染时
     * 重新计算 memoryAge(mtimeMs) 会调用 Date.now()，
     * 所以"3 天前保存"跨轮次变成"4 天前保存" → 不同字节
     * → prompt 缓存失效。
     * 为兼容恢复的会话可选；渲染路径在缺失时回退到重新计算。
     */
    header?: string;
    /**
     * readMemoriesForSurfacing 截断文件时的 lineCount，
     * 否则为 undefined。传递到 readFileState 写入，
     * 使 getChangedFiles 跳过被截断的记忆
     *（部分内容会产生误导性的 diff）。
     */
    limit?: number;
  }[];
} | {
  type: 'dynamic_skill';
  skillDir: string;
  skillNames: string[];
  /** 创建时相对于 CWD 的路径，用于稳定显示 */
  displayPath: string;
} | {
  type: 'skill_listing';
  content: string;
  skillCount: number;
  isInitial: boolean;
} | {
  type: 'skill_discovery';
  skills: {
    name: string;
    description: string;
    shortId?: string;
  }[];
  signal: DiscoverySignal;
  source: 'native' | 'aki' | 'both';
} | {
  type: 'queued_command';
  prompt: string | Array<ContentBlockParam>;
  source_uuid?: UUID;
  imagePasteIds?: number[];
  /** 原始队列模式 — 用户消息为 'prompt'，系统事件为 'task-notification' */
  commandMode?: string;
  /** 从 QueuedCommand 携带的来源，使轮次中排空时保留 */
  origin?: MessageOrigin;
  /** 从 QueuedCommand.isMeta 携带 — 区分人类输入与系统注入 */
  isMeta?: boolean;
} | {
  type: 'output_style';
  style: string;
} | {
  type: 'diagnostics';
  files: DiagnosticFile[];
  isNew: boolean;
} | {
  type: 'plan_mode';
  reminderType: 'full' | 'sparse';
  isSubAgent?: boolean;
  planFilePath: string;
  planExists: boolean;
} | {
  type: 'plan_mode_reentry';
  planFilePath: string;
} | {
  type: 'plan_mode_exit';
  planFilePath: string;
  planExists: boolean;
} | {
  type: 'auto_mode';
  reminderType: 'full' | 'sparse';
} | {
  type: 'auto_mode_exit';
} | {
  type: 'critical_system_reminder';
  content: string;
} | {
  type: 'plan_file_reference';
  planFilePath: string;
  planContent: string;
} | {
  type: 'mcp_resource';
  server: string;
  uri: string;
  name: string;
  description?: string;
  content: ReadResourceResult;
} | {
  type: 'command_permissions';
  allowedTools: string[];
  model?: string;
} | AgentMentionAttachment | {
  type: 'task_status';
  taskId: string;
  taskType: TaskType;
  status: TaskStatus;
  description: string;
  deltaSummary: string | null;
  outputFilePath?: string;
} | AsyncHookResponseAttachment | {
  type: 'token_usage';
  used: number;
  total: number;
  remaining: number;
} | {
  type: 'budget_usd';
  used: number;
  total: number;
  remaining: number;
} | {
  type: 'output_token_usage';
  turn: number;
  session: number;
  budget: number | null;
} | {
  type: 'structured_output';
  data: unknown;
} | TeammateMailboxAttachment | TeamContextAttachment | HookAttachment | {
  type: 'invoked_skills';
  skills: Array<{
    name: string;
    path: string;
    content: string;
  }>;
} | {
  type: 'verify_plan_reminder';
} | {
  type: 'max_turns_reached';
  maxTurns: number;
  turnCount: number;
} | {
  type: 'current_session_memory';
  content: string;
  path: string;
  tokenCount: number;
} | {
  type: 'teammate_shutdown_batch';
  count: number;
} | {
  type: 'compaction_reminder';
} | {
  type: 'context_efficiency';
} | {
  type: 'date_change';
  newDate: string;
} | {
  type: 'ultrathink_effort';
  level: 'high';
} | {
  type: 'deferred_tools_delta';
  addedNames: string[];
  addedLines: string[];
  removedNames: string[];
} | {
  type: 'agent_listing_delta';
  addedTypes: string[];
  addedLines: string[];
  removedTypes: string[];
  /** 是否为会话中的首次公告 */
  isInitial: boolean;
  /** 是否包含"并发启动多个代理"说明（非 Pro 订阅） */
  showConcurrencyNote: boolean;
} | {
  type: 'mcp_instructions_delta';
  addedNames: string[];
  addedBlocks: string[];
  removedNames: string[];
} | {
  type: 'companion_intro';
  name: string;
  species: string;
} | {
  type: 'bagel_console';
  errorCount: number;
  warningCount: number;
  sample: string;
};
export type TeammateMailboxAttachment = {
  type: 'teammate_mailbox';
  messages: Array<{
    from: string;
    text: string;
    timestamp: string;
    color?: string;
    summary?: string;
  }>;
};
export type TeamContextAttachment = {
  type: 'team_context';
  agentId: string;
  agentName: string;
  teamName: string;
  teamConfigPath: string;
  taskListPath: string;
};

/**
 * 这段代码有些粗糙
 * TODO: 在创建消息时生成附件，而不是这里
 */
export async function getAttachments(input: string | null, toolUseContext: ToolUseContext, ideSelection: IDESelection | null, queuedCommands: QueuedCommand[], messages?: Message[], querySource?: QuerySource, options?: {
  skipSkillDiscovery?: boolean;
}): Promise<Attachment[]> {
  if (isEnvTruthy(process.env.ZY_CODE_DISABLE_ATTACHMENTS) || isEnvTruthy(process.env.ZY_CODE_SIMPLE)) {
    // query.ts:removeFromQueue 在 getAttachmentMessages 运行后无条件地将这些出队 —
    // 在此返回 [] 会静默丢弃它们。
    // Coworker 以 --bare 运行，依赖 task-notification 获取
    // Local*Task/Remote*Task 在工具调用中的通知。
    return getQueuedCommandAttachments(queuedCommands);
  }

  // 这会减慢提交速度
  // TODO: 在用户输入时计算附件，而不是在这里（尽管我们也对 slash 命令提示使用此函数）
  const abortController = createAbortController();
  const timeoutId = setTimeout(ac => ac.abort(), 1000, abortController);
  const context = {
    ...toolUseContext,
    abortController
  };
  const isMainThread = !toolUseContext.agentId;

  // 响应用户输入而添加的附件
  const userInputAttachments = input ? [maybe('at_mentioned_files', () => processAtMentionedFiles(input, context)), maybe('mcp_resources', () => processMcpResourceAttachments(input, context)), maybe('agent_mentions', () => Promise.resolve(processAgentMentions(input, toolUseContext.options.agentDefinitions.activeAgents))),
  // 第 0 轮的技能发现（用户输入作为信号）。轮间
  // 发现通过 query.ts 中的 startSkillDiscoveryPrefetch 运行，
  // 由 write-pivot 检测门控 — 见 skillSearch/prefetch.ts。
  // 此处的 feature() 使 DCE 能从外部构建中丢弃 'skill_discovery' 字符串
  //（及其调用的函数）。
  //
  // skipSkillDiscovery 门控排除 SKILL.md 扩展路径
  //（getMessagesForPromptSlashCommand）。当调用技能时，
  // 其 SKILL.md 内容作为 `input` 传入此处以提取 @-mentions —
  // 但该内容不是用户意图，不应触发发现。
  // 没有此门控时，110KB 的 SKILL.md 会在每次技能调用时
  // 触发约 3.3s 的分块 AKI 查询（会话 13a9afae）。
  ...(feature('EXPERIMENTAL_SKILL_SEARCH') && skillSearchModules && !options?.skipSkillDiscovery ? [maybe('skill_discovery', () => skillSearchModules.prefetch.getTurnZeroSkillDiscovery(input, messages ?? [], context))] : [])] : [];

  // 先处理用户输入附件（包括 @提到的文件）
  // 这确保文件在 nested_memory 处理之前添加到 nestedMemoryAttachmentTriggers
  const userAttachmentResults = await Promise.all(userInputAttachments);

  // 子代理中可用的线程安全附件
  // 注意：这些必须在 userInputAttachments 完成后创建，以确保
  // nestedMemoryAttachmentTriggers 在 getNestedMemoryAttachments 运行之前已填充
  const allThreadAttachments = [
  // queuedCommands 已由 query.ts 中的 drain gate 进行代理作用域 —
  // 主线程获取 agentId===undefined，子代理获取自己的 agentId。
  // 必须对所有线程运行，否则子代理通知会流失到虚空
  //（被 removeFromQueue 从队列中移除但从未附加）。
  maybe('queued_commands', () => getQueuedCommandAttachments(queuedCommands)), maybe('date_change', () => Promise.resolve(getDateChangeAttachments(messages))), maybe('ultrathink_effort', () => Promise.resolve(getUltrathinkEffortAttachment(input))), maybe('deferred_tools_delta', () => Promise.resolve(getDeferredToolsDeltaAttachment(toolUseContext.options.tools, toolUseContext.options.mainLoopModel, messages, {
    callSite: isMainThread ? 'attachments_main' : 'attachments_subagent',
    querySource
  }))), maybe('agent_listing_delta', () => Promise.resolve(getAgentListingDeltaAttachment(toolUseContext, messages))), maybe('mcp_instructions_delta', () => Promise.resolve(getMcpInstructionsDeltaAttachment(toolUseContext.options.mcpClients, toolUseContext.options.tools, toolUseContext.options.mainLoopModel, messages))), ...(feature('BUDDY') ? [maybe('companion_intro', () => Promise.resolve(getCompanionIntroAttachment(messages)))] : []), maybe('changed_files', () => getChangedFiles(context)), maybe('nested_memory', () => getNestedMemoryAttachments(context)),
  // relevant_memories 已移至异步预取（startRelevantMemoryPrefetch）
  maybe('dynamic_skill', () => getDynamicSkillAttachments(context)), maybe('skill_listing', () => getSkillListingAttachments(context)),
  // 轮间技能发现现在通过 startSkillDiscoveryPrefetch 运行
  //（query.ts，与主轮次并发）。此前驻留在此的阻塞调用
  // 是 assistant_turn 信号 — 97% 的这些 Haiku 调用在生产环境中
  // 什么都没找到。预取 + 收集时 await 取代了它；
  // 见 src/services/skillSearch/prefetch.ts。
  maybe('plan_mode', () => getPlanModeAttachments(messages, toolUseContext)), maybe('plan_mode_exit', () => getPlanModeExitAttachment(toolUseContext)), ...(feature('TRANSCRIPT_CLASSIFIER') ? [maybe('auto_mode', () => getAutoModeAttachments(messages, toolUseContext)), maybe('auto_mode_exit', () => getAutoModeExitAttachment(toolUseContext))] : []), maybe('todo_reminders', () => isTodoV2Enabled() ? getTaskReminderAttachments(messages, toolUseContext) : getTodoReminderAttachments(messages, toolUseContext)), ...(isAgentSwarmsEnabled() ? [
  // 跳过 session_memory 分叉代理的 teammate 邮箱。
  // 它与 leader 共享 AppState.teamContext，因此 isTeamLead 解析为
  // true，它会将 leader 的 DM 读取并标记为已读作为临时附件，
  // 静默窃取本应作为永久轮次传递的消息。
  ...(querySource === 'session_memory' ? [] : [maybe('teammate_mailbox', async () => getTeammateMailboxAttachments(toolUseContext))]), maybe('team_context', async () => getTeamContextAttachment(messages ?? []))] : []), maybe('agent_pending_messages', async () => getAgentPendingMessageAttachments(toolUseContext)), maybe('critical_system_reminder', () => Promise.resolve(getCriticalSystemReminderAttachment(toolUseContext))), ...(feature('COMPACTION_REMINDERS') ? [maybe('compaction_reminder', () => Promise.resolve(getCompactionReminderAttachment(messages ?? [], toolUseContext.options.mainLoopModel)))] : []), ...(feature('HISTORY_SNIP') ? [maybe('context_efficiency', () => Promise.resolve(getContextEfficiencyAttachment(messages ?? [])))] : [])];

  // 语义上仅用于主对话或不具备并发安全实现的附件
  const mainThreadAttachments = isMainThread ? [maybe('ide_selection', async () => getSelectedLinesFromIDE(ideSelection, toolUseContext)), maybe('ide_opened_file', async () => getOpenedFileFromIDE(ideSelection, toolUseContext)), maybe('output_style', async () => Promise.resolve(getOutputStyleAttachment())), maybe('diagnostics', async () => getDiagnosticAttachments(toolUseContext)), maybe('lsp_diagnostics', async () => getLSPDiagnosticAttachments(toolUseContext)), maybe('unified_tasks', async () => getUnifiedTaskAttachments(toolUseContext)), maybe('async_hook_responses', async () => getAsyncHookResponseAttachments()), maybe('token_usage', async () => Promise.resolve(getTokenUsageAttachment(messages ?? [], toolUseContext.options.mainLoopModel))), maybe('budget_usd', async () => Promise.resolve(getMaxBudgetUsdAttachment(toolUseContext.options.maxBudgetUsd))), maybe('output_token_usage', async () => Promise.resolve(getOutputTokenUsageAttachment())), maybe('verify_plan_reminder', async () => getVerifyPlanReminderAttachment(messages, toolUseContext))] : [];

  // 并行处理线程和主线程附件（它们之间无依赖）
  const [threadAttachmentResults, mainThreadAttachmentResults] = await Promise.all([Promise.all(allThreadAttachments), Promise.all(mainThreadAttachments)]);
  clearTimeout(timeoutId);
  // 防御性：泄露 [undefined] 的 getter 会使下方的 .map(a => a.type) 崩溃。
  return [...userAttachmentResults.flat(), ...threadAttachmentResults.flat(), ...mainThreadAttachmentResults.flat()].filter(a => a !== undefined && a !== null);
}
async function maybe<A>(label: string, f: () => Promise<A[]>): Promise<A[]> {
  const startTime = Date.now();
  try {
    const result = await f();
    const duration = Date.now() - startTime;
    // 仅记录 5% 的事件以减少数据量
    if (Math.random() < 0.05) {
      // jsonStringify(undefined) 返回 undefined，因此 .length 会抛出异常
      const attachmentSizeBytes = result.filter(a => a !== undefined && a !== null).reduce((total, attachment) => {
        return total + jsonStringify(attachment).length;
      }, 0);
      logEvent('tengu_attachment_compute_duration', {
        label,
        duration_ms: duration,
        attachment_size_bytes: attachmentSizeBytes,
        attachment_count: result.length
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS);
    }
    return result;
  } catch (e) {
    const duration = Date.now() - startTime;
    // 仅记录 5% 的事件以减少数据量
    if (Math.random() < 0.05) {
      logEvent('tengu_attachment_compute_duration', {
        label,
        duration_ms: duration,
        error: true
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS);
    }
    logError(e);
    // 对于 Ant 用户，记录完整错误以帮助调试
    logAntError(`Attachment error in ${label}`, e);
    return [];
  }
}
const INLINE_NOTIFICATION_MODES = new Set(['prompt', 'task-notification']);
export async function getQueuedCommandAttachments(queuedCommands: QueuedCommand[]): Promise<Attachment[]> {
  if (!queuedCommands) {
    return [];
  }
  // 将 'prompt' 和 'task-notification' 命令都包含为附件。
  // 在主动代理循环期间，task-notification 命令否则会
  // 永久停留在队列中（查询活跃时 useQueueProcessor 无法运行），
  // 导致 hasPendingNotifications() 返回 true 且 Sleep 以
  // 0ms 持续时间立即唤醒，形成无限循环。
  const filtered = queuedCommands.filter(_ => INLINE_NOTIFICATION_MODES.has(_.mode));
  return Promise.all(filtered.map(async _ => {
    const imageBlocks = await buildImageContentBlocks(_.pastedContents);
    let prompt: string | Array<ContentBlockParam> = _.value;
    if (imageBlocks.length > 0) {
      // 构建包含文本 + 图像的内容块数组，使模型能看到它们
      const textValue = typeof _.value === 'string' ? _.value : extractTextContent(_.value, '\n');
      prompt = [{
        type: 'text' as const,
        text: textValue
      }, ...imageBlocks];
    }
    return {
      type: 'queued_command' as const,
      prompt,
      source_uuid: _.uuid,
      imagePasteIds: getImagePasteIds(_.pastedContents),
      commandMode: _.mode,
      origin: _.origin,
      isMeta: _.isMeta
    };
  }));
}
export function getAgentPendingMessageAttachments(toolUseContext: ToolUseContext): Attachment[] {
  const agentId = toolUseContext.agentId;
  if (!agentId) return [];
  const drained = drainPendingMessages(agentId, toolUseContext.getAppState, toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState);
  return drained.map(msg => ({
    type: 'queued_command' as const,
    prompt: msg,
    origin: {
      kind: 'coordinator' as const
    },
    isMeta: true
  }));
}
async function buildImageContentBlocks(pastedContents: Record<number, PastedContent> | undefined): Promise<ImageBlockParam[]> {
  if (!pastedContents) {
    return [];
  }
  const imageContents = Object.values(pastedContents).filter(isValidImagePaste);
  if (imageContents.length === 0) {
    return [];
  }
  const results = await Promise.all(imageContents.map(async img => {
    const imageBlock: ImageBlockParam = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: (img.mediaType || 'image/png') as Base64ImageSource['media_type'],
        data: img.content
      }
    };
    const resized = await maybeResizeAndDownsampleImageBlock(imageBlock);
    return resized.block;
  }));
  return results;
}
function getPlanModeAttachmentTurnCount(messages: Message[]): {
  turnCount: number;
  foundPlanModeAttachment: boolean;
} {
  let turnsSinceLastAttachment = 0;
  let foundPlanModeAttachment = false;

  // 向后迭代以查找最近的 plan_mode 附件。
  // 统计人工轮次（非 meta、非工具结果的用户消息），而不是 assistant
  // 消息 — query.ts 中的工具循环在每个工具轮次调用 getAttachmentMessages，
  // 因此统计 assistant 消息会每 5 个工具调用触发一次提醒，而不是每 5 个人工轮次。
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.type === 'user' && !message.isMeta && !hasToolResultContent(message.message.content)) {
      turnsSinceLastAttachment++;
    } else if (message?.type === 'attachment' && (message.attachment.type === 'plan_mode' || message.attachment.type === 'plan_mode_reentry')) {
      foundPlanModeAttachment = true;
      break;
    }
  }
  return {
    turnCount: turnsSinceLastAttachment,
    foundPlanModeAttachment
  };
}

/**
 * Count plan_mode attachments since the last plan_mode_exit (or from start if no exit).
 * This ensures the full/sparse cycle resets when re-entering plan mode.
 */
function countPlanModeAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0;
  // 向后迭代 — 如果遇到 plan_mode_exit，停止计数
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'plan_mode_exit') {
        break; // 在最后一次退出处停止计数
      }
      if (message.attachment.type === 'plan_mode') {
        count++;
      }
    }
  }
  return count;
}
async function getPlanModeAttachments(messages: Message[] | undefined, toolUseContext: ToolUseContext): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState();
  const permissionContext = appState.toolPermissionContext;
  if (permissionContext.mode !== 'plan') {
    return [];
  }

  // 检查是否应基于轮次计数附加（首轮除外）
  if (messages && messages.length > 0) {
    const {
      turnCount,
      foundPlanModeAttachment
    } = getPlanModeAttachmentTurnCount(messages);
    // 仅在我们已发送过 plan_mode 附件时才限流
    // 在 plan mode 的首轮，始终附加
    if (foundPlanModeAttachment && turnCount < PLAN_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS) {
      return [];
    }
  }
  const planFilePath = getPlanFilePath(toolUseContext.agentId);
  const existingPlan = getPlan(toolUseContext.agentId);
  const attachments: Attachment[] = [];

  // 检查重新进入：标志已设置且计划文件存在
  if (hasExitedPlanModeInSession() && existingPlan !== null) {
    attachments.push({
      type: 'plan_mode_reentry',
      planFilePath
    });
    setHasExitedPlanMode(false); // 清除标志 — 一次性指导
  }

  // 确定这是完整还是稀疏提醒
  // 在第 1、6、11... 轮次完整提醒（每 N 次附件）
  const attachmentCount = countPlanModeAttachmentsSinceLastExit(messages ?? []) + 1;
  const reminderType: 'full' | 'sparse' = attachmentCount % PLAN_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS === 1 ? 'full' : 'sparse';

  // 始终添加主 plan_mode 附件
  attachments.push({
    type: 'plan_mode',
    reminderType,
    isSubAgent: !!toolUseContext.agentId,
    planFilePath,
    planExists: existingPlan !== null
  });
  return attachments;
}

/**
 * Returns a plan_mode_exit attachment if we just exited plan mode.
 * This is a one-time notification to tell the model it's no longer in plan mode.
 */
async function getPlanModeExitAttachment(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  // 仅在标志已设置时触发（我们刚退出 plan mode）
  if (!needsPlanModeExitAttachment()) {
    return [];
  }
  const appState = toolUseContext.getAppState();
  if (appState.toolPermissionContext.mode === 'plan') {
    setNeedsPlanModeExitAttachment(false);
    return [];
  }

  // 清除标志 — 这是一次性通知
  setNeedsPlanModeExitAttachment(false);
  const planFilePath = getPlanFilePath(toolUseContext.agentId);
  const planExists = getPlan(toolUseContext.agentId) !== null;

  // 注意：技能发现不会在 plan 退出时触发。到计划写好时，
  // 已经太晚了 — 模型应该在规划期间就有相关技能。
  // 触发规划的用户消息信号已经在正确的时刻触发。
  return [{
    type: 'plan_mode_exit',
    planFilePath,
    planExists
  }];
}
function getAutoModeAttachmentTurnCount(messages: Message[]): {
  turnCount: number;
  foundAutoModeAttachment: boolean;
} {
  let turnsSinceLastAttachment = 0;
  let foundAutoModeAttachment = false;

  // 向后迭代以查找最近的 auto_mode 附件。
  // 统计人工轮次（非 meta、非工具结果的用户消息），而不是 assistant
  // 消息 — query.ts 中的工具循环在每个工具轮次调用 getAttachmentMessages，
  // 因此如果统计 assistant 消息，一个有 100 次工具调用的单个人工轮次
  // 会触发约 20 次提醒。自动模式的目标用例是长代理会话，
  // 每会话累积 60-105 次。
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.type === 'user' && !message.isMeta && !hasToolResultContent(message.message.content)) {
      turnsSinceLastAttachment++;
    } else if (message?.type === 'attachment' && message.attachment.type === 'auto_mode') {
      foundAutoModeAttachment = true;
      break;
    } else if (message?.type === 'attachment' && message.attachment.type === 'auto_mode_exit') {
      // 退出重置限流 — 视为没有先前的附件存在
      break;
    }
  }
  return {
    turnCount: turnsSinceLastAttachment,
    foundAutoModeAttachment
  };
}

/**
 * 统计自上次 auto_mode 退出以来的 auto_mode 附件数量（如无退出则从开始统计）。
 * 这确保重新进入自动模式时完整/稀疏周期重置。
 */
function countAutoModeAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'auto_mode_exit') {
        break;
      }
      if (message.attachment.type === 'auto_mode') {
        count++;
      }
    }
  }
  return count;
}
async function getAutoModeAttachments(messages: Message[] | undefined, toolUseContext: ToolUseContext): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState();
  const permissionContext = appState.toolPermissionContext;
  const inAuto = permissionContext.mode === 'auto';
  const inPlanWithAuto = permissionContext.mode === 'plan' && (autoModeStateModule?.isAutoModeActive() ?? false);
  if (!inAuto && !inPlanWithAuto) {
    return [];
  }

  // 检查是否应基于轮次计数附加（首轮除外）
  if (messages && messages.length > 0) {
    const {
      turnCount,
      foundAutoModeAttachment
    } = getAutoModeAttachmentTurnCount(messages);
    // 仅在我们已发送过 auto_mode 附件时才限流
    // 在 auto mode 的首轮，始终附加
    if (foundAutoModeAttachment && turnCount < AUTO_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS) {
      return [];
    }
  }

  // 判断这应该是完整还是稀疏提醒
  const attachmentCount = countAutoModeAttachmentsSinceLastExit(messages ?? []) + 1;
  const reminderType: 'full' | 'sparse' = attachmentCount % AUTO_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS === 1 ? 'full' : 'sparse';
  return [{
    type: 'auto_mode',
    reminderType
  }];
}

/**
 * 如果刚退出 auto mode，返回 auto_mode_exit 附件。
 * 这是一次性通知，告诉模型它不再处于自动模式。
 */
async function getAutoModeExitAttachment(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  if (!needsAutoModeExitAttachment()) {
    return [];
  }
  const appState = toolUseContext.getAppState();
  // 当 auto 仍处于活跃状态时抑制 — 覆盖 mode==='auto' 和
  // plan-with-auto-active（此时 mode==='plan' 但分类器仍在运行）。
  if (appState.toolPermissionContext.mode === 'auto' || (autoModeStateModule?.isAutoModeActive() ?? false)) {
    setNeedsAutoModeExitAttachment(false);
    return [];
  }
  setNeedsAutoModeExitAttachment(false);
  return [{
    type: 'auto_mode_exit'
  }];
}

/**
 * Detects when the local date has changed since the last turn (user coding
 * past midnight) and emits an attachment to notify the model.
 *
 * The date_change attachment is appended at the tail of the conversation,
 * so the model learns the new date without mutating the cached prefix.
 * messages[0] (from getUserContext → prependUserContext) intentionally
 * keeps the stale date — clearing that cache would regenerate the prefix
 * and turn the entire conversation into cache_creation on the next turn
 * (~920K effective tokens per midnight crossing per overnight session).
 *
 * Exported for testing — regression guard for the cache-clear removal.
 */
export function getDateChangeAttachments(messages: Message[] | undefined): Attachment[] {
  const currentDate = getLocalISODate();
  const lastDate = getLastEmittedDate();
  if (lastDate === null) {
    // 首轮 — 仅记录，无需附件
    setLastEmittedDate(currentDate);
    return [];
  }
  if (currentDate === lastDate) {
    return [];
  }
  setLastEmittedDate(currentDate);

  // Assistant 模式：将昨天的 transcript 刷新到每日文件，使 /dream 技能（本地 1-5am）
  // 即使今天没有 compact 触发也能找到它。触发即忘；writeSessionTranscriptSegment
  // 按消息时间戳分桶，因此多天空隔也能正确刷新每一天。
  if (feature('KAIROS')) {
    if (getKairosActive() && messages !== undefined) {
      sessionTranscriptModule?.flushOnDateChange(messages, currentDate);
    }
  }
  return [{
    type: 'date_change',
    newDate: currentDate
  }];
}
function getUltrathinkEffortAttachment(input: string | null): Attachment[] {
  if (!isUltrathinkEnabled() || !input || !hasUltrathinkKeyword(input)) {
    return [];
  }
  logEvent('tengu_ultrathink', {});
  return [{
    type: 'ultrathink_effort',
    level: 'high'
  }];
}

// 为 compact.ts 导出 — 门控在两个调用点必须一致。
export function getDeferredToolsDeltaAttachment(tools: Tools, model: string, messages: Message[] | undefined, scanContext?: DeferredToolsDeltaScanContext): Attachment[] {
  if (!isDeferredToolsDeltaEnabled()) return [];
  // 这三个检查与 isToolSearchEnabled 的同步部分镜像 —
  // 附件文本说 "available via ToolSearch"，因此 ToolSearch
  // 必须实际存在于请求中。异步 auto-threshold 检查不复制
  //（会重复触发 tengu_tool_search_mode_decision）；
  // 在 tst-auto 低于阈值时，附件可能在 ToolSearch 被过滤后触发，
  // 但这是窄情况，且宣布的工具无论如何都是可直接调用的。
  if (!isToolSearchEnabledOptimistic()) return [];
  if (!modelSupportsToolReference(model)) return [];
  if (!isToolSearchToolAvailable(tools)) return [];
  const delta = getDeferredToolsDelta(tools, messages ?? [], scanContext);
  if (!delta) return [];
  return [{
    type: 'deferred_tools_delta',
    ...delta
  }];
}

/**
 * Diff the current filtered agent pool against what's already been announced
 * in this conversation (reconstructed from prior agent_listing_delta
 * attachments). Returns [] if nothing changed or the gate is off.
 *
 * The agent list was embedded in AgentTool's description, causing ~10.2% of
 * fleet cache_creation: MCP async connect, /reload-plugins, or
 * permission-mode change → description changes → full tool-schema cache bust.
 * Moving the list here keeps the tool description static.
 *
 * Exported for compact.ts — re-announces the full set after compaction eats
 * prior deltas.
 */
export function getAgentListingDeltaAttachment(toolUseContext: ToolUseContext, messages: Message[] | undefined): Attachment[] {
  if (!shouldInjectAgentListInMessages()) return [];

  // 如果 AgentTool 不在池中则跳过 — 列表将无法操作。
  if (!toolUseContext.options.tools.some(t => toolMatchesName(t, AGENT_TOOL_NAME))) {
    return [];
  }
  const {
    activeAgents,
    allowedAgentTypes
  } = toolUseContext.options.agentDefinitions;

  // 镜像 AgentTool.prompt() 的过滤：MCP 要求 → 拒绝规则 → allowedAgentTypes 限制。
  // 与 AgentTool.tsx 保持同步。
  const mcpServers = new Set<string>();
  for (const tool of toolUseContext.options.tools) {
    const info = mcpInfoFromString(tool.name);
    if (info) mcpServers.add(info.serverName);
  }
  const permissionContext = toolUseContext.getAppState().toolPermissionContext;
  let filtered = filterDeniedAgents(filterAgentsByMcpRequirements(activeAgents, [...mcpServers]), permissionContext, AGENT_TOOL_NAME);
  if (allowedAgentTypes) {
    filtered = filtered.filter(a => allowedAgentTypes.includes(a.agentType));
  }

  // 从 transcript 中的先前增量重建已宣布集合。
  const announced = new Set<string>();
  for (const msg of messages ?? []) {
    if (msg.type !== 'attachment') continue;
    if (msg.attachment.type !== 'agent_listing_delta') continue;
    for (const t of msg.attachment.addedTypes) announced.add(t);
    for (const t of msg.attachment.removedTypes) announced.delete(t);
  }
  const currentTypes = new Set(filtered.map(a => a.agentType));
  const added = filtered.filter(a => !announced.has(a.agentType));
  const removed: string[] = [];
  for (const t of announced) {
    if (!currentTypes.has(t)) removed.push(t);
  }
  if (added.length === 0 && removed.length === 0) return [];

  // 排序以获得确定性输出 — agent 加载顺序是非确定性的
  //（插件加载竞争、MCP 异步连接）。
  added.sort((a, b) => a.agentType.localeCompare(b.agentType));
  removed.sort();
  return [{
    type: 'agent_listing_delta',
    addedTypes: added.map(a => a.agentType),
    addedLines: added.map(formatAgentLine),
    removedTypes: removed,
    isInitial: announced.size === 0,
    showConcurrencyNote: true
  }];
}

// 为 compact.ts / reactiveCompact.ts 导出 — 门控的唯一真实来源。
export function getMcpInstructionsDeltaAttachment(mcpClients: MCPServerConnection[], tools: Tools, model: string, messages: Message[] | undefined): Attachment[] {
  if (!isMcpInstructionsDeltaEnabled()) return [];

  // chrome ToolSearch 提示是客户端编写且 ToolSearch 条件性的；
  // 实际服务器 `instructions` 是无条件的。在此决定 chrome 部分，
  // 将其作为合成条目传入纯 diff。
  const clientSide: ClientSideInstruction[] = [];
  if (isToolSearchEnabledOptimistic() && modelSupportsToolReference(model) && isToolSearchToolAvailable(tools)) {
    clientSide.push({
      serverName: CLAUDE_IN_CHROME_MCP_SERVER_NAME,
      block: CHROME_TOOL_SEARCH_INSTRUCTIONS
    });
  }
  const delta = getMcpInstructionsDelta(mcpClients, messages ?? [], clientSide);
  if (!delta) return [];
  return [{
    type: 'mcp_instructions_delta',
    ...delta
  }];
}
function getCriticalSystemReminderAttachment(toolUseContext: ToolUseContext): Attachment[] {
  const reminder = toolUseContext.criticalSystemReminder_EXPERIMENTAL;
  if (!reminder) {
    return [];
  }
  return [{
    type: 'critical_system_reminder',
    content: reminder
  }];
}
function getOutputStyleAttachment(): Attachment[] {
  const settings = getSettings_DEPRECATED();
  const outputStyle = settings?.outputStyle || 'default';

  // 仅对非默认样式显示
  if (outputStyle === 'default') {
    return [];
  }
  return [{
    type: 'output_style',
    style: outputStyle
  }];
}
async function getSelectedLinesFromIDE(ideSelection: IDESelection | null, toolUseContext: ToolUseContext): Promise<Attachment[]> {
  const ideName = getConnectedIdeName(toolUseContext.options.mcpClients);
  if (!ideName || ideSelection?.lineStart === undefined || !ideSelection.text || !ideSelection.filePath) {
    return [];
  }
  const appState = toolUseContext.getAppState();
  if (isFileReadDenied(ideSelection.filePath, appState.toolPermissionContext)) {
    return [];
  }
  return [{
    type: 'selected_lines_in_ide',
    ideName,
    lineStart: ideSelection.lineStart,
    lineEnd: ideSelection.lineStart + ideSelection.lineCount - 1,
    filename: ideSelection.filePath,
    content: ideSelection.text,
    displayPath: relative(getCwd(), ideSelection.filePath)
  }];
}

/**
 * Computes the directories to process for nested memory file loading.
 * Returns two lists:
 * - nestedDirs: Directories between CWD and targetPath (processed for CLAUDE.md + all rules)
 * - cwdLevelDirs: Directories from root to CWD (processed for conditional rules only)
 *
 * @param targetPath The target file path
 * @param originalCwd The original current working directory
 * @returns Object with nestedDirs and cwdLevelDirs arrays, both ordered from parent to child
 */
export function getDirectoriesToProcess(targetPath: string, originalCwd: string): {
  nestedDirs: string[];
  cwdLevelDirs: string[];
} {
  // 构建从原始 CWD 到 targetPath 目录的目录列表
  const targetDir = dirname(resolve(targetPath));
  const nestedDirs: string[] = [];
  let currentDir = targetDir;

  // 从目标目录向上遍历到原始 CWD
  while (currentDir !== originalCwd && currentDir !== parse(currentDir).root) {
    if (currentDir.startsWith(originalCwd)) {
      nestedDirs.push(currentDir);
    }
    currentDir = dirname(currentDir);
  }

  // 反转以获得从 CWD 到目标的顺序
  nestedDirs.reverse();

  // 构建从根目录到 CWD 的目录列表（仅用于条件规则）
  const cwdLevelDirs: string[] = [];
  currentDir = originalCwd;
  while (currentDir !== parse(currentDir).root) {
    cwdLevelDirs.push(currentDir);
    currentDir = dirname(currentDir);
  }

  // 反转以获得从根目录到 CWD 的顺序
  cwdLevelDirs.reverse();
  return {
    nestedDirs,
    cwdLevelDirs
  };
}

/**
 * Converts memory files to attachments, filtering out already-loaded files.
 *
 * @param memoryFiles The memory files to convert
 * @param toolUseContext The tool use context (for tracking loaded files)
 * @returns Array of nested memory attachments
 */
function isInstructionsMemoryType(type: MemoryFileInfo['type']): type is InstructionsMemoryType {
  return type === 'User' || type === 'Project' || type === 'Local' || type === 'Managed';
}

/** Exported for testing — regression guard for LRU-eviction re-injection. */
export function memoryFilesToAttachments(memoryFiles: MemoryFileInfo[], toolUseContext: ToolUseContext, triggerFilePath?: string): Attachment[] {
  const attachments: Attachment[] = [];
  const shouldFireHook = hasInstructionsLoadedHook();
  for (const memoryFile of memoryFiles) {
    // 去重：loadedNestedMemoryPaths 是非淘汰 Set；
    // readFileState 是 100 条目 LRU，在繁忙会话中会丢弃条目，
    // 因此仅依赖它会在每次淘汰周期重新注入相同的 CLAUDE.md。
    if (toolUseContext.loadedNestedMemoryPaths?.has(memoryFile.path)) {
      continue;
    }
    if (!toolUseContext.readFileState.has(memoryFile.path)) {
      attachments.push({
        type: 'nested_memory',
        path: memoryFile.path,
        content: memoryFile,
        displayPath: relative(getCwd(), memoryFile.path)
      });
      toolUseContext.loadedNestedMemoryPaths?.add(memoryFile.path);

      // 在 readFileState 中标记为已加载 — 通过上方的 .has() 检查提供
      // 跨函数和跨轮次去重。
      //
      // 当注入的内容与磁盘不匹配（剥离的 HTML 注释、
      // 剥离的 frontmatter、截断的 MEMORY.md）时，用 `isPartialView: true`
      // 缓存原始磁盘字节。编辑/写入看到该标志并要求先进行真实读取；
      // getChangedFiles 看到真实内容 + undefined offset/limit，
      // 因此会话中期的更改检测仍然有效。
      toolUseContext.readFileState.set(memoryFile.path, {
        content: memoryFile.contentDiffersFromDisk ? memoryFile.rawContent ?? memoryFile.content : memoryFile.content,
        timestamp: Date.now(),
        offset: undefined,
        limit: undefined,
        isPartialView: memoryFile.contentDiffersFromDisk
      });

      // 触发 InstructionsLoaded hook 用于审计/可观测性（触发即忘）
      if (shouldFireHook && isInstructionsMemoryType(memoryFile.type)) {
        const loadReason = memoryFile.globs ? 'path_glob_match' : memoryFile.parent ? 'include' : 'nested_traversal';
        void executeInstructionsLoadedHooks(memoryFile.path, memoryFile.type, loadReason, {
          globs: memoryFile.globs,
          triggerFilePath,
          parentFilePath: memoryFile.parent
        });
      }
    }
  }
  return attachments;
}

/**
 * Loads nested memory files for a given file path and returns them as attachments.
 * This function performs directory traversal to find CLAUDE.md files and conditional rules
 * that apply to the target file path.
 *
 * Processing order (must be preserved):
 * 1. Managed/User conditional rules matching targetPath
 * 2. Nested directories (CWD → target): CLAUDE.md + unconditional + conditional rules
 * 3. CWD-level directories (root → CWD): conditional rules only
 *
 * @param filePath The file path to get nested memory files for
 * @param toolUseContext The tool use context
 * @param appState The app state containing tool permission context
 * @returns Array of nested memory attachments
 */
async function getNestedMemoryAttachmentsForFile(filePath: string, toolUseContext: ToolUseContext, appState: {
  toolPermissionContext: ToolPermissionContext;
}): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  try {
    // 如果路径不在允许的工作路径中，提前返回
    if (!pathInAllowedWorkingPath(filePath, appState.toolPermissionContext)) {
      return attachments;
    }
    const processedPaths = new Set<string>();
    const originalCwd = getOriginalCwd();

    // 阶段 1：处理 Managed 和 User 条件规则
    const managedUserRules = await getManagedAndUserConditionalRules(filePath, processedPaths);
    attachments.push(...memoryFilesToAttachments(managedUserRules, toolUseContext, filePath));

    // 阶段 2：获取要处理的目录
    const {
      nestedDirs,
      cwdLevelDirs
    } = getDirectoriesToProcess(filePath, originalCwd);
    const skipProjectLevel = getFeatureValue_CACHED_MAY_BE_STALE('tengu_paper_halyard', false);

    // 阶段 3：处理嵌套目录（CWD → target）
    // 每个目录获取：CLAUDE.md + 无条件规则 + 条件规则
    for (const dir of nestedDirs) {
      const memoryFiles = (await getMemoryFilesForNestedDirectory(dir, filePath, processedPaths)).filter(f => !skipProjectLevel || f.type !== 'Project' && f.type !== 'Local');
      attachments.push(...memoryFilesToAttachments(memoryFiles, toolUseContext, filePath));
    }

    // 阶段 4：处理 CWD 级目录（root → CWD）
    // 仅条件规则（无条件规则已预先热加载）
    for (const dir of cwdLevelDirs) {
      const conditionalRules = (await getConditionalRulesForCwdLevelDirectory(dir, filePath, processedPaths)).filter(f => !skipProjectLevel || f.type !== 'Project' && f.type !== 'Local');
      attachments.push(...memoryFilesToAttachments(conditionalRules, toolUseContext, filePath));
    }
  } catch (error) {
    logError(error);
  }
  return attachments;
}
async function getOpenedFileFromIDE(ideSelection: IDESelection | null, toolUseContext: ToolUseContext): Promise<Attachment[]> {
  if (!ideSelection?.filePath || ideSelection.text) {
    return [];
  }
  const appState = toolUseContext.getAppState();
  if (isFileReadDenied(ideSelection.filePath, appState.toolPermissionContext)) {
    return [];
  }

  // 获取嵌套记忆文件
  const nestedMemoryAttachments = await getNestedMemoryAttachmentsForFile(ideSelection.filePath, toolUseContext, appState);

  // 返回嵌套记忆附件，然后是打开的文件附件
  return [...nestedMemoryAttachments, {
    type: 'opened_file_in_ide',
    filename: ideSelection.filePath
  }];
}
async function processAtMentionedFiles(input: string, toolUseContext: ToolUseContext): Promise<Attachment[]> {
  const files = extractAtMentionedFiles(input);
  if (files.length === 0) return [];
  const appState = toolUseContext.getAppState();
  const results = await Promise.all(files.map(async file => {
    try {
      const {
        filename,
        lineStart,
        lineEnd
      } = parseAtMentionedFileLines(file);
      const absoluteFilename = expandPath(filename);
      if (isFileReadDenied(absoluteFilename, appState.toolPermissionContext)) {
        return null;
      }

      // 检查是否是目录
      try {
        const stats = await stat(absoluteFilename);
        if (stats.isDirectory()) {
          try {
            const entries = await readdir(absoluteFilename, {
              withFileTypes: true
            });
            const MAX_DIR_ENTRIES = 1000;
            const truncated = entries.length > MAX_DIR_ENTRIES;
            const names = entries.slice(0, MAX_DIR_ENTRIES).map(e => e.name);
            if (truncated) {
              names.push(`\u2026 and ${entries.length - MAX_DIR_ENTRIES} more entries`);
            }
            const stdout = names.join('\n');
            logEvent('tengu_at_mention_extracting_directory_success', {});
            return {
              type: 'directory' as const,
              path: absoluteFilename,
              content: stdout,
              displayPath: relative(getCwd(), absoluteFilename)
            };
          } catch {
            return null;
          }
        }
      } catch {
        // 如果 stat 失败，继续执行文件逻辑
      }
      return await generateFileAttachment(absoluteFilename, toolUseContext, 'tengu_at_mention_extracting_filename_success', 'tengu_at_mention_extracting_filename_error', 'at-mention', {
        offset: lineStart,
        limit: lineEnd && lineStart ? lineEnd - lineStart + 1 : undefined
      });
    } catch {
      logEvent('tengu_at_mention_extracting_filename_error', {});
    }
  }));
  return results.filter(Boolean) as Attachment[];
}
function processAgentMentions(input: string, agents: AgentDefinition[]): Attachment[] {
  const agentMentions = extractAgentMentions(input);
  if (agentMentions.length === 0) return [];
  const results = agentMentions.map(mention => {
    const agentType = mention.replace('agent-', '');
    const agentDef = agents.find(def => def.agentType === agentType);
    if (!agentDef) {
      logEvent('tengu_at_mention_agent_not_found', {});
      return null;
    }
    logEvent('tengu_at_mention_agent_success', {});
    return {
      type: 'agent_mention' as const,
      agentType: agentDef.agentType
    };
  });
  return results.filter((result): result is NonNullable<typeof result> => result !== null);
}
async function processMcpResourceAttachments(input: string, toolUseContext: ToolUseContext): Promise<Attachment[]> {
  const resourceMentions = extractMcpResourceMentions(input);
  if (resourceMentions.length === 0) return [];
  const mcpClients = toolUseContext.options.mcpClients || [];
  const results = await Promise.all(resourceMentions.map(async mention => {
    try {
      const [serverName, ...uriParts] = mention.split(':');
      const uri = uriParts.join(':'); // 重新连接，以防 URI 包含冒号

      if (!serverName || !uri) {
        logEvent('tengu_at_mention_mcp_resource_error', {});
        return null;
      }

      // 查找 MCP 客户端
      const client = mcpClients.find(c => c.name === serverName);
      if (!client || client.type !== 'connected') {
        logEvent('tengu_at_mention_mcp_resource_error', {});
        return null;
      }

      // 在可用资源中查找资源以获取其元数据
      const serverResources = toolUseContext.options.mcpResources?.[serverName] || [];
      const resourceInfo = serverResources.find(r => r.uri === uri);
      if (!resourceInfo) {
        logEvent('tengu_at_mention_mcp_resource_error', {});
        return null;
      }
      try {
        const result = await client.client.readResource({
          uri
        });
        logEvent('tengu_at_mention_mcp_resource_success', {});
        return {
          type: 'mcp_resource' as const,
          server: serverName,
          uri,
          name: resourceInfo.name || uri,
          description: resourceInfo.description,
          content: result
        };
      } catch (error) {
        logEvent('tengu_at_mention_mcp_resource_error', {});
        logError(error);
        return null;
      }
    } catch {
      logEvent('tengu_at_mention_mcp_resource_error', {});
      return null;
    }
  }));
  return results.filter((result): result is NonNullable<typeof result> => result !== null) as Attachment[];
}
export async function getChangedFiles(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  const filePaths = cacheKeys(toolUseContext.readFileState);
  if (filePaths.length === 0) return [];
  const appState = toolUseContext.getAppState();
  const results = await Promise.all(filePaths.map(async filePath => {
    const fileState = toolUseContext.readFileState.get(filePath);
    if (!fileState) return null;

    // TODO：实现 changed files 的 offset/limit 支持
    if (fileState.offset !== undefined || fileState.limit !== undefined) {
      return null;
    }
    const normalizedPath = expandPath(filePath);

    // 检查文件是否配置了拒绝规则
    if (isFileReadDenied(normalizedPath, appState.toolPermissionContext)) {
      return null;
    }
    try {
      const mtime = await getFileModificationTimeAsync(normalizedPath);
      if (mtime <= fileState.timestamp) {
        return null;
      }
      const fileInput = {
        file_path: normalizedPath
      };

      // 验证文件路径有效
      const isValid = await FileReadTool.validateInput(fileInput, toolUseContext);
      if (!isValid.result) {
        return null;
      }
      const result = await FileReadTool.call(fileInput, toolUseContext);
      // 仅提取更改的部分
      if (result.data.type === 'text') {
        const snippet = getSnippetForTwoFileDiff(fileState.content, result.data.file.content);

        // 文件被触及但未修改
        if (snippet === '') {
          return null;
        }
        return {
          type: 'edited_text_file' as const,
          filename: normalizedPath,
          snippet
        };
      }

      // 对于非文本文件（图片），应用与 FileReadTool 相同的 token 限制逻辑
      if (result.data.type === 'image') {
        try {
          const data = await readImageWithTokenBudget(normalizedPath);
          return {
            type: 'edited_image_file' as const,
            filename: normalizedPath,
            content: data
          };
        } catch (compressionError) {
          logError(compressionError);
          logEvent('tengu_watched_file_compression_failed', {
            file: normalizedPath
          } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS);
          return null;
        }
      }

      // notebook / pdf / parts — 无差异表示；显式返回 null，
      // 使 map 回调没有隐式 undefined 路径。
      return null;
    } catch (err) {
      // 仅在 ENOENT 时淘汰（文件真正删除）。瞬时 stat 失败 —
      // 原子保存竞争（编辑器写入 tmp→rename 且 stat 命中间隙）、
      // EACCES 变动、网络 FS 抖动 — 绝不能淘汰，否则下次 Edit
      // 会 code-6 失败，尽管文件仍然存在且模型刚读取过它。
      // VS Code 自动保存/保存时格式化尤其频繁命中此竞争。
      // 见 PR #18525 的回归分析。
      if (isENOENT(err)) {
        toolUseContext.readFileState.delete(filePath);
      }
      return null;
    }
  }));
  return results.filter(result => result != null) as Attachment[];
}

/**
 * Processes paths that need nested memory attachments and checks for nested CLAUDE.md files
 * Uses nestedMemoryAttachmentTriggers field from ToolUseContext
 */
async function getNestedMemoryAttachments(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  // 先检查触发器 — getAppState() 等待 React 渲染周期，
  // 而常见情况是空触发器集合。
  if (!toolUseContext.nestedMemoryAttachmentTriggers || toolUseContext.nestedMemoryAttachmentTriggers.size === 0) {
    return [];
  }
  const appState = toolUseContext.getAppState();
  const attachments: Attachment[] = [];
  for (const filePath of toolUseContext.nestedMemoryAttachmentTriggers) {
    const nestedAttachments = await getNestedMemoryAttachmentsForFile(filePath, toolUseContext, appState);
    attachments.push(...nestedAttachments);
  }
  toolUseContext.nestedMemoryAttachmentTriggers.clear();
  return attachments;
}
async function getRelevantMemoryAttachments(input: string, agents: AgentDefinition[], readFileState: FileStateCache, recentTools: readonly string[], signal: AbortSignal, alreadySurfaced: ReadonlySet<string>): Promise<Attachment[]> {
  // 如果 @-mention 了 agent，仅搜索其记忆目录（隔离）。
  // 否则搜索自动记忆目录。
  const memoryDirs = extractAgentMentions(input).flatMap(mention => {
    const agentType = mention.replace('agent-', '');
    const agentDef = agents.find(def => def.agentType === agentType);
    return agentDef?.memory ? [getAgentMemoryDir(agentType, agentDef.memory)] : [];
  });
  const dirs = memoryDirs.length > 0 ? memoryDirs : [getAutoMemPath()];
  const allResults = await Promise.all(dirs.map(dir => findRelevantMemories(input, dir, signal, recentTools, alreadySurfaced).catch(() => [])));
  // alreadySurfaced 在选择器内部过滤，使 Sonnet 的 5 槽预算用于新候选；
  // readFileState 捕获模型通过 FileReadTool 读取的文件。此处冗余的
  // alreadySurfaced 检查是双重保险（多目录结果可能重新引入选择器
  // 在其他目录中过滤的路径）。
  const selected = allResults.flat().filter(m => !readFileState.has(m.path) && !alreadySurfaced.has(m.path)).slice(0, 5);
  const memories = await readMemoriesForSurfacing(selected, signal);
  if (memories.length === 0) {
    return [];
  }
  return [{
    type: 'relevant_memories' as const,
    memories
  }];
}

/**
 * Scan messages for past relevant_memories attachments.  Returns both the
 * set of surfaced paths (for selector de-dup) and cumulative byte count
 * (for session-total throttle).  Scanning messages rather than tracking
 * in toolUseContext means compact naturally resets both — old attachments
 * are gone from the compacted transcript, so re-surfacing is valid again.
 */
export function collectSurfacedMemories(messages: ReadonlyArray<Message>): {
  paths: Set<string>;
  totalBytes: number;
} {
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const m of messages) {
    if (m.type === 'attachment' && m.attachment.type === 'relevant_memories') {
      for (const mem of m.attachment.memories) {
        paths.add(mem.path);
        totalBytes += mem.content.length;
      }
    }
  }
  return {
    paths,
    totalBytes
  };
}

/**
 * Reads a set of relevance-ranked memory files for injection as
 * <system-reminder> attachments. Enforces both MAX_MEMORY_LINES and
 * MAX_MEMORY_BYTES via readFileInRange's truncateOnByteLimit option.
 * Truncation surfaces partial
 * content with a note rather than dropping the file — findRelevantMemories
 * already picked this as most-relevant, so the frontmatter + opening context
 * is worth surfacing even if later lines are cut.
 *
 * Exported for direct testing without mocking the ranker + GB gates.
 */
export async function readMemoriesForSurfacing(selected: ReadonlyArray<{
  path: string;
  mtimeMs: number;
}>, signal?: AbortSignal): Promise<Array<{
  path: string;
  content: string;
  mtimeMs: number;
  header: string;
  limit?: number;
}>> {
  const results = await Promise.all(selected.map(async ({
    path: filePath,
    mtimeMs
  }) => {
    try {
      const result = await readFileInRange(filePath, 0, MAX_MEMORY_LINES, MAX_MEMORY_BYTES, signal, {
        truncateOnByteLimit: true
      });
      const truncated = result.totalLines > MAX_MEMORY_LINES || result.truncatedByBytes;
      const content = truncated ? result.content + `\n\n> This memory file was truncated (${result.truncatedByBytes ? `${MAX_MEMORY_BYTES} byte limit` : `first ${MAX_MEMORY_LINES} lines`}). Use the ${FILE_READ_TOOL_NAME} tool to view the complete file at: ${filePath}` : result.content;
      return {
        path: filePath,
        content,
        mtimeMs,
        header: memoryHeader(filePath, mtimeMs),
        limit: truncated ? result.lineCount : undefined
      };
    } catch {
      return null;
    }
  }));
  return results.filter(r => r !== null);
}

/**
 * Header string for a relevant-memory block.  Exported so messages.ts
 * can fall back for resumed sessions where the stored header is missing.
 */
export function memoryHeader(path: string, mtimeMs: number): string {
  const staleness = memoryFreshnessText(mtimeMs);
  return staleness ? `${staleness}\n\nMemory: ${path}:` : `Memory (saved ${memoryAge(mtimeMs)}): ${path}:`;
}

/**
 * A memory relevance-selector prefetch handle. The promise is started once
 * per user turn and runs while the main model streams and tools execute.
 * At the collect point (post-tools), the caller reads settledAt to
 * consume-if-ready or skip-and-retry-next-iteration — the prefetch never
 * blocks the turn.
 *
 * Disposable: query.ts binds with `using`, so [Symbol.dispose] fires on all
 * generator exit paths (return, throw, .return() closure) — aborting the
 * in-flight request and emitting terminal telemetry without instrumenting
 * each of the ~13 return sites inside the while loop.
 */
export type MemoryPrefetch = {
  promise: Promise<Attachment[]>;
  /** Set by promise.finally(). null until the promise settles. */
  settledAt: number | null;
  /** Set by the collect point in query.ts. -1 until consumed. */
  consumedOnIteration: number;
  [Symbol.dispose](): void;
};

/**
 * Starts the relevant memory search as an async prefetch.
 * Extracts the last real user prompt from messages (skipping isMeta system
 * injections) and kicks off a non-blocking search. Returns a Disposable
 * handle with settlement tracking. Bound with `using` in query.ts.
 */
export function startRelevantMemoryPrefetch(messages: ReadonlyArray<Message>, toolUseContext: ToolUseContext): MemoryPrefetch | undefined {
  if (!isAutoMemoryEnabled() || !getFeatureValue_CACHED_MAY_BE_STALE('tengu_moth_copse', false)) {
    return undefined;
  }
  const lastUserMessage = messages.findLast(m => m.type === 'user' && !m.isMeta);
  if (!lastUserMessage) {
    return undefined;
  }
  const input = getUserMessageText(lastUserMessage);
  // 单字提示缺乏足够上下文来进行有意义的术语提取
  if (!input || !/\s/.test(input.trim())) {
    return undefined;
  }
  const surfaced = collectSurfacedMemories(messages);
  if (surfaced.totalBytes >= RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES) {
    return undefined;
  }

  // 链接到轮次级 abort，使用户 Escape 能立即取消 sideQuery，
  // 而非仅在 queryLoop 退出时的 [Symbol.dispose] 取消。
  const controller = createChildAbortController(toolUseContext.abortController);
  const firedAt = Date.now();
  const promise = getRelevantMemoryAttachments(input, toolUseContext.options.agentDefinitions.activeAgents, toolUseContext.readFileState, collectRecentSuccessfulTools(messages, lastUserMessage), controller.signal, surfaced.paths).catch(e => {
    if (!isAbortError(e)) {
      logError(e);
    }
    return [];
  });
  const handle: MemoryPrefetch = {
    promise,
    settledAt: null,
    consumedOnIteration: -1,
    [Symbol.dispose]() {
      controller.abort();
      logEvent('tengu_memdir_prefetch_collected', {
        hidden_by_first_iteration: handle.settledAt !== null && handle.consumedOnIteration === 0,
        consumed_on_iteration: handle.consumedOnIteration,
        latency_ms: (handle.settledAt ?? Date.now()) - firedAt
      });
    }
  };
  void promise.finally(() => {
    handle.settledAt = Date.now();
  });
  return handle;
}
type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  is_error?: boolean;
};
function isToolResultBlock(b: unknown): b is ToolResultBlock {
  return typeof b === 'object' && b !== null && (b as ToolResultBlock).type === 'tool_result' && typeof (b as ToolResultBlock).tool_use_id === 'string';
}

/**
 * Check whether a user message's content contains tool_result blocks.
 * This is more reliable than checking `toolUseResult === undefined` because
 * sub-agent tool result messages explicitly set `toolUseResult` to `undefined`
 * when `preserveToolUseResults` is false (the default for Explore agents).
 */
function hasToolResultContent(content: unknown): boolean {
  return Array.isArray(content) && content.some(isToolResultBlock);
}

/**
 * Tools that succeeded (and never errored) since the previous real turn
 * boundary.  The memory selector uses this to suppress docs about tools
 * that are working — surfacing reference material for a tool the model
 * is already calling successfully is noise.
 *
 * Any error → tool excluded (model is struggling, docs stay available).
 * No result yet → also excluded (outcome unknown).
 *
 * tool_use lives in assistant content; tool_result in user content
 * (toolUseResult set, isMeta undefined).  Both are within the scan window.
 * Backward scan sees results before uses so we collect both by id and
 * resolve after.
 */
export function collectRecentSuccessfulTools(messages: ReadonlyArray<Message>, lastUserMessage: Message): readonly string[] {
  const useIdToName = new Map<string, string>();
  const resultByUseId = new Map<string, boolean>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (isHumanTurn(m) && m !== lastUserMessage) break;
    if (m.type === 'assistant' && typeof m.message.content !== 'string') {
      for (const block of m.message.content) {
        if (block.type === 'tool_use') useIdToName.set(block.id, block.name);
      }
    } else if (m.type === 'user' && 'message' in m && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (isToolResultBlock(block)) {
          resultByUseId.set(block.tool_use_id, block.is_error === true);
        }
      }
    }
  }
  const failed = new Set<string>();
  const succeeded = new Set<string>();
  for (const [id, name] of useIdToName) {
    const errored = resultByUseId.get(id);
    if (errored === undefined) continue;
    if (errored) {
      failed.add(name);
    } else {
      succeeded.add(name);
    }
  }
  return [...succeeded].filter(t => !failed.has(t));
}

/**
 * Filters prefetched memory attachments to exclude memories the model already
 * has in context via FileRead/Write/Edit tool calls (any iteration this turn)
 * or a previous turn's memory surfacing — both tracked in the cumulative
 * readFileState. Survivors are then marked in readFileState so subsequent
 * turns won't re-surface them.
 *
 * The mark-after-filter ordering is load-bearing: readMemoriesForSurfacing
 * used to write to readFileState during the prefetch, which meant the filter
 * saw every prefetch-selected path as "already in context" and dropped them
 * all (self-referential filter). Deferring the write to here, after the
 * filter runs, breaks that cycle while still deduping against tool calls
 * from any iteration.
 */
export function filterDuplicateMemoryAttachments(attachments: Attachment[], readFileState: FileStateCache): Attachment[] {
  return attachments.map(attachment => {
    if (attachment.type !== 'relevant_memories') return attachment;
    const filtered = attachment.memories.filter(m => !readFileState.has(m.path));
    for (const m of filtered) {
      readFileState.set(m.path, {
        content: m.content,
        timestamp: m.mtimeMs,
        offset: undefined,
        limit: m.limit
      });
    }
    return filtered.length > 0 ? {
      ...attachment,
      memories: filtered
    } : null;
  }).filter((a): a is Attachment => a !== null);
}

/**
 * Processes skill directories that were discovered during file operations.
 * Uses dynamicSkillDirTriggers field from ToolUseContext
 */
async function getDynamicSkillAttachments(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  if (toolUseContext.dynamicSkillDirTriggers && toolUseContext.dynamicSkillDirTriggers.size > 0) {
    // 并行化：并发 readdir 所有技能目录
    const perDirResults = await Promise.all(Array.from(toolUseContext.dynamicSkillDirTriggers).map(async skillDir => {
      try {
        const entries = await readdir(skillDir, {
          withFileTypes: true
        });
        const candidates = entries.filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name);
        // 并行化：并发 stat 所有 SKILL.md 候选
        const checked = await Promise.all(candidates.map(async name => {
          try {
            await stat(resolve(skillDir, name, 'SKILL.md'));
            return name;
          } catch {
            return null; // SKILL.md 不存在，跳过此项
          }
        }));
        return {
          skillDir,
          skillNames: checked.filter((n): n is string => n !== null)
        };
      } catch {
        // 忽略读取技能目录时的错误（例如目录不存在）
        return {
          skillDir,
          skillNames: []
        };
      }
    }));
    for (const {
      skillDir,
      skillNames
    } of perDirResults) {
      if (skillNames.length > 0) {
        attachments.push({
          type: 'dynamic_skill',
          skillDir,
          skillNames,
          displayPath: relative(getCwd(), skillDir)
        });
      }
    }
    toolUseContext.dynamicSkillDirTriggers.clear();
  }
  return attachments;
}

// 追踪已发送的技能以避免重复发送。按 agentId 键控
//（空字符串 = 主线程），使子代理获得自己的首轮列表 —
// 如果没有每代理作用域，主线程填充此 Set 会导致
// 每个子代理的 filterToBundledAndMcp 结果去重为空。
const sentSkillNames = new Map<string, Set<string>>();

// 当技能集合真正改变时调用（插件重载、磁盘上技能文件变更），
// 使新技能被宣布。不在 compact 时调用 —
// compact 后重新注入成本约 4K tokens/event，收益甚微。
export function resetSentSkillNames(): void {
  sentSkillNames.clear();
  suppressNext = false;
}

/**
 * Suppress the next skill-listing injection. Called by conversationRecovery
 * on --resume when a skill_listing attachment already exists in the
 * transcript.
 *
 * `sentSkillNames` is module-scope — process-local. Each `zy -p` spawn
 * starts with an empty Map, so without this every resume re-injects the
 * full ~600-token listing even though it's already in the conversation from
 * the prior process. Shows up on every --resume; particularly loud for
 * daemons that respawn frequently.
 *
 * Trade-off: skills added between sessions won't be announced until the
 * next non-resume session. Acceptable — skill_listing was never meant to
 * cover cross-process deltas, and the agent can still call them (they're
 * in the Skill tool's runtime registry regardless).
 */
export function suppressNextSkillListing(): void {
  suppressNext = true;
}
let suppressNext = false;

// 当启用技能搜索且过滤后（bundled + MCP）列表超过此数量时，
// 回退到仅 bundled。保护重 MCP 用户（100+ 服务器）免于截断，
// 同时保持典型设置的首轮保证。
const FILTERED_LISTING_MAX = 30;

/**
 * Filter skills to bundled (Anthropic-curated) + MCP (user-connected) only.
 * Used when skill-search is enabled to resolve the turn-0 gap for subagents:
 * these sources are small, intent-signaled, and won't hit the truncation budget.
 * User/project/plugin skills (the long tail — 200+) go through discovery instead.
 *
 * Falls back to bundled-only if bundled+mcp exceeds FILTERED_LISTING_MAX.
 */
export function filterToBundledAndMcp(commands: Command[]): Command[] {
  const filtered = commands.filter(cmd => cmd.loadedFrom === 'bundled' || cmd.loadedFrom === 'mcp');
  if (filtered.length > FILTERED_LISTING_MAX) {
    return filtered.filter(cmd => cmd.loadedFrom === 'bundled');
  }
  return filtered;
}
async function getSkillListingAttachments(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  if (process.env.NODE_ENV === 'test') {
    return [];
  }

  // 跳过没有 Skill 工具的代理的技能列表 — 它们无法直接使用技能。
  if (!toolUseContext.options.tools.some(t => toolMatchesName(t, SKILL_TOOL_NAME))) {
    return [];
  }
  const cwd = getProjectRoot();
  const localCommands = await getSkillToolCommands(cwd);
  const mcpSkills = getMcpSkillCommands(toolUseContext.getAppState().mcp.commands);
  let allCommands = mcpSkills.length > 0 ? uniqBy([...localCommands, ...mcpSkills], 'name') : localCommands;

  // 当技能搜索活跃时，过滤到 bundled + MCP 而非完全抑制。
  // 解决首轮缺口：主线程通过 getTurnZeroSkillDiscovery（阻塞）获得首轮发现，
  // 但子代理使用异步 subagent_spawn 信号（工具后收集，首轮可见）。
  // Bundled + MCP 小巧且有意图信号；用户/项目/插件技能通过发现获取。
  // feature() 优先用于 DCE — 否则属性访问字符串会泄露，即使对 null 使用 ?.。
  if (feature('EXPERIMENTAL_SKILL_SEARCH') && skillSearchModules?.featureCheck.isSkillSearchEnabled()) {
    allCommands = filterToBundledAndMcp(allCommands);
  }
  const agentKey = toolUseContext.agentId ?? '';
  let sent = sentSkillNames.get(agentKey);
  if (!sent) {
    sent = new Set();
    sentSkillNames.set(agentKey, sent);
  }

  // 恢复路径：之前的进程已注入列表；它在 transcript 中。
  // 将当前所有内容标记为已发送，因此仅恢复后的增量
  //（后来通过 /reload-plugins 等加载的技能）会被宣布。
  if (suppressNext) {
    suppressNext = false;
    for (const cmd of allCommands) {
      sent.add(cmd.name);
    }
    return [];
  }

  // 查找尚未发送的技能
  const newSkills = allCommands.filter(cmd => !sent.has(cmd.name));
  if (newSkills.length === 0) {
    return [];
  }

  // 如果尚未发送任何技能，这是初始批次
  const isInitial = sent.size === 0;

  // 标记为已发送
  for (const cmd of newSkills) {
    sent.add(cmd.name);
  }
  logForDebugging(`Sending ${newSkills.length} skills via attachment (${isInitial ? 'initial' : 'dynamic'}, ${sent.size} total sent)`);

  // 使用现有逻辑在预算内格式化
  const contextWindowTokens = getContextWindowForModel(toolUseContext.options.mainLoopModel, getSdkBetas());
  const content = formatCommandsWithinBudget(newSkills, contextWindowTokens);
  return [{
    type: 'skill_listing',
    content,
    skillCount: newSkills.length,
    isInitial
  }];
}

// getSkillDiscoveryAttachment 已移至 skillSearch/prefetch.ts 中作为
// getTurnZeroSkillDiscovery — 将 'skill_discovery' 字符串字面量保留在
// 特性门控模块内，使其不会泄露到外部构建中。

export function extractAtMentionedFiles(content: string): string[] {
  // 提取带有 @ 符号的文件名，包括行范围语法：@file.txt#L10-20
  // 也支持带空格文件的引号路径：@"my/file with spaces.txt"
  // 示例："foo bar @baz moo" 会提取 "baz"
  // 示例：'check @"my file.txt" please' 会提取 "my file.txt"

  // 两种模式：引号路径和普通路径
  const quotedAtMentionRegex = /(^|\s)@"([^"]+)"/g;
  const regularAtMentionRegex = /(^|\s)@([^\s]+)\b/g;
  const quotedMatches: string[] = [];
  const regularMatches: string[] = [];

  // 先提取引号提及（跳过 agent 提及如 @"code-reviewer (agent)"）
  let match;
  while ((match = quotedAtMentionRegex.exec(content)) !== null) {
    if (match[2] && !match[2].endsWith(' (agent)')) {
      quotedMatches.push(match[2]); // 引号内的内容
    }
  }

  // 提取普通提及
  const regularMatchArray = content.match(regularAtMentionRegex) || [];
  regularMatchArray.forEach(match => {
    const filename = match.slice(match.indexOf('@') + 1);
    // 如果以引号开头则不包含（已作为引号处理）
    if (!filename.startsWith('"')) {
      regularMatches.push(filename);
    }
  });

  // 合并并去重
  return uniq([...quotedMatches, ...regularMatches]);
}
export function extractMcpResourceMentions(content: string): string[] {
  // 提取带有 @ 符号的 MCP 资源，格式为 @server:uri
  // 示例："@server1:resource/path" 会提取 "server1:resource/path"
  const atMentionRegex = /(^|\s)@([^\s]+:[^\s]+)\b/g;
  const matches = content.match(atMentionRegex) || [];

  // 从每个匹配中移除前缀（@ 之前的所有内容）
  return uniq(matches.map(match => match.slice(match.indexOf('@') + 1)));
}
export function extractAgentMentions(content: string): string[] {
  // 提取两种格式的 agent 提及：
  // 1. @agent-<agent-type>（旧版/手动输入）
  //    示例："@agent-code-elegance-refiner" → "agent-code-elegance-refiner"
  // 2. @"<agent-type> (agent)"（来自自动完成选择）
  //    示例：'@"code-reviewer (agent)"' → "code-reviewer"
  // 支持冒号、点和 @-符号用于插件作用域 agent，如 "@agent-asana:project-status-updater"
  const results: string[] = [];

  // 匹配引号格式：@"<type> (agent)"
  const quotedAgentRegex = /(^|\s)@"([\w:.@-]+) \(agent\)"/g;
  let match;
  while ((match = quotedAgentRegex.exec(content)) !== null) {
    if (match[2]) {
      results.push(match[2]);
    }
  }

  // 匹配非引号格式：@agent-<type>
  const unquotedAgentRegex = /(^|\s)@(agent-[\w:.@-]+)/g;
  const unquotedMatches = content.match(unquotedAgentRegex) || [];
  for (const m of unquotedMatches) {
    results.push(m.slice(m.indexOf('@') + 1));
  }
  return uniq(results);
}
interface AtMentionedFileLines {
  filename: string;
  lineStart?: number;
  lineEnd?: number;
}
export function parseAtMentionedFileLines(mention: string): AtMentionedFileLines {
  // 解析如 "file.txt#L10-20"、"file.txt#heading" 或仅 "file.txt" 的提及
  // 支持行范围（#L10、#L10-20）并剥离非行范围片段（#heading）
  const match = mention.match(/^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/);
  if (!match) {
    return {
      filename: mention
    };
  }
  const [, filename, lineStartStr, lineEndStr] = match;
  const lineStart = lineStartStr ? parseInt(lineStartStr, 10) : undefined;
  const lineEnd = lineEndStr ? parseInt(lineEndStr, 10) : lineStart;
  return {
    filename: filename ?? mention,
    lineStart,
    lineEnd
  };
}
async function getDiagnosticAttachments(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  // 仅当代理有 Bash 工具可操作时诊断才有用
  if (!toolUseContext.options.tools.some(t => toolMatchesName(t, BASH_TOOL_NAME))) {
    return [];
  }

  // 从追踪器获取新诊断（通过 MCP 的 IDE 诊断）
  const newDiagnostics = await diagnosticTracker.getNewDiagnostics();
  if (newDiagnostics.length === 0) {
    return [];
  }
  return [{
    type: 'diagnostics',
    files: newDiagnostics,
    isNew: true
  }];
}

/**
 * Get LSP diagnostic attachments from passive LSP servers.
 * Follows the AsyncHookRegistry pattern for consistent async attachment delivery.
 */
async function getLSPDiagnosticAttachments(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  // 仅当代理有 Bash 工具可操作时 LSP 诊断才有用
  if (!toolUseContext.options.tools.some(t => toolMatchesName(t, BASH_TOOL_NAME))) {
    return [];
  }
  logForDebugging('LSP Diagnostics: getLSPDiagnosticAttachments called');
  try {
    const diagnosticSets = checkForLSPDiagnostics();
    if (diagnosticSets.length === 0) {
      return [];
    }
    logForDebugging(`LSP Diagnostics: Found ${diagnosticSets.length} pending diagnostic set(s)`);

    // 将每个诊断集转换为附件
    const attachments: Attachment[] = diagnosticSets.map(({
      files
    }) => ({
      type: 'diagnostics' as const,
      files,
      isNew: true
    }));

    // 从注册表清除已交付的诊断以防止内存泄漏
    // 遵循与 removeDeliveredAsyncHooks 相同的模式
    if (diagnosticSets.length > 0) {
      clearAllLSPDiagnostics();
      logForDebugging(`LSP Diagnostics: Cleared ${diagnosticSets.length} delivered diagnostic(s) from registry`);
    }
    logForDebugging(`LSP Diagnostics: Returning ${attachments.length} diagnostic attachment(s)`);
    return attachments;
  } catch (error) {
    const err = toError(error);
    logError(new Error(`Failed to get LSP diagnostic attachments: ${err.message}`));
    // 返回空数组以允许其他附件继续进行
    return [];
  }
}
export async function* getAttachmentMessages(input: string | null, toolUseContext: ToolUseContext, ideSelection: IDESelection | null, queuedCommands: QueuedCommand[], messages?: Message[], querySource?: QuerySource, options?: {
  skipSkillDiscovery?: boolean;
}): AsyncGenerator<AttachmentMessage, void> {
  // TODO：在上游计算此值
  const attachments = await getAttachments(input, toolUseContext, ideSelection, queuedCommands, messages, querySource, options);
  if (attachments.length === 0) {
    return;
  }
  logEvent('tengu_attachments', {
    attachment_types: attachments.map(_ => _.type) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  for (const attachment of attachments) {
    yield createAttachmentMessage(attachment);
  }
}

/**
 * Generates a file attachment by reading a file with proper validation and truncation.
 * This is the core file reading logic shared between @-mentioned files and post-compact restoration.
 *
 * @param filename The absolute path to the file to read
 * @param toolUseContext The tool use context for calling FileReadTool
 * @param options Optional configuration for file reading
 * @returns A new_file attachment or null if the file couldn't be read
 */
/**
 * Check if a PDF file should be represented as a lightweight reference
 * instead of being inlined. Returns a PDFReferenceAttachment for large PDFs
 * (more than PDF_AT_MENTION_INLINE_THRESHOLD pages), or null otherwise.
 */
export async function tryGetPDFReference(filename: string): Promise<PDFReferenceAttachment | null> {
  const ext = parse(filename).ext.toLowerCase();
  if (!isPDFExtension(ext)) {
    return null;
  }
  try {
    const [stats, pageCount] = await Promise.all([getFsImplementation().stat(filename), getPDFPageCount(filename)]);
    // 如果有页数则使用，否则回退到大小启发式（每页约 100KB）
    const effectivePageCount = pageCount ?? Math.ceil(stats.size / (100 * 1024));
    if (effectivePageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
      logEvent('tengu_pdf_reference_attachment', {
        pageCount: effectivePageCount,
        fileSize: stats.size,
        hadPdfinfo: pageCount !== null
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS);
      return {
        type: 'pdf_reference',
        filename,
        pageCount: effectivePageCount,
        fileSize: stats.size,
        displayPath: relative(getCwd(), filename)
      };
    }
  } catch {
    // 如果无法 stat 文件，返回 null 以继续正常读取
  }
  return null;
}
export async function generateFileAttachment(filename: string, toolUseContext: ToolUseContext, successEventName: string, errorEventName: string, mode: 'compact' | 'at-mention', options?: {
  offset?: number;
  limit?: number;
}): Promise<FileAttachment | CompactFileReferenceAttachment | PDFReferenceAttachment | AlreadyReadFileAttachment | null> {
  const {
    offset,
    limit
  } = options ?? {};

  // 检查文件是否配置了拒绝规则
  const appState = toolUseContext.getAppState();
  if (isFileReadDenied(filename, appState.toolPermissionContext)) {
    return null;
  }

  // 读取前检查文件大小（跳过 PDF — 它们有自己的大小/页数处理）
  if (mode === 'at-mention' && !isFileWithinReadSizeLimit(filename, getDefaultFileReadingLimits().maxSizeBytes)) {
    const ext = parse(filename).ext.toLowerCase();
    if (!isPDFExtension(ext)) {
      try {
        const stats = await getFsImplementation().stat(filename);
        logEvent('tengu_attachment_file_too_large', {
          size_bytes: stats.size,
          mode
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS);
        return null;
      } catch {
        // 如果无法 stat 文件，继续正常读取（如果文件不存在，稍后会失败）
      }
    }
  }

  // 对于 @ 提及的大型 PDF，返回轻量引用而非内联
  if (mode === 'at-mention') {
    const pdfRef = await tryGetPDFReference(filename);
    if (pdfRef) {
      return pdfRef;
    }
  }

  // 检查文件是否已在上下文中且为最新版本
  const existingFileState = toolUseContext.readFileState.get(filename);
  if (existingFileState && mode === 'at-mention') {
    try {
      // 检查文件自上次读取后是否已修改
      const mtimeMs = await getFileModificationTimeAsync(filename);

      // 处理时间戳格式不一致：
      // - FileReadTool 存储 Date.now()（读取时的当前时间）
      // - FileEdit/WriteTools 存储 mtimeMs（文件修改时间）
      //
      // 如果 timestamp > mtimeMs，它由 FileReadTool 使用 Date.now() 存储
      // 此时不应使用优化，因为无法可靠比较修改时间。
      // 仅当 timestamp <= mtimeMs 时使用优化，
      // 表示它由 FileEdit/WriteTool 使用实际 mtimeMs 存储。

      if (existingFileState.timestamp <= mtimeMs && mtimeMs === existingFileState.timestamp) {
        // 文件未修改，返回 already_read_file 附件
        // 这告诉系统文件已在上下文中，无需发送到 API
        logEvent(successEventName, {});
        return {
          type: 'already_read_file',
          filename,
          displayPath: relative(getCwd(), filename),
          content: {
            type: 'text',
            file: {
              filePath: filename,
              content: existingFileState.content,
              numLines: countCharInString(existingFileState.content, '\n') + 1,
              startLine: offset ?? 1,
              totalLines: countCharInString(existingFileState.content, '\n') + 1
            }
          }
        };
      }
    } catch {
      // 如果无法 stat 文件，继续正常读取
    }
  }
  try {
    const fileInput = {
      file_path: filename,
      offset,
      limit
    };
    async function readTruncatedFile(): Promise<FileAttachment | CompactFileReferenceAttachment | AlreadyReadFileAttachment | null> {
      if (mode === 'compact') {
        return {
          type: 'compact_file_reference',
          filename,
          displayPath: relative(getCwd(), filename)
        };
      }

      // 读取截断文件前检查拒绝规则
      const appState = toolUseContext.getAppState();
      if (isFileReadDenied(filename, appState.toolPermissionContext)) {
        return null;
      }
      try {
        // 对于过大的文件仅读取前 MAX_LINES_TO_READ 行
        const truncatedInput = {
          file_path: filename,
          offset: offset ?? 1,
          limit: MAX_LINES_TO_READ
        };
        const result = await FileReadTool.call(truncatedInput, toolUseContext);
        logEvent(successEventName, {});
        return {
          type: 'file' as const,
          filename,
          content: result.data,
          truncated: true,
          displayPath: relative(getCwd(), filename)
        };
      } catch {
        logEvent(errorEventName, {});
        return null;
      }
    }

    // 验证文件路径有效
    const isValid = await FileReadTool.validateInput(fileInput, toolUseContext);
    if (!isValid.result) {
      return null;
    }
    try {
      const result = await FileReadTool.call(fileInput, toolUseContext);
      logEvent(successEventName, {});
      return {
        type: 'file',
        filename,
        content: result.data,
        displayPath: relative(getCwd(), filename)
      };
    } catch (error) {
      if (error instanceof MaxFileReadTokenExceededError || error instanceof FileTooLargeError) {
        return await readTruncatedFile();
      }
      throw error;
    }
  } catch {
    logEvent(errorEventName, {});
    return null;
  }
}
export function createAttachmentMessage(attachment: Attachment): AttachmentMessage {
  return {
    attachment,
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString()
  };
}
function getTodoReminderTurnCounts(messages: Message[]): {
  turnsSinceLastTodoWrite: number;
  turnsSinceLastReminder: number;
} {
  let lastTodoWriteIndex = -1;
  let lastReminderIndex = -1;
  let assistantTurnsSinceWrite = 0;
  let assistantTurnsSinceReminder = 0;

  // 反向迭代以查找最近的事件（TodoWrite 提醒检查）
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        // 跳过思考消息
        continue;
      }

      // 在计数器递增之前检查 TodoWrite 使用情况
      //（我们不希望将 TodoWrite 消息本身计为"写入后 1 轮"）
      if (lastTodoWriteIndex === -1 && 'message' in message && Array.isArray(message.message?.content) && message.message.content.some(block => block.type === 'tool_use' && block.name === 'TodoWrite')) {
        lastTodoWriteIndex = i;
      }

      // 在找到事件之前递增 assistant 轮次计数
      if (lastTodoWriteIndex === -1) assistantTurnsSinceWrite++;
      if (lastReminderIndex === -1) assistantTurnsSinceReminder++;
    } else if (lastReminderIndex === -1 && message?.type === 'attachment' && message.attachment.type === 'todo_reminder') {
      lastReminderIndex = i;
    }
    if (lastTodoWriteIndex !== -1 && lastReminderIndex !== -1) {
      break;
    }
  }
  return {
    turnsSinceLastTodoWrite: assistantTurnsSinceWrite,
    turnsSinceLastReminder: assistantTurnsSinceReminder
  };
}
async function getTodoReminderAttachments(messages: Message[] | undefined, toolUseContext: ToolUseContext): Promise<Attachment[]> {
  // 如果 TodoWrite 工具不可用则跳过
  if (!toolUseContext.options.tools.some(t => toolMatchesName(t, TODO_WRITE_TOOL_NAME))) {
    return [];
  }

  // 当 SendUserMessage 在工具集中时，它是主要通信渠道，
  // 模型总是被告知使用它（#20467）。TodoWrite 变成辅助渠道 —
  // 提示模型使用它会与 brief 工作流冲突。工具本身保持可用；
  // 此处仅门控"你很久没用它了"的提醒。
  if (BRIEF_TOOL_NAME && toolUseContext.options.tools.some(t => toolMatchesName(t, BRIEF_TOOL_NAME))) {
    return [];
  }

  // 如果未提供消息则跳过
  if (!messages || messages.length === 0) {
    return [];
  }
  const {
    turnsSinceLastTodoWrite,
    turnsSinceLastReminder
  } = getTodoReminderTurnCounts(messages);

  // 检查是否应显示提醒
  if (turnsSinceLastTodoWrite >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE && turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS) {
    const todoKey = toolUseContext.agentId ?? getSessionId();
    const appState = toolUseContext.getAppState();
    const todos = appState.todos[todoKey] ?? [];
    return [{
      type: 'todo_reminder',
      content: todos,
      itemCount: todos.length
    }];
  }
  return [];
}
function getTaskReminderTurnCounts(messages: Message[]): {
  turnsSinceLastTaskManagement: number;
  turnsSinceLastReminder: number;
} {
  let lastTaskManagementIndex = -1;
  let lastReminderIndex = -1;
  let assistantTurnsSinceTaskManagement = 0;
  let assistantTurnsSinceReminder = 0;

  // 反向迭代以查找最近的事件（TodoWrite 提醒检查）
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        // 跳过思考消息
        continue;
      }

      // 在计数器递增之前检查 TaskCreate 或 TaskUpdate 使用情况
      if (lastTaskManagementIndex === -1 && 'message' in message && Array.isArray(message.message?.content) && message.message.content.some(block => block.type === 'tool_use' && (block.name === TASK_CREATE_TOOL_NAME || block.name === TASK_UPDATE_TOOL_NAME))) {
        lastTaskManagementIndex = i;
      }

      // 在找到事件之前递增 assistant 轮次计数
      if (lastTaskManagementIndex === -1) assistantTurnsSinceTaskManagement++;
      if (lastReminderIndex === -1) assistantTurnsSinceReminder++;
    } else if (lastReminderIndex === -1 && message?.type === 'attachment' && message.attachment.type === 'task_reminder') {
      lastReminderIndex = i;
    }
    if (lastTaskManagementIndex !== -1 && lastReminderIndex !== -1) {
      break;
    }
  }
  return {
    turnsSinceLastTaskManagement: assistantTurnsSinceTaskManagement,
    turnsSinceLastReminder: assistantTurnsSinceReminder
  };
}
async function getTaskReminderAttachments(messages: Message[] | undefined, toolUseContext: ToolUseContext): Promise<Attachment[]> {
  if (!isTodoV2Enabled()) {
    return [];
  }

  // 跳过 ant 用户
  if (isInternalBuild()) {
    return [];
  }

  // 当 SendUserMessage 在工具集中时，它是主要通信渠道，
  // 模型总是被告知使用它（#20467）。TaskUpdate 变成辅助渠道 —
  // 提示模型使用它会与 brief 工作流冲突。工具本身保持可用；
  // 此处仅门控提醒。
  if (BRIEF_TOOL_NAME && toolUseContext.options.tools.some(t => toolMatchesName(t, BRIEF_TOOL_NAME))) {
    return [];
  }

  // 如果 TaskUpdate 工具不可用则跳过
  if (!toolUseContext.options.tools.some(t => toolMatchesName(t, TASK_UPDATE_TOOL_NAME))) {
    return [];
  }

  // 如果未提供消息则跳过
  if (!messages || messages.length === 0) {
    return [];
  }
  const {
    turnsSinceLastTaskManagement,
    turnsSinceLastReminder
  } = getTaskReminderTurnCounts(messages);

  // 检查是否应显示提醒
  if (turnsSinceLastTaskManagement >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE && turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS) {
    const tasks = await listTasks(getTaskListId());
    return [{
      type: 'task_reminder',
      content: tasks,
      itemCount: tasks.length
    }];
  }
  return [];
}

/**
 * Get attachments for all unified tasks using the Task framework.
 * Replaces the old getBackgroundShellAttachments, getBackgroundRemoteSessionAttachments,
 * and getAsyncAgentAttachments functions.
 */
async function getUnifiedTaskAttachments(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState();
  const {
    attachments,
    updatedTaskOffsets,
    evictedTaskIds
  } = await generateTaskAttachments(appState);
  applyTaskOffsetsAndEvictions(toolUseContext.setAppState, updatedTaskOffsets, evictedTaskIds);

  // 将 TaskAttachment 转换为 Attachment 格式
  return attachments.map(taskAttachment => ({
    type: 'task_status' as const,
    taskId: taskAttachment.taskId,
    taskType: taskAttachment.taskType,
    status: taskAttachment.status,
    description: taskAttachment.description,
    deltaSummary: taskAttachment.deltaSummary,
    outputFilePath: getTaskOutputPath(taskAttachment.taskId)
  }));
}
async function getAsyncHookResponseAttachments(): Promise<Attachment[]> {
  const responses = await checkForAsyncHookResponses();
  if (responses.length === 0) {
    return [];
  }
  logForDebugging(`Hooks: getAsyncHookResponseAttachments found ${responses.length} responses`);
  const attachments = responses.map(({
    processId,
    response,
    hookName,
    hookEvent,
    toolName,
    pluginId,
    stdout,
    stderr,
    exitCode
  }) => {
    logForDebugging(`Hooks: Creating attachment for ${processId} (${hookName}): ${jsonStringify(response)}`);
    return {
      type: 'async_hook_response' as const,
      processId,
      hookName,
      hookEvent,
      toolName,
      response,
      stdout,
      stderr,
      exitCode
    };
  });

  // 从注册表移除已交付的 hook 以防止重新处理
  if (responses.length > 0) {
    const processIds = responses.map(r => r.processId);
    removeDeliveredAsyncHooks(processIds);
    logForDebugging(`Hooks: Removed ${processIds.length} delivered hooks from registry`);
  }
  logForDebugging(`Hooks: getAsyncHookResponseAttachments found ${attachments.length} attachments`);
  return attachments;
}

/**
 * Get teammate mailbox attachments for agent swarm communication
 * Teammates are independent ZY Code sessions running in parallel (swarms),
 * not parent-child subagent relationships.
 *
 * This function checks two sources for messages:
 * 1. File-based mailbox (for messages that arrived between polls)
 * 2. AppState.inbox (for messages queued mid-turn by useInboxPoller)
 *
 * Messages from AppState.inbox are delivered mid-turn as attachments,
 * allowing teammates to receive messages without waiting for the turn to end.
 */
async function getTeammateMailboxAttachments(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  if (!isAgentSwarmsEnabled()) {
    return [];
  }
  if (!isInternalBuild()) {
    return [];
  }

  // 提前获取 AppState 以检查 team lead 状态
  const appState = toolUseContext.getAppState();

  // 使用助手中的 agent 名称（先检查 AsyncLocalStorage，然后 dynamicTeamContext）
  const envAgentName = getAgentName();

  // 获取团队名称（检查 AsyncLocalStorage、dynamicTeamContext，然后 AppState）
  const teamName = getTeamName(appState.teamContext);

  // 检查我们是否是 team lead（使用 swarm utils 的共享逻辑）
  const teamLeadStatus = isTeamLead(appState.teamContext);

  // 检查是否正在查看 teammate 的 transcript（用于进程内 teammate）
  const viewedTeammate = getViewedTeammateTask(appState);

  // 根据我们正在 VIEWING 的对象解析 agent 名称：
  // - 如果正在查看 teammate，使用他们的名称（从他们的邮箱读取）
  // - 否则使用环境变量（如果设置），或者如果我们是 team lead 则使用 leader 的名称
  let agentName = viewedTeammate?.identity.agentName ?? envAgentName;
  if (!agentName && teamLeadStatus && appState.teamContext) {
    const leadAgentId = appState.teamContext.leadAgentId;
    // 从 agents 映射查找 lead 的名称（而非 UUID）
    agentName = appState.teamContext.teammates[leadAgentId]?.name || 'team-lead';
  }
  logForDebugging(`[SwarmMailbox] getTeammateMailboxAttachments called: envAgentName=${envAgentName}, isTeamLead=${teamLeadStatus}, resolved agentName=${agentName}, teamName=${teamName}`);

  // 仅当作为 swarm 中的 agent 或 team lead 运行时才检查收件箱
  if (!agentName) {
    logForDebugging(`[SwarmMailbox] Not checking inbox - not in a swarm or team lead`);
    return [];
  }
  logForDebugging(`[SwarmMailbox] Checking inbox for agent="${agentName}" team="${teamName || 'default'}"`);

  // 检查邮箱中的未读消息（路由到进程内或基于文件）
  // 过滤掉结构化协议消息（权限请求/响应、关闭消息等）—
  // 这些必须保持未读，以便 useInboxPoller 路由到正确的处理器
  //（workerPermissions 队列、sandbox 队列等）。如果不过滤，
  // 附件生成会与 InboxPoller 竞争：先读取的一方会将所有消息标记为已读，
  // 如果附件获胜，协议消息会被打包为原始 LLM 上下文文本，而非路由到其 UI 处理器。
  const allUnreadMessages = await readUnreadMessages(agentName, teamName);
  const unreadMessages = allUnreadMessages.filter(m => !isStructuredProtocolMessage(m.text));
  logForDebugging(`[MailboxBridge] Found ${allUnreadMessages.length} unread message(s) for "${agentName}" (${allUnreadMessages.length - unreadMessages.length} structured protocol messages filtered out)`);

  // 同时检查 AppState.inbox 中的待处理消息（由 useInboxPoller 在轮次中途排队）
  // 重要：appState.inbox 包含从 teammate 发送到 leader 的消息。
  // 仅在查看 leader 的 transcript 时显示这些消息（而非 teammate 的）。
  // 查看 teammate 时，他们的消息来自上方的基于文件的邮箱。
  // 进程内 teammate 与 leader 共享 AppState — appState.inbox 包含
  // LEADER 的排队消息，而非 teammate 的。跳过它以防止泄漏
  //（包括来自广播的自回显）。teammate 仅通过其基于文件的邮箱 +
  // waitForNextPromptOrShutdown 接收消息。
  // 注意：viewedTeammate 已在上方为 agentName 解析计算过
  const pendingInboxMessages = viewedTeammate || isInProcessTeammate() ? [] // 正在查看 teammate 或作为进程内 teammate 运行 — 不显示 leader 的收件箱
  : appState.inbox.messages.filter(m => m.status === 'pending');
  logForDebugging(`[SwarmMailbox] Found ${pendingInboxMessages.length} pending message(s) in AppState.inbox`);

  // 合并两个消息源并进行去重
  // 同一条消息可能同时存在于文件邮箱和 AppState.inbox 中（由于竞争条件）：
  // 1. getTeammateMailboxAttachments 读取文件 -> 找到消息 M
  // 2. InboxPoller 读取相同文件 -> 将 M 排队到 AppState.inbox
  // 3. getTeammateMailboxAttachments 读取 AppState -> 再次找到 M
  // 我们使用 from+timestamp+text 前缀作为 key 进行去重
  const seen = new Set<string>();
  let allMessages: Array<{
    from: string;
    text: string;
    timestamp: string;
    color?: string;
    summary?: string;
  }> = [];
  for (const m of [...unreadMessages, ...pendingInboxMessages]) {
    const key = `${m.from}|${m.timestamp}|${m.text.slice(0, 100)}`;
    if (!seen.has(key)) {
      seen.add(key);
      allMessages.push({
        from: m.from,
        text: m.text,
        timestamp: m.timestamp,
        color: m.color,
        summary: m.summary
      });
    }
  }

  // 合并每个 agent 的多个空闲通知 — 仅保留最新的。
  // 单次解析，然后过滤而无需重新解析。
  const idleAgentByIndex = new Map<number, string>();
  const latestIdleByAgent = new Map<string, number>();
  for (let i = 0; i < allMessages.length; i++) {
    const idle = isIdleNotification(allMessages[i]!.text);
    if (idle) {
      idleAgentByIndex.set(i, idle.from);
      latestIdleByAgent.set(idle.from, i);
    }
  }
  if (idleAgentByIndex.size > latestIdleByAgent.size) {
    const beforeCount = allMessages.length;
    allMessages = allMessages.filter((_m, i) => {
      const agent = idleAgentByIndex.get(i);
      if (agent === undefined) return true;
      return latestIdleByAgent.get(agent) === i;
    });
    logForDebugging(`[SwarmMailbox] Collapsed ${beforeCount - allMessages.length} duplicate idle notification(s)`);
  }
  if (allMessages.length === 0) {
    logForDebugging(`[SwarmMailbox] No messages to deliver, returning empty`);
    return [];
  }
  logForDebugging(`[SwarmMailbox] Returning ${allMessages.length} message(s) as attachment for "${agentName}" (${unreadMessages.length} from file, ${pendingInboxMessages.length} from AppState, after dedup)`);

  // 在将消息标记为已处理之前构建附件
  // 这可以防止如果下方任何操作失败时的消息丢失
  const attachment: Attachment[] = [{
    type: 'teammate_mailbox',
    messages: allMessages
  }];

  // 附件构建后仅将非结构化邮箱消息标记为已读。
  // 结构化协议消息保持未读以供 useInboxPoller 处理。
  if (unreadMessages.length > 0) {
    await markMessagesAsReadByPredicate(agentName, m => !isStructuredProtocolMessage(m.text), teamName);
    logForDebugging(`[MailboxBridge] marked ${unreadMessages.length} non-structured message(s) as read for agent="${agentName}" team="${teamName || 'default'}"`);
  }

  // 处理 shutdown_approved 消息 — 从团队文件中移除 teammate
  // 这镜像了 useInboxPoller 在交互模式中的行为（第 546-606 行）
  // 在 -p 模式下，useInboxPoller 不运行，因此我们必须在此处处理
  if (teamLeadStatus && teamName) {
    for (const m of allMessages) {
      const shutdownApproval = isShutdownApproved(m.text);
      if (shutdownApproval) {
        const teammateToRemove = shutdownApproval.from;
        logForDebugging(`[SwarmMailbox] Processing shutdown_approved from ${teammateToRemove}`);

        // 按名称查找 teammate ID
        const teammateId = appState.teamContext?.teammates ? Object.entries(appState.teamContext.teammates).find(([, t]) => t.name === teammateToRemove)?.[0] : undefined;
        if (teammateId) {
          // 从团队文件中移除
          removeTeammateFromTeamFile(teamName, {
            agentId: teammateId,
            name: teammateToRemove
          });
          logForDebugging(`[SwarmMailbox] Removed ${teammateToRemove} from team file`);

          // 取消分配此 teammate 拥有的任务
          await unassignTeammateTasks(teamName, teammateId, teammateToRemove, 'shutdown');

          // 从 AppState 的 teamContext 中移除
          toolUseContext.setAppState(prev => {
            if (!prev.teamContext?.teammates) return prev;
            if (!(teammateId in prev.teamContext.teammates)) return prev;
            const {
              [teammateId]: _,
              ...remainingTeammates
            } = prev.teamContext.teammates;
            return {
              ...prev,
              teamContext: {
                ...prev.teamContext,
                teammates: remainingTeammates
              }
            };
          });
        }
      }
    }
  }

  // 最后在附件构建后将 AppState 收件箱消息标记为已处理
  // 这确保如果 earlier 操作失败时消息不会丢失
  if (pendingInboxMessages.length > 0) {
    const pendingIds = new Set(pendingInboxMessages.map(m => m.id));
    toolUseContext.setAppState(prev => ({
      ...prev,
      inbox: {
        messages: prev.inbox.messages.map(m => pendingIds.has(m.id) ? {
          ...m,
          status: 'processed' as const
        } : m)
      }
    }));
  }
  return attachment;
}

/**
 * Get team context attachment for teammates in a swarm.
 * Only injected on the first turn to provide team coordination instructions.
 */
function getTeamContextAttachment(messages: Message[]): Attachment[] {
  const teamName = getTeamName();
  const agentId = getAgentId();
  const agentName = getAgentName();

  // 仅为 teammate 注入（非 team lead 或非团队会话）
  if (!teamName || !agentId) {
    return [];
  }

  // 仅在首轮注入 — 检查是否尚无 assistant 消息
  const hasAssistantMessage = messages.some(m => m.type === 'assistant');
  if (hasAssistantMessage) {
    return [];
  }
  const configDir = getZyConfigHomeDir();
  const teamConfigPath = `${configDir}/teams/${teamName}/config.json`;
  const taskListPath = `${configDir}/tasks/${teamName}/`;
  return [{
    type: 'team_context',
    agentId,
    agentName: agentName || agentId,
    teamName,
    teamConfigPath,
    taskListPath
  }];
}
function getTokenUsageAttachment(messages: Message[], model: string): Attachment[] {
  if (!isEnvTruthy(process.env.ZY_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT)) {
    return [];
  }
  const contextWindow = getEffectiveContextWindowSize(model);
  const usedTokens = tokenCountFromLastAPIResponse(messages);
  return [{
    type: 'token_usage',
    used: usedTokens,
    total: contextWindow,
    remaining: contextWindow - usedTokens
  }];
}
function getOutputTokenUsageAttachment(): Attachment[] {
  if (feature('TOKEN_BUDGET')) {
    const budget = getCurrentTurnTokenBudget();
    if (budget === null || budget <= 0) {
      return [];
    }
    return [{
      type: 'output_token_usage',
      turn: getTurnOutputTokens(),
      session: getTotalOutputTokens(),
      budget
    }];
  }
  return [];
}
function getMaxBudgetUsdAttachment(maxBudgetUsd?: number): Attachment[] {
  if (maxBudgetUsd === undefined) {
    return [];
  }
  const usedCost = getTotalCostUSD();
  const remainingBudget = maxBudgetUsd - usedCost;
  return [{
    type: 'budget_usd',
    used: usedCost,
    total: maxBudgetUsd,
    remaining: remainingBudget
  }];
}

/**
 * Count human turns since plan mode exit (plan_mode_exit attachment).
 * Returns 0 if no plan_mode_exit attachment found.
 *
 * tool_result messages are type:'user' without isMeta, so filter by
 * toolUseResult to avoid counting them — otherwise the 10-turn reminder
 * interval fires every ~10 tool calls instead of ~10 human turns.
 */
export function getVerifyPlanReminderTurnCount(messages: Message[]): number {
  let turnCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && isHumanTurn(message)) {
      turnCount++;
    }
    // 在 plan_mode_exit 附件处停止计数（标记实现开始时间）
    if (message?.type === 'attachment' && message.attachment.type === 'plan_mode_exit') {
      return turnCount;
    }
  }
  // 未找到 plan_mode_exit
  return 0;
}

/**
 * Get verify plan reminder attachment if the model hasn't called VerifyPlanExecution yet.
 */
async function getVerifyPlanReminderAttachment(messages: Message[] | undefined, toolUseContext: ToolUseContext): Promise<Attachment[]> {
  if (!isInternalBuild() || !isEnvTruthy(process.env.ZY_CODE_VERIFY_PLAN)) {
    return [];
  }
  const appState = toolUseContext.getAppState();
  const pending = appState.pendingPlanVerification;

  // 仅在计划存在且验证未开始或完成时才提醒
  if (!pending || pending.verificationStarted || pending.verificationCompleted) {
    return [];
  }

  // 仅每 N 轮提醒一次
  if (messages && messages.length > 0) {
    const turnCount = getVerifyPlanReminderTurnCount(messages);
    if (turnCount === 0 || turnCount % VERIFY_PLAN_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS !== 0) {
      return [];
    }
  }
  return [{
    type: 'verify_plan_reminder'
  }];
}
export function getCompactionReminderAttachment(messages: Message[], model: string): Attachment[] {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_marble_fox', false)) {
    return [];
  }
  if (!isAutoCompactEnabled()) {
    return [];
  }
  const contextWindow = getContextWindowForModel(model, getSdkBetas());
  if (contextWindow < 1_000_000) {
    return [];
  }
  const effectiveWindow = getEffectiveContextWindowSize(model);
  const usedTokens = tokenCountWithEstimation(messages);
  if (usedTokens < effectiveWindow * 0.25) {
    return [];
  }
  return [{
    type: 'compaction_reminder'
  }];
}

/**
 * Context-efficiency nudge. Injected after every N tokens of growth without
 * a snip. Pacing is handled entirely by shouldNudgeForSnips — the 10k
 * interval resets on prior nudges, snip markers, snip boundaries, and
 * compact boundaries.
 */
export function getContextEfficiencyAttachment(messages: Message[]): Attachment[] {
  if (!feature('HISTORY_SNIP')) {
    return [];
  }
  // 门控必须与 SnipTool.isEnabled() 匹配 — 不要提示使用不在工具列表中的工具。
  // 延迟 require 使此文件不包含 snip 字符串。
  const {
    isSnipRuntimeEnabled,
    shouldNudgeForSnips
  } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../services/compact/snipCompact.js') as typeof import('../services/compact/snipCompact.js');
  if (!isSnipRuntimeEnabled()) {
    return [];
  }
  if (!shouldNudgeForSnips(messages)) {
    return [];
  }
  return [{
    type: 'context_efficiency'
  }];
}
function isFileReadDenied(filePath: string, toolPermissionContext: ToolPermissionContext): boolean {
  const denyRule = matchingRuleForInput(filePath, toolPermissionContext, 'read', 'deny');
  return denyRule !== null;
}
