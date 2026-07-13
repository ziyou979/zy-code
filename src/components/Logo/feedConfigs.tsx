import { homedir } from 'node:os'
import { isInternalBuild } from 'src/utils/envUtils.ts'
import { TICK } from '../../constants/figures.js'
import { tSync } from '../../i18n/index.js'
import type { Step } from '../../projectOnboardingState.js'
import type { LogOption } from '../../types/logs.js'
import { getCwd } from '../../utils/cwd.js'
import { formatRelativeTimeAgo } from '../../utils/format.js'
import type { FeedConfig, FeedLine } from './Feed.js'
export function createRecentActivityFeed(activities: LogOption[]): FeedConfig {
  const lines: FeedLine[] = activities.map((log) => {
    const time = formatRelativeTimeAgo(log.modified)
    const description = log.summary && log.summary !== 'No prompt' ? log.summary : log.firstPrompt
    return {
      text: description || '',
      timestamp: time,
    }
  })
  return {
    title: tSync('logo.recentActivity'),
    lines,
    footer: lines.length > 0 ? tSync('logo.recentActivityFooter') : undefined,
    emptyMessage: tSync('logo.noRecentActivity'),
  }
}
export function createWhatsNewFeed(releaseNotes: string[]): FeedConfig {
  const lines: FeedLine[] = releaseNotes.map((note) => {
    if (isInternalBuild()) {
      const match = note.match(/^(\d+\s+\w+\s+ago)\s+(.+)$/)
      if (match) {
        return {
          timestamp: match[1],
          text: match[2] || '',
        }
      }
    }
    return {
      text: note,
    }
  })
  const emptyMessage = isInternalBuild()
    ? 'Unable to fetch latest zy-cli-internal commits'
    : tSync('logo.whatsNewEmpty')
  return {
    title: isInternalBuild() ? "What's new [ANT-ONLY: Latest CC commits]" : tSync('logo.whatsNew'),
    lines,
    footer: lines.length > 0 ? tSync('logo.whatsNewFooter') : undefined,
    emptyMessage,
  }
}
export function createProjectOnboardingFeed(steps: Step[]): FeedConfig {
  const enabledSteps = steps
    .filter(({ isEnabled }) => isEnabled)
    .sort((a, b) => Number(a.isComplete) - Number(b.isComplete))
  const lines: FeedLine[] = enabledSteps.map(({ text, isComplete }) => {
    const checkmark = isComplete ? `${TICK} ` : ''
    return {
      text: `${checkmark}${text}`,
    }
  })
  const warningText = getCwd() === homedir() ? tSync('logo.homeDirWarning') : undefined
  if (warningText) {
    lines.push({
      text: warningText,
    })
  }
  return {
    title: tSync('logo.tipsGettingStarted'),
    lines,
  }
}
