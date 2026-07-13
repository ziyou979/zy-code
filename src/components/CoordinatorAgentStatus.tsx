/**
 * CoordinatorTaskPanel — Steerable list of background agents.
 *
 * Renders below the prompt input footer whenever local_agent tasks exist.
 * Visibility is driven by evictAfter: undefined (running/retained) shows
 * always; a timestamp shows until passed. Enter to view/steer, x to dismiss.
 */

import * as React from 'react'
import { BLACK_CIRCLE, POINTER, RADIO_OFF } from '../constants/figures.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { tSync } from '../i18n/index.js'
import { stringWidth } from '../ink/stringWidth.js'
import { Box, Text, wrapText } from '../ink.js'
import { evictTerminalTask } from '../services/task/framework.js'
import { type AppState, useAppState, useSetAppState } from '../state/AppState.js'
import { enterTeammateView, exitTeammateView } from '../state/teammateViewHelpers.js'
import {
  isPanelAgentTask,
  type LocalAgentTaskState,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { formatDuration } from '../utils/format.js'
import { isTerminalStatus } from './tasks/taskStatusUtils.js'

/**
 * Which panel-managed tasks currently have a visible row.
 * Presence in AppState.tasks IS visibility — the 1s tick in
 * CoordinatorTaskPanel evicts tasks past their evictAfter deadline. The
 * evictAfter !== 0 check handles immediate dismiss (x key) without making
 * the filter time-dependent. Shared by panel render, useCoordinatorTaskCount,
 * and index resolvers so the math can't drift.
 */
export function getVisibleAgentTasks(tasks: AppState['tasks']): LocalAgentTaskState[] {
  return Object.values(tasks)
    .filter((t): t is LocalAgentTaskState => isPanelAgentTask(t) && t.evictAfter !== 0)
    .sort((a, b) => a.startTime - b.startTime)
}
export function CoordinatorTaskPanel(): React.ReactNode {
  const tasks = useAppState((s) => s.tasks)
  const viewingAgentTaskId = useAppState((s_0) => s_0.viewingAgentTaskId)
  const coordinatorTaskIndex = useAppState((s_2) => s_2.coordinatorTaskIndex)
  const tasksSelected = useAppState((s_3) => s_3.footerSelection === 'tasks')
  const selectedIndex = tasksSelected ? coordinatorTaskIndex : undefined
  const setAppState = useSetAppState()
  const visibleTasks = getVisibleAgentTasks(tasks)
  const hasTasks = Object.values(tasks).some(isPanelAgentTask)

  // 1s tick: re-render for elapsed time + evict tasks past their deadline.
  // The eviction deletes from prev.tasks, which makes useCoordinatorTaskCount
  // (and other consumers) see the updated count without their own tick.
  const tasksRef = React.useRef(tasks)
  tasksRef.current = tasks
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    if (!hasTasks) {
      return
    }
    const interval = setInterval(
      (tasksRef_0, setAppState_0, setTick_0) => {
        const now = Date.now()
        for (const t of Object.values(tasksRef_0.current)) {
          if (isPanelAgentTask(t) && (t.evictAfter ?? Infinity) <= now) {
            evictTerminalTask(t.id, setAppState_0)
          }
        }
        setTick_0((prev: number) => prev + 1)
      },
      1000,
      tasksRef,
      setAppState,
      setTick,
    )
    return () => clearInterval(interval)
  }, [hasTasks, setAppState])
  if (visibleTasks.length === 0) {
    return null
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <MainLine
        isSelected={selectedIndex === 0}
        isViewed={viewingAgentTaskId === undefined}
        onClick={() => exitTeammateView(setAppState)}
      />
      {visibleTasks.map((task, i) => (
        <AgentLine
          key={task.id}
          task={task}
          isSelected={selectedIndex === i + 1}
          isViewed={viewingAgentTaskId === task.id}
          onClick={() => enterTeammateView(task.id, setAppState)}
        />
      ))}
    </Box>
  )
}

