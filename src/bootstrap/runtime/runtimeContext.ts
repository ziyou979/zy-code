import * as apiTrackingState from '../state/apiTracking.js'
import * as agentRuntimeState from '../state/agentRuntime.js'
import * as clientState from '../state/client.js'
import * as channelPermissionsState from '../state/channelPermissions.js'
import * as configurationState from '../state/configuration.js'
import * as coreState from '../state/core.js'
import * as costState from '../state/cost.js'
import * as diagnosticsState from '../state/diagnostics.js'
import * as durationState from '../state/duration.js'
import * as hooksState from '../state/hooks.js'
import * as modelState from '../state/model.js'
import * as promptState from '../state/prompt.js'
import * as replWireState from '../state/replWire.js'
import * as scrollState from '../state/scroll.js'
import * as sessionMetadataState from '../state/sessionMetadata.js'
import * as sessionState from '../state/session.js'
import * as sessionRuntimeState from '../state/sessionRuntime.js'
import * as skillsState from '../state/skills.js'
import * as telemetryState from '../state/telemetry.js'
import * as tokenState from '../state/tokens.js'

export type { AttributedCounter, ChannelEntry } from '../state/core.js'

// runtimeContext 为嵌入方保留可替换能力，底层直接组合正式领域模块。
const state = {
  ...apiTrackingState,
  ...agentRuntimeState,
  ...clientState,
  ...channelPermissionsState,
  ...configurationState,
  ...coreState,
  ...costState,
  ...diagnosticsState,
  ...durationState,
  ...hooksState,
  ...modelState,
  ...promptState,
  ...replWireState,
  ...scrollState,
  ...sessionMetadataState,
  ...sessionState,
  ...sessionRuntimeState,
  ...skillsState,
  ...telemetryState,
  ...tokenState,
}

type StateModule = typeof state
type RuntimeFunctionName = {
  [K in keyof StateModule]: StateModule[K] extends (...args: never[]) => unknown ? K : never
}[keyof StateModule]

/** 可在入口或测试中替换的最小运行时函数集合。 */
export type RuntimeContextOverrides = Partial<Pick<StateModule, RuntimeFunctionName>>

let runtimeOverrides: RuntimeContextOverrides = {}

/**
 * 注入运行时能力。未提供的函数继续使用正式状态模块中的实时 accessor，
 * 因而迁移消费者时不会缓存会话快照，也不会改变 accessor 的实时语义。
 */
export function configureRuntimeContext(overrides: RuntimeContextOverrides): void {
  runtimeOverrides = { ...runtimeOverrides, ...overrides }
}

/** 清除测试或嵌入方注入的运行时能力。 */
export function resetRuntimeContext(): void {
  runtimeOverrides = {}
}

function resolveRuntimeFunction<K extends RuntimeFunctionName>(name: K): StateModule[K] {
  return (runtimeOverrides[name] ?? state[name]) as StateModule[K]
}

export const addInvokedSkill: StateModule['addInvokedSkill'] = (...args) =>
  resolveRuntimeFunction('addInvokedSkill')(...args)

export const addToToolDuration: StateModule['addToToolDuration'] = (...args) =>
  resolveRuntimeFunction('addToToolDuration')(...args)

export const addToTotalDurationState: StateModule['addToTotalDurationState'] = (...args) =>
  resolveRuntimeFunction('addToTotalDurationState')(...args)

export const addToTurnClassifierDuration: StateModule['addToTurnClassifierDuration'] = (...args) =>
  resolveRuntimeFunction('addToTurnClassifierDuration')(...args)

export const addToTurnHookDuration: StateModule['addToTurnHookDuration'] = (...args) =>
  resolveRuntimeFunction('addToTurnHookDuration')(...args)

export const clearRegisteredPluginHooks: StateModule['clearRegisteredPluginHooks'] = (...args) =>
  resolveRuntimeFunction('clearRegisteredPluginHooks')(...args)

export const consumePostCompaction: StateModule['consumePostCompaction'] = (...args) =>
  resolveRuntimeFunction('consumePostCompaction')(...args)

export const getAdditionalDirectoriesForAgentsMd: StateModule['getAdditionalDirectoriesForAgentsMd'] =
  (...args) => resolveRuntimeFunction('getAdditionalDirectoriesForAgentsMd')(...args)

export const getAfkModeHeaderLatched: StateModule['getAfkModeHeaderLatched'] = (...args) =>
  resolveRuntimeFunction('getAfkModeHeaderLatched')(...args)

export const getAllowedChannels: StateModule['getAllowedChannels'] = (...args) =>
  resolveRuntimeFunction('getAllowedChannels')(...args)

export const getCacheEditingHeaderLatched: StateModule['getCacheEditingHeaderLatched'] = (
  ...args
) => resolveRuntimeFunction('getCacheEditingHeaderLatched')(...args)

