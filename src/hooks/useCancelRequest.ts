/**
 * CancelRequestHandler 组件，用于处理 cancel/escape 快捷键绑定。
 *
 * 必须在 KeybindingSetup 内部渲染，以便访问 keybinding 上下文。
 * 此组件不渲染任何内容——它仅注册 cancel 快捷键处理函数。
 */
import { useCallback, useRef } from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/metadata.js'
import {
  useAppState,
  useAppStateStore,
  useSetAppState,
} from 'src/state/AppState.js'
import { isVimModeEnabled } from '../components/PromptInput/utils.js'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import type { SpinnerMode } from '../components/Spinner/types.js'
import { useNotifications } from '../context/notifications.js'
import { useIsOverlayActive } from '../context/overlayContext.js'
import { useCommandQueue } from '../hooks/useCommandQueue.js'
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import type { Screen } from '../screens/REPL.js'
import { exitTeammateView } from '../state/teammateViewHelpers.js'
import {
  killAllRunningAgentTasks,
  markAgentsNotified,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { PromptInputMode, VimMode } from '../types/textInputTypes.js'
import {
  clearCommandQueue,
  enqueuePendingNotification,
  hasCommandsInQueue,
} from '../utils/messageQueueManager.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'

/** 第二次按键用于终止所有后台 agent 的时间窗口（毫秒）。 */
const KILL_AGENTS_CONFIRM_WINDOW_MS = 3000

type CancelRequestHandlerProps = {
  setToolUseConfirmQueue: (
    f: (toolUseConfirmQueue: ToolUseConfirm[]) => ToolUseConfirm[],
  ) => void
  onCancel: () => void
  onAgentsKilled: () => void
  isMessageSelectorVisible: boolean
  screen: Screen
  abortSignal?: AbortSignal
  popCommandFromQueue?: () => void
  vimMode?: VimMode
  isLocalJSXCommand?: boolean
  isSearchingHistory?: boolean
  isHelpOpen?: boolean
  inputMode?: PromptInputMode
  inputValue?: string
  streamMode?: SpinnerMode
}

/**
 * 处理 cancel 请求的组件，通过 keybinding 触发。
 * 渲染 null，但注册了 'chat:cancel' 快捷键处理函数。
 */
export function CancelRequestHandler(props: CancelRequestHandlerProps): null {
  const {
    setToolUseConfirmQueue,
    onCancel,
    onAgentsKilled,
    isMessageSelectorVisible,
    screen,
    abortSignal,
    popCommandFromQueue,
    vimMode,
    isLocalJSXCommand,
    isSearchingHistory,
    isHelpOpen,
    inputMode,
    inputValue,
    streamMode,
  } = props
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const queuedCommandsLength = useCommandQueue().length
  const { addNotification, removeNotification } = useNotifications()
  const lastKillAgentsPressRef = useRef<number>(0)
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)

  const handleCancel = useCallback(() => {
    const cancelProps = {
      source:
        'escape' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      streamMode:
        streamMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }

    // 优先级 1：如果有正在运行的 task，首先取消它
    // 这优先于队列管理，因此用户始终可以中断 ZY
    if (abortSignal !== undefined && !abortSignal.aborted) {
      logEvent('tengu_cancel', cancelProps)
      setToolUseConfirmQueue(() => [])
      onCancel()
      return
    }

    // 优先级 2：当 ZY 空闲时（没有可取消的运行 task），弹出队列
    if (hasCommandsInQueue()) {
      if (popCommandFromQueue) {
        popCommandFromQueue()
        return
      }
    }

    // 兜底：没有可取消或可弹出的内容（如果 isActive 正确，不应到达此处）
    logEvent('tengu_cancel', cancelProps)
    setToolUseConfirmQueue(() => [])
    onCancel()
  }, [
    abortSignal,
    popCommandFromQueue,
    setToolUseConfirmQueue,
    onCancel,
    streamMode,
  ])

  // 判断此 handler 是否应该处于激活状态
  // 其他上下文（Transcript、HistorySearch、Help）有各自的 escape 处理函数
  // 覆盖层（ModelPicker、ThinkingToggle 等）通过 useRegisterOverlay 自行注册
  // 本地 JSX 命令（如 /model、/btw）自行处理输入
  const isOverlayActive = useIsOverlayActive()
  const canCancelRunningTask = abortSignal !== undefined && !abortSignal.aborted
  const hasQueuedCommands = queuedCommandsLength > 0
  // 当处于 bash/background 模式且输入为空时，escape 应该退出该模式
  // 而不是取消请求。让 PromptInput 处理模式退出。
  // 这仅适用于 Escape，不适用于 Ctrl+C，后者应该始终取消。
  const isInSpecialModeWithEmptyInput =
    inputMode !== undefined && inputMode !== 'prompt' && !inputValue
  // 当查看 teammate 的转录时，让 useBackgroundTaskNavigation 处理 Escape
  const isViewingTeammate = viewSelectionMode === 'viewing-agent'
  // 上下文守卫：其他 screen/overlay 自行处理 cancel
  const isContextActive =
    screen !== 'transcript' &&
    !isSearchingHistory &&
    !isMessageSelectorVisible &&
    !isLocalJSXCommand &&
    !isHelpOpen &&
    !isOverlayActive &&
    !(isVimModeEnabled() && vimMode === 'INSERT')

  // Escape (chat:cancel) 在处于特殊模式且输入为空时委托给模式退出，
  // 在查看 teammate 时委托给 useBackgroundTaskNavigation
  const isEscapeActive =
    isContextActive &&
    (canCancelRunningTask || hasQueuedCommands) &&
    !isInSpecialModeWithEmptyInput &&
    !isViewingTeammate

  // Ctrl+C (app:interrupt)：当查看 teammate 时，停止所有内容并
  // 返回主线程。否则仅执行 handleCancel。
  // 当主线程在 prompt 处空闲时，绝不能抢占 ctrl+c——
  // 那会阻止 copy-selection handler 和双击退出接收到按键。
  const isCtrlCActive =
    isContextActive &&
    (canCancelRunningTask || hasQueuedCommands || isViewingTeammate)

  useKeybinding('chat:cancel', handleCancel, {
    context: 'Chat',
    isActive: isEscapeActive,
  })

  // 共用的终止路径：停止所有 agent，抑制每个 agent 的通知，
  // 发送 SDK 事件，入队一个聚合的面向模型的通知。
  // 如果有被终止的内容则返回 true。
  const killAllAgentsAndNotify = useCallback((): boolean => {
    const tasks = store.getState().tasks
    const running = Object.entries(tasks).filter(
      ([, t]) => t.type === 'local_agent' && t.status === 'running',
    )
    if (running.length === 0) return false
    killAllRunningAgentTasks(tasks, setAppState)
    const descriptions: string[] = []
    for (const [taskId, task] of running) {
      markAgentsNotified(taskId, setAppState)
      descriptions.push(task.description)
      emitTaskTerminatedSdk(taskId, 'stopped', {
        toolUseId: task.toolUseId,
        summary: task.description,
      })
    }
    const summary =
      descriptions.length === 1
        ? `Background agent "${descriptions[0]}" was stopped by the user.`
        : `${descriptions.length} background agents were stopped by the user: ${descriptions.map(d => `"${d}"`).join(', ')}.`
    enqueuePendingNotification({ value: summary, mode: 'task-notification' })
    onAgentsKilled()
    return true
  }, [store, setAppState, onAgentsKilled])

  // Ctrl+C (app:interrupt)。限定在 teammate-view 范围内：
  // 从主 prompt 终止 agent 仍然是一个刻意的操作（chat:killAgents），
  // 而不是取消 turn 的副作用。
  const handleInterrupt = useCallback(() => {
    if (isViewingTeammate) {
      killAllAgentsAndNotify()
      exitTeammateView(setAppState)
    }
    if (canCancelRunningTask || hasQueuedCommands) {
      handleCancel()
    }
  }, [
    isViewingTeammate,
    killAllAgentsAndNotify,
    setAppState,
    canCancelRunningTask,
    hasQueuedCommands,
    handleCancel,
  ])

  useKeybinding('app:interrupt', handleInterrupt, {
    context: 'Global',
    isActive: isCtrlCActive,
  })

  // chat:killAgents 使用两次按键的模式：第一次按键显示确认提示，
  // 第二次在时间窗口内的按键才真正终止所有 agent。
  // 直接从 store 读取 tasks 以避免闭包过期问题。
  const handleKillAgents = useCallback(() => {
    const tasks = store.getState().tasks
    const hasRunningAgents = Object.values(tasks).some(
      t => t.type === 'local_agent' && t.status === 'running',
    )
    if (!hasRunningAgents) {
      addNotification({
        key: 'kill-agents-none',
        text: 'No background agents running',
        priority: 'immediate',
        timeoutMs: 2000,
      })
      return
    }
    const now = Date.now()
    const elapsed = now - lastKillAgentsPressRef.current
    if (elapsed <= KILL_AGENTS_CONFIRM_WINDOW_MS) {
      // 第二次在窗口内的按键——终止所有后台 agent
      lastKillAgentsPressRef.current = 0
      removeNotification('kill-agents-confirm')
      logEvent('tengu_cancel', {
        source:
          'kill_agents' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      clearCommandQueue()
      killAllAgentsAndNotify()
      return
    }
    // 第一次按键——在状态栏显示确认提示
    lastKillAgentsPressRef.current = now
    const shortcut = getShortcutDisplay(
      'chat:killAgents',
      'Chat',
      'ctrl+x ctrl+k',
    )
    addNotification({
      key: 'kill-agents-confirm',
      text: `Press ${shortcut} again to stop background agents`,
      priority: 'immediate',
      timeoutMs: KILL_AGENTS_CONFIRM_WINDOW_MS,
    })
  }, [store, addNotification, removeNotification, killAllAgentsAndNotify])

  // 必须始终保持激活状态：ctrl+x 作为 chord 前缀被消费，
  // 无论 isActive 状态如何（因为 ctrl+x ctrl+e 始终有效），
  // 如果此处 handler 不激活，会导致 ctrl+k 泄漏到 readline 的 kill-line。
  // Handler 在内部进行门控。
  useKeybinding('chat:killAgents', handleKillAgents, {
    context: 'Chat',
  })

  return null
}
