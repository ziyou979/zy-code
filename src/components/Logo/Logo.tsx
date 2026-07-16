import { feature } from 'bun:bundle'
import { useEffect, useState } from 'react'
import { getDumpPromptsPath } from 'src/services/api/dumpPrompts.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/services/config/config.js'
import { getDebugLogPath, isDebugMode, isDebugToStdErr } from 'src/utils/debug.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { getInitialSettings } from 'src/services/settings/settings.js'
import { getStartupPerfLogPath, isDetailedProfilingEnabled } from 'src/utils/startupProfiler.js'
import { resolveThemeSetting } from 'src/utils/systemTheme.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { tSync } from '../../i18n/index.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, color, Text } from '../../ink/index.js'
import {
  getSteps,
  incrementProjectOnboardingSeenCount,
  shouldShowProjectOnboarding,
} from '../../services/settings/projectOnboardingState.js'
import { getDisplayPath } from '../../utils/file.js'
import { truncate } from '../../utils/format.js'
import {
  calculateLayoutDimensions,
  calculateOptimalLeftWidth,
  formatWelcomeMessage,
  getLayoutMode,
  getLogoDisplayData,
  getRecentActivitySync,
  getRecentReleaseNotesSync,
  truncatePath,
} from '../../utils/logoUtils.js'
import { checkForReleaseNotesSync } from '../../utils/releaseNotes.js'
import { OffscreenFreeze } from '../OffscreenFreeze.js'
import { CondensedLogo } from './CondensedLogo.js'
import { EmergencyTip } from './EmergencyTip.js'
import { FeedColumn } from './FeedColumn.js'
import {
  createProjectOnboardingFeed,
  createRecentActivityFeed,
  createWhatsNewFeed,
} from './FeedConfigs.js'
import { VoiceModeNotice } from './VoiceModeNotice.js'
import { Zy } from './Zy.js'

// Type declarations for missing components
// biome-ignore lint/suspicious/noExplicitAny: 占位组件，永远不会被渲染（dead code）
const GateOverridesWarning: any = null
// biome-ignore lint/suspicious/noExplicitAny: 占位组件，永远不会被渲染（dead code）
const ExperimentEnrollmentNotice: any = null

// Conditional require so ChannelsNotice.tsx tree-shakes when both flags are
// false. A module-scope helper component inside a feature() ternary does NOT
// tree-shake (docs/feature-gating.md); the require pattern eliminates the
// whole file. VoiceModeNotice uses the unsafe helper pattern but VOICE_MODE
// is external: true so it's moot there.
/* eslint-disable @typescript-eslint/no-require-imports */
const ChannelsNoticeModule =
  feature('KAIROS') || feature('KAIROS_CHANNELS')
    ? (require('./ChannelsNotice.js') as typeof import('./ChannelsNotice.js'))
    : null

/* eslint-enable @typescript-eslint/no-require-imports */
import { SandboxManager } from 'src/services/sandbox/sandbox-adapter.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { renderModelSetting } from '../../services/model/model.js'
import { useAppState } from '../../state/AppState.js'