export const getChannelPermissionCallbacks: StateModule['getChannelPermissionCallbacks'] = (
  ...args
) => resolveRuntimeFunction('getChannelPermissionCallbacks')(...args)

export const getCachedAgentsMdContent: StateModule['getCachedAgentsMdContent'] = (...args) =>
  resolveRuntimeFunction('getCachedAgentsMdContent')(...args)

export const getChromeFlagOverride: StateModule['getChromeFlagOverride'] = (...args) =>
  resolveRuntimeFunction('getChromeFlagOverride')(...args)

export const getClientType: StateModule['getClientType'] = (...args) =>
  resolveRuntimeFunction('getClientType')(...args)

export const getCodeEditToolDecisionCounter: StateModule['getCodeEditToolDecisionCounter'] = (
  ...args
) => resolveRuntimeFunction('getCodeEditToolDecisionCounter')(...args)

export const getCurrentTurnTokenBudget: StateModule['getCurrentTurnTokenBudget'] = (...args) =>
  resolveRuntimeFunction('getCurrentTurnTokenBudget')(...args)

export const getCwdState: StateModule['getCwdState'] = (...args) =>
  resolveRuntimeFunction('getCwdState')(...args)

export const getEventLogger: StateModule['getEventLogger'] = (...args) =>
  resolveRuntimeFunction('getEventLogger')(...args)

export const getFlagSettingsPath: StateModule['getFlagSettingsPath'] = (...args) =>
  resolveRuntimeFunction('getFlagSettingsPath')(...args)

export const getInitialMainLoopModel: StateModule['getInitialMainLoopModel'] = (...args) =>
  resolveRuntimeFunction('getInitialMainLoopModel')(...args)

export const getInlinePlugins: StateModule['getInlinePlugins'] = (...args) =>
  resolveRuntimeFunction('getInlinePlugins')(...args)

export const getInvokedSkillsForAgent: StateModule['getInvokedSkillsForAgent'] = (...args) =>
  resolveRuntimeFunction('getInvokedSkillsForAgent')(...args)

export const getIsInteractive: StateModule['getIsInteractive'] = (...args) =>
  resolveRuntimeFunction('getIsInteractive')(...args)

export const getIsNonInteractiveSession: StateModule['getIsNonInteractiveSession'] = (...args) =>
  resolveRuntimeFunction('getIsNonInteractiveSession')(...args)

export const getIsRemoteMode: StateModule['getIsRemoteMode'] = (...args) =>
  resolveRuntimeFunction('getIsRemoteMode')(...args)

export const getAllowedSettingSources: StateModule['getAllowedSettingSources'] = (...args) =>
  resolveRuntimeFunction('getAllowedSettingSources')(...args)

export const getFlagSettingsInline: StateModule['getFlagSettingsInline'] = (...args) =>
  resolveRuntimeFunction('getFlagSettingsInline')(...args)

export const getUseCoworkPlugins: StateModule['getUseCoworkPlugins'] = (...args) =>
  resolveRuntimeFunction('getUseCoworkPlugins')(...args)

export const getIsScrollDraining: StateModule['getIsScrollDraining'] = (...args) =>
  resolveRuntimeFunction('getIsScrollDraining')(...args)

export const getKairosActive: StateModule['getKairosActive'] = (...args) =>
  resolveRuntimeFunction('getKairosActive')(...args)

export const getLastApiCompletionTimestamp: StateModule['getLastApiCompletionTimestamp'] = (
  ...args
) => resolveRuntimeFunction('getLastApiCompletionTimestamp')(...args)

export const getLastClassifierRequests: StateModule['getLastClassifierRequests'] = (...args) =>
  resolveRuntimeFunction('getLastClassifierRequests')(...args)

export const getLastEmittedDate: StateModule['getLastEmittedDate'] = (...args) =>
  resolveRuntimeFunction('getLastEmittedDate')(...args)

export const getLoggerProvider: StateModule['getLoggerProvider'] = (...args) =>
  resolveRuntimeFunction('getLoggerProvider')(...args)

export const getMainLoopModelOverride: StateModule['getMainLoopModelOverride'] = (...args) =>
  resolveRuntimeFunction('getMainLoopModelOverride')(...args)

export const getMainThreadAgentType: StateModule['getMainThreadAgentType'] = (...args) =>
  resolveRuntimeFunction('getMainThreadAgentType')(...args)

export const getMeterProvider: StateModule['getMeterProvider'] = (...args) =>
  resolveRuntimeFunction('getMeterProvider')(...args)

export const getModelStrings: StateModule['getModelStrings'] = (...args) =>
  resolveRuntimeFunction('getModelStrings')(...args)

