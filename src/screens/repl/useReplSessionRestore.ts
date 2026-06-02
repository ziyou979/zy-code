// 会话恢复（--continue / --resume / teleport / fork）。
// 抽自 screens/REPL.tsx 1403-1665。
//
// 初始化时一次性运行，与主查询循环解耦。
// 返回 resume callback 供 getToolUseContext 传给 query engine。
// 同时包含 initialMessages mount effect（props 传入的消息恢复 readFileState）。

import { feature } from 'bun:bundle'
import type { UUID } from 'node:crypto'
import { dirname } from 'node:path'
import type React from 'react'
import { useCallback, useEffect } from 'react'
import { setCostStateForRestore } from '../../bootstrap/state/cost.js'
import { switchSession } from '../../bootstrap/state/session.js'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import {
  getStoredSessionCosts,
  resetCostState,
  saveCurrentSessionCosts,
} from '../../cost-tracker.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { useAppStateStore, useSetAppState } from '../../state/AppState.js'
import type { ReplStoreInstance } from '../../state/ReplStore.js'
import { restoreRemoteAgentTasks } from '../../tasks/RemoteAgentTask/RemoteAgentTask.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { ResumeEntrypoint } from '../../types/command.js'
import { asSessionId } from '../../types/ids.js'
import type { LogOption } from '../../types/logs.js'
import type { Message as MessageType } from '../../types/message.js'
import { updateSessionName } from '../../utils/concurrentSessions.js'
import { deserializeMessages } from '../../utils/conversationRecovery.js'
import { copyFileHistoryForResume } from '../../utils/fileHistory.js'
import { executeSessionEndHooks, getSessionEndHookTimeoutMs } from '../../utils/hooks.js'
import { createSystemMessage } from '../../utils/messages.js'
import { copyPlanForFork, copyPlanForResume } from '../../utils/plans.js'
import {
  computeStandaloneAgentContext,
  exitRestoredWorktree,
  restoreAgentFromSession,
  restoreSessionStateFromLog,
  restoreWorktreeForResume,
} from '../../utils/sessionRestore.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import {
  clearSessionMetadata,
  restoreSessionMetadata,
} from '../../utils/sessionStorage/sessionMetadata.js'
import {
  adoptResumedSessionFile,
  resetSessionFilePointer,
} from '../../utils/sessionStorage/transcript.js'
import {
  cacheSessionTitle,
  getCurrentSessionTitle,
  saveAiGeneratedTitle,
  saveWorktreeState,
} from '../../utils/sessionStorage.js'
import { generateSessionTitle } from '../../utils/sessionTitle.js'
import { reconstructContentReplacementState } from '../../utils/toolResultStorage.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'

// ── 公共类型 ──────────────────────────────────────────────

export type UseReplSessionRestoreParams = {
  initialMessages: MessageType[] | undefined
  initialMainThreadAgentDefinition: AgentDefinition | undefined
  replStore: ReplStoreInstance
  // REPL local state / callbacks
  setInputValue: (value: string) => void
  setToolJSX: (jsx: null) => void
  setAbortController: React.Dispatch<React.SetStateAction<AbortController | null>>
  mainThreadAgentDefinition: AgentDefinition | undefined
  setMainThreadAgentDefinition: React.Dispatch<React.SetStateAction<AgentDefinition | undefined>>
  resetLoadingState: () => void
  restoreReadFileState: (messages: MessageType[], cwd: string) => void
  forceRenderTitle: React.Dispatch<React.SetStateAction<number>>
}

export type ResumeFunction = (
  sessionId: UUID,
  log: LogOption,
  entrypoint: ResumeEntrypoint,
) => Promise<void>

// ── 主 hook ──────────────────────────────────────────────

