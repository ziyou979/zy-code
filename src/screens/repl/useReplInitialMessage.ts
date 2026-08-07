/**
 * useReplInitialMessage.ts — 从 REPL.tsx 提取的初始消息处理 effect。
 *
 * 处理来自 CLI 参数或带上下文清除的 plan mode 退出的初始消息。
 */

import { feature } from 'bun:bundle'
import { useEffect, useRef } from 'react'
import { getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import { buildPermissionUpdates } from '../../components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js'
import type { AppState, AppStateStore } from '../../state/AppStateStore.js'
import type { ReplStoreInstance } from '../../state/replStore.js'
import { toUUID } from '../../types/ids.js'
import type { Message as MessageType } from '../../types/message.js'
import { createAbortController } from '../../utils/abortController.js'
import { isEnvTruthy, isInternalBuild } from '../../services/infra/envUtils.js'
import type { FileHistoryState } from '../../services/file-persistence/fileHistory.js'
import {
  fileHistoryEnabled,
  fileHistoryMakeSnapshot,
} from '../../services/file-persistence/fileHistory.js'
import type { PromptInputHelpers } from '../../services/input/handlePromptSubmit.js'
import { applyPermissionUpdates } from '../../services/permissions/permissionUpdate.ts'
import { stripDangerousPermissionsForAutoMode } from '../../services/permissions/dangerousPermissionRules.js'
import { getPlanSlug, setPlanSlug } from '../../services/plans/plans.js'

export interface UseReplInitialMessageParams {
  replStore: ReplStoreInstance
  store: AppStateStore
  isLoading: boolean
  setMessages: (updater: (prev: MessageType[]) => MessageType[]) => void
  setAppState: (updater: (prev: AppState) => AppState) => void
  setAbortController: React.Dispatch<React.SetStateAction<AbortController | null>>
  mainLoopModel: string
  fileHistory: FileHistoryState
  clearBashToolsTracking: () => void
  awaitPendingHooks: () => Promise<void>
  onSubmit: (input: string, helpers: PromptInputHelpers) => Promise<void>
  onQuery: (
    newMessages: MessageType[],
    abortController: AbortController,
    shouldQuery: boolean,
    additionalAllowedTools: string[],
    mainLoopModelParam: string,
  ) => Promise<void>
}

export function useReplInitialMessage(params: UseReplInitialMessageParams): void {
  const {
    replStore,
    store,
    isLoading,
    setMessages,
    setAppState,
    setAbortController,
    mainLoopModel,
    fileHistory,
    clearBashToolsTracking,
    awaitPendingHooks,
    onSubmit,
    onQuery,
  } = params

  const _initialMessage = store.getState().initialMessage

  const initialMessageRef = useRef(false)
  useEffect(() => {
    const pending = store.getState().initialMessage
    if (!pending || isLoading || initialMessageRef.current) {
      return
    }

    // 标记为处理中以防止重入
    initialMessageRef.current = true
    async function processInitialMessage(initialMsg: NonNullable<typeof pending>) {
      // 如果请求则清除上下文（plan mode 退出）
      if (initialMsg.clearContext) {
        const oldPlanSlug = initialMsg.message.planContent ? getPlanSlug() : undefined
        const { clearConversation } = await import('../../commands/clear/conversation.js')
        await clearConversation({
          setMessages,
          readFileState: replStore.mutable.readFileState,
          discoveredSkillNames: replStore.mutable.discoveredSkillNames,
          loadedNestedMemoryPaths: replStore.mutable.loadedNestedMemoryPaths,
          getAppState: () => store.getState(),
          setAppState,
          setConversationId: replStore.setConversationId,
        })
        replStore.mutable.titleGenerationAttempted = false
        clearBashToolsTracking()

        if (oldPlanSlug) {
          setPlanSlug(getSessionId(), oldPlanSlug)
        }
      }

      // 原子操作：清除初始消息，设置权限模式和规则
      const shouldStorePlanForVerification =
        initialMsg.message.planContent && isInternalBuild() && isEnvTruthy(undefined)
      setAppState((prev) => {
        let updatedToolPermissionContext = initialMsg.mode
          ? applyPermissionUpdates(
              prev.toolPermissionContext,
              buildPermissionUpdates(initialMsg.mode, initialMsg.allowedPrompts),
            )
          : prev.toolPermissionContext
        if (initialMsg.mode === 'auto') {
          updatedToolPermissionContext = stripDangerousPermissionsForAutoMode({
            ...updatedToolPermissionContext,
            mode: 'auto',
            prePlanMode: undefined,
          })
        }
        return {
          ...prev,
          initialMessage: null,
          toolPermissionContext: updatedToolPermissionContext,
          ...(shouldStorePlanForVerification && {
            pendingPlanVerification: {
              plan: initialMsg.message.planContent!,
              verificationStarted: false,
              verificationCompleted: false,
            },
          }),
        }
      })

      // 创建文件历史快照用于代码回退
      if (fileHistoryEnabled()) {
        void fileHistoryMakeSnapshot((updater: (prev: FileHistoryState) => FileHistoryState) => {
          setAppState((prev) => ({
            ...prev,
            fileHistory: updater(prev.fileHistory),
          }))
        }, toUUID(initialMsg.message.uuid))
      }

      await awaitPendingHooks()

      const content = initialMsg.message.message.content

      if (typeof content === 'string' && !initialMsg.message.planContent) {
        void onSubmit(content, {
          setCursorOffset: () => {},
          clearBuffer: () => {},
          resetHistory: () => {},
        })
      } else {
        const newAbortController = createAbortController()
        setAbortController(newAbortController)
        void onQuery([initialMsg.message], newAbortController, true, [], mainLoopModel)
      }

      // 延迟后重置 ref 以允许新初始消息
      setTimeout(
        (ref) => {
          ref.current = false
        },
        100,
        initialMessageRef,
      )
    }
    void processInitialMessage(pending)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isLoading,
    setMessages,
    setAppState,
    onQuery,
    mainLoopModel,
    awaitPendingHooks,
    store.getState,
    replStore.mutable.readFileState,
    setAbortController,
    replStore.mutable.discoveredSkillNames,
    clearBashToolsTracking,
    replStore.mutable.loadedNestedMemoryPaths,
    replStore.setConversationId,
    replStore.mutable,
    onSubmit,
  ])
}
