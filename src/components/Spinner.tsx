// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { Box, Text } from '../ink.js';
import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { computeGlimmerIndex, computeShimmerSegments, SHIMMER_INTERVAL_MS } from '../bridge/bridgeStatusUtil.js';
import { feature } from 'bun:bundle';
import { getKairosActive, getUserMsgOptIn } from '../bootstrap/state.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js';
import { isEnvTruthy, isInternalBuild } from '../utils/envUtils.js';
import { count } from '../utils/array.js';
import sample from 'lodash-es/sample.js';
import { formatDuration, formatNumber } from '../utils/format.js';
import type { Theme } from 'src/utils/theme.js';
import { activityManager } from '../utils/activityManager.js';
import { getSpinnerVerbs } from '../constants/spinnerVerbs.js';
import { MessageResponse } from './MessageResponse.js';
import { TaskListV2 } from './TaskListV2.js';
import { useTasksV2 } from '../hooks/useTasksV2.js';
import type { Task } from '../utils/tasks.js';
import { useAppState } from '../state/AppState.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { stringWidth } from '../ink/stringWidth.js';
import { getDefaultCharacters, type SpinnerMode } from './Spinner/index.js';
import { SpinnerAnimationRow } from './Spinner/SpinnerAnimationRow.js';
import { useSettings } from '../hooks/useSettings.js';
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js';
import { isBackgroundTask } from '../tasks/types.js';
import { getAllInProcessTeammateTasks } from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import { getEffortSuffix } from '../utils/effort.js';
import { getMainLoopModel } from '../utils/model/model.js';
import { getViewedTeammateTask } from '../state/selectors.js';
import { TEARDROP_ASTERISK } from '../constants/figures.js';
import { getCurrentTurnTokenBudget, getTurnOutputTokens } from '../bootstrap/state.js';
import { TeammateSpinnerTree } from './Spinner/TeammateSpinnerTree.js';
import { useAnimationFrame } from '../ink.js';
import { getGlobalConfig } from '../utils/config.js';
import { tSync } from '../i18n/index.js';
export type { SpinnerMode } from './Spinner/index.js';
const DEFAULT_CHARACTERS = getDefaultCharacters();
const SPINNER_FRAMES = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()];
type Props = {
  mode: SpinnerMode;
  loadingStartTimeRef: React.RefObject<number>;
  totalPausedMsRef: React.RefObject<number>;
  pauseStartTimeRef: React.RefObject<number | null>;
  spinnerTip?: string;
  responseLengthRef: React.RefObject<number>;
  overrideColor?: keyof Theme | null;
  overrideShimmerColor?: keyof Theme | null;
  overrideMessage?: string | null;
  spinnerSuffix?: string | null;
  verbose: boolean;
  hasActiveTools?: boolean;
  /** Leader 的 turn 已完成（无活跃查询）。用于仅在 teammates 运行时抑制停滞红色 spinner。 */
  leaderIsIdle?: boolean;
};

