/**
 * Agent 运行时会话概览组件。
 *
 * 从 appState.tasks 中筛选 local_agent / in_process_teammate 类型 task，
 * 逐行渲染状态图标 + 名称 + 进度摘要 + 最近活动。
 * 支持通过 enterTeammateView 进入 Peek 模式。
 */

import * as React from 'react'
import { useMemo, useState } from 'react'
import {
  GREEN_CIRCLE,
  RED_CIRCLE,
  SMALL_RIGHT_TRIANGLE,
  WHITE_SQUARE,
  YELLOW_CIRCLE,
} from '../../constants/figures.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text, useInput } from '../../ink.js'
import type { AppState } from '../../state/AppStateStore.js'
import { enterTeammateView } from '../../state/teammateViewHelpers.js'
import {
  type InProcessTeammateTaskState,
  isInProcessTeammateTask,
} from '../../tasks/in-process-teammate-task/types.js'
import {
  isLocalAgentTask,
  type LocalAgentTaskState,
} from '../../tasks/local-agent-task/LocalAgentTask.js'
import { formatWaitingDuration } from '../../utils/format.js'

type AgentTask = LocalAgentTaskState | InProcessTeammateTaskState

type AgentSessionViewProps = {
  appState: AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
  onExit: () => void
}

/** 获取 agent task 的显示名称 */
function getAgentDisplayName(task: AgentTask): string {
  if (isInProcessTeammateTask(task)) {
    // plan accept / 自定义名：description 优先于 agentName
    if (task.description?.trim()) {
      return task.description.trim().slice(0, 80)
    }
    return task.identity.agentName || task.identity.agentId
  }
  if (isLocalAgentTask(task)) {
    // CC 2.1.207：plan accept 自动命名应显示在 agent-view 行（description 字段）
    if (task.description?.trim()) {
      return task.description.trim().slice(0, 80)
    }
    if (task.progress?.summary?.trim()) {
      return task.progress.summary.trim().slice(0, 80)
    }
    return task.selectedAgent?.agentType || task.agentType || task.agentId || 'agent'
  }
  return 'unknown'
}

/** 获取状态图标 */
function getStatusIcon(task: AgentTask): string {
  if (task.status === 'running') {
    return GREEN_CIRCLE
  }
  if (task.status === 'pending') {
    return YELLOW_CIRCLE
  }
  if (task.error) {
    return RED_CIRCLE
  }
  return WHITE_SQUARE
}

/** 获取状态标签 */
function getStatusLabel(task: AgentTask): string {
  if (isInProcessTeammateTask(task) && task.awaitingPlanApproval) {
    return tSync('agentView.awaitingApproval')
  }
  if (isInProcessTeammateTask(task) && task.isIdle && task.status === 'running') {
    return tSync('agentView.needsInput')
  }
  if (task.status === 'running') {
    return tSync('agentView.running')
  }
  if (task.status === 'pending') {
    return tSync('agentView.pending')
  }
  return tSync('agentView.completed')
}

/**
 * 阻塞/等待输入时的 peek 摘要（对齐 CC 2.1.207）：
 * 以问题/摘要打头 + 口语化等待时钟（waiting 3m），避免状态词与时间戳重复。
 */
export function getBlockedPeekSummary(task: AgentTask, nowMs: number = Date.now()): string {
  const isBlocked =
    isInProcessTeammateTask(task) &&
    (task.awaitingPlanApproval || (task.isIdle && task.status === 'running'))
  if (!isBlocked) {
    return ''
  }

  // 优先展示问题/摘要（progress.summary 或最近活动描述）
  const question =
    task.progress?.summary?.trim() ||
    task.progress?.lastActivity?.activityDescription?.trim() ||
    (task.awaitingPlanApproval
      ? tSync('agentView.awaitingApproval')
      : tSync('agentView.needsInput'))

  // 等待时钟：idleSince 优先，否则无时钟
  let clock = ''
  if (isInProcessTeammateTask(task) && task.idleSince) {
    clock = formatWaitingDuration(task.idleSince, nowMs)
  }

  // 若 question 已是状态词且无更具体内容，只显示 question · clock，不重复
  if (clock) {
    return `${question} · ${clock}`
  }
  return question
}

