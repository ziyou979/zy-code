import { feature } from 'bun:bundle'
// @ts-expect-error -- no declaration file for asciichart
import { plot as asciichart } from 'asciichart'
import chalk from 'chalk'
import React, { Suspense, use, useEffect, useMemo, useRef, useState } from 'react'
import stripAnsi from 'strip-ansi'
import type { CommandResultDisplay } from '../commands.js'
import { ARROW_DOWN, ARROW_UP, BULLET, CIRCLE, STAR } from '../constants/figures.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { getUiLanguage, tSync } from '../i18n/index.js'
import { applyColor } from '../ink/colorize.js'
import ScrollBox, { type ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { stringWidth as getStringWidth } from '../ink/stringWidth.js'
import type { Color } from '../ink/styles.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw j/k/arrow stats navigation
import { Ansi, Box, Text, useInput } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { renderModelName } from '../services/model/model.js'
import { getGlobalConfig } from '../utils/config.js'
import { isInternalBuild } from '../utils/envUtils.js'
import { formatDuration, formatNumber } from '../utils/format.js'
import { generateHeatmap, generateHeatmapData, type HeatmapCell } from '../utils/heatmap.js'
import { copyAnsiToClipboard } from '../utils/screenshotClipboard.js'
import {
  aggregateZyCodeStatsForRange,
  type DailyModelTokens,
  type StatsDateRange,
  type ZyCodeStats,
} from '../utils/stats.js'
import { resolveThemeSetting } from '../utils/systemTheme.js'
import { getTheme, themeColorToAnsi } from '../utils/theme.js'
import { Pane } from './design-system/Pane.js'
import { Tab, Tabs, useTabHeaderFocus } from './design-system/Tabs.js'
import { Spinner } from './Spinner.js'

type InnerTabProps = {
  isActive: boolean
  onUp: () => void
}

function getLocale(): string {
  return getUiLanguage() === 'zh-CN' ? 'zh-CN' : 'en-US'
}
function formatPeakDay(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString(getLocale(), {
    month: 'short',
    day: 'numeric',
  })
}
function HeatmapCellText({ cell }: { cell: HeatmapCell }) {
  if (cell.intensity === 0) {
    return <Text dimColor>{cell.char}</Text>
  }
  return <Text color="zy">{cell.char}</Text>
}

type Props = {
  onClose: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
}
export type StatsResult =
  | {
      type: 'success'
      data: ZyCodeStats
    }
  | {
      type: 'error'
      message: string
    }
  | {
      type: 'empty'
    }
// getter：惰性求值，避免模块顶层冻结翻译；语言切换后即时反应。
const getDateRangeLabels = (): Record<StatsDateRange, string> => ({
  '7d': tSync('stats.last7Days'),
  '30d': tSync('stats.last30Days'),
  all: tSync('stats.allTime'),
})
const DATE_RANGE_ORDER: StatsDateRange[] = ['all', '7d', '30d']
function getNextDateRange(current: StatsDateRange): StatsDateRange {
  const currentIndex = DATE_RANGE_ORDER.indexOf(current)
  return DATE_RANGE_ORDER[(currentIndex + 1) % DATE_RANGE_ORDER.length]!
}

/**
 * Creates a stats loading promise that never rejects.
 * Always loads all-time stats for the heatmap.
 */
export function createAllTimeStatsPromise(): Promise<StatsResult> {
  return aggregateZyCodeStatsForRange('all')
    .then((data): StatsResult => {
      if (!data || data.totalSessions === 0) {
        return {
          type: 'empty',
        }
      }
      return {
        type: 'success',
        data,
      }
    })
    .catch((err): StatsResult => {
      const message =
        err instanceof Error ? err.message : tSync('stats.loadError', { message: 'Unknown error' })
      return {
        type: 'error',
        message,
      }
    })
}
export function Stats({ onClose }: Props) {
  const allTimePromise = createAllTimeStatsPromise()
  return (
    <Suspense
      fallback={
        <Box marginTop={1}>
          <Spinner />
          <Text> {tSync('stats.loading')}</Text>
        </Box>
      }
    >
      <StatsContent allTimePromise={allTimePromise} onClose={onClose} />
    </Suspense>
  )
}

// 可嵌入 Settings tab 的 Stats 内容（无 Pane/close 逻辑）
export function StatsInner({
  allTimeStatsPromise,
}: {
  allTimeStatsPromise?: Promise<StatsResult>
}) {
  const [allTimePromise] = useState(() => allTimeStatsPromise ?? createAllTimeStatsPromise())
  return (
    <Suspense
      fallback={
        <Box marginTop={1}>
          <Spinner />
          <Text> {tSync('stats.loading')}</Text>
        </Box>
      }
    >
      <StatsInnerContent allTimePromise={allTimePromise} />
    </Suspense>
  )
}

type StatsContentProps = {
  allTimePromise: Promise<StatsResult>
  onClose: Props['onClose']
}

function StatsContent({ allTimePromise, onClose }: StatsContentProps) {
  const handleClose = () => {
    onClose('Stats dialog dismissed', {
      display: 'system',
    })
  }
  useKeybinding('confirm:no', handleClose, {
    context: 'Confirmation',
  })
  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === 'd')) {
      onClose('Stats dialog dismissed', {
        display: 'system',
      })
    }
  })
  return (
    <Pane color="zy">
      <StatsInnerContent allTimePromise={allTimePromise} />
    </Pane>
  )
}

