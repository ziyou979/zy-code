// focusedInputDialog 分支渲染 — 无状态 dispatch 组件。
// 抽自 screens/REPL.tsx 4533-4938 的 ~400 行条件渲染。
//
// 包含 14 个对话框分支：sandbox-permission / prompt / worker-pending ×2 /
// worker-sandbox-permission / elicitation / idle-return / ide-onboarding /
// effort-callout / remote-callout / plugin-hint / lsp-recommendation /
// desktop-upsell / ultraplan-choice / ultraplan-launch。
//
// 复杂内联回调已提取为具名 handler 函数（handleSandboxResponse /
// handleWorkerSandboxResponse / handleIdleReturnDone / handleUltraplanChoice）。
//
// AppState 衍生值由组件内部 useAppState 自取，REPL 只传本地 state / refs。

import { feature } from 'bun:bundle'
import * as React from 'react'
import { getTotalInputTokens } from '../../bootstrap/state.js'
import { DesktopUpsellStartup } from '../../components/DesktopUpsell/DesktopUpsellStartup.js'
import { EffortCallout } from '../../components/EffortCallout.js'
import { FullscreenUpsellDialog } from '../../components/FullscreenUpsell/FullscreenUpsellDialog.js'
import { PluginHintMenu } from '../../components/Hint/PluginHintMenu.js'
import { PromptDialog } from '../../components/hooks/PromptDialog.js'
import { IdeOnboardingDialog } from '../../components/IdeOnboardingDialog.js'
import { IdleReturnDialog } from '../../components/IdleReturnDialog.js'
import { LspRecommendationMenu } from '../../components/LspRecommendation/LspRecommendationMenu.js'
import { ElicitationDialog } from '../../components/mcp/ElicitationDialog.js'
import { SandboxPermissionRequest } from '../../components/permissions/SandboxPermissionRequest.js'
import { WorkerPendingPermission } from '../../components/permissions/WorkerPendingPermission.js'
import { RemoteCallout } from '../../components/RemoteCallout.js'
import { LOCAL_COMMAND_STDOUT_TAG } from '../../constants/xml.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { NetworkHostPattern } from '../../services/sandbox/sandbox-adapter.js'
import { SandboxManager } from '../../services/sandbox/sandbox-adapter.js'
import { sendSandboxPermissionResponseViaMailbox } from '../../services/swarm/permissionSync.js'
import { useAppState, useAppStateStore, useSetAppState } from '../../state/AppState.js'
import { useReplStore } from '../../state/ReplState.js'
import { WEB_FETCH_TOOL_NAME } from '../../tools/WebFetchTool/prompt.js'
import { saveGlobalConfig } from '../../utils/config.js'
import type { PromptInputHelpers } from '../../utils/handlePromptSubmit.js'
import type { IDEExtensionInstallationStatus } from '../../utils/ide.js'
import { logError } from '../../utils/log.js'
import { createCommandInputMessage, formatCommandInputTags } from '../../utils/messages.js'
import {
  applyPermissionUpdate,
  persistPermissionUpdate,
} from '../../utils/permissions/PermissionUpdate.js'
import { escapeXml } from '../../utils/xml.js'
import type { ReplNotificationsCluster } from './useReplNotificationsCluster.js'
import type { FocusedInputDialog } from './useReplOnCancel.js'

// ── Props ──────────────────────────────────────────────

export type ReplDialogDispatchProps = {
  focusedInputDialog: FocusedInputDialog
  sandboxWireCleanupRef: React.RefObject<Map<string, Array<() => void>>>
  setInputValue: (value: string) => void
  clearBashToolsTracking: () => void
  onSubmitRef: React.RefObject<(input: string, helpers: PromptInputHelpers) => void>
  ideInstallationStatus: IDEExtensionInstallationStatus | null
  setShowIdeOnboarding: (v: boolean) => void
  mainLoopModel: string
  setShowEffortCallout: (next: boolean) => void
  hintRecommendation: ReplNotificationsCluster['hintRecommendation']
  handleHintResponse: ReplNotificationsCluster['handleHintResponse']
  lspRecommendation: ReplNotificationsCluster['lspRecommendation']
  handleLspResponse: ReplNotificationsCluster['handleLspResponse']
  setShowDesktopUpsellStartup: (next: boolean) => void
  setShowFullscreenUpsell: (next: boolean) => void
  createAbortController: () => AbortController
  exitFlow: React.ReactNode
}

// ── stub 组件（feature('ULTRAPLAN') 关闭时 DCE）──
const UltraplanChoiceDialogStub: React.FC<Record<string, unknown>> = () => null
const UltraplanLaunchDialogStub: React.FC<Record<string, unknown>> = () => null

