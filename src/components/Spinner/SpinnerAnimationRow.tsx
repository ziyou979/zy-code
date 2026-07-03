import { fig } from '../../constants/figures.js'
import * as React from 'react'
import { useMemo, useRef } from 'react'
import { tSync } from '../../i18n/index.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text, useAnimationFrame } from '../../ink.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { formatNumber, getLocalizedDurationFormatter } from '../../utils/format.js'
import { toInkColor } from '../../utils/ink.js'
import type { Theme } from '../../utils/theme.js'
import { Byline } from '../design-system/Byline.js'
import { GlimmerMessage } from './GlimmerMessage.js'
import { SpinnerGlyph } from './SpinnerGlyph.js'
import type { SpinnerMode } from './types.js'
import { useStalledAnimation } from './useStalledAnimation.js'

const SEP_WIDTH = stringWidth(' · ')
const SHOW_TOKENS_AFTER_MS = 30_000

export type SpinnerAnimationRowProps = {
  // Animation inputs
  mode: SpinnerMode
  reducedMotion: boolean
  hasActiveTools: boolean
  responseLengthRef: React.RefObject<number>

  // Message (stable within a turn)
  message: string
  messageColor: keyof Theme
  shimmerColor: keyof Theme
  overrideColor?: keyof Theme | null

  // Timer refs (stable references)
  loadingStartTimeRef: React.RefObject<number>
  totalPausedMsRef: React.RefObject<number>
  pauseStartTimeRef: React.RefObject<number | null>

  // Display flags
  spinnerSuffix?: string | null
  verbose: boolean
  columns: number

  // Teammate-derived (computed by parent from tasks)
  hasRunningTeammates: boolean
  teammateTokens: number
  foregroundedTeammate: InProcessTeammateTaskState | undefined
  /** Leader's turn has completed. Suppresses stall-red since responseLengthRef/hasActiveTools track leader state only. */
  leaderIsIdle?: boolean
}

/**
 * The 50ms-animated portion of SpinnerWithVerb. Owns useAnimationFrame(50)
 * and all values derived from the animation clock (frame, glimmer, token
 * counter animation, elapsed-time, stalled intensity, thinking shimmer).
 *
 * The parent SpinnerWithVerb is freed from the 50ms render loop and only
 * re-renders when its props/app state change (~25x/turn instead of ~383x).
 * That keeps the outer Box shells, useAppState selectors, task filtering,
 * and tip/tree subtrees out of the hot animation path.
 */