export const getOriginalCwd: StateModule['getOriginalCwd'] = (...args) =>
  resolveRuntimeFunction('getOriginalCwd')(...args)

export const getParentSessionId: StateModule['getParentSessionId'] = (...args) =>
  resolveRuntimeFunction('getParentSessionId')(...args)

export const getPlanSlugCache: StateModule['getPlanSlugCache'] = (...args) =>
  resolveRuntimeFunction('getPlanSlugCache')(...args)

export const getProjectRoot: StateModule['getProjectRoot'] = (...args) =>
  resolveRuntimeFunction('getProjectRoot')(...args)

export const getPromptId: StateModule['getPromptId'] = (...args) =>
  resolveRuntimeFunction('getPromptId')(...args)

export const getRegisteredHooks: StateModule['getRegisteredHooks'] = (...args) =>
  resolveRuntimeFunction('getRegisteredHooks')(...args)

export const getSessionBypassPermissionsMode: StateModule['getSessionBypassPermissionsMode'] = (
  ...args
) => resolveRuntimeFunction('getSessionBypassPermissionsMode')(...args)

export const getSessionCreatedTeams: StateModule['getSessionCreatedTeams'] = (...args) =>
  resolveRuntimeFunction('getSessionCreatedTeams')(...args)

export const getSessionId: StateModule['getSessionId'] = (...args) =>
  resolveRuntimeFunction('getSessionId')(...args)

export const getSessionProjectDir: StateModule['getSessionProjectDir'] = (...args) =>
  resolveRuntimeFunction('getSessionProjectDir')(...args)

export const getSessionTrustAccepted: StateModule['getSessionTrustAccepted'] = (...args) =>
  resolveRuntimeFunction('getSessionTrustAccepted')(...args)

export const getStatsStore: StateModule['getStatsStore'] = (...args) =>
  resolveRuntimeFunction('getStatsStore')(...args)

export const getTeleportedSessionInfo: StateModule['getTeleportedSessionInfo'] = (...args) =>
  resolveRuntimeFunction('getTeleportedSessionInfo')(...args)

export const getThinkingClearLatched: StateModule['getThinkingClearLatched'] = (...args) =>
  resolveRuntimeFunction('getThinkingClearLatched')(...args)

export const getTotalCacheCreationInputTokens: StateModule['getTotalCacheCreationInputTokens'] = (
  ...args
) => resolveRuntimeFunction('getTotalCacheCreationInputTokens')(...args)

export const getTotalCacheReadInputTokens: StateModule['getTotalCacheReadInputTokens'] = (
  ...args
) => resolveRuntimeFunction('getTotalCacheReadInputTokens')(...args)

export const getTotalCost: StateModule['getTotalCost'] = (...args) =>
  resolveRuntimeFunction('getTotalCost')(...args)

export const getTotalInputTokens: StateModule['getTotalInputTokens'] = (...args) =>
  resolveRuntimeFunction('getTotalInputTokens')(...args)

export const getTotalOutputTokens: StateModule['getTotalOutputTokens'] = (...args) =>
  resolveRuntimeFunction('getTotalOutputTokens')(...args)

export const getTracerProvider: StateModule['getTracerProvider'] = (...args) =>
  resolveRuntimeFunction('getTracerProvider')(...args)

export const getTurnOutputTokens: StateModule['getTurnOutputTokens'] = (...args) =>
  resolveRuntimeFunction('getTurnOutputTokens')(...args)

export const handleAutoModeTransition: StateModule['handleAutoModeTransition'] = (...args) =>
  resolveRuntimeFunction('handleAutoModeTransition')(...args)

export const handlePlanModeTransition: StateModule['handlePlanModeTransition'] = (...args) =>
  resolveRuntimeFunction('handlePlanModeTransition')(...args)

export const hasExitedPlanModeInSession: StateModule['hasExitedPlanModeInSession'] = (...args) =>
  resolveRuntimeFunction('hasExitedPlanModeInSession')(...args)

export const isSessionPersistenceDisabled: StateModule['isSessionPersistenceDisabled'] = (
  ...args
) => resolveRuntimeFunction('isSessionPersistenceDisabled')(...args)

export const markFirstTeleportMessageLogged: StateModule['markFirstTeleportMessageLogged'] = (
  ...args
) => resolveRuntimeFunction('markFirstTeleportMessageLogged')(...args)

export const markPostCompaction: StateModule['markPostCompaction'] = (...args) =>
  resolveRuntimeFunction('markPostCompaction')(...args)

export const needsAutoModeExitAttachment: StateModule['needsAutoModeExitAttachment'] = (...args) =>
  resolveRuntimeFunction('needsAutoModeExitAttachment')(...args)

export const needsPlanModeExitAttachment: StateModule['needsPlanModeExitAttachment'] = (...args) =>
  resolveRuntimeFunction('needsPlanModeExitAttachment')(...args)

