import { feature } from 'bun:bundle'
import figures from 'figures'
import React, { type ReactNode, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { isCoordinatorMode } from 'src/coordinator/coordinatorMode.js'
import { useTerminalSize } from 'src/hooks/useTerminalSize.js'
import { useAppState, useSetAppState } from 'src/state/AppState.js'
import { enterTeammateView, exitTeammateView } from 'src/state/teammateViewHelpers.js'
import type { ToolUseContext } from 'src/Tool.js'
import { DreamTask, type DreamTaskState } from 'src/tasks/DreamTask/DreamTask.js'
import { InProcessTeammateTask } from 'src/tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import type { InProcessTeammateTaskState } from 'src/tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from 'src/tasks/LocalAgentTask/LocalAgentTask.js'
import { LocalAgentTask } from 'src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from 'src/tasks/LocalShellTask/guards.js'
import { LocalShellTask } from 'src/tasks/LocalShellTask/LocalShellTask.js'
// Type import is erased at build time — safe even though module is ant-gated.
import type { LocalWorkflowTaskState } from 'src/tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { MonitorMcpTaskState } from 'src/tasks/MonitorMcpTask/MonitorMcpTask.js'
import {
  RemoteAgentTask,
  type RemoteAgentTaskState,
} from 'src/tasks/RemoteAgentTask/RemoteAgentTask.js'
import { type BackgroundTaskState, isBackgroundTask, type TaskState } from 'src/tasks/types.js'
import type { DeepImmutable } from 'src/types/utils.js'
import { intersperse } from 'src/utils/array.js'
import { TEAM_LEAD_NAME } from 'src/utils/swarm/constants.js'
import { stopUltraplan } from '../../commands/ultraplan.js'
import type { CommandResultDisplay } from '../../commands.js'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import type { ExitState } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { tSync } from '../../i18n/index.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { count } from '../../utils/array.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { AsyncAgentDetailDialog } from './AsyncAgentDetailDialog.js'
import { BackgroundTask as BackgroundTaskComponent } from './BackgroundTask.js'
import { DreamDetailDialog } from './DreamDetailDialog.js'
import { InProcessTeammateDetailDialog } from './InProcessTeammateDetailDialog.js'
import { RemoteSessionDetailDialog } from './RemoteSessionDetailDialog.js'
import { ShellDetailDialog } from './ShellDetailDialog.js'
import { Item, type ListItem, TeammateTaskGroups, toListItem } from './taskListRenderers.js'

type ViewState =
  | {
      mode: 'list'
    }
  | {
      mode: 'detail'
      itemId: string
    }
type Props = {
  onDone: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
  toolUseContext: ToolUseContext
  initialDetailTaskId?: string
}

// WORKFLOW_SCRIPTS 仅限 ant（build_flags.yaml）。静态导入会泄漏约 1.3K 行到外部构建中。
// 使用 feature() + require 门控，这样打包器可以对分支进行死代码消除。
/* eslint-disable @typescript-eslint/no-require-imports */
const WorkflowDetailDialog = null
const workflowTaskModule = null
const killWorkflowTask = null
const skipWorkflowAgent = null
const retryWorkflowAgent = null
const monitorMcpModule = null
const killMonitorMcp = null
const MonitorMcpDetailDialog = null
/* eslint-enable @typescript-eslint/no-require-imports */

// 辅助函数：获取过滤后的后台任务（排除已前置的 local_agent）
function getSelectableBackgroundTasks(
  tasks: Record<string, TaskState> | undefined,
  foregroundedTaskId: string | undefined,
): TaskState[] {
  const backgroundTasks = Object.values(tasks ?? {}).filter(isBackgroundTask)
  return backgroundTasks.filter(
    (task) => !(task.type === 'local_agent' && task.id === foregroundedTaskId),
  )
}
export function BackgroundTasksDialog({
  onDone,
  toolUseContext,
  initialDetailTaskId,
}: Props): React.ReactNode {
  const tasks = useAppState((s) => s.tasks)
  const foregroundedTaskId = useAppState((s) => s.foregroundedTaskId)
  const showSpinnerTree = useAppState((s) => s.expandedView) === 'teammates'
  const setAppState = useSetAppState()
  const killAgentsShortcut = useShortcutDisplay('chat:killAgents', 'Chat', 'ctrl+x ctrl+k')
  const typedTasks = tasks as Record<string, TaskState> | undefined

  // 追踪挂载时是否跳过了列表视图（用于返回按钮行为）
  const skippedListOnMount = useRef(false)

  // 计算初始视图状态——如果调用者提供了具体任务或只有一个任务，则跳过列表
  const [viewState, setViewState] = useState<ViewState>(() => {
    if (initialDetailTaskId) {
      skippedListOnMount.current = true
      return {
        mode: 'detail',
        itemId: initialDetailTaskId,
      }
    }
    const allItems = getSelectableBackgroundTasks(typedTasks, foregroundedTaskId)
    if (allItems.length === 1) {
      skippedListOnMount.current = true
      return {
        mode: 'detail',
        itemId: allItems[0]!.id,
      }
    }
    return {
      mode: 'list',
    }
  })
  const [selectedIndex, setSelectedIndex] = useState<number>(0)

  // 注册为模态覆盖层，这样此对话框打开时父级 Chat 快捷键（上/下键翻历史）会被禁用
  // @ts-expect-error
  useRegisterOverlay('background-tasks-dialog')

  // 将排序和分类的项目一起 memo 化以确保引用稳定
  const {
    bashTasks,
    remoteSessions,
    agentTasks,
    teammateTasks,
    workflowTasks,
    mcpMonitors,
    dreamTasks: dreamTaskItems,
    allSelectableItems,
  } = useMemo(() => {
    // 过滤，仅显示运行中/等待中的后台任务，与状态栏计数保持一致
    const backgroundTasks = Object.values(typedTasks ?? {}).filter(isBackgroundTask)
    const allItems = backgroundTasks.map(toListItem)
    const sorted = allItems.sort((a, b) => {
      const aStatus = a.status
      const bStatus = b.status
      if (aStatus === 'running' && bStatus !== 'running') return -1
      if (aStatus !== 'running' && bStatus === 'running') return 1
      const aTime = 'task' in a ? a.task.startTime : 0
      const bTime = 'task' in b ? b.task.startTime : 0
      return bTime - aTime
    })
    const bash = sorted.filter((item) => item.type === 'local_bash')
    const remote = sorted.filter((item) => item.type === 'remote_agent')
    // 排除已前置的任务——它正在主 UI 中查看，不是后台任务
    const agent = sorted.filter(
      (item) => item.type === 'local_agent' && item.id !== foregroundedTaskId,
    )
    const workflows = sorted.filter((item) => item.type === 'local_workflow')
    const monitorMcp = sorted.filter((item) => item.type === 'monitor_mcp')
    const dreamTasks = sorted.filter((item) => item.type === 'dream')
    // 在 spinner-tree 模式下，从对话框中排除 teammate（它们出现在树中）
    const teammates = showSpinnerTree
      ? []
      : sorted.filter((item) => item.type === 'in_process_teammate')
    // 当有 teammate 时添加 leader 条目，这样用户可以返回 foreground 到 leader
    const leaderItem: ListItem[] =
      teammates.length > 0
        ? [
            {
              id: '__leader__',
              type: 'leader',
              label: `@${TEAM_LEAD_NAME}`,
              status: 'running',
            },
          ]
        : []
    return {
      bashTasks: bash,
      remoteSessions: remote,
      agentTasks: agent,
      workflowTasks: workflows,
      mcpMonitors: monitorMcp,
      dreamTasks,
      teammateTasks: [...leaderItem, ...teammates],
      // 顺序必须与 JSX 渲染顺序一致（teammates → bash → monitorMcp →
      // remote → agent → workflows → dream），这样 ↓/↑ 导航时光标视觉上向下移动。
      allSelectableItems: [
        ...leaderItem,
        ...teammates,
        ...bash,
        ...monitorMcp,
        ...remote,
        ...agent,
        ...workflows,
        ...dreamTasks,
      ],
    }
  }, [typedTasks, foregroundedTaskId, showSpinnerTree])
  const currentSelection = allSelectableItems[selectedIndex] ?? null

  // 使用可配置的快捷键进行标准导航和确认/取消。
  // confirm:no 由 Dialog 的 onCancel 属性处理。
  useKeybindings(
    {
      'confirm:previous': () => setSelectedIndex((prev) => Math.max(0, prev - 1)),
      'confirm:next': () =>
        setSelectedIndex((prev) => Math.min(allSelectableItems.length - 1, prev + 1)),
      'confirm:yes': () => {
        const current = allSelectableItems[selectedIndex]
        if (current) {
          if (current.type === 'leader') {
            exitTeammateView(setAppState)
            onDone(tSync('backgroundTasks.dismissed'), {
              display: 'system',
            })
          } else {
            setViewState({
              mode: 'detail',
              itemId: current.id,
            })
          }
        }
      },
    },
    {
      context: 'Confirmation',
      isActive: viewState.mode === 'list',
    },
  )

  // 组件专属快捷键（x=停止，f=前置，right=放大）在 UI 中显示。
  // 这些取决于任务类型和状态，不是标准对话框快捷键。
  const handleKeyDown = (e: KeyboardEvent) => {
    // 仅在列表模式下处理输入
    if (viewState.mode !== 'list') return
    if (e.key === 'left') {
      e.preventDefault()
      onDone(tSync('backgroundTasks.dismissed'), {
        display: 'system',
      })
      return
    }

    // 计算按键时刻的当前选中项
    const currentSelection = allSelectableItems[selectedIndex]
    if (!currentSelection) return // 以下内容都需要选中项

    if (e.key === 'x') {
      e.preventDefault()
      if (currentSelection.type === 'local_bash' && currentSelection.status === 'running') {
        void killShellTask(currentSelection.id)
      } else if (currentSelection.type === 'local_agent' && currentSelection.status === 'running') {
        void killAgentTask(currentSelection.id)
      } else if (
        currentSelection.type === 'in_process_teammate' &&
        currentSelection.status === 'running'
      ) {
        void killTeammateTask(currentSelection.id)
      } else if (
        currentSelection.type === 'local_workflow' &&
        currentSelection.status === 'running' &&
        killWorkflowTask
      ) {
        killWorkflowTask(currentSelection.id, setAppState)
      } else if (
        currentSelection.type === 'monitor_mcp' &&
        currentSelection.status === 'running' &&
        killMonitorMcp
      ) {
        killMonitorMcp(currentSelection.id, setAppState)
      } else if (currentSelection.type === 'dream' && currentSelection.status === 'running') {
        void killDreamTask(currentSelection.id)
      } else if (
        currentSelection.type === 'remote_agent' &&
        currentSelection.status === 'running'
      ) {
        if (currentSelection.task.isUltraplan) {
          void stopUltraplan(currentSelection.id, currentSelection.task.sessionId, setAppState)
        } else {
          void killRemoteAgentTask(currentSelection.id)
        }
      }
    }
    if (e.key === 'f') {
      if (
        currentSelection.type === 'in_process_teammate' &&
        currentSelection.status === 'running'
      ) {
        e.preventDefault()
        enterTeammateView(currentSelection.id, setAppState)
        onDone(tSync('backgroundTasks.dismissed'), {
          display: 'system',
        })
      } else if (currentSelection.type === 'leader') {
        e.preventDefault()
        exitTeammateView(setAppState)
        onDone(tSync('backgroundTasks.dismissed'), {
          display: 'system',
        })
      }
    }
  }
  async function killShellTask(taskId: string): Promise<void> {
    await LocalShellTask.kill(taskId, setAppState)
  }
  async function killAgentTask(taskId: string): Promise<void> {
    await LocalAgentTask.kill(taskId, setAppState)
  }
  async function killTeammateTask(taskId: string): Promise<void> {
    await InProcessTeammateTask.kill(taskId, setAppState)
  }
  async function killDreamTask(taskId: string): Promise<void> {
    await DreamTask.kill(taskId, setAppState)
  }
  async function killRemoteAgentTask(taskId: string): Promise<void> {
    await RemoteAgentTask.kill(taskId, setAppState)
  }

  // 用 useEffectEvent 包装 onDone，获得稳定引用，始终调用当前 onDone 回调，
  // 而不会导致 effect 重新触发。
  const onDoneEvent = useEffectEvent(onDone)
  useEffect(() => {
    if (viewState.mode !== 'list') {
      const task = (typedTasks ?? {})[viewState.itemId]
      // Workflow 任务有宽限期：它们的详情视图在完成后保持打开，
      // 这样用户可以在被清除前看到最终状态。
      if (!task || (task.type !== 'local_workflow' && !isBackgroundTask(task))) {
        // 任务已被移除或不再是后台任务（例如被终止）。
        // 如果挂载时跳过了列表，则完全关闭对话框。
        if (skippedListOnMount.current) {
          onDoneEvent(tSync('backgroundTasks.dismissed'), {
            display: 'system',
          })
        } else {
          setViewState({
            mode: 'list',
          })
        }
      }
    }
    const totalItems = allSelectableItems.length
    if (selectedIndex >= totalItems && totalItems > 0) {
      setSelectedIndex(totalItems - 1)
    }
  }, [viewState, typedTasks, selectedIndex, allSelectableItems, onDoneEvent])

  // 返回列表视图的辅助函数（如果挂载时跳过了列表且仍只有 ≤1 项，则关闭对话框）。
  // 检查当前计数可防止过时状态陷阱：如果打开时只有 1 个任务（自动跳到详情），
  // 然后第二个任务开始了，"返回"应显示列表——而非关闭。
  const goBackToList = () => {
    if (skippedListOnMount.current && allSelectableItems.length <= 1) {
      onDone(tSync('backgroundTasks.dismissed'), {
        display: 'system',
      })
    } else {
      skippedListOnMount.current = false
      setViewState({
        mode: 'list',
      })
    }
  }

  // 如果选中了某项，显示相应的视图
  if (viewState.mode !== 'list' && typedTasks) {
    const task = typedTasks[viewState.itemId]
    if (!task) {
      return null
    }

    // 详情模式——显示相应的详情对话框
    switch (task.type) {
      case 'local_bash':
        return (
          <ShellDetailDialog
            shell={task}
            onDone={onDone}
            onKillShell={() => void killShellTask(task.id)}
            onBack={goBackToList}
            key={`shell-${task.id}`}
          />
        )
      case 'local_agent':
        return (
          <AsyncAgentDetailDialog
            agent={task}
            onDone={onDone}
            onKillAgent={() => void killAgentTask(task.id)}
            onBack={goBackToList}
            key={`agent-${task.id}`}
          />
        )
      case 'remote_agent':
        return (
          <RemoteSessionDetailDialog
            session={task}
            onDone={onDone}
            toolUseContext={toolUseContext}
            onBack={goBackToList}
            onKill={
              task.status !== 'running'
                ? undefined
                : task.isUltraplan
                  ? () => void stopUltraplan(task.id, task.sessionId, setAppState)
                  : () => void killRemoteAgentTask(task.id)
            }
            key={`session-${task.id}`}
          />
        )
      case 'in_process_teammate':
        return (
          <InProcessTeammateDetailDialog
            teammate={task}
            onDone={onDone}
            onKill={task.status === 'running' ? () => void killTeammateTask(task.id) : undefined}
            onBack={goBackToList}
            onForeground={
              task.status === 'running'
                ? () => {
                    enterTeammateView(task.id, setAppState)
                    onDone(tSync('backgroundTasks.dismissed'), {
                      display: 'system',
                    })
                  }
                : undefined
            }
            key={`teammate-${task.id}`}
          />
        )
      case 'local_workflow':
        if (!WorkflowDetailDialog) return null
        return (
          <WorkflowDetailDialog
            workflow={task}
            onDone={onDone}
            onKill={
              task.status === 'running' && killWorkflowTask
                ? () => killWorkflowTask(task.id, setAppState)
                : undefined
            }
            onSkipAgent={
              task.status === 'running' && skipWorkflowAgent
                ? () => skipWorkflowAgent(task.id, setAppState)
                : undefined
            }
            onRetryAgent={
              task.status === 'running' && retryWorkflowAgent
                ? () => retryWorkflowAgent(task.id, setAppState)
                : undefined
            }
            onBack={goBackToList}
            key={`workflow-${task.id}`}
          />
        )
      case 'monitor_mcp':
        if (!MonitorMcpDetailDialog) return null
        return (
          <MonitorMcpDetailDialog
            task={task}
            onKill={
              task.status === 'running' && killMonitorMcp
                ? () => killMonitorMcp(task.id, setAppState)
                : undefined
            }
            onBack={goBackToList}
            key={`monitor-mcp-${task.id}`}
          />
        )
      case 'dream':
        return (
          <DreamDetailDialog
            task={task}
            onDone={() =>
              onDone(tSync('backgroundTasks.dismissed'), {
                display: 'system',
              })
            }
            onBack={goBackToList}
            onKill={task.status === 'running' ? () => void killDreamTask(task.id) : undefined}
            key={`dream-${task.id}`}
          />
        )
    }
  }
  const runningBashCount = count(bashTasks, (_) => _.status === 'running')
  const runningAgentCount =
    count(
      remoteSessions,
      (session) => session.status === 'running' || session.status === 'pending',
    ) + count(agentTasks, (agent) => agent.status === 'running')
  const runningTeammateCount = count(teammateTasks, (teammate) => teammate.status === 'running')
  const subtitle = intersperse(
    [
      ...(runningTeammateCount > 0
        ? [
            <Text key="teammates">
              {runningTeammateCount}{' '}
              {runningTeammateCount !== 1
                ? tSync('backgroundTasks.agent')
                : tSync('backgroundTasks.agentSingular')}
            </Text>,
          ]
        : []),
      ...(runningBashCount > 0
        ? [
            <Text key="shells">
              {runningBashCount}{' '}
              {runningBashCount !== 1
                ? tSync('backgroundTasks.activeShells')
                : tSync('backgroundTasks.activeShell')}
            </Text>,
          ]
        : []),
      ...(runningAgentCount > 0
        ? [
            <Text key="agents">
              {runningAgentCount}{' '}
              {runningAgentCount !== 1
                ? tSync('backgroundTasks.activeAgents')
                : tSync('backgroundTasks.activeAgent')}
            </Text>,
          ]
        : []),
    ],
    (index) => <Text key={`separator-${index}`}> · </Text>,
  )
  const actions = [
    <KeyboardShortcutHint key="upDown" shortcut="↑/↓" action="select" />,
    <KeyboardShortcutHint key="enter" shortcut="Enter" action="view" />,
    ...(currentSelection?.type === 'in_process_teammate' && currentSelection.status === 'running'
      ? [<KeyboardShortcutHint key="foreground" shortcut="f" action="foreground" />]
      : []),
    ...((currentSelection?.type === 'local_bash' ||
      currentSelection?.type === 'local_agent' ||
      currentSelection?.type === 'in_process_teammate' ||
      currentSelection?.type === 'local_workflow' ||
      currentSelection?.type === 'monitor_mcp' ||
      currentSelection?.type === 'dream' ||
      currentSelection?.type === 'remote_agent') &&
    currentSelection.status === 'running'
      ? [<KeyboardShortcutHint key="kill" shortcut="x" action="stop" />]
      : []),
    ...(agentTasks.some((t) => t.status === 'running')
      ? [<KeyboardShortcutHint key="kill-all" shortcut={killAgentsShortcut} action="stop agents" />]
      : []),
    <KeyboardShortcutHint key="esc" shortcut="←/Esc" action="close" />,
  ]
  const handleCancel = () =>
    onDone(tSync('backgroundTasks.dismissed'), {
      display: 'system',
    })
  function renderInputGuide(exitState: ExitState): React.ReactNode {
    if (exitState.pending) {
      return (
        <Text>
          {tSync('backgroundTasks.pressAgainToExit', {
            key: exitState.keyName,
          })}
        </Text>
      )
    }
    return <Byline>{actions}</Byline>
  }
  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title={tSync('backgroundTasks.title')}
        subtitle={<>{subtitle}</>}
        onCancel={handleCancel}
        color="background"
        inputGuide={renderInputGuide}
      >
        {allSelectableItems.length === 0 ? (
          <Text dimColor>{tSync('backgroundTasks.noTasks')}</Text>
        ) : (
          <Box flexDirection="column">
            {teammateTasks.length > 0 && (
              <Box flexDirection="column">
                {(bashTasks.length > 0 || remoteSessions.length > 0 || agentTasks.length > 0) && (
                  <Text dimColor>
                    <Text bold>
                      {'  '}
                      {tSync('backgroundTasks.agents')}
                    </Text>{' '}
                    ({count(teammateTasks, (i) => i.type !== 'leader')})
                  </Text>
                )}
                <Box flexDirection="column">
                  <TeammateTaskGroups
                    teammateTasks={teammateTasks}
                    currentSelectionId={currentSelection?.id}
                  />
                </Box>
              </Box>
            )}

            {bashTasks.length > 0 && (
              <Box flexDirection="column" marginTop={teammateTasks.length > 0 ? 1 : 0}>
                {(teammateTasks.length > 0 ||
                  remoteSessions.length > 0 ||
                  agentTasks.length > 0) && (
                  <Text dimColor>
                    <Text bold>
                      {'  '}
                      {tSync('backgroundTasks.shells')}
                    </Text>{' '}
                    ({bashTasks.length})
                  </Text>
                )}
                <Box flexDirection="column">
                  {bashTasks.map((item) => (
                    <Item key={item.id} item={item} isSelected={item.id === currentSelection?.id} />
                  ))}
                </Box>
              </Box>
            )}

            {mcpMonitors.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={teammateTasks.length > 0 || bashTasks.length > 0 ? 1 : 0}
              >
                <Text dimColor>
                  <Text bold>
                    {'  '}
                    {tSync('backgroundTasks.monitors')}
                  </Text>{' '}
                  ({mcpMonitors.length})
                </Text>
                <Box flexDirection="column">
                  {mcpMonitors.map((item) => (
                    <Item key={item.id} item={item} isSelected={item.id === currentSelection?.id} />
                  ))}
                </Box>
              </Box>
            )}

            {remoteSessions.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={
                  teammateTasks.length > 0 || bashTasks.length > 0 || mcpMonitors.length > 0 ? 1 : 0
                }
              >
                <Text dimColor>
                  <Text bold>
                    {'  '}
                    {tSync('backgroundTasks.remoteAgents')}
                  </Text>{' '}
                  ({remoteSessions.length})
                </Text>
                <Box flexDirection="column">
                  {remoteSessions.map((item) => (
                    <Item key={item.id} item={item} isSelected={item.id === currentSelection?.id} />
                  ))}
                </Box>
              </Box>
            )}

            {agentTasks.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={
                  teammateTasks.length > 0 ||
                  bashTasks.length > 0 ||
                  mcpMonitors.length > 0 ||
                  remoteSessions.length > 0
                    ? 1
                    : 0
                }
              >
                <Text dimColor>
                  <Text bold>
                    {'  '}
                    {tSync('backgroundTasks.localAgents')}
                  </Text>{' '}
                  ({agentTasks.length})
                </Text>
                <Box flexDirection="column">
                  {agentTasks.map((item) => (
                    <Item key={item.id} item={item} isSelected={item.id === currentSelection?.id} />
                  ))}
                </Box>
              </Box>
            )}

            {workflowTasks.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={
                  teammateTasks.length > 0 ||
                  bashTasks.length > 0 ||
                  mcpMonitors.length > 0 ||
                  remoteSessions.length > 0 ||
                  agentTasks.length > 0
                    ? 1
                    : 0
                }
              >
                <Text dimColor>
                  <Text bold>
                    {'  '}
                    {tSync('backgroundTasks.workflows')}
                  </Text>{' '}
                  ({workflowTasks.length})
                </Text>
                <Box flexDirection="column">
                  {workflowTasks.map((item) => (
                    <Item key={item.id} item={item} isSelected={item.id === currentSelection?.id} />
                  ))}
                </Box>
              </Box>
            )}

            {dreamTaskItems.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={
                  teammateTasks.length > 0 ||
                  bashTasks.length > 0 ||
                  mcpMonitors.length > 0 ||
                  remoteSessions.length > 0 ||
                  agentTasks.length > 0 ||
                  workflowTasks.length > 0
                    ? 1
                    : 0
                }
              >
                <Box flexDirection="column">
                  {dreamTaskItems.map((item) => (
                    <Item key={item.id} item={item} isSelected={item.id === currentSelection?.id} />
                  ))}
                </Box>
              </Box>
            )}
          </Box>
        )}
      </Dialog>
    </Box>
  )
}
