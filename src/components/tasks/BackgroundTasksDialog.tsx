import { feature } from 'bun:bundle';
import figures from 'figures';
import React, { type ReactNode, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { isCoordinatorMode } from 'src/coordinator/coordinatorMode.js';
import { useTerminalSize } from 'src/hooks/useTerminalSize.js';
import { useAppState, useSetAppState } from 'src/state/AppState.js';
import { enterTeammateView, exitTeammateView } from 'src/state/teammateViewHelpers.js';
import type { ToolUseContext } from 'src/Tool.js';
import { DreamTask, type DreamTaskState } from 'src/tasks/DreamTask/DreamTask.js';
import { InProcessTeammateTask } from 'src/tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import type { InProcessTeammateTaskState } from 'src/tasks/InProcessTeammateTask/types.js';
import type { LocalAgentTaskState } from 'src/tasks/LocalAgentTask/LocalAgentTask.js';
import { LocalAgentTask } from 'src/tasks/LocalAgentTask/LocalAgentTask.js';
import type { LocalShellTaskState } from 'src/tasks/LocalShellTask/guards.js';
import { LocalShellTask } from 'src/tasks/LocalShellTask/LocalShellTask.js';
// Type import is erased at build time — safe even though module is ant-gated.
import type { LocalWorkflowTaskState } from 'src/tasks/LocalWorkflowTask/LocalWorkflowTask.js';
import type { MonitorMcpTaskState } from 'src/tasks/MonitorMcpTask/MonitorMcpTask.js';
import { RemoteAgentTask, type RemoteAgentTaskState } from 'src/tasks/RemoteAgentTask/RemoteAgentTask.js';
import { type BackgroundTaskState, isBackgroundTask, type TaskState } from 'src/tasks/types.js';
import type { DeepImmutable } from 'src/types/utils.js';
import { intersperse } from 'src/utils/array.js';
import { TEAM_LEAD_NAME } from 'src/utils/swarm/constants.js';
import { tSync } from '../../i18n/index.js';
import { stopUltraplan } from '../../commands/ultraplan.js';
import type { CommandResultDisplay } from '../../commands.js';
import { useRegisterOverlay } from '../../context/overlayContext.js';
import type { ExitState } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Text } from '../../ink.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { count } from '../../utils/array.js';
import { Byline } from '../design-system/Byline.js';
import { Dialog } from '../design-system/Dialog.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';
import { AsyncAgentDetailDialog } from './AsyncAgentDetailDialog.js';
import { BackgroundTask as BackgroundTaskComponent } from './BackgroundTask.js';
import { DreamDetailDialog } from './DreamDetailDialog.js';
import { InProcessTeammateDetailDialog } from './InProcessTeammateDetailDialog.js';
import { RemoteSessionDetailDialog } from './RemoteSessionDetailDialog.js';
import { ShellDetailDialog } from './ShellDetailDialog.js';
type ViewState = {
  mode: 'list';
} | {
  mode: 'detail';
  itemId: string;
};
type Props = {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  toolUseContext: ToolUseContext;
  initialDetailTaskId?: string;
};
type ListItem = {
  id: string;
  type: 'local_bash';
  label: string;
  status: string;
  task: DeepImmutable<LocalShellTaskState>;
} | {
  id: string;
  type: 'remote_agent';
  label: string;
  status: string;
  task: DeepImmutable<RemoteAgentTaskState>;
} | {
  id: string;
  type: 'local_agent';
  label: string;
  status: string;
  task: DeepImmutable<LocalAgentTaskState>;
} | {
  id: string;
  type: 'in_process_teammate';
  label: string;
  status: string;
  task: DeepImmutable<InProcessTeammateTaskState>;
} | {
  id: string;
  type: 'local_workflow';
  label: string;
  status: string;
  task: DeepImmutable<LocalWorkflowTaskState>;
} | {
  id: string;
  type: 'monitor_mcp';
  label: string;
  status: string;
  task: DeepImmutable<MonitorMcpTaskState>;
} | {
  id: string;
  type: 'dream';
  label: string;
  status: string;
  task: DeepImmutable<DreamTaskState>;
} | {
  id: string;
  type: 'leader';
  label: string;
  status: 'running';
};