const LEFT_PANEL_MAX_WIDTH = 50
export function Logo() {
  const activities = getRecentActivitySync()
  const username = getGlobalConfig().oauthAccount?.displayName ?? ''
  const { columns } = useTerminalSize()
  const showOnboarding = shouldShowProjectOnboarding()
  const showSandboxStatus = SandboxManager.isSandboxingEnabled()
  const agent = useAppState((s) => s.agent)
  const model = useMainLoopModel()
  const config = getGlobalConfig()
  let changelog: string[]
  try {
    changelog = getRecentReleaseNotesSync(3)
  } catch {
    changelog = []
  }
  const [announcement] = useState(() => {
    const announcements = getInitialSettings().companyAnnouncements
    if (!announcements || announcements.length === 0) {
      return
    }
    return config.numStartups === 1
      ? announcements[0]
      : announcements[Math.floor(Math.random() * announcements.length)]
  })
  const { hasReleaseNotes } = checkForReleaseNotesSync(config.lastReleaseNotesSeen)
  useEffect(() => {
    const currentConfig = getGlobalConfig()
    if (currentConfig.lastReleaseNotesSeen === MACRO.VERSION) {
      return
    }
    saveGlobalConfig((current) => {
      if (current.lastReleaseNotesSeen === MACRO.VERSION) {
        return current
      }
      return {
        ...current,
        lastReleaseNotesSeen: MACRO.VERSION,
      }
    })
    if (showOnboarding) {
      incrementProjectOnboardingSeenCount()
    }
  }, [showOnboarding])
  const fullModelDisplayName = renderModelSetting(model)
  const { version, cwd, providerName, agentName: agentNameFromSettings } = getLogoDisplayData()
  const agentName = agent ?? agentNameFromSettings
  const modelDisplayName = truncate(fullModelDisplayName, LEFT_PANEL_MAX_WIDTH - 20)
  if (!hasReleaseNotes && !showOnboarding && !isEnvTruthy(process.env.ZY_CODE_FORCE_FULL_LOGO)) {
    const debugInfoSection = isDebugMode() && (
      <Box paddingLeft={2} flexDirection="column">
        <Text color="warning">{tSync('logo.debugModeEnabled')}</Text>
        <Text dimColor={true}>
          {tSync('logo.loggingTo', {
            path: isDebugToStdErr() ? tSync('logo.stderr') : getDebugLogPath(),
          })}
        </Text>
      </Box>
    )
    return (
      <>
        {<CondensedLogo />}
        {<VoiceModeNotice />}
        {ChannelsNoticeModule && <ChannelsNoticeModule.ChannelsNotice />}
        {debugInfoSection}
        {<EmergencyTip />}
        {process.env.ZY_CODE_TMUX_SESSION && (
          <Box paddingLeft={2} flexDirection="column">
            <Text dimColor={true}>tmux session: {process.env.ZY_CODE_TMUX_SESSION}</Text>
            <Text dimColor={true}>
              {process.env.ZY_CODE_TMUX_PREFIX_CONFLICTS
                ? `Detach: ${process.env.ZY_CODE_TMUX_PREFIX} ${process.env.ZY_CODE_TMUX_PREFIX} d (press prefix twice - Zy uses ${process.env.ZY_CODE_TMUX_PREFIX})`
                : `Detach: ${process.env.ZY_CODE_TMUX_PREFIX} d`}
            </Text>
          </Box>
        )}
        {announcement && (
          <Box paddingLeft={2} flexDirection="column">
            {!process.env.IS_DEMO && config.oauthAccount?.organizationName && (
              <Text dimColor={true}>Message from {config.oauthAccount.organizationName}:</Text>
            )}
            <Text>{announcement}</Text>
          </Box>
        )}
        {false && !process.env.DEMO_VERSION && (
          <Box paddingLeft={2} flexDirection="column">
            <Text dimColor={true}>Use /issue to report model behavior issues</Text>
          </Box>
        )}
        {false && !process.env.DEMO_VERSION && (
          <Box paddingLeft={2} flexDirection="column">
            <Text color="warning">[INNER-ONLY] Logs:</Text>
            <Text dimColor={true}>API calls: {getDisplayPath(getDumpPromptsPath())}</Text>
            <Text dimColor={true}>Debug logs: {getDisplayPath(getDebugLogPath())}</Text>
            {isDetailedProfilingEnabled() && (
              <Text dimColor={true}>Startup Perf: {getDisplayPath(getStartupPerfLogPath())}</Text>
            )}
          </Box>
        )}
        {false && <GateOverridesWarning />}
        {false && <ExperimentEnrollmentNotice />}
      </>
    )
  }
  const layoutMode = getLayoutMode(columns)
  const userTheme = resolveThemeSetting(getGlobalConfig().theme)
  const borderTitle = ` ${color('zy', userTheme)('ZY Code')} ${color('inactive', userTheme)(`v${version}`)} `
  const compactBorderTitle = color('zy', userTheme)(' ZY Code ')
  if (layoutMode === 'compact') {
    let welcomeMessage = formatWelcomeMessage(username)
    if (stringWidth(welcomeMessage) > columns - 4) {
      welcomeMessage = formatWelcomeMessage(null)
    }
    const cwdAvailableWidth = agentName ? columns - 4 - 1 - stringWidth(agentName) - 3 : columns - 4
    const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10))
    return (
      <>
        <OffscreenFreeze>
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="zy"
            borderText={{
              content: compactBorderTitle,
              position: 'top',
              align: 'start',
              offset: 1,
            }}
            paddingX={1}
            paddingY={1}
            alignItems="center"
            width={columns}
          >
            <Text bold={true}>{welcomeMessage}</Text>
            {
              <Box marginY={1}>
                <Zy />
              </Box>
            }
            {<Text dimColor={true}>{modelDisplayName}</Text>}
            <Text dimColor={true}>{providerName}</Text>
            <Text dimColor={true}>
              {agentName ? `@${agentName} · ${truncatedCwd}` : truncatedCwd}
            </Text>
          </Box>
        </OffscreenFreeze>
        {<VoiceModeNotice />}
        {ChannelsNoticeModule && <ChannelsNoticeModule.ChannelsNotice />}
        {showSandboxStatus && (
          <Box marginTop={1} flexDirection="column">
            <Text color="warning">
              Your bash commands will be sandboxed. Disable with /sandbox.
            </Text>
          </Box>
        )}
        {false && <GateOverridesWarning />}
        {false && <ExperimentEnrollmentNotice />}
      </>
    )
  }
  const welcomeMessage = formatWelcomeMessage(username)
  const modelLine =
    !process.env.IS_DEMO && config.oauthAccount?.organizationName
      ? `${modelDisplayName} · ${providerName} · ${config.oauthAccount.organizationName}`
      : `${modelDisplayName} · ${providerName}`
  const cwdAvailableWidth = agentName
    ? LEFT_PANEL_MAX_WIDTH - 1 - stringWidth(agentName) - 3
    : LEFT_PANEL_MAX_WIDTH
  const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10))
  const cwdLine = agentName ? `@${agentName} · ${truncatedCwd}` : truncatedCwd
  const optimalLeftWidth = calculateOptimalLeftWidth(welcomeMessage, cwdLine, modelLine)
  const { leftWidth, rightWidth } = calculateLayoutDimensions(columns, layoutMode, optimalLeftWidth)
  const debugInfoSection = isDebugMode() && (
    <Box paddingLeft={2} flexDirection="column">
      <Text color="warning">{tSync('logo.debugModeEnabled')}</Text>
      <Text dimColor={true}>
        {tSync('logo.loggingTo', {
          path: isDebugToStdErr() ? tSync('logo.stderr') : getDebugLogPath(),
        })}
      </Text>
    </Box>
  )
  return (
    <>
      {
        <OffscreenFreeze>
          {
            <Box
              flexDirection={'column'}
              borderStyle={'round'}
              borderColor={'zy'}
              borderText={{
                content: borderTitle,
                position: 'top',
                align: 'start',
                offset: 3,
              }}
            >
              {
                <Box
                  flexDirection={layoutMode === 'horizontal' ? 'row' : 'column'}
                  paddingX={1}
                  gap={1}
                >
                  {
                    <Box
                      flexDirection="column"
                      width={leftWidth}
                      justifyContent="space-between"
                      alignItems="center"
                      minHeight={9}
                    >
                      {
                        <Box marginTop={1}>
                          <Text bold={true}>{welcomeMessage}</Text>
                        </Box>
                      }
                      {<Zy />}
                      {
                        <Box flexDirection="column" alignItems="center">
                          {<Text dimColor={true}>{modelLine}</Text>}
                          {<Text dimColor={true}>{cwdLine}</Text>}
                        </Box>
                      }
                    </Box>
                  }
                  {layoutMode === 'horizontal' && (
                    <Box
                      height="100%"
                      borderStyle="single"
                      borderColor="zy"
                      borderDimColor={true}
                      borderTop={false}
                      borderBottom={false}
                      borderLeft={false}
                    />
                  )}
                  {layoutMode === 'horizontal' && (
                    <FeedColumn
                      feeds={
                        showOnboarding
                          ? [
                              createProjectOnboardingFeed(getSteps()),
                              createRecentActivityFeed(activities),
                            ]
                          : [createRecentActivityFeed(activities), createWhatsNewFeed(changelog)]
                      }
                      maxWidth={rightWidth}
                    />
                  )}
                </Box>
              }
            </Box>
          }
        </OffscreenFreeze>
      }
      {<VoiceModeNotice />}
      {ChannelsNoticeModule && <ChannelsNoticeModule.ChannelsNotice />}
      {debugInfoSection}
      {<EmergencyTip />}
      {process.env.ZY_CODE_TMUX_SESSION && (
        <Box paddingLeft={2} flexDirection="column">
          <Text dimColor={true}>tmux session: {process.env.ZY_CODE_TMUX_SESSION}</Text>
          <Text dimColor={true}>
            {process.env.ZY_CODE_TMUX_PREFIX_CONFLICTS
              ? `Detach: ${process.env.ZY_CODE_TMUX_PREFIX} ${process.env.ZY_CODE_TMUX_PREFIX} d (press prefix twice - Zy uses ${process.env.ZY_CODE_TMUX_PREFIX})`
              : `Detach: ${process.env.ZY_CODE_TMUX_PREFIX} d`}
          </Text>
        </Box>
      )}
      {announcement && (
        <Box paddingLeft={2} flexDirection="column">
          {!process.env.IS_DEMO && config.oauthAccount?.organizationName && (
            <Text dimColor={true}>Message from {config.oauthAccount.organizationName}:</Text>
          )}
          <Text>{announcement}</Text>
        </Box>
      )}
      {showSandboxStatus && (
        <Box paddingLeft={2} flexDirection="column">
          <Text color="warning">Your bash commands will be sandboxed. Disable with /sandbox.</Text>
        </Box>
      )}
      {false && !process.env.DEMO_VERSION && (
        <Box paddingLeft={2} flexDirection="column">
          <Text dimColor={true}>Use /issue to report model behavior issues</Text>
        </Box>
      )}
      {false && !process.env.DEMO_VERSION && (
        <Box paddingLeft={2} flexDirection="column">
          <Text color="warning">[INNER-ONLY] Logs:</Text>
          <Text dimColor={true}>API calls: {getDisplayPath(getDumpPromptsPath())}</Text>
          <Text dimColor={true}>Debug logs: {getDisplayPath(getDebugLogPath())}</Text>
          {isDetailedProfilingEnabled() && (
            <Text dimColor={true}>Startup Perf: {getDisplayPath(getStartupPerfLogPath())}</Text>
          )}
        </Box>
      )}
      {false && <GateOverridesWarning />}
      {false && <ExperimentEnrollmentNotice />}
    </>
  )
}
