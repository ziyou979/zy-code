/**
 * TaskStatusLine — 动态第二行状态栏
 *
 * 当有 Todo 任务或活跃子 Agent 时，在 BuiltInStatusBar 下方自动展开一行，
 * 显示任务摘要和 Agent 详情；空闲时折叠。根据终端宽度自适应展示粒度。
 */

import * as React from 'react'
import { memo, useEffect, useState } from 'react'
import { useTasksV2 } from '../hooks/useTasksV2.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '../ink.js'
import { useAppState } from '../state/AppState.js'
import {
  isPanelAgentTask,
  type LocalAgentTaskState,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { isBackgroundTask, type TaskState } from '../tasks/types.js'
import { isInternalBuild } from '../utils/envUtils.js'
import { formatDuration, truncateToWidth } from '../utils/format.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import type { Task } from '../utils/tasks.js'
import { isTerminalStatus } from './tasks/taskStatusUtils.js'

/** 宽屏阈值：显示内联任务标题 + Agent 活动描述 */
const WIDE_WIDTH = 110
/** 中屏阈值：仅显示计数 */
const MEDIUM_WIDTH = 80
/** 最大内联任务条目数 */
const MAX_INLINE_TASKS = 3
/** 最大内联 Agent 条目数 */
const MAX_INLINE_AGENTS = 2
/** 任务标题截断宽度 */
const TASK_SUBJECT_MAX = 28
/** Agent 活动描述截断宽度 */
const AGENT_ACTIVITY_MAX = 30
/** 运行中 Agent 的时间刷新间隔（秒） */
const AGENT_TICK_S = 10

/**
 * 获取任务状态对应的图标
 */
function taskStatusIcon(status: Task['status']): string {
  switch (status) {
    case 'completed':
      return '✓'
    case 'in_progress':
      return '▶'
    case 'pending':
      return '☐'
  }
}

/**
 * 判断某个任务是否为活跃的 Agent（非终止状态的 local_agent 或 in_process_teammate）
 */
function isActiveAgentTask(t: TaskState): boolean {
  if (!isBackgroundTask(t)) {
    return false
  }
  if (isInternalBuild() && isPanelAgentTask(t)) {
    return false
  }
  if (isTerminalStatus(t.status)) {
    return false
  }
  return t.type === 'local_agent' || t.type === 'in_process_teammate'
}

/**
 * 构建任务列表的展示文本
 */
function buildTaskParts(tasksV2: Task[], columns: number): string[] {
  const parts: string[] = []
  const pending = tasksV2.filter((t) => t.status === 'pending')
  const inProgress = tasksV2.filter((t) => t.status === 'in_progress')
  const completed = tasksV2.filter((t) => t.status === 'completed')
  const total = tasksV2.length

  if (columns >= WIDE_WIDTH) {
    // 宽屏：显示内联任务条目（优先 in_progress，其次 pending）
    const prioritized = [...inProgress, ...pending].slice(0, MAX_INLINE_TASKS)
    if (prioritized.length > 0) {
      const items = prioritized.map(
        (t) =>
          `#${t.id} ${truncateToWidth(t.subject, TASK_SUBJECT_MAX)} ${taskStatusIcon(t.status)}`,
      )
      parts.push(`📋 ${items.join(' · ')}`)
    }
    // 如果有更多未显示的任务，追加 "+N"
    const remaining = total - prioritized.length
    if (remaining > 0) {
      parts.push(`+${remaining}`)
    }
  } else {
    // 中屏：仅显示状态计数摘要
    const statusParts: string[] = []
    if (inProgress.length > 0) {
      statusParts.push(`${inProgress.length}▶`)
    }
    if (pending.length > 0) {
      statusParts.push(`${pending.length}☐`)
    }
    if (completed.length > 0) {
      statusParts.push(`${completed.length}✓`)
    }
    const summary = statusParts.length > 0 ? statusParts.join(' ') : '0'
    parts.push(`📋 ${summary} /${total}`)
  }

  return parts
}

/**
 * 构建 Agent 列表的展示文本
 */
function buildAgentParts(agents: TaskState[], columns: number): string[] {
  const parts: string[] = []

  for (const agent of agents.slice(0, MAX_INLINE_AGENTS)) {
    if (agent.type === 'in_process_teammate') {
      // Swarm teammate
      // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
      const teammate = agent as any
      const name = teammate.identity?.agentName ?? 'agent'
      const isIdle = teammate.isIdle === true
      const status = isIdle ? 'idle' : 'working'
      const icon = isIdle ? '⏸' : '▶'
      const color = teammate.identity?.color
      // 标色名称（宽屏时使用）
      const namePart = color ? `@${name}` : `@${name}`
      parts.push(`🤖 ${namePart} ${icon} ${status}`)
    } else {
      // local_agent
      const la = agent as LocalAgentTaskState
      const name = la.agentType || 'agent'
      const elapsedMs = Math.max(0, Date.now() - la.startTime - (la.totalPausedMs ?? 0))
      const elapsed = formatDuration(elapsedMs)
      const activity = la.progress?.lastActivity?.activityDescription ?? ''

      let agentStr = `🤖 ${name} ▶ ${elapsed}`
      if (activity && columns >= WIDE_WIDTH) {
        agentStr += ` ${truncateToWidth(activity, AGENT_ACTIVITY_MAX)}`
      }
      parts.push(agentStr)
    }
  }

  // 如果有更多 Agent，追加 "+N"
  if (agents.length > MAX_INLINE_AGENTS) {
    parts.push(`+${agents.length - MAX_INLINE_AGENTS}`)
  }

  return parts
}

function TaskStatusLineInner(): React.ReactNode {
  const tasksV2 = useTasksV2()
  const appStateTasks = useAppState((s) => s.tasks)
  const { columns } = useTerminalSize()
  const isFullscreen = isFullscreenEnvEnabled()

  // 定时刷新：Agent 运行时长需要更新
  const [tick, setTick] = useState(0)
  const hasActiveAgents = Object.values(appStateTasks ?? {}).some(isActiveAgentTask)
  useEffect(() => {
    if (!hasActiveAgents) {
      return
    }
    const id = setInterval(() => setTick((n) => n + 1), AGENT_TICK_S * 1000)
    return () => clearInterval(id)
  }, [hasActiveAgents])

  // 收集活跃子 Agent
  const activeAgents = Object.values(appStateTasks ?? {}).filter(isActiveAgentTask)

  const hasTasksV2 = tasksV2 !== undefined && tasksV2.length > 0
  const hasAgents = activeAgents.length > 0

  // 无事可显示 → 全屏模式保留占位行以稳定高度
  if (!hasTasksV2 && !hasAgents) {
    return isFullscreen ? <Text> </Text> : null
  }

  // 窄屏：仅全屏保留占位行
  if (columns < MEDIUM_WIDTH) {
    return isFullscreen ? <Text> </Text> : null
  }

  // 强制引用 tick 以避免 unused variable 警告
  void tick

  const parts: string[] = []

  // ── Todo 部分 ──
  if (hasTasksV2) {
    parts.push(...buildTaskParts(tasksV2!, columns))
  }

  // ── Agent 部分 ──
  if (hasAgents) {
    parts.push(...buildAgentParts(activeAgents, columns))
  }

  if (parts.length === 0) {
    return isFullscreen ? <Text> </Text> : null
  }

  return (
    <Box height={1} overflow="hidden">
      <Text dimColor wrap="truncate">
        {parts.join(' · ')}
      </Text>
    </Box>
  )
}

export const TaskStatusLine = memo(TaskStatusLineInner)