// 薄包装：根据 isBriefOnly 分支，使两个变体有独立的 hook 调用链。
// 没有这个分割，在渲染中途切换 /brief 会违反 Hooks 规则
// （内部变体调用约 10 个额外的 hook）。
export function SpinnerWithVerb(props: Props): React.ReactNode {
  const isBriefOnly = useAppState(s => s.isBriefOnly);
  // REPL 在查看 teammate transcript 时将 isBriefOnly 覆盖为 false
  // （参见 isBriefOnly={viewedTeammateTask ? false : isBriefOnly}）。
  // 该 prop 未传递到这里，所以从 store 复制 gate——
  // teammate 视图需要真正的 spinner（显示 teammate 状态）。
  const viewingAgentTaskId = useAppState(s_0 => s_0.viewingAgentTaskId);
  // 提升到 mount 时——该组件以动画帧率重新渲染。
  const briefEnvEnabled = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useMemo(() => isEnvTruthy(process.env.ZY_CODE_BRIEF), []) : false;

  // 运行时 gate 镜像 isBriefEnabled() 但内联——从 BriefTool.ts 导入会
  // 将 tool 名称字符串泄漏到 external build 中。单个 spinner 实例 →
  // hook 保持无条件（两个订阅，可忽略不计）。
  if ((feature('KAIROS') || feature('KAIROS_BRIEF')) && (getKairosActive() || getUserMsgOptIn() && (briefEnvEnabled || getFeatureValue_CACHED_MAY_BE_STALE('tengu_kairos_brief', false))) && isBriefOnly && !viewingAgentTaskId) {
    return <BriefSpinner mode={props.mode} overrideMessage={props.overrideMessage} />;
  }
  return <SpinnerWithVerbInner {...props} />;
}
function SpinnerWithVerbInner({
  mode,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  spinnerTip,
  responseLengthRef,
  overrideColor,
  overrideShimmerColor,
  overrideMessage,
  spinnerSuffix,
  verbose,
  hasActiveTools = false,
  leaderIsIdle = false
}: Props): React.ReactNode {
  const settings = useSettings();
  const reducedMotion = settings.prefersReducedMotion ?? false;

  // NOTE: useAnimationFrame(50) 位于 SpinnerAnimationRow 中，不在这里。
  // 该组件仅在 props 或 app state 变化时重新渲染——
  // 不再在 50ms 时钟上。所有 `time` 派生的值
  // （frame、glimmer、stalled intensity、token 计数器、thinking shimmer、
  // 经过时间计时器）都在子组件中计算。

  const tasks = useAppState(s => s.tasks);
  const viewingAgentTaskId = useAppState(s_0 => s_0.viewingAgentTaskId);
  const expandedView = useAppState(s_1 => s_1.expandedView);
  const showExpandedTodos = expandedView === 'tasks';
  const showSpinnerTree = expandedView === 'teammates';
  const selectedIPAgentIndex = useAppState(s_2 => s_2.selectedIPAgentIndex);
  const viewSelectionMode = useAppState(s_3 => s_3.viewSelectionMode);
  // 获取 foregrounded teammate（如果正在查看 teammate 的 transcript）
  const foregroundedTeammate = viewingAgentTaskId ? getViewedTeammateTask({
    viewingAgentTaskId,
    tasks
  }) : undefined;
  const {
    columns
  } = useTerminalSize();
  const tasksV2 = useTasksV2();

  // 追踪 thinking 状态：'thinking' | number（持续时间 ms）| null
  // 每个状态至少显示 2s，以避免 UI 抖动
  const [thinkingStatus, setThinkingStatus] = useState<'thinking' | number | null>(null);
  const thinkingStartRef = useRef<number | null>(null);
  useEffect(() => {
    let showDurationTimer: ReturnType<typeof setTimeout> | null = null;
    let clearStatusTimer: ReturnType<typeof setTimeout> | null = null;
    if (mode === 'thinking') {
      // 开始 thinking
      if (thinkingStartRef.current === null) {
        thinkingStartRef.current = Date.now();
        setThinkingStatus('thinking');
      }
    } else if (thinkingStartRef.current !== null) {
      // 停止 thinking - 计算持续时间并确保至少显示 2s
      const duration = Date.now() - thinkingStartRef.current;
      const elapsed = Date.now() - thinkingStartRef.current;
      const remainingThinkingTime = Math.max(0, 2000 - elapsed);
      thinkingStartRef.current = null;

      // 如果经过时间 < 2s，在剩余时间内显示"thinking..."，然后显示持续时间
      const showDuration = (): void => {
        setThinkingStatus(duration);
        // 2s 后清除
        clearStatusTimer = setTimeout(setThinkingStatus, 2000, null);
      };
      if (remainingThinkingTime > 0) {
        showDurationTimer = setTimeout(showDuration, remainingThinkingTime);
      } else {
        showDuration();
      }
    }
    return () => {
      if (showDurationTimer) clearTimeout(showDurationTimer);
      if (clearStatusTimer) clearTimeout(clearStatusTimer);
    };
  }, [mode]);

  // 查找当前进行中的任务和下一个 pending 任务
  const currentTodo = tasksV2?.find(task => task.status !== 'pending' && task.status !== 'completed');
  const nextTask = findNextPendingTask(tasksV2);

  // 使用带初始化器的 useState，在 mount 时随机选择一个 verb
  const [randomVerb] = useState(() => sample(getSpinnerVerbs()));

  // Leader 自己的 verb（始终是 leader 的，无论谁被 foregrounded）
  const leaderVerb = overrideMessage ?? currentTodo?.activeForm ?? currentTodo?.subject ?? randomVerb;
  const effectiveVerb = foregroundedTeammate && !foregroundedTeammate.isIdle ? foregroundedTeammate.spinnerVerb ?? randomVerb : leaderVerb;
  const message = effectiveVerb + '…';

  // spinner 活跃时追踪 CLI 活动
  useEffect(() => {
    const operationId = 'spinner-' + mode;
    activityManager.startCLIActivity(operationId);
    return () => {
      activityManager.endCLIActivity(operationId);
    };
  }, [mode]);
  const effortValue = useAppState(s_4 => s_4.effortValue);
  const effortSuffix = getEffortSuffix(getMainLoopModel(), effortValue);

  // 检查是否有运行中的 in-process teammates（两种模式都需要）
  const runningTeammates = getAllInProcessTeammateTasks(tasks).filter(t => t.status === 'running');
  const hasRunningTeammates = runningTeammates.length > 0;
  const allIdle = hasRunningTeammates && runningTeammates.every(teammate => teammate.isIdle);

  // 收集所有运行中 swarm teammates 的聚合 token 统计
  // 在 spinner-tree 模式下，跳过聚合（teammates 在树中有自己的行）
  let teammateTokens = 0;
  if (!showSpinnerTree) {
    for (const task_0 of Object.values(tasks)) {
      if (isInProcessTeammateTask(task_0) && task_0.status === 'running') {
        if (task_0.progress?.tokenCount) {
          teammateTokens += task_0.progress.tokenCount;
        }
      }
    }
  }

  // 对下面 showBtwTip 的 refs 进行陈旧读取——我们不在 50ms 时钟上，
  // 所以这仅在 props/app state 变化时更新，对于粗略的 30s 阈值已足够。
  const elapsedSnapshot = pauseStartTimeRef.current !== null ? pauseStartTimeRef.current - loadingStartTimeRef.current - totalPausedMsRef.current : Date.now() - loadingStartTimeRef.current - totalPausedMsRef.current;

  // TeammateSpinnerTree 的 Leader token 计数——从 ref 读取原始（非动画）值。
  // 该树仅在 teammates 运行时显示；teammate 进度更新到 s.tasks 会触发
  // 重新渲染以保持此值新鲜。
  const leaderTokenCount = Math.round(responseLengthRef.current / 4);
  const defaultColor: keyof Theme = 'zy';
  const defaultShimmerColor = 'ZyShimmer';
  const messageColor = overrideColor ?? defaultColor;
  const shimmerColor = overrideShimmerColor ?? defaultShimmerColor;

  // 在此处计算 TTFT 字符串（不在 50ms 动画时钟上）并传递给
  // 我们在父组件约 25 次/turn 的重新渲染节奏上获取更新，
  // 与旧的 ApiMetricsLine 相同。
  let ttftText: string | null = null;
  // @ts-ignore -- ant-only: apiMetricsRef and computeTtftText are only available in internal builds
  if (isInternalBuild() && apiMetricsRef?.current && apiMetricsRef.current.length > 0) {
    // @ts-ignore -- ant-only
    ttftText = computeTtftText(apiMetricsRef.current);
  }

  // 当 leader 空闲但 teammates 在运行（且我们正在查看 leader）时，
  // 显示静态的暗色空闲显示而不是动画 spinner——否则
  // useStalledAnimation 在 3s 后检测不到新 token 会将 spinner 变红。
  if (leaderIsIdle && hasRunningTeammates && !foregroundedTeammate) {
    return <Box flexDirection="column" width="100%" alignItems="flex-start">
        <Box flexDirection="row" flexWrap="wrap" marginTop={1} width="100%">
          <Text dimColor>
            {TEARDROP_ASTERISK} {tSync('spinner.idle')}
            {!allIdle && ` · ${tSync('spinner.teammatesRunning')}`}
          </Text>
        </Box>
        {showSpinnerTree && <TeammateSpinnerTree selectedIndex={selectedIPAgentIndex} isInSelectionMode={viewSelectionMode === 'selecting-agent'} allIdle={allIdle} leaderTokenCount={leaderTokenCount} leaderIdleText={tSync('spinner.idle')} />}
      </Box>;
  }

  // 查看空闲的 teammate 时，显示静态空闲显示而不是动画 spinner
  if (foregroundedTeammate?.isIdle) {
    const idleText = allIdle ? `${TEARDROP_ASTERISK} ${tSync('spinner.workedFor', {
      duration: formatDuration(Date.now() - foregroundedTeammate.startTime)
    })}` : `${TEARDROP_ASTERISK} ${tSync('spinner.idle')}`;
    return <Box flexDirection="column" width="100%" alignItems="flex-start">
        <Box flexDirection="row" flexWrap="wrap" marginTop={1} width="100%">
          <Text dimColor>{idleText}</Text>
        </Box>
        {showSpinnerTree && hasRunningTeammates && <TeammateSpinnerTree selectedIndex={selectedIPAgentIndex} isInSelectionMode={viewSelectionMode === 'selecting-agent'} allIdle={allIdle} leaderVerb={leaderIsIdle ? undefined : leaderVerb} leaderIdleText={leaderIsIdle ? tSync('spinner.idle') : undefined} leaderTokenCount={leaderTokenCount} />}
      </Box>;
  }

  // 基于时间的 tip 覆盖：粗略的阈值，因此陈旧的 ref 读取（我们不在 50ms 时钟上）没问题。
  // 其他触发器（mode 变化、setMessages）实际上会导致重新渲染来刷新这个。
  let contextTipsActive = false;
  const tipsEnabled = settings.spinnerTipsEnabled !== false;
  const showClearTip = tipsEnabled && elapsedSnapshot > 1_800_000;
  const showBtwTip = tipsEnabled && elapsedSnapshot > 30_000 && !getGlobalConfig().btwUseCount;
  const effectiveTip = contextTipsActive ? undefined : showClearTip && !nextTask ? tSync('tip.clearContext') : showBtwTip && !nextTask ? tSync('tip.btwSideQuestion') : spinnerTip;

  // Budget 文本（仅 ant）——显示在 tip 行上方
  let budgetText: string | null = null;
  if (feature('TOKEN_BUDGET')) {
    const budget = getCurrentTurnTokenBudget();
    if (budget !== null && budget > 0) {
      const tokens = getTurnOutputTokens();
      if (tokens >= budget) {
        budgetText = tSync('spinner.targetUsed', {
          used: formatNumber(tokens),
          budget: formatNumber(budget)
        });
      } else {
        const pct = Math.round(tokens / budget * 100);
        const remaining = budget - tokens;
        const rate = elapsedSnapshot > 5000 && tokens >= 2000 ? tokens / elapsedSnapshot : 0;
        const eta = rate > 0 ? ` \u00B7 ~${formatDuration(remaining / rate, {
          mostSignificantOnly: true
        })}` : '';
        budgetText = tSync('spinner.targetPercent', {
          used: formatNumber(tokens),
          budget: formatNumber(budget),
          pct,
          eta
        });
      }
    }
  }
  return <Box flexDirection="column" width="100%" alignItems="flex-start">
      <SpinnerAnimationRow mode={mode} reducedMotion={reducedMotion} hasActiveTools={hasActiveTools} responseLengthRef={responseLengthRef} message={message} messageColor={messageColor} shimmerColor={shimmerColor} overrideColor={overrideColor} loadingStartTimeRef={loadingStartTimeRef} totalPausedMsRef={totalPausedMsRef} pauseStartTimeRef={pauseStartTimeRef} spinnerSuffix={spinnerSuffix} verbose={verbose} columns={columns} hasRunningTeammates={hasRunningTeammates} teammateTokens={teammateTokens} foregroundedTeammate={foregroundedTeammate} leaderIsIdle={leaderIsIdle} thinkingStatus={thinkingStatus} effortSuffix={effortSuffix} />
      {showSpinnerTree && hasRunningTeammates ? <TeammateSpinnerTree selectedIndex={selectedIPAgentIndex} isInSelectionMode={viewSelectionMode === 'selecting-agent'} allIdle={allIdle} leaderVerb={leaderIsIdle ? undefined : leaderVerb} leaderIdleText={leaderIsIdle ? 'Idle' : undefined} leaderTokenCount={leaderTokenCount} /> : showExpandedTodos && tasksV2 && tasksV2.length > 0 ? <Box width="100%" flexDirection="column">
          <MessageResponse>
            <TaskListV2 tasks={tasksV2} />
          </MessageResponse>
        </Box> : nextTask || effectiveTip || budgetText ?
    // 重要：我们需要这个 width="100%" 来避免 Ink bug，
    // 当 spinner 运行时如果终端非常小，tip 会被反复复制。TODO: 在 Ink 中修复这个问题。
    <Box width="100%" flexDirection="column">
          {budgetText && <MessageResponse>
              <Text dimColor>{budgetText}</Text>
            </MessageResponse>}
          {(nextTask || effectiveTip) && <MessageResponse>
              <Text dimColor>
                {nextTask ? tSync('spinner.next', {
            subject: nextTask.subject
          }) : tSync('spinner.tip', {
            tip: effectiveTip
          })}
              </Text>
            </MessageResponse>}
        </Box> : null}
    </Box>;
}