/** 获取进度摘要 */
function getProgressSummary(task: AgentTask): string {
  // 阻塞态：专用 peek 行，避免 status 标签与 activity 重复同一文案
  const blocked = getBlockedPeekSummary(task)
  if (blocked) {
    return blocked
  }

  const progress = task.progress
  if (!progress) {
    return ''
  }
  const parts: string[] = []
  if (progress.toolUseCount > 0) {
    parts.push(`${progress.toolUseCount} tools`)
  }
  if (progress.tokenCount > 0) {
    parts.push(`${(progress.tokenCount / 1000).toFixed(1)}k tokens`)
  }
  if (progress.lastActivity?.activityDescription) {
    parts.push(progress.lastActivity.activityDescription)
  }
  return parts.join(' · ')
}

export function AgentSessionView({
  appState,
  setAppState,
  onExit,
}: AgentSessionViewProps): React.ReactElement {
  // 从 tasks 中筛选 agent 类型的 task
  const agentTasks = useMemo(() => {
    const tasks: Array<{ id: string; task: AgentTask }> = []
    for (const [taskId, task] of Object.entries(appState.tasks)) {
      if (isLocalAgentTask(task) || isInProcessTeammateTask(task)) {
        tasks.push({ id: taskId, task })
      }
    }
    // 运行中的排前面，然后按 pending，最后 completed
    tasks.sort((a, b) => {
      const statusOrder = { running: 0, pending: 1, completed: 2 }
      const aOrder = statusOrder[a.task.status as keyof typeof statusOrder] ?? 2
      const bOrder = statusOrder[b.task.status as keyof typeof statusOrder] ?? 2
      return aOrder - bOrder
    })
    return tasks
  }, [appState.tasks])

  const [selectedIndex, setSelectedIndex] = useState(0)

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onExit()
      return
    }
    // j/k 或上下箭头导航
    if (input === 'j' || key.downArrow) {
      setSelectedIndex((prev) => Math.min(prev + 1, agentTasks.length - 1))
      return
    }
    if (input === 'k' || key.upArrow) {
      setSelectedIndex((prev) => Math.max(prev - 1, 0))
      return
    }
    // Enter 进入 Peek 模式
    if (key.return && agentTasks.length > 0) {
      const selected = agentTasks[selectedIndex]
      if (selected) {
        enterTeammateView(selected.id, setAppState)
        onExit()
      }
    }
  })

  // 无 agent task 时的提示
  if (agentTasks.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{tSync('agentView.title')}</Text>
        <Text dimColor>{tSync('agentView.noSessions')}</Text>
        <Text dimColor>{tSync('agentView.exitHint')}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>{tSync('agentView.title')}</Text>
      <Text dimColor>{tSync('agentView.navigationHint')}</Text>
      <Box flexDirection="column" marginTop={1}>
        {agentTasks.map(({ id, task }, index) => {
          const isSelected = index === selectedIndex
          const icon = getStatusIcon(task)
          const name = getAgentDisplayName(task)
          const statusLabel = getStatusLabel(task)
          const progress = getProgressSummary(task)

          // 阻塞 peek：进度行已含「问题 · waiting 3m」，不再重复 [status] 标签
          const isBlockedPeek =
            isInProcessTeammateTask(task) &&
            (task.awaitingPlanApproval || (task.isIdle && task.status === 'running'))

          return (
            <Box key={id} flexDirection="row" gap={1}>
              <Text>{isSelected ? SMALL_RIGHT_TRIANGLE : ' '}</Text>
              <Text>{icon}</Text>
              <Text bold={isSelected}>{name}</Text>
              {!isBlockedPeek ? <Text dimColor>[{statusLabel}]</Text> : null}
              {progress ? (
                <Text dimColor={!isBlockedPeek} color={isBlockedPeek ? 'warning' : undefined}>
                  {progress}
                </Text>
              ) : null}
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{tSync('agentView.exitHint')}</Text>
      </Box>
    </Box>
  )
}