export const registerHookCallbacks: StateModule['registerHookCallbacks'] = (...args) =>
  resolveRuntimeFunction('registerHookCallbacks')(...args)

export const resetSdkInitState: StateModule['resetSdkInitState'] = (...args) =>
  resolveRuntimeFunction('resetSdkInitState')(...args)

export const setAfkModeHeaderLatched: StateModule['setAfkModeHeaderLatched'] = (...args) =>
  resolveRuntimeFunction('setAfkModeHeaderLatched')(...args)

export const setCacheEditingHeaderLatched: StateModule['setCacheEditingHeaderLatched'] = (
  ...args
) => resolveRuntimeFunction('setCacheEditingHeaderLatched')(...args)

export const setEventLogger: StateModule['setEventLogger'] = (...args) =>
  resolveRuntimeFunction('setEventLogger')(...args)

export const setHasExitedPlanMode: StateModule['setHasExitedPlanMode'] = (...args) =>
  resolveRuntimeFunction('setHasExitedPlanMode')(...args)

export const setLastApiCompletionTimestamp: StateModule['setLastApiCompletionTimestamp'] = (
  ...args
) => resolveRuntimeFunction('setLastApiCompletionTimestamp')(...args)

export const setLastClassifierRequests: StateModule['setLastClassifierRequests'] = (...args) =>
  resolveRuntimeFunction('setLastClassifierRequests')(...args)

export const setLastEmittedDate: StateModule['setLastEmittedDate'] = (...args) =>
  resolveRuntimeFunction('setLastEmittedDate')(...args)

export const setLastMainRequestId: StateModule['setLastMainRequestId'] = (...args) =>
  resolveRuntimeFunction('setLastMainRequestId')(...args)

export const setLoggerProvider: StateModule['setLoggerProvider'] = (...args) =>
  resolveRuntimeFunction('setLoggerProvider')(...args)

export const setMeterProvider: StateModule['setMeterProvider'] = (...args) =>
  resolveRuntimeFunction('setMeterProvider')(...args)

export const setModelStrings: StateModule['setModelStrings'] = (...args) =>
  resolveRuntimeFunction('setModelStrings')(...args)

export const setNeedsAutoModeExitAttachment: StateModule['setNeedsAutoModeExitAttachment'] = (
  ...args
) => resolveRuntimeFunction('setNeedsAutoModeExitAttachment')(...args)

export const setNeedsPlanModeExitAttachment: StateModule['setNeedsPlanModeExitAttachment'] = (
  ...args
) => resolveRuntimeFunction('setNeedsPlanModeExitAttachment')(...args)

export const setPromptId: StateModule['setPromptId'] = (...args) =>
  resolveRuntimeFunction('setPromptId')(...args)

export const setThinkingClearLatched: StateModule['setThinkingClearLatched'] = (...args) =>
  resolveRuntimeFunction('setThinkingClearLatched')(...args)

export const setTracerProvider: StateModule['setTracerProvider'] = (...args) =>
  resolveRuntimeFunction('setTracerProvider')(...args)

export const switchSession: StateModule['switchSession'] = (...args) =>
  resolveRuntimeFunction('switchSession')(...args)

export const waitForScrollIdle: StateModule['waitForScrollIdle'] = (...args) =>
  resolveRuntimeFunction('waitForScrollIdle')(...args)

export const onSessionSwitch: StateModule['onSessionSwitch'] = (...args) =>
  resolveRuntimeFunction('onSessionSwitch')(...args)

export const getSlowOperations: StateModule['getSlowOperations'] = (...args) =>
  resolveRuntimeFunction('getSlowOperations')(...args)

export const getLastAPIRequest: StateModule['getLastAPIRequest'] = (...args) =>
  resolveRuntimeFunction('getLastAPIRequest')(...args)

export const getHasDevChannels: StateModule['getHasDevChannels'] = (...args) =>
  resolveRuntimeFunction('getHasDevChannels')(...args)

export const getUserMsgOptIn: StateModule['getUserMsgOptIn'] = (...args) =>
  resolveRuntimeFunction('getUserMsgOptIn')(...args)

export const setUserMsgOptIn: StateModule['setUserMsgOptIn'] = (...args) =>
  resolveRuntimeFunction('setUserMsgOptIn')(...args)

export const setSessionTrustAccepted: StateModule['setSessionTrustAccepted'] = (...args) =>
  resolveRuntimeFunction('setSessionTrustAccepted')(...args)

export const setHasUnknownModelCost: StateModule['setHasUnknownModelCost'] = (...args) =>
  resolveRuntimeFunction('setHasUnknownModelCost')(...args)