// WORKFLOW_SCRIPTS 仅限 ant（build_flags.yaml）。静态导入会泄漏约 1.3K 行到外部构建中。
// 使用 feature() + require 门控，这样打包器可以对分支进行死代码消除。
/* eslint-disable @typescript-eslint/no-require-imports */
const WorkflowDetailDialog = feature('WORKFLOW_SCRIPTS') ? (require('./WorkflowDetailDialog.js') as typeof import('./WorkflowDetailDialog.js')).WorkflowDetailDialog : null;
const workflowTaskModule = feature('WORKFLOW_SCRIPTS') ? require('src/tasks/LocalWorkflowTask/LocalWorkflowTask.js') as typeof import('src/tasks/LocalWorkflowTask/LocalWorkflowTask.js') : null;
const killWorkflowTask = workflowTaskModule?.killWorkflowTask ?? null;
const skipWorkflowAgent = workflowTaskModule?.skipWorkflowAgent ?? null;
const retryWorkflowAgent = workflowTaskModule?.retryWorkflowAgent ?? null;
// 相对路径，而非 `src/...` 路径映射——Bun 的 DCE 可以静态解析并消除 `./` require，
// 但路径映射的字符串保持不透明，会作为死文字保留在包中。与 tasks.ts 模式一致。
const monitorMcpModule = feature('MONITOR_TOOL') ? require('../../tasks/MonitorMcpTask/MonitorMcpTask.js') as typeof import('../../tasks/MonitorMcpTask/MonitorMcpTask.js') : null;
const killMonitorMcp = monitorMcpModule?.killMonitorMcp ?? null;
const MonitorMcpDetailDialog = feature('MONITOR_TOOL') ? (require('./MonitorMcpDetailDialog.js') as typeof import('./MonitorMcpDetailDialog.js')).MonitorMcpDetailDialog : null;
/* eslint-enable @typescript-eslint/no-require-imports */