// ── 组件 ──────────────────────────────────────────────

export function ReplDialogDispatch(props: ReplDialogDispatchProps): React.ReactNode {
  const {
    focusedInputDialog: dialog,
    sandboxWireCleanupRef,
    setInputValue,
    clearBashToolsTracking,
    onSubmitRef,
    ideInstallationStatus,
    setShowIdeOnboarding,
    mainLoopModel,
    setShowEffortCallout,
    hintRecommendation,
    handleHintResponse,
    lspRecommendation,
    handleLspResponse,
    setShowDesktopUpsellStartup,
    setShowFullscreenUpsell,
    createAbortController,
    exitFlow,
  } = props

  const replStore = useReplStore()
  const rs = replStore.getState()
  const sandboxPermissionRequestQueue = rs.sandboxPermissionRequestQueue
  const promptQueue = rs.promptQueue
  const idleReturnPending = rs.idleReturnPending
  const queryGuard = replStore.mutable.queryGuard
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  const workerSandboxPermissions = useAppState((s) => s.workerSandboxPermissions)
  const teamContext = useAppState((s) => s.teamContext)
  const elicitation = useAppState((s) => s.elicitation)
  const pendingWorkerRequest = useAppState((s) => s.pendingWorkerRequest)
  const pendingSandboxRequest = useAppState((s) => s.pendingSandboxRequest)
  const ultraplanPendingChoice = useAppState((s) => s.ultraplanPendingChoice)
  const ultraplanLaunchPending = useAppState((s) => s.ultraplanLaunchPending)

  // ── handler: sandbox permission ──
  const handleSandboxResponse = React.useCallback(
    (response: { allow: boolean; persistToSettings: boolean }) => {
      const { allow, persistToSettings } = response
      const currentRequest = sandboxPermissionRequestQueue[0]
      if (!currentRequest) {
        return
      }
      const approvedHost = currentRequest.hostPattern.host
      if (persistToSettings) {
        const update = {
          type: 'addRules' as const,
          rules: [{ toolName: WEB_FETCH_TOOL_NAME, ruleContent: `domain:${approvedHost}` }],
          behavior: (allow ? 'allow' : 'deny') as 'allow' | 'deny',
          destination: 'localSettings' as const,
        }
        setAppState((prev) => ({
          ...prev,
          toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, update),
        }))
        persistPermissionUpdate(update)
        SandboxManager.refreshConfig()
      }
      replStore.setState((prev) => {
        const queue = prev.sandboxPermissionRequestQueue
        queue
          .filter((item) => item.hostPattern.host === approvedHost)
          .forEach((item) => item.resolvePromise(allow))
        return {
          ...prev,
          sandboxPermissionRequestQueue: queue.filter(
            (item) => item.hostPattern.host !== approvedHost,
          ),
        }
      })
      const cleanups = sandboxWireCleanupRef.current.get(approvedHost)
      if (cleanups) {
        for (const fn of cleanups) {
          fn()
        }
        sandboxWireCleanupRef.current.delete(approvedHost)
      }
    },
    [sandboxPermissionRequestQueue, replStore, sandboxWireCleanupRef, setAppState],
  )

  // ── handler: worker sandbox permission ──
  const handleWorkerSandboxResponse = React.useCallback(
    (response: { allow: boolean; persistToSettings: boolean }) => {
      const { allow, persistToSettings } = response
      const currentRequest = workerSandboxPermissions.queue[0]
      if (!currentRequest) {
        return
      }
      const approvedHost = currentRequest.host
      void sendSandboxPermissionResponseViaMailbox(
        currentRequest.workerName,
        currentRequest.requestId,
        approvedHost,
        allow,
        teamContext?.teamName,
      )
      if (persistToSettings && allow) {
        const update = {
          type: 'addRules' as const,
          rules: [{ toolName: WEB_FETCH_TOOL_NAME, ruleContent: `domain:${approvedHost}` }],
          behavior: 'allow' as const,
          destination: 'localSettings' as const,
        }
        setAppState((prev) => ({
          ...prev,
          toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, update),
        }))
        persistPermissionUpdate(update)
        SandboxManager.refreshConfig()
      }
      setAppState((prev) => ({
        ...prev,
        workerSandboxPermissions: {
          ...prev.workerSandboxPermissions,
          queue: prev.workerSandboxPermissions.queue.slice(1),
        },
      }))
    },
    [workerSandboxPermissions, teamContext, setAppState],
  )

  // ── handler: idle-return ──
  const handleIdleReturnDone = React.useCallback(
    async (action: string) => {
      const pending = idleReturnPending
      if (!pending) {
        return
      }
      replStore.update({ idleReturnPending: null })
      logEvent('zy_idle_return_action', {
        action: action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        idleMinutes: Math.round(pending.idleMinutes),
        messageCount: replStore.getState().messages.length,
        totalInputTokens: getTotalInputTokens(),
      })
      if (action === 'dismiss') {
        setInputValue(pending.input)
        return
      }
      if (action === 'never') {
        saveGlobalConfig((current) => {
          if (current.idleReturnDismissed) {
            return current
          }
          return { ...current, idleReturnDismissed: true }
        })
      }
      if (action === 'clear') {
        const { clearConversation } = await import('../../commands/clear/conversation.js')
        await clearConversation({
          setMessages: replStore.setMessages,
          readFileState: replStore.mutable.readFileState,
          discoveredSkillNames: replStore.mutable.discoveredSkillNames,
          loadedNestedMemoryPaths: replStore.mutable.loadedNestedMemoryPaths,
          getAppState: () => store.getState(),
          setAppState,
          setConversationId: replStore.setConversationId,
        })
        replStore.mutable.titleGenerationAttempted = false
        clearBashToolsTracking()
      }
      replStore.mutable.skipIdleCheck = true
      void onSubmitRef.current(pending.input, {
        setCursorOffset: () => {},
        clearBuffer: () => {},
        resetHistory: () => {},
      })
    },
    [
      idleReturnPending,
      setInputValue,
      replStore,
      store,
      setAppState,
      clearBashToolsTracking,
      onSubmitRef,
    ],
  )

  // ── handler: ultraplan launch ──
  const handleUltraplanChoice = React.useCallback(
    (choice: string, opts?: { disconnectedBridge?: boolean }) => {
      const blurb = ultraplanLaunchPending?.blurb
      setAppState((prev) =>
        prev.ultraplanLaunchPending ? { ...prev, ultraplanLaunchPending: undefined } : prev,
      )
      if (choice === 'cancel' || !blurb) {
        return
      }
      replStore.setMessages((prev) => [
        ...prev,
        createCommandInputMessage(formatCommandInputTags('ultraplan', blurb)),
      ])
      const appendStdout = (msg: string) =>
        replStore.setMessages((prev) => [
          ...prev,
          createCommandInputMessage(
            `<${LOCAL_COMMAND_STDOUT_TAG}>${escapeXml(msg)}</${LOCAL_COMMAND_STDOUT_TAG}>`,
          ),
        ])
      const appendWhenIdle = (msg: string) => {
        if (!queryGuard.isActive) {
          appendStdout(msg)
          return
        }
        const unsub = queryGuard.subscribe(() => {
          if (queryGuard.isActive) {
            return
          }
          unsub()
          if (!store.getState().ultraplanSessionUrl) {
            return
          }
          appendStdout(msg)
        })
      }
      // @ts-expect-error -- ant-only: launchUltraplan is conditionally imported
      void launchUltraplan({
        blurb,
        getAppState: () => store.getState(),
        setAppState,
        signal: createAbortController().signal,
        disconnectedBridge: opts?.disconnectedBridge,
        onSessionReady: appendWhenIdle,
      })
        .then(appendStdout)
        .catch(logError)
    },
    [ultraplanLaunchPending, setAppState, replStore, queryGuard, store, createAbortController],
  )

  return (
    <>
      {dialog === 'sandbox-permission' && sandboxPermissionRequestQueue[0] && (
        <SandboxPermissionRequest
          key={sandboxPermissionRequestQueue[0].hostPattern.host}
          hostPattern={sandboxPermissionRequestQueue[0].hostPattern}
          onUserResponse={handleSandboxResponse}
        />
      )}
      {dialog === 'prompt' && promptQueue[0] && (
        <PromptDialog
          key={promptQueue[0].request.prompt}
          title={promptQueue[0].title}
          toolInputSummary={promptQueue[0].toolInputSummary}
          request={promptQueue[0].request}
          onRespond={(selectedKey) => {
            const item = promptQueue[0]
            if (!item) {
              return
            }
            item.resolve({ prompt_response: item.request.prompt, selected: selectedKey })
            replStore.setState((p) => ({ ...p, promptQueue: p.promptQueue.slice(1) }))
          }}
          onAbort={() => {
            const item = promptQueue[0]
            if (!item) {
              return
            }
            item.reject(new Error('Prompt cancelled by user'))
            replStore.setState((p) => ({ ...p, promptQueue: p.promptQueue.slice(1) }))
          }}
        />
      )}
      {pendingWorkerRequest && (
        <WorkerPendingPermission
          toolName={pendingWorkerRequest.toolName}
          description={pendingWorkerRequest.description}
        />
      )}
      {pendingSandboxRequest && (
        <WorkerPendingPermission
          toolName="Network Access"
          description={`Waiting for leader to approve network access to ${pendingSandboxRequest.host}`}
        />
      )}
      {dialog === 'worker-sandbox-permission' && workerSandboxPermissions.queue[0] && (
        <SandboxPermissionRequest
          key={workerSandboxPermissions.queue[0].requestId}
          hostPattern={
            { host: workerSandboxPermissions.queue[0].host, port: undefined } as NetworkHostPattern
          }
          onUserResponse={handleWorkerSandboxResponse}
        />
      )}
      {dialog === 'elicitation' && elicitation.queue[0] && (
        <ElicitationDialog
          key={`${elicitation.queue[0].serverName}:${String(elicitation.queue[0].requestId)}`}
          event={elicitation.queue[0]}
          onResponse={(action, content) => {
            const currentRequest = elicitation.queue[0]
            if (!currentRequest) {
              return
            }
            currentRequest.respond({ action, content })
            const isUrlAccept = currentRequest.params.mode === 'url' && action === 'accept'
            if (!isUrlAccept) {
              setAppState((prev) => ({
                ...prev,
                elicitation: { queue: prev.elicitation.queue.slice(1) },
              }))
            }
          }}
          onWaitingDismiss={(action) => {
            const currentRequest = elicitation.queue[0]
            setAppState((prev) => ({
              ...prev,
              elicitation: { queue: prev.elicitation.queue.slice(1) },
            }))
            currentRequest?.onWaitingDismiss?.(action)
          }}
        />
      )}
      {dialog === 'idle-return' && idleReturnPending && (
        <IdleReturnDialog
          idleMinutes={idleReturnPending.idleMinutes}
          totalInputTokens={getTotalInputTokens()}
          onDone={handleIdleReturnDone}
        />
      )}
      {dialog === 'ide-onboarding' && (
        <IdeOnboardingDialog
          onDone={() => setShowIdeOnboarding(false)}
          installationStatus={ideInstallationStatus}
        />
      )}
      {dialog === 'effort-callout' && (
        <EffortCallout
          model={mainLoopModel}
          onDone={(selection) => {
            setShowEffortCallout(false)
            if (selection !== 'dismiss') {
              setAppState((prev) => ({ ...prev, effortValue: selection }))
            }
          }}
        />
      )}
      {dialog === 'remote-callout' && (
        <RemoteCallout
          onDone={(selection) => {
            setAppState((prev) => {
              if (!prev.showRemoteCallout) {
                return prev
              }
              return {
                ...prev,
                showRemoteCallout: false,
                ...(selection === 'enable' && {
                  replBridgeEnabled: true,
                  replWireExplicit: true,
                  replBridgeOutboundOnly: false,
                }),
              }
            })
          }}
        />
      )}

      {exitFlow}

      {dialog === 'plugin-hint' && hintRecommendation && (
        <PluginHintMenu
          pluginName={hintRecommendation.pluginName}
          pluginDescription={hintRecommendation.pluginDescription}
          marketplaceName={hintRecommendation.marketplaceName}
          sourceCommand={hintRecommendation.sourceCommand}
          onResponse={handleHintResponse}
        />
      )}
      {dialog === 'lsp-recommendation' && lspRecommendation && (
        <LspRecommendationMenu
          pluginName={lspRecommendation.pluginName}
          pluginDescription={lspRecommendation.pluginDescription}
          fileExtension={lspRecommendation.fileExtension}
          onResponse={handleLspResponse}
        />
      )}
      {dialog === 'fullscreen-upsell' && (
        <FullscreenUpsellDialog onDone={() => setShowFullscreenUpsell(false)} />
      )}
      {dialog === 'desktop-upsell' && (
        <DesktopUpsellStartup onDone={() => setShowDesktopUpsellStartup(false)} />
      )}

      {feature('ULTRAPLAN')
        ? dialog === 'ultraplan-choice' &&
          ultraplanPendingChoice && (
            <UltraplanChoiceDialogStub
              plan={ultraplanPendingChoice.plan}
              sessionId={ultraplanPendingChoice.sessionId}
              taskId={ultraplanPendingChoice.taskId}
              setMessages={replStore.setMessages}
              readFileState={replStore.mutable.readFileState}
              getAppState={() => store.getState()}
              setConversationId={replStore.setConversationId}
            />
          )
        : null}

      {feature('ULTRAPLAN')
        ? dialog === 'ultraplan-launch' &&
          ultraplanLaunchPending && <UltraplanLaunchDialogStub onChoice={handleUltraplanChoice} />
        : null}
    </>
  )
}