export const getActiveTimeCounter: StateModule['getActiveTimeCounter'] = (...args) =>
  resolveRuntimeFunction('getActiveTimeCounter')(...args)

export const getApiKeyFromFd: StateModule['getApiKeyFromFd'] = (...args) =>
  resolveRuntimeFunction('getApiKeyFromFd')(...args)

export const getOauthTokenFromFd: StateModule['getOauthTokenFromFd'] = (...args) =>
  resolveRuntimeFunction('getOauthTokenFromFd')(...args)

export const setApiKeyFromFd: StateModule['setApiKeyFromFd'] = (...args) =>
  resolveRuntimeFunction('setApiKeyFromFd')(...args)

export const setOauthTokenFromFd: StateModule['setOauthTokenFromFd'] = (...args) =>
  resolveRuntimeFunction('setOauthTokenFromFd')(...args)

export const addSessionCronTask: StateModule['addSessionCronTask'] = (...args) =>
  resolveRuntimeFunction('addSessionCronTask')(...args)

export const getSessionCronTasks: StateModule['getSessionCronTasks'] = (...args) =>
  resolveRuntimeFunction('getSessionCronTasks')(...args)

export const removeSessionCronTasks: StateModule['removeSessionCronTasks'] = (...args) =>
  resolveRuntimeFunction('removeSessionCronTasks')(...args)

export const setLastAPIRequest: StateModule['setLastAPIRequest'] = (...args) =>
  resolveRuntimeFunction('setLastAPIRequest')(...args)

export const setLastAPIRequestMessages: StateModule['setLastAPIRequestMessages'] = (...args) =>
  resolveRuntimeFunction('setLastAPIRequestMessages')(...args)

export const getSessionIngressToken: StateModule['getSessionIngressToken'] = (...args) =>
  resolveRuntimeFunction('getSessionIngressToken')(...args)

export const setSessionIngressToken: StateModule['setSessionIngressToken'] = (...args) =>
  resolveRuntimeFunction('setSessionIngressToken')(...args)

export const addSlowOperation: StateModule['addSlowOperation'] = (...args) =>
  resolveRuntimeFunction('addSlowOperation')(...args)

export const addToInMemoryErrorLog: StateModule['addToInMemoryErrorLog'] = (...args) =>
  resolveRuntimeFunction('addToInMemoryErrorLog')(...args)

export const addToTotalCostState: StateModule['addToTotalCostState'] = (...args) =>
  resolveRuntimeFunction('addToTotalCostState')(...args)

export const addToTotalLinesChanged: StateModule['addToTotalLinesChanged'] = (...args) =>
  resolveRuntimeFunction('addToTotalLinesChanged')(...args)

export const clearBetaHeaderLatches: StateModule['clearBetaHeaderLatches'] = (...args) =>
  resolveRuntimeFunction('clearBetaHeaderLatches')(...args)

export const clearInvokedSkills: StateModule['clearInvokedSkills'] = (...args) =>
  resolveRuntimeFunction('clearInvokedSkills')(...args)

export const clearInvokedSkillsForAgent: StateModule['clearInvokedSkillsForAgent'] = (...args) =>
  resolveRuntimeFunction('clearInvokedSkillsForAgent')(...args)

export const clearRegisteredHooks: StateModule['clearRegisteredHooks'] = (...args) =>
  resolveRuntimeFunction('clearRegisteredHooks')(...args)

export const clearSystemPromptSectionState: StateModule['clearSystemPromptSectionState'] = (
  ...args
) => resolveRuntimeFunction('clearSystemPromptSectionState')(...args)

export const flushInteractionTime: StateModule['flushInteractionTime'] = (...args) =>
  resolveRuntimeFunction('flushInteractionTime')(...args)

export const getAgentColorMap: StateModule['getAgentColorMap'] = (...args) =>
  resolveRuntimeFunction('getAgentColorMap')(...args)

export const getBudgetContinuationCount: StateModule['getBudgetContinuationCount'] = (...args) =>
  resolveRuntimeFunction('getBudgetContinuationCount')(...args)

export const getCommitCounter: StateModule['getCommitCounter'] = (...args) =>
  resolveRuntimeFunction('getCommitCounter')(...args)

export const getCostCounter: StateModule['getCostCounter'] = (...args) =>
  resolveRuntimeFunction('getCostCounter')(...args)

export const getDirectConnectServerUrl: StateModule['getDirectConnectServerUrl'] = (...args) =>
  resolveRuntimeFunction('getDirectConnectServerUrl')(...args)

export const getInitJsonSchema: StateModule['getInitJsonSchema'] = (...args) =>
  resolveRuntimeFunction('getInitJsonSchema')(...args)

export const getInvokedSkills: StateModule['getInvokedSkills'] = (...args) =>
  resolveRuntimeFunction('getInvokedSkills')(...args)

