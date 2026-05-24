import { basename } from 'node:path'
import * as React from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getVisibleAgentTasks } from '../components/CoordinatorAgentStatus.js'
import {
  EFFORT_HIGH,
  EFFORT_LOW,
  EFFORT_MAX,
  EFFORT_MEDIUM,
  FORK_GLYPH,
} from '../constants/figures.js'
import { getTotalCost, getTotalInputTokens, getTotalOutputTokens } from '../cost-tracker.js'
import { useSettings } from '../hooks/useSettings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { tSync } from '../i18n/index.js'
import { stringWidth } from '../ink/stringWidth.js'
import { Box, Text } from '../ink.js'
import { useAppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import { getGlobalConfig } from '../utils/config.js'
import { calculateContextPercentages, getContextWindowForModel } from '../utils/context.js'
import { getCwd } from '../utils/cwd.js'
import { getDisplayedEffortLevel } from '../utils/effort.js'
import { formatTokens } from '../utils/format.js'
import { getBranch, getIsClean } from '../utils/git.js'
import { type ModelName } from '../services/model/model.js'
import { resolveThemeSetting } from '../utils/systemTheme.js'
import { getTheme } from '../utils/theme.js'
import { getCurrentUsage } from '../utils/tokens.js'

/** 进度条宽度（字符数） */
const BAR_WIDTH = 8

/** 模块优先级（数字越小越重要，超宽时优先隐藏高序号模块） */
const MODULE_PRIORITY: Record<string, number> = {
  directory: 0,
  model: 1,
  context: 2,
  tokens: 3,
  cost: 4,
  agents: 5,
  memory: 6,
}

/** 分隔符宽度 */
const SEPARATOR_WIDTH = 3 // ' │ '

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
  if (percentage === null) {
    return ''
  }
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
  const { columns } = useTerminalSize()
  const [branch, setBranch] = useState<string | null>(null)
  const [gitClean, setGitClean] = useState<boolean | null>(null)
  const [memoryRss, setMemoryRss] = useState<number>(0)
  const [tick, setTick] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  // 是否启用（默认启用）
  const enabled = settings?.builtInStatusBar?.enabled !== false
  // 模块可见性（默认全部显示）
  const modules = settings?.builtInStatusBar?.modules
  const showModule = useCallback(
    (name: keyof NonNullable<typeof modules>) => modules === undefined || modules[name] !== false,
    [modules],
  )
  if (!enabled) {
    return null
  }

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
    if (!isLoading) {
      return
    }
    const id = setInterval(() => setTick((n) => n + 1), LOADING_REFRESH_MS)
    return () => clearInterval(id)
  }, [isLoading])

  const theme = getTheme(resolveThemeSetting(getGlobalConfig().theme))
  type Segment = { text: string; color: string; priority: number }
  const segments: Segment[] = []

  // 强制引用 tick 以避免 unused variable 警告
  void tick

  const thinkingEnabled = useAppState((s) => s.thinkingEnabled)

  // 1. 目录 · Git 分支 → blue（最高优先级）
  if (showModule('directory')) {
    let dirStr = `📂 ${basename(getCwd())}`
    if (branch) {
      dirStr += ` · ${FORK_GLYPH} ${branch}`
      if (gitClean === true) {
        dirStr += ' ✓'
      } else if (gitClean === false) {
        dirStr += ' ●'
      }
    }
    segments.push({
      text: dirStr,
      color: theme.rainbow_blue_shimmer,
      priority: MODULE_PRIORITY.directory,
    })
  }

  // 2. 模型名 · Effort → cyan（核心智能）
  if (showModule('model')) {
    const level = getDisplayedEffortLevel(mainLoopModel, effortValue)
    const i18nKey = EFFORT_I18N_KEYS[level] ?? 'effort.medium'
    const levelName = tSync(i18nKey)
    const effortColors: Record<string, string> = {
      low: theme.rainbow_indigo_shimmer,
      medium: theme.rainbow_violet_shimmer,
      high: theme.rainbow_orange_shimmer,
      max: theme.rainbow_red_shimmer,
    }
    if (thinkingEnabled) {
      const modelColor = effortColors[level] ?? theme.rainbow_violet_shimmer
      const icon = EFFORT_ICONS[level] ?? EFFORT_MEDIUM
      segments.push({
        text: `${mainLoopModel} · ${icon} ${levelName}`,
        color: modelColor,
        priority: MODULE_PRIORITY.model,
      })
    } else {
      segments.push({
        text: `${mainLoopModel}`,
        color: theme.rainbow_violet_shimmer,
        priority: MODULE_PRIORITY.model,
      })
    }
  }

  // 3. 上下文使用量 → 动态变色（<50%绿 / 50-75%黄 / ≥75%红）
  if (showModule('context')) {
    const currentUsage = getCurrentUsage(messages)
    const contextWindowSize = getContextWindowForModel(mainLoopModel)
    if (currentUsage) {
      const percentages = calculateContextPercentages(currentUsage, contextWindowSize)
      const usedTokens =
        currentUsage.inputTokens +
        currentUsage.cacheCreationInputTokens +
        currentUsage.cacheReadInputTokens
      const bar = renderContextBar(percentages.used)
      const contextColor =
        percentages.used >= 75
          ? theme.error
          : percentages.used >= 50
            ? theme.warning
            : theme.success
      segments.push({
        text: `⛁ ${formatTokens(usedTokens)}/${formatTokens(contextWindowSize)} ${bar}`,
        color: contextColor,
        priority: MODULE_PRIORITY.context,
      })
    } else {
      segments.push({
        text: `⛁ ${formatTokens(contextWindowSize)}`,
        color: theme.success,
        priority: MODULE_PRIORITY.context,
      })
    }
  }

  // 4. Token 使用量 → blue（数据流）
  if (showModule('tokens')) {
    const totalIn = getTotalInputTokens()
    const totalOut = getTotalOutputTokens()
    if (totalIn > 0 || totalOut > 0) {
      segments.push({
        text: `↑ ${formatTokens(totalIn)}  ↓ ${formatTokens(totalOut)}`,
        color: theme.suggestion,
        priority: MODULE_PRIORITY.tokens,
      })
    }
  }

  // 5. 预估费用 → yellow（费用/金钱）
  if (showModule('cost')) {
    const cost = getTotalCost()
    if (cost > 0) {
      segments.push({
        text: `💰 ￥${cost.toFixed(2)}`,
        color: theme.warning,
        priority: MODULE_PRIORITY.cost,
      })
    }
  }

  // 6. 活跃子智能体 → green
  if (showModule('agents')) {
    const visibleTasks = getVisibleAgentTasks(tasks)
    const runningTasks = visibleTasks.filter((t) => t.status === 'running')
    const completedTasks = visibleTasks.filter((t) => t.status === 'completed')
    const failedTasks = visibleTasks.filter((t) => t.status === 'failed')

    if (runningTasks.length > 0 || completedTasks.length > 0) {
      let taskInfo = `🛰 ${runningTasks.length}`
      if (completedTasks.length > 0) {
        taskInfo += ` ✓${completedTasks.length}`
      }
      if (failedTasks.length > 0) {
        taskInfo += ` ✗${failedTasks.length}`
      }
      segments.push({ text: taskInfo, color: theme.permission, priority: MODULE_PRIORITY.agents })
    }
  }

  // 7. 内存占用 → inactive（次要不突出）
  if (showModule('memory')) {
    if (memoryRss > 0) {
      segments.push({
        text: `💾 ${formatMemory(memoryRss)}`,
        color: theme.inactive,
        priority: MODULE_PRIORITY.memory,
      })
    }
  }

  // 自适应宽度：超宽时按优先级从低到高隐藏模块
  const visibleSegments = useMemo(() => {
    // 按优先级排序（数字小=优先级高，排前面）
    const sorted = [...segments].sort((a, b) => a.priority - b.priority)
    // 计算全部显示时的总宽度
    const totalWidth =
      sorted.reduce((sum, s) => sum + stringWidth(s.text), 0) +
      Math.max(0, sorted.length - 1) * SEPARATOR_WIDTH
    if (totalWidth <= columns - 2) {
      // 终端够宽，全部显示
      return sorted
    }
    // 超宽，从低优先级开始逐个移除
    const available = columns - 2
    for (let i = sorted.length - 1; i > 0; i--) {
      const withoutWidth =
        sorted.slice(0, i).reduce((sum, s) => sum + stringWidth(s.text), 0) +
        Math.max(0, i - 1) * SEPARATOR_WIDTH
      if (withoutWidth <= available) {
        return sorted.slice(0, i)
      }
    }
    // 只剩最高优先级段，保留
    return [sorted[0]!]
  }, [segments, columns])

  return (
    <Box gap={2}>
      <Text wrap="truncate">
        {visibleSegments.map((seg, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Text dimColor> │ </Text>}
            <Text color={seg.color as import('../ink/styles.js').Color}>{seg.text}</Text>
          </React.Fragment>
        ))}
      </Text>
    </Box>
  )
}

export const BuiltInStatusBar = memo(BuiltInStatusBarInner)
