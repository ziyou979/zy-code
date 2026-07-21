import * as React from 'react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useSettings } from '../hooks/useSettings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { stringWidth } from '../ink/stringWidth.js'
import { Box, Text } from '../ink/index.js'
import { type ModelName } from '../services/model/model.js'
import { useAppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import { getGlobalConfig } from '../services/config/config.js'
import { getBranch, getIsClean } from '../services/infra/git.js'
import { resolveThemeSetting } from '../services/environment/systemTheme.js'
import { getTheme, type Theme } from '../services/environment/theme.js'
import { renderStatusbarSegments, type StatusbarContext } from './statusbar/renderSegments.js'
import { mergeWithDefaults } from './statusbar/statusbarModuleDefaults.js'

/** 分隔符宽度 */
const SEPARATOR_WIDTH = 3 // ' │ '

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
  const thinkingEnabled = useAppState((s) => s.thinkingEnabled)
  const { columns } = useTerminalSize()
  const [branch, setBranch] = useState<string | null>(null)
  const [gitClean, setGitClean] = useState<boolean | null>(null)
  const [memoryRss, setMemoryRss] = useState<number>(0)
  const [tick, setTick] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const enabled = settings?.builtInStatusBar?.enabled !== false

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

  // 强制引用 tick 以避免 unused variable 警告（其值仅用于触发重渲染）
  void tick

  const modules = useMemo(
    () => mergeWithDefaults(settings?.builtInStatusBar?.modules),
    [settings?.builtInStatusBar?.modules],
  )

  const theme = getTheme(resolveThemeSetting(getGlobalConfig().theme))

  const segments = useMemo(() => {
    const ctx: StatusbarContext = {
      messages,
      mainLoopModel,
      effortValue,
      thinkingEnabled: thinkingEnabled ?? false,
      branch,
      gitClean,
      memoryRss,
    }
    return renderStatusbarSegments(modules, ctx)
  }, [modules, messages, mainLoopModel, effortValue, thinkingEnabled, branch, gitClean, memoryRss])

  // 自适应宽度：用户排序优先，超宽时从末尾开始丢弃
  const visibleSegments = useMemo(() => {
    if (segments.length === 0) {
      return segments
    }
    const available = columns - 2
    let cut = segments.length
    while (cut > 1) {
      const w =
        segments.slice(0, cut).reduce((sum, s) => sum + stringWidth(s.text), 0) +
        Math.max(0, cut - 1) * SEPARATOR_WIDTH
      if (w <= available) {
        break
      }
      cut -= 1
    }
    return segments.slice(0, cut)
  }, [segments, columns])

  if (!enabled) {
    return null
  }

  return (
    <Box gap={2}>
      <Text wrap="truncate">
        {visibleSegments.map((seg, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Text dimColor> │ </Text>}
            <Text color={resolveColor(theme, seg.colorToken) as import('../ink/styles.js').Color}>
              {seg.text}
            </Text>
          </React.Fragment>
        ))}
      </Text>
    </Box>
  )
}

/**
 * Resolve a theme token name (e.g. "success", "rainbow_blue_shimmer") to its
 * actual color string. Falls back to the token itself if the name isn't in
 * the theme — Ink accepts named colors like 'blue' as a last resort.
 */
function resolveColor(theme: Theme, token: string): string {
  const value = (theme as unknown as Record<string, string>)[token]
  return value ?? token
}

export const BuiltInStatusBar = memo(BuiltInStatusBarInner)