export const getLastAPIRequestMessages: StateModule['getLastAPIRequestMessages'] = (...args) =>
  resolveRuntimeFunction('getLastAPIRequestMessages')(...args)

export const getLastInteractionTime: StateModule['getLastInteractionTime'] = (...args) =>
  resolveRuntimeFunction('getLastInteractionTime')(...args)

export const getLastMainRequestId: StateModule['getLastMainRequestId'] = (...args) =>
  resolveRuntimeFunction('getLastMainRequestId')(...args)

export const getLocCounter: StateModule['getLocCounter'] = (...args) =>
  resolveRuntimeFunction('getLocCounter')(...args)

export const getMeter: StateModule['getMeter'] = (...args) =>
  resolveRuntimeFunction('getMeter')(...args)

export const getModelUsage: StateModule['getModelUsage'] = (...args) =>
  resolveRuntimeFunction('getModelUsage')(...args)

export const getPrCounter: StateModule['getPrCounter'] = (...args) =>
  resolveRuntimeFunction('getPrCounter')(...args)

export const getQuestionPreviewFormat: StateModule['getQuestionPreviewFormat'] = (...args) =>
  resolveRuntimeFunction('getQuestionPreviewFormat')(...args)

export const getScheduledTasksEnabled: StateModule['getScheduledTasksEnabled'] = (...args) =>
  resolveRuntimeFunction('getScheduledTasksEnabled')(...args)

export const getSdkAgentProgressSummariesEnabled: StateModule['getSdkAgentProgressSummariesEnabled'] =
  (...args) => resolveRuntimeFunction('getSdkAgentProgressSummariesEnabled')(...args)

export const getSdkBetas: StateModule['getSdkBetas'] = (...args) =>
  resolveRuntimeFunction('getSdkBetas')(...args)

export const getSessionCounter: StateModule['getSessionCounter'] = (...args) =>
  resolveRuntimeFunction('getSessionCounter')(...args)

export const getSessionSource: StateModule['getSessionSource'] = (...args) =>
  resolveRuntimeFunction('getSessionSource')(...args)

export const getStrictToolResultPairing: StateModule['getStrictToolResultPairing'] = (...args) =>
  resolveRuntimeFunction('getStrictToolResultPairing')(...args)

export const getSystemPromptSectionCache: StateModule['getSystemPromptSectionCache'] = (...args) =>
  resolveRuntimeFunction('getSystemPromptSectionCache')(...args)

export const getTokenCounter: StateModule['getTokenCounter'] = (...args) =>
  resolveRuntimeFunction('getTokenCounter')(...args)

export const getTotalAPIDuration: StateModule['getTotalAPIDuration'] = (...args) =>
  resolveRuntimeFunction('getTotalAPIDuration')(...args)

export const getTotalAPIDurationWithoutRetries: StateModule['getTotalAPIDurationWithoutRetries'] = (
  ...args
) => resolveRuntimeFunction('getTotalAPIDurationWithoutRetries')(...args)

export const getTotalCostByCurrency: StateModule['getTotalCostByCurrency'] = (...args) =>
  resolveRuntimeFunction('getTotalCostByCurrency')(...args)

export const getTotalDuration: StateModule['getTotalDuration'] = (...args) =>
  resolveRuntimeFunction('getTotalDuration')(...args)

export const getTotalLinesAdded: StateModule['getTotalLinesAdded'] = (...args) =>
  resolveRuntimeFunction('getTotalLinesAdded')(...args)

export const getTotalLinesRemoved: StateModule['getTotalLinesRemoved'] = (...args) =>
  resolveRuntimeFunction('getTotalLinesRemoved')(...args)

export const getTotalToolDuration: StateModule['getTotalToolDuration'] = (...args) =>
  resolveRuntimeFunction('getTotalToolDuration')(...args)

export const getTotalWebSearchRequests: StateModule['getTotalWebSearchRequests'] = (...args) =>
  resolveRuntimeFunction('getTotalWebSearchRequests')(...args)

export const getTurnClassifierCount: StateModule['getTurnClassifierCount'] = (...args) =>
  resolveRuntimeFunction('getTurnClassifierCount')(...args)

export const getTurnClassifierDurationMs: StateModule['getTurnClassifierDurationMs'] = (...args) =>
  resolveRuntimeFunction('getTurnClassifierDurationMs')(...args)

export const getTurnHookCount: StateModule['getTurnHookCount'] = (...args) =>
  resolveRuntimeFunction('getTurnHookCount')(...args)

export const getTurnHookDurationMs: StateModule['getTurnHookDurationMs'] = (...args) =>
  resolveRuntimeFunction('getTurnHookDurationMs')(...args)

export const getTurnToolCount: StateModule['getTurnToolCount'] = (...args) =>
  resolveRuntimeFunction('getTurnToolCount')(...args)