export function SpinnerAnimationRow({
  mode,
  reducedMotion,
  hasActiveTools,
  responseLengthRef,
  message,
  messageColor,
  shimmerColor,
  overrideColor,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  spinnerSuffix,
  verbose,
  columns,
  hasRunningTeammates,
  teammateTokens,
  foregroundedTeammate,
  leaderIsIdle = false,
}: SpinnerAnimationRowProps): React.ReactNode {
  const [viewportRef, time] = useAnimationFrame(reducedMotion ? null : 50)

  // === Elapsed time (wall-clock, derived from refs each frame) ===
  const now = Date.now()
  const elapsedTimeMs =
    pauseStartTimeRef.current !== null
      ? pauseStartTimeRef.current - loadingStartTimeRef.current - totalPausedMsRef.current
      : now - loadingStartTimeRef.current - totalPausedMsRef.current

  // Track wall-clock turn start for teammates. While a swarm is running the
  // leader's elapsedTimeMs may jump around (new API calls reset
  // loadingStartTimeRef; pauses freeze it), so we anchor to the earliest
  // derived start seen so far. When no teammates are running this just tracks
  // derivedStart every frame, effectively resetting for the next swarm.
  const derivedStart = now - elapsedTimeMs
  const turnStartRef = useRef(derivedStart)
  if (!hasRunningTeammates || derivedStart < turnStartRef.current) {
    turnStartRef.current = derivedStart
  }

  // === Animation derivations from `time` ===
  const currentResponseLength = responseLengthRef.current

  // Suppress stall detection when leader is idle — responseLengthRef and
  // hasActiveTools both track leader state. When viewing an active teammate
  // while leader is idle, they'd otherwise flag a false stall after 3s.
  // Treating leaderIsIdle like hasActiveTools resets the stall timer.
  const { isStalled, stalledIntensity } = useStalledAnimation(
    time,
    currentResponseLength,
    hasActiveTools || leaderIsIdle,
    reducedMotion,
  )
  const frame = reducedMotion ? 0 : Math.floor(time / 120)
  const glimmerSpeed = mode === 'requesting' ? 50 : 200
  // message is stable within a turn; stringWidth is expensive enough (Bun native
  // call per code point) to memoize explicitly across the 50ms loop.
  const glimmerMessageWidth = useMemo(() => stringWidth(message), [message])
  const cycleLength = glimmerMessageWidth + 20
  const cyclePosition = Math.floor(time / glimmerSpeed)
  const glimmerIndex = reducedMotion
    ? -100
    : isStalled
      ? -100
      : mode === 'requesting'
        ? (cyclePosition % cycleLength) - 10
        : glimmerMessageWidth + 10 - (cyclePosition % cycleLength)
  const flashOpacity = reducedMotion
    ? 0
    : mode === 'tool-use'
      ? (Math.sin((time / 1000) * Math.PI) + 1) / 2
      : 0

  // === Token counter animation (smooth increment, driven by 50ms clock) ===
  const tokenCounterRef = useRef(currentResponseLength)
  if (reducedMotion) {
    tokenCounterRef.current = currentResponseLength
  } else {
    const gap = currentResponseLength - tokenCounterRef.current
    if (gap > 0) {
      let increment
      if (gap < 70) {
        increment = 3
      } else if (gap < 200) {
        increment = Math.max(8, Math.ceil(gap * 0.15))
      } else {
        increment = 50
      }
      tokenCounterRef.current = Math.min(tokenCounterRef.current + increment, currentResponseLength)
    }
  }
  const displayedResponseLength = tokenCounterRef.current
  const leaderTokens = Math.round(displayedResponseLength / 4)
  const effectiveElapsedMs = hasRunningTeammates
    ? Math.max(elapsedTimeMs, now - turnStartRef.current)
    : elapsedTimeMs
  const timerText = getLocalizedDurationFormatter()(effectiveElapsedMs)
  const timerWidth = stringWidth(timerText)

  // === Token count (leader + teammates, or foregrounded teammate) ===
  const totalTokens =
    foregroundedTeammate && !foregroundedTeammate.isIdle
      ? (foregroundedTeammate.progress?.tokenCount ?? 0)
      : leaderTokens + teammateTokens
  const tokenCount = formatNumber(totalTokens)
  const tokensText = hasRunningTeammates
    ? `${tokenCount} tokens`
    : `${fig.arrowDown} ${tokenCount} tokens`
  const tokensWidth = stringWidth(tokensText)

  // === Progressive width gating ===
  const messageWidth = glimmerMessageWidth + 2
  const sep = SEP_WIDTH
  const wantsTimerAndTokens =
    verbose || hasRunningTeammates || effectiveElapsedMs > SHOW_TOKENS_AFTER_MS
  const availableSpace = columns - messageWidth - 5
  const showTimer = wantsTimerAndTokens && availableSpace > timerWidth
  const showTokens =
    wantsTimerAndTokens &&
    totalTokens > 0 &&
    availableSpace > (showTimer ? timerWidth + sep : 0) + tokensWidth

  // === Build status parts ===
  const parts = [
    ...(spinnerSuffix
      ? [
          <Text dimColor key="suffix">
            {spinnerSuffix}
          </Text>,
        ]
      : []),
    ...(showTimer
      ? [
          <Text dimColor key="elapsedTime">
            {timerText}
          </Text>,
        ]
      : []),
    ...(showTokens
      ? [
          <Box flexDirection="row" key="tokens">
            {!hasRunningTeammates && ( // @ts-ignore
              <SpinnerModeGlyph mode={mode} />
            )}
            <Text dimColor>{tokenCount} tokens</Text>
          </Box>,
        ]
      : []),
  ]
  const status =
    foregroundedTeammate && !foregroundedTeammate.isIdle ? (
      <>
        <Text dimColor>({tSync('shortcut.interrupt')} </Text>
        <Text color={toInkColor(foregroundedTeammate.identity.color)}>
          {foregroundedTeammate.identity.agentName}
        </Text>
        <Text dimColor>)</Text>
      </>
    ) : !foregroundedTeammate && parts.length > 0 ? (
      <>
        <Text dimColor>(</Text>
        <Byline>{parts}</Byline>
        <Text dimColor>)</Text>
      </>
    ) : null
  return (
    <Box ref={viewportRef} flexDirection="row" overflow="hidden" marginTop={1} width="100%">
      <SpinnerGlyph
        frame={frame}
        messageColor={messageColor}
        stalledIntensity={overrideColor ? 0 : stalledIntensity}
        reducedMotion={reducedMotion}
        time={time}
      />
      <GlimmerMessage
        message={message}
        mode={mode}
        messageColor={messageColor}
        glimmerIndex={glimmerIndex}
        flashOpacity={flashOpacity}
        shimmerColor={shimmerColor}
        stalledIntensity={overrideColor ? 0 : stalledIntensity}
      />
      {status}
    </Box>
  )
}
function SpinnerModeGlyph({ mode }: SpinnerAnimationRowProps) {
  switch (mode) {
    case 'tool-input':
    case 'tool-use':
    case 'responding':
    case 'thinking': {
      return (
        <Box width={2}>
          <Text dimColor={true}>{fig.arrowDown}</Text>
        </Box>
      )
    }
    case 'requesting': {
      return (
        <Box width={2}>
          <Text dimColor={true}>{fig.arrowUp}</Text>
        </Box>
      )
    }
  }
}