// 辅助函数：获取过滤后的后台任务（排除已前置的 local_agent）
function getSelectableBackgroundTasks(tasks: Record<string, TaskState> | undefined, foregroundedTaskId: string | undefined): TaskState[] {
  const backgroundTasks = Object.values(tasks ?? {}).filter(isBackgroundTask);
  return backgroundTasks.filter(task => !(task.type === 'local_agent' && task.id === foregroundedTaskId));
}
export function BackgroundTasksDialog({
  onDone,
  toolUseContext,
  initialDetailTaskId
}: Props): React.ReactNode {
  const tasks = useAppState(s => s.tasks);
  const foregroundedTaskId = useAppState(s_0 => s_0.foregroundedTaskId);
  const showSpinnerTree = useAppState(s_1 => s_1.expandedView) === 'teammates';
  const setAppState = useSetAppState();
  const killAgentsShortcut = useShortcutDisplay('chat:killAgents', 'Chat', 'ctrl+x ctrl+k');
  const typedTasks = tasks as Record<string, TaskState> | undefined;

  // 追踪挂载时是否跳过了列表视图（用于返回按钮行为）
  const skippedListOnMount = useRef(false);

  // 计算初始视图状态——如果调用者提供了具体任务或只有一个任务，则跳过列表
  const [viewState, setViewState] = useState<ViewState>(() => {
    if (initialDetailTaskId) {
      skippedListOnMount.current = true;
      return {
        mode: 'detail',
        itemId: initialDetailTaskId
      };
    }
    const allItems = getSelectableBackgroundTasks(typedTasks, foregroundedTaskId);
    if (allItems.length === 1) {
      skippedListOnMount.current = true;
      return {
        mode: 'detail',
        itemId: allItems[0]!.id
      };
    }
    return {
      mode: 'list'
    };
  });
  const [selectedIndex, setSelectedIndex] = useState<number>(0);

  // 注册为模态覆盖层，这样此对话框打开时父级 Chat 快捷键（上/下键翻历史）会被禁用
  useRegisterOverlay('background-tasks-dialog');

  // 将排序和分类的项目一起 memo 化以确保引用稳定
  const {
    bashTasks,
    remoteSessions,
    agentTasks,
    teammateTasks,
    workflowTasks,
    mcpMonitors,
    dreamTasks: dreamTasks_0,
    allSelectableItems
  } = useMemo(() => {
    // 过滤，仅显示运行中/等待中的后台任务，与状态栏计数保持一致
    const backgroundTasks = Object.values(typedTasks ?? {}).filter(isBackgroundTask);
    const allItems_0 = backgroundTasks.map(toListItem);
    const sorted = allItems_0.sort((a, b) => {
      const aStatus = a.status;
      const bStatus = b.status;
      if (aStatus === 'running' && bStatus !== 'running') return -1;
      if (aStatus !== 'running' && bStatus === 'running') return 1;
      const aTime = 'task' in a ? a.task.startTime : 0;
      const bTime = 'task' in b ? b.task.startTime : 0;
      return bTime - aTime;
    });
    const bash = sorted.filter(item => item.type === 'local_bash');
    const remote = sorted.filter(item_0 => item_0.type === 'remote_agent');
    // 排除已前置的任务——它正在主 UI 中查看，不是后台任务
    const agent = sorted.filter(item_1 => item_1.type === 'local_agent' && item_1.id !== foregroundedTaskId);
    const workflows = sorted.filter(item_2 => item_2.type === 'local_workflow');
    const monitorMcp = sorted.filter(item_3 => item_3.type === 'monitor_mcp');
    const dreamTasks = sorted.filter(item_4 => item_4.type === 'dream');
    // 在 spinner-tree 模式下，从对话框中排除 teammate（它们出现在树中）
    const teammates = showSpinnerTree ? [] : sorted.filter(item_5 => item_5.type === 'in_process_teammate');
    // 当有 teammate 时添加 leader 条目，这样用户可以返回 foreground 到 leader
    const leaderItem: ListItem[] = teammates.length > 0 ? [{
      id: '__leader__',
      type: 'leader',
      label: `@${TEAM_LEAD_NAME}`,
      status: 'running'
    }] : [];
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
      allSelectableItems: [...leaderItem, ...teammates, ...bash, ...monitorMcp, ...remote, ...agent, ...workflows, ...dreamTasks]
    };
  }, [typedTasks, foregroundedTaskId, showSpinnerTree]);
  const currentSelection = allSelectableItems[selectedIndex] ?? null;

  // 使用可配置的快捷键进行标准导航和确认/取消。
  // confirm:no 由 Dialog 的 onCancel 属性处理。
  useKeybindings({
    'confirm:previous': () => setSelectedIndex(prev => Math.max(0, prev - 1)),
    'confirm:next': () => setSelectedIndex(prev_0 => Math.min(allSelectableItems.length - 1, prev_0 + 1)),
    'confirm:yes': () => {
      const current = allSelectableItems[selectedIndex];
      if (current) {
        if (current.type === 'leader') {
          exitTeammateView(setAppState);
          onDone(tSync('backgroundTasks.dismissed'), {
            display: 'system'
          });
        } else {
          setViewState({
            mode: 'detail',
            itemId: current.id
          });
        }
      }
    }
  }, {
    context: 'Confirmation',
    isActive: viewState.mode === 'list'
  });

  // 组件专属快捷键（x=停止，f=前置，right=放大）在 UI 中显示。
  // 这些取决于任务类型和状态，不是标准对话框快捷键。
  const handleKeyDown = (e: KeyboardEvent) => {
    // 仅在列表模式下处理输入
    if (viewState.mode !== 'list') return;
    if (e.key === 'left') {
      e.preventDefault();
      onDone(tSync('backgroundTasks.dismissed'), {
        display: 'system'
      });
      return;
    }

    // 计算按键时刻的当前选中项
    const currentSelection_0 = allSelectableItems[selectedIndex];
    if (!currentSelection_0) return; // 以下内容都需要选中项

    if (e.key === 'x') {
      e.preventDefault();
      if (currentSelection_0.type === 'local_bash' && currentSelection_0.status === 'running') {
        void killShellTask(currentSelection_0.id);
      } else if (currentSelection_0.type === 'local_agent' && currentSelection_0.status === 'running') {
        void killAgentTask(currentSelection_0.id);
      } else if (currentSelection_0.type === 'in_process_teammate' && currentSelection_0.status === 'running') {
        void killTeammateTask(currentSelection_0.id);
      } else if (currentSelection_0.type === 'local_workflow' && currentSelection_0.status === 'running' && killWorkflowTask) {
        killWorkflowTask(currentSelection_0.id, setAppState);
      } else if (currentSelection_0.type === 'monitor_mcp' && currentSelection_0.status === 'running' && killMonitorMcp) {
        killMonitorMcp(currentSelection_0.id, setAppState);
      } else if (currentSelection_0.type === 'dream' && currentSelection_0.status === 'running') {
        void killDreamTask(currentSelection_0.id);
      } else if (currentSelection_0.type === 'remote_agent' && currentSelection_0.status === 'running') {
        if (currentSelection_0.task.isUltraplan) {
          void stopUltraplan(currentSelection_0.id, currentSelection_0.task.sessionId, setAppState);
        } else {
          void killRemoteAgentTask(currentSelection_0.id);
        }
      }
    }
    if (e.key === 'f') {
      if (currentSelection_0.type === 'in_process_teammate' && currentSelection_0.status === 'running') {
        e.preventDefault();
        enterTeammateView(currentSelection_0.id, setAppState);
        onDone(tSync('backgroundTasks.dismissed'), {
          display: 'system'
        });
      } else if (currentSelection_0.type === 'leader') {
        e.preventDefault();
        exitTeammateView(setAppState);
        onDone(tSync('backgroundTasks.dismissed'), {
          display: 'system'
        });
      }
    }
  };
  async function killShellTask(taskId: string): Promise<void> {
    await LocalShellTask.kill(taskId, setAppState);
  }
  async function killAgentTask(taskId_0: string): Promise<void> {
    await LocalAgentTask.kill(taskId_0, setAppState);
  }
  async function killTeammateTask(taskId_1: string): Promise<void> {
    await InProcessTeammateTask.kill(taskId_1, setAppState);
  }
  async function killDreamTask(taskId_2: string): Promise<void> {
    await DreamTask.kill(taskId_2, setAppState);
  }
  async function killRemoteAgentTask(taskId_3: string): Promise<void> {
    await RemoteAgentTask.kill(taskId_3, setAppState);
  }

  // 用 useEffectEvent 包装 onDone，获得稳定引用，始终调用当前 onDone 回调，
  // 而不会导致 effect 重新触发。
  const onDoneEvent = useEffectEvent(onDone);
  useEffect(() => {
    if (viewState.mode !== 'list') {
      const task = (typedTasks ?? {})[viewState.itemId];
      // Workflow 任务有宽限期：它们的详情视图在完成后保持打开，
      // 这样用户可以在被清除前看到最终状态。
      if (!task || task.type !== 'local_workflow' && !isBackgroundTask(task)) {
        // 任务已被移除或不再是后台任务（例如被终止）。
        // 如果挂载时跳过了列表，则完全关闭对话框。
        if (skippedListOnMount.current) {
          onDoneEvent('Background tasks dialog dismissed', {
            display: 'system'
          });
        } else {
          setViewState({
            mode: 'list'
          });
        }
      }
    }
    const totalItems = allSelectableItems.length;
    if (selectedIndex >= totalItems && totalItems > 0) {
      setSelectedIndex(totalItems - 1);
    }
  }, [viewState, typedTasks, selectedIndex, allSelectableItems, onDoneEvent]);

  // 返回列表视图的辅助函数（如果挂载时跳过了列表且仍只有 ≤1 项，则关闭对话框）。
  // 检查当前计数可防止过时状态陷阱：如果打开时只有 1 个任务（自动跳到详情），
  // 然后第二个任务开始了，"返回"应显示列表——而非关闭。
  const goBackToList = () => {
    if (skippedListOnMount.current && allSelectableItems.length <= 1) {
      onDone(tSync('backgroundTasks.dismissed'), {
        display: 'system'
      });
    } else {
      skippedListOnMount.current = false;
      setViewState({
        mode: 'list'
      });
    }
  };

  // 如果选中了某项，显示相应的视图
  if (viewState.mode !== 'list' && typedTasks) {
    const task_0 = typedTasks[viewState.itemId];
    if (!task_0) {
      return null;
    }

    // 详情模式——显示相应的详情对话框
    switch (task_0.type) {
      case 'local_bash':
        return <ShellDetailDialog shell={task_0} onDone={onDone} onKillShell={() => void killShellTask(task_0.id)} onBack={goBackToList} key={`shell-${task_0.id}`} />;
      case 'local_agent':
        return <AsyncAgentDetailDialog agent={task_0} onDone={onDone} onKillAgent={() => void killAgentTask(task_0.id)} onBack={goBackToList} key={`agent-${task_0.id}`} />;
      case 'remote_agent':
        return <RemoteSessionDetailDialog session={task_0} onDone={onDone} toolUseContext={toolUseContext} onBack={goBackToList} onKill={task_0.status !== 'running' ? undefined : task_0.isUltraplan ? () => void stopUltraplan(task_0.id, task_0.sessionId, setAppState) : () => void killRemoteAgentTask(task_0.id)} key={`session-${task_0.id}`} />;
      case 'in_process_teammate':
        return <InProcessTeammateDetailDialog teammate={task_0} onDone={onDone} onKill={task_0.status === 'running' ? () => void killTeammateTask(task_0.id) : undefined} onBack={goBackToList} onForeground={task_0.status === 'running' ? () => {
          enterTeammateView(task_0.id, setAppState);
          onDone(tSync('backgroundTasks.dismissed'), {
            display: 'system'
          });
        } : undefined} key={`teammate-${task_0.id}`} />;
      case 'local_workflow':
        if (!WorkflowDetailDialog) return null;
        return <WorkflowDetailDialog workflow={task_0} onDone={onDone} onKill={task_0.status === 'running' && killWorkflowTask ? () => killWorkflowTask(task_0.id, setAppState) : undefined} onSkipAgent={task_0.status === 'running' && skipWorkflowAgent ? agentId => skipWorkflowAgent(task_0.id, agentId, setAppState) : undefined} onRetryAgent={task_0.status === 'running' && retryWorkflowAgent ? agentId_0 => retryWorkflowAgent(task_0.id, agentId_0, setAppState) : undefined} onBack={goBackToList} key={`workflow-${task_0.id}`} />;
      case 'monitor_mcp':
        if (!MonitorMcpDetailDialog) return null;
        return <MonitorMcpDetailDialog task={task_0} onKill={task_0.status === 'running' && killMonitorMcp ? () => killMonitorMcp(task_0.id, setAppState) : undefined} onBack={goBackToList} key={`monitor-mcp-${task_0.id}`} />;
      case 'dream':
        return <DreamDetailDialog task={task_0} onDone={() => onDone('Background tasks dialog dismissed', {
          display: 'system'
        })} onBack={goBackToList} onKill={task_0.status === 'running' ? () => void killDreamTask(task_0.id) : undefined} key={`dream-${task_0.id}`} />;
    }
  }
  const runningBashCount = count(bashTasks, _ => _.status === 'running');
  const runningAgentCount = count(remoteSessions, __0 => __0.status === 'running' || __0.status === 'pending') + count(agentTasks, __1 => __1.status === 'running');
  const runningTeammateCount = count(teammateTasks, __2 => __2.status === 'running');
  const subtitle = intersperse([...(runningTeammateCount > 0 ? [<Text key="teammates">
              {runningTeammateCount}{' '}
              {runningTeammateCount !== 1 ? tSync('backgroundTasks.agent') : tSync('backgroundTasks.agentSingular')}
            </Text>] : []), ...(runningBashCount > 0 ? [<Text key="shells">
              {runningBashCount}{' '}
              {runningBashCount !== 1 ? tSync('backgroundTasks.activeShells') : tSync('backgroundTasks.activeShell')}
            </Text>] : []), ...(runningAgentCount > 0 ? [<Text key="agents">
              {runningAgentCount}{' '}
              {runningAgentCount !== 1 ? tSync('backgroundTasks.activeAgents') : tSync('backgroundTasks.activeAgent')}
            </Text>] : [])], index => <Text key={`separator-${index}`}> · </Text>);
  const actions = [<KeyboardShortcutHint key="upDown" shortcut="↑/↓" action={tSync('backgroundTasks.action.select')} />, <KeyboardShortcutHint key="enter" shortcut="Enter" action={tSync('backgroundTasks.action.view')} />, ...(currentSelection?.type === 'in_process_teammate' && currentSelection.status === 'running' ? [<KeyboardShortcutHint key="foreground" shortcut="f" action={tSync('backgroundTasks.action.foreground')} />] : []), ...((currentSelection?.type === 'local_bash' || currentSelection?.type === 'local_agent' || currentSelection?.type === 'in_process_teammate' || currentSelection?.type === 'local_workflow' || currentSelection?.type === 'monitor_mcp' || currentSelection?.type === 'dream' || currentSelection?.type === 'remote_agent') && currentSelection.status === 'running' ? [<KeyboardShortcutHint key="kill" shortcut="x" action={tSync('backgroundTasks.action.stop')} />] : []), ...(agentTasks.some(t => t.status === 'running') ? [<KeyboardShortcutHint key="kill-all" shortcut={killAgentsShortcut} action={tSync('backgroundTasks.action.stopAll')} />] : []), <KeyboardShortcutHint key="esc" shortcut="←/Esc" action={tSync('backgroundTasks.action.close')} />];
  const handleCancel = () => onDone('Background tasks dialog dismissed', {
    display: 'system'
  });
  function renderInputGuide(exitState: ExitState): React.ReactNode {
    if (exitState.pending) {
      return <Text>{tSync('backgroundTasks.pressAgainToExit', {
          key: exitState.keyName
        })}</Text>;
    }
    return <Byline>{actions}</Byline>;
  }
  return <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog title={tSync('backgroundTasks.title')} subtitle={<>{subtitle}</>} onCancel={handleCancel} color="background" inputGuide={renderInputGuide}>
        {allSelectableItems.length === 0 ? <Text dimColor>{tSync('backgroundTasks.noTasks')}</Text> : <Box flexDirection="column">
            {teammateTasks.length > 0 && <Box flexDirection="column">
                {(bashTasks.length > 0 || remoteSessions.length > 0 || agentTasks.length > 0) && <Text dimColor>
                    <Text bold>{'  '}{tSync('backgroundTasks.agents')}</Text> (
                    {count(teammateTasks, i => i.type !== 'leader')})
                  </Text>}
                <Box flexDirection="column">
                  <TeammateTaskGroups teammateTasks={teammateTasks} currentSelectionId={currentSelection?.id} />
                </Box>
              </Box>}

            {bashTasks.length > 0 && <Box flexDirection="column" marginTop={teammateTasks.length > 0 ? 1 : 0}>
                {(teammateTasks.length > 0 || remoteSessions.length > 0 || agentTasks.length > 0) && <Text dimColor>
                    <Text bold>{'  '}{tSync('backgroundTasks.shells')}</Text> ({bashTasks.length})
                  </Text>}
                <Box flexDirection="column">
                  {bashTasks.map(item_6 => <Item key={item_6.id} item={item_6} isSelected={item_6.id === currentSelection?.id} />)}
                </Box>
              </Box>}

            {mcpMonitors.length > 0 && <Box flexDirection="column" marginTop={teammateTasks.length > 0 || bashTasks.length > 0 ? 1 : 0}>
                <Text dimColor>
                  <Text bold>{'  '}{tSync('backgroundTasks.monitors')}</Text> ({mcpMonitors.length})
                </Text>
                <Box flexDirection="column">
                  {mcpMonitors.map(item_7 => <Item key={item_7.id} item={item_7} isSelected={item_7.id === currentSelection?.id} />)}
                </Box>
              </Box>}

            {remoteSessions.length > 0 && <Box flexDirection="column" marginTop={teammateTasks.length > 0 || bashTasks.length > 0 || mcpMonitors.length > 0 ? 1 : 0}>
                <Text dimColor>
                  <Text bold>{'  '}{tSync('backgroundTasks.remoteAgents')}</Text> ({remoteSessions.length}
                  )
                </Text>
                <Box flexDirection="column">
                  {remoteSessions.map(item_8 => <Item key={item_8.id} item={item_8} isSelected={item_8.id === currentSelection?.id} />)}
                </Box>
              </Box>}

            {agentTasks.length > 0 && <Box flexDirection="column" marginTop={teammateTasks.length > 0 || bashTasks.length > 0 || mcpMonitors.length > 0 || remoteSessions.length > 0 ? 1 : 0}>
                <Text dimColor>
                  <Text bold>{'  '}{tSync('backgroundTasks.localAgents')}</Text> ({agentTasks.length})
                </Text>
                <Box flexDirection="column">
                  {agentTasks.map(item_9 => <Item key={item_9.id} item={item_9} isSelected={item_9.id === currentSelection?.id} />)}
                </Box>
              </Box>}

            {workflowTasks.length > 0 && <Box flexDirection="column" marginTop={teammateTasks.length > 0 || bashTasks.length > 0 || mcpMonitors.length > 0 || remoteSessions.length > 0 || agentTasks.length > 0 ? 1 : 0}>
                <Text dimColor>
                  <Text bold>{'  '}{tSync('backgroundTasks.workflows')}</Text> ({workflowTasks.length})
                </Text>
                <Box flexDirection="column">
                  {workflowTasks.map(item_10 => <Item key={item_10.id} item={item_10} isSelected={item_10.id === currentSelection?.id} />)}
                </Box>
              </Box>}

            {dreamTasks_0.length > 0 && <Box flexDirection="column" marginTop={teammateTasks.length > 0 || bashTasks.length > 0 || mcpMonitors.length > 0 || remoteSessions.length > 0 || agentTasks.length > 0 || workflowTasks.length > 0 ? 1 : 0}>
                <Box flexDirection="column">
                  {dreamTasks_0.map(item_11 => <Item key={item_11.id} item={item_11} isSelected={item_11.id === currentSelection?.id} />)}
                </Box>
              </Box>}
          </Box>}
      </Dialog>
    </Box>;
}
function toListItem(task: BackgroundTaskState): ListItem {
  switch (task.type) {
    case 'local_bash':
      return {
        id: task.id,
        type: 'local_bash',
        label: task.kind === 'monitor' ? task.description : task.command,
        status: task.status,
        task
      };
    case 'remote_agent':
      return {
        id: task.id,
        type: 'remote_agent',
        label: task.title,
        status: task.status,
        task
      };
    case 'local_agent':
      return {
        id: task.id,
        type: 'local_agent',
        label: task.description,
        status: task.status,
        task
      };
    case 'in_process_teammate':
      return {
        id: task.id,
        type: 'in_process_teammate',
        label: `@${task.identity.agentName}`,
        status: task.status,
        task
      };
    case 'local_workflow':
      return {
        id: task.id,
        type: 'local_workflow',
        label: task.summary ?? task.description,
        status: task.status,
        task
      };
    case 'monitor_mcp':
      return {
        id: task.id,
        type: 'monitor_mcp',
        label: task.description,
        status: task.status,
        task
      };
    case 'dream':
      return {
        id: task.id,
        type: 'dream',
        label: task.description,
        status: task.status,
        task
      };
  }
}
function Item({
  item,
  isSelected
}) {
  const {
    columns
  } = useTerminalSize();
  const maxActivityWidth = Math.max(30, columns - 26);
  const useGreyPointer = isCoordinatorMode();
  return <Box flexDirection="row">{<Text dimColor={useGreyPointer && isSelected}>{isSelected ? figures.pointer + " " : "  "}</Text>}{<Text color={isSelected && !useGreyPointer ? "suggestion" : undefined}>{item.type === "leader" ? <Text>@{TEAM_LEAD_NAME}</Text> : <BackgroundTaskComponent task={item.task} maxActivityWidth={maxActivityWidth} />}</Text>}</Box>;
}
function TeammateTaskGroups({
  teammateTasks,
  currentSelectionId
}) {
  const leaderItems = teammateTasks.filter(i => i.type === "leader");
  const teammateItems = teammateTasks.filter(i_0 => i_0.type === "in_process_teammate");
  const teams = new Map();
  for (const item of teammateItems) {
    const teamName = item.task.identity.teamName;
    const group = teams.get(teamName);
    if (group) {
      group.push(item);
    } else {
      teams.set(teamName, [item]);
    }
  }
  const teamEntries = [...teams.entries()];
  return <>{teamEntries.map(t2 => {
      const [teamName_0, items] = t2;
      const memberCount = items.length + leaderItems.length;
      return <Box key={teamName_0} flexDirection="column"><Text dimColor={true}>{"  "}{tSync('backgroundTasks.team')}: {teamName_0} ({memberCount})</Text>{leaderItems.map(item_0 => <Item key={`${item_0.id}-${teamName_0}`} item={item_0} isSelected={item_0.id === currentSelectionId} />)}{items.map(item_1 => <Item key={item_1.id} item={item_1} isSelected={item_1.id === currentSelectionId} />)}</Box>;
    })}</>;
}
