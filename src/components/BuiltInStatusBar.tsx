import { basename } from 'path'
import * as React from 'react'
import { memo, useEffect, useRef, useState } from 'react'
import {
  EFFORT_HIGH,
  EFFORT_LOW,
  EFFORT_MAX,
  EFFORT_MEDIUM,
  FORK_GLYPH,
} from '../constants/figures.js'
import { getTotalCost, getTotalInputTokens, getTotalOutputTokens } from '../cost-tracker.js'
import { tSync } from '../i18n/index.js'
import { useSettings } from '../hooks/useSettings.js'
import { Box, Text } from '../ink.js'
import { useAppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import { getVisibleAgentTasks } from '../components/CoordinatorAgentStatus.js'
import { calculateContextPercentages, getContextWindowForModel } from '../utils/context.js'
import { getCwd } from '../utils/cwd.js'
import { getDisplayedEffortLevel } from '../utils/effort.js'
import { formatTokens } from '../utils/format.js'
import { getBranch, getIsClean } from '../utils/git.js'
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
  messages: Message[]
  isLoading: boolean
  mainLoopModel: ModelName
}

/** 加载期间刷新间隔（ms），确保 token/费用实时更新 */
const LOADING_REFRESH_MS = 500

function BuiltInStatusBarInner({ messages, isLoading, mainLoopModel }: Props): React.ReactNode {
  const settings = useSettings()
  const effortValue = useAppState((s) => s.effortValue)
  const tasks = useAppState((s) => s.tasks)
  const [branch, setBranch] = useState<string | null>(null)
  const [gitClean, setGitClean] = useState<boolean | null>(null)
  const [memoryRss, setMemoryRss] = useState<number>(0)
  const [tick, setTick] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  // 是否启用（默认启用）
  const enabled = settings?.builtInStatusBar?.enabled !== false
  if (!enabled) return null

  // 异步获取 git 分支名和仓库状态
  useEffect(() => {
    let cancelled = false
    Promise.all([getBranch().catch(() => null), getIsClean().catch(() => null)]).then(
      ([b, clean]) => {
        if (!cancelled) {
          setBranch(b)
          setGitClean(clean)
        }
      },
    )
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

  // 加载期间定时刷新，确保 token/费用读数实时更新
  useEffect(() => {
    if (!isLoading) return
    const id = setInterval(() => setTick((n) => n + 1), LOADING_REFRESH_MS)
    return () => clearInterval(id)
  }, [isLoading])

  type SegmentColor =
    | 'ansi:yellow'
    | 'ansi:blue'
    | 'ansi:cyan'
    | 'ansi:magenta'
    | 'ansi:green'
    | 'ansi:red'
    | 'inactive'
  const segments: Array<{ text: string; color: SegmentColor }> = []

  // 强制引用 tick 以避免 unused variable 警告
  void tick

  const thinkingEnabled = useAppState((s) => s.thinkingEnabled)

  // 1. 目录 · Git 分支 → blue
  {
    let dirStr = `📂 ${basename(getCwd())}`
    if (branch) {
      dirStr += ` · ${FORK_GLYPH} ${branch}`
      if (gitClean === true) {
        dirStr += ' ✓'
      } else if (gitClean === false) {
        dirStr += ' ●'
      }
    }
    segments.push({ text: dirStr, color: 'ansi:blue' })
  }

  // 2. 模型名 · Effort → cyan（核心智能）
  {
    const level = getDisplayedEffortLevel(mainLoopModel, effortValue)
    const i18nKey = EFFORT_I18N_KEYS[level] ?? 'effort.medium'
    const levelName = tSync(i18nKey)
    if (thinkingEnabled) {
      segments.push({ text: `${mainLoopModel} · ↻ ${levelName}`, color: 'ansi:cyan' })
    } else {
      const icon = EFFORT_ICONS[level] ?? EFFORT_MEDIUM
      segments.push({ text: `${mainLoopModel} · ${icon} ${levelName}`, color: 'ansi:cyan' })
    }
  }

  // 3. 上下文使用量 → 动态变色（<50%绿 / 50-75%黄 / ≥75%红）
  {
    const currentUsage = getCurrentUsage(messages)
    const contextWindowSize = getContextWindowForModel(mainLoopModel)
    if (currentUsage) {
      const percentages = calculateContextPercentages(currentUsage, contextWindowSize)
      const usedTokens =
        currentUsage.inputTokens +
        currentUsage.cacheCreationInputTokens +
        currentUsage.cacheReadInputTokens
      const bar = renderContextBar(percentages.used)
      const contextColor: SegmentColor =
        percentages.used >= 75 ? 'ansi:red' : percentages.used >= 50 ? 'ansi:yellow' : 'ansi:green'
      segments.push({
        text: `⛁ ${formatTokens(usedTokens)}/${formatTokens(contextWindowSize)} ${bar}`,
        color: contextColor,
      })
    } else {
      segments.push({ text: `⛁ ${formatTokens(contextWindowSize)}`, color: 'ansi:green' })
    }
  }

  // 4. Token 使用量 → blue（数据流）
  {
    const totalIn = getTotalInputTokens()
    const totalOut = getTotalOutputTokens()
    if (totalIn > 0 || totalOut > 0) {
      segments.push({
        text: `↑ ${formatTokens(totalIn)}  ↓ ${formatTokens(totalOut)}`,
        color: 'ansi:blue',
      })
    }
  }

  // 5. 预估费用 → magenta（费用/金钱）
  {
    const cost = getTotalCost()
    if (cost > 0) {
      segments.push({ text: `💰 ￥${cost.toFixed(2)}`, color: 'ansi:yellow' })
    }
  }

  // 6. 活跃子智能体 → green
  {
    const visibleTasks = getVisibleAgentTasks(tasks)
    const runningTasks = visibleTasks.filter((t) => t.status === 'running')
    const completedTasks = visibleTasks.filter((t) => t.status === 'completed')
    const failedTasks = visibleTasks.filter((t) => t.status === 'failed')

    if (runningTasks.length > 0 || completedTasks.length > 0) {
      let taskInfo = `🛰 ${runningTasks.length}`
      if (completedTasks.length > 0) taskInfo += ` ✓${completedTasks.length}`
      if (failedTasks.length > 0) taskInfo += ` ✗${failedTasks.length}`
      segments.push({ text: taskInfo, color: 'ansi:green' })
    }
  }

  // 7. 内存占用 → inactive（次要不突出）
  if (memoryRss > 0) {
    segments.push({ text: `💾 ${formatMemory(memoryRss)}`, color: 'inactive' })
  }

  return (
    <Box gap={2}>
      <Text wrap="truncate">
        {segments.map((seg, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Text dimColor> │ </Text>}
            <Text color={seg.color}>{seg.text}</Text>
          </React.Fragment>
        ))}
      </Text>
    </Box>
  )
}

export const BuiltInStatusBar = memo(BuiltInStatusBarInner)
