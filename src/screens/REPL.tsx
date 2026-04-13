// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle';
import { spawnSync } from 'child_process';
import { snapshotOutputTokensForTurn, getCurrentTurnTokenBudget, getTurnOutputTokens, getBudgetContinuationCount, getTotalInputTokens } from '../bootstrap/state.js';
import { parseTokenBudget } from '../utils/tokenBudget.js';
import { count } from '../utils/array.js';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import figures from 'figures';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- / n N Esc [ v are bare letters in transcript modal context, same class as g/G/j/k in ScrollKeybindingHandler
import { useInput } from '../ink.js';
import { useSearchInput } from '../hooks/useSearchInput.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useSearchHighlight } from '../ink/hooks/use-search-highlight.js';
import type { JumpHandle } from '../components/VirtualMessageList.js';
import { renderMessagesToPlainText } from '../utils/exportRenderer.js';
import { openFileInExternalEditor } from '../utils/editor.js';
import { writeFile } from 'fs/promises';
import { Box, Text, useStdin, useTheme, useTerminalFocus, useTerminalTitle, useTabStatus } from '../ink.js';
import type { TabStatusKind } from '../ink/hooks/use-tab-status.js';
import { CostThresholdDialog } from '../components/CostThresholdDialog.js';
import { IdleReturnDialog } from '../components/IdleReturnDialog.js';
import * as React from 'react';
import { useEffect, useMemo, useRef, useState, useCallback, useDeferredValue, useLayoutEffect, type RefObject } from 'react';
import { useNotifications } from '../context/notifications.js';
import { sendNotification } from '../services/notifier.js';
import { startPreventSleep, stopPreventSleep } from '../services/preventSleep.js';
import { useTerminalNotification } from '../ink/useTerminalNotification.js';
import { hasCursorUpViewportYankBug } from '../ink/terminal.js';
import { createFileStateCacheWithSizeLimit, mergeFileStateCaches, READ_FILE_STATE_CACHE_SIZE } from '../utils/fileStateCache.js';
import { updateLastInteractionTime, getLastInteractionTime, getOriginalCwd, getProjectRoot, getSessionId, switchSession, setCostStateForRestore, getTurnHookDurationMs, getTurnHookCount, resetTurnHookDuration, getTurnToolDurationMs, getTurnToolCount, resetTurnToolDuration, getTurnClassifierDurationMs, getTurnClassifierCount, resetTurnClassifierDuration } from '../bootstrap/state.js';
import { asSessionId, asAgentId } from '../types/ids.js';
import { logForDebugging } from '../utils/debug.js';
import { QueryGuard } from '../utils/QueryGuard.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { formatTokens, truncateToWidth } from '../utils/format.js';
import { consumeEarlyInput } from '../utils/earlyInput.js';
import { setMemberActive } from '../utils/swarm/teamHelpers.js';
import { isSwarmWorker, generateSandboxRequestId, sendSandboxPermissionRequestViaMailbox, sendSandboxPermissionResponseViaMailbox } from '../utils/swarm/permissionSync.js';
import { registerSandboxPermissionCallback } from '../hooks/useSwarmPermissionPoller.js';
import { getTeamName, getAgentName } from '../utils/teammate.js';
import { WorkerPendingPermission } from '../components/permissions/WorkerPendingPermission.js';
import { injectUserMessageToTeammate, getAllInProcessTeammateTasks } from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import { isLocalAgentTask, queuePendingMessage, appendMessageToLocalAgent, type LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js';
import { registerLeaderToolUseConfirmQueue, unregisterLeaderToolUseConfirmQueue, registerLeaderSetToolPermissionContext, unregisterLeaderSetToolPermissionContext } from '../utils/swarm/leaderPermissionBridge.js';
import { endInteractionSpan } from '../utils/telemetry/sessionTracing.js';
import { useLogMessages } from '../hooks/useLogMessages.js';
import { useReplBridge } from '../hooks/useReplBridge.js';
import { type Command, type CommandResultDisplay, type ResumeEntrypoint, getCommandName, isCommandEnabled } from '../commands.js';
import type { PromptInputMode, QueuedCommand, VimMode } from '../types/textInputTypes.js';
import { MessageSelector, selectableUserMessagesFilter, messagesAfterAreOnlySynthetic } from '../components/MessageSelector.js';
import { useIdeLogging } from '../hooks/useIdeLogging.js';
import { PermissionRequest, type ToolUseConfirm } from '../components/permissions/PermissionRequest.js';
import { ElicitationDialog } from '../components/mcp/ElicitationDialog.js';
import { PromptDialog } from '../components/hooks/PromptDialog.js';
import type { PromptRequest, PromptResponse } from '../types/hooks.js';
import PromptInput from '../components/PromptInput/PromptInput.js';
import { PromptInputQueuedCommands } from '../components/PromptInput/PromptInputQueuedCommands.js';
import { useRemoteSession } from '../hooks/useRemoteSession.js';
import { useDirectConnect } from '../hooks/useDirectConnect.js';
import type { DirectConnectConfig } from '../server/directConnectManager.js';
import { useSSHSession } from '../hooks/useSSHSession.js';
import { useAssistantHistory } from '../hooks/useAssistantHistory.js';
import type { SSHSession } from '../ssh/createSSHSession.js';
import { SkillImprovementSurvey } from '../components/SkillImprovementSurvey.js';
import { useSkillImprovementSurvey } from '../hooks/useSkillImprovementSurvey.js';
import { useMoreRight } from '../moreright/useMoreRight.js';
import { SpinnerWithVerb, BriefIdleStatus, type SpinnerMode } from '../components/Spinner.js';
import { getSystemPrompt } from '../constants/prompts.js';
import { buildEffectiveSystemPrompt } from '../utils/systemPrompt.js';
import { getSystemContext, getUserContext } from '../context.js';
import { getMemoryFiles } from '../utils/zymd.js';
import { startBackgroundHousekeeping } from '../utils/backgroundHousekeeping.js';
import { getTotalCost, saveCurrentSessionCosts, resetCostState, getStoredSessionCosts } from '../cost-tracker.js';
import { useCostSummary } from '../costHook.js';
import { useFpsMetrics } from '../context/fpsMetrics.js';
import { useAfterFirstRender } from '../hooks/useAfterFirstRender.js';
import { useDeferredHookMessages } from '../hooks/useDeferredHookMessages.js';
import { addToHistory, removeLastFromHistory, expandPastedTextRefs, parseReferences } from '../history.js';
import { prependModeCharacterToInput } from '../components/PromptInput/inputModes.js';
import { prependToShellHistoryCache } from '../utils/suggestions/shellHistoryCompletion.js';
import { useApiKeyVerification } from '../hooks/useApiKeyVerification.js';
import { GlobalKeybindingHandlers } from '../hooks/useGlobalKeybindings.js';
import { CommandKeybindingHandlers } from '../hooks/useCommandKeybindings.js';
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js';
import { CancelRequestHandler } from '../hooks/useCancelRequest.js';
import { useBackgroundTaskNavigation } from '../hooks/useBackgroundTaskNavigation.js';
import { useSwarmInitialization } from '../hooks/useSwarmInitialization.js';
import { useTeammateViewAutoExit } from '../hooks/useTeammateViewAutoExit.js';
import { errorMessage } from '../utils/errors.js';
import { isHumanTurn } from '../utils/messagePredicates.js';
import { logError } from '../utils/log.js';
// 死代码消除：条件导入
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const useVoiceIntegration: typeof import('../hooks/useVoiceIntegration.js').useVoiceIntegration = feature('VOICE_MODE') ? require('../hooks/useVoiceIntegration.js').useVoiceIntegration : () => ({
  stripTrailing: () => 0,
  handleKeyEvent: () => {},
  resetAnchor: () => {}
});
const VoiceKeybindingHandler: typeof import('../hooks/useVoiceIntegration.js').VoiceKeybindingHandler = feature('VOICE_MODE') ? require('../hooks/useVoiceIntegration.js').VoiceKeybindingHandler : () => null;
// 挫败感检测仅限 ant 内部使用（dogfooding）。条件 require 以便外部
// 构建完全消除该模块（包括其两个 O(n) useMemo，每次 messages 变化时运行，
// 以及 GrowthBook 获取）。
const useFrustrationDetection: typeof import('../components/FeedbackSurvey/useFrustrationDetection.js').useFrustrationDetection = "external" === 'ant' ? require('../components/FeedbackSurvey/useFrustrationDetection.js').useFrustrationDetection : () => ({
  state: 'closed',
  handleTranscriptSelect: () => {}
});
// Ant 专属组织警告。条件 require 以便从外部构建中消除组织 UUID 列表
// （其中一个 UUID 在 excluded-strings 上）。
const useAntOrgWarningNotification: typeof import('../hooks/notifs/useAntOrgWarningNotification.js').useAntOrgWarningNotification = "external" === 'ant' ? require('../hooks/notifs/useAntOrgWarningNotification.js').useAntOrgWarningNotification : () => {};
// 死代码消除：coordinator mode 的条件导入
const getCoordinatorUserContext: (mcpClients: ReadonlyArray<{
  name: string;
}>, scratchpadDir?: string) => {
  [k: string]: string;
} = feature('COORDINATOR_MODE') ? require('../coordinator/coordinatorMode.js').getCoordinatorUserContext : () => ({});
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import useCanUseTool from '../hooks/useCanUseTool.js';
import type { ToolPermissionContext, Tool } from '../Tool.js';
import { applyPermissionUpdate, applyPermissionUpdates, persistPermissionUpdate } from '../utils/permissions/PermissionUpdate.js';
import { buildPermissionUpdates } from '../components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js';
import { stripDangerousPermissionsForAutoMode } from '../utils/permissions/permissionSetup.js';
import { getScratchpadDir, isScratchpadEnabled } from '../utils/permissions/filesystem.js';
import { WEB_FETCH_TOOL_NAME } from '../tools/WebFetchTool/prompt.js';
import { SLEEP_TOOL_NAME } from '../tools/SleepTool/prompt.js';
import { clearSpeculativeChecks } from '../tools/BashTool/bashPermissions.js';
import type { AutoUpdaterResult } from '../utils/autoUpdater.js';
import { getGlobalConfig, saveGlobalConfig, getGlobalConfigWriteCount } from '../utils/config.js';
import { hasConsoleBillingAccess } from '../utils/billing.js';
import { logEvent, type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js';
import { textForResubmit, handleMessageFromStream, type StreamingToolUse, type StreamingThinking, isCompactBoundaryMessage, getMessagesAfterCompactBoundary, getContentText, createUserMessage, createAssistantMessage, createTurnDurationMessage, createAgentsKilledMessage, createApiMetricsMessage, createSystemMessage, createCommandInputMessage, formatCommandInputTags } from '../utils/messages.js';
import { generateSessionTitle } from '../utils/sessionTitle.js';
import { BASH_INPUT_TAG, COMMAND_MESSAGE_TAG, COMMAND_NAME_TAG, LOCAL_COMMAND_STDOUT_TAG } from '../constants/xml.js';
import { escapeXml } from '../utils/xml.js';
import type { ThinkingConfig } from '../utils/thinking.js';
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js';
import { handlePromptSubmit, type PromptInputHelpers } from '../utils/handlePromptSubmit.js';
import { useQueueProcessor } from '../hooks/useQueueProcessor.js';
import { useMailboxBridge } from '../hooks/useMailboxBridge.js';
import { queryCheckpoint, logQueryProfileReport } from '../utils/queryProfiler.js';
import type { Message as MessageType, UserMessage, ProgressMessage, HookResultMessage, PartialCompactDirection } from '../types/message.js';
import { query } from '../query.js';
import { mergeClients, useMergedClients } from '../hooks/useMergedClients.js';
import { getQuerySourceForREPL } from '../utils/promptCategory.js';
import { useMergedTools } from '../hooks/useMergedTools.js';
import { mergeAndFilterTools } from '../utils/toolPool.js';
import { useMergedCommands } from '../hooks/useMergedCommands.js';
import { useSkillsChange } from '../hooks/useSkillsChange.js';
import { useManagePlugins } from '../hooks/useManagePlugins.js';
import { Messages } from '../components/Messages.js';
import { TaskListV2 } from '../components/TaskListV2.js';
import { TeammateViewHeader } from '../components/TeammateViewHeader.js';
import { useTasksV2WithCollapseEffect } from '../hooks/useTasksV2.js';
import { maybeMarkProjectOnboardingComplete } from '../projectOnboardingState.js';
import type { MCPServerConnection } from '../services/mcp/types.js';
import type { ScopedMcpServerConfig } from '../services/mcp/types.js';
import { randomUUID, type UUID } from 'crypto';
import { processSessionStartHooks } from '../utils/sessionStart.js';
import { executeSessionEndHooks, getSessionEndHookTimeoutMs } from '../utils/hooks.js';
import { type IDESelection, useIdeSelection } from '../hooks/useIdeSelection.js';
import { getTools, assembleToolPool } from '../tools.js';
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js';
import { resolveAgentTools } from '../tools/AgentTool/agentToolUtils.js';
import { resumeAgentBackground } from '../tools/AgentTool/resumeAgent.js';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { useAppState, useSetAppState, useAppStateStore } from '../state/AppState.js';
import type { ContentBlockParam, ImageBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
import type { ProcessUserInputContext } from '../utils/processUserInput/processUserInput.js';
import type { PastedContent } from '../utils/config.js';
import { copyPlanForFork, copyPlanForResume, getPlanSlug, setPlanSlug } from '../utils/plans.js';
import { clearSessionMetadata, resetSessionFilePointer, adoptResumedSessionFile, removeTranscriptMessage, restoreSessionMetadata, getCurrentSessionTitle, isEphemeralToolProgress, isLoggableMessage, saveWorktreeState, getAgentTranscript } from '../utils/sessionStorage.js';
import { deserializeMessages } from '../utils/conversationRecovery.js';
import { extractReadFilesFromMessages, extractBashToolsFromMessages } from '../utils/queryHelpers.js';
import { resetMicrocompactState } from '../services/compact/microCompact.js';
import { runPostCompactCleanup } from '../services/compact/postCompactCleanup.js';
import { provisionContentReplacementState, reconstructContentReplacementState, type ContentReplacementRecord } from '../utils/toolResultStorage.js';
import { partialCompactConversation } from '../services/compact/compact.js';
import type { LogOption } from '../types/logs.js';
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js';
import { fileHistoryMakeSnapshot, type FileHistoryState, fileHistoryRewind, type FileHistorySnapshot, copyFileHistoryForResume, fileHistoryEnabled, fileHistoryHasAnyChanges } from '../utils/fileHistory.js';
import { type AttributionState, incrementPromptCount } from '../utils/commitAttribution.js';
import { recordAttributionSnapshot } from '../utils/sessionStorage.js';
import { computeStandaloneAgentContext, restoreAgentFromSession, restoreSessionStateFromLog, restoreWorktreeForResume, exitRestoredWorktree } from '../utils/sessionRestore.js';
import { isBgSession, updateSessionName, updateSessionActivity } from '../utils/concurrentSessions.js';
import { isInProcessTeammateTask, type InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js';
import { restoreRemoteAgentTasks } from '../tasks/RemoteAgentTask/RemoteAgentTask.js';
import { useInboxPoller } from '../hooks/useInboxPoller.js';
// 死代码消除：loop mode 的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('PROACTIVE') || feature('KAIROS') ? require('../proactive/index.js') : null;
const PROACTIVE_NO_OP_SUBSCRIBE = (_cb: () => void) => () => {};
const PROACTIVE_FALSE = () => false;
const SUGGEST_BG_PR_NOOP = (_p: string, _n: string): boolean => false;
const useProactive = feature('PROACTIVE') || feature('KAIROS') ? require('../proactive/useProactive.js').useProactive : null;
const useScheduledTasks = feature('AGENT_TRIGGERS') ? require('../hooks/useScheduledTasks.js').useScheduledTasks : null;
/* eslint-enable @typescript-eslint/no-require-imports */
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js';
import { useTaskListWatcher } from '../hooks/useTaskListWatcher.js';
import type { SandboxAskCallback, NetworkHostPattern } from '../utils/sandbox/sandbox-adapter.js';
import { type IDEExtensionInstallationStatus, closeOpenDiffs, getConnectedIdeClient, type IdeType } from '../utils/ide.js';
import { useIDEIntegration } from '../hooks/useIDEIntegration.js';
import exit from '../commands/exit/index.js';
import { ExitFlow } from '../components/ExitFlow.js';
import { getCurrentWorktreeSession } from '../utils/worktree.js';
import { popAllEditable, enqueue, type SetAppState, getCommandQueue, getCommandQueueLength, removeByFilter } from '../utils/messageQueueManager.js';
import { useCommandQueue } from '../hooks/useCommandQueue.js';
import { SessionBackgroundHint } from '../components/SessionBackgroundHint.js';
import { startBackgroundSession } from '../tasks/LocalMainSessionTask.js';
import { useSessionBackgrounding } from '../hooks/useSessionBackgrounding.js';
import { diagnosticTracker } from '../services/diagnosticTracking.js';
import { handleSpeculationAccept, type ActiveSpeculationState } from '../services/PromptSuggestion/speculation.js';
import { IdeOnboardingDialog } from '../components/IdeOnboardingDialog.js';
import { EffortCallout, shouldShowEffortCallout } from '../components/EffortCallout.js';
import type { EffortValue } from '../utils/effort.js';
import { RemoteCallout } from '../components/RemoteCallout.js';
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const AntModelSwitchCallout = "external" === 'ant' ? require('../components/AntModelSwitchCallout.js').AntModelSwitchCallout : null;
const shouldShowAntModelSwitch = "external" === 'ant' ? require('../components/AntModelSwitchCallout.js').shouldShowModelSwitchCallout : (): boolean => false;
const UndercoverAutoCallout = "external" === 'ant' ? require('../components/UndercoverAutoCallout.js').UndercoverAutoCallout : null;
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import { activityManager } from '../utils/activityManager.js';
import { createAbortController } from '../utils/abortController.js';
import { MCPConnectionManager } from 'src/services/mcp/MCPConnectionManager.js';
import { useFeedbackSurvey } from 'src/components/FeedbackSurvey/useFeedbackSurvey.js';
import { useMemorySurvey } from 'src/components/FeedbackSurvey/useMemorySurvey.js';
import { usePostCompactSurvey } from 'src/components/FeedbackSurvey/usePostCompactSurvey.js';
import { FeedbackSurvey } from 'src/components/FeedbackSurvey/FeedbackSurvey.js';
import { useInstallMessages } from 'src/hooks/notifs/useInstallMessages.js';
import { useAwaySummary } from 'src/hooks/useAwaySummary.js';
import { useChromeExtensionNotification } from 'src/hooks/useChromeExtensionNotification.js';
import { useOfficialMarketplaceNotification } from 'src/hooks/useOfficialMarketplaceNotification.js';
import { usePromptsFromClaudeInChrome } from 'src/hooks/usePromptsFromClaudeInChrome.js';
import { getTipToShowOnSpinner, recordShownTip } from 'src/services/tips/tipScheduler.js';
import type { Theme } from 'src/utils/theme.js';
import { checkAndDisableBypassPermissionsIfNeeded, checkAndDisableAutoModeIfNeeded, useKickOffCheckAndDisableBypassPermissionsIfNeeded, useKickOffCheckAndDisableAutoModeIfNeeded } from 'src/utils/permissions/bypassPermissionsKillswitch.js';
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js';
import { SANDBOX_NETWORK_ACCESS_TOOL_NAME } from 'src/cli/structuredIO.js';
import { useFileHistorySnapshotInit } from 'src/hooks/useFileHistorySnapshotInit.js';
import { SandboxPermissionRequest } from 'src/components/permissions/SandboxPermissionRequest.js';
import { SandboxViolationExpandedView } from 'src/components/SandboxViolationExpandedView.js';
import { useSettingsErrors } from 'src/hooks/notifs/useSettingsErrors.js';
import { useMcpConnectivityStatus } from 'src/hooks/notifs/useMcpConnectivityStatus.js';
import { useAutoModeUnavailableNotification } from 'src/hooks/notifs/useAutoModeUnavailableNotification.js';
import { AUTO_MODE_DESCRIPTION } from 'src/components/AutoModeOptInDialog.js';
import { useLspInitializationNotification } from 'src/hooks/notifs/useLspInitializationNotification.js';
import { useLspPluginRecommendation } from 'src/hooks/useLspPluginRecommendation.js';
import { LspRecommendationMenu } from 'src/components/LspRecommendation/LspRecommendationMenu.js';
import { useZyCodeHintRecommendation } from 'src/hooks/useZyCodeHintRecommendation.js';
import { PluginHintMenu } from 'src/components/ZyCodeHint/PluginHintMenu.js';
import { DesktopUpsellStartup, shouldShowDesktopUpsellStartup } from 'src/components/DesktopUpsell/DesktopUpsellStartup.js';
import { usePluginInstallationStatus } from 'src/hooks/notifs/usePluginInstallationStatus.js';
import { usePluginAutoupdateNotification } from 'src/hooks/notifs/usePluginAutoupdateNotification.js';
import { performStartupChecks } from 'src/utils/plugins/performStartupChecks.js';
import { UserTextMessage } from 'src/components/messages/UserTextMessage.js';
import { AwsAuthStatusBox } from '../components/AwsAuthStatusBox.js';
import { useRateLimitWarningNotification } from 'src/hooks/notifs/useRateLimitWarningNotification.js';
import { useDeprecationWarningNotification } from 'src/hooks/notifs/useDeprecationWarningNotification.js';
import { useNpmDeprecationNotification } from 'src/hooks/notifs/useNpmDeprecationNotification.js';
import { useIDEStatusIndicator } from 'src/hooks/notifs/useIDEStatusIndicator.js';
import { useModelMigrationNotifications } from 'src/hooks/notifs/useModelMigrationNotifications.js';
import { useCanSwitchToExistingSubscription } from 'src/hooks/notifs/useCanSwitchToExistingSubscription.js';
import { useTeammateLifecycleNotification } from 'src/hooks/notifs/useTeammateShutdownNotification.js';
import { useFastModeNotification } from 'src/hooks/notifs/useFastModeNotification.js';
import { AutoRunIssueNotification, shouldAutoRunIssue, getAutoRunIssueReasonText, getAutoRunCommand, type AutoRunIssueReason } from '../utils/autoRunIssue.js';
import type { HookProgress } from '../types/hooks.js';
import { TungstenLiveMonitor } from '../tools/TungstenTool/TungstenLiveMonitor.js';
/* eslint-disable @typescript-eslint/no-require-imports */
const WebBrowserPanelModule = feature('WEB_BROWSER_TOOL') ? require('../tools/WebBrowserTool/WebBrowserPanel.js') as typeof import('../tools/WebBrowserTool/WebBrowserPanel.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
import { IssueFlagBanner } from '../components/PromptInput/IssueFlagBanner.js';
import { useIssueFlagBanner } from '../hooks/useIssueFlagBanner.js';
import { CompanionSprite, CompanionFloatingBubble, MIN_COLS_FOR_FULL_SPRITE } from '../buddy/CompanionSprite.js';
import { DevBar } from '../components/DevBar.js';
// Session manager 已移除 - 现在使用 AppState
import type { RemoteSessionConfig } from '../remote/RemoteSessionManager.js';
import { REMOTE_SAFE_COMMANDS } from '../commands.js';
import type { RemoteMessageContent } from '../utils/teleport/api.js';
import { FullscreenLayout, useUnseenDivider, computeUnseenDivider } from '../components/FullscreenLayout.js';
import { isFullscreenEnvEnabled, maybeGetTmuxMouseHint, isMouseTrackingEnabled } from '../utils/fullscreen.js';
import { AlternateScreen } from '../ink/components/AlternateScreen.js';
import { ScrollKeybindingHandler } from '../components/ScrollKeybindingHandler.js';
import { useMessageActions, MessageActionsKeybindings, MessageActionsBar, type MessageActionsState, type MessageActionsNav, type MessageActionCaps } from '../components/messageActions.js';
import { setClipboard } from '../ink/termio/osc.js';
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js';
import { createAttachmentMessage, getQueuedCommandAttachments } from '../utils/attachments.js';

// 为接受 MCPServerConnection[] 的 hooks 提供稳定空数组 — 避免
// 在 remote mode 下每次渲染创建新的 [] 字面量，否则会导致
// useEffect 依赖变化并引发无限重渲染循环。
const EMPTY_MCP_CLIENTS: MCPServerConnection[] = [];

// useAssistantHistory 非 KAIROS 分支的稳定存根 — 避免每次渲染
// 产生新的函数 identity，否则会破坏 composedOnScroll 的 memo。
const HISTORY_STUB = {
  maybeLoadOlder: (_: ScrollBoxHandle) => {}
};
// 用户主动滚动后的时间窗口，在此期间向空输入框打字不会
// 自动回到底部。Josh Rosen 的工作流：Zy 输出长内容 → 向上
// 滚动阅读开头 → 开始打字 → 修复前会突然跳到底部。
// https://anthropic.slack.com/archives/C07VBSHV7EV/p1773545449871739
const RECENT_SCROLL_REPIN_WINDOW_MS = 3000;

// 使用 LRU 缓存防止内存无限增长
// 100 个文件对于大多数编码会话应该足够，同时防止
// 在大型项目中跨多个文件工作时出现内存问题

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/**
 * Small component to display transcript mode footer with dynamic keybinding.
 * Must be rendered inside KeybindingSetup to access keybinding context.
 */
function TranscriptModeFooter({
  showAllInTranscript,
  virtualScroll,
  searchBadge,
  suppressShowAll = false,
  status
}) {
  const toggleShortcut = useShortcutDisplay("app:toggleTranscript", "Global", "ctrl+o");
  const showAllShortcut = useShortcutDisplay("transcript:toggleShowAll", "Transcript", "ctrl+e");
  return <Box noSelect={true} alignItems="center" alignSelf="center" borderTopDimColor={true} borderBottom={false} borderLeft={false} borderRight={false} borderStyle="single" marginTop={1} paddingLeft={2} width="100%">{<Text dimColor={true}>Showing detailed transcript · {toggleShortcut} to toggle{searchBadge ? " \xB7 n/N to navigate" : virtualScroll ? ` · ${figures.arrowUp}${figures.arrowDown} scroll · home/end top/bottom` : suppressShowAll ? "" : ` · ${showAllShortcut} to ${showAllInTranscript ? "collapse" : "show all"}`}</Text>}{status ? <><Box flexGrow={1} /><Text>{status} </Text></> : searchBadge ? <><Box flexGrow={1} /><Text dimColor={true}>{searchBadge.current}/{searchBadge.count}{"  "}</Text></> : null}</Box>;
}

/** less 风格 / bar。1 行，与 TranscriptModeFooter 相同的 border-top 样式
 *  所以在 bottom 插槽中交换它们不会改变 ScrollBox 高度。
 *  useSearchInput 处理 readline 编辑；我们报告查询变化并
 *  渲染计数器。增量 — 每次按键重新搜索 + 高亮。 */
function TranscriptSearchBar({
  jumpRef,
  count,
  current,
  onClose,
  onCancel,
  setHighlight,
  initialQuery
}: {
  jumpRef: RefObject<JumpHandle | null>;
  count: number;
  current: number;
  /** Enter — 确认。查询保留以供 n/N 使用。 */
  onClose: (lastQuery: string) => void;
  /** Esc/ctrl+c/ctrl+g — 撤销到搜索前状态。 */
  onCancel: () => void;
  setHighlight: (query: string) => void;
  // 使用之前的查询作为种子（less 风格：/ 显示上次模式）。effect 挂载时
  // 用相同查询重新扫描 — 幂等（相同匹配、最近指针、相同高亮）。用户可以编辑或清除。
  initialQuery: string;
}): React.ReactNode {
  const {
    query,
    cursorOffset
  } = useSearchInput({
    isActive: true,
    initialQuery,
    onExit: () => onClose(query),
    onCancel
  });
  // 索引预热在查询 effect 之前运行，以便测量真实成本 —
  // 否则 setSearchQuery 先填充缓存，warm 报告 ~0ms 而用户
  // 实际感受到了延迟。
  // 转录模式会话中第一次 / 需要支付 extractSearchText 成本。
  // 后续 / 立即返回 0（VML 中的 indexWarmed ref）。
  // 转录在 ctrl+o 时冻结，因此缓存保持有效。
  // 初始 'building' 使 warmDone 在挂载时为 false — [query] effect
  // 等待 warm effect 首次 resolve 而不是与之竞争。如果初始为 null，
  // warmDone 会在挂载时为 true → [query] 触发 → setSearchQuery 填充
  // 缓存 → warm 报告 ~0ms 而用户实际感受到了延迟。
  const [indexStatus, setIndexStatus] = React.useState<'building' | {
    ms: number;
  } | null>('building');
  React.useEffect(() => {
    let alive = true;
    const warm = jumpRef.current?.warmSearchIndex;
    if (!warm) {
      setIndexStatus(null); // VML not mounted yet — rare, skip indicator
      return;
    }
    setIndexStatus('building');
    warm().then(ms => {
      if (!alive) return;
      // <20ms = 无法察觉。没必要显示 "indexed in 3ms"。
      if (ms < 20) {
        setIndexStatus(null);
      } else {
        setIndexStatus({
          ms
        });
        setTimeout(() => alive && setIndexStatus(null), 2000);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount-only: bar opens once per /
  // 以 warm 完成为门控来控制 query effect。setHighlight 保持即时
  // （屏幕空间叠加层，无需索引）。setSearchQuery（扫描）会等待。
  const warmDone = indexStatus !== 'building';
  useEffect(() => {
    if (!warmDone) return;
    jumpRef.current?.setSearchQuery(query);
    setHighlight(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, warmDone]);
  const off = cursorOffset;
  const cursorChar = off < query.length ? query[off] : ' ';
  return <Box borderTopDimColor borderBottom={false} borderLeft={false} borderRight={false} borderStyle="single" marginTop={1} paddingLeft={2} width="100%"
  // applySearchHighlight 扫描整个屏幕缓冲区。此处渲染的查询
  // 文本确实在屏幕上 — /foo 会匹配 bar 中的 'foo'。如果没有内容
  // 匹配，这是唯一可见的匹配 → 被标记为 CURRENT → 加下划线。
  // noSelect 使 searchHighlight.ts:76 跳过这些单元格（与边栏相同
  // 排除）。你也无法文本选择 bar；它是临时控件，没问题。
  noSelect>
      <Text>/</Text>
      <Text>{query.slice(0, off)}</Text>
      <Text inverse>{cursorChar}</Text>
      {off < query.length && <Text>{query.slice(off + 1)}</Text>}
      <Box flexGrow={1} />
      {indexStatus === 'building' ? <Text dimColor>indexing… </Text> : indexStatus ? <Text dimColor>indexed in {indexStatus.ms}ms </Text> : count === 0 && query ? <Text color="error">no matches </Text> : count > 0 ?
    // 引擎计数（extractSearchText 上的 indexOf）。可能与渲染计数
    // 因幽灵/幻影消息而有偏差 — 徽章是粗略的位置提示。scanElement
    // 给出每条消息的精确位置，但计算所有匹配的成本约为 ~1-3ms × 匹配消息数。
    <Text dimColor>
          {current}/{count}
          {'  '}
        </Text> : null}
    </Box>;
}
const TITLE_ANIMATION_FRAMES = ['⠂', '⠐'];
const TITLE_STATIC_PREFIX = '✳';
const TITLE_ANIMATION_INTERVAL_MS = 960;

/**
 * Sets the terminal tab title, with an animated prefix glyph while a query
 * is running. Isolated from REPL so the 960ms animation tick re-renders only
 * this leaf component (which returns null — pure side-effect) instead of the
 * entire REPL tree. Before extraction, the tick was ~1 REPL render/sec for
 * the duration of every turn, dragging PromptInput and friends along.
 */
function AnimatedTerminalTitle({
  isAnimating,
  title,
  disabled,
  noPrefix
}) {
  const terminalFocused = useTerminalFocus();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (disabled || noPrefix || !isAnimating || !terminalFocused) {
      return;
    }
    const interval = setInterval(setFrame_0 => setFrame_0(f => (f + 1) % TITLE_ANIMATION_FRAMES.length), TITLE_ANIMATION_INTERVAL_MS, setFrame);
    return () => clearInterval(interval);
  }, [disabled, noPrefix, isAnimating, terminalFocused]);
  const prefix = isAnimating ? TITLE_ANIMATION_FRAMES[frame] ?? TITLE_STATIC_PREFIX : TITLE_STATIC_PREFIX;
  useTerminalTitle(disabled ? null : noPrefix ? title : `${prefix} ${title}`);
  return null;
}
export type Props = {
  commands: Command[];
  debug: boolean;
  initialTools: Tool[];
  // 用于填充 REPL 的初始消息
  initialMessages?: MessageType[];
  // 延迟的 hook 消息 promise — REPL 立即渲染并在 hook 消息
  // 解析时注入。在第一次 API 调用之前等待。
  pendingHookMessages?: Promise<HookResultMessage[]>;
  initialFileHistorySnapshots?: FileHistorySnapshot[];
  // 从恢复会话的转录中获取的内容替换记录 — 用于重建
  // contentReplacementState 以便重新替换相同的结果
  initialContentReplacements?: ContentReplacementRecord[];
  // 会话恢复的初始 agent 上下文（通过 /rename 或 /color 设置名称/颜色）
  initialAgentName?: string;
  initialAgentColor?: AgentColorName;
  mcpClients?: MCPServerConnection[];
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>;
  autoConnectIdeFlag?: boolean;
  strictMcpConfig?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  // 在查询执行之前调用的可选回调
  // 在用户消息添加到对话后但在 API 调用之前调用
  // 返回 false 以阻止查询执行
  onBeforeQuery?: (input: string, newMessages: MessageType[]) => Promise<boolean>;
  // 回合完成时的可选回调（模型完成响应）
  onTurnComplete?: (messages: MessageType[]) => void | Promise<void>;
  // 为 true 时，禁用 REPL 输入（隐藏提示符并阻止消息选择器）
  disabled?: boolean;
  // 用于主线程的可选 agent 定义
  mainThreadAgentDefinition?: AgentDefinition;
  // 为 true 时，禁用所有斜杠命令
  disableSlashCommands?: boolean;
  // 任务列表 ID：设置时启用任务模式，监视任务列表并自动处理任务
  taskListId?: string;
  // --remote 模式的远程会话配置（使用 CCR 作为执行引擎）
  remoteSessionConfig?: RemoteSessionConfig;
  // `zy connect` 模式的直连配置（连接到 zy 服务器）
  directConnectConfig?: DirectConnectConfig;
  // `zy ssh` 模式的 SSH 会话（本地 REPL，通过 ssh 的远程工具）
  sshSession?: SSHSession;
  // 启用思考时使用的思考配置
  thinkingConfig: ThinkingConfig;
};
export type Screen = 'prompt' | 'transcript';
export function REPL({
  commands: initialCommands,
  debug,
  initialTools,
  initialMessages,
  pendingHookMessages,
  initialFileHistorySnapshots,
  initialContentReplacements,
  initialAgentName,
  initialAgentColor,
  mcpClients: initialMcpClients,
  dynamicMcpConfig: initialDynamicMcpConfig,
  autoConnectIdeFlag,
  strictMcpConfig = false,
  systemPrompt: customSystemPrompt,
  appendSystemPrompt,
  onBeforeQuery,
  onTurnComplete,
  disabled = false,
  mainThreadAgentDefinition: initialMainThreadAgentDefinition,
  disableSlashCommands = false,
  taskListId,
  remoteSessionConfig,
  directConnectConfig,
  sshSession,
  thinkingConfig
}: Props): React.ReactNode {
  const isRemoteSession = !!remoteSessionConfig;

  // 环境变量门控提升到挂载时 — isEnvTruthy 执行 toLowerCase+trim+
  // includes，这些在渲染路径上（PageUp 频繁操作时很热）。
  const titleDisabled = useMemo(() => isEnvTruthy(process.env.ZY_CODE_DISABLE_TERMINAL_TITLE), []);
  const moreRightEnabled = useMemo(() => "external" === 'ant' && isEnvTruthy(process.env.CLAUDE_MORERIGHT), []);
  const disableVirtualScroll = useMemo(() => isEnvTruthy(process.env.ZY_CODE_DISABLE_VIRTUAL_SCROLL), []);
  const disableMessageActions = feature('MESSAGE_ACTIONS') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useMemo(() => isEnvTruthy(process.env.ZY_CODE_DISABLE_MESSAGE_ACTIONS), []) : false;

  // 记录 REPL 挂载/卸载生命周期
  useEffect(() => {
    logForDebugging(`[REPL:mount] REPL mounted, disabled=${disabled}`);
    return () => logForDebugging(`[REPL:unmount] REPL unmounting`);
  }, [disabled]);

  // Agent 定义是 state 以便 /resume 可以在会话中间更新它
  const [mainThreadAgentDefinition, setMainThreadAgentDefinition] = useState(initialMainThreadAgentDefinition);
  const toolPermissionContext = useAppState(s => s.toolPermissionContext);
  const verbose = useAppState(s => s.verbose);
  const mcp = useAppState(s => s.mcp);
  const plugins = useAppState(s => s.plugins);
  const agentDefinitions = useAppState(s => s.agentDefinitions);
  const fileHistory = useAppState(s => s.fileHistory);
  const initialMessage = useAppState(s => s.initialMessage);
  const queuedCommands = useCommandQueue();
  // feature() 是构建时常量 — 死代码消除会在外部构建中
  // 完全移除 hook 调用，所以尽管看起来是条件调用但是安全的。
  // 这些字段包含不能出现在外部构建中的排除字符串。
  const spinnerTip = useAppState(s => s.spinnerTip);
  const showExpandedTodos = useAppState(s => s.expandedView) === 'tasks';
  const pendingWorkerRequest = useAppState(s => s.pendingWorkerRequest);
  const pendingSandboxRequest = useAppState(s => s.pendingSandboxRequest);
  const teamContext = useAppState(s => s.teamContext);
  const tasks = useAppState(s => s.tasks);
  const workerSandboxPermissions = useAppState(s => s.workerSandboxPermissions);
  const elicitation = useAppState(s => s.elicitation);
  const ultraplanPendingChoice = useAppState(s => s.ultraplanPendingChoice);
  const ultraplanLaunchPending = useAppState(s => s.ultraplanLaunchPending);
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId);
  const setAppState = useSetAppState();

  // Bootstrap：保留了尚未加载磁盘的 local_agent → 读取
  // sidechain JSONL 并与 stream 已追加的内容进行 UUID 合并。
  // Stream 在保留时立即追加（不延迟）；bootstrap 填充前缀。
  // 磁盘先于 yield 写入意味着 live 始终是 disk 的后缀。
  const viewedLocalAgent = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined;
  const needsBootstrap = isLocalAgentTask(viewedLocalAgent) && viewedLocalAgent.retain && !viewedLocalAgent.diskLoaded;
  useEffect(() => {
    if (!viewingAgentTaskId || !needsBootstrap) return;
    const taskId = viewingAgentTaskId;
    void getAgentTranscript(asAgentId(taskId)).then(result => {
      setAppState(prev => {
        const t = prev.tasks[taskId];
        if (!isLocalAgentTask(t) || t.diskLoaded || !t.retain) return prev;
        const live = t.messages ?? [];
        const liveUuids = new Set(live.map(m => m.uuid));
        const diskOnly = result ? result.messages.filter(m => !liveUuids.has(m.uuid)) : [];
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: {
              ...t,
              messages: [...diskOnly, ...live],
              diskLoaded: true
            }
          }
        };
      });
    });
  }, [viewingAgentTaskId, needsBootstrap, setAppState]);
  const store = useAppStateStore();
  const terminal = useTerminalNotification();
  const mainLoopModel = useMainLoopModel();

  // 注意：standaloneAgentContext 在 main.tsx（通过 initialState）或
  // ResumeConversation.tsx（在渲染 REPL 之前通过 setAppState）中初始化，以避免
  // 挂载时基于 useEffect 的 state 初始化（遵循 CLAUDE.md 指南）

  // 命令的本地 state（skill 文件更改时可热重载）
  const [localCommands, setLocalCommands] = useState(initialCommands);

  // 监听 skill 文件更改并重新加载所有命令
  useSkillsChange(isRemoteSession ? undefined : getProjectRoot(), setLocalCommands);

  // 跟踪 proactive mode 以供 tools 依赖 - SleepTool 根据 proactive state 过滤
  const proactiveActive = React.useSyncExternalStore(proactiveModule?.subscribeToProactiveChanges ?? PROACTIVE_NO_OP_SUBSCRIBE, proactiveModule?.isProactiveActive ?? PROACTIVE_FALSE);

  // BriefTool.isEnabled() 从 bootstrap state 读取 getUserMsgOptIn()，
  // /brief 在会话中间与 isBriefOnly 一起切换。下面的 memo 需要一个
  // React 可见的依赖来在发生时重新运行 getTools()；isBriefOnly 是
  // 触发重新渲染的 AppState 镜像。没有这个，在会话中切换
  // /brief 会留下过时的工具列表（没有 SendUserMessage），
  // 模型会发出被 brief 过滤器隐藏的纯文本。
  const isBriefOnly = useAppState(s => s.isBriefOnly);
  const localTools = useMemo(() => getTools(toolPermissionContext), [toolPermissionContext, proactiveActive, isBriefOnly]);
  useKickOffCheckAndDisableBypassPermissionsIfNeeded();
  useKickOffCheckAndDisableAutoModeIfNeeded();
  const [dynamicMcpConfig, setDynamicMcpConfig] = useState<Record<string, ScopedMcpServerConfig> | undefined>(initialDynamicMcpConfig);
  const onChangeDynamicMcpConfig = useCallback((config: Record<string, ScopedMcpServerConfig>) => {
    setDynamicMcpConfig(config);
  }, [setDynamicMcpConfig]);
  const [screen, setScreen] = useState<Screen>('prompt');
  const [showAllInTranscript, setShowAllInTranscript] = useState(false);
  // [ 强制在转录模式内走 dump-to-scrollback 路径。与
  // ZY_CODE_NO_FLICKER=0（进程生命周期）分开 — 这是临时的，
  // 退出转录时重置。诊断逃生通道，使终端/tmux 原生 cmd-F
  // 可以搜索完整扁平渲染。
  const [dumpMode, setDumpMode] = useState(false);
  // 面向编辑器的 v 渲染进度。内联在 footer 中 — 通知
  // 在 PromptInput 内渲染，而 PromptInput 在转录中未挂载。
  const [editorStatus, setEditorStatus] = useState('');
  // 退出转录时递增。异步 v-render 在开始时捕获此值；
  // 如果过时，每次状态写入都无操作（用户在渲染中间离开转录 —
  // 稳定的 setState 否则会将幽灵 toast 印入下一个会话）。
  // 同时清除任何待处理的 4 秒自动清除。
  const editorGenRef = useRef(0);
  const editorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editorRenderingRef = useRef(false);
  const {
    addNotification,
    removeNotification
  } = useNotifications();

  // eslint-disable-next-line prefer-const
  let trySuggestBgPRIntercept = SUGGEST_BG_PR_NOOP;
  const mcpClients = useMergedClients(initialMcpClients, mcp.clients);

  // IDE 集成
  const [ideSelection, setIDESelection] = useState<IDESelection | undefined>(undefined);
  const [ideToInstallExtension, setIDEToInstallExtension] = useState<IdeType | null>(null);
  const [ideInstallationStatus, setIDEInstallationStatus] = useState<IDEExtensionInstallationStatus | null>(null);
  const [showIdeOnboarding, setShowIdeOnboarding] = useState(false);
  // 死代码消除：模型切换 callout state（ant 专属）
  const [showModelSwitchCallout, setShowModelSwitchCallout] = useState(() => {
    if ("external" === 'ant') {
      return shouldShowAntModelSwitch();
    }
    return false;
  });
  const [showEffortCallout, setShowEffortCallout] = useState(() => shouldShowEffortCallout(mainLoopModel));
  const showRemoteCallout = useAppState(s => s.showRemoteCallout);
  const [showDesktopUpsellStartup, setShowDesktopUpsellStartup] = useState(() => shouldShowDesktopUpsellStartup());
  // 通知
  useModelMigrationNotifications();
  useCanSwitchToExistingSubscription();
  useIDEStatusIndicator({
    ideSelection,
    mcpClients,
    ideInstallationStatus
  });
  useMcpConnectivityStatus({
    mcpClients
  });
  useAutoModeUnavailableNotification();
  usePluginInstallationStatus();
  usePluginAutoupdateNotification();
  useSettingsErrors();
  useRateLimitWarningNotification(mainLoopModel);
  useFastModeNotification();
  useDeprecationWarningNotification(mainLoopModel);
  useNpmDeprecationNotification();
  useAntOrgWarningNotification();
  useInstallMessages();
  useChromeExtensionNotification();
  useOfficialMarketplaceNotification();
  useLspInitializationNotification();
  useTeammateLifecycleNotification();
  const {
    recommendation: lspRecommendation,
    handleResponse: handleLspResponse
  } = useLspPluginRecommendation();
  const {
    recommendation: hintRecommendation,
    handleResponse: handleHintResponse
  } = useZyCodeHintRecommendation();

  // 记忆化合并的初始工具数组以防止引用变化
  const combinedInitialTools = useMemo(() => {
    return [...localTools, ...initialTools];
  }, [localTools, initialTools]);

  // 初始化插件管理
  useManagePlugins({
    enabled: !isRemoteSession
  });
  const tasksV2 = useTasksV2WithCollapseEffect();

  // 启动后台插件安装

  // 安全：此代码保证仅在用户确认"信任此文件夹"对话框之后运行。
  // 信任对话框在 cli.tsx（约 387 行）中显示，在 REPL 组件渲染之前。
  // 对话框会阻塞执行直到用户接受，然后 REPL 组件才会挂载并执行此 effect。
  // 这确保来自仓库和用户设置的插件安装仅在用户明确同意信任当前工作目录后进行。
  useEffect(() => {
    if (isRemoteSession) return;
    void performStartupChecks(setAppState);
  }, [setAppState, isRemoteSession]);

  // 允许 Claude in Chrome MCP 通过 MCP 通知发送提示
  // 并将权限模式更改同步到 Chrome 扩展
  usePromptsFromClaudeInChrome(isRemoteSession ? EMPTY_MCP_CLIENTS : mcpClients, toolPermissionContext.mode);

  // 初始化 swarm 功能：teammate hooks 和上下文
  // 处理全新启动和恢复的 teammate 会话
  useSwarmInitialization(setAppState, initialMessages, {
    enabled: !isRemoteSession
  });
  const mergedTools = useMergedTools(combinedInitialTools, mcp.tools, toolPermissionContext);

  // 如果设置了 mainThreadAgentDefinition，则应用 agent 工具限制
  const {
    tools,
    allowedAgentTypes
  } = useMemo(() => {
    if (!mainThreadAgentDefinition) {
      return {
        tools: mergedTools,
        allowedAgentTypes: undefined as string[] | undefined
      };
    }
    const resolved = resolveAgentTools(mainThreadAgentDefinition, mergedTools, false, true);
    return {
      tools: resolved.resolvedTools,
      allowedAgentTypes: resolved.allowedAgentTypes
    };
  }, [mainThreadAgentDefinition, mergedTools]);

  // 合并来自本地 state、插件和 MCP 的命令
  const commandsWithPlugins = useMergedCommands(localCommands, plugins.commands as Command[]);
  const mergedCommands = useMergedCommands(commandsWithPlugins, mcp.commands as Command[]);
  // 如果 disableSlashCommands 为 true，则过滤掉所有命令
  const commands = useMemo(() => disableSlashCommands ? [] : mergedCommands, [disableSlashCommands, mergedCommands]);
  useIdeLogging(isRemoteSession ? EMPTY_MCP_CLIENTS : mcp.clients);
  useIdeSelection(isRemoteSession ? EMPTY_MCP_CLIENTS : mcp.clients, setIDESelection);
  const [streamMode, setStreamMode] = useState<SpinnerMode>('responding');
  // Ref 镜像使 onSubmit 可以读取最新值而无需将
  // streamMode 添加到其依赖中。streamMode 在流式传输期间
  // 每个回合在 requesting/responding/tool-use 之间切换约 10 次；
  // 将其放在 onSubmit 的依赖中会在每次切换时重新创建 onSubmit，
  // 级联导致 PromptInput prop 变化和下游 useCallback/useMemo 失效。
  // 回调中唯一的消费者是调试日志和遥测事件（handlePromptSubmit.ts），
  // 所以落后一渲染的值是无害的 — 但 ref 镜像无论如何都会在每次渲染时同步，所以它是新鲜的。
  const streamModeRef = useRef(streamMode);
  streamModeRef.current = streamMode;
  const [streamingToolUses, setStreamingToolUses] = useState<StreamingToolUse[]>([]);
  const [streamingThinking, setStreamingThinking] = useState<StreamingThinking | null>(null);

  // 流式思考完成后 30 秒自动隐藏
  useEffect(() => {
    if (streamingThinking && !streamingThinking.isStreaming && streamingThinking.streamingEndedAt) {
      const elapsed = Date.now() - streamingThinking.streamingEndedAt;
      const remaining = 30000 - elapsed;
      if (remaining > 0) {
        const timer = setTimeout(setStreamingThinking, remaining, null);
        return () => clearTimeout(timer);
      } else {
        setStreamingThinking(null);
      }
    }
  }, [streamingThinking]);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  // Ref，始终指向当前 abort controller，由 REPL bridge 使用
  // 在远程中断到达时中止活动查询。
  const abortControllerRef = useRef<AbortController | null>(null);
  abortControllerRef.current = abortController;

  // bridge 结果回调的 ref — 在 useReplBridge 初始化后设置，
  // 在 onQuery finally 块中读取以通知移动端回合已结束。
  const sendBridgeResultRef = useRef<() => void>(() => {});

  // 同步恢复回调的 ref — 在 restoreMessageSync 定义后设置，
  // 在 onQuery finally 块中读取以在中断时自动恢复。
  const restoreMessageSyncRef = useRef<(m: UserMessage) => void>(() => {});

  // 全屏布局滚动框的 ref，用于键盘滚动。
  // 全屏模式禁用时为 null（ref 从未附加）。
  const scrollRef = useRef<ScrollBoxHandle>(null);
  // modal slot 内部 ScrollBox 的独立 ref — 通过
  // FullscreenLayout → ModalContext 传递，以便 Tabs 可以将其附加到自己的
  // ScrollBox 用于高内容（例如 /status 的 MCP 服务器列表）。
  // 非键盘驱动 — ScrollKeybindingHandler 保持在外部 ref 上，
  // 所以 PgUp/PgDn/wheel 始终滚动 modal 后面的转录。
  // 管道保留以供未来 modal-scroll 布线使用。
  const modalScrollRef = useRef<ScrollBoxHandle>(null);
  // 用户发起滚动的最后一次时间戳（滚轮、PgUp/PgDn、ctrl+u、
  // End/Home、G、拖拽滚动）。在 composedOnScroll 中加盖 —
  // ScrollKeybindingHandler 为每个用户滚动动作调用的单一瓶颈。
  // 程序化滚动（repinScroll 的 scrollToBottom、sticky 自动跟随）
  // 不经过 composedOnScroll，所以不会加盖此值。Ref 而非 state：
  // 每次滚轮 tick 不触发重新渲染。
  const lastUserScrollTsRef = useRef(0);

  // 查询生命周期的同步状态机。替换容易出错的双状态模式，
  // 其中 isLoading（React state，异步批处理）和 isQueryRunning（ref，同步）
  // 可能不同步。参见 QueryGuard.ts。
  const queryGuard = React.useRef(new QueryGuard()).current;

  // 订阅 guard — dispatching 或 running 期间为 true。
  // 这是"本地查询是否在飞行中"的唯一真实来源。
  const isQueryActive = React.useSyncExternalStore(queryGuard.subscribe, queryGuard.getSnapshot);

  // 本地查询 guard 之外的操作的独立 loading 标志：
  // 远程会话（useRemoteSession / useDirectConnect）和前台化
  // 后台任务（useSessionBackgrounding）。这些不经过
  // onQuery / queryGuard，所以需要自己的 spinner 可见性 state。
  // 如果使用初始提示的 remote mode 则初始化为 true（CCR 正在处理）。
  const [isExternalLoading, setIsExternalLoadingRaw] = React.useState(remoteSessionConfig?.hasInitialPrompt ?? false);

  // 派生：任何 loading 源活动。只读 — 无 setter。本地查询
  // loading 由 queryGuard 驱动（reserve/tryStart/end/cancelReservation），
  // 外部 loading 由 setIsExternalLoading 驱动。
  const isLoading = isQueryActive || isExternalLoading;

  // 已过时间由 SpinnerWithVerb 从这些 ref 在每一帧计算，
  // 避免 useInterval 重新渲染整个 REPL。
  const [userInputOnProcessing, setUserInputOnProcessingRaw] = React.useState<string | undefined>(undefined);
  // 设置 userInputOnProcessing 时消息计数基线
  // messagesRef.current.length 在设置 userInputOnProcessing 时捕获。
  // 占位符在 displayedMessages 超过此值后隐藏 — 即
  // 真实用户消息已到达可见转录。
  const userInputBaselineRef = React.useRef(0);
  // 在提交的提示正在处理但用户消息
  // 尚未到达 setMessages 时为 true。setMessages 使用此值使
  // 基线保持同步，当不相关的异步消息（bridge 状态、hook
  // 结果、计划任务）在 processUserInputBase 期间到达时。
  const userMessagePendingRef = React.useRef(false);

  // 精确已过时间计算的挂钟时间跟踪 ref
  const loadingStartTimeRef = React.useRef<number>(0);
  const totalPausedMsRef = React.useRef(0);
  const pauseStartTimeRef = React.useRef<number | null>(null);
  const resetTimingRefs = React.useCallback(() => {
    loadingStartTimeRef.current = Date.now();
    totalPausedMsRef.current = 0;
    pauseStartTimeRef.current = null;
  }, []);

  // 当 isQueryActive 从 false→true 转换时内联重置 timing refs。
  // queryGuard.reserve()（在 executeUserInput 中）在 processUserInput 的
  // 第一个 await 之前触发，但 onQuery try 块中的 ref 重置在之后运行。
  // 在此期间，React 用 loadingStartTimeRef=0 渲染 spinner，计算
  // elapsedTimeMs = Date.now() - 0 ≈ 56 年。此内联重置在
  // 首次观察到 isQueryActive 为 true 的渲染上运行 — 与首次
  // 显示 spinner 的渲染相同 — 所以 spinner 读取时 ref 是正确的。参见 INC-4549。
  const wasQueryActiveRef = React.useRef(false);
  if (isQueryActive && !wasQueryActiveRef.current) {
    resetTimingRefs();
  }
  wasQueryActiveRef.current = isQueryActive;

  // 包装 setIsExternalLoading 在转换为 true 时重置 timing refs —
  // SpinnerWithVerb 读取这些用于已过时间，所以它们必须为
  // 远程会话/前台任务重置（不仅是本地查询，它们在 onQuery 中重置）。
  // 没有这个，纯远程会话会显示约 56 年的已过时间（Date.now() - 0）。
  const setIsExternalLoading = React.useCallback((value: boolean) => {
    setIsExternalLoadingRaw(value);
    if (value) resetTimingRefs();
  }, [resetTimingRefs]);

  // 有 swarm teammate 运行的第一个回合的开始时间
  // 用于计算延迟消息的总已过时间（包括 teammate 执行）
  const swarmStartTimeRef = React.useRef<number | null>(null);
  const swarmBudgetInfoRef = React.useRef<{
    tokens: number;
    limit: number;
    nudges: number;
  } | undefined>(undefined);

  // 跟踪当前 focusedInputDialog 的 ref，用于回调中读取
  // 避免在 timer 回调中检查对话框状态时出现过时闭包
  const focusedInputDialogRef = React.useRef<ReturnType<typeof getFocusedInputDialog>>(undefined);

  // 用户停止打字后多久显示延迟对话框
  const PROMPT_SUPPRESSION_MS = 1500;
  // 用户正在打字时为 true — 延迟中断对话框以免按键
  // 意外关闭或回答用户尚未阅读的权限提示。
  const [isPromptInputActive, setIsPromptInputActive] = React.useState(false);
  const [autoUpdaterResult, setAutoUpdaterResult] = useState<AutoUpdaterResult | null>(null);
  useEffect(() => {
    if (autoUpdaterResult?.notifications) {
      autoUpdaterResult.notifications.forEach(notification => {
        addNotification({
          key: 'auto-updater-notification',
          text: notification,
          priority: 'low'
        });
      });
    }
  }, [autoUpdaterResult, addNotification]);

  // tmux + fullscreen + `mouse off`：一次性提示滚轮不会滚动。
  // 我们不再修改 tmux 的会话级 mouse 选项（会污染
  // 兄弟面板）；tmux 用户已经从 vim/less 知道这个权衡。
  useEffect(() => {
    if (isFullscreenEnvEnabled()) {
      void maybeGetTmuxMouseHint().then(hint => {
        if (hint) {
          addNotification({
            key: 'tmux-mouse-hint',
            text: hint,
            priority: 'low'
          });
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [showUndercoverCallout, setShowUndercoverCallout] = useState(false);
  useEffect(() => {
    if ("external" === 'ant') {
      void (async () => {
        // 等待仓库分类稳定（记忆化，如果已预加载则无操作）。
        const {
          isInternalModelRepo
        } = await import('../utils/commitAttribution.js');
        await isInternalModelRepo();
        const {
          shouldShowUndercoverAutoNotice
        } = await import('../utils/undercover.js');
        if (shouldShowUndercoverAutoNotice()) {
          setShowUndercoverCallout(true);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [toolJSX, setToolJSXInternal] = useState<{
    jsx: React.ReactNode | null;
    shouldHidePromptInput: boolean;
    shouldContinueAnimation?: true;
    showSpinner?: boolean;
    isLocalJSXCommand?: boolean;
    isImmediate?: boolean;
  } | null>(null);

  // 单独跟踪本地 JSX 命令，以便工具不会覆盖它们。
  // 这使"即时"命令（如 /btw）能在 Zy 处理时持续存在。
  const localJSXCommandRef = useRef<{
    jsx: React.ReactNode | null;
    shouldHidePromptInput: boolean;
    shouldContinueAnimation?: true;
    showSpinner?: boolean;
    isLocalJSXCommand: true;
  } | null>(null);

  // setToolJSX 的包装器，保留本地 JSX 命令（如 /btw）。
  // 当本地 JSX 命令活动时，忽略工具的更新
  // 除非它们显式设置 clearLocalJSX: true（来自 onDone 回调）。
  //
  // 添加新即时命令的步骤：
  // 1. 在命令定义中设置 `immediate: true`
  // 2. 在命令的 JSX 中调用 setToolJSX 时设置 `isLocalJSXCommand: true`
  // 3. 在 onDone 回调中，使用 `setToolJSX({ jsx: null, shouldHidePromptInput: false, clearLocalJSX: true })`
  //    在用户关闭时显式清除此覆盖层
  const setToolJSX = useCallback((args: {
    jsx: React.ReactNode | null;
    shouldHidePromptInput: boolean;
    shouldContinueAnimation?: true;
    showSpinner?: boolean;
    isLocalJSXCommand?: boolean;
    clearLocalJSX?: boolean;
  } | null) => {
    // 如果设置本地 JSX 命令，存储在 ref 中
    if (args?.isLocalJSXCommand) {
      const {
        clearLocalJSX: _,
        ...rest
      } = args;
      localJSXCommandRef.current = {
        ...rest,
        isLocalJSXCommand: true
      };
      setToolJSXInternal(rest);
      return;
    }

    // 如果有活动的本地 JSX 命令在 ref 中
    if (localJSXCommandRef.current) {
      // 仅在显式请求时允许清除（来自 onDone 回调）
      if (args?.clearLocalJSX) {
        localJSXCommandRef.current = null;
        setToolJSXInternal(null);
        return;
      }
    // 保留本地 JSX 命令可见性 — 忽略工具更新
      return;
    }

    // 没有活动的本地 JSX 命令，允许任何更新
    if (args?.clearLocalJSX) {
      setToolJSXInternal(null);
      return;
    }
    setToolJSXInternal(args);
  }, []);
  const [toolUseConfirmQueue, setToolUseConfirmQueue] = useState<ToolUseConfirm[]>([]);
  // 由权限请求组件注册的粘性 footer JSX（当前
  // 仅 ExitPlanModePermissionRequest）。在 FullscreenLayout 的 `bottom`
  // 插槽中渲染，以便用户在滚动长计划时响应选项保持可见。
  const [permissionStickyFooter, setPermissionStickyFooter] = useState<React.ReactNode | null>(null);
  const [sandboxPermissionRequestQueue, setSandboxPermissionRequestQueue] = useState<Array<{
    hostPattern: NetworkHostPattern;
    resolvePromise: (allowConnection: boolean) => void;
  }>>([]);
  const [promptQueue, setPromptQueue] = useState<Array<{
    request: PromptRequest;
    title: string;
    toolInputSummary?: string | null;
    resolve: (response: PromptResponse) => void;
    reject: (error: Error) => void;
  }>>([]);

  // 跟踪沙盒权限请求的 bridge 清理函数，以便
  // 本地对话框处理程序可以在本地用户先响应时取消远程提示。
  // 以 host 为键支持并发的同 host 请求。
  const sandboxBridgeCleanupRef = useRef<Map<string, Array<() => void>>>(new Map());

  // -- 终端标题管理
  // 会话标题（通过 /rename 设置或恢复时还原）优先于
  // agent 名称，agent 名称优先于 Haiku 提取的主题；
  // 所有都回退到产品名称。
  const terminalTitleFromRename = useAppState(s => s.settings.terminalTitleFromRename) !== false;
  const sessionTitle = terminalTitleFromRename ? getCurrentSessionTitle(getSessionId()) : undefined;
  const [haikuTitle, setHaikuTitle] = useState<string>();
  // 门控单次 Haiku 调用生成标签标题。恢复时种子为 true
  // （存在 initialMessages），所以我们不会从会话中间上下文
  // 重新为恢复的会话设置标题。
  const haikuTitleAttemptedRef = useRef((initialMessages?.length ?? 0) > 0);
  const agentTitle = mainThreadAgentDefinition?.agentType;
  const terminalTitle = sessionTitle ?? agentTitle ?? haikuTitle ?? 'ZY Code';
  const isWaitingForApproval = toolUseConfirmQueue.length > 0 || promptQueue.length > 0 || pendingWorkerRequest || pendingSandboxRequest;
  // 本地 jsx 命令（如 /plugin, /config）显示面向用户的对话框，
  // 等待输入。要求 jsx != null — 如果标志卡为 true 但 jsx
  // 为 null，视为未显示以免 TextInput 焦点和队列处理器
  // 被幻影覆盖死锁。
  const isShowingLocalJSXCommand = toolJSX?.isLocalJSXCommand === true && toolJSX?.jsx != null;
  const titleIsAnimating = isLoading && !isWaitingForApproval && !isShowingLocalJSXCommand;
  // 标题动画 state 位于 <AnimatedTerminalTitle> 中，这样 960ms tick
  // 不会重新渲染 REPL。titleDisabled/terminalTitle 仍在此计算
  // 因为 onQueryImpl 读取它们（后台会话描述、haiku 标题门控）。

  // Zy 工作时防止 macOS 休眠
  useEffect(() => {
    if (isLoading && !isWaitingForApproval && !isShowingLocalJSXCommand) {
      startPreventSleep();
      return () => stopPreventSleep();
    }
  }, [isLoading, isWaitingForApproval, isShowingLocalJSXCommand]);
  const sessionStatus: TabStatusKind = isWaitingForApproval || isShowingLocalJSXCommand ? 'waiting' : isLoading ? 'busy' : 'idle';
  const waitingFor = sessionStatus !== 'waiting' ? undefined : toolUseConfirmQueue.length > 0 ? `approve ${toolUseConfirmQueue[0]!.tool.name}` : pendingWorkerRequest ? 'worker request' : pendingSandboxRequest ? 'sandbox request' : isShowingLocalJSXCommand ? 'dialog open' : 'input needed';

  // 将状态推送到 PID 文件以供 `zy ps` 使用。发送后不管；ps 在
  // 缺少/过期时会回退到转录尾部推导。
  useEffect(() => {
    if (feature('BG_SESSIONS')) {
      void updateSessionActivity({
        status: sessionStatus,
        waitingFor
      });
    }
  }, [sessionStatus, waitingFor]);

  // 第三方默认：关闭 — OSC 21337 是 ant 专属而规范正在稳定。
  // 门控以便我们可以在侧边栏指示器与
  // 渲染两者的终端中标题 spinner 冲突时回滚。标志开启时，
  // 面向用户的配置设置控制其是否活动。
  const tabStatusGateEnabled = getFeatureValue_CACHED_MAY_BE_STALE('tengu_terminal_sidebar', false);
  const showStatusInTerminalTab = tabStatusGateEnabled && (getGlobalConfig().showStatusInTerminalTab ?? false);
  useTabStatus(titleDisabled || !showStatusInTerminalTab ? null : sessionStatus);

  // 为进程内 teammate 注册 leader 的 setToolUseConfirmQueue
  useEffect(() => {
    registerLeaderToolUseConfirmQueue(setToolUseConfirmQueue);
    return () => unregisterLeaderToolUseConfirmQueue();
  }, [setToolUseConfirmQueue]);
  const [messages, rawSetMessages] = useState<MessageType[]>(initialMessages ?? []);
  const messagesRef = useRef(messages);
  // 存储已显示（如果未显示提示则为 false）的 willowMode 变体。
  // 在提示显示时捕获，以便 hint_converted 遥测报告相同的
  // 变体 — GrowthBook 值不应在会话中间更改，但读取
  // 一次可保证配对事件之间的一致性。
  const idleHintShownRef = useRef<string | false>(false);
  // 包装 setMessages 使 messagesRef 在调用返回时始终是当前值 —
  // 不是 React 稍后处理批处理时。对 ref 热切应用 updater 函数，
  // 然后将计算值（不是函数）交给 React。rawSetMessages 批处理
  // 变为最后写入获胜，最后一次写入是正确的，因为每次调用都基于
  // 已更新的 ref 组合。这是 Zustand 模式：ref 是真实来源，
  // React state 是渲染投影。没有这个，排队函数 updater 然后
  // 同步读取 ref 的路径（例如 handleSpeculationAccept → onQuery）
  // 会看到过时数据。
  const setMessages = useCallback((action: React.SetStateAction<MessageType[]>) => {
    const prev = messagesRef.current;
    const next = typeof action === 'function' ? action(messagesRef.current) : action;
    messagesRef.current = next;
    if (next.length < userInputBaselineRef.current) {
      // 缩小（压缩/回退/清除）— 钳制以便 placeholderText 的长度
      // 检查不会过时。
      userInputBaselineRef.current = 0;
    } else if (next.length > prev.length && userMessagePendingRef.current) {
      // 增长而提交的用户消息尚未到达。如果
      // 新增消息不包括它（bridge 状态、hook 结果、
      // 计划任务在 processUserInputBase 期间异步到达），增加
      // 基线以便占位符保持可见。一旦用户消息
      // 到达，停止跟踪 — 后来的添加（assistant 流）
      // 不应重新显示占位符。
      const delta = next.length - prev.length;
      const added = prev.length === 0 || next[0] === prev[0] ? next.slice(-delta) : next.slice(0, delta);
      if (added.some(isHumanTurn)) {
        userMessagePendingRef.current = false;
      } else {
        userInputBaselineRef.current = next.length;
      }
    }
    rawSetMessages(next);
  }, []);
  // 捕获基线消息计数与占位符文本，以便
  // 渲染可以在 displayedMessages 超过基线后隐藏它。
  const setUserInputOnProcessing = useCallback((input: string | undefined) => {
    if (input !== undefined) {
      userInputBaselineRef.current = messagesRef.current.length;
      userMessagePendingRef.current = true;
    } else {
      userMessagePendingRef.current = false;
    }
    setUserInputOnProcessingRaw(input);
  }, []);
  // 全屏：跟踪未见分隔线位置。dividerIndex 变化
  // 仅约两次/滚动会话（首次滚动离开 + 重新固定）。pillVisible
  // 和 stickyPrompt 现在位于 FullscreenLayout — 它们订阅
  // ScrollBox 直接所以每帧滚动不会重新渲染 REPL。
  const {
    dividerIndex,
    dividerYRef,
    onScrollAway,
    onRepin,
    jumpToNew,
    shiftDivider
  } = useUnseenDivider(messages.length);
  if (feature('AWAY_SUMMARY')) {
    // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
    useAwaySummary(messages, setMessages, isLoading);
  }
  const [cursor, setCursor] = useState<MessageActionsState | null>(null);
  const cursorNavRef = useRef<MessageActionsNav | null>(null);
  // Messages 的 memoized 以便 Messages 的 React.memo 保持有效。
  const unseenDivider = useMemo(() => computeUnseenDivider(messages, dividerIndex),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- length change covers appends; useUnseenDivider's count-drop guard clears dividerIndex on replace/rewind
  [dividerIndex, messages.length]);
  // 重新固定滚动到底部并清除未见消息基线。调用
  // 在任何用户驱动的回实时操作（提交、打字到空、
  // 叠加层出现/关闭）。
  const repinScroll = useCallback(() => {
    scrollRef.current?.scrollToBottom();
    onRepin();
    setCursor(null);
  }, [onRepin, setCursor]);
  // onSubmit 提交处理器重新固定的后备。如果缓冲的 stdin
  // 事件（滚轮/拖拽）在处理器触发和 state 提交之间竞争，
  // 处理器的 scrollToBottom 可能被撤销。此 effect 在
  // 用户消息实际到达的渲染上触发 — 绑定到 React 的提交周期，
  // 所以它不能与 stdin 竞争。以 lastMsg identity 为键（不是 messages.length）
  // 所以 useAssistantHistory 的前置不会错误地重新固定。
  const lastMsg = messages.at(-1);
  const lastMsgIsHuman = lastMsg != null && isHumanTurn(lastMsg);
  useEffect(() => {
    if (lastMsgIsHuman) {
      repinScroll();
    }
  }, [lastMsgIsHuman, lastMsg, repinScroll]);
  // 助手聊天：向上滚动时懒加载远程历史。无操作除非
  // KAIROS 构建 + config.viewerOnly。feature() 是构建时常量所以
  // 分支在非 KAIROS 构建中被死代码消除（与上面
  // useUnseenDivider 相同模式）。
  const {
    maybeLoadOlder
  } = feature('KAIROS') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAssistantHistory({
    config: remoteSessionConfig,
    setMessages,
    scrollRef,
    onPrepend: shiftDivider
  }) : HISTORY_STUB;
  // 组合 useUnseenDivider 的回调与懒加载触发器。
  const composedOnScroll = useCallback((sticky: boolean, handle: ScrollBoxHandle) => {
    lastUserScrollTsRef.current = Date.now();
    if (sticky) {
      onRepin();
    } else {
      onScrollAway(handle);
      if (feature('KAIROS')) maybeLoadOlder(handle);
      // 滚动时关闭伙伴气泡 — 它绝对定位
      // 在右下角，覆盖转录内容。滚动 = 用户正在
      // 尝试阅读它下面的内容。
      if (feature('BUDDY')) {
        setAppState(prev => prev.companionReaction === undefined ? prev : {
          ...prev,
          companionReaction: undefined
        });
      }
    }
  }, [onRepin, onScrollAway, maybeLoadOlder, setAppState]);
  // 延迟的 SessionStart hook 消息 — REPL 立即渲染并且
  // hook 消息在它们解析时注入。awaitPendingHooks()
  // 必须在第一次 API 调用之前调用，以便模型看到 hook 上下文。
  const awaitPendingHooks = useDeferredHookMessages(pendingHookMessages, setMessages);

  // Messages 组件的延迟消息 — 在 transition
  // 优先级渲染以便协调器每 5ms yield，保持输入响应
  // 同时运行昂贵的消息处理管道。
  const deferredMessages = useDeferredValue(messages);
  const deferredBehind = messages.length - deferredMessages.length;
  if (deferredBehind > 0) {
    logForDebugging(`[useDeferredValue] Messages deferred by ${deferredBehind} (${deferredMessages.length}→${messages.length})`);
  }

  // 转录模式的冻结状态 - 存储长度而不是克隆数组以提高内存效率
  const [frozenTranscriptState, setFrozenTranscriptState] = useState<{
    messagesLength: number;
    streamingToolUsesLength: number;
  } | null>(null);
  // 用 REPL 准备就绪之前捕获的任何早期输入初始化输入。
  // 使用懒初始化确保 PromptInput 中的光标偏移正确设置。
  const [inputValue, setInputValueRaw] = useState(() => consumeEarlyInput());
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;
  const insertTextRef = useRef<{
    insert: (text: string) => void;
    setInputWithCursor: (value: string, cursor: number) => void;
    cursorOffset: number;
  } | null>(null);

  // 包装 setInputValue 以共置抑制状态更新。
  // 两个 setState 调用发生在相同的同步上下文中，所以 React
  // 将它们批处理为单次渲染，消除之前 useEffect → setState
  // 模式导致的额外渲染。
  const setInputValue = useCallback((value: string) => {
    if (trySuggestBgPRIntercept(inputValueRef.current, value)) return;
    // 全屏模式下，向空提示打字会重新固定滚动到
    // 底部。仅在空→非空时触发，所以向上滚动参考
    // 内容同时编写消息不会在每个按键时把视图拉回。
    // 恢复全屏前的肌肉记忆：打字以快照回到对话末尾。
    // 如果用户在最后 3 秒内滚动则跳过 — 他们正在
    // 积极阅读，没有迷路。lastUserScrollTsRef 从 0 开始所以第一次
    // 按键（尚未滚动）始终重新固定。
    if (inputValueRef.current === '' && value !== '' && Date.now() - lastUserScrollTsRef.current >= RECENT_SCROLL_REPIN_WINDOW_MS) {
      repinScroll();
    }
    // 立即同步 ref（如 setMessages）以便调用者读取
    // inputValueRef 在 React 提交之前 — 例如自动恢复 finally
    // 块的 `=== ''` 守卫 — 看到新鲜值，而不是过时的渲染。
    inputValueRef.current = value;
    setInputValueRaw(value);
    setIsPromptInputActive(value.trim().length > 0);
  }, [setIsPromptInputActive, repinScroll, trySuggestBgPRIntercept]);

  // 调度超时以在用户停止打字后停止抑制对话框。
  // 仅管理超时 — 立即激活由上面的 setInputValue 处理。
  useEffect(() => {
    if (inputValue.trim().length === 0) return;
    const timer = setTimeout(setIsPromptInputActive, PROMPT_SUPPRESSION_MS, false);
    return () => clearTimeout(timer);
  }, [inputValue]);
  const [inputMode, setInputMode] = useState<PromptInputMode>('prompt');
  const [stashedPrompt, setStashedPrompt] = useState<{
    text: string;
    cursorOffset: number;
    pastedContents: Record<number, PastedContent>;
  } | undefined>();

  // 根据 CCR 可用斜杠命令过滤命令的回调
  const handleRemoteInit = useCallback((remoteSlashCommands: string[]) => {
    const remoteCommandSet = new Set(remoteSlashCommands);
    // Keep 列出 CCR 包含的命令或在本地安全集合中的命令
    setLocalCommands(prev => prev.filter(cmd => remoteCommandSet.has(cmd.name) || REMOTE_SAFE_COMMANDS.has(cmd)));
  }, [setLocalCommands]);
  const [inProgressToolUseIDs, setInProgressToolUseIDs] = useState<Set<string>>(new Set());
  const hasInterruptibleToolInProgressRef = useRef(false);

  // 远程会话 hook - 管理 --remote 模式的 WebSocket 连接和消息处理
  const remoteSession = useRemoteSession({
    config: remoteSessionConfig,
    setMessages,
    setIsLoading: setIsExternalLoading,
    onInit: handleRemoteInit,
    setToolUseConfirmQueue,
    tools: combinedInitialTools,
    setStreamingToolUses,
    setStreamMode,
    setInProgressToolUseIDs
  });

  // 直连 hook - 管理到 zy 服务器的 WebSocket 连接，用于 `zy connect` 模式
  const directConnect = useDirectConnect({
    config: directConnectConfig,
    setMessages,
    setIsLoading: setIsExternalLoading,
    setToolUseConfirmQueue,
    tools: combinedInitialTools
  });

  // SSH 会话 hook - 管理 ssh 子进程，用于 `zy ssh` 模式。
  // 与 useDirectConnect 相同的回调形状；仅底层
  // 传输不同（ChildProcess stdin/stdout 与 WebSocket）。
  const sshRemote = useSSHSession({
    session: sshSession,
    setMessages,
    setIsLoading: setIsExternalLoading,
    setToolUseConfirmQueue,
    tools: combinedInitialTools
  });

  // 使用活动的远程模式
  const activeRemote = sshRemote.isRemoteMode ? sshRemote : directConnect.isRemoteMode ? directConnect : remoteSession;
  const [pastedContents, setPastedContents] = useState<Record<number, PastedContent>>({});
  const [submitCount, setSubmitCount] = useState(0);
  // 使用 ref 而非 state 以避免在每次流式 text_delta 时触发 React 重新渲染。spinner 通过动画定时器读取此值。
  const responseLengthRef = useRef(0);
  // 用于 ant 专属 spinner 显示的 API 性能指标 ref（TTFT/OTPS）。
  // 累积回合中所有 API 请求的指标用于 P50 聚合。
  const apiMetricsRef = useRef<Array<{
    ttftMs: number;
    firstTokenTime: number;
    lastTokenTime: number;
    responseLengthBaseline: number;
    // 跟踪最后一次内容添加时的 responseLengthRef。
    // 由流式 delta 和子 agent 消息内容更新。
    // lastTokenTime 也在同时更新，所以 OTPS
    // 分母正确包括子 agent 处理时间。
    endResponseLength: number;
  }>>([]);
  const setResponseLength = useCallback((f: (prev: number) => number) => {
    const prev = responseLengthRef.current;
    responseLengthRef.current = f(prev);
    // 内容添加时（不是压缩重置），更新最新
    // 指标条目以便 OTPS 反映所有内容生成活动。
    // 此处更新 lastTokenTime 确保分母包括
    // 流式时间 AND 子 agent 执行时间，防止膨胀。
    if (responseLengthRef.current > prev) {
      const entries = apiMetricsRef.current;
      if (entries.length > 0) {
        const lastEntry = entries.at(-1)!;
        lastEntry.lastTokenTime = Date.now();
        lastEntry.endResponseLength = responseLengthRef.current;
      }
    }
  }, []);

  // 流式文本显示：每个 delta 直接设置 state（Ink 的 16ms 渲染
  // 节流批处理快速更新）。消息到达时清除（messages.ts）
  // 所以 displayedMessages 从 deferredMessages 原子切换到 messages。
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const reducedMotion = useAppState(s => s.settings.prefersReducedMotion) ?? false;
  const showStreamingText = !reducedMotion && !hasCursorUpViewportYankBug();
  const onStreamingText = useCallback((f: (current: string | null) => string | null) => {
    if (!showStreamingText) return;
    setStreamingText(f);
  }, [showStreamingText]);

  // 隐藏进行中的源行以便文本逐行流式传输，而不是
  // 逐字符。lastIndexOf 在没有换行时返回 -1，得到 '' → null。
  // 在 showStreamingText 上守卫以便在流式传输中间切换
  // reducedMotion 时立即隐藏流式预览。
  const visibleStreamingText = streamingText && showStreamingText ? streamingText.substring(0, streamingText.lastIndexOf('\n') + 1) || null : null;
  const [lastQueryCompletionTime, setLastQueryCompletionTime] = useState(0);
  const [spinnerMessage, setSpinnerMessage] = useState<string | null>(null);
  const [spinnerColor, setSpinnerColor] = useState<keyof Theme | null>(null);
  const [spinnerShimmerColor, setSpinnerShimmerColor] = useState<keyof Theme | null>(null);
  const [isMessageSelectorVisible, setIsMessageSelectorVisible] = useState(false);
  const [messageSelectorPreselect, setMessageSelectorPreselect] = useState<UserMessage | undefined>(undefined);
  const [showCostDialog, setShowCostDialog] = useState(false);
  const [conversationId, setConversationId] = useState(randomUUID());

  // 空闲返回对话框：用户在长空闲后提交时显示
  const [idleReturnPending, setIdleReturnPending] = useState<{
    input: string;
    idleMinutes: number;
  } | null>(null);
  const skipIdleCheckRef = useRef(false);
  const lastQueryCompletionTimeRef = useRef(lastQueryCompletionTime);
  lastQueryCompletionTimeRef.current = lastQueryCompletionTime;

  // 聚合工具结果预算：每个对话的决策跟踪。
  // 当 GrowthBook 标志开启时，query.ts 强制执行预算；当
  // 关闭（undefined）时，完全不强制执行。/clear、回退或压缩后
  // 的过时条目无害（tool_use_ids 是 UUID，过时
  // 键永远不会被查找）。内存有界，由总替换次数
  // × REPL 生命周期内约 ~2KB 预览 — 可忽略。
  //
  // 懒初始化通过 useState 初始化器 — useRef(expr) 在每次
  // 渲染时计算 expr（React 在第一次之后忽略它，但计算仍然运行）。
  // 对于大型恢复会话，重建执行 O(messages × blocks)
  // 工作；我们只想执行一次。
  const [contentReplacementStateRef] = useState(() => ({
    current: provisionContentReplacementState(initialMessages, initialContentReplacements)
  }));
  const [haveShownCostDialog, setHaveShownCostDialog] = useState(getGlobalConfig().hasAcknowledgedCostThreshold);
  const [vimMode, setVimMode] = useState<VimMode>('INSERT');
  const [showBashesDialog, setShowBashesDialog] = useState<string | boolean>(false);
  const [isSearchingHistory, setIsSearchingHistory] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  // showBashesDialog 位于 REPL 级以便它在 PromptInput 卸载后存活。
  // 当 ultraplan 批准在 pill 对话框打开时触发，PromptInput
  // 卸载（focusedInputDialog → 'ultraplan-choice'）但此值保持 true；
  // 接受后，PromptInput 重新挂载到空的"No tasks"对话框
  // （已完成的 ultraplan 任务已被过滤掉）。在此关闭它。
  useEffect(() => {
    if (ultraplanPendingChoice && showBashesDialog) {
      setShowBashesDialog(false);
    }
  }, [ultraplanPendingChoice, showBashesDialog]);
  const isTerminalFocused = useTerminalFocus();
  const terminalFocusRef = useRef(isTerminalFocused);
  terminalFocusRef.current = isTerminalFocused;
  const [theme] = useTheme();

  // resetLoadingState 每个回合运行两次（onQueryImpl 尾部 + onQuery finally）。
  // 没有这个守卫，两次调用都会选择提示 → 两次 recordShownTip → 两次
  // saveGlobalConfig 背靠背写入。在 onSubmit 中的提交时重置。
  const tipPickedThisTurnRef = React.useRef(false);
  const pickNewSpinnerTip = useCallback(() => {
    if (tipPickedThisTurnRef.current) return;
    tipPickedThisTurnRef.current = true;
    const newMessages = messagesRef.current.slice(bashToolsProcessedIdx.current);
    for (const tool of extractBashToolsFromMessages(newMessages)) {
      bashTools.current.add(tool);
    }
    bashToolsProcessedIdx.current = messagesRef.current.length;
    void getTipToShowOnSpinner({
      theme,
      readFileState: readFileState.current,
      bashTools: bashTools.current
    }).then(async tip => {
      if (tip) {
        const content = await tip.content({
          theme
        });
        setAppState(prev => ({
          ...prev,
          spinnerTip: content
        }));
        recordShownTip(tip);
      } else {
        setAppState(prev => {
          if (prev.spinnerTip === undefined) return prev;
          return {
            ...prev,
            spinnerTip: undefined
          };
        });
      }
    });
  }, [setAppState, theme]);

  // 重置 UI loading state。不显式调用 onTurnComplete - 那应该
  // 仅在查询回合实际完成时显式调用。
  const resetLoadingState = useCallback(() => {
    // isLoading 现在从 queryGuard 派生 — 无需 setter 调用。
    // queryGuard.end()（onQuery finally）或 cancelReservation()（executeUserInput
    // finally）在运行时已经将 guard 转换为空闲。
    // 外部 loading（远程/后台）由那些 hooks 单独重置。
    setIsExternalLoading(false);
    setUserInputOnProcessing(undefined);
    responseLengthRef.current = 0;
    apiMetricsRef.current = [];
    setStreamingText(null);
    setStreamingToolUses([]);
    setSpinnerMessage(null);
    setSpinnerColor(null);
    setSpinnerShimmerColor(null);
    pickNewSpinnerTip();
    endInteractionSpan();
    // 推测性 bash 分类器检查仅对当前
    // 回合的命令有效 — 每个回合后清除以避免累积
    // 未消耗检查（拒绝/中止路径）的 Promise 链。
    clearSpeculativeChecks();
  }, [pickNewSpinnerTip]);

  // 会话后台 — hook 在 getToolUseContext 之后定义

  const hasRunningTeammates = useMemo(() => getAllInProcessTeammateTasks(tasks).some(t => t.status === 'running'), [tasks]);

  // 所有 swarm teammate 完成后显示延迟回合持续时间消息
  useEffect(() => {
    if (!hasRunningTeammates && swarmStartTimeRef.current !== null) {
      const totalMs = Date.now() - swarmStartTimeRef.current;
      const deferredBudget = swarmBudgetInfoRef.current;
      swarmStartTimeRef.current = null;
      swarmBudgetInfoRef.current = undefined;
      setMessages(prev => [...prev, createTurnDurationMessage(totalMs, deferredBudget,
      // 仅计算 recordTranscript 将持久化的内容 — 瞬时
      // 进度 tick 和非 ant 附件被 isLoggableMessage 过滤
      // 且永远不会到达磁盘。使用原始 prev.length
      // 会使 checkResumeConsistency 对每个运行了进度发射工具的
      // 回合报告假 delta<0。
      count(prev, isLoggableMessage))]);
    }
  }, [hasRunningTeammates, setMessages]);

  // 进入 auto mode 时显示自动权限警告
  // （通过 Shift+Tab 切换或启动时）。防抖以避免
  // 用户快速循环模式时闪烁。
  // 总共仅显示 3 次跨会话。
  const safeYoloMessageShownRef = useRef(false);
  useEffect(() => {
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      if (toolPermissionContext.mode !== 'auto') {
        safeYoloMessageShownRef.current = false;
        return;
      }
      if (safeYoloMessageShownRef.current) return;
      const config = getGlobalConfig();
      const count = config.autoPermissionsNotificationCount ?? 0;
      if (count >= 3) return;
      const timer = setTimeout((ref, setMessages) => {
        ref.current = true;
        saveGlobalConfig(prev => {
          const prevCount = prev.autoPermissionsNotificationCount ?? 0;
          if (prevCount >= 3) return prev;
          return {
            ...prev,
            autoPermissionsNotificationCount: prevCount + 1
          };
        });
        setMessages(prev => [...prev, createSystemMessage(AUTO_MODE_DESCRIPTION, 'warning')]);
      }, 800, safeYoloMessageShownRef, setMessages);
      return () => clearTimeout(timer);
    }
  }, [toolPermissionContext.mode, setMessages]);

  // 如果 worktree 创建很慢且 sparse-checkout 未配置，
  // 提示用户考虑设置 settings.worktree.sparsePaths。
  const worktreeTipShownRef = useRef(false);
  useEffect(() => {
    if (worktreeTipShownRef.current) return;
    const wt = getCurrentWorktreeSession();
    if (!wt?.creationDurationMs || wt.usedSparsePaths) return;
    if (wt.creationDurationMs < 15_000) return;
    worktreeTipShownRef.current = true;
    const secs = Math.round(wt.creationDurationMs / 1000);
    setMessages(prev => [...prev, createSystemMessage(`Worktree creation took ${secs}s. For large repos, set \`worktree.sparsePaths\` in .zy/settings.json to check out only the directories you need — e.g. \`{"worktree": {"sparsePaths": ["src", "packages/foo"]}}\`.`, 'info')]);
  }, [setMessages]);

  // 唯一活动工具是 Sleep 时隐藏 spinner
  const onlySleepToolActive = useMemo(() => {
    const lastAssistant = messages.findLast(m => m.type === 'assistant');
    if (lastAssistant?.type !== 'assistant') return false;
    const inProgressToolUses = lastAssistant.message.content.filter(b => b.type === 'tool_use' && inProgressToolUseIDs.has(b.id));
    return inProgressToolUses.length > 0 && inProgressToolUses.every(b => b.type === 'tool_use' && b.name === SLEEP_TOOL_NAME);
  }, [messages, inProgressToolUseIDs]);
  const {
    onBeforeQuery: mrOnBeforeQuery,
    onTurnComplete: mrOnTurnComplete,
    render: mrRender
  } = useMoreRight({
    enabled: moreRightEnabled,
    setMessages,
    inputValue,
    setInputValue,
    setToolJSX
  });
  const showSpinner = (!toolJSX || toolJSX.showSpinner === true) && toolUseConfirmQueue.length === 0 && promptQueue.length === 0 && (
  // 在处理输入、API 调用、teammate 运行时，
  // 或待处理任务通知排队时显示 spinner（防止连续通知之间 spinner 弹跳）
  isLoading || userInputOnProcessing || hasRunningTeammates ||
  // 当任务通知排队处理时保持 spinner 可见。
  // 没有这个，spinner 在连续通知之间短暂消失
  // （例如多个后台 agent 快速连续完成），因为
  // isLoading 在处理每个通知之间短暂变为 false。
  getCommandQueueLength() > 0) &&
  // 等待 leader 批准权限请求时隐藏 spinner
  !pendingWorkerRequest && !onlySleepToolActive && (
  // 流式文本可见时隐藏 spinner（文本本身就是反馈），
  // 但当 isBriefOnly 抑制流式文本显示时保持可见
  !visibleStreamingText || isBriefOnly);

  // 检查是否有任何权限或提问提示当前可见
  // 用于防止在提示活动时打开调查
  const hasActivePrompt = toolUseConfirmQueue.length > 0 || promptQueue.length > 0 || sandboxPermissionRequestQueue.length > 0 || elicitation.queue.length > 0 || workerSandboxPermissions.queue.length > 0;
  const feedbackSurveyOriginal = useFeedbackSurvey(messages, isLoading, submitCount, 'session', hasActivePrompt);
  const skillImprovementSurvey = useSkillImprovementSurvey(setMessages);
  const showIssueFlagBanner = useIssueFlagBanner(messages, submitCount);

  // 包装反馈 survey handler 以触发自动运行 /issue
  const feedbackSurvey = useMemo(() => ({
    ...feedbackSurveyOriginal,
    handleSelect: (selected: 'dismissed' | 'bad' | 'fine' | 'good') => {
      // 新 survey 响应进来时重置 ref
      didAutoRunIssueRef.current = false;
      const showedTranscriptPrompt = feedbackSurveyOriginal.handleSelect(selected);
      // 未显示转录提示时为 "bad" 自动运行 /issue
      if (selected === 'bad' && !showedTranscriptPrompt && shouldAutoRunIssue('feedback_survey_bad')) {
        setAutoRunIssueReason('feedback_survey_bad');
        didAutoRunIssueRef.current = true;
      }
    }
  }), [feedbackSurveyOriginal]);

  // Compact 后 survey：如果功能门启用则在 compact 后显示
  const postCompactSurvey = usePostCompactSurvey(messages, isLoading, hasActivePrompt, {
    enabled: !isRemoteSession
  });

  // 记忆 survey：当助手提到记忆且本对话中读取了记忆文件时显示
  const memorySurvey = useMemorySurvey(messages, isLoading, hasActivePrompt, {
    enabled: !isRemoteSession
  });

  // 挫败感检测：检测到沮丧消息后显示转录共享提示
  const frustrationDetection = useFrustrationDetection(messages, isLoading, hasActivePrompt, feedbackSurvey.state !== 'closed' || postCompactSurvey.state !== 'closed' || memorySurvey.state !== 'closed');

  // 初始化 IDE 集成
  useIDEIntegration({
    autoConnectIdeFlag,
    ideToInstallExtension,
    setDynamicMcpConfig,
    setShowIdeOnboarding,
    setIDEInstallationState: setIDEInstallationStatus
  });
  useFileHistorySnapshotInit(initialFileHistorySnapshots, fileHistory, fileHistoryState => setAppState(prev => ({
    ...prev,
    fileHistory: fileHistoryState
  })));
  const resume = useCallback(async (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) => {
    const resumeStart = performance.now();
    try {
      // 反序列化消息以正确清理对话
      // 过滤未解析的工具使用并在需要时添加合成助手消息
      const messages = deserializeMessages(log.messages);

      // 匹配 coordinator/normal 模式到恢复的会话
      if (feature('COORDINATOR_MODE')) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const coordinatorModule = require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js');
        /* eslint-enable @typescript-eslint/no-require-imports */
        const warning = coordinatorModule.matchSessionMode(log.mode);
        if (warning) {
          // 模式切换后重新推导 agent 定义，以便内置 agent
          // 反映新的 coordinator/normal 模式
          /* eslint-disable @typescript-eslint/no-require-imports */
          const {
            getAgentDefinitionsWithOverrides,
            getActiveAgentsFromList
          } = require('../tools/AgentTool/loadAgentsDir.js') as typeof import('../tools/AgentTool/loadAgentsDir.js');
          /* eslint-enable @typescript-eslint/no-require-imports */
          getAgentDefinitionsWithOverrides.cache.clear?.();
          const freshAgentDefs = await getAgentDefinitionsWithOverrides(getOriginalCwd());
          setAppState(prev => ({
            ...prev,
            agentDefinitions: {
              ...freshAgentDefs,
              allAgents: freshAgentDefs.allAgents,
              activeAgents: getActiveAgentsFromList(freshAgentDefs.allAgents)
            }
          }));
          messages.push(createSystemMessage(warning, 'warning'));
        }
      }

      // 在恢复新会话之前为当前会话触发 SessionEnd hooks
      // 镜像 /clear 流程（conversation.ts）。
      const sessionEndTimeoutMs = getSessionEndHookTimeoutMs();
      await executeSessionEndHooks('resume', {
        getAppState: () => store.getState(),
        setAppState,
        signal: AbortSignal.timeout(sessionEndTimeoutMs),
        timeoutMs: sessionEndTimeoutMs
      });

      // 处理 resume 的 Session start hooks
      const hookMessages = await processSessionStartHooks('resume', {
        sessionId,
        agentType: mainThreadAgentDefinition?.agentType,
        model: mainLoopModel
      });

      // 将 hook 消息追加到对话中
      messages.push(...hookMessages);
      // 对于 fork，生成新的 plan slug 并复制 plan 内容，以便
      // 原始和 fork 会话不会互相覆盖 plan 文件。
      // 对于常规 resume，重用原始会话的 plan slug。
      if (entrypoint === 'fork') {
        void copyPlanForFork(log, asSessionId(sessionId));
      } else {
        void copyPlanForResume(log, asSessionId(sessionId));
      }

      // 从恢复的对话中恢复文件历史和归属状态
      restoreSessionStateFromLog(log, setAppState);
      if (log.fileHistorySnapshots) {
        void copyFileHistoryForResume(log);
      }

      // 从恢复的对话中恢复 agent 设置
      // 始终重置为新会话的值（或清除如果没有），
      // 匹配下面的 standaloneAgentContext 模式
      const {
        agentDefinition: restoredAgent
      } = restoreAgentFromSession(log.agentSetting, initialMainThreadAgentDefinition, agentDefinitions);
      setMainThreadAgentDefinition(restoredAgent);
      setAppState(prev => ({
        ...prev,
        agent: restoredAgent?.agentType
      }));

      // 从恢复的对话中恢复独立 agent 上下文
      // 始终重置为新会话的值（或清除如果没有）
      setAppState(prev => ({
        ...prev,
        standaloneAgentContext: computeStandaloneAgentContext(log.agentName, log.agentColor)
      }));
      void updateSessionName(log.agentName);

      // 从消息历史中恢复读取文件状态
      restoreReadFileState(messages, log.projectPath ?? getOriginalCwd());

      // 清除任何活动的 loading state（不在查询中所以没有 queryId）
      resetLoadingState();
      setAbortController(null);
      setConversationId(sessionId);

      // 在保存当前会话之前获取目标会话的成本
      // （saveCurrentSessionCosts 会覆盖配置，所以需要先读取）
      const targetSessionCosts = getStoredSessionCosts(sessionId);

      // 保存当前会话的成本以免切换到时丢失累积成本
      saveCurrentSessionCosts();

      // 恢复目标会话之前重置成本 state 以便干净起步
      resetCostState();

      // 切换会话（id + 项目目录原子操作）。fullPath 可能指向
      // 不同的项目（跨 worktree，/branch）；null 从
      // 当前 originalCwd 派生。
      switchSession(asSessionId(sessionId), log.fullPath ? dirname(log.fullPath) : null);
      // 重命名 asciicast 录音以匹配恢复的会话 ID
      const {
        renameRecordingForSession
      } = await import('../utils/asciicast.js');
      await renameRecordingForSession();
      await resetSessionFilePointer();

      // 先清除然后恢复会话元数据，以便退出时通过
      // reAppendSessionMetadata 重新追加。必须先调用 clearSessionMetadata：
      // restoreSessionMetadata 只在值为真时设置，所以不清除的话，
      // 没有 agent name 的会话会继承前一个会话的
      // 缓存名称并在第一次消息时写入错误的转录。
      clearSessionMetadata();
      restoreSessionMetadata(log);
      // 恢复的会话不应从会话中间上下文重新设置标题
      // （与 useRef 种子相同的理由），前一个会话的
      // Haiku 标题也不应继承。
      haikuTitleAttemptedRef.current = true;
      setHaikuTitle(undefined);

      // 退出之前 /resume 进入的任何 worktree，然后 cd 进入此
      // 会话所在的 worktree。没有退出，从 worktree B
      // 恢复到非 worktree C 会留下 cwd/currentWorktreeSession 过时；
      // 恢复 B→C 其中 C 也是 worktree 会完全失败
      // （getCurrentWorktreeSession 守卫阻止切换）。
      //
      // /branch 跳过：forkLog 不携带 worktreeSession，所以
      // 这会把用户踢出他们仍在工作的 worktree。与 processResumedConversation
      // 相同的 fork 跳过 adopt — fork 在 REPL 挂载时通过 recordTranscript
      // 实体化自己的文件。
      if (entrypoint !== 'fork') {
        exitRestoredWorktree();
        restoreWorktreeForResume(log.worktreeSession);
        adoptResumedSessionFile();
        void restoreRemoteAgentTasks({
          abortController: new AbortController(),
          getAppState: () => store.getState(),
          setAppState
        });
      } else {
      // Fork: 与 /clear 相同的重新持久化（conversation.ts）。上面的
      // clear 清除了 currentSessionWorktree，forkLog 不携带它，
      // 且进程仍在相同的 worktree 中
        const ws = getCurrentWorktreeSession();
        if (ws) saveWorktreeState(ws);
      }

      // 持久化当前模式以便未来 resume 知道此会话的模式
      if (feature('COORDINATOR_MODE')) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const {
          saveMode
        } = require('../utils/sessionStorage.js');
        const {
          isCoordinatorMode
        } = require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js');
        /* eslint-enable @typescript-eslint/no-require-imports */
        saveMode(isCoordinatorMode() ? 'coordinator' : 'normal');
      }

      // 恢复之前读取的目标会话成本
      if (targetSessionCosts) {
        setCostStateForRestore(targetSessionCosts);
      }

      // 重建恢复会话的替换 state。在
      // setSessionId 之后运行以便任何 post-resume 的新
      // 替换写入恢复会话的 tool-results 目录。以 ref.current 为门控：
      // 初始挂载已经读取了功能标志，所以我们不在这里
      // 重新读取（会话中间标志翻转在两个方向都保持不可观察）。
      //
      // 会话内 /branch 跳过：现有 ref 已经正确
      // （branch 保持 tool_use_ids），所以无需重建。
      // createFork() 确实将内容替换条目写入 forked
      // JSONL 并带有 fork 的 sessionId，所以 `zy -r {forkId}` 也有效。
      if (contentReplacementStateRef.current && entrypoint !== 'fork') {
        contentReplacementStateRef.current = reconstructContentReplacementState(messages, log.contentReplacements ?? []);
      }

      // 将消息重置为提供的初始消息
      // 使用回调以确保不依赖于过时 state
      setMessages(() => messages);

      // 清除任何活动的工具 JSX
      setToolJSX(null);

      // 清除输入以确保没有残留状态
      setInputValue('');
      logEvent('tengu_session_resumed', {
        entrypoint: entrypoint as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: true,
        resume_duration_ms: Math.round(performance.now() - resumeStart)
      });
    } catch (error) {
      logEvent('tengu_session_resumed', {
        entrypoint: entrypoint as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: false
      });
      throw error;
    }
  }, [resetLoadingState, setAppState]);

  // 懒初始化：useRef(createX()) 会在每次渲染调用 createX 并
  // 丢弃结果。LRUCache 构建在 FileStateCache 内部
  // 很昂贵（~170ms），所以我们使用 useState 的懒初始化器来
  // 精确创建一次，然后将稳定引用送入 useRef。
  const [initialReadFileState] = useState(() => createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE));
  const readFileState = useRef(initialReadFileState);
  const bashTools = useRef(new Set<string>());
  const bashToolsProcessedIdx = useRef(0);
  // 会话级 skill 发现跟踪（为 tengu_skill_tool_invocation 提供
  // was_discovered）。必须在 getToolUseContext 重建之间跨会话持久：
  // turn-0 发现在 onQuery 构建自己的上下文之前通过 processUserInput
  // 写入，turn N 的发现仍必须在 turn N+k 时归属于 SkillTool 调用。
  // 在 clearConversation 中清除。
  const discoveredSkillNamesRef = useRef(new Set<string>());
  // 会话级去重嵌套记忆 CLAUDE.md 附件。
  // readFileState 是 100 条目 LRU；一旦它驱逐 CLAUDE.md 路径，
  // 下一个发现周期会重新注入它。在 clearConversation 中清除。
  const loadedNestedMemoryPathsRef = useRef(new Set<string>());

  // 从消息中恢复读取文件状态的辅助函数（用于 resume 流程）
  // 这使 Zy 能够编辑在之前会话中读取的文件
  const restoreReadFileState = useCallback((messages: MessageType[], cwd: string) => {
    const extracted = extractReadFilesFromMessages(messages, cwd, READ_FILE_STATE_CACHE_SIZE);
    readFileState.current = mergeFileStateCaches(readFileState.current, extracted);
    for (const tool of extractBashToolsFromMessages(messages)) {
      bashTools.current.add(tool);
    }
  }, []);

  // 挂载时从 initialMessages 中提取读取文件状态
  // 这处理 CLI 标志 resume（--resume-session）和 ResumeConversation 屏幕
  // 其中消息作为 props 传递而不是通过 resume 回调
  useEffect(() => {
    if (initialMessages && initialMessages.length > 0) {
      restoreReadFileState(initialMessages, getOriginalCwd());
      void restoreRemoteAgentTasks({
        abortController: new AbortController(),
        getAppState: () => store.getState(),
        setAppState
      });
    }
    // 仅在挂载时运行 - initialMessages 不应在组件生命周期中更改
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const {
    status: apiKeyStatus,
    reverify
  } = useApiKeyVerification();

  // 自动运行 /issue state
  const [autoRunIssueReason, setAutoRunIssueReason] = useState<AutoRunIssueReason | null>(null);
  // Ref 跟踪此 survey 周期是否触发了 autoRunIssue，
  // 以便即使在 autoRunIssueReason 清除后也能抑制 [1] 后续提示。
  const didAutoRunIssueRef = useRef(false);

  // 退出反馈流程的 state
  const [exitFlow, setExitFlow] = useState<React.ReactNode>(null);
  const [isExiting, setIsExiting] = useState(false);

  // 计算是否应显示成本对话框
  const showingCostDialog = !isLoading && showCostDialog;

  // 确定哪个对话框应该获得焦点（如果有）
  // 权限和交互式对话框即使在设置了 toolJSX 时也可以显示，
  // 只要 shouldContinueAnimation 为 true。这防止当
  // agent 在等待用户交互时设置后台提示时死锁。
  function getFocusedInputDialog(): 'message-selector' | 'sandbox-permission' | 'tool-permission' | 'prompt' | 'worker-sandbox-permission' | 'elicitation' | 'cost' | 'idle-return' | 'init-onboarding' | 'ide-onboarding' | 'model-switch' | 'undercover-callout' | 'effort-callout' | 'remote-callout' | 'lsp-recommendation' | 'plugin-hint' | 'desktop-upsell' | 'ultraplan-choice' | 'ultraplan-launch' | undefined {
    // 退出状态始终优先
    if (isExiting || exitFlow) return undefined;

    // 高优先级对话框（无论打字与否始终显示）
    if (isMessageSelectorVisible) return 'message-selector';

    // 用户打字时抑制中断对话框
    if (isPromptInputActive) return undefined;
    if (sandboxPermissionRequestQueue[0]) return 'sandbox-permission';

    // 权限/交互式对话框（除非被 toolJSX 阻止否则显示）
    const allowDialogsWithAnimation = !toolJSX || toolJSX.shouldContinueAnimation;
    if (allowDialogsWithAnimation && toolUseConfirmQueue[0]) return 'tool-permission';
    if (allowDialogsWithAnimation && promptQueue[0]) return 'prompt';
    // 来自 swarm worker 的 worker 沙盒权限提示（网络访问）
    if (allowDialogsWithAnimation && workerSandboxPermissions.queue[0]) return 'worker-sandbox-permission';
    if (allowDialogsWithAnimation && elicitation.queue[0]) return 'elicitation';
    if (allowDialogsWithAnimation && showingCostDialog) return 'cost';
    if (allowDialogsWithAnimation && idleReturnPending) return 'idle-return';
    if (feature('ULTRAPLAN') && allowDialogsWithAnimation && !isLoading && ultraplanPendingChoice) return 'ultraplan-choice';
    if (feature('ULTRAPLAN') && allowDialogsWithAnimation && !isLoading && ultraplanLaunchPending) return 'ultraplan-launch';

    // Onboarding 对话框（特殊条件）
    if (allowDialogsWithAnimation && showIdeOnboarding) return 'ide-onboarding';

    // 模型切换 callout（ant 专属，从外部构建中消除）
    if ("external" === 'ant' && allowDialogsWithAnimation && showModelSwitchCallout) return 'model-switch';

    // Undercover 自动启用解释器（ant 专属，从外部构建中消除）
    if ("external" === 'ant' && allowDialogsWithAnimation && showUndercoverCallout) return 'undercover-callout';

    // Effort callout（启用 effort 时为 Opus 4.6 用户显示一次）
    if (allowDialogsWithAnimation && showEffortCallout) return 'effort-callout';

    // 远程 callout（首次启用桥之前显示一次）
    if (allowDialogsWithAnimation && showRemoteCallout) return 'remote-callout';

    // LSP 插件推荐（最低优先级 - 非阻塞建议）
    if (allowDialogsWithAnimation && lspRecommendation) return 'lsp-recommendation';

    // 来自 CLI/SDK stderr 的插件提示（与 LSP 推荐相同优先级）
    if (allowDialogsWithAnimation && hintRecommendation) return 'plugin-hint';

    // 桌面应用推荐（最多 3 次启动，最低优先级）
    if (allowDialogsWithAnimation && showDesktopUpsellStartup) return 'desktop-upsell';
    return undefined;
  }
  const focusedInputDialog = getFocusedInputDialog();

  // 权限提示存在但被隐藏因为用户正在打字
  const hasSuppressedDialogs = isPromptInputActive && (sandboxPermissionRequestQueue[0] || toolUseConfirmQueue[0] || promptQueue[0] || workerSandboxPermissions.queue[0] || elicitation.queue[0] || showingCostDialog);

  // 保持 ref 同步以便 timer 回调可以读取当前值
  focusedInputDialogRef.current = focusedInputDialog;

  // focusedInputDialog 变化时立即捕获暂停/恢复
  // 这确保准确计时即使在系统高负载下，而不是
  // 依赖 100ms 轮询间隔来检测状态变化
  useEffect(() => {
    if (!isLoading) return;
    const isPaused = focusedInputDialog === 'tool-permission';
    const now = Date.now();
    if (isPaused && pauseStartTimeRef.current === null) {
      // 刚进入暂停状态 - 记录确切时刻
      pauseStartTimeRef.current = now;
    } else if (!isPaused && pauseStartTimeRef.current !== null) {
      // 刚退出暂停状态 - 立即累积暂停时间
      totalPausedMsRef.current += now - pauseStartTimeRef.current;
      pauseStartTimeRef.current = null;
    }
  }, [focusedInputDialog, isLoading]);

  // 权限叠加出现或关闭时重新固定滚动到底部。
  // 叠加层现在在 ScrollBox 内消息下方渲染（不重新挂载），
  // 所以我们需要显式 scrollToBottom：
  //  - 出现：用户可能已向上滚动（sticky 损坏）—
  //    对话框是阻塞的必须可见
  //  - 关闭：用户可能在叠加层期间向上滚动阅读上下文，
  //    且 onScroll 被抑制所以 pill state 过时
  // useLayoutEffect 以便重新固定在 Ink 帧渲染之前提交 —
  // 不会有一帧错误滚动位置的闪烁。
  const prevDialogRef = useRef(focusedInputDialog);
  useLayoutEffect(() => {
    const was = prevDialogRef.current === 'tool-permission';
    const now = focusedInputDialog === 'tool-permission';
    if (was !== now) repinScroll();
    prevDialogRef.current = focusedInputDialog;
  }, [focusedInputDialog, repinScroll]);
  function onCancel() {
    if (focusedInputDialog === 'elicitation') {
      // Elicitation 对话框处理自己的 Escape，关闭它不应影响任何 loading state。
      return;
    }
    logForDebugging(`[onCancel] focusedInputDialog=${focusedInputDialog} streamMode=${streamMode}`);

    // 暂停 proactive mode 以便用户取回控制权。
    // 他们提交下一个输入时会恢复（见 onSubmit）。
    if (feature('PROACTIVE') || feature('KAIROS')) {
      proactiveModule?.pauseProactive();
    }
    queryGuard.forceEnd();
    skipIdleCheckRef.current = false;

    // 保留部分流式传输的文本以便用户可以看到
    // 按 Esc 之前生成的内容。在 resetLoadingState 清除
    // streamingText 之前推入，在 query.ts yield 异步中断标记之前，
    // 给出最终顺序 [user, partial-assistant, [Request interrupted by user]]。
    if (streamingText?.trim()) {
      setMessages(prev => [...prev, createAssistantMessage({
        content: streamingText
      })]);
    }
    resetLoadingState();

    // 清除任何活动的 token 预算以便后备不会在
    // 查询生成器尚未退出的过时预算上触发。
    if (feature('TOKEN_BUDGET')) {
      snapshotOutputTokensForTurn(null);
    }
    if (focusedInputDialog === 'tool-permission') {
      // Tool use confirm 自己处理 abort 信号
      toolUseConfirmQueue[0]?.onAbort();
      setToolUseConfirmQueue([]);
    } else if (focusedInputDialog === 'prompt') {
      // 拒绝所有待处理提示并清除队列
      for (const item of promptQueue) {
        item.reject(new Error('Prompt cancelled by user'));
      }
      setPromptQueue([]);
      abortController?.abort('user-cancel');
    } else if (activeRemote.isRemoteMode) {
      // 远程模式：发送中断信号到 CCR
      activeRemote.cancelRequest();
    } else {
      abortController?.abort('user-cancel');
    }

    // 清除 controller 以便后续 Escape 按键不会看到过时的
    // 中止信号。没有这个，canCancelRunningTask 为 false（信号
    // 已定义但 .aborted === true），所以如果没有其他
    // 激活条件 isActive 变为 false — 使 Escape 键绑定不活动。
    setAbortController(null);

    // forceEnd() 跳过 finally 路径 — 直接触发（aborted=true）。
    void mrOnTurnComplete(messagesRef.current, true);
  }

  // 取消权限请求时处理排队命令的函数
  const handleQueuedCommandOnCancel = useCallback(() => {
    const result = popAllEditable(inputValue, 0);
    if (!result) return;
    setInputValue(result.text);
    setInputMode('prompt');

    // 从排队命令中恢复图像到 pastedContents
    if (result.images.length > 0) {
      setPastedContents(prev => {
        const newContents = {
          ...prev
        };
        for (const image of result.images) {
          newContents[image.id] = image;
        }
        return newContents;
      });
    }
  }, [setInputValue, setInputMode, inputValue, setPastedContents]);

  // CancelRequestHandler 属性 - 在 KeybindingSetup 内渲染
  const cancelRequestProps = {
    setToolUseConfirmQueue,
    onCancel,
    onAgentsKilled: () => setMessages(prev => [...prev, createAgentsKilledMessage()]),
    isMessageSelectorVisible: isMessageSelectorVisible || !!showBashesDialog,
    screen,
    abortSignal: abortController?.signal,
    popCommandFromQueue: handleQueuedCommandOnCancel,
    vimMode,
    isLocalJSXCommand: toolJSX?.isLocalJSXCommand,
    isSearchingHistory,
    isHelpOpen,
    inputMode,
    inputValue,
    streamMode
  };
  useEffect(() => {
    const totalCost = getTotalCost();
    if (totalCost >= 5 /* $5 */ && !showCostDialog && !haveShownCostDialog) {
      logEvent('tengu_cost_threshold_reached', {});
      // 即使对话框不会渲染（无控制台计费
      // 访问）也标记为已显示。否则此 effect 会在会话剩余时间
      // 的每次消息更改时重新触发 — 观察到 200k+ 次虚假事件。
      setHaveShownCostDialog(true);
      if (hasConsoleBillingAccess()) {
        setShowCostDialog(true);
      }
    }
  }, [messages, showCostDialog, haveShownCostDialog]);
  const sandboxAskCallback: SandboxAskCallback = useCallback(async (hostPattern: NetworkHostPattern) => {
    // 作为 swarm worker 运行时，通过 mailbox 将请求转发给 leader
    if (isAgentSwarmsEnabled() && isSwarmWorker()) {
      const requestId = generateSandboxRequestId();

      // 通过 mailbox 发送请求给 leader
      const sent = await sendSandboxPermissionRequestViaMailbox(hostPattern.host, requestId);
      return new Promise(resolveShouldAllowHost => {
        if (!sent) {
          // 如果无法通过 mailbox 发送，回退到本地处理
          setSandboxPermissionRequestQueue(prev => [...prev, {
            hostPattern,
            resolvePromise: resolveShouldAllowHost
          }]);
          return;
        }

        // leader 响应时注册回调
        registerSandboxPermissionCallback({
          requestId,
          host: hostPattern.host,
          resolve: resolveShouldAllowHost
        });

        // 更新 AppState 以显示待处理指示器
        setAppState(prev => ({
          ...prev,
          pendingSandboxRequest: {
            requestId,
            host: hostPattern.host
          }
        }));
      });
    }

    // 非 worker 的正常流程：显示本地 UI 并可选地竞争
    // 对抗 REPL bridge（远程控制）如果已连接。
    return new Promise(resolveShouldAllowHost => {
      let resolved = false;
      function resolveOnce(allow: boolean): void {
        if (resolved) return;
        resolved = true;
        resolveShouldAllowHost(allow);
      }

      // 排队本地沙盒权限对话框
      setSandboxPermissionRequestQueue(prev => [...prev, {
        hostPattern,
        resolvePromise: resolveOnce
      }]);

      // REPL bridge 连接时，也将沙盒
      // 权限请求作为 can_use_tool control_request 转发，以便
      // 远程用户（例如在 zy.ai 上）也可以批准它。
      if (feature('BRIDGE_MODE')) {
        const bridgeCallbacks = store.getState().replBridgePermissionCallbacks;
        if (bridgeCallbacks) {
          const bridgeRequestId = randomUUID();
          bridgeCallbacks.sendRequest(bridgeRequestId, SANDBOX_NETWORK_ACCESS_TOOL_NAME, {
            host: hostPattern.host
          }, randomUUID(), `Allow network connection to ${hostPattern.host}?`);
          const unsubscribe = bridgeCallbacks.onResponse(bridgeRequestId, response => {
            unsubscribe();
            const allow = response.behavior === 'allow';
            // 解析 ALL 同一 host 的待处理请求，不仅是
            // 这个 — 镜像本地对话框处理程序模式。
            setSandboxPermissionRequestQueue(queue => {
              queue.filter(item => item.hostPattern.host === hostPattern.host).forEach(item => item.resolvePromise(allow));
              return queue.filter(item => item.hostPattern.host !== hostPattern.host);
            });
            // 清除此 host 的所有兄弟 bridge 订阅
            // （其他并发的同 host 请求）然后删除。
            const siblingCleanups = sandboxBridgeCleanupRef.current.get(hostPattern.host);
            if (siblingCleanups) {
              for (const fn of siblingCleanups) {
                fn();
              }
              sandboxBridgeCleanupRef.current.delete(hostPattern.host);
            }
          });

          // 注册清理以便本地对话框处理程序可以取消
          // 远程提示并在本地用户先响应时取消订阅。
          const cleanup = () => {
            unsubscribe();
            bridgeCallbacks.cancelRequest(bridgeRequestId);
          };
          const existing = sandboxBridgeCleanupRef.current.get(hostPattern.host) ?? [];
          existing.push(cleanup);
          sandboxBridgeCleanupRef.current.set(hostPattern.host, existing);
        }
      }
    });
  }, [setAppState, store]);

  // #34044：如果用户显式设置 sandbox.enabled=true 但依赖缺失，
  // isSandboxingEnabled() 会静默返回 false。在
  // 挂载时显示一次原因，以便用户知道他们的安全配置未被强制执行。完整
  // 原因进入调试日志；通知指向 /sandbox 获取详情。
  // addNotification 稳定（useCallback）所以 effect 仅触发一次。
  useEffect(() => {
    const reason = SandboxManager.getSandboxUnavailableReason();
    if (!reason) return;
    if (SandboxManager.isSandboxRequired()) {
      process.stderr.write(`\nError: sandbox required but unavailable: ${reason}\n` + `  sandbox.failIfUnavailable is set — refusing to start without a working sandbox.\n\n`);
      gracefulShutdownSync(1, 'other');
      return;
    }
    logForDebugging(`sandbox disabled: ${reason}`, {
      level: 'warn'
    });
    addNotification({
      key: 'sandbox-unavailable',
      jsx: <>
          <Text color="warning">sandbox disabled</Text>
          <Text dimColor> · /sandbox</Text>
        </>,
      priority: 'medium'
    });
  }, [addNotification]);
  if (SandboxManager.isSandboxingEnabled()) {
    // 如果启用了沙盒（定义了 setting.sandbox，初始化管理器）
    SandboxManager.initialize(sandboxAskCallback).catch(err => {
      // 初始化/验证失败 - 显示错误并退出
      process.stderr.write(`\n❌ Sandbox Error: ${errorMessage(err)}\n`);
      gracefulShutdownSync(1, 'other');
    });
  }
  const setToolPermissionContext = useCallback((context: ToolPermissionContext, options?: {
    preserveMode?: boolean;
  }) => {
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...context,
        // 仅在显式请求时保留 coordinator 的模式。
        // Worker 的 getAppState() 返回转换后的上下文，模式为
        // 'acceptEdits'，不能通过权限规则更新泄漏到 coordinator 的实际
        // state — 那些调用点传递
        // { preserveMode: true }。用户发起的模式更改（例如，
        // 选择"allow all edits"）不得被覆盖。
        mode: options?.preserveMode ? prev.toolPermissionContext.mode : context.mode
      }
    }));

    // 权限上下文更改时，重新检查所有排队项
    // 这处理批准 item1 时使用"不再询问"
    // 应自动批准其他现在匹配更新规则的排队项
    setImmediate(setToolUseConfirmQueue => {
      // 使用 setToolUseConfirmQueue 回调获取当前队列 state
      // 而不是在闭包中捕获，以避免过时闭包问题
      setToolUseConfirmQueue(currentQueue => {
        currentQueue.forEach(item => {
          void item.recheckPermission();
        });
        return currentQueue;
      });
    }, setToolUseConfirmQueue);
  }, [setAppState, setToolUseConfirmQueue]);

  // 为进程内 teammate 注册 leader 的 setToolPermissionContext
  useEffect(() => {
    registerLeaderSetToolPermissionContext(setToolPermissionContext);
    return () => unregisterLeaderSetToolPermissionContext();
  }, [setToolPermissionContext]);
  const canUseTool = useCanUseTool(setToolUseConfirmQueue, setToolPermissionContext);
  const requestPrompt = useCallback((title: string, toolInputSummary?: string | null) => (request: PromptRequest): Promise<PromptResponse> => new Promise<PromptResponse>((resolve, reject) => {
    setPromptQueue(prev => [...prev, {
      request,
      title,
      toolInputSummary,
      resolve,
      reject
    }]);
  }), []);
  const getToolUseContext = useCallback((messages: MessageType[], newMessages: MessageType[], abortController: AbortController, mainLoopModel: string): ProcessUserInputContext => {
    // 从 store.getState() 新鲜读取可变值而不是闭包捕获
    // useAppState() 快照。今天的值相同（闭包通过
    // 回合之间的渲染刷新）；将新鲜度与 React 的渲染周期解耦
    // 为未来的无头对话循环。与 refreshTools() 使用的模式相同。
    const s = store.getState();

    // 从 store.getState() 新鲜计算工具而不是闭包
    // 捕获的 `tools`。useManageMCPConnections 异步填充 appState.mcp
    // 随着服务器连接 — store 可能有比
    // 渲染时捕获的闭包更新的 MCP state。也作为
    // 中间查询工具列表更新的 refreshTools()。
    const computeTools = () => {
      const state = store.getState();
      const assembled = assembleToolPool(state.toolPermissionContext, state.mcp.tools);
      const merged = mergeAndFilterTools(combinedInitialTools, assembled, state.toolPermissionContext.mode);
      if (!mainThreadAgentDefinition) return merged;
      return resolveAgentTools(mainThreadAgentDefinition, merged, false, true).resolvedTools;
    };
    return {
      abortController,
      options: {
        commands,
        tools: computeTools(),
        debug,
        verbose: s.verbose,
        mainLoopModel,
        thinkingConfig: s.thinkingEnabled !== false ? thinkingConfig : {
          type: 'disabled'
        },
        // Merge fresh from store rather than closing over useMergedClients'
        // memoized output. initialMcpClients is a prop (session-constant).
        mcpClients: mergeClients(initialMcpClients, s.mcp.clients),
        mcpResources: s.mcp.resources,
        ideInstallationStatus: ideInstallationStatus,
        isNonInteractiveSession: false,
        dynamicMcpConfig,
        theme,
        agentDefinitions: allowedAgentTypes ? {
          ...s.agentDefinitions,
          allowedAgentTypes
        } : s.agentDefinitions,
        customSystemPrompt,
        appendSystemPrompt,
        refreshTools: computeTools
      },
      getAppState: () => store.getState(),
      setAppState,
      messages,
      setMessages,
      updateFileHistoryState(updater: (prev: FileHistoryState) => FileHistoryState) {
        // 性能：当 updater 返回相同引用时跳过 setState
        // （例如 fileHistoryTrackEdit 在文件已被
        // 跟踪时返回 `state`）。否则每次无操作调用都会通知所有 store 监听器。
        setAppState(prev => {
          const updated = updater(prev.fileHistory);
          if (updated === prev.fileHistory) return prev;
          return {
            ...prev,
            fileHistory: updated
          };
        });
      },
      updateAttributionState(updater: (prev: AttributionState) => AttributionState) {
        setAppState(prev => {
          const updated = updater(prev.attribution);
          if (updated === prev.attribution) return prev;
          return {
            ...prev,
            attribution: updated
          };
        });
      },
      openMessageSelector: () => {
        if (!disabled) {
          setIsMessageSelectorVisible(true);
        }
      },
      onChangeAPIKey: reverify,
      readFileState: readFileState.current,
      setToolJSX,
      addNotification,
      appendSystemMessage: msg => setMessages(prev => [...prev, msg]),
      sendOSNotification: opts => {
        void sendNotification(opts, terminal);
      },
      onChangeDynamicMcpConfig,
      onInstallIDEExtension: setIDEToInstallExtension,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: loadedNestedMemoryPathsRef.current,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: discoveredSkillNamesRef.current,
      setResponseLength,
      pushApiMetricsEntry: "external" === 'ant' ? (ttftMs: number) => {
        const now = Date.now();
        const baseline = responseLengthRef.current;
        apiMetricsRef.current.push({
          ttftMs,
          firstTokenTime: now,
          lastTokenTime: now,
          responseLengthBaseline: baseline,
          endResponseLength: baseline
        });
      } : undefined,
      setStreamMode,
      onCompactProgress: event => {
        switch (event.type) {
          case 'hooks_start':
            setSpinnerColor('ZyBlue_FOR_SYSTEM_SPINNER');
            setSpinnerShimmerColor('ZyBlueShimmer_FOR_SYSTEM_SPINNER');
            setSpinnerMessage(event.hookType === 'pre_compact' ? 'Running PreCompact hooks\u2026' : event.hookType === 'post_compact' ? 'Running PostCompact hooks\u2026' : 'Running SessionStart hooks\u2026');
            break;
          case 'compact_start':
            setSpinnerMessage('Compacting conversation');
            break;
          case 'compact_end':
            setSpinnerMessage(null);
            setSpinnerColor(null);
            setSpinnerShimmerColor(null);
            break;
        }
      },
      setInProgressToolUseIDs,
      setHasInterruptibleToolInProgress: (v: boolean) => {
        hasInterruptibleToolInProgressRef.current = v;
      },
      resume,
      setConversationId,
      requestPrompt: feature('HOOK_PROMPTS') ? requestPrompt : undefined,
      contentReplacementState: contentReplacementStateRef.current
    };
  }, [commands, combinedInitialTools, mainThreadAgentDefinition, debug, initialMcpClients, ideInstallationStatus, dynamicMcpConfig, theme, allowedAgentTypes, store, setAppState, reverify, addNotification, setMessages, onChangeDynamicMcpConfig, resume, requestPrompt, disabled, customSystemPrompt, appendSystemPrompt, setConversationId]);

  // 会话后台（Ctrl+B 后台/前台）
  const handleBackgroundQuery = useCallback(() => {
    // 停止前台查询以便后台查询接管
    abortController?.abort('background');
    // 中止子 agent 可能会产生任务完成通知。
    // 清除任务通知以便队列处理器不会立即
    // 启动新的前台查询；将它们转发到后台会话。
    const removedNotifications = removeByFilter(cmd => cmd.mode === 'task-notification');
    void (async () => {
      const toolUseContext = getToolUseContext(messagesRef.current, [], new AbortController(), mainLoopModel);
      const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([getSystemPrompt(toolUseContext.options.tools, mainLoopModel, Array.from(toolPermissionContext.additionalWorkingDirectories.keys()), toolUseContext.options.mcpClients), getUserContext(), getSystemContext()]);
      const systemPrompt = buildEffectiveSystemPrompt({
        mainThreadAgentDefinition,
        toolUseContext,
        customSystemPrompt,
        defaultSystemPrompt,
        appendSystemPrompt
      });
      toolUseContext.renderedSystemPrompt = systemPrompt;
      const notificationAttachments = await getQueuedCommandAttachments(removedNotifications).catch(() => []);
      const notificationMessages = notificationAttachments.map(createAttachmentMessage);

      // 去重：如果查询循环已经在我们将通知从队列中移除之前
      // 将其 yield 到 messagesRef，跳过重复项。
      // 我们使用提示文本去重因为 source_uuid 未在
      // 任务通知 QueuedCommands 上设置（enqueuePendingNotification 调用者
      // 不传递 uuid），所以它始终为 undefined。
      const existingPrompts = new Set<string>();
      for (const m of messagesRef.current) {
        if (m.type === 'attachment' && m.attachment.type === 'queued_command' && m.attachment.commandMode === 'task-notification' && typeof m.attachment.prompt === 'string') {
          existingPrompts.add(m.attachment.prompt);
        }
      }
      const uniqueNotifications = notificationMessages.filter(m => m.attachment.type === 'queued_command' && (typeof m.attachment.prompt !== 'string' || !existingPrompts.has(m.attachment.prompt)));
      startBackgroundSession({
        messages: [...messagesRef.current, ...uniqueNotifications],
        queryParams: {
          systemPrompt,
          userContext,
          systemContext,
          canUseTool,
          toolUseContext,
          querySource: getQuerySourceForREPL()
        },
        description: terminalTitle,
        setAppState,
        agentDefinition: mainThreadAgentDefinition
      });
    })();
  }, [abortController, mainLoopModel, toolPermissionContext, mainThreadAgentDefinition, getToolUseContext, customSystemPrompt, appendSystemPrompt, canUseTool, setAppState]);
  const {
    handleBackgroundSession
  } = useSessionBackgrounding({
    setMessages,
    setIsLoading: setIsExternalLoading,
    resetLoadingState,
    setAbortController,
    onBackgroundQuery: handleBackgroundQuery
  });
  const onQueryEvent = useCallback((event: Parameters<typeof handleMessageFromStream>[0]) => {
    handleMessageFromStream(event, newMessage => {
      if (isCompactBoundaryMessage(newMessage)) {
        // 全屏：保留压缩前消息以供 scrollback。query.ts
        // 在边界处切片用于 API 调用，Messages.tsx 跳过
        // 全屏中的边界过滤，useLogMessages 将此
        // 视为增量追加（第一个 uuid 不变）。限制为一个
        // 压缩间隔的 scrollback — normalizeMessages/applyGrouping
        // 每次渲染 O(n)，所以在多日会话中丢弃前一个
        // 边界之前的所有内容以保持 n 有界。
        if (isFullscreenEnvEnabled()) {
          setMessages(old => [...getMessagesAfterCompactBoundary(old, {
            includeSnipped: true
          }), newMessage]);
        } else {
          setMessages(() => [newMessage]);
        }
        // 提升 conversationId 以便 Messages.tsx 行键更改并且
        // 过时 memoized 行以压缩后内容重新挂载。
        setConversationId(randomUUID());
        // 压缩成功 — 清除上下文阻塞标志以便 tick 恢复
        if (feature('PROACTIVE') || feature('KAIROS')) {
          proactiveModule?.setContextBlocked(false);
        }
      } else if (newMessage.type === 'progress' && isEphemeralToolProgress(newMessage.data.type)) {
        // 替换之前相同工具调用的瞬时进度 tick
        // 而不是追加。Sleep/Bash 每秒发射一个 tick 且
        // 只渲染最后一个；追加会使 messages
        // 数组膨胀（观察到 13k+）和转录（120MB 的 sleep_progress
        // 行）。useLogMessages 跟踪长度，所以相同长度替换
        // 也跳过转录写入。
        // agent_progress / hook_progress / skill_progress 不是瞬时的
        // — 每个都携带 UI 需要的不同状态（例如子 agent 工具
        // 历史）。替换那些会使 AgentTool UI 卡在
        // "Initializing…" 因为它渲染完整的进度轨迹。
        setMessages(oldMessages => {
          const last = oldMessages.at(-1);
          if (last?.type === 'progress' && last.parentToolUseID === newMessage.parentToolUseID && last.data.type === newMessage.data.type) {
            const copy = oldMessages.slice();
            copy[copy.length - 1] = newMessage;
            return copy;
          }
          return [...oldMessages, newMessage];
        });
      } else {
        setMessages(oldMessages => [...oldMessages, newMessage]);
      }
      // 阻塞 API 错误的 tick 以防止 tick → error → tick
      // 失控循环（例如认证失败、速率限制、阻塞限制）。
      // 在压缩边界（上方）或成功响应（下方）时清除。
      if (feature('PROACTIVE') || feature('KAIROS')) {
        if (newMessage.type === 'assistant' && 'isApiErrorMessage' in newMessage && newMessage.isApiErrorMessage) {
          proactiveModule?.setContextBlocked(true);
        } else if (newMessage.type === 'assistant') {
          proactiveModule?.setContextBlocked(false);
        }
      }
    }, newContent => {
      // setResponseLength 处理更新 responseLengthRef（用于
      // spinner 动画）和 apiMetricsRef（endResponseLength/lastTokenTime
      // 用于 OTPS）。此处无需单独更新指标。
      setResponseLength(length => length + newContent.length);
    }, setStreamMode, setStreamingToolUses, tombstonedMessage => {
      setMessages(oldMessages => oldMessages.filter(m => m !== tombstonedMessage));
      void removeTranscriptMessage(tombstonedMessage.uuid);
    }, setStreamingThinking, metrics => {
      const now = Date.now();
      const baseline = responseLengthRef.current;
      apiMetricsRef.current.push({
        ...metrics,
        firstTokenTime: now,
        lastTokenTime: now,
        responseLengthBaseline: baseline,
        endResponseLength: baseline
      });
    }, onStreamingText);
  }, [setMessages, setResponseLength, setStreamMode, setStreamingToolUses, setStreamingThinking, onStreamingText]);
  const onQueryImpl = useCallback(async (messagesIncludingNewMessages: MessageType[], newMessages: MessageType[], abortController: AbortController, shouldQuery: boolean, additionalAllowedTools: string[], mainLoopModelParam: string, effort?: EffortValue) => {
    // 为新提示准备 IDE 集成。从 store 新鲜读取 mcpClients —
    // useManageMCPConnections 可能在此闭包捕获后填充它
    // （与 computeTools 相同模式）。
    if (shouldQuery) {
      const freshClients = mergeClients(initialMcpClients, store.getState().mcp.clients);
      void diagnosticTracker.handleQueryStart(freshClients);
      const ideClient = getConnectedIdeClient(freshClients);
      if (ideClient) {
        void closeOpenDiffs(ideClient);
      }
    }

    // 向 ZY 发送任何用户消息时将 onboarding 标记为完成
    void maybeMarkProjectOnboardingComplete();

    // 从第一个真实用户消息中提取会话标题。单次
    // 通过 ref（曾是 tengu_birch_mist 实验：仅第一条消息以节省
    // Haiku 调用）。ref 替换了旧的 `messages.length <= 1` 检查，
    // 该检查被 SessionStart hook 消息（通过
    // useDeferredHookMessages 前置）和附件消息（通过
    // processTextPrompt 追加）破坏 — 两者都在第一回合将长度推到 1 以上，所以标题
    // 静默失败到 "Zy Code" 默认值。
    if (!titleDisabled && !sessionTitle && !agentTitle && !haikuTitleAttemptedRef.current) {
      const firstUserMessage = newMessages.find(m => m.type === 'user' && !m.isMeta);
      const text = firstUserMessage?.type === 'user' ? getContentText(firstUserMessage.message.content) : null;
      // 跳过合成面包屑 — 斜杠命令输出、prompt-skill
      // 扩展（/commit → <command-message>）、local-command 头部
      // （/help → <command-name>）和 bash 模式（!cmd → <bash-input>）。
      // 这些都不是用户的主题；等待真实散文。
      if (text && !text.startsWith(`<${LOCAL_COMMAND_STDOUT_TAG}>`) && !text.startsWith(`<${COMMAND_MESSAGE_TAG}>`) && !text.startsWith(`<${COMMAND_NAME_TAG}>`) && !text.startsWith(`<${BASH_INPUT_TAG}>`)) {
        haikuTitleAttemptedRef.current = true;
        void generateSessionTitle(text, new AbortController().signal).then(title => {
          if (title) setHaikuTitle(title);else haikuTitleAttemptedRef.current = false;
        }, () => {
          haikuTitleAttemptedRef.current = false;
        });
      }
    }

    // 将斜杠命令范围的 allowedTools（来自 skill frontmatter）应用到
    // store，每个回合一次。这也覆盖重置：下一个非 skill 回合
    // 传递 [] 并清除它。必须在 !shouldQuery 门控之前运行：forked
    // 命令（executeForkedSlashCommand）返回 shouldQuery=false，且
    // forkedAgent.ts 中的 createGetAppStateWithAllowedTools 读取此字段，所以
    // 过时 skill 工具否则可能泄漏到 forked agent 权限。
    // 之前此写入隐藏在 getToolUseContext 的 getAppState 内部
    // （约 85 次调用/回合）；提升到此使 getAppState 成为纯读取并停止
    // 临时上下文（权限对话框、BackgroundTasksDialog）在
    // 回合中间意外清除它。
    store.setState(prev => {
      const cur = prev.toolPermissionContext.alwaysAllowRules.command;
      if (cur === additionalAllowedTools || cur?.length === additionalAllowedTools.length && cur.every((v, i) => v === additionalAllowedTools[i])) {
        return prev;
      }
      return {
        ...prev,
        toolPermissionContext: {
          ...prev.toolPermissionContext,
          alwaysAllowRules: {
            ...prev.toolPermissionContext.alwaysAllowRules,
            command: additionalAllowedTools
          }
        }
      };
    });

    // 最后一条消息是助手消息，如果用户输入是 bash 命令，
    // 或用户输入是无效的斜杠命令。
    if (!shouldQuery) {
      // 手动 /compact 直接设置消息（shouldQuery=false）绕过
      // handleMessageFromStream。如果存在压缩边界则清除上下文阻塞
      // 以便压缩后 proactive tick 恢复。
      if (newMessages.some(isCompactBoundaryMessage)) {
        // Bump conversationId so Messages.tsx row keys change and
        // stale memoized rows remount with post-compact content.
        setConversationId(randomUUID());
        if (feature('PROACTIVE') || feature('KAIROS')) {
          proactiveModule?.setContextBlocked(false);
        }
      }
      resetLoadingState();
      setAbortController(null);
      return;
    }
    const toolUseContext = getToolUseContext(messagesIncludingNewMessages, newMessages, abortController, mainLoopModelParam);
    // getToolUseContext 从 store.getState() 新鲜读取 tools/mcpClients
    // （通过 computeTools/mergeClients）。使用这些而不是闭包
    // 捕获的 `tools`/`mcpClients` — useManageMCPConnections 可能在捕获此闭包
    // 的渲染和现在之间刷新了新的 MCP state。通过 processInitialMessage 的
    // 第 1 回合是主要受益者。
    const {
      tools: freshTools,
      mcpClients: freshMcpClients
    } = toolUseContext.options;

    // 将 skill 的 effort 覆盖范围限定为此回合的上下文 —
    // 包装 getAppState 使覆盖不进入全局 store，所以
    // 后台 agent 和 UI 订阅者（Spinner, LogoV2）永远不会看到它。
    if (effort !== undefined) {
      const previousGetAppState = toolUseContext.getAppState;
      toolUseContext.getAppState = () => ({
        ...previousGetAppState(),
        effortValue: effort
      });
    }
    queryCheckpoint('query_context_loading_start');
    const [,, defaultSystemPrompt, baseUserContext, systemContext] = await Promise.all([
    // 重要：在上面的 setMessages() 之后执行此操作，以避免 UI 卡顿
    checkAndDisableBypassPermissionsIfNeeded(toolPermissionContext, setAppState),
    // 在 TRANSCRIPT_CLASSIFIER 上门控以便 GrowthBook kill switch 在内置 auto mode 的任何地方运行
    feature('TRANSCRIPT_CLASSIFIER') ? checkAndDisableAutoModeIfNeeded(toolPermissionContext, setAppState, store.getState().fastMode) : undefined, getSystemPrompt(freshTools, mainLoopModelParam, Array.from(toolPermissionContext.additionalWorkingDirectories.keys()), freshMcpClients), getUserContext(), getSystemContext()]);
    const userContext = {
      ...baseUserContext,
      ...getCoordinatorUserContext(freshMcpClients, isScratchpadEnabled() ? getScratchpadDir() : undefined),
      ...((feature('PROACTIVE') || feature('KAIROS')) && proactiveModule?.isProactiveActive() && !terminalFocusRef.current ? {
        terminalFocus: 'The terminal is unfocused \u2014 the user is not actively watching.'
      } : {})
    };
    queryCheckpoint('query_context_loading_end');
    const systemPrompt = buildEffectiveSystemPrompt({
      mainThreadAgentDefinition,
      toolUseContext,
      customSystemPrompt,
      defaultSystemPrompt,
      appendSystemPrompt
    });
    toolUseContext.renderedSystemPrompt = systemPrompt;
    queryCheckpoint('query_query_start');
    resetTurnHookDuration();
    resetTurnToolDuration();
    resetTurnClassifierDuration();
    for await (const event of query({
      messages: messagesIncludingNewMessages,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool,
      toolUseContext,
      querySource: getQuerySourceForREPL()
    })) {
      onQueryEvent(event);
    }
    if (feature('BUDDY')) {
      void fireCompanionObserver(messagesRef.current, reaction => setAppState(prev => prev.companionReaction === reaction ? prev : {
        ...prev,
        companionReaction: reaction
      }));
    }
    queryCheckpoint('query_end');

    // 在查询结束前捕获 ant 专属 API 指标。
    // 对于多请求回合（工具使用循环），计算所有请求的 P50。
    if ("external" === 'ant' && apiMetricsRef.current.length > 0) {
      const entries = apiMetricsRef.current;
      const ttfts = entries.map(e => e.ttftMs);
      // 使用仅活动流式时间计算每个请求的 OTPS 和
      // 仅流式内容。endResponseLength 跟踪仅由
      // 流式 delta 添加的内容，排除子 agent/压缩膨胀。
      const otpsValues = entries.map(e => {
        const delta = Math.round((e.endResponseLength - e.responseLengthBaseline) / 4);
        const samplingMs = e.lastTokenTime - e.firstTokenTime;
        return samplingMs > 0 ? Math.round(delta / (samplingMs / 1000)) : 0;
      });
      const isMultiRequest = entries.length > 1;
      const hookMs = getTurnHookDurationMs();
      const hookCount = getTurnHookCount();
      const toolMs = getTurnToolDurationMs();
      const toolCount = getTurnToolCount();
      const classifierMs = getTurnClassifierDurationMs();
      const classifierCount = getTurnClassifierCount();
      const turnMs = Date.now() - loadingStartTimeRef.current;
      setMessages(prev => [...prev, createApiMetricsMessage({
        ttftMs: isMultiRequest ? median(ttfts) : ttfts[0]!,
        otps: isMultiRequest ? median(otpsValues) : otpsValues[0]!,
        isP50: isMultiRequest,
        hookDurationMs: hookMs > 0 ? hookMs : undefined,
        hookCount: hookCount > 0 ? hookCount : undefined,
        turnDurationMs: turnMs > 0 ? turnMs : undefined,
        toolDurationMs: toolMs > 0 ? toolMs : undefined,
        toolCount: toolCount > 0 ? toolCount : undefined,
        classifierDurationMs: classifierMs > 0 ? classifierMs : undefined,
        classifierCount: classifierCount > 0 ? classifierCount : undefined,
        configWriteCount: getGlobalConfigWriteCount()
      })]);
    }
    resetLoadingState();

    // 如果启用了查询分析则记录报告
    logQueryProfileReport();

    // 信号查询回合已成功完成
    await onTurnComplete?.(messagesRef.current);
  }, [initialMcpClients, resetLoadingState, getToolUseContext, toolPermissionContext, setAppState, customSystemPrompt, onTurnComplete, appendSystemPrompt, canUseTool, mainThreadAgentDefinition, onQueryEvent, sessionTitle, titleDisabled]);
  const onQuery = useCallback(async (newMessages: MessageType[], abortController: AbortController, shouldQuery: boolean, additionalAllowedTools: string[], mainLoopModelParam: string, onBeforeQueryCallback?: (input: string, newMessages: MessageType[]) => Promise<boolean>, input?: string, effort?: EffortValue): Promise<void> => {
    // 如果是 teammate，开始回合时标记他们为活动
    if (isAgentSwarmsEnabled()) {
      const teamName = getTeamName();
      const agentName = getAgentName();
      if (teamName && agentName) {
        // 发送后不管 - 回合立即启动，写入在后台发生
        void setMemberActive(teamName, agentName, true);
      }
    }

    // 通过状态机的并发守卫。tryStart() 原子检查
    // 并转换 idle→running，返回世代号。
    // 如果已在运行则返回 null — 无需单独的 check-then-set。
    const thisGeneration = queryGuard.tryStart();
    if (thisGeneration === null) {
      logEvent('tengu_concurrent_onquery_detected', {});

      // 提取用户消息文本并入队，跳过元消息
      // （例如扩展的 skill 内容、tick 提示）不应作为
      // 用户可见文本重放。
      newMessages.filter((m): m is UserMessage => m.type === 'user' && !m.isMeta).map(_ => getContentText(_.message.content)).filter(_ => _ !== null).forEach((msg, i) => {
        enqueue({
          value: msg,
          mode: 'prompt'
        });
        if (i === 0) {
          logEvent('tengu_concurrent_onquery_enqueued', {});
        }
      });
      return;
    }
    try {
      // isLoading 从 queryGuard 派生 — tryStart() 已经
      // 转换 dispatching→running，所以这里无需 setter 调用。
      resetTimingRefs();
      setMessages(oldMessages => [...oldMessages, ...newMessages]);
      responseLengthRef.current = 0;
      if (feature('TOKEN_BUDGET')) {
        const parsedBudget = input ? parseTokenBudget(input) : null;
        snapshotOutputTokensForTurn(parsedBudget ?? getCurrentTurnTokenBudget());
      }
      apiMetricsRef.current = [];
      setStreamingToolUses([]);
      setStreamingText(null);

      // messagesRef 由上面的 setMessages 包装器同步更新
      // 在此 try 块顶部的 append 处已经包括 newMessages。
      // 无需重建，无需等待
      // React 的调度器（之前每次提示花费 20-56ms；56ms
      // 的情况是 await 期间捕获的 GC 停顿）。
      const latestMessages = messagesRef.current;
      if (input) {
        await mrOnBeforeQuery(input, latestMessages, newMessages.length);
      }

      // 传递完整对话历史给回调
      if (onBeforeQueryCallback && input) {
        const shouldProceed = await onBeforeQueryCallback(input, latestMessages);
        if (!shouldProceed) {
          return;
        }
      }
      await onQueryImpl(latestMessages, newMessages, abortController, shouldQuery, additionalAllowedTools, mainLoopModelParam, effort);
    } finally {
      // queryGuard.end() 原子检查世代并转换
      // running→idle。如果新查询拥有 guard 则返回 false
      // （取消+重新提交竞争，过时的 finally 作为微任务触发）。
      if (queryGuard.end(thisGeneration)) {
        setLastQueryCompletionTime(Date.now());
        skipIdleCheckRef.current = false;
        // 始终在 finally 中重置 loading state - 这确保即使
        // onQueryImpl 抛出也进行清理。onTurnComplete 在
        // onQueryImpl 中仅在成功完成时单独调用。
        resetLoadingState();
        await mrOnTurnComplete(messagesRef.current, abortController.signal.aborted);

        // 通知 bridge 客户端回合已完成，以便移动应用
        // 可以停止火花动画并显示回合后 UI。
        sendBridgeResultRef.current();

        // 回合结束时自动隐藏 tungsten 面板内容（ant 专属），但保持
        // tungstenActiveSession 设置以便 pill 留在 footer 中且用户可以
        // 重新打开面板。后台 tmux 任务（例如 /hunter）运行
        // 数分钟 — 擦除会话使 pill 完全消失，强制
        // 用户重新调用 Tmux 只是为了查看。中止时跳过以便面板
        // 保持打开以供检查（匹配下面的回合持续时间守卫）。
        if ("external" === 'ant' && !abortController.signal.aborted) {
          setAppState(prev => {
            if (prev.tungstenActiveSession === undefined) return prev;
            if (prev.tungstenPanelAutoHidden === true) return prev;
            return {
              ...prev,
              tungstenPanelAutoHidden: true
            };
          });
        }

        // 清除前捕获预算信息（ant 专属）
        let budgetInfo: {
          tokens: number;
          limit: number;
          nudges: number;
        } | undefined;
        if (feature('TOKEN_BUDGET')) {
          if (getCurrentTurnTokenBudget() !== null && getCurrentTurnTokenBudget()! > 0 && !abortController.signal.aborted) {
            budgetInfo = {
              tokens: getTurnOutputTokens(),
              limit: getCurrentTurnTokenBudget()!,
              nudges: getBudgetContinuationCount()
            };
          }
          snapshotOutputTokensForTurn(null);
        }

        // 为超过 30 秒或有预算的回合添加回合持续时间消息
        // 如果用户中止或在 loop mode 中则跳过（tick 之间太吵）
        // 如果 swarm teammate 仍在运行则延迟（它们完成时显示）
        const turnDurationMs = Date.now() - loadingStartTimeRef.current - totalPausedMsRef.current;
        if ((turnDurationMs > 30000 || budgetInfo !== undefined) && !abortController.signal.aborted && !proactiveActive) {
          const hasRunningSwarmAgents = getAllInProcessTeammateTasks(store.getState().tasks).some(t => t.status === 'running');
          if (hasRunningSwarmAgents) {
            // 仅在第一次延迟回合记录开始时间
            if (swarmStartTimeRef.current === null) {
              swarmStartTimeRef.current = loadingStartTimeRef.current;
            }
            // 始终更新预算 — 后来的回合可能携带实际预算
            if (budgetInfo) {
              swarmBudgetInfoRef.current = budgetInfo;
            }
          } else {
            setMessages(prev => [...prev, createTurnDurationMessage(turnDurationMs, budgetInfo, count(prev, isLoggableMessage))]);
          }
        }
        // 清除 controller 以便 CancelRequestHandler 的 canCancelRunningTask
        // 读取空闲提示时为 false。没有这个，过时非中止
        // controller 使 ctrl+c 触发 onCancel()（中止无）而不是
        // 传播到双次按下退出流程。
        setAbortController(null);
      }

      // 自动恢复：如果用户在任何有意义响应之前中断，
      // 回退对话并恢复他们的提示 — 与
      // 打开消息选择器并选择最后一条消息相同。
      // 这在 queryGuard.end() 检查之外运行，因为 onCancel 调用
      // forceEnd()，它会提升世代使上面的 end() 返回 false。
      // 守卫：reason === 'user-cancel'（onCancel/Esc；程序化中止
      // 使用 'background'/'interrupt' 不得回退 — 注意 abort() 无
      // 参数设置 reason 为 DOMException，不是 undefined），!isActive（没有
      // 新查询启动 — 取消+重新提交竞争），空输入（不要
      // 覆盖加载期间输入的文本），无排队命令（用户在 A 加载时排队
      // B — 他们已继续，不要恢复 A；也
      // 避免 removeLastFromHistory 移除 B 的条目而不是 A 的），
      // 不在查看 teammate（messagesRef 是主对话 —
      // 旧的 Up-arrow 快速恢复有这个守卫，保留它）。
      if (abortController.signal.reason === 'user-cancel' && !queryGuard.isActive && inputValueRef.current === '' && getCommandQueueLength() === 0 && !store.getState().viewingAgentTaskId) {
        const msgs = messagesRef.current;
        const lastUserMsg = msgs.findLast(selectableUserMessagesFilter);
        if (lastUserMsg) {
          const idx = msgs.lastIndexOf(lastUserMsg);
          if (messagesAfterAreOnlySynthetic(msgs, idx)) {
            // 提交正在被撤销 — 也撤销其历史条目，
            // 否则 Up-arrow 会显示恢复文本两次。
            removeLastFromHistory();
            restoreMessageSyncRef.current(lastUserMsg);
          }
        }
      }
    }
  }, [onQueryImpl, setAppState, resetLoadingState, queryGuard, mrOnBeforeQuery, mrOnTurnComplete]);

  // 处理初始消息（来自 CLI 参数或带上下文清除的 plan mode 退出）
  // 当 isLoading 变为 false 且有待处理消息时此 effect 运行
  const initialMessageRef = useRef(false);
  useEffect(() => {
    const pending = initialMessage;
    if (!pending || isLoading || initialMessageRef.current) return;

    // 标记为处理中以防止重入
    initialMessageRef.current = true;
    async function processInitialMessage(initialMsg: NonNullable<typeof pending>) {
      // 如果请求则清除上下文（plan mode 退出）
      if (initialMsg.clearContext) {
        // 清除上下文之前保留 plan slug，以便新会话
        // 可以在 regenerateSessionId() 后访问相同的 plan 文件
        const oldPlanSlug = initialMsg.message.planContent ? getPlanSlug() : undefined;
        const {
          clearConversation
        } = await import('../commands/clear/conversation.js');
        await clearConversation({
          setMessages,
          readFileState: readFileState.current,
          discoveredSkillNames: discoveredSkillNamesRef.current,
          loadedNestedMemoryPaths: loadedNestedMemoryPathsRef.current,
          getAppState: () => store.getState(),
          setAppState,
          setConversationId
        });
        haikuTitleAttemptedRef.current = false;
        setHaikuTitle(undefined);
        bashTools.current.clear();
        bashToolsProcessedIdx.current = 0;

        // 恢复新会话的 plan slug 以便 getPlan() 找到文件
        if (oldPlanSlug) {
          setPlanSlug(getSessionId(), oldPlanSlug);
        }
      }

      // 原子操作：清除初始消息，设置权限模式和规则，并存储 plan 用于验证
      const shouldStorePlanForVerification = initialMsg.message.planContent && "external" === 'ant' && isEnvTruthy(undefined);
      setAppState(prev => {
        // 构建并应用权限更新（模式 + allowedPrompts 规则）
        let updatedToolPermissionContext = initialMsg.mode ? applyPermissionUpdates(prev.toolPermissionContext, buildPermissionUpdates(initialMsg.mode, initialMsg.allowedPrompts)) : prev.toolPermissionContext;
        // 对于 auto，覆盖模式（buildPermissionUpdates 映射
        // 它到 'default' 通过 toExternalPermissionMode）并剥离危险规则
        if (feature('TRANSCRIPT_CLASSIFIER') && initialMsg.mode === 'auto') {
          updatedToolPermissionContext = stripDangerousPermissionsForAutoMode({
            ...updatedToolPermissionContext,
            mode: 'auto',
            prePlanMode: undefined
          });
        }
        return {
          ...prev,
          initialMessage: null,
          toolPermissionContext: updatedToolPermissionContext,
          ...(shouldStorePlanForVerification && {
            pendingPlanVerification: {
              plan: initialMsg.message.planContent!,
              verificationStarted: false,
              verificationCompleted: false
            }
          })
        };
      });

      // 创建文件历史快照用于代码回退
      if (fileHistoryEnabled()) {
        void fileHistoryMakeSnapshot((updater: (prev: FileHistoryState) => FileHistoryState) => {
          setAppState(prev => ({
            ...prev,
            fileHistory: updater(prev.fileHistory)
          }));
        }, initialMsg.message.uuid);
      }

      // 确保 SessionStart hook 上下文在第一次 API
      // 调用之前可用。onSubmit 在内部调用此但下面的 onQuery 路径
      // 绕过 onSubmit — 在此提升以便两条路径都看到 hook 消息。
      await awaitPendingHooks();

      // 将所有初始提示通过 onSubmit 路由以确保 UserPromptSubmit hooks 触发
      // TODO: 一旦它支持 ContentBlockParam 数组（图像）作为输入，简化为始终通过 onSubmit 路由
      const content = initialMsg.message.message.content;

      // 通过 onSubmit 路由所有字符串内容以确保 hooks 触发
      // 对于复杂内容（图像等），回退到直接 onQuery
      // Plan 消息绕过 onSubmit 以保留 planContent 元数据用于渲染
      if (typeof content === 'string' && !initialMsg.message.planContent) {
        // 通过 onSubmit 路由以进行正确处理，包括 UserPromptSubmit hooks
        void onSubmit(content, {
          setCursorOffset: () => {},
          clearBuffer: () => {},
          resetHistory: () => {}
        });
      } else {
        // Plan 消息或复杂内容（图像等）- 直接发送到模型
        // Plan 消息使用 onQuery 以保留 planContent 元数据用于渲染
        // TODO: 一旦 onSubmit 支持 ContentBlockParam 数组，移除此分支
        const newAbortController = createAbortController();
        setAbortController(newAbortController);
        void onQuery([initialMsg.message], newAbortController, true,
        // shouldQuery
        [],
        // additionalAllowedTools
        mainLoopModel);
      }

      // 延迟后重置 ref 以允许新初始消息
      setTimeout(ref => {
        ref.current = false;
      }, 100, initialMessageRef);
    }
    void processInitialMessage(pending);
  }, [initialMessage, isLoading, setMessages, setAppState, onQuery, mainLoopModel, tools]);
  const onSubmit = useCallback(async (input: string, helpers: PromptInputHelpers, speculationAccept?: {
    state: ActiveSpeculationState;
    speculationSessionTimeSavedMs: number;
    setAppState: SetAppState;
  }, options?: {
    fromKeybinding?: boolean;
  }) => {
    // 提交时重新固定滚动到底部，以便用户始终看到新的
    // 交互（匹配 OpenCode 的自动滚动行为）。
    repinScroll();

    // 如果暂停则恢复 loop mode
    if (feature('PROACTIVE') || feature('KAIROS')) {
      proactiveModule?.resumeProactive();
    }

    // 处理即时命令 - 这些绕过队列并立即执行
    // 即使在 Zy 处理时。命令通过 `immediate: true` 选择加入。
    // 通过键绑定触发的命令始终被视为即时命令。
    if (!speculationAccept && input.trim().startsWith('/')) {
      // 展开 [Pasted text #N] 引用以便即时命令（例如 /btw）接收
      // 粘贴内容，而不是占位符。非即时路径稍后在 handlePromptSubmit 中获得此扩展。
      const trimmedInput = expandPastedTextRefs(input, pastedContents).trim();
      const spaceIndex = trimmedInput.indexOf(' ');
      const commandName = spaceIndex === -1 ? trimmedInput.slice(1) : trimmedInput.slice(1, spaceIndex);
      const commandArgs = spaceIndex === -1 ? '' : trimmedInput.slice(spaceIndex + 1).trim();

      // 查找匹配命令 - 如果满足以下条件则视为即时：
      // 1. 命令有 `immediate: true`，或
      // 2. 命令通过键绑定触发（fromKeybinding 选项）
      const matchingCommand = commands.find(cmd => isCommandEnabled(cmd) && (cmd.name === commandName || cmd.aliases?.includes(commandName) || getCommandName(cmd) === commandName));
      if (matchingCommand?.name === 'clear' && idleHintShownRef.current) {
        logEvent('tengu_idle_return_action', {
          action: 'hint_converted' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          variant: idleHintShownRef.current as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          idleMinutes: Math.round((Date.now() - lastQueryCompletionTimeRef.current) / 60_000),
          messageCount: messagesRef.current.length,
          totalInputTokens: getTotalInputTokens()
        });
        idleHintShownRef.current = false;
      }
      const shouldTreatAsImmediate = queryGuard.isActive && (matchingCommand?.immediate || options?.fromKeybinding);
      if (matchingCommand && shouldTreatAsImmediate && matchingCommand.type === 'local-jsx') {
        // 仅在提交的文本与提示中的内容匹配时清除输入。
        // 当命令键绑定触发时，输入是 "/<command>" 但实际
        // 输入值是用户现有文本 - 在这种情况下不要清除它。
        if (input.trim() === inputValueRef.current.trim()) {
          setInputValue('');
          helpers.setCursorOffset(0);
          helpers.clearBuffer();
          setPastedContents({});
        }
        const pastedTextRefs = parseReferences(input).filter(r => pastedContents[r.id]?.type === 'text');
        const pastedTextCount = pastedTextRefs.length;
        const pastedTextBytes = pastedTextRefs.reduce((sum, r) => sum + (pastedContents[r.id]?.content.length ?? 0), 0);
        logEvent('tengu_paste_text', {
          pastedTextCount,
          pastedTextBytes
        });
        logEvent('tengu_immediate_command_executed', {
          commandName: matchingCommand.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fromKeybinding: options?.fromKeybinding ?? false
        });

        // 直接执行命令
        const executeImmediateCommand = async (): Promise<void> => {
          let doneWasCalled = false;
          const onDone = (result?: string, doneOptions?: {
            display?: CommandResultDisplay;
            metaMessages?: string[];
          }): void => {
            doneWasCalled = true;
            setToolJSX({
              jsx: null,
              shouldHidePromptInput: false,
              clearLocalJSX: true
            });
            const newMessages: MessageType[] = [];
            if (result && doneOptions?.display !== 'skip') {
              addNotification({
                key: `immediate-${matchingCommand.name}`,
                text: result,
                priority: 'immediate'
              });
              // 全屏中命令仅作为居中模态
              // 面板显示 — 上面的通知已足够反馈。添加
              // "❯ /config" + "⎿ dismissed" 到转录是杂乱
              // （这些消息是 type:system subtype:local_command —
              // 用户可见但不发送给模型，所以跳过它们
              // 不会改变模型上下文）。全屏外转录
              // 条目保留以便 scrollback 显示运行的内容。
              if (!isFullscreenEnvEnabled()) {
                newMessages.push(createCommandInputMessage(formatCommandInputTags(getCommandName(matchingCommand), commandArgs)), createCommandInputMessage(`<${LOCAL_COMMAND_STDOUT_TAG}>${escapeXml(result)}</${LOCAL_COMMAND_STDOUT_TAG}>`));
              }
            }
            // 将元消息（模型可见，用户隐藏）注入转录
            if (doneOptions?.metaMessages?.length) {
              newMessages.push(...doneOptions.metaMessages.map(content => createUserMessage({
                content,
                isMeta: true
              })));
            }
            if (newMessages.length) {
              setMessages(prev => [...prev, ...newMessages]);
            }
            // 本地 jsx 命令完成后恢复隐藏提示。
            // 正常的 stash 恢复路径（下面）被跳过因为
            // 本地 jsx 命令从 onSubmit 提前返回。
            if (stashedPrompt !== undefined) {
              setInputValue(stashedPrompt.text);
              helpers.setCursorOffset(stashedPrompt.cursorOffset);
              setPastedContents(stashedPrompt.pastedContents);
              setStashedPrompt(undefined);
            }
          };

          // 为命令构建上下文（重用现有 getToolUseContext）。
          // 通过 ref 读取消息以保持 onSubmit 在消息
          // 更新时稳定 — 匹配 L2384/L2400/L2662 的模式并避免
          // 在下游闭包中固定过时 REPL 渲染范围。
          const context = getToolUseContext(messagesRef.current, [], createAbortController(), mainLoopModel);
          const mod = await matchingCommand.load();
          const jsx = await mod.call(onDone, context, commandArgs);

          // 如果 onDone 已经触发则跳过 — 防止卡住的 isLocalJSXCommand
          // （完整机制参见 processSlashCommand.tsx local-jsx 情况）。
          if (jsx && !doneWasCalled) {
            // shouldHidePromptInput: false 保持 Notifications 挂载
            // 以便 onDone 结果不会丢失
            setToolJSX({
              jsx,
              shouldHidePromptInput: false,
              isLocalJSXCommand: true
            });
          }
        };
        void executeImmediateCommand();
        return; // 始终提前返回 - 不添加到历史或队列
      }
    }

    // 远程模式：在任何状态变更之前尽早跳过空输入
    if (activeRemote.isRemoteMode && !input.trim()) {
      return;
    }

    // 空闲返回：当对话很大且缓存冷时提示用户重新开始。
    // tengu_willow_mode 控制处理："dialog"（阻塞），"hint"（通知），"off"。
    {
      const willowMode = getFeatureValue_CACHED_MAY_BE_STALE('tengu_willow_mode', 'off');
      const idleThresholdMin = Number(process.env.ZY_CODE_IDLE_THRESHOLD_MINUTES ?? 75);
      const tokenThreshold = Number(process.env.ZY_CODE_IDLE_TOKEN_THRESHOLD ?? 100_000);
      if (willowMode !== 'off' && !getGlobalConfig().idleReturnDismissed && !skipIdleCheckRef.current && !speculationAccept && !input.trim().startsWith('/') && lastQueryCompletionTimeRef.current > 0 && getTotalInputTokens() >= tokenThreshold) {
        const idleMs = Date.now() - lastQueryCompletionTimeRef.current;
        const idleMinutes = idleMs / 60_000;
        if (idleMinutes >= idleThresholdMin && willowMode === 'dialog') {
          setIdleReturnPending({
            input,
            idleMinutes
          });
          setInputValue('');
          helpers.setCursorOffset(0);
          helpers.clearBuffer();
          return;
        }
      }
    }

    // 直接用户提交添加到历史。
    // 排队命令处理（executeQueuedInput）不调用 onSubmit，
    // 所以通知和已排队的用户输入不会在此添加到历史。
    // 跳过键绑定触发的命令的历史（用户没有输入命令）。
    if (!options?.fromKeybinding) {
      addToHistory({
        display: speculationAccept ? input : prependModeCharacterToInput(input, inputMode),
        pastedContents: speculationAccept ? {} : pastedContents
      });
      // 将刚刚提交的命令添加到 ghost-text 的前面
      // 缓存以便它立即被建议（而不是等待 60s TTL）。
      if (inputMode === 'bash') {
        prependToShellHistoryCache(input.trim());
      }
    }

    // 如果存在则恢复 stash，但不适用于斜杠命令或加载时。
    // - 斜杠命令（尤其是交互式如 /model, /context）隐藏
    //   提示符并显示选择器 UI。在命令期间恢复 stash 会将
    //   文本放在隐藏输入中，用户会在输入下一个命令时丢失它。
    //   相反，保留 stash 以便它跨命令运行存活。
    // - 加载时，提交的输入将被排队且 handlePromptSubmit
    //   将清除输入字段（onInputChange('')），这将覆盖
    //   恢复的 stash。延迟恢复到 handlePromptSubmit 之后（下面）。
    //   远程模式例外：它通过 WebSocket 发送并提前返回而不
    //   调用 handlePromptSubmit，所以没有覆盖风险 — 急切恢复。
    // 在两种延迟情况下，stash 在 await handlePromptSubmit 后恢复。
    const isSlashCommand = !speculationAccept && input.trim().startsWith('/');
    // 未排队时（非加载中），或接受推测时，或远程模式下提交（通过 WS 发送并
    // 提前返回而不调用 handlePromptSubmit）。
    const submitsNow = !isLoading || speculationAccept || activeRemote.isRemoteMode;
    if (stashedPrompt !== undefined && !isSlashCommand && submitsNow) {
      setInputValue(stashedPrompt.text);
      helpers.setCursorOffset(stashedPrompt.cursorOffset);
      setPastedContents(stashedPrompt.pastedContents);
      setStashedPrompt(undefined);
    } else if (submitsNow) {
      if (!options?.fromKeybinding) {
        // 未加载或接受推测时清除输入。
        // 为键绑定触发的命令保留输入。
        setInputValue('');
        helpers.setCursorOffset(0);
      }
      setPastedContents({});
    }
    if (submitsNow) {
      setInputMode('prompt');
      setIDESelection(undefined);
      setSubmitCount(_ => _ + 1);
      helpers.clearBuffer();
      tipPickedThisTurnRef.current = false;

      // 与 setInputValue('') 在同一 React 批处理中显示占位符。
      // 跳过斜杠/bash（它们有自己的回显）、推测和远程
      // 模式（都直接 setMessages 没有间隙来桥接）。
      if (!isSlashCommand && inputMode === 'prompt' && !speculationAccept && !activeRemote.isRemoteMode) {
        setUserInputOnProcessing(input);
        // showSpinner 包括 userInputOnProcessing，所以 spinner 出现在
        // 此渲染上。现在重置计时 refs（在 queryGuard.reserve()
        // 之前）以便已过时间不会读作 Date.now() - 0。上面的
        // isQueryActive 转换做相同的重置 — 幂等。
        resetTimingRefs();
      }

      // Increment prompt count for attribution tracking and save snapshot
      // The snapshot persists promptCount so it survives compaction
      if (feature('COMMIT_ATTRIBUTION')) {
        setAppState(prev => ({
          ...prev,
          attribution: incrementPromptCount(prev.attribution, snapshot => {
            void recordAttributionSnapshot(snapshot).catch(error => {
              logForDebugging(`Attribution: Failed to save snapshot: ${error}`);
            });
          })
        }));
      }
    }

    // 处理推测接受
    if (speculationAccept) {
      const {
        queryRequired
      } = await handleSpeculationAccept(speculationAccept.state, speculationAccept.speculationSessionTimeSavedMs, speculationAccept.setAppState, input, {
        setMessages,
        readFileState,
        cwd: getOriginalCwd()
      });
      if (queryRequired) {
        const newAbortController = createAbortController();
        setAbortController(newAbortController);
        void onQuery([], newAbortController, true, [], mainLoopModel);
      }
      return;
    }

    // 远程模式：通过 stream-json 发送输入而不是本地查询。
    // 来自远程的权限请求桥接到 toolUseConfirmQueue
    // 并使用标准 PermissionRequest 组件渲染。
    //
    // 本地 jsx 斜杠命令（例如 /agents, /config）在本地进程中渲染 UI —
    // 它们没有远程等效物。让它们回退到
    // handlePromptSubmit 以便在本地执行。提示命令和
    // 纯文本转到远程。
    if (activeRemote.isRemoteMode && !(isSlashCommand && commands.find(c => {
      const name = input.trim().slice(1).split(/\s/)[0];
      return isCommandEnabled(c) && (c.name === name || c.aliases?.includes(name!) || getCommandName(c) === name);
    })?.type === 'local-jsx')) {
      // 当有粘贴附件（图像）时构建内容块
      const pastedValues = Object.values(pastedContents);
      const imageContents = pastedValues.filter(c => c.type === 'image');
      const imagePasteIds = imageContents.length > 0 ? imageContents.map(c => c.id) : undefined;
      let messageContent: string | ContentBlockParam[] = input.trim();
      let remoteContent: RemoteMessageContent = input.trim();
      if (pastedValues.length > 0) {
        const contentBlocks: ContentBlockParam[] = [];
        const remoteBlocks: Array<{
          type: string;
          [key: string]: unknown;
        }> = [];
        const trimmedInput = input.trim();
        if (trimmedInput) {
          contentBlocks.push({
            type: 'text',
            text: trimmedInput
          });
          remoteBlocks.push({
            type: 'text',
            text: trimmedInput
          });
        }
        for (const pasted of pastedValues) {
          if (pasted.type === 'image') {
            const source = {
              type: 'base64' as const,
              media_type: (pasted.mediaType ?? 'image/png') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: pasted.content
            };
            contentBlocks.push({
              type: 'image',
              source
            });
            remoteBlocks.push({
              type: 'image',
              source
            });
          } else {
            contentBlocks.push({
              type: 'text',
              text: pasted.content
            });
            remoteBlocks.push({
              type: 'text',
              text: pasted.content
            });
          }
        }
        messageContent = contentBlocks;
        remoteContent = remoteBlocks;
      }

      // 创建并添加用户消息到 UI
      // 注意：空输入已由上面的提前返回处理
      const userMessage = createUserMessage({
        content: messageContent,
        imagePasteIds
      });
      setMessages(prev => [...prev, userMessage]);

      // 发送到远程会话
      await activeRemote.sendMessage(remoteContent, {
        uuid: userMessage.uuid
      });
      return;
    }

    // 确保 SessionStart hook 上下文在第一次 API 调用之前可用。
    await awaitPendingHooks();
    await handlePromptSubmit({
      input,
      helpers,
      queryGuard,
      isExternalLoading,
      mode: inputMode,
      commands,
      onInputChange: setInputValue,
      setPastedContents,
      setToolJSX,
      getToolUseContext,
      messages: messagesRef.current,
      mainLoopModel,
      pastedContents,
      ideSelection,
      setUserInputOnProcessing,
      setAbortController,
      abortController,
      onQuery,
      setAppState,
      querySource: getQuerySourceForREPL(),
      onBeforeQuery,
      canUseTool,
      addNotification,
      setMessages,
      // 通过 ref 读取 streamMode 以便从 onSubmit 依赖中删除 —
      // handlePromptSubmit 仅将其用于调试日志 + 遥测事件。
      streamMode: streamModeRef.current,
      hasInterruptibleToolInProgress: hasInterruptibleToolInProgressRef.current
    });

    // 恢复上面延迟的 stash。两种情况：
    // - 斜杠命令：handlePromptSubmit 等待完整命令执行
    //   （包括交互式选择器）。现在恢复将 stash 放回
    //   可见输入中。
    // - 加载（排队）：handlePromptSubmit 入队 + 清除输入，然后
    //   快速返回。现在恢复将 stash 放回清除之后。
    if ((isSlashCommand || isLoading) && stashedPrompt !== undefined) {
      setInputValue(stashedPrompt.text);
      helpers.setCursorOffset(stashedPrompt.cursorOffset);
      setPastedContents(stashedPrompt.pastedContents);
      setStashedPrompt(undefined);
    }
  }, [queryGuard,
  // isLoading 在上面的 !isLoading 检查中读取用于输入清除
  // 和 submitCount 门控。它从 isQueryActive || isExternalLoading 派生，
  // 所以包含在此确保闭包捕获新鲜值。
  isLoading, isExternalLoading, inputMode, commands, setInputValue, setInputMode, setPastedContents, setSubmitCount, setIDESelection, setToolJSX, getToolUseContext,
  // messages 在回调中通过 messagesRef.current 读取以
  // 保持 onSubmit 在消息更新时稳定（见 L2384/L2400/L2662）。
  // 没有这个，每次 setMessages 调用（每回合约 30 次）重新创建
  // onSubmit，固定 REPL 渲染范围（1776B）+ 该渲染的
  // messages 数组在下游闭包中（PromptInput, handleAutoRunIssue）。
  // 堆分析显示 #20174/#20175 之后约 9 个 REPL 范围和约 15 个 messages 数组版本
  // 累积，全部追溯到此依赖。
  mainLoopModel, pastedContents, ideSelection, setUserInputOnProcessing, setAbortController, addNotification, onQuery, stashedPrompt, setStashedPrompt, setAppState, onBeforeQuery, canUseTool, remoteSession, setMessages, awaitPendingHooks, repinScroll]);

  // Callback for when user submits input while viewing a teammate's transcript
  const onAgentSubmit = useCallback(async (input: string, task: InProcessTeammateTaskState | LocalAgentTaskState, helpers: PromptInputHelpers) => {
    if (isLocalAgentTask(task)) {
      appendMessageToLocalAgent(task.id, createUserMessage({
        content: input
      }), setAppState);
      if (task.status === 'running') {
        queuePendingMessage(task.id, input, setAppState);
      } else {
        void resumeAgentBackground({
          agentId: task.id,
          prompt: input,
          toolUseContext: getToolUseContext(messagesRef.current, [], new AbortController(), mainLoopModel),
          canUseTool
        }).catch(err => {
          logForDebugging(`resumeAgentBackground failed: ${errorMessage(err)}`);
          addNotification({
            key: `resume-agent-failed-${task.id}`,
            jsx: <Text color="error">
                  Failed to resume agent: {errorMessage(err)}
                </Text>,
            priority: 'low'
          });
        });
      }
    } else {
      injectUserMessageToTeammate(task.id, input, setAppState);
    }
    setInputValue('');
    helpers.setCursorOffset(0);
    helpers.clearBuffer();
  }, [setAppState, setInputValue, getToolUseContext, canUseTool, mainLoopModel, addNotification]);

  // Handlers for auto-run /issue or /good-zy (defined after onSubmit)
  const handleAutoRunIssue = useCallback(() => {
    const command = autoRunIssueReason ? getAutoRunCommand(autoRunIssueReason) : '/issue';
    setAutoRunIssueReason(null); // Clear the state
    onSubmit(command, {
      setCursorOffset: () => {},
      clearBuffer: () => {},
      resetHistory: () => {}
    }).catch(err => {
      logForDebugging(`Auto-run ${command} failed: ${errorMessage(err)}`);
    });
  }, [onSubmit, autoRunIssueReason]);
  const handleCancelAutoRunIssue = useCallback(() => {
    setAutoRunIssueReason(null);
  }, []);

  // Handler for when user presses 1 on survey thanks screen to share details
  const handleSurveyRequestFeedback = useCallback(() => {
    const command = "external" === 'ant' ? '/issue' : '/feedback';
    onSubmit(command, {
      setCursorOffset: () => {},
      clearBuffer: () => {},
      resetHistory: () => {}
    }).catch(err => {
      logForDebugging(`Survey feedback request failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, [onSubmit]);

  // onSubmit is unstable (deps include `messages` which changes every turn).
  // `handleOpenRateLimitOptions` is prop-drilled to every MessageRow, and each
  // MessageRow fiber pins the closure (and transitively the entire REPL render
  // scope, ~1.8KB) at mount time. Using a ref keeps this callback stable so
  // old REPL scopes can be GC'd — saves ~35MB over a 1000-turn session.
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const handleOpenRateLimitOptions = useCallback(() => {
    void onSubmitRef.current('/rate-limit-options', {
      setCursorOffset: () => {},
      clearBuffer: () => {},
      resetHistory: () => {}
    });
  }, []);
  const handleExit = useCallback(async () => {
    setIsExiting(true);
    // In bg sessions, always detach instead of kill — even when a worktree is
    // active. Without this guard, the worktree branch below short-circuits into
    // ExitFlow (which calls gracefulShutdown) before exit.tsx is ever loaded.
    if (feature('BG_SESSIONS') && isBgSession()) {
      spawnSync('tmux', ['detach-client'], {
        stdio: 'ignore'
      });
      setIsExiting(false);
      return;
    }
    const showWorktree = getCurrentWorktreeSession() !== null;
    if (showWorktree) {
      setExitFlow(<ExitFlow showWorktree onDone={() => {}} onCancel={() => {
        setExitFlow(null);
        setIsExiting(false);
      }} />);
      return;
    }
    const exitMod = await exit.load();
    const exitFlowResult = await exitMod.call(() => {});
    setExitFlow(exitFlowResult);
    // If call() returned without killing the process (bg session detach),
    // clear isExiting so the UI is usable on reattach. No-op on the normal
    // path — gracefulShutdown's process.exit() means we never get here.
    if (exitFlowResult === null) {
      setIsExiting(false);
    }
  }, []);
  const handleShowMessageSelector = useCallback(() => {
    setIsMessageSelectorVisible(prev => !prev);
  }, []);

  // Rewind conversation state to just before `message`: slice messages,
  // reset conversation ID, microcompact state, permission mode, prompt suggestion.
  // Does NOT touch the prompt input. Index is computed from messagesRef (always
  // fresh via the setMessages wrapper) so callers don't need to worry about
  // stale closures.
  const rewindConversationTo = useCallback((message: UserMessage) => {
    const prev = messagesRef.current;
    const messageIndex = prev.lastIndexOf(message);
    if (messageIndex === -1) return;
    logEvent('tengu_conversation_rewind', {
      preRewindMessageCount: prev.length,
      postRewindMessageCount: messageIndex,
      messagesRemoved: prev.length - messageIndex,
      rewindToMessageIndex: messageIndex
    });
    setMessages(prev.slice(0, messageIndex));
    // Careful, this has to happen after setMessages
    setConversationId(randomUUID());
    // Reset cached microcompact state so stale pinned cache edits
    // don't reference tool_use_ids from truncated messages
    resetMicrocompactState();
    if (feature('CONTEXT_COLLAPSE')) {
      // Rewind truncates the REPL array. Commits whose archived span
      // was past the rewind point can't be projected anymore
      // (projectView silently skips them) but the staged queue and ID
      // maps reference stale uuids. Simplest safe reset: drop
      // everything. The ctx-agent will re-stage on the next
      // threshold crossing.
      /* eslint-disable @typescript-eslint/no-require-imports */

      (require('../services/contextCollapse/index.js') as typeof import('../services/contextCollapse/index.js')).resetContextCollapse();
      /* eslint-enable @typescript-eslint/no-require-imports */
    }

    // Restore state from the message we're rewinding to
    setAppState(prev => ({
      ...prev,
      // Restore permission mode from the message
      toolPermissionContext: message.permissionMode && prev.toolPermissionContext.mode !== message.permissionMode ? {
        ...prev.toolPermissionContext,
        mode: message.permissionMode
      } : prev.toolPermissionContext,
      // Clear stale prompt suggestion from previous conversation state
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null
      }
    }));
  }, [setMessages, setAppState]);

  // Synchronous rewind + input population. Used directly by auto-restore on
  // interrupt (so React batches with the abort's setMessages → single render,
  // no flicker). MessageSelector wraps this in setImmediate via handleRestoreMessage.
  const restoreMessageSync = useCallback((message: UserMessage) => {
    rewindConversationTo(message);
    const r = textForResubmit(message);
    if (r) {
      setInputValue(r.text);
      setInputMode(r.mode);
    }

    // Restore pasted images
    if (Array.isArray(message.message.content) && message.message.content.some(block => block.type === 'image')) {
      const imageBlocks: Array<ImageBlockParam> = message.message.content.filter(block => block.type === 'image');
      if (imageBlocks.length > 0) {
        const newPastedContents: Record<number, PastedContent> = {};
        imageBlocks.forEach((block, index) => {
          if (block.source.type === 'base64') {
            const id = message.imagePasteIds?.[index] ?? index + 1;
            newPastedContents[id] = {
              id,
              type: 'image',
              content: block.source.data,
              mediaType: block.source.media_type
            };
          }
        });
        setPastedContents(newPastedContents);
      }
    }
  }, [rewindConversationTo, setInputValue]);
  restoreMessageSyncRef.current = restoreMessageSync;

  // MessageSelector path: defer via setImmediate so the "Interrupted" message
  // renders to static output before rewind — otherwise it remains vestigial
  // at the top of the screen.
  const handleRestoreMessage = useCallback(async (message: UserMessage) => {
    setImmediate((restore, message) => restore(message), restoreMessageSync, message);
  }, [restoreMessageSync]);

  // Not memoized — hook stores caps via ref, reads latest closure at dispatch.
  // 24-char prefix: deriveUUID preserves first 24, renderable uuid prefix-matches raw source.
  const findRawIndex = (uuid: string) => {
    const prefix = uuid.slice(0, 24);
    return messages.findIndex(m => m.uuid.slice(0, 24) === prefix);
  };
  const messageActionCaps: MessageActionCaps = {
    copy: text =>
    // setClipboard RETURNS OSC 52 — caller must stdout.write (tmux side-effects load-buffer, but that's tmux-only).
    void setClipboard(text).then(raw => {
      if (raw) process.stdout.write(raw);
      addNotification({
        // Same key as text-selection copy — repeated copies replace toast, don't queue.
        key: 'selection-copied',
        text: 'copied',
        color: 'success',
        priority: 'immediate',
        timeoutMs: 2000
      });
    }),
    edit: async msg => {
      // Same skip-confirm check as /rewind: lossless → direct, else confirm dialog.
      const rawIdx = findRawIndex(msg.uuid);
      const raw = rawIdx >= 0 ? messages[rawIdx] : undefined;
      if (!raw || !selectableUserMessagesFilter(raw)) return;
      const noFileChanges = !(await fileHistoryHasAnyChanges(fileHistory, raw.uuid));
      const onlySynthetic = messagesAfterAreOnlySynthetic(messages, rawIdx);
      if (noFileChanges && onlySynthetic) {
        // rewindConversationTo's setMessages races stream appends — cancel first (idempotent).
        onCancel();
        // handleRestoreMessage also restores pasted images.
        void handleRestoreMessage(raw);
      } else {
        // Dialog path: onPreRestore (= onCancel) fires when user CONFIRMS, not on nevermind.
        setMessageSelectorPreselect(raw);
        setIsMessageSelectorVisible(true);
      }
    }
  };
  const {
    enter: enterMessageActions,
    handlers: messageActionHandlers
  } = useMessageActions(cursor, setCursor, cursorNavRef, messageActionCaps);
  async function onInit() {
    // Always verify API key on startup, so we can show the user an error in the
    // bottom right corner of the screen if the API key is invalid.
    void reverify();

    // Populate readFileState with CLAUDE.md files at startup
    const memoryFiles = await getMemoryFiles();
    if (memoryFiles.length > 0) {
      const fileList = memoryFiles.map(f => `  [${f.type}] ${f.path} (${f.content.length} chars)${f.parent ? ` (included by ${f.parent})` : ''}`).join('\n');
      logForDebugging(`Loaded ${memoryFiles.length} CLAUDE.md/rules files:\n${fileList}`);
    } else {
      logForDebugging('No CLAUDE.md/rules files found');
    }
    for (const file of memoryFiles) {
      // When the injected content doesn't match disk (stripped HTML comments,
      // stripped frontmatter, MEMORY.md truncation), cache the RAW disk bytes
      // with isPartialView so Edit/Write require a real Read first while
      // getChangedFiles + nested_memory dedup still work.
      readFileState.current.set(file.path, {
        content: file.contentDiffersFromDisk ? file.rawContent ?? file.content : file.content,
        timestamp: Date.now(),
        offset: undefined,
        limit: undefined,
        isPartialView: file.contentDiffersFromDisk
      });
    }

    // Initial message handling is done via the initialMessage effect
  }

  // Register cost summary tracker
  useCostSummary(useFpsMetrics());

  // Record transcripts locally, for debugging and conversation recovery
  // Don't record conversation if we only have initial messages; optimizes
  // the case where user resumes a conversation then quites before doing
  // anything else
  useLogMessages(messages, messages.length === initialMessages?.length);

  // REPL Bridge: replicate user/assistant messages to the bridge session
  // for remote access via zy.ai. No-op in external builds or when not enabled.
  const {
    sendBridgeResult
  } = useReplBridge(messages, setMessages, abortControllerRef, commands, mainLoopModel);
  sendBridgeResultRef.current = sendBridgeResult;
  useAfterFirstRender();

  // Track prompt queue usage for analytics. Fire once per transition from
  // empty to non-empty, not on every length change -- otherwise a render loop
  // (concurrent onQuery thrashing, etc.) spams saveGlobalConfig, which hits
  // ELOCKED under concurrent sessions and falls back to unlocked writes.
  // That write storm is the primary trigger for ~/.zy.json corruption
  // (GH #3117).
  const hasCountedQueueUseRef = useRef(false);
  useEffect(() => {
    if (queuedCommands.length < 1) {
      hasCountedQueueUseRef.current = false;
      return;
    }
    if (hasCountedQueueUseRef.current) return;
    hasCountedQueueUseRef.current = true;
    saveGlobalConfig(current => ({
      ...current,
      promptQueueUseCount: (current.promptQueueUseCount ?? 0) + 1
    }));
  }, [queuedCommands.length]);

  // Process queued commands when query completes and queue has items

  const executeQueuedInput = useCallback(async (queuedCommands: QueuedCommand[]) => {
    await handlePromptSubmit({
      helpers: {
        setCursorOffset: () => {},
        clearBuffer: () => {},
        resetHistory: () => {}
      },
      queryGuard,
      commands,
      onInputChange: () => {},
      setPastedContents: () => {},
      setToolJSX,
      getToolUseContext,
      messages,
      mainLoopModel,
      ideSelection,
      setUserInputOnProcessing,
      setAbortController,
      onQuery,
      setAppState,
      querySource: getQuerySourceForREPL(),
      onBeforeQuery,
      canUseTool,
      addNotification,
      setMessages,
      queuedCommands
    });
  }, [queryGuard, commands, setToolJSX, getToolUseContext, messages, mainLoopModel, ideSelection, setUserInputOnProcessing, canUseTool, setAbortController, onQuery, addNotification, setAppState, onBeforeQuery]);
  useQueueProcessor({
    executeQueuedInput,
    hasActiveLocalJsxUI: isShowingLocalJSXCommand,
    queryGuard
  });

  // We'll use the global lastInteractionTime from state.ts

  // Update last interaction time when input changes.
  // Must be immediate because useEffect runs after the Ink render cycle flush.
  useEffect(() => {
    activityManager.recordUserActivity();
    updateLastInteractionTime(true);
  }, [inputValue, submitCount]);
  useEffect(() => {
    if (submitCount === 1) {
      startBackgroundHousekeeping();
    }
  }, [submitCount]);

  // Show notification when Zy is done responding and user is idle
  useEffect(() => {
    // Don't set up notification if Zy is busy
    if (isLoading) return;

    // Only enable notifications after the first new interaction in this session
    if (submitCount === 0) return;

    // No query has completed yet
    if (lastQueryCompletionTime === 0) return;

    // Set timeout to check idle state
    const timer = setTimeout((lastQueryCompletionTime, isLoading, toolJSX, focusedInputDialogRef, terminal) => {
      // Check if user has interacted since the response ended
      const lastUserInteraction = getLastInteractionTime();
      if (lastUserInteraction > lastQueryCompletionTime) {
        // User has interacted since Zy finished - they're not idle, don't notify
        return;
      }

      // User hasn't interacted since response ended, check other conditions
      const idleTimeSinceResponse = Date.now() - lastQueryCompletionTime;
      if (!isLoading && !toolJSX &&
      // Use ref to get current dialog state, avoiding stale closure
      focusedInputDialogRef.current === undefined && idleTimeSinceResponse >= getGlobalConfig().messageIdleNotifThresholdMs) {
        void sendNotification({
          message: 'Zy is waiting for your input',
          notificationType: 'idle_prompt'
        }, terminal);
      }
    }, getGlobalConfig().messageIdleNotifThresholdMs, lastQueryCompletionTime, isLoading, toolJSX, focusedInputDialogRef, terminal);
    return () => clearTimeout(timer);
  }, [isLoading, toolJSX, submitCount, lastQueryCompletionTime, terminal]);

  // Idle-return hint: show notification when idle threshold is exceeded.
  // Timer fires after the configured idle period; notification persists until
  // dismissed or the user submits.
  useEffect(() => {
    if (lastQueryCompletionTime === 0) return;
    if (isLoading) return;
    const willowMode: string = getFeatureValue_CACHED_MAY_BE_STALE('tengu_willow_mode', 'off');
    if (willowMode !== 'hint' && willowMode !== 'hint_v2') return;
    if (getGlobalConfig().idleReturnDismissed) return;
    const tokenThreshold = Number(process.env.ZY_CODE_IDLE_TOKEN_THRESHOLD ?? 100_000);
    if (getTotalInputTokens() < tokenThreshold) return;
    const idleThresholdMs = Number(process.env.ZY_CODE_IDLE_THRESHOLD_MINUTES ?? 75) * 60_000;
    const elapsed = Date.now() - lastQueryCompletionTime;
    const remaining = idleThresholdMs - elapsed;
    const timer = setTimeout((lqct, addNotif, msgsRef, mode, hintRef) => {
      if (msgsRef.current.length === 0) return;
      const totalTokens = getTotalInputTokens();
      const formattedTokens = formatTokens(totalTokens);
      const idleMinutes = (Date.now() - lqct) / 60_000;
      addNotif({
        key: 'idle-return-hint',
        jsx: mode === 'hint_v2' ? <>
                <Text dimColor>new task? </Text>
                <Text color="suggestion">/clear</Text>
                <Text dimColor> to save </Text>
                <Text color="suggestion">{formattedTokens} tokens</Text>
              </> : <Text color="warning">
                new task? /clear to save {formattedTokens} tokens
              </Text>,
        priority: 'medium',
        // Persist until submit — the hint fires at T+75min idle, user may
        // not return for hours. removeNotification in useEffect cleanup
        // handles dismissal. 0x7FFFFFFF = setTimeout max (~24.8 days).
        timeoutMs: 0x7fffffff
      });
      hintRef.current = mode;
      logEvent('tengu_idle_return_action', {
        action: 'hint_shown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        variant: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        idleMinutes: Math.round(idleMinutes),
        messageCount: msgsRef.current.length,
        totalInputTokens: totalTokens
      });
    }, Math.max(0, remaining), lastQueryCompletionTime, addNotification, messagesRef, willowMode, idleHintShownRef);
    return () => {
      clearTimeout(timer);
      removeNotification('idle-return-hint');
      idleHintShownRef.current = false;
    };
  }, [lastQueryCompletionTime, isLoading, addNotification, removeNotification]);

  // Submits incoming prompts from teammate messages or tasks mode as new turns
  // Returns true if submission succeeded, false if a query is already running
  const handleIncomingPrompt = useCallback((content: string, options?: {
    isMeta?: boolean;
  }): boolean => {
    if (queryGuard.isActive) return false;

    // Defer to user-queued commands — user input always takes priority
    // over system messages (teammate messages, task list items, etc.)
    // Read from the module-level store at call time (not the render-time
    // snapshot) to avoid a stale closure — this callback's deps don't
    // include the queue.
    if (getCommandQueue().some(cmd => cmd.mode === 'prompt' || cmd.mode === 'bash')) {
      return false;
    }
    const newAbortController = createAbortController();
    setAbortController(newAbortController);

    // Create a user message with the formatted content (includes XML wrapper)
    const userMessage = createUserMessage({
      content,
      isMeta: options?.isMeta ? true : undefined
    });
    void onQuery([userMessage], newAbortController, true, [], mainLoopModel);
    return true;
  }, [onQuery, mainLoopModel, store]);

  // Voice input integration (VOICE_MODE builds only)
  const voice = feature('VOICE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useVoiceIntegration({
    setInputValueRaw,
    inputValueRef,
    insertTextRef
  }) : {
    stripTrailing: () => 0,
    handleKeyEvent: () => {},
    resetAnchor: () => {},
    interimRange: null
  };
  useInboxPoller({
    enabled: isAgentSwarmsEnabled(),
    isLoading,
    focusedInputDialog,
    onSubmitMessage: handleIncomingPrompt
  });
  useMailboxBridge({
    isLoading,
    onSubmitMessage: handleIncomingPrompt
  });

  // Scheduled tasks from .zy/scheduled_tasks.json (CronCreate/Delete/List)
  if (feature('AGENT_TRIGGERS')) {
    // Assistant mode bypasses the isLoading gate (the proactive tick →
    // Sleep → tick loop would otherwise starve the scheduler).
    // kairosEnabled is set once in initialState (main.tsx) and never mutated — no
    // subscription needed. The tengu_kairos_cron runtime gate is checked inside
    // useScheduledTasks's effect (not here) since wrapping a hook call in a dynamic
    // condition would break rules-of-hooks.
    const assistantMode = store.getState().kairosEnabled;
    // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
    useScheduledTasks!({
      isLoading,
      assistantMode,
      setMessages
    });
  }

  // Note: Permission polling is now handled by useInboxPoller
  // - Workers receive permission responses via mailbox messages
  // - Leaders receive permission requests via mailbox messages

  if ("external" === 'ant') {
    // Tasks mode: watch for tasks and auto-process them
    // eslint-disable-next-line react-hooks/rules-of-hooks
    // biome-ignore lint/correctness/useHookAtTopLevel: conditional for dead code elimination in external builds
    useTaskListWatcher({
      taskListId,
      isLoading,
      onSubmitTask: handleIncomingPrompt
    });

    // Loop mode: auto-tick when enabled (via /job command)
    // eslint-disable-next-line react-hooks/rules-of-hooks
    // biome-ignore lint/correctness/useHookAtTopLevel: conditional for dead code elimination in external builds
    useProactive?.({
      // Suppress ticks while an initial message is pending — the initial
      // message will be processed asynchronously and a premature tick would
      // race with it, causing concurrent-query enqueue of expanded skill text.
      isLoading: isLoading || initialMessage !== null,
      queuedCommandsLength: queuedCommands.length,
      hasActiveLocalJsxUI: isShowingLocalJSXCommand,
      isInPlanMode: toolPermissionContext.mode === 'plan',
      onSubmitTick: (prompt: string) => handleIncomingPrompt(prompt, {
        isMeta: true
      }),
      onQueueTick: (prompt: string) => enqueue({
        mode: 'prompt',
        value: prompt,
        isMeta: true
      })
    });
  }

  // Abort the current operation when a 'now' priority message arrives
  // (e.g. from a chat UI client via UDS).
  useEffect(() => {
    if (queuedCommands.some(cmd => cmd.priority === 'now')) {
      abortControllerRef.current?.abort('interrupt');
    }
  }, [queuedCommands]);

  // Initial load
  useEffect(() => {
    void onInit();

    // Cleanup on unmount
    return () => {
      void diagnosticTracker.shutdown();
    };
    // TODO: fix this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for suspend/resume events
  const {
    internal_eventEmitter
  } = useStdin();
  const [remountKey, setRemountKey] = useState(0);
  useEffect(() => {
    const handleSuspend = () => {
      // Print suspension instructions
      process.stdout.write(`\nZY Code has been suspended. Run \`fg\` to bring ZY Code back.\nNote: ctrl + z now suspends ZY Code, ctrl + _ undoes input.\n`);
    };
    const handleResume = () => {
      // Force complete component tree replacement instead of terminal clear
      // Ink now handles line count reset internally on SIGCONT
      setRemountKey(prev => prev + 1);
    };
    internal_eventEmitter?.on('suspend', handleSuspend);
    internal_eventEmitter?.on('resume', handleResume);
    return () => {
      internal_eventEmitter?.off('suspend', handleSuspend);
      internal_eventEmitter?.off('resume', handleResume);
    };
  }, [internal_eventEmitter]);

  // Derive stop hook spinner suffix from messages state
  const stopHookSpinnerSuffix = useMemo(() => {
    if (!isLoading) return null;

    // Find stop hook progress messages
    const progressMsgs = messages.filter((m): m is ProgressMessage<HookProgress> => m.type === 'progress' && m.data.type === 'hook_progress' && (m.data.hookEvent === 'Stop' || m.data.hookEvent === 'SubagentStop'));
    if (progressMsgs.length === 0) return null;

    // Get the most recent stop hook execution
    const currentToolUseID = progressMsgs.at(-1)?.toolUseID;
    if (!currentToolUseID) return null;

    // Check if there's already a summary message for this execution (hooks completed)
    const hasSummaryForCurrentExecution = messages.some(m => m.type === 'system' && m.subtype === 'stop_hook_summary' && m.toolUseID === currentToolUseID);
    if (hasSummaryForCurrentExecution) return null;
    const currentHooks = progressMsgs.filter(p => p.toolUseID === currentToolUseID);
    const total = currentHooks.length;

    // Count completed hooks
    const completedCount = count(messages, m => {
      if (m.type !== 'attachment') return false;
      const attachment = m.attachment;
      return 'hookEvent' in attachment && (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') && 'toolUseID' in attachment && attachment.toolUseID === currentToolUseID;
    });

    // Check if any hook has a custom status message
    const customMessage = currentHooks.find(p => p.data.statusMessage)?.data.statusMessage;
    if (customMessage) {
      // Use custom message with progress counter if multiple hooks
      return total === 1 ? `${customMessage}…` : `${customMessage}… ${completedCount}/${total}`;
    }

    // Fall back to default behavior
    const hookType = currentHooks[0]?.data.hookEvent === 'SubagentStop' ? 'subagent stop' : 'stop';
    if ("external" === 'ant') {
      const cmd = currentHooks[completedCount]?.data.command;
      const label = cmd ? ` '${truncateToWidth(cmd, 40)}'` : '';
      return total === 1 ? `running ${hookType} hook${label}` : `running ${hookType} hook${label}\u2026 ${completedCount}/${total}`;
    }
    return total === 1 ? `running ${hookType} hook` : `running stop hooks… ${completedCount}/${total}`;
  }, [messages, isLoading]);

  // Callback to capture frozen state when entering transcript mode
  const handleEnterTranscript = useCallback(() => {
    setFrozenTranscriptState({
      messagesLength: messages.length,
      streamingToolUsesLength: streamingToolUses.length
    });
  }, [messages.length, streamingToolUses.length]);

  // Callback to clear frozen state when exiting transcript mode
  const handleExitTranscript = useCallback(() => {
    setFrozenTranscriptState(null);
  }, []);

  // Props for GlobalKeybindingHandlers component (rendered inside KeybindingSetup)
  const virtualScrollActive = isFullscreenEnvEnabled() && !disableVirtualScroll;

  // Transcript search state. Hooks must be unconditional so they live here
  // (not inside the `if (screen === 'transcript')` branch below); isActive
  // gates the useInput. Query persists across bar open/close so n/N keep
  // working after Enter dismisses the bar (less semantics).
  const jumpRef = useRef<JumpHandle | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCount, setSearchCount] = useState(0);
  const [searchCurrent, setSearchCurrent] = useState(0);
  const onSearchMatchesChange = useCallback((count: number, current: number) => {
    setSearchCount(count);
    setSearchCurrent(current);
  }, []);
  useInput((input, key, event) => {
    if (key.ctrl || key.meta) return;
    // No Esc handling here — less has no navigating mode. Search state
    // (highlights, n/N) is just state. Esc/q/ctrl+c → transcript:exit
    // (ungated). Highlights clear on exit via the screen-change effect.
    if (input === '/') {
      // Capture scrollTop NOW — typing is a preview, 0-matches snaps
      // back here. Synchronous ref write, fires before the bar's
      // mount-effect calls setSearchQuery.
      jumpRef.current?.setAnchor();
      setSearchOpen(true);
      event.stopImmediatePropagation();
      return;
    }
    // Held-key batching: tokenizer coalesces to 'nnn'. Same uniform-batch
    // pattern as modalPagerAction in ScrollKeybindingHandler.tsx. Each
    // repeat is a step (n isn't idempotent like g).
    const c = input[0];
    if ((c === 'n' || c === 'N') && input === c.repeat(input.length) && searchCount > 0) {
      const fn = c === 'n' ? jumpRef.current?.nextMatch : jumpRef.current?.prevMatch;
      if (fn) for (let i = 0; i < input.length; i++) fn();
      event.stopImmediatePropagation();
    }
  },
  // Search needs virtual scroll (jumpRef drives VirtualMessageList). [
  // kills it, so !dumpMode — after [ there's nothing to jump in.
  {
    isActive: screen === 'transcript' && virtualScrollActive && !searchOpen && !dumpMode
  });
  const {
    setQuery: setHighlight,
    scanElement,
    setPositions
  } = useSearchHighlight();

  // Resize → abort search. Positions are (msg, query, WIDTH)-keyed —
  // cached positions are stale after a width change (new layout, new
  // wrapping). Clearing searchQuery triggers VML's setSearchQuery('')
  // which clears positionsCache + setPositions(null). Bar closes.
  // User hits / again → fresh everything.
  const transcriptCols = useTerminalSize().columns;
  const prevColsRef = React.useRef(transcriptCols);
  React.useEffect(() => {
    if (prevColsRef.current !== transcriptCols) {
      prevColsRef.current = transcriptCols;
      if (searchQuery || searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
        setSearchCount(0);
        setSearchCurrent(0);
        jumpRef.current?.disarmSearch();
        setHighlight('');
      }
    }
  }, [transcriptCols, searchQuery, searchOpen, setHighlight]);

  // Transcript escape hatches. Bare letters in modal context (no prompt
  // competing for input) — same class as g/G/j/k in ScrollKeybindingHandler.
  useInput((input, key, event) => {
    if (key.ctrl || key.meta) return;
    if (input === 'q') {
      // less: q quits the pager. ctrl+o toggles; q is the lineage exit.
      handleExitTranscript();
      event.stopImmediatePropagation();
      return;
    }
    if (input === '[' && !dumpMode) {
      // Force dump-to-scrollback. Also expand + uncap — no point dumping
      // a subset. Terminal/tmux cmd-F can now find anything. Guard here
      // (not in isActive) so v still works post-[ — dump-mode footer at
      // ~4898 wires editorStatus, confirming v is meant to stay live.
      setDumpMode(true);
      setShowAllInTranscript(true);
      event.stopImmediatePropagation();
    } else if (input === 'v') {
      // less-style: v opens the file in $VISUAL/$EDITOR. Render the full
      // transcript (same path /export uses), write to tmp, hand off.
      // openFileInExternalEditor handles alt-screen suspend/resume for
      // terminal editors; GUI editors spawn detached.
      event.stopImmediatePropagation();
      // Drop double-taps: the render is async and a second press before it
      // completes would run a second parallel render (double memory, two
      // tempfiles, two editor spawns). editorGenRef only guards
      // transcript-exit staleness, not same-session concurrency.
      if (editorRenderingRef.current) return;
      editorRenderingRef.current = true;
      // Capture generation + make a staleness-aware setter. Each write
      // checks gen (transcript exit bumps it → late writes from the
      // async render go silent).
      const gen = editorGenRef.current;
      const setStatus = (s: string): void => {
        if (gen !== editorGenRef.current) return;
        clearTimeout(editorTimerRef.current);
        setEditorStatus(s);
      };
      setStatus(`rendering ${deferredMessages.length} messages…`);
      void (async () => {
        try {
          // Width = terminal minus vim's line-number gutter (4 digits +
          // space + slack). Floor at 80. PassThrough has no .columns so
          // without this Ink defaults to 80. Trailing-space strip: right-
          // aligned timestamps still leave a flexbox spacer run at EOL.
          // eslint-disable-next-line custom-rules/prefer-use-terminal-size -- one-shot at keypress time, not a reactive render dep
          const w = Math.max(80, (process.stdout.columns ?? 80) - 6);
          const raw = await renderMessagesToPlainText(deferredMessages, tools, w);
          const text = raw.replace(/[ \t]+$/gm, '');
          const path = join(tmpdir(), `cc-transcript-${Date.now()}.txt`);
          await writeFile(path, text);
          const opened = openFileInExternalEditor(path);
          setStatus(opened ? `opening ${path}` : `wrote ${path} · no $VISUAL/$EDITOR set`);
        } catch (e) {
          setStatus(`render failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        editorRenderingRef.current = false;
        if (gen !== editorGenRef.current) return;
        editorTimerRef.current = setTimeout(s => s(''), 4000, setEditorStatus);
      })();
    }
  },
  // !searchOpen: typing 'v' or '[' in the search bar is search input, not
  // a command. No !dumpMode here — v should work after [ (the [ handler
  // guards itself inline).
  {
    isActive: screen === 'transcript' && virtualScrollActive && !searchOpen
  });

  // Fresh `less` per transcript entry. Prevents stale highlights matching
  // unrelated normal-mode text (overlay is alt-screen-global) and avoids
  // surprise n/N on re-entry. Same exit resets [ dump mode — each ctrl+o
  // entry is a fresh instance.
  const inTranscript = screen === 'transcript' && virtualScrollActive;
  useEffect(() => {
    if (!inTranscript) {
      setSearchQuery('');
      setSearchCount(0);
      setSearchCurrent(0);
      setSearchOpen(false);
      editorGenRef.current++;
      clearTimeout(editorTimerRef.current);
      setDumpMode(false);
      setEditorStatus('');
    }
  }, [inTranscript]);
  useEffect(() => {
    setHighlight(inTranscript ? searchQuery : '');
    // Clear the position-based CURRENT (yellow) overlay too. setHighlight
    // only clears the scan-based inverse. Without this, the yellow box
    // persists at its last screen coords after ctrl-c exits transcript.
    if (!inTranscript) setPositions(null);
  }, [inTranscript, searchQuery, setHighlight, setPositions]);
  const globalKeybindingProps = {
    screen,
    setScreen,
    showAllInTranscript,
    setShowAllInTranscript,
    messageCount: messages.length,
    onEnterTranscript: handleEnterTranscript,
    onExitTranscript: handleExitTranscript,
    virtualScrollActive,
    // Bar-open is a mode (owns keystrokes — j/k type, Esc cancels).
    // Navigating (query set, bar closed) is NOT — Esc exits transcript,
    // same as less q with highlights still visible. useSearchInput
    // doesn't stopPropagation, so without this gate transcript:exit
    // would fire on the same Esc that cancels the bar (child registers
    // first, fires first, bubbles).
    searchBarOpen: searchOpen
  };

  // Use frozen lengths to slice arrays, avoiding memory overhead of cloning
  const transcriptMessages = frozenTranscriptState ? deferredMessages.slice(0, frozenTranscriptState.messagesLength) : deferredMessages;
  const transcriptStreamingToolUses = frozenTranscriptState ? streamingToolUses.slice(0, frozenTranscriptState.streamingToolUsesLength) : streamingToolUses;

  // Handle shift+down for teammate navigation and background task management.
  // Guard onOpenBackgroundTasks when a local-jsx dialog (e.g. /mcp) is open —
  // otherwise Shift+Down stacks BackgroundTasksDialog on top and deadlocks input.
  useBackgroundTaskNavigation({
    onOpenBackgroundTasks: isShowingLocalJSXCommand ? undefined : () => setShowBashesDialog(true)
  });
  // Auto-exit viewing mode when teammate completes or errors
  useTeammateViewAutoExit();
  if (screen === 'transcript') {
    // Virtual scroll replaces the 30-message cap: everything is scrollable
    // and memory is bounded by the viewport. Without it, wrapping transcript
    // in a ScrollBox would mount all messages (~250 MB on long sessions —
    // the exact problem), so the kill switch and non-fullscreen paths must
    // fall through to the legacy render: no alt screen, dump to terminal
    // scrollback, 30-cap + Ctrl+E. Reusing scrollRef is safe — normal-mode
    // and transcript-mode are mutually exclusive (this early return), so
    // only one ScrollBox is ever mounted at a time.
    const transcriptScrollRef = isFullscreenEnvEnabled() && !disableVirtualScroll && !dumpMode ? scrollRef : undefined;
    const transcriptMessagesElement = <Messages messages={transcriptMessages} tools={tools} commands={commands} verbose={true} toolJSX={null} toolUseConfirmQueue={[]} inProgressToolUseIDs={inProgressToolUseIDs} isMessageSelectorVisible={false} conversationId={conversationId} screen={screen} agentDefinitions={agentDefinitions} streamingToolUses={transcriptStreamingToolUses} showAllInTranscript={showAllInTranscript} onOpenRateLimitOptions={handleOpenRateLimitOptions} isLoading={isLoading} hidePastThinking={true} streamingThinking={streamingThinking} scrollRef={transcriptScrollRef} jumpRef={jumpRef} onSearchMatchesChange={onSearchMatchesChange} scanElement={scanElement} setPositions={setPositions} disableRenderCap={dumpMode} />;
    const transcriptToolJSX = toolJSX && <Box flexDirection="column" width="100%">
        {toolJSX.jsx}
      </Box>;
    const transcriptReturn = <KeybindingSetup>
        <AnimatedTerminalTitle isAnimating={titleIsAnimating} title={terminalTitle} disabled={titleDisabled} noPrefix={showStatusInTerminalTab} />
        <GlobalKeybindingHandlers {...globalKeybindingProps} />
        {feature('VOICE_MODE') ? <VoiceKeybindingHandler voiceHandleKeyEvent={voice.handleKeyEvent} stripTrailing={voice.stripTrailing} resetAnchor={voice.resetAnchor} isActive={!toolJSX?.isLocalJSXCommand} /> : null}
        <CommandKeybindingHandlers onSubmit={onSubmit} isActive={!toolJSX?.isLocalJSXCommand} />
        {transcriptScrollRef ?
      // ScrollKeybindingHandler must mount before CancelRequestHandler so
      // ctrl+c-with-selection copies instead of cancelling the active task.
      // Its raw useInput handler only stops propagation when a selection
      // exists — without one, ctrl+c falls through to CancelRequestHandler.
      <ScrollKeybindingHandler scrollRef={scrollRef}
      // Yield wheel/ctrl+u/d to UltraplanChoiceDialog's own scroll
      // handler while the modal is showing.
      isActive={focusedInputDialog !== 'ultraplan-choice'}
      // g/G/j/k/ctrl+u/ctrl+d would eat keystrokes the search bar
      // wants. Off while searching.
      isModal={!searchOpen}
      // Manual scroll exits the search context — clear the yellow
      // current-match marker. Positions are (msg, rowOffset)-keyed;
      // j/k changes scrollTop so rowOffset is stale → wrong row
      // gets yellow. Next n/N re-establishes via step()→jump().
      onScroll={() => jumpRef.current?.disarmSearch()} /> : null}
        <CancelRequestHandler {...cancelRequestProps} />
        {transcriptScrollRef ? <FullscreenLayout scrollRef={scrollRef} scrollable={<>
                {transcriptMessagesElement}
                {transcriptToolJSX}
                <SandboxViolationExpandedView />
              </>} bottom={searchOpen ? <TranscriptSearchBar jumpRef={jumpRef}
      // Seed was tried (c01578c8) — broke /hello muscle
      // memory (cursor lands after 'foo', /hello → foohello).
      // Cancel-restore handles the 'don't lose prior search'
      // concern differently (onCancel re-applies searchQuery).
      initialQuery="" count={searchCount} current={searchCurrent} onClose={q => {
        // Enter — commit. 0-match guard: junk query shouldn't
        // persist (badge hidden, n/N dead anyway).
        setSearchQuery(searchCount > 0 ? q : '');
        setSearchOpen(false);
        // onCancel path: bar unmounts before its useEffect([query])
        // can fire with ''. Without this, searchCount stays stale
        // (n guard at :4956 passes) and VML's matches[] too
        // (nextMatch walks the old array). Phantom nav, no
        // highlight. onExit (Enter, q non-empty) still commits.
        if (!q) {
          setSearchCount(0);
          setSearchCurrent(0);
          jumpRef.current?.setSearchQuery('');
        }
      }} onCancel={() => {
        // Esc/ctrl+c/ctrl+g — undo. Bar's effect last fired
        // with whatever was typed. searchQuery (REPL state)
        // is unchanged since / (onClose = commit, didn't run).
        // Two VML calls: '' restores anchor (0-match else-
        // branch), then searchQuery re-scans from anchor's
        // nearest. Both synchronous — one React batch.
        // setHighlight explicit: REPL's sync-effect dep is
        // searchQuery (unchanged), wouldn't re-fire.
        setSearchOpen(false);
        jumpRef.current?.setSearchQuery('');
        jumpRef.current?.setSearchQuery(searchQuery);
        setHighlight(searchQuery);
      }} setHighlight={setHighlight} /> : <TranscriptModeFooter showAllInTranscript={showAllInTranscript} virtualScroll={true} status={editorStatus || undefined} searchBadge={searchQuery && searchCount > 0 ? {
        current: searchCurrent,
        count: searchCount
      } : undefined} />} /> : <>
            {transcriptMessagesElement}
            {transcriptToolJSX}
            <SandboxViolationExpandedView />
            <TranscriptModeFooter showAllInTranscript={showAllInTranscript} virtualScroll={false} suppressShowAll={dumpMode} status={editorStatus || undefined} />
          </>}
      </KeybindingSetup>;
    // The virtual-scroll branch (FullscreenLayout above) needs
    // <AlternateScreen>'s <Box height={rows}> constraint — without it,
    // ScrollBox's flexGrow has no ceiling, viewport = content height,
    // scrollTop pins at 0, and Ink's screen buffer sizes to the full
    // spacer (200×5k+ rows on long sessions). Same root type + props as
    // normal mode's wrap below so React reconciles and the alt buffer
    // stays entered across toggle. The 30-cap dump branch stays
    // unwrapped — it wants native terminal scrollback.
    if (transcriptScrollRef) {
      return <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>
          {transcriptReturn}
        </AlternateScreen>;
    }
    return transcriptReturn;
  }

  // Get viewed agent task (inlined from selectors for explicit data flow).
  // viewedAgentTask: teammate OR local_agent — drives the boolean checks
  // below. viewedTeammateTask: teammate-only narrowed, for teammate-specific
  // field access (inProgressToolUseIDs).
  const viewedTask = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined;
  const viewedTeammateTask = viewedTask && isInProcessTeammateTask(viewedTask) ? viewedTask : undefined;
  const viewedAgentTask = viewedTeammateTask ?? (viewedTask && isLocalAgentTask(viewedTask) ? viewedTask : undefined);

  // Bypass useDeferredValue when streaming text is showing so Messages renders
  // the final message in the same frame streaming text clears. Also bypass when
  // not loading — deferredMessages only matters during streaming (keeps input
  // responsive); after the turn ends, showing messages immediately prevents a
  // jitter gap where the spinner is gone but the answer hasn't appeared yet.
  // Only reducedMotion users keep the deferred path during loading.
  const usesSyncMessages = showStreamingText || !isLoading;
  // When viewing an agent, never fall through to leader — empty until
  // bootstrap/stream fills. Closes the see-leader-type-agent footgun.
  const displayedMessages = viewedAgentTask ? viewedAgentTask.messages ?? [] : usesSyncMessages ? messages : deferredMessages;
  // Show the placeholder until the real user message appears in
  // displayedMessages. userInputOnProcessing stays set for the whole turn
  // (cleared in resetLoadingState); this length check hides it once
  // displayedMessages grows past the baseline captured at submit time.
  // Covers both gaps: before setMessages is called (processUserInput), and
  // while deferredMessages lags behind messages. Suppressed when viewing an
  // agent — displayedMessages is a different array there, and onAgentSubmit
  // doesn't use the placeholder anyway.
  const placeholderText = userInputOnProcessing && !viewedAgentTask && displayedMessages.length <= userInputBaselineRef.current ? userInputOnProcessing : undefined;
  const toolPermissionOverlay = focusedInputDialog === 'tool-permission' ? <PermissionRequest key={toolUseConfirmQueue[0]?.toolUseID} onDone={() => setToolUseConfirmQueue(([_, ...tail]) => tail)} onReject={handleQueuedCommandOnCancel} toolUseConfirm={toolUseConfirmQueue[0]!} toolUseContext={getToolUseContext(messages, messages, abortController ?? createAbortController(), mainLoopModel)} verbose={verbose} workerBadge={toolUseConfirmQueue[0]?.workerBadge} setStickyFooter={isFullscreenEnvEnabled() ? setPermissionStickyFooter : undefined} /> : null;

  // Narrow terminals: companion collapses to a one-liner that REPL stacks
  // on its own row (above input in fullscreen, below in scrollback) instead
  // of row-beside. Wide terminals keep the row layout with sprite on the right.
  const companionNarrow = transcriptCols < MIN_COLS_FOR_FULL_SPRITE;
  // Hide the sprite when PromptInput early-returns BackgroundTasksDialog.
  // The sprite sits as a row sibling of PromptInput, so the dialog's Pane
  // divider draws at useTerminalSize() width but only gets terminalWidth -
  // spriteWidth — divider stops short and dialog text wraps early. Don't
  // check footerSelection: pill FOCUS (arrow-down to tasks pill) must keep
  // the sprite visible so arrow-right can navigate to it.
  const companionVisible = !toolJSX?.shouldHidePromptInput && !focusedInputDialog && !showBashesDialog;

  // In fullscreen, ALL local-jsx slash commands float in the modal slot —
  // FullscreenLayout wraps them in an absolute-positioned bottom-anchored
  // pane (▔ divider, ModalContext). Pane/Dialog inside detect the context
  // and skip their own top-level frame. Non-fullscreen keeps the inline
  // render paths below. Commands that used to route through bottom
  // (immediate: /model, /mcp, /btw, ...) and scrollable (non-immediate:
  // /config, /theme, /diff, ...) both go here now.
  const toolJsxCentered = isFullscreenEnvEnabled() && toolJSX?.isLocalJSXCommand === true;
  const centeredModal: React.ReactNode = toolJsxCentered ? toolJSX!.jsx : null;

  // <AlternateScreen> at the root: everything below is inside its
  // <Box height={rows}>. Handlers/contexts are zero-height so ScrollBox's
  // flexGrow in FullscreenLayout resolves against this Box. The transcript
  // early return above wraps its virtual-scroll branch the same way; only
  // the 30-cap dump branch stays unwrapped for native terminal scrollback.
  const mainReturn = <KeybindingSetup>
      <AnimatedTerminalTitle isAnimating={titleIsAnimating} title={terminalTitle} disabled={titleDisabled} noPrefix={showStatusInTerminalTab} />
      <GlobalKeybindingHandlers {...globalKeybindingProps} />
      {feature('VOICE_MODE') ? <VoiceKeybindingHandler voiceHandleKeyEvent={voice.handleKeyEvent} stripTrailing={voice.stripTrailing} resetAnchor={voice.resetAnchor} isActive={!toolJSX?.isLocalJSXCommand} /> : null}
      <CommandKeybindingHandlers onSubmit={onSubmit} isActive={!toolJSX?.isLocalJSXCommand} />
      {/* ScrollKeybindingHandler must mount before CancelRequestHandler so
          ctrl+c-with-selection copies instead of cancelling the active task.
          Its raw useInput handler only stops propagation when a selection
          exists — without one, ctrl+c falls through to CancelRequestHandler.
          PgUp/PgDn/wheel always scroll the transcript behind the modal —
          the modal's inner ScrollBox is not keyboard-driven. onScroll
          stays suppressed while a modal is showing so scroll doesn't
          stamp divider/pill state. */}
      <ScrollKeybindingHandler scrollRef={scrollRef} isActive={isFullscreenEnvEnabled() && (centeredModal != null || !focusedInputDialog || focusedInputDialog === 'tool-permission')} onScroll={centeredModal || toolPermissionOverlay || viewedAgentTask ? undefined : composedOnScroll} />
      {feature('MESSAGE_ACTIONS') && isFullscreenEnvEnabled() && !disableMessageActions ? <MessageActionsKeybindings handlers={messageActionHandlers} isActive={cursor !== null} /> : null}
      <CancelRequestHandler {...cancelRequestProps} />
      <MCPConnectionManager key={remountKey} dynamicMcpConfig={dynamicMcpConfig} isStrictMcpConfig={strictMcpConfig}>
        <FullscreenLayout scrollRef={scrollRef} overlay={toolPermissionOverlay} bottomFloat={feature('BUDDY') && companionVisible && !companionNarrow ? <CompanionFloatingBubble /> : undefined} modal={centeredModal} modalScrollRef={modalScrollRef} dividerYRef={dividerYRef} hidePill={!!viewedAgentTask} hideSticky={!!viewedTeammateTask} newMessageCount={unseenDivider?.count ?? 0} onPillClick={() => {
        setCursor(null);
        jumpToNew(scrollRef.current);
      }} scrollable={<>
              <TeammateViewHeader />
              <Messages messages={displayedMessages} tools={tools} commands={commands} verbose={verbose} toolJSX={toolJSX} toolUseConfirmQueue={toolUseConfirmQueue} inProgressToolUseIDs={viewedTeammateTask ? viewedTeammateTask.inProgressToolUseIDs ?? new Set() : inProgressToolUseIDs} isMessageSelectorVisible={isMessageSelectorVisible} conversationId={conversationId} screen={screen} streamingToolUses={streamingToolUses} showAllInTranscript={showAllInTranscript} agentDefinitions={agentDefinitions} onOpenRateLimitOptions={handleOpenRateLimitOptions} isLoading={isLoading} streamingText={isLoading && !viewedAgentTask ? visibleStreamingText : null} isBriefOnly={viewedAgentTask ? false : isBriefOnly} unseenDivider={viewedAgentTask ? undefined : unseenDivider} scrollRef={isFullscreenEnvEnabled() ? scrollRef : undefined} trackStickyPrompt={isFullscreenEnvEnabled() ? true : undefined} cursor={cursor} setCursor={setCursor} cursorNavRef={cursorNavRef} />
              <AwsAuthStatusBox />
              {/* Hide the processing placeholder while a modal is showing —
                  it would sit at the last visible transcript row right above
                  ▔ 分隔线，显示 "❯ /config" 显得冗余
                  （模态框本身就是 /config UI）。在模态框外保持显示，
                  以便用户在 Zy 处理时能看到自己的输入回显。 */}
              {!disabled && placeholderText && !centeredModal && <UserTextMessage param={{
          text: placeholderText,
          type: 'text'
        }} addMargin={true} verbose={verbose} />}
              {toolJSX && !(toolJSX.isLocalJSXCommand && toolJSX.isImmediate) && !toolJsxCentered && <Box flexDirection="column" width="100%">
                    {toolJSX.jsx}
                  </Box>}
              {"external" === 'ant' && <TungstenLiveMonitor />}
              {feature('WEB_BROWSER_TOOL') ? WebBrowserPanelModule && <WebBrowserPanelModule.WebBrowserPanel /> : null}
              <Box flexGrow={1} />
              {showSpinner && <SpinnerWithVerb mode={streamMode} spinnerTip={spinnerTip} responseLengthRef={responseLengthRef} apiMetricsRef={apiMetricsRef} overrideMessage={spinnerMessage} spinnerSuffix={stopHookSpinnerSuffix} verbose={verbose} loadingStartTimeRef={loadingStartTimeRef} totalPausedMsRef={totalPausedMsRef} pauseStartTimeRef={pauseStartTimeRef} overrideColor={spinnerColor} overrideShimmerColor={spinnerShimmerColor} hasActiveTools={inProgressToolUseIDs.size > 0} leaderIsIdle={!isLoading} />}
              {!showSpinner && !isLoading && !userInputOnProcessing && !hasRunningTeammates && isBriefOnly && !viewedAgentTask && <BriefIdleStatus />}
              {isFullscreenEnvEnabled() && <PromptInputQueuedCommands />}
            </>} bottom={<Box flexDirection={feature('BUDDY') && companionNarrow ? 'column' : 'row'} width="100%" alignItems={feature('BUDDY') && companionNarrow ? undefined : 'flex-end'}>
              {feature('BUDDY') && companionNarrow && isFullscreenEnvEnabled() && companionVisible ? <CompanionSprite /> : null}
              <Box flexDirection="column" flexGrow={1}>
                {permissionStickyFooter}
                {/* 即时 local-jsx 命令（/btw、/sandbox、/assistant、
                  /issue）渲染在此处，而非 scrollable 内部。它们在主对话流
                  背后推送时保持挂载，因此 ScrollBox 每次新消息的重新布局
                  不会拖动它们。bottom 是 flexShrink={0} 且在 ScrollBox 外
                  ——它永远不会移动。
                  非即时 local-jsx（/diff、/status、/theme 等约 40 个）
                  保留在 scrollable 中：主循环已暂停，因此不会抖动，
                  且它们的高内容（DiffDetailView 最多渲染 400 行，无内部滚动）
                  需要外部 ScrollBox。 */}
                {toolJSX?.isLocalJSXCommand && toolJSX.isImmediate && !toolJsxCentered && <Box flexDirection="column" width="100%">
                      {toolJSX.jsx}
                    </Box>}
                {!showSpinner && !toolJSX?.isLocalJSXCommand && showExpandedTodos && tasksV2 && tasksV2.length > 0 && <Box width="100%" flexDirection="column">
                      <TaskListV2 tasks={tasksV2} isStandalone={true} />
                    </Box>}
                {focusedInputDialog === 'sandbox-permission' && <SandboxPermissionRequest key={sandboxPermissionRequestQueue[0]!.hostPattern.host} hostPattern={sandboxPermissionRequestQueue[0]!.hostPattern} onUserResponse={(response: {
            allow: boolean;
            persistToSettings: boolean;
          }) => {
            const {
              allow,
              persistToSettings
            } = response;
            const currentRequest = sandboxPermissionRequestQueue[0];
            if (!currentRequest) return;
            const approvedHost = currentRequest.hostPattern.host;
            if (persistToSettings) {
              const update = {
                type: 'addRules' as const,
                rules: [{
                  toolName: WEB_FETCH_TOOL_NAME,
                  ruleContent: `domain:${approvedHost}`
                }],
                behavior: (allow ? 'allow' : 'deny') as 'allow' | 'deny',
                destination: 'localSettings' as const
              };
              setAppState(prev => ({
                ...prev,
                toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, update)
              }));
              persistPermissionUpdate(update);

              // 立即更新沙盒内存配置，防止竞态条件
              // 即待处理请求在设置更改检测前漏过
              SandboxManager.refreshConfig();
            }

            // 解析同一主机的所有待处理请求（不仅仅是第一个）
            // 这处理了多个并行请求来自同一域名的情况
            setSandboxPermissionRequestQueue(queue => {
              queue.filter(item => item.hostPattern.host === approvedHost).forEach(item => item.resolvePromise(allow));
              return queue.filter(item => item.hostPattern.host !== approvedHost);
            });

            // 清理桥接订阅并取消远程提示
            // 因为本地用户已经响应，所以针对该主机
            const cleanups = sandboxBridgeCleanupRef.current.get(approvedHost);
            if (cleanups) {
              for (const fn of cleanups) {
                fn();
              }
              sandboxBridgeCleanupRef.current.delete(approvedHost);
            }
          }} />}
                {focusedInputDialog === 'prompt' && <PromptDialog key={promptQueue[0]!.request.prompt} title={promptQueue[0]!.title} toolInputSummary={promptQueue[0]!.toolInputSummary} request={promptQueue[0]!.request} onRespond={selectedKey => {
            const item = promptQueue[0];
            if (!item) return;
            item.resolve({
              prompt_response: item.request.prompt,
              selected: selectedKey
            });
            setPromptQueue(([, ...tail]) => tail);
          }} onAbort={() => {
            const item = promptQueue[0];
            if (!item) return;
            item.reject(new Error('Prompt cancelled by user'));
            setPromptQueue(([, ...tail]) => tail);
          }} />}
                {/* 在 worker 等待 leader 批准时显示待处理指示器 */}
                {pendingWorkerRequest && <WorkerPendingPermission toolName={pendingWorkerRequest.toolName} description={pendingWorkerRequest.description} />}
                {/* 显示 worker 端沙盒权限的待处理指示器 */}
                {pendingSandboxRequest && <WorkerPendingPermission toolName="Network Access" description={`Waiting for leader to approve network access to ${pendingSandboxRequest.host}`} />}
                {/* 来自 swarm worker 的 worker 沙盒权限请求 */}
                {focusedInputDialog === 'worker-sandbox-permission' && <SandboxPermissionRequest key={workerSandboxPermissions.queue[0]!.requestId} hostPattern={{
            host: workerSandboxPermissions.queue[0]!.host,
            port: undefined
          } as NetworkHostPattern} onUserResponse={(response: {
            allow: boolean;
            persistToSettings: boolean;
          }) => {
            const {
              allow,
              persistToSettings
            } = response;
            const currentRequest = workerSandboxPermissions.queue[0];
            if (!currentRequest) return;
            const approvedHost = currentRequest.host;

            // 通过邮箱向 worker 发送响应
            void sendSandboxPermissionResponseViaMailbox(currentRequest.workerName, currentRequest.requestId, approvedHost, allow, teamContext?.teamName);
            if (persistToSettings && allow) {
              const update = {
                type: 'addRules' as const,
                rules: [{
                  toolName: WEB_FETCH_TOOL_NAME,
                  ruleContent: `domain:${approvedHost}`
                }],
                behavior: 'allow' as const,
                destination: 'localSettings' as const
              };
              setAppState(prev => ({
                ...prev,
                toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, update)
              }));
              persistPermissionUpdate(update);
              SandboxManager.refreshConfig();
            }

            // 从队列中移除
            setAppState(prev => ({
              ...prev,
              workerSandboxPermissions: {
                ...prev.workerSandboxPermissions,
                queue: prev.workerSandboxPermissions.queue.slice(1)
              }
            }));
          }} />}
                {focusedInputDialog === 'elicitation' && <ElicitationDialog key={elicitation.queue[0]!.serverName + ':' + String(elicitation.queue[0]!.requestId)} event={elicitation.queue[0]!} onResponse={(action, content) => {
            const currentRequest = elicitation.queue[0];
            if (!currentRequest) return;
            // 调用 respond 回调以解析 Promise
            currentRequest.respond({
              action,
              content
            });
            // 对于 URL 接受，保留在队列中等待阶段 2
            const isUrlAccept = currentRequest.params.mode === 'url' && action === 'accept';
            if (!isUrlAccept) {
              setAppState(prev => ({
                ...prev,
                elicitation: {
                  queue: prev.elicitation.queue.slice(1)
                }
              }));
            }
          }} onWaitingDismiss={action => {
            const currentRequest = elicitation.queue[0];
            // 从队列中移除
            setAppState(prev => ({
              ...prev,
              elicitation: {
                queue: prev.elicitation.queue.slice(1)
              }
            }));
            currentRequest?.onWaitingDismiss?.(action);
          }} />}
                {focusedInputDialog === 'cost' && <CostThresholdDialog onDone={() => {
            setShowCostDialog(false);
            setHaveShownCostDialog(true);
            saveGlobalConfig(current => ({
              ...current,
              hasAcknowledgedCostThreshold: true
            }));
            logEvent('tengu_cost_threshold_acknowledged', {});
          }} />}
                {focusedInputDialog === 'idle-return' && idleReturnPending && <IdleReturnDialog idleMinutes={idleReturnPending.idleMinutes} totalInputTokens={getTotalInputTokens()} onDone={async action => {
            const pending = idleReturnPending;
            setIdleReturnPending(null);
            logEvent('tengu_idle_return_action', {
              action: action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              idleMinutes: Math.round(pending.idleMinutes),
              messageCount: messagesRef.current.length,
              totalInputTokens: getTotalInputTokens()
            });
            if (action === 'dismiss') {
              setInputValue(pending.input);
              return;
            }
            if (action === 'never') {
              saveGlobalConfig(current => {
                if (current.idleReturnDismissed) return current;
                return {
                  ...current,
                  idleReturnDismissed: true
                };
              });
            }
            if (action === 'clear') {
              const {
                clearConversation
              } = await import('../commands/clear/conversation.js');
              await clearConversation({
                setMessages,
                readFileState: readFileState.current,
                discoveredSkillNames: discoveredSkillNamesRef.current,
                loadedNestedMemoryPaths: loadedNestedMemoryPathsRef.current,
                getAppState: () => store.getState(),
                setAppState,
                setConversationId
              });
              haikuTitleAttemptedRef.current = false;
              setHaikuTitle(undefined);
              bashTools.current.clear();
              bashToolsProcessedIdx.current = 0;
            }
            skipIdleCheckRef.current = true;
            void onSubmitRef.current(pending.input, {
              setCursorOffset: () => {},
              clearBuffer: () => {},
              resetHistory: () => {}
            });
          }} />}
                {focusedInputDialog === 'ide-onboarding' && <IdeOnboardingDialog onDone={() => setShowIdeOnboarding(false)} installationStatus={ideInstallationStatus} />}
                {"external" === 'ant' && focusedInputDialog === 'model-switch' && AntModelSwitchCallout && <AntModelSwitchCallout onDone={(selection: string, modelAlias?: string) => {
            setShowModelSwitchCallout(false);
            if (selection === 'switch' && modelAlias) {
              setAppState(prev => ({
                ...prev,
                mainLoopModel: modelAlias,
                mainLoopModelForSession: null
              }));
            }
          }} />}
                {"external" === 'ant' && focusedInputDialog === 'undercover-callout' && UndercoverAutoCallout && <UndercoverAutoCallout onDone={() => setShowUndercoverCallout(false)} />}
                {focusedInputDialog === 'effort-callout' && <EffortCallout model={mainLoopModel} onDone={selection => {
            setShowEffortCallout(false);
            if (selection !== 'dismiss') {
              setAppState(prev => ({
                ...prev,
                effortValue: selection
              }));
            }
          }} />}
                {focusedInputDialog === 'remote-callout' && <RemoteCallout onDone={selection => {
            setAppState(prev => {
              if (!prev.showRemoteCallout) return prev;
              return {
                ...prev,
                showRemoteCallout: false,
                ...(selection === 'enable' && {
                  replBridgeEnabled: true,
                  replBridgeExplicit: true,
                  replBridgeOutboundOnly: false
                })
              };
            });
          }} />}

                {exitFlow}

                {focusedInputDialog === 'plugin-hint' && hintRecommendation && <PluginHintMenu pluginName={hintRecommendation.pluginName} pluginDescription={hintRecommendation.pluginDescription} marketplaceName={hintRecommendation.marketplaceName} sourceCommand={hintRecommendation.sourceCommand} onResponse={handleHintResponse} />}

                {focusedInputDialog === 'lsp-recommendation' && lspRecommendation && <LspRecommendationMenu pluginName={lspRecommendation.pluginName} pluginDescription={lspRecommendation.pluginDescription} fileExtension={lspRecommendation.fileExtension} onResponse={handleLspResponse} />}

                {focusedInputDialog === 'desktop-upsell' && <DesktopUpsellStartup onDone={() => setShowDesktopUpsellStartup(false)} />}

                {feature('ULTRAPLAN') ? focusedInputDialog === 'ultraplan-choice' && ultraplanPendingChoice && <UltraplanChoiceDialog plan={ultraplanPendingChoice.plan} sessionId={ultraplanPendingChoice.sessionId} taskId={ultraplanPendingChoice.taskId} setMessages={setMessages} readFileState={readFileState.current} getAppState={() => store.getState()} setConversationId={setConversationId} /> : null}

                {feature('ULTRAPLAN') ? focusedInputDialog === 'ultraplan-launch' && ultraplanLaunchPending && <UltraplanLaunchDialog onChoice={(choice, opts) => {
            const blurb = ultraplanLaunchPending.blurb;
            setAppState(prev => prev.ultraplanLaunchPending ? {
              ...prev,
              ultraplanLaunchPending: undefined
            } : prev);
            if (choice === 'cancel') return;
            // 使用命令的 onDone，显示 display:'skip'，在此处
            // 添加回显 —— 在 ~5s teleportToRemote 解析前提供即时反馈
            setMessages(prev => [...prev, createCommandInputMessage(formatCommandInputTags('ultraplan', blurb))]);
            const appendStdout = (msg: string) => setMessages(prev => [...prev, createCommandInputMessage(`<${LOCAL_COMMAND_STDOUT_TAG}>${escapeXml(msg)}</${LOCAL_COMMAND_STDOUT_TAG}>`)]);
            // 如果查询正在进行中，则延迟第二条消息
            // 使其在 assistant 回复之后到达，而不是
            // 夹在用户提示和回复之间
            const appendWhenIdle = (msg: string) => {
              if (!queryGuard.isActive) {
                appendStdout(msg);
                return;
              }
              const unsub = queryGuard.subscribe(() => {
                if (queryGuard.isActive) return;
                unsub();
                // 如果在等待期间用户停止了 ultraplan，则跳过
                // ——避免为已消失的会话显示过时的 "Monitoring
                // <url>" 消息
                if (!store.getState().ultraplanSessionUrl) return;
                appendStdout(msg);
              });
            };
            void launchUltraplan({
              blurb,
              getAppState: () => store.getState(),
              setAppState,
              signal: createAbortController().signal,
              disconnectedBridge: opts?.disconnectedBridge,
              onSessionReady: appendWhenIdle
            }).then(appendStdout).catch(logError);
          }} /> : null}

                {mrRender()}

                {!toolJSX?.shouldHidePromptInput && !focusedInputDialog && !isExiting && !disabled && !cursor && <>
                      {autoRunIssueReason && <AutoRunIssueNotification onRun={handleAutoRunIssue} onCancel={handleCancelAutoRunIssue} reason={getAutoRunIssueReasonText(autoRunIssueReason)} />}
                      {postCompactSurvey.state !== 'closed' ? <FeedbackSurvey state={postCompactSurvey.state} lastResponse={postCompactSurvey.lastResponse} handleSelect={postCompactSurvey.handleSelect} inputValue={inputValue} setInputValue={setInputValue} onRequestFeedback={handleSurveyRequestFeedback} /> : memorySurvey.state !== 'closed' ? <FeedbackSurvey state={memorySurvey.state} lastResponse={memorySurvey.lastResponse} handleSelect={memorySurvey.handleSelect} handleTranscriptSelect={memorySurvey.handleTranscriptSelect} inputValue={inputValue} setInputValue={setInputValue} onRequestFeedback={handleSurveyRequestFeedback} message="How well did Zy use its memory? (optional)" /> : <FeedbackSurvey state={feedbackSurvey.state} lastResponse={feedbackSurvey.lastResponse} handleSelect={feedbackSurvey.handleSelect} handleTranscriptSelect={feedbackSurvey.handleTranscriptSelect} inputValue={inputValue} setInputValue={setInputValue} onRequestFeedback={didAutoRunIssueRef.current ? undefined : handleSurveyRequestFeedback} />}
                      {/* 挫折触发的转录共享提示 */}
                      {frustrationDetection.state !== 'closed' && <FeedbackSurvey state={frustrationDetection.state} lastResponse={null} handleSelect={() => {}} handleTranscriptSelect={frustrationDetection.handleTranscriptSelect} inputValue={inputValue} setInputValue={setInputValue} />}
                      {/* 技能改进调查 —— 检测到改进时出现（仅 ant） */}
                      {"external" === 'ant' && skillImprovementSurvey.suggestion && <SkillImprovementSurvey isOpen={skillImprovementSurvey.isOpen} skillName={skillImprovementSurvey.suggestion.skillName} updates={skillImprovementSurvey.suggestion.updates} handleSelect={skillImprovementSurvey.handleSelect} inputValue={inputValue} setInputValue={setInputValue} />}
                      {showIssueFlagBanner && <IssueFlagBanner />}
                      {}
                      <PromptInput debug={debug} ideSelection={ideSelection} hasSuppressedDialogs={!!hasSuppressedDialogs} isLocalJSXCommandActive={isShowingLocalJSXCommand} getToolUseContext={getToolUseContext} toolPermissionContext={toolPermissionContext} setToolPermissionContext={setToolPermissionContext} apiKeyStatus={apiKeyStatus} commands={commands} agents={agentDefinitions.activeAgents} isLoading={isLoading} onExit={handleExit} verbose={verbose} messages={messages} onAutoUpdaterResult={setAutoUpdaterResult} autoUpdaterResult={autoUpdaterResult} input={inputValue} onInputChange={setInputValue} mode={inputMode} onModeChange={setInputMode} stashedPrompt={stashedPrompt} setStashedPrompt={setStashedPrompt} submitCount={submitCount} onShowMessageSelector={handleShowMessageSelector} onMessageActionsEnter={
            // isLoading 期间有效 —— 编辑会先取消；uuid 选择在追加后保留
            feature('MESSAGE_ACTIONS') && isFullscreenEnvEnabled() && !disableMessageActions ? enterMessageActions : undefined} mcpClients={mcpClients} pastedContents={pastedContents} setPastedContents={setPastedContents} vimMode={vimMode} setVimMode={setVimMode} showBashesDialog={showBashesDialog} setShowBashesDialog={setShowBashesDialog} onSubmit={onSubmit} onAgentSubmit={onAgentSubmit} isSearchingHistory={isSearchingHistory} setIsSearchingHistory={setIsSearchingHistory} helpOpen={isHelpOpen} setHelpOpen={setIsHelpOpen} insertTextRef={feature('VOICE_MODE') ? insertTextRef : undefined} voiceInterimRange={voice.interimRange} />
                      <SessionBackgroundHint onBackgroundSession={handleBackgroundSession} isLoading={isLoading} />
                    </>}
                {cursor &&
          // inputValue 是 REPL 状态；输入的文字在往返过程中保留
          <MessageActionsBar cursor={cursor} />}
                {focusedInputDialog === 'message-selector' && <MessageSelector messages={messages} preselectedMessage={messageSelectorPreselect} onPreRestore={onCancel} onRestoreCode={async (message: UserMessage) => {
            await fileHistoryRewind((updater: (prev: FileHistoryState) => FileHistoryState) => {
              setAppState(prev => ({
                ...prev,
                fileHistory: updater(prev.fileHistory)
              }));
            }, message.uuid);
          }} onSummarize={async (message: UserMessage, feedback?: string, direction: PartialCompactDirection = 'from') => {
            // 投影被裁剪的消息，这样 compact 模型
            // 就不会有意被移除的内容进行摘要
            const compactMessages = getMessagesAfterCompactBoundary(messages);
            const messageIndex = compactMessages.indexOf(message);
            if (messageIndex === -1) {
              // 选择了被裁剪或 compact 前的消息，而选择器
              // 仍然显示（REPL 保留完整历史用于回滚）。
              // 显示为什么没有操作，而不是静默无操作
              setMessages(prev => [...prev, createSystemMessage('That message is no longer in the active context (snipped or pre-compact). Choose a more recent message.', 'warning')]);
              return;
            }
            const newAbortController = createAbortController();
            const context = getToolUseContext(compactMessages, [], newAbortController, mainLoopModel);
            const appState = context.getAppState();
            const defaultSysPrompt = await getSystemPrompt(context.options.tools, context.options.mainLoopModel, Array.from(appState.toolPermissionContext.additionalWorkingDirectories.keys()), context.options.mcpClients);
            const systemPrompt = buildEffectiveSystemPrompt({
              mainThreadAgentDefinition: undefined,
              toolUseContext: context,
              customSystemPrompt: context.options.customSystemPrompt,
              defaultSystemPrompt: defaultSysPrompt,
              appendSystemPrompt: context.options.appendSystemPrompt
            });
            const [userContext, systemContext] = await Promise.all([getUserContext(), getSystemContext()]);
            const result = await partialCompactConversation(compactMessages, messageIndex, context, {
              systemPrompt,
              userContext,
              systemContext,
              toolUseContext: context,
              forkContextMessages: compactMessages
            }, feedback, direction);
            const kept = result.messagesToKeep ?? [];
            const ordered = direction === 'up_to' ? [...result.summaryMessages, ...kept] : [...kept, ...result.summaryMessages];
            const postCompact = [result.boundaryMarker, ...ordered, ...result.attachments, ...result.hookResults];
            // Fullscreen 的 'from' 保留回滚；'up_to' 不能
            // （old[0] 不变 + 数组增长意味着使用
            // useLogMessages 路径，因此边界从不持久化）。
            // 通过 uuid 查找，因为 old 是原始 REPL 历史，
            // 被裁剪的条目可能会改变投影的 messageIndex
            if (isFullscreenEnvEnabled() && direction === 'from') {
              setMessages(old => {
                const rawIdx = old.findIndex(m => m.uuid === message.uuid);
                return [...old.slice(0, rawIdx === -1 ? 0 : rawIdx), ...postCompact];
              });
            } else {
              setMessages(postCompact);
            }
            // 局部 compact 绕过 handleMessageFromStream —— 清除
            // 上下文阻塞标志，以便主动 tick 恢复
            if (feature('PROACTIVE') || feature('KAIROS')) {
              proactiveModule?.setContextBlocked(false);
            }
            setConversationId(randomUUID());
            runPostCompactCleanup(context.options.querySource);
            if (direction === 'from') {
              const r = textForResubmit(message);
              if (r) {
                setInputValue(r.text);
                setInputMode(r.mode);
              }
            }

            // 显示带 ctrl+o 提示的通知
            const historyShortcut = getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o');
            addNotification({
              key: 'summarize-ctrl-o-hint',
              text: `Conversation summarized (${historyShortcut} for history)`,
              priority: 'medium',
              timeoutMs: 8000
            });
          }} onRestoreMessage={handleRestoreMessage} onClose={() => {
            setIsMessageSelectorVisible(false);
            setMessageSelectorPreselect(undefined);
          }} />}
                {"external" === 'ant' && <DevBar />}
              </Box>
              {feature('BUDDY') && !(companionNarrow && isFullscreenEnvEnabled()) && companionVisible ? <CompanionSprite /> : null}
            </Box>} />
      </MCPConnectionManager>
    </KeybindingSetup>;
  if (isFullscreenEnvEnabled()) {
    return <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>
        {mainReturn}
      </AlternateScreen>;
  }
  return mainReturn;
}