export function useReplSessionRestore({
  initialMessages,
  initialMainThreadAgentDefinition,
  replStore,
  setInputValue,
  setToolJSX,
  setAbortController,
  mainThreadAgentDefinition,
  setMainThreadAgentDefinition,
  resetLoadingState,
  restoreReadFileState,
  forceRenderTitle,
}: UseReplSessionRestoreParams): ResumeFunction {
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  const mainLoopModel = useMainLoopModel()
  const agentDefinitions = store.getState().agentDefinitions

  const resume: ResumeFunction = useCallback(
    async (sessionId, log, entrypoint) => {
      const resumeStart = performance.now()
      try {
        const messages = deserializeMessages(log.messages)

        if (feature('COORDINATOR_MODE')) {
          /* eslint-disable @typescript-eslint/no-require-imports */
          const coordinatorModule =
            require('../../coordinator/coordinatorMode.js') as typeof import('../../coordinator/coordinatorMode.js')
          /* eslint-enable @typescript-eslint/no-require-imports */
          const warning = coordinatorModule.matchSessionMode(log.mode)
          if (warning) {
            /* eslint-disable @typescript-eslint/no-require-imports */
            const { getAgentDefinitionsWithOverrides, getActiveAgentsFromList } =
              require('../../tools/AgentTool/loadAgentsDir.js') as typeof import('../../tools/AgentTool/loadAgentsDir.js')
            /* eslint-enable @typescript-eslint/no-require-imports */
            getAgentDefinitionsWithOverrides.cache.clear?.()
            const freshAgentDefs = await getAgentDefinitionsWithOverrides(getOriginalCwd())
            setAppState((prev) => ({
              ...prev,
              agentDefinitions: {
                ...freshAgentDefs,
                allAgents: freshAgentDefs.allAgents,
                activeAgents: getActiveAgentsFromList(freshAgentDefs.allAgents),
              },
            }))
            messages.push(createSystemMessage(warning, 'warn'))
          }
        }

        const sessionEndTimeoutMs = getSessionEndHookTimeoutMs()
        await executeSessionEndHooks('resume', {
          getAppState: () => store.getState(),
          setAppState,
          signal: AbortSignal.timeout(sessionEndTimeoutMs),
          timeoutMs: sessionEndTimeoutMs,
        })

        const hookMessages = await processSessionStartHooks('resume', {
          sessionId,
          agentType: mainThreadAgentDefinition?.agentType,
          model: mainLoopModel,
        })
        messages.push(...hookMessages)

        if (entrypoint === 'fork') {
          void copyPlanForFork(log, asSessionId(sessionId))
        } else {
          void copyPlanForResume(log, asSessionId(sessionId))
        }

        restoreSessionStateFromLog(log, setAppState)
        if (log.fileHistorySnapshots) {
          void copyFileHistoryForResume(log)
        }

        const { agentDefinition: restoredAgent } = restoreAgentFromSession(
          log.agentSetting,
          initialMainThreadAgentDefinition,
          agentDefinitions,
        )
        setMainThreadAgentDefinition(restoredAgent)
        setAppState((prev) => ({ ...prev, agent: restoredAgent?.agentType }))
        setAppState((prev) => ({
          ...prev,
          standaloneAgentContext: computeStandaloneAgentContext(log.agentName, log.agentColor),
        }))
        void updateSessionName(log.agentName)

        restoreReadFileState(messages, log.projectPath ?? getOriginalCwd())
        resetLoadingState()
        setAbortController(null)
        replStore.setConversationId(sessionId)

        const targetSessionCosts = getStoredSessionCosts(sessionId)
        saveCurrentSessionCosts()
        resetCostState()

        switchSession(asSessionId(sessionId), log.fullPath ? dirname(log.fullPath) : null)
        const { renameRecordingForSession } = await import('../../utils/asciicast.js')
        await renameRecordingForSession()
        await resetSessionFilePointer()

        clearSessionMetadata()
        restoreSessionMetadata(log)
        if (getCurrentSessionTitle(getSessionId())) {
          replStore.mutable.titleGenerationAttempted = true
        } else {
          replStore.mutable.titleGenerationAttempted = false
          const sid = getSessionId()
          if (sid && log.messages.length > 0) {
            const text = log.firstPrompt || ''
            if (text) {
              void generateSessionTitle(text, AbortSignal.timeout(15_000)).then((title) => {
                if (title) {
                  saveAiGeneratedTitle(sid as UUID, title)
                  cacheSessionTitle(title)
                  forceRenderTitle((n) => n + 1)
                }
              })
            }
          }
        }

        if (entrypoint !== 'fork') {
          exitRestoredWorktree()
          restoreWorktreeForResume(log.worktreeSession)
          adoptResumedSessionFile()
          void restoreRemoteAgentTasks({
            abortController: new AbortController(),
            getAppState: () => store.getState(),
            setAppState,
          })
        } else {
          const ws = getCurrentWorktreeSession()
          if (ws) {
            saveWorktreeState(ws)
          }
        }

        if (feature('COORDINATOR_MODE')) {
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { saveMode } = require('../../utils/sessionStorage.js')
          const { isCoordinatorMode } =
            require('../../coordinator/coordinatorMode.js') as typeof import('../../coordinator/coordinatorMode.js')
          /* eslint-enable @typescript-eslint/no-require-imports */
          saveMode(isCoordinatorMode() ? 'coordinator' : 'normal')
        }

        if (targetSessionCosts) {
          setCostStateForRestore(targetSessionCosts)
        }

        if (replStore.mutable.contentReplacementState && entrypoint !== 'fork') {
          replStore.mutable.contentReplacementState = reconstructContentReplacementState(
            messages,
            log.contentReplacements ?? [],
          )
        }

        replStore.setMessages(() => messages)
        setToolJSX(null)
        setInputValue('')
        logEvent('zy_session_resumed', {
          entrypoint: entrypoint as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          success: true,
          resume_duration_ms: Math.round(performance.now() - resumeStart),
        })
      } catch (error) {
        logEvent('zy_session_resumed', {
          entrypoint: entrypoint as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          success: false,
        })
        throw error
      }
    },
    [
      resetLoadingState,
      setAppState,
      setToolJSX,
      initialMainThreadAgentDefinition,
      replStore,
      agentDefinitions,
      store.getState,
      setInputValue,
      mainThreadAgentDefinition?.agentType,
      mainLoopModel,
      setAbortController,
      restoreReadFileState,
      setMainThreadAgentDefinition,
      forceRenderTitle,
    ],
  )

  // 挂载时从 initialMessages 中恢复 readFileState + remote agent tasks
  useEffect(() => {
    if (initialMessages && initialMessages.length > 0) {
      restoreReadFileState(initialMessages, getOriginalCwd())
      void restoreRemoteAgentTasks({
        abortController: new AbortController(),
        getAppState: () => store.getState(),
        setAppState,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessages?.length, store.getState, setAppState, restoreReadFileState, initialMessages])

  return resume
}
