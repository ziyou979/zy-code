import * as React from 'react'
import { useEffect, useState } from 'react'
import { formatCost } from 'src/cost-tracker.js'
import { getSubscriptionType } from 'src/utils/auth.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  type ExtraUsage,
  fetchUtilization,
  type RateLimit,
  type Utilization,
} from '../../services/api/usage.js'
import { formatResetText } from '../../utils/format.js'
import { logError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Byline } from '../design-system/Byline.js'
import { ProgressBar } from '../design-system/ProgressBar.js'
import { SessionCost } from './SessionCost.js'

type LimitBarProps = {
  title: string
  limit: RateLimit
  maxWidth: number
  showTimeInReset?: boolean
  extraSubtext?: string
}
function LimitBar({ title, limit, maxWidth, showTimeInReset = true, extraSubtext }: LimitBarProps) {
  const { utilization, resets_at } = limit
  if (utilization === null) {
    return null
  }
  const usedText = tSync('usage.percentUsed', {
    pct: Math.floor(utilization),
  })
  let subtext
  if (resets_at) {
    const resetText = formatResetText(resets_at, true, showTimeInReset)
    subtext = tSync('usage.resets', {
      time: resetText,
    })
  }
  if (extraSubtext) {
    if (subtext) {
      subtext = `${extraSubtext} · ${subtext}`
    } else {
      subtext = extraSubtext
    }
  }
  if (maxWidth >= 62) {
    return (
      <Box flexDirection="column">
        {<Text bold={true}>{title}</Text>}
        {
          <Box flexDirection="row" gap={1}>
            {
              <ProgressBar
                ratio={utilization / 100}
                width={50}
                fillColor="rate_limit_fill"
                emptyColor="rate_limit_empty"
              />
            }
            {<Text>{usedText}</Text>}
          </Box>
        }
        {subtext && <Text dimColor={true}>{subtext}</Text>}
      </Box>
    )
  } else {
    return (
      <Box flexDirection="column">
        {
          <Text>
            {<Text bold={true}>{title}</Text>}
            {subtext && (
              <>
                <Text> </Text>
                <Text dimColor={true}>· {subtext}</Text>
              </>
            )}
          </Text>
        }
        {
          <ProgressBar
            ratio={utilization / 100}
            width={maxWidth}
            fillColor="rate_limit_fill"
            emptyColor="rate_limit_empty"
          />
        }
        {<Text>{usedText}</Text>}
      </Box>
    )
  }
}

// rate limit 区域独立组件，自行管理加载/错误状态
function RateLimitSection({ maxWidth }: { maxWidth: number }) {
  const [utilization, setUtilization] = useState<Utilization | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const loadUtilization = React.useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await fetchUtilization()
      setUtilization(data)
    } catch (err) {
      logError(err as Error)
      const axiosError = err as {
        response?: {
          data?: unknown
        }
      }
      const responseBody = axiosError.response?.data
        ? jsonStringify(axiosError.response.data)
        : undefined
      setError(
        responseBody
          ? tSync('usage.loadErrorDetail', {
              detail: responseBody,
            })
          : tSync('usage.loadError'),
      )
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadUtilization()
  }, [loadUtilization])

  useKeybinding(
    'settings:retry',
    () => {
      void loadUtilization()
    },
    {
      context: 'Settings',
      isActive: !!error && !isLoading,
    },
  )

  if (error) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error">
          {tSync('usage.error', {
            error: error,
          })}
        </Text>
        <Text dimColor>
          <Byline>
            <ConfigurableShortcutHint
              action="settings:retry"
              context="Settings"
              fallback="r"
              description="retry"
            />
          </Byline>
        </Text>
      </Box>
    )
  }

  if (isLoading || !utilization) {
    return (
      <Box>
        <Text dimColor>{tSync('usage.loading')}</Text>
      </Box>
    )
  }

  const subscriptionType = getSubscriptionType()
  const showSonnetBar =
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    (subscriptionType as any) === 'max' ||
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    (subscriptionType as any) === 'team' ||
    subscriptionType === null
  const limits = [
    {
      title: tSync('usage.currentSession'),
      limit: utilization.five_hour,
    },
    {
      title: tSync('usage.currentWeekAll'),
      limit: utilization.seven_day,
    },
    ...(showSonnetBar
      ? [
          {
            title: tSync('usage.currentWeekSonnet'),
            limit: utilization.seven_day_sonnet,
          },
        ]
      : []),
  ]

  const hasAnyLimit = limits.some(({ limit }) => limit)
  if (!hasAnyLimit && !utilization.extra_usage) {
    return null
  }

  return (
    <>
      {!hasAnyLimit && <Text dimColor>{tSync('usage.subscriptionOnly')}</Text>}
      {limits.map(
        ({ title, limit: rateLimit }) =>
          rateLimit && <LimitBar key={title} title={title} limit={rateLimit} maxWidth={maxWidth} />,
      )}
      {utilization.extra_usage && (
        <ExtraUsageSection extraUsage={utilization.extra_usage} maxWidth={maxWidth} />
      )}
    </>
  )
}

export function Usage(): React.ReactNode {
  const { columns } = useTerminalSize()
  const availableWidth = columns - 2
  const maxWidth = Math.min(availableWidth, 80)

  return (
    <Box flexDirection="column" gap={1} width="100%">
      <SessionCost />
      <RateLimitSection maxWidth={maxWidth} />
      <Text dimColor>
        <ConfigurableShortcutHint
          action="confirm:no"
          context="Settings"
          fallback="Esc"
          description="cancel"
        />
      </Text>
    </Box>
  )
}

type ExtraUsageSectionProps = {
  extraUsage: ExtraUsage
  maxWidth: number
}
function ExtraUsageSection({ extraUsage, maxWidth }: ExtraUsageSectionProps) {
  const EXTRA_USAGE_SECTION_TITLE = tSync('usage.extraUsage')
  const subscriptionType = getSubscriptionType()
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  const isProOrMax = (subscriptionType as any) === 'pro' || (subscriptionType as any) === 'max'
  if (!isProOrMax) {
    return false
  }
  if (!extraUsage.is_enabled) {
    return null
  }
  if (extraUsage.monthly_limit === null) {
    return (
      <Box flexDirection="column">
        <Text bold={true}>{EXTRA_USAGE_SECTION_TITLE}</Text>
        <Text dimColor={true}>{tSync('usage.unlimited')}</Text>
      </Box>
    )
  }
  if (typeof extraUsage.used_credits !== 'number' || typeof extraUsage.utilization !== 'number') {
    return null
  }
  const formattedUsedCredits = formatCost(extraUsage.used_credits / 100, 2)
  const formattedMonthlyLimit = formatCost(extraUsage.monthly_limit / 100, 2)
  const now = new Date()
  const oneMonthReset = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const LimitBarComponent = LimitBar
  const resetIsoString = oneMonthReset.toISOString()
  const spentText = tSync('usage.spent', {
    used: formattedUsedCredits,
    total: formattedMonthlyLimit,
  })
  return (
    <LimitBarComponent
      title={EXTRA_USAGE_SECTION_TITLE}
      limit={{
        utilization: extraUsage.utilization,
        resets_at: resetIsoString,
      }}
      showTimeInReset={false}
      extraSubtext={spentText}
      maxWidth={maxWidth}
    />
  )
}