// Brief/assistant 模式 spinner：单行状态。PromptInput 在 isBriefOnly 活跃时
// 丢弃自己的 marginTop，因此该组件拥有消息和输入之间的 2 行占位。
// 占位是 [blank, content]——上方一行空白（消息列表下的呼吸空间），
// spinner 紧贴输入栏。PromptInput 的绝对定位 Notifications 覆盖在
// brief 模式下用 marginTop=-2 补偿（PromptInput.tsx:~2928），这样它
// 浮动到 spinner 上方的空白行，而不是覆盖 spinner 内容。与 BriefIdleStatus
// 配对，在空闲时保持相同的占位。
type BriefSpinnerProps = {
  mode: SpinnerMode;
  overrideMessage?: string | null;
};
function BriefSpinner({
  mode,
  overrideMessage
}: BriefSpinnerProps) {
  const settings = useSettings();
  const reducedMotion = settings.prefersReducedMotion ?? false;
  const [randomVerb] = useState(() => sample(getSpinnerVerbs()) ?? "Working");
  const verb = overrideMessage ?? randomVerb;
  const connStatus = useAppState(s => s.remoteConnectionStatus);
  useEffect(() => {
    const operationId = "spinner-" + mode;
    activityManager.startCLIActivity(operationId);
    return () => {
      activityManager.endCLIActivity(operationId);
    };
  }, [mode]);
  const [, time] = useAnimationFrame(reducedMotion ? null : 120);
  const runningCount = useAppState(s_0 => count(Object.values(s_0.tasks), isBackgroundTask) + s_0.remoteBackgroundTaskCount);
  const showConnWarning = connStatus === "reconnecting" || connStatus === "disconnected";
  const connText = connStatus === "reconnecting" ? tSync('spinner.reconnecting') : tSync('spinner.disconnected');
  const dotFrame = Math.floor(time / 300) % 3;
  const dots = reducedMotion ? "\u2026  " : ".".repeat(dotFrame + 1).padEnd(3);
  const verbWidth = stringWidth(verb);
  const glimmerIndex = reducedMotion || showConnWarning ? -100 : computeGlimmerIndex(Math.floor(time / SHIMMER_INTERVAL_MS), verbWidth);
  const {
    before,
    shimmer,
    after
  } = computeShimmerSegments(verb, glimmerIndex);
  const {
    columns
  } = useTerminalSize();
  const rightText = runningCount > 0 ? tSync('spinner.inBackground', {
    count: runningCount
  }) : "";
  const textWidth = showConnWarning ? stringWidth(connText) : verbWidth;
  const leftWidth = textWidth + 3;
  const pad = Math.max(1, columns - 2 - leftWidth - stringWidth(rightText));
  return <Box flexDirection="row" width="100%" marginTop={1} paddingLeft={2}>{showConnWarning ? <Text color="error">{connText + dots}</Text> : <>{before ? <Text dimColor={true}>{before}</Text> : null}{shimmer ? <Text>{shimmer}</Text> : null}{after ? <Text dimColor={true}>{after}</Text> : null}<Text dimColor={true}>{dots}</Text></>}{rightText ? <><Text>{" ".repeat(pad)}</Text><Text color="subtle">{rightText}</Text></> : null}</Box>;
}