type StatsInnerContentProps = {
  allTimePromise: Promise<StatsResult>
}

function StatsInnerContent({ allTimePromise }: StatsInnerContentProps) {
  const allTimeResult = use(allTimePromise)
  const [dateRange, setDateRange] = useState<StatsDateRange>('all')
  const [statsCache, setStatsCache] = useState<Record<string, ZyCodeStats | null>>({})
  const [isLoadingFiltered, setIsLoadingFiltered] = useState(false)
  const [activeTab, setActiveTab] = useState('Overview')
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const scrollRef = useRef<ScrollBoxHandle>(null)
  const { headerFocused: outerHeaderFocused, focusHeader: focusOuterHeader } = useTabHeaderFocus()
  useEffect(() => {
    if (dateRange === 'all' || statsCache[dateRange]) {
      return
    }
    let cancelled = false
    setIsLoadingFiltered(true)
    aggregateZyCodeStatsForRange(dateRange)
      .then((data) => {
        if (!cancelled) {
          setStatsCache((prev) => ({ ...prev, [dateRange]: data }))
          setIsLoadingFiltered(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsLoadingFiltered(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [dateRange, statsCache])
  const displayStats =
    dateRange === 'all'
      ? allTimeResult.type === 'success'
        ? allTimeResult.data
        : null
      : (statsCache[dateRange] ?? (allTimeResult.type === 'success' ? allTimeResult.data : null))
  const allTimeStats = allTimeResult.type === 'success' ? allTimeResult.data : null
  useInput(
    (input, key) => {
      if (input === 'r' && !key.ctrl && !key.meta) {
        setDateRange(getNextDateRange(dateRange))
      }
      if (key.ctrl && input === 's' && displayStats) {
        handleScreenshot(displayStats, activeTab as 'Overview' | 'Models', setCopyStatus)
      }
      if (activeTab === 'Overview') {
        if (key.downArrow) {
          scrollRef.current?.scrollBy(2)
        } else if (key.upArrow) {
          const top = scrollRef.current?.getScrollTop() ?? 0
          if (top > 0) {
            scrollRef.current?.scrollBy(-2)
          } else {
            focusOuterHeader()
          }
        }
      }
    },
    { isActive: !outerHeaderFocused },
  )
  if (allTimeResult.type === 'error') {
    return (
      <Box marginTop={1}>
        <Text color="error">{tSync('stats.loadError', { message: allTimeResult.message })}</Text>
      </Box>
    )
  }
  if (allTimeResult.type === 'empty') {
    return (
      <Box marginTop={1}>
        <Text color="warning">{tSync('stats.empty')}</Text>
      </Box>
    )
  }
  if (!displayStats || !allTimeStats) {
    return (
      <Box marginTop={1}>
        <Spinner />
        <Text> {tSync('stats.loadingFiltered')}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* @ts-ignore — Tabs children type */}
      <Tabs
        color="zy"
        selectedTab={activeTab}
        onTabChange={setActiveTab}
        disableNavigation={outerHeaderFocused}
        initialHeaderFocused={true}
      >
        <Tab title={tSync('stats.overview')} id="Overview">
          <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
            <OverviewTab
              stats={displayStats}
              allTimeStats={allTimeStats}
              dateRange={dateRange}
              isLoading={isLoadingFiltered}
              isActive={!outerHeaderFocused}
              onUp={focusOuterHeader}
            />
          </ScrollBox>
        </Tab>
        <Tab title={tSync('stats.models')} id="Models">
          <ModelsTab
            stats={displayStats}
            dateRange={dateRange}
            isLoading={isLoadingFiltered}
            isActive={!outerHeaderFocused}
            onUp={focusOuterHeader}
          />
        </Tab>
      </Tabs>
      <Box marginTop={1}>
        <Text dimColor>
          {outerHeaderFocused ? '↓ stats' : '↑ tabs'}
          {' · '}r {tSync('stats.footer.cycleDates')}
          {' · '}ctrl+s {tSync('stats.footer.copy')}
          {copyStatus ? ` · ${copyStatus}` : ''}
        </Text>
      </Box>
    </Box>
  )
}
// biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
function DateRangeSelector({ dateRange, isLoading }: any) {
  const dateRangeElements = DATE_RANGE_ORDER.map((range, index) => (
    <Text key={range}>
      {index > 0 && <Text dimColor={true}> · </Text>}
      {range === dateRange ? (
        <Text bold={true} color="zy">
          {getDateRangeLabels()[range]}
        </Text>
      ) : (
        <Text dimColor={true}>{getDateRangeLabels()[range]}</Text>
      )}
    </Text>
  ))
  return (
    <Box marginBottom={1} gap={1}>
      {<Box>{dateRangeElements}</Box>}
      {isLoading && <Spinner />}
    </Box>
  )
}
function OverviewTab({
  stats,
  allTimeStats,
  dateRange,
  isLoading,
  isActive,
  onUp,
}: {
  stats: ZyCodeStats
  allTimeStats: ZyCodeStats
  dateRange: StatsDateRange
  isLoading: boolean
} & InnerTabProps): React.ReactNode {
  const { columns: terminalWidth } = useTerminalSize()

  // Calculate favorite model and total tokens
  const modelEntries = Object.entries(stats.modelUsage).sort(
    ([, a], [, b]) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  )
  const favoriteModel = modelEntries[0]
  const totalTokens = modelEntries.reduce(
    (sum, [, usage]) => sum + usage.inputTokens + usage.outputTokens,
    0,
  )

  // Memoize the factoid so it doesn't change when switching tabs
  const factoid = useMemo(() => generateFunFactoid(stats, totalTokens), [stats, totalTokens])

  // Calculate range days based on selected date range
  const rangeDays = dateRange === '7d' ? 7 : dateRange === '30d' ? 30 : stats.totalDays

  // Compute shot stats data (ant-only, gated by feature flag)
  let shotStatsData: {
    avgShots: string
    buckets: {
      label: string
      count: number
      pct: number
    }[]
  } | null = null
  if (feature('SHOT_STATS') && stats.shotDistribution) {
    const dist = stats.shotDistribution
    const total = Object.values(dist).reduce((s, n) => s + n, 0)
    if (total > 0) {
      const totalShots = Object.entries(dist).reduce(
        (s_0, [count, sessions]) => s_0 + parseInt(count, 10) * sessions,
        0,
      )
      const bucket = (min: number, max?: number) =>
        Object.entries(dist)
          .filter(([k]) => {
            const n_0 = parseInt(k, 10)
            return n_0 >= min && (max === undefined || n_0 <= max)
          })
          .reduce((s_1, [, v]) => s_1 + v, 0)
      const pct = (n_1: number) => Math.round((n_1 / total) * 100)
      const b1 = bucket(1, 1)
      const b2_5 = bucket(2, 5)
      const b6_10 = bucket(6, 10)
      const b11 = bucket(11)
      shotStatsData = {
        avgShots: (totalShots / total).toFixed(1),
        buckets: [
          {
            label: '1-shot',
            count: b1,
            pct: pct(b1),
          },
          {
            label: '2\u20135 shot',
            count: b2_5,
            pct: pct(b2_5),
          },
          {
            label: '6\u201310 shot',
            count: b6_10,
            pct: pct(b6_10),
          },
          {
            label: '11+ shot',
            count: b11,
            pct: pct(b11),
          },
        ],
      }
    }
  }
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      {/* Activity Heatmap */}
      {allTimeStats.dailyActivity.length > 0 &&
        (() => {
          const hm = generateHeatmapData(allTimeStats.dailyActivity, { terminalWidth })
          return (
            <Box flexDirection="column" marginBottom={1} flexShrink={0}>
              <Text>{hm.monthLabel}</Text>
              {hm.lines.map((line, i) => (
                <Text key={i}>
                  {line.label}
                  {line.cells.map((cell, j) => (
                    <HeatmapCellText key={j} cell={cell} />
                  ))}
                </Text>
              ))}
              <Text> </Text>
              <Text dimColor>{hm.legendLabel}</Text>
            </Box>
          )
        })()}

      {/* Date range selector */}
      {/* @ts-ignore */}
      <DateRangeSelector dateRange={dateRange} isLoading={isLoading} />

      {/* Section 1: Usage */}
      <Box flexDirection="row" gap={4} marginBottom={1}>
        <Box flexDirection="column" width={28}>
          {favoriteModel && (
            <Text wrap="truncate">
              {tSync('stats.favoriteModel')}:{' '}
              <Text color="zy" bold>
                {renderModelName(favoriteModel[0])}
              </Text>
            </Text>
          )}
        </Box>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            {tSync('stats.totalTokens')}: <Text color="zy">{formatNumber(totalTokens)}</Text>
          </Text>
        </Box>
      </Box>

      {/* Section 2: Activity - Row 1: Sessions | Longest session */}
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            {tSync('stats.sessions')}: <Text color="zy">{formatNumber(stats.totalSessions)}</Text>
          </Text>
        </Box>
        <Box flexDirection="column" width={28}>
          {stats.longestSession && (
            <Text wrap="truncate">
              {tSync('stats.longestSession')}:{' '}
              <Text color="zy">{formatDuration(stats.longestSession.duration)}</Text>
            </Text>
          )}
        </Box>
      </Box>

      {/* Row 2: Active days | Longest streak */}
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            {tSync('stats.activeDays')}: <Text color="zy">{stats.activeDays}</Text>
            <Text color="subtle">/{rangeDays}</Text>
          </Text>
        </Box>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            {tSync('stats.longestStreak')}:{' '}
            <Text color="zy" bold>
              {stats.streaks.longestStreak}
            </Text>{' '}
            {stats.streaks.longestStreak === 1 ? tSync('stats.day') : tSync('stats.days')}
          </Text>
        </Box>
      </Box>

      {/* Row 3: Most active day | Current streak */}
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" width={28}>
          {stats.peakActivityDay && (
            <Text wrap="truncate">
              {tSync('stats.mostActiveDay')}:{' '}
              <Text color="zy">{formatPeakDay(stats.peakActivityDay)}</Text>
            </Text>
          )}
        </Box>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            {tSync('stats.currentStreak')}:{' '}
            <Text color="zy" bold>
              {allTimeStats.streaks.currentStreak}
            </Text>{' '}
            {allTimeStats.streaks.currentStreak === 1 ? tSync('stats.day') : tSync('stats.days')}
          </Text>
        </Box>
      </Box>

      {/* Speculation time saved (ant-only) */}
      {isInternalBuild() && stats.totalSpeculationTimeSavedMs > 0 && (
        <Box flexDirection="row" gap={4}>
          <Box flexDirection="column" width={28}>
            <Text wrap="truncate">
              {tSync('stats.speculationSaved')}:{' '}
              <Text color="zy">{formatDuration(stats.totalSpeculationTimeSavedMs)}</Text>
            </Text>
          </Box>
        </Box>
      )}

      {/* Shot stats (ant-only) */}
      {shotStatsData && (
        <>
          <Box marginTop={1}>
            <Text>{tSync('stats.shotDistribution')}</Text>
          </Box>
          <Box flexDirection="row" gap={4}>
            <Box flexDirection="column" width={28}>
              <Text wrap="truncate">
                {shotStatsData.buckets[0]!.label}:{' '}
                <Text color="zy">{shotStatsData.buckets[0]!.count}</Text>
                <Text color="subtle"> ({shotStatsData.buckets[0]!.pct}%)</Text>
              </Text>
            </Box>
            <Box flexDirection="column" width={28}>
              <Text wrap="truncate">
                {shotStatsData.buckets[1]!.label}:{' '}
                <Text color="zy">{shotStatsData.buckets[1]!.count}</Text>
                <Text color="subtle"> ({shotStatsData.buckets[1]!.pct}%)</Text>
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" gap={4}>
            <Box flexDirection="column" width={28}>
              <Text wrap="truncate">
                {shotStatsData.buckets[2]!.label}:{' '}
                <Text color="zy">{shotStatsData.buckets[2]!.count}</Text>
                <Text color="subtle"> ({shotStatsData.buckets[2]!.pct}%)</Text>
              </Text>
            </Box>
            <Box flexDirection="column" width={28}>
              <Text wrap="truncate">
                {shotStatsData.buckets[3]!.label}:{' '}
                <Text color="zy">{shotStatsData.buckets[3]!.count}</Text>
                <Text color="subtle"> ({shotStatsData.buckets[3]!.pct}%)</Text>
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" gap={4}>
            <Box flexDirection="column" width={28}>
              <Text wrap="truncate">
                {tSync('stats.avgPerSession')}: <Text color="zy">{shotStatsData.avgShots}</Text>
              </Text>
            </Box>
          </Box>
        </>
      )}

      {/* Fun factoid */}
      {factoid && (
        <Box marginTop={1}>
          <Text color="suggestion">{factoid}</Text>
        </Box>
      )}
    </Box>
  )
}

// 各国名著及大致 Token 数（英文约 words*1.3，中文约 chars*1.5）
// 按 tokens 升序排列，用于趣味对比；name 为 i18n key
const BOOK_COMPARISONS = [
  { id: 'theLittlePrince', tokens: 22000 },
  { id: 'theOldManAndTheSea', tokens: 35000 },
  { id: 'aChristmasCarol', tokens: 37000 },
  { id: 'animalFarm', tokens: 39000 },
  { id: 'toLive', tokens: 48000 },
  { id: 'borderTown', tokens: 50000 },
  { id: 'fahrenheit451', tokens: 60000 },
  { id: 'theGreatGatsby', tokens: 62000 },
  { id: 'slaughterhouseFive', tokens: 64000 },
  { id: 'norwegianWood', tokens: 75000 },
  { id: 'braveNewWorld', tokens: 83000 },
  { id: 'fortressBesieged', tokens: 88000 },
  { id: 'theCatcherInTheRye', tokens: 95000 },
  { id: 'camelXiangzi', tokens: 100000 },
  { id: 'harryPotterAndThePhilosophersStone', tokens: 103000 },
  { id: 'theHobbit', tokens: 123000 },
  { id: 'nineteenEightyFour', tokens: 123000 },
  { id: 'toKillAMockingbird', tokens: 130000 },
  { id: 'theKiteRunner', tokens: 130000 },
  { id: 'prideAndPrejudice', tokens: 156000 },
  { id: 'whiteDeerPlain', tokens: 220000 },
  { id: 'snowCountry', tokens: 220000 },
  { id: 'dune', tokens: 244000 },
  { id: 'ordinaryWorld', tokens: 260000 },
  { id: 'mobyDick', tokens: 268000 },
  { id: 'crimeAndPunishment', tokens: 274000 },
  { id: 'theThreeBodyProblem', tokens: 310000 },
  { id: 'aGameOfThrones', tokens: 381000 },
  { id: 'journeyToTheWest', tokens: 420000 },
  { id: 'annaKarenina', tokens: 468000 },
  { id: 'dreamOfTheRedChamber', tokens: 470000 },
  { id: 'donQuixote', tokens: 520000 },
  { id: 'waterMargin', tokens: 520000 },
  { id: 'theLordOfTheRings', tokens: 576000 },
  { id: 'theCountOfMonteCristo', tokens: 603000 },
  { id: 'theLegendOfTheCondorHeroes', tokens: 620000 },
  { id: 'romanceOfTheThreeKingdoms', tokens: 650000 },
  { id: 'lesMiserables', tokens: 689000 },
  { id: 'warAndPeace', tokens: 730000 },
]

// Time equivalents for session durations
const TIME_COMPARISONS = [
  {
    name: 'a TED talk',
    minutes: 18,
  },
  {
    name: 'an episode of The Office',
    minutes: 22,
  },
  {
    name: 'listening to Abbey Road',
    minutes: 47,
  },
  {
    name: 'a yoga class',
    minutes: 60,
  },
  {
    name: 'a World Cup soccer match',
    minutes: 90,
  },
  {
    name: 'a half marathon (average time)',
    minutes: 120,
  },
  {
    name: 'the movie Inception',
    minutes: 148,
  },
  {
    name: 'watching Titanic',
    minutes: 195,
  },
  {
    name: 'a transatlantic flight',
    minutes: 420,
  },
  {
    name: 'a full night of sleep',
    minutes: 480,
  },
]
function generateFunFactoid(stats: ZyCodeStats, totalTokens: number): string {
  const factoids: string[] = []
  if (totalTokens > 0) {
    const matchingBooks = BOOK_COMPARISONS.filter((book) => totalTokens >= book.tokens)
    for (const book of matchingBooks) {
      const bookName = tSync(`stats.books.${book.id}`)
      const times = totalTokens / book.tokens
      if (times >= 2) {
        factoids.push(tSync('stats.factTokensMore', { n: Math.floor(times), book: bookName }))
      } else {
        factoids.push(tSync('stats.factTokensSame', { book: bookName }))
      }
    }
  }
  if (stats.longestSession) {
    const sessionMinutes = stats.longestSession.duration / (1000 * 60)
    for (const comparison of TIME_COMPARISONS) {
      const ratio = sessionMinutes / comparison.minutes
      if (ratio >= 2) {
        factoids.push(
          tSync('stats.factSessionLonger', { n: Math.floor(ratio), comparison: comparison.name }),
        )
      }
    }
  }
  if (factoids.length === 0) {
    return ''
  }
  const randomIndex = Math.floor(Math.random() * factoids.length)
  return factoids[randomIndex]!
}
function ModelsTab({
  stats,
  dateRange,
  isLoading,
  isActive,
  onUp,
}: {
  stats: ZyCodeStats
  dateRange: StatsDateRange
  isLoading: boolean
} & InnerTabProps) {
  const [scrollOffset, setScrollOffset] = useState(0)
  const { columns: terminalWidth } = useTerminalSize()
  const modelEntries = Object.entries(stats.modelUsage).sort((entryA, entryB) => {
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    const [, a]: [string, any] = entryA
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    const [, b]: [string, any] = entryB
    return b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)
  })
  useInput(
    (_input, key) => {
      if (key.downArrow && scrollOffset < modelEntries.length - 4) {
        setScrollOffset((prev) => Math.min(prev + 2, modelEntries.length - 4))
      }
      if (key.upArrow) {
        if (scrollOffset > 0) {
          setScrollOffset((previousOffset) => Math.max(previousOffset - 2, 0))
        } else {
          onUp()
        }
      }
    },
    { isActive },
  )
  if (modelEntries.length === 0) {
    return (
      <Box>
        <Text color="subtle">{tSync('stats.noModelData')}</Text>
      </Box>
    )
  }
  const totalTokens = modelEntries.reduce((sum, entry) => {
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    const [, usage]: [string, any] = entry
    return sum + usage.inputTokens + usage.outputTokens
  }, 0)
  const chartOutput = generateTokenChart(
    stats.dailyModelTokens,
    modelEntries.map((entry) => {
      const [model] = entry
      return model
    }),
    terminalWidth,
  )
  const visibleModels = modelEntries.slice(scrollOffset, scrollOffset + 4)
  const midpoint = Math.ceil(visibleModels.length / 2)
  const leftModels = visibleModels.slice(0, midpoint)
  const rightModels = visibleModels.slice(midpoint)
  const canScrollUp = scrollOffset > 0
  const canScrollDown = scrollOffset < modelEntries.length - 4
  const showScrollHint = modelEntries.length > 4
  const StatsBox = Box
  const rightModelEntries = rightModels.map((entry) => {
    const [model_1, usage_1] = entry
    return (
      <ModelEntry
        key={model_1}
        model={model_1}
        usage={usage_1 as ModelEntryProps['usage']}
        totalTokens={totalTokens}
      />
    )
  })
  return (
    <Box flexDirection="column" marginTop={1}>
      {chartOutput && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold={true}>{tSync('stats.tokensPerDay')}</Text>
          {chartOutput.chart.split('\n').map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
          <Text color="subtle">{chartOutput.xAxisLabels}</Text>
          <Box>
            {chartOutput.legend.map((item, i) => (
              <Text key={item.model}>
                {i > 0 ? ' · ' : ''}
                <Ansi>{item.coloredBullet}</Ansi> {item.model}
              </Text>
            ))}
          </Box>
        </Box>
      )}
      {/* @ts-ignore */}
      <DateRangeSelector dateRange={dateRange} isLoading={isLoading} />
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" width={36}>
          {leftModels.map((entry) => {
            const [model_0, usage_0] = entry
            const normalizedUsage = {
              inputTokens: (usage_0 as { inputTokens?: number }).inputTokens ?? 0,
              outputTokens: (usage_0 as { outputTokens?: number }).outputTokens ?? 0,
              cacheReadInputTokens:
                (usage_0 as { cacheReadInputTokens?: number }).cacheReadInputTokens ?? 0,
            }
            return (
              <ModelEntry
                key={model_0}
                model={model_0}
                usage={normalizedUsage}
                totalTokens={totalTokens}
              />
            )
          })}
        </Box>
        {
          <StatsBox flexDirection={'column'} width={36}>
            {rightModelEntries}
          </StatsBox>
        }
      </Box>
      {showScrollHint && (
        <Box marginTop={1}>
          <Text color="subtle">
            {canScrollUp ? ARROW_UP : ' '} {canScrollDown ? ARROW_DOWN : ' '} {scrollOffset + 1}-
            {Math.min(scrollOffset + 4, modelEntries.length)} of {modelEntries.length}{' '}
            {tSync('stats.modelScrollHint')}
          </Text>
        </Box>
      )}
    </Box>
  )
}
type ModelEntryProps = {
  model: string
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
  }
  totalTokens: number
}
function ModelEntry({ model, usage, totalTokens }: ModelEntryProps) {
  const modelTokens = usage.inputTokens + usage.outputTokens
  const percentage = ((modelTokens / totalTokens) * 100).toFixed(1)
  const displayName = renderModelName(model)
  const formattedInput = formatNumber(usage.inputTokens)
  const formattedOutput = formatNumber(usage.outputTokens)
  return (
    <Box flexDirection="column">
      {
        <Text>
          {BULLET} {<Text bold={true}>{displayName}</Text>}{' '}
          {<Text color="subtle">({percentage}%)</Text>}
        </Text>
      }
      {
        <Text color="subtle">
          {'  '}
          {tSync('stats.inOut', { in: formattedInput, out: formattedOutput })}
        </Text>
      }
    </Box>
  )
}
type ChartLegend = {
  model: string
  coloredBullet: string // Pre-colored bullet using chalk
}
type ChartOutput = {
  chart: string
  legend: ChartLegend[]
  xAxisLabels: string
}
function generateTokenChart(
  dailyTokens: DailyModelTokens[],
  models: string[],
  terminalWidth: number,
): ChartOutput | null {
  if (dailyTokens.length < 2 || models.length === 0) {
    return null
  }

  // Y-axis labels take about 6 characters, plus some padding
  // Cap at ~52 to align with heatmap width (1 year of data)
  const yAxisWidth = 7
  const availableWidth = terminalWidth - yAxisWidth
  const chartWidth = Math.min(52, Math.max(20, availableWidth))

  // Distribute data across the available chart width
  let recentData: DailyModelTokens[]
  if (dailyTokens.length >= chartWidth) {
    // More data than space: take most recent N days
    recentData = dailyTokens.slice(-chartWidth)
  } else {
    // Less data than space: expand by repeating each point
    const repeatCount = Math.floor(chartWidth / dailyTokens.length)
    recentData = []
    for (const day of dailyTokens) {
      for (let i = 0; i < repeatCount; i++) {
        recentData.push(day)
      }
    }
  }

  // Color palette for different models - use blue shades
  const theme = getTheme(resolveThemeSetting(getGlobalConfig().theme))
  const colors = [
    themeColorToAnsi(theme.suggestion),
    themeColorToAnsi(theme.success),
    themeColorToAnsi(theme.warning),
  ]

  // Prepare series data for each model
  const series: number[][] = []
  const legend: ChartLegend[] = []

  // Only show top 3 models to keep chart readable
  const topModels = models.slice(0, 3)
  for (let i = 0; i < topModels.length; i++) {
    const model = topModels[i]!
    const data = recentData.map((day) => day.tokensByModel[model] || 0)

    // Only include if there's actual data
    if (data.some((v) => v > 0)) {
      series.push(data)
      // Use blue colors that match the chart
      const bulletColors: Color[] = ['ansi:cyan', 'ansi:blue', 'ansi:blueBright']
      legend.push({
        model: renderModelName(model),
        coloredBullet: applyColor(BULLET, bulletColors[i % bulletColors.length]!),
      })
    }
  }
  if (series.length === 0) {
    return null
  }
  const chart = asciichart(series, {
    height: 8,
    colors: colors.slice(0, series.length),
    format: (x: number) => {
      let label: string
      if (x >= 1_000_000) {
        label = `${(x / 1_000_000).toFixed(1)}M`
      } else if (x >= 1_000) {
        label = `${(x / 1_000).toFixed(0)}k`
      } else {
        label = x.toFixed(0)
      }
      return label.padStart(6)
    },
  })

  // Generate x-axis labels with dates
  const xAxisLabels = generateXAxisLabels(recentData, recentData.length, yAxisWidth)
  return {
    chart,
    legend,
    xAxisLabels,
  }
}
function generateXAxisLabels(
  data: DailyModelTokens[],
  _chartWidth: number,
  yAxisOffset: number,
): string {
  if (data.length === 0) {
    return ''
  }

  // Show 3-4 date labels evenly spaced, but leave room for last label
  const numLabels = Math.min(4, Math.max(2, Math.floor(data.length / 8)))
  // Don't use the very last position - leave room for the label text
  const usableLength = data.length - 6 // Reserve ~6 chars for last label (e.g., "Dec 7")
  const step = Math.floor(usableLength / (numLabels - 1)) || 1
  const labelPositions: {
    pos: number
    label: string
  }[] = []
  for (let i = 0; i < numLabels; i++) {
    const idx = Math.min(i * step, data.length - 1)
    const date = new Date(data[idx]!.date)
    const label = date.toLocaleDateString(getLocale(), {
      month: 'short',
      day: 'numeric',
    })
    labelPositions.push({
      pos: idx,
      label,
    })
  }

  // Build the label string with proper spacing
  let result = ' '.repeat(yAxisOffset)
  let currentPos = 0
  for (const { pos, label } of labelPositions) {
    const spaces = Math.max(1, pos - currentPos)
    result += ' '.repeat(spaces) + label
    currentPos = pos + label.length
  }
  return result
}

// Screenshot functionality
async function handleScreenshot(
  stats: ZyCodeStats,
  activeTab: 'Overview' | 'Models',
  setStatus: (status: string | null) => void,
): Promise<void> {
  setStatus(tSync('stats.copying'))
  const ansiText = renderStatsToAnsi(stats, activeTab)
  const result = await copyAnsiToClipboard(ansiText)
  setStatus(result.success ? tSync('stats.copied') : tSync('stats.copyFailed'))

  // Clear status after 2 seconds
  setTimeout(setStatus, 2000, null)
}
function renderStatsToAnsi(stats: ZyCodeStats, activeTab: 'Overview' | 'Models'): string {
  const lines: string[] = []
  if (activeTab === 'Overview') {
    lines.push(...renderOverviewToAnsi(stats))
  } else {
    lines.push(...renderModelsToAnsi(stats))
  }

  // Trim trailing empty lines
  while (lines.length > 0 && stripAnsi(lines[lines.length - 1]!).trim() === '') {
    lines.pop()
  }

  // Add "/stats" right-aligned on the last line
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1]!
    const lastLineLen = getStringWidth(lastLine)
    // Use known content widths based on layout:
    // Overview: two-column stats = COL2_START(40) + COL2_LABEL_WIDTH(18) + max_value(~12) = 70
    // Models: chart width = 80
    const contentWidth = activeTab === 'Overview' ? 70 : 80
    const statsLabel = '/stats'
    const padding = Math.max(2, contentWidth - lastLineLen - statsLabel.length)
    lines[lines.length - 1] = lastLine + ' '.repeat(padding) + chalk.gray(statsLabel)
  }
  return lines.join('\n')
}
function renderOverviewToAnsi(stats: ZyCodeStats): string[] {
  const lines: string[] = []
  const theme = getTheme(resolveThemeSetting(getGlobalConfig().theme))
  const h = (text: string) => applyColor(text, theme.zy as Color)

  // Two-column helper with fixed spacing
  // Column 1: label (18 chars) + value + padding to reach col 2
  // Column 2 starts at character position 40
  const COL1_LABEL_WIDTH = 18
  const COL2_START = 40
  const COL2_LABEL_WIDTH = 18
  const row = (l1: string, v1: string, l2: string, v2: string): string => {
    // Build column 1: label + value
    const label1 = `${l1}:`.padEnd(COL1_LABEL_WIDTH)
    const col1PlainLen = label1.length + v1.length

    // Calculate spaces needed between col1 value and col2 label
    const spaceBetween = Math.max(2, COL2_START - col1PlainLen)

    // Build column 2: label + value
    const label2 = `${l2}:`.padEnd(COL2_LABEL_WIDTH)

    // Assemble with colors applied to values only
    return label1 + h(v1) + ' '.repeat(spaceBetween) + label2 + h(v2)
  }

  // Heatmap - use fixed width for screenshot (56 = 52 weeks + 4 for day labels)
  if (stats.dailyActivity.length > 0) {
    lines.push(
      generateHeatmap(stats.dailyActivity, {
        terminalWidth: 56,
      }),
    )
    lines.push('')
  }

  // Calculate values
  const modelEntries = Object.entries(stats.modelUsage).sort(
    ([, a], [, b]) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  )
  const favoriteModel = modelEntries[0]
  const totalTokens = modelEntries.reduce(
    (sum, [, usage]) => sum + usage.inputTokens + usage.outputTokens,
    0,
  )

  // Row 1: Favorite model | Total tokens
  if (favoriteModel) {
    lines.push(
      row(
        tSync('stats.favoriteModel'),
        renderModelName(favoriteModel[0]),
        tSync('stats.totalTokens'),
        formatNumber(totalTokens),
      ),
    )
  }
  lines.push('')

  // Row 2: Sessions | Longest session
  lines.push(
    row(
      tSync('stats.sessions'),
      formatNumber(stats.totalSessions),
      tSync('stats.longestSession'),
      stats.longestSession
        ? formatDuration(stats.longestSession.duration)
        : tSync('stats.notAvailable'),
    ),
  )

  // Row 3: Current streak | Longest streak
  const currentStreakVal = `${stats.streaks.currentStreak} ${stats.streaks.currentStreak === 1 ? tSync('stats.day') : tSync('stats.days')}`
  const longestStreakVal = `${stats.streaks.longestStreak} ${stats.streaks.longestStreak === 1 ? tSync('stats.day') : tSync('stats.days')}`
  lines.push(
    row(
      tSync('stats.currentStreak'),
      currentStreakVal,
      tSync('stats.longestStreak'),
      longestStreakVal,
    ),
  )

  // Row 4: Active days | Peak hour
  const activeDaysVal = `${stats.activeDays}/${stats.totalDays}`
  const peakHourVal =
    stats.peakActivityHour !== null
      ? `${stats.peakActivityHour}:00-${stats.peakActivityHour + 1}:00`
      : tSync('stats.notAvailable')
  lines.push(row(tSync('stats.activeDays'), activeDaysVal, tSync('stats.peakHour'), peakHourVal))

  // Speculation time saved (ant-only)
  if (isInternalBuild() && stats.totalSpeculationTimeSavedMs > 0) {
    const label = `${tSync('stats.speculationSaved')}:`.padEnd(COL1_LABEL_WIDTH)
    lines.push(label + h(formatDuration(stats.totalSpeculationTimeSavedMs)))
  }

  // Shot stats (ant-only)
  if (feature('SHOT_STATS') && stats.shotDistribution) {
    const dist = stats.shotDistribution
    const totalWithShots = Object.values(dist).reduce((s, n) => s + n, 0)
    if (totalWithShots > 0) {
      const totalShots = Object.entries(dist).reduce(
        (s, [count, sessions]) => s + parseInt(count, 10) * sessions,
        0,
      )
      const avgShots = (totalShots / totalWithShots).toFixed(1)
      const bucket = (min: number, max?: number) =>
        Object.entries(dist)
          .filter(([k]) => {
            const n = parseInt(k, 10)
            return n >= min && (max === undefined || n <= max)
          })
          .reduce((s, [, v]) => s + v, 0)
      const pct = (n: number) => Math.round((n / totalWithShots) * 100)
      const fmtBucket = (count: number, p: number) => `${count} (${p}%)`
      const b1 = bucket(1, 1)
      const b2_5 = bucket(2, 5)
      const b6_10 = bucket(6, 10)
      const b11 = bucket(11)
      lines.push('')
      lines.push(tSync('stats.shotDistribution'))
      lines.push(row('1-shot', fmtBucket(b1, pct(b1)), '2\u20135 shot', fmtBucket(b2_5, pct(b2_5))))
      lines.push(
        row('6\u201310 shot', fmtBucket(b6_10, pct(b6_10)), '11+ shot', fmtBucket(b11, pct(b11))),
      )
      lines.push(`${(`${tSync('stats.avgPerSession')}:`).padEnd(COL1_LABEL_WIDTH)}${h(avgShots)}`)
    }
  }
  lines.push('')

  // Fun factoid
  const factoid = generateFunFactoid(stats, totalTokens)
  lines.push(h(factoid))
  lines.push(chalk.gray(tSync('stats.screenshotDateRange', { n: stats.totalDays })))
  return lines
}
function renderModelsToAnsi(stats: ZyCodeStats): string[] {
  const lines: string[] = []
  const modelEntries = Object.entries(stats.modelUsage).sort(
    ([, a], [, b]) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  )
  if (modelEntries.length === 0) {
    lines.push(chalk.gray(tSync('stats.noModelData')))
    return lines
  }
  const favoriteModel = modelEntries[0]
  const totalTokens = modelEntries.reduce(
    (sum, [, usage]) => sum + usage.inputTokens + usage.outputTokens,
    0,
  )

  // Generate chart if we have data - use fixed width for screenshot
  const chartOutput = generateTokenChart(
    stats.dailyModelTokens,
    modelEntries.map(([model]) => model),
    80, // Fixed width for screenshot
  )
  if (chartOutput) {
    lines.push(chalk.bold(tSync('stats.tokensPerDay')))
    lines.push(chartOutput.chart)
    lines.push(chalk.gray(chartOutput.xAxisLabels))
    // Legend - use pre-colored bullets from chart output
    const legendLine = chartOutput.legend
      .map((item) => `${item.coloredBullet} ${item.model}`)
      .join(' · ')
    lines.push(legendLine)
    lines.push('')
  }

  // Summary
  lines.push(
    `${STAR} ${tSync('stats.favoriteModel')}: ${chalk.cyan.bold(renderModelName(favoriteModel?.[0] || ''))} · ${CIRCLE} ${tSync('stats.totalTokens')}: ${chalk.cyan(formatNumber(totalTokens))} tokens`,
  )
  lines.push('')

  // Model breakdown - only show top 3 for screenshot
  const topModels = modelEntries.slice(0, 3)
  for (const [model, usage] of topModels) {
    const modelTokens = usage.inputTokens + usage.outputTokens
    const percentage = ((modelTokens / totalTokens) * 100).toFixed(1)
    lines.push(`${BULLET} ${chalk.bold(renderModelName(model))} ${chalk.gray(`(${percentage}%)`)}`)
    lines.push(
      chalk.dim(
        `  ${tSync('stats.inOut', { in: formatNumber(usage.inputTokens), out: formatNumber(usage.outputTokens) })}`,
      ),
    )
  }
  return lines
}
