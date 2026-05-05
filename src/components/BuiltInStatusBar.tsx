import * as React from 'react'
import { memo, useEffect, useRef, useState } from 'react'
import { EFFORT_HIGH, EFFORT_LOW, EFFORT_MAX, EFFORT_MEDIUM } from '../constants/figures.js'
import { getTotalCost, getTotalInputTokens, getTotalOutputTokens } from '../cost-tracker.js'
import { tSync } from '../i18n/index.js'
import { useSettings } from '../hooks/useSettings.js'
import { Box, Text } from '../ink.js'
import { useAppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import { getVisibleAgentTasks } from '../components/CoordinatorAgentStatus.js'
import { calculateContextPercentages, getContextWindowForModel } from '../utils/context.js'
import { getDisplayedEffortLevel } from '../utils/effort.js'
import { formatTokens } from '../utils/format.js'
import { getBranch } from '../utils/git.js'
import { type ModelName } from '../utils/model/model.js'
import { getCurrentUsage } from '../utils/tokens.js'

/** 进度条宽度（字符数） */
const BAR_WIDTH = 8

/** Effort 级别对应的图标映射 */
const EFFORT_ICONS: Record<string, string> = {
  low: EFFORT_LOW,
  medium: EFFORT_MEDIUM,
  high: EFFORT_HIGH,
  max: EFFORT_MAX,
}

/** Effort 级别对应的 i18n key */
const EFFORT_I18N_KEYS: Record<string, string> = {
  low: 'effort.low',
  medium: 'effort.medium',
  high: 'effort.high',
  max: 'effort.max',
}

/**
 * 生成上下文使用量进度条
 * @param percentage 0-100 的百分比
 * @returns 如 "[████░░░░] 17%"
 */
function renderContextBar(percentage: number | null): string {
  if (percentage === null) return ''
  const clamped = Math.min(100, Math.max(0, percentage))
  const filled = Math.round((clamped / 100) * BAR_WIDTH)
  const empty = BAR_WIDTH - filled
  const bar = '█'.repeat(filled) + '░'.repeat(empty)
  return `${bar} ${clamped}%`
}

/**
 * 格式化内存大小为可读字符串（MB/GB）
 */
function formatMemory(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
  }
  return `${Math.round(bytes / (1024 * 1024))}MB`
}

type Props = {
  messagesRef: React.RefObject<Message[]>
  mainLoopModel: ModelName
}

function BuiltInStatusBarInner({ messagesRef, mainLoopModel }: Props): React.ReactNode {
  const settings = useSettings()
  const effortValue = useAppState((s) => s.effortValue)
  const tasks = useAppState((s) => s.tasks)
  const [branch, setBranch] = useState<string | null>(null)
  const [memoryRss, setMemoryRss] = useState<number>(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  // 是否启用（默认启用）
  const enabled = settings?.builtInStatusBar?.enabled !== false
  if (!enabled) return null

  // 异步获取 git 分支名
  useEffect(() => {
    let cancelled = false
    getBranch()
      .then((b) => {
        if (!cancelled) setBranch(b)
      })
      .catch(() => {
        if (!cancelled) setBranch(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 定时采样内存占用
  useEffect(() => {
    setMemoryRss(process.memoryUsage().rss)
    intervalRef.current = setInterval(() => {
      setMemoryRss(process.memoryUsage().rss)
    }, 5000)
    return () => {
      if (intervalRef.current !== undefined) {
        clearInterval(intervalRef.current)
      }
    }
  }, [])

  const parts: string[] = []

  // 1. Effort 级别
  {
    const level = getDisplayedEffortLevel(mainLoopModel, effortValue)
    const icon = EFFORT_ICONS[level] ?? EFFORT_MEDIUM
    const i18nKey = EFFORT_I18N_KEYS[level] ?? 'effort.medium'
    const levelName = tSync(i18nKey)
    parts.push(`${icon} ${levelName}`)
  }

  // 2. 上下文使用量（进度条）
  {
    const msgs = messagesRef.current
    const currentUsage = getCurrentUsage(msgs)
    const contextWindowSize = getContextWindowForModel(mainLoopModel)
    if (currentUsage) {
      const percentages = calculateContextPercentages(currentUsage, contextWindowSize)
      const usedTokens =
        currentUsage.inputTokens +
        currentUsage.cacheCreationInputTokens +
        currentUsage.cacheReadInputTokens
      const bar = renderContextBar(percentages.used)
      parts.push(`📊 ${formatTokens(usedTokens)}/${formatTokens(contextWindowSize)} ${bar}`)
    } else {
      parts.push(`📊 ${formatTokens(contextWindowSize)}`)
    }
  }

  // 3. 模型名
  parts.push(mainLoopModel)

  // 4. Token 使用量
  {
    const totalIn = getTotalInputTokens()
    const totalOut = getTotalOutputTokens()
    if (totalIn > 0 || totalOut > 0) {
      parts.push(`🔤 ↑${formatTokens(totalIn)} ↓${formatTokens(totalOut)}`)
    }
  }

  // 5. 预估费用
  {
    const cost = getTotalCost()
    if (cost > 0) {
      parts.push(`💰 ￥${cost.toFixed(2)}`)
    }
  }

  // 6. 活跃子智能体
  {
    const visibleTasks = getVisibleAgentTasks(tasks)
    const runningTasks = visibleTasks.filter((t) => t.status === 'running')
    const completedTasks = visibleTasks.filter((t) => t.status === 'completed')
    const failedTasks = visibleTasks.filter((t) => t.status === 'failed')

    if (runningTasks.length > 0 || completedTasks.length > 0) {
      let taskInfo = `🤖${runningTasks.length}`
      if (completedTasks.length > 0) taskInfo += ` ✓${completedTasks.length}`
      if (failedTasks.length > 0) taskInfo += ` ✗${failedTasks.length}`
      parts.push(taskInfo)
    }
  }

  // 7. 内存占用
  if (memoryRss > 0) {
    parts.push(`💾 ${formatMemory(memoryRss)}`)
  }

  // 8. Git 分支
  if (branch) {
    parts.push(branch)
  }

  return (
    <Box gap={2}>
      <Text dimColor wrap="truncate">
        {parts.join(' · ')}
      </Text>
    </Box>
  )
}

export const BuiltInStatusBar = memo(BuiltInStatusBarInner)