// brief 模式的空闲占位符。与 BriefSpinner 相同的 2 行 [blank, content] 占位，
// 这样在 working/idle/disconnected 之间切换时输入栏永远不会跳动。
// 有关 Notifications 覆盖耦合，请参阅 BriefSpinner 的注释。

export function BriefIdleStatus() {
  const connStatus = useAppState(s => s.remoteConnectionStatus);
  const runningCount = useAppState(s_0 => count(Object.values(s_0.tasks), isBackgroundTask) + s_0.remoteBackgroundTaskCount);
  const {
    columns
  } = useTerminalSize();
  const showConnWarning = connStatus === "reconnecting" || connStatus === "disconnected";
  const connText = connStatus === "reconnecting" ? tSync('spinner.reconnecting') + '\u2026' : tSync('spinner.disconnected');
  const leftText = showConnWarning ? connText : "";
  const rightText = runningCount > 0 ? tSync('spinner.inBackground', {
    count: runningCount
  }) : "";
  if (!leftText && !rightText) {
    return <Box height={2} />;
  }
  const pad = Math.max(1, columns - 2 - stringWidth(leftText) - stringWidth(rightText));
  return <Box marginTop={1} paddingLeft={2}><Text>{leftText ? <Text color="error">{leftText}</Text> : null}{rightText ? <><Text>{" ".repeat(pad)}</Text><Text color="subtle">{rightText}</Text></> : null}</Text></Box>;
}
export function Spinner() {
  const settings = useSettings();
  const reducedMotion = settings.prefersReducedMotion ?? false;
  const [ref, time] = useAnimationFrame(reducedMotion ? null : 120);
  if (reducedMotion) {
    return <Box ref={ref} flexWrap="wrap" height={1} width={2}>{<Text color="text">●</Text>}</Box>;
  }
  const frame = Math.floor(time / 120) % SPINNER_FRAMES.length;
  return <Box ref={ref} flexWrap="wrap" height={1} width={2}>{<Text color="text">{SPINNER_FRAMES[frame]}</Text>}</Box>;
}
function findNextPendingTask(tasks: Task[] | undefined): Task | undefined {
  if (!tasks) {
    return undefined;
  }
  const pendingTasks = tasks.filter(t => t.status === 'pending');
  if (pendingTasks.length === 0) {
    return undefined;
  }
  const unresolvedIds = new Set(tasks.filter(t => t.status !== 'completed').map(t => t.id));
  return pendingTasks.find(t => !t.blockedBy.some(id => unresolvedIds.has(id))) ?? pendingTasks[0];
}