export const getTurnToolDurationMs: StateModule['getTurnToolDurationMs'] = (...args) =>
  resolveRuntimeFunction('getTurnToolDurationMs')(...args)

export const getUsageForModel: StateModule['getUsageForModel'] = (...args) =>
  resolveRuntimeFunction('getUsageForModel')(...args)

export const hasShownLspRecommendationThisSession: StateModule['hasShownLspRecommendationThisSession'] =
  (...args) => resolveRuntimeFunction('hasShownLspRecommendationThisSession')(...args)

export const hasUnknownModelCost: StateModule['hasUnknownModelCost'] = (...args) =>
  resolveRuntimeFunction('hasUnknownModelCost')(...args)

export const incrementBudgetContinuationCount: StateModule['incrementBudgetContinuationCount'] = (
  ...args
) => resolveRuntimeFunction('incrementBudgetContinuationCount')(...args)

export const isReplWireActive: StateModule['isReplWireActive'] = (...args) =>
  resolveRuntimeFunction('isReplWireActive')(...args)

export const markScrollActivity: StateModule['markScrollActivity'] = (...args) =>
  resolveRuntimeFunction('markScrollActivity')(...args)

export const preferThirdPartyAuthentication: StateModule['preferThirdPartyAuthentication'] = (
  ...args
) => resolveRuntimeFunction('preferThirdPartyAuthentication')(...args)

export const regenerateSessionId: StateModule['regenerateSessionId'] = (...args) =>
  resolveRuntimeFunction('regenerateSessionId')(...args)

export const resetCostState: StateModule['resetCostState'] = (...args) =>
  resolveRuntimeFunction('resetCostState')(...args)

export const resetModelStringsForTestingOnly: StateModule['resetModelStringsForTestingOnly'] = (
  ...args
) => resolveRuntimeFunction('resetModelStringsForTestingOnly')(...args)

export const resetStateForTests: StateModule['resetStateForTests'] = (...args) =>
  resolveRuntimeFunction('resetStateForTests')(...args)

export const resetTotalDurationStateAndCost_FOR_TESTS_ONLY: StateModule['resetTotalDurationStateAndCost_FOR_TESTS_ONLY'] =
  (...args) => resolveRuntimeFunction('resetTotalDurationStateAndCost_FOR_TESTS_ONLY')(...args)

export const resetTurnClassifierDuration: StateModule['resetTurnClassifierDuration'] = (...args) =>
  resolveRuntimeFunction('resetTurnClassifierDuration')(...args)

export const resetTurnHookDuration: StateModule['resetTurnHookDuration'] = (...args) =>
  resolveRuntimeFunction('resetTurnHookDuration')(...args)

export const resetTurnToolDuration: StateModule['resetTurnToolDuration'] = (...args) =>
  resolveRuntimeFunction('resetTurnToolDuration')(...args)

export const setAdditionalDirectoriesForAgentsMd: StateModule['setAdditionalDirectoriesForAgentsMd'] =
  (...args) => resolveRuntimeFunction('setAdditionalDirectoriesForAgentsMd')(...args)

export const setAllowedChannels: StateModule['setAllowedChannels'] = (...args) =>
  resolveRuntimeFunction('setAllowedChannels')(...args)

export const setAllowedSettingSources: StateModule['setAllowedSettingSources'] = (...args) =>
  resolveRuntimeFunction('setAllowedSettingSources')(...args)

export const setCachedAgentsMdContent: StateModule['setCachedAgentsMdContent'] = (...args) =>
  resolveRuntimeFunction('setCachedAgentsMdContent')(...args)

export const setChromeFlagOverride: StateModule['setChromeFlagOverride'] = (...args) =>
  resolveRuntimeFunction('setChromeFlagOverride')(...args)

export const setClientType: StateModule['setClientType'] = (...args) =>
  resolveRuntimeFunction('setClientType')(...args)

export const setCostStateForRestore: StateModule['setCostStateForRestore'] = (...args) =>
  resolveRuntimeFunction('setCostStateForRestore')(...args)

export const setCwdState: StateModule['setCwdState'] = (...args) =>
  resolveRuntimeFunction('setCwdState')(...args)

export const setDirectConnectServerUrl: StateModule['setDirectConnectServerUrl'] = (...args) =>
  resolveRuntimeFunction('setDirectConnectServerUrl')(...args)

export const setFlagSettingsInline: StateModule['setFlagSettingsInline'] = (...args) =>
  resolveRuntimeFunction('setFlagSettingsInline')(...args)

export const setFlagSettingsPath: StateModule['setFlagSettingsPath'] = (...args) =>
  resolveRuntimeFunction('setFlagSettingsPath')(...args)