/**
 * Returns the number of selectable rows in CoordinatorTaskPanel:
 * 1 main row + one row per visible agent task. Returns 0 when no agent
 * task is visible (panel is hidden, no selection bounds needed).
 *
 * The panel's 1s tick evicts expired tasks from prev.tasks, so this
 * count stays accurate without needing its own tick.
 */
export function useCoordinatorTaskCount() {
  const tasks = useAppState((s) => s.tasks)
  return React.useMemo(() => {
    const visible = getVisibleAgentTasks(tasks)
    return visible.length === 0 ? 0 : visible.length + 1
  }, [tasks])
}
function MainLine({
  isSelected,
  isViewed,
  onClick,
}: {
  isSelected: boolean
  isViewed: boolean
  onClick: () => void
}) {
  const { columns } = useTerminalSize()
  const [hover, setHover] = React.useState(false)
  const highlighted = isSelected || hover
  const prefix = highlighted ? `${POINTER} ` : '  '
  const bullet = isViewed ? BLACK_CIRCLE : RADIO_OFF
  const dim = !highlighted && !isViewed
  const label = tSync('coordinator.main')
  const hint = tSync('coordinator.selectHint')
  // 右侧提示占用宽度计算：prefix + bullet + " " + label + 间距 + hint。
  // 预留 2 列安全边距，避免某些终端（如 Windows cmd）上 CJK 字符
  // 实际渲染宽度与 stringWidth 值不一致时 hint 尾部被裁剪。
  const used = stringWidth(prefix) + stringWidth(bullet) + 1 + stringWidth(label)
  const gap = Math.max(1, columns - used - stringWidth(hint) - 2)
  return (
    <Box onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <Text dimColor={dim} bold={isViewed}>
        {prefix}
        {bullet} {label}
        {' '.repeat(gap)}
      </Text>
      <Text dimColor={true}>{hint}</Text>
    </Box>
  )
}
// 获取 agent 类型的 i18n 显示标签，自定义类型 fallback 为原始 agentType
function getAgentTypeLabel(agentType: string): string {
  const key = `coordinator.agentType.${agentType}`
  const translated = tSync(key)
  return translated !== key ? translated : agentType
}

type AgentLineProps = {
  task: LocalAgentTaskState
  isSelected?: boolean
  isViewed?: boolean
  onClick?: () => void
}
function AgentLine({ task, isSelected, isViewed, onClick }: AgentLineProps) {
  const { columns } = useTerminalSize()
  const [hover, setHover] = React.useState(false)
  const isRunning = !isTerminalStatus(task.status)
  const pausedMs = task.totalPausedMs ?? 0
  const elapsedMs = Math.max(
    0,
    isRunning
      ? Date.now() - task.startTime - pausedMs
      : (task.endTime ?? task.startTime) - task.startTime - pausedMs,
  )
  const elapsed = formatDuration(elapsedMs)
  const displayDescription = task.progress?.summary || task.description
  const highlighted = isSelected || hover
  const prefix = highlighted ? `${POINTER} ` : '  '
  const bullet = isViewed ? BLACK_CIRCLE : RADIO_OFF
  const dim = !highlighted && !isViewed
  const typeLabel = getAgentTypeLabel(task.agentType)
  const typeLabelPart = `${typeLabel}  `
  // 描述左侧消耗的宽度 + 右侧 elapsed 占用宽度，剩下的空间留给描述与 gap
  const leftWidth = stringWidth(prefix) + stringWidth(bullet) + 1 + stringWidth(typeLabelPart)
  const rightWidth = stringWidth(elapsed)
  const availableForDesc = Math.max(0, columns - leftWidth - rightWidth - 1)
  const truncated = wrapText(displayDescription, availableForDesc, 'truncate-end')
  const gap = Math.max(1, columns - leftWidth - stringWidth(truncated) - rightWidth)
  const line = (
    <Box onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <Text dimColor={dim} bold={isViewed}>
        {prefix}
        {bullet}{' '}
        <Text dimColor={false} bold={true}>
          {typeLabel}
          {'  '}
        </Text>
        {truncated}
        {' '.repeat(gap)}
        {elapsed}
      </Text>
    </Box>
  )
  return line
}