export const setHasDevChannels: StateModule['setHasDevChannels'] = (...args) =>
  resolveRuntimeFunction('setHasDevChannels')(...args)

export const setInitJsonSchema: StateModule['setInitJsonSchema'] = (...args) =>
  resolveRuntimeFunction('setInitJsonSchema')(...args)

export const setInitialMainLoopModel: StateModule['setInitialMainLoopModel'] = (...args) =>
  resolveRuntimeFunction('setInitialMainLoopModel')(...args)

export const setInlinePlugins: StateModule['setInlinePlugins'] = (...args) =>
  resolveRuntimeFunction('setInlinePlugins')(...args)

export const setIsInteractive: StateModule['setIsInteractive'] = (...args) =>
  resolveRuntimeFunction('setIsInteractive')(...args)

export const setIsRemoteMode: StateModule['setIsRemoteMode'] = (...args) =>
  resolveRuntimeFunction('setIsRemoteMode')(...args)

export const setKairosActive: StateModule['setKairosActive'] = (...args) =>
  resolveRuntimeFunction('setKairosActive')(...args)

export const setLspRecommendationShownThisSession: StateModule['setLspRecommendationShownThisSession'] =
  (...args) => resolveRuntimeFunction('setLspRecommendationShownThisSession')(...args)

export const setMainLoopModelOverride: StateModule['setMainLoopModelOverride'] = (...args) =>
  resolveRuntimeFunction('setMainLoopModelOverride')(...args)

export const setMainThreadAgentType: StateModule['setMainThreadAgentType'] = (...args) =>
  resolveRuntimeFunction('setMainThreadAgentType')(...args)

export const setMeter: StateModule['setMeter'] = (...args) =>
  resolveRuntimeFunction('setMeter')(...args)

export const setOriginalCwd: StateModule['setOriginalCwd'] = (...args) =>
  resolveRuntimeFunction('setOriginalCwd')(...args)

export const setProjectRoot: StateModule['setProjectRoot'] = (...args) =>
  resolveRuntimeFunction('setProjectRoot')(...args)

export const setQuestionPreviewFormat: StateModule['setQuestionPreviewFormat'] = (...args) =>
  resolveRuntimeFunction('setQuestionPreviewFormat')(...args)

export const setScheduledTasksEnabled: StateModule['setScheduledTasksEnabled'] = (...args) =>
  resolveRuntimeFunction('setScheduledTasksEnabled')(...args)

export const setSdkAgentProgressSummariesEnabled: StateModule['setSdkAgentProgressSummariesEnabled'] =
  (...args) => resolveRuntimeFunction('setSdkAgentProgressSummariesEnabled')(...args)

export const setSdkBetas: StateModule['setSdkBetas'] = (...args) =>
  resolveRuntimeFunction('setSdkBetas')(...args)

export const setSessionBypassPermissionsMode: StateModule['setSessionBypassPermissionsMode'] = (
  ...args
) => resolveRuntimeFunction('setSessionBypassPermissionsMode')(...args)

export const setSessionPersistenceDisabled: StateModule['setSessionPersistenceDisabled'] = (
  ...args
) => resolveRuntimeFunction('setSessionPersistenceDisabled')(...args)

export const setSessionSource: StateModule['setSessionSource'] = (...args) =>
  resolveRuntimeFunction('setSessionSource')(...args)

export const setChannelPermissionCallbacks: StateModule['setChannelPermissionCallbacks'] = (
  ...args
) => resolveRuntimeFunction('setChannelPermissionCallbacks')(...args)

export const setStatsStore: StateModule['setStatsStore'] = (...args) =>
  resolveRuntimeFunction('setStatsStore')(...args)

export const setStrictToolResultPairing: StateModule['setStrictToolResultPairing'] = (...args) =>
  resolveRuntimeFunction('setStrictToolResultPairing')(...args)

export const setSystemPromptSectionCacheEntry: StateModule['setSystemPromptSectionCacheEntry'] = (
  ...args
) => resolveRuntimeFunction('setSystemPromptSectionCacheEntry')(...args)

export const setTeleportedSessionInfo: StateModule['setTeleportedSessionInfo'] = (...args) =>
  resolveRuntimeFunction('setTeleportedSessionInfo')(...args)

export const setUseCoworkPlugins: StateModule['setUseCoworkPlugins'] = (...args) =>
  resolveRuntimeFunction('setUseCoworkPlugins')(...args)

export const snapshotOutputTokensForTurn: StateModule['snapshotOutputTokensForTurn'] = (...args) =>
  resolveRuntimeFunction('snapshotOutputTokensForTurn')(...args)

export const updateLastInteractionTime: StateModule['updateLastInteractionTime'] = (...args) =>
  resolveRuntimeFunction('updateLastInteractionTime')(...args)
