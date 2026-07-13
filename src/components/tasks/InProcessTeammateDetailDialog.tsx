import type { DeepImmutable } from 'src/types/utils.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text, useTheme } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { getTools } from '../../tools.js'
import { formatNumber, truncateToWidth } from '../../utils/format.js'
import { toInkColor } from '../../utils/ink.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { renderToolActivity } from './renderToolActivity.js'
import { describeTeammateActivity } from './taskStatusUtils.js'

type Props = {
  teammate: DeepImmutable<InProcessTeammateTaskState>
  onDone: () => void
  onKill?: () => void
  onBack?: () => void
  onForeground?: () => void
}
export function InProcessTeammateDetailDialog({
  teammate,
  onDone,
  onKill,
  onBack,
  onForeground,
}: Props) {
  const [theme] = useTheme()
  const tools = getTools(getEmptyToolPermissionContext())
  const elapsedTime = useElapsedTime(
    teammate.startTime,
    teammate.status === 'running',
    1000,
    teammate.totalPausedMs ?? 0,
  )
  useKeybindings(
    {
      'confirm:yes': onDone,
    },
    {
      context: 'Confirmation',
    },
  )
  const handleKeyDown = (e: import('../../ink/events/keyboard-event.js').KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault()
      onDone()
    } else {
      if (e.key === 'left' && onBack) {
        e.preventDefault()
        onBack()
      } else {
        if (e.key === 'x' && teammate.status === 'running' && onKill) {
          e.preventDefault()
          onKill()
        } else {
          if (e.key === 'f' && teammate.status === 'running' && onForeground) {
            e.preventDefault()
            onForeground()
          }
        }
      }
    }
  }
  const activity = describeTeammateActivity(teammate)
  const tokenCount = teammate.result?.totalTokens ?? teammate.progress?.tokenCount
  const toolUseCount = teammate.result?.totalToolUseCount ?? teammate.progress?.toolUseCount
  const displayPrompt = truncateToWidth(teammate.prompt, 300)
  const teammateColor = toInkColor(teammate.identity.color)
  const title = (
    <Text>
      {<Text color={teammateColor}>@{teammate.identity.agentName}</Text>}
      {activity && <Text dimColor={true}> ({activity})</Text>}
    </Text>
  )
  const subtitle = (
    <Text>
      {teammate.status !== 'running' && (
        <Text
          color={
            teammate.status === 'completed'
              ? 'success'
              : teammate.status === 'killed'
                ? 'warning'
                : 'error'
          }
        >
          {teammate.status === 'completed'
            ? tSync('backgroundTasks.completed')
            : teammate.status === 'failed'
              ? tSync('backgroundTasks.failed')
              : tSync('backgroundTasks.stopped')}
          {' \xB7 '}
        </Text>
      )}
      {
        <Text dimColor={true}>
          {elapsedTime}
          {tokenCount !== undefined && tokenCount > 0 && <> · {formatNumber(tokenCount)} tokens</>}
          {toolUseCount !== undefined && toolUseCount > 0 && (
            <>
              {' '}
              · {toolUseCount}{' '}
              {toolUseCount === 1
                ? tSync('backgroundTasks.toolSingular')
                : tSync('backgroundTasks.toolPlural')}
            </>
          )}
        </Text>
      }
    </Text>
  )
  const tmRecentActivities = teammate.progress?.recentActivities
  const progressSection = teammate.status === 'running' &&
    tmRecentActivities &&
    tmRecentActivities.length > 0 && (
      <Box flexDirection="column">
        <Text bold={true} dimColor={true}>
          {tSync('backgroundTasks.progress')}
        </Text>
        {tmRecentActivities.map((activity, index) => (
          <Text key={index} dimColor={index < tmRecentActivities.length - 1} wrap="truncate-end">
            {index === tmRecentActivities.length - 1 ? '\u203A ' : '  '}
            {renderToolActivity(activity, tools, theme)}
          </Text>
        ))}
      </Box>
    )
  return (
    <Box flexDirection="column" tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>
      {
        <Dialog
          title={title}
          subtitle={subtitle}
          onCancel={onDone}
          color="background"
          inputGuide={(exitState) =>
            exitState.pending ? (
              <Text>
                {tSync('taskDetail.pressAgainToExit', { keyName: exitState.keyName ?? '' })}
              </Text>
            ) : (
              <Byline>
                {onBack && <KeyboardShortcutHint shortcut={'\u2190'} action="go back" />}
                <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
                {teammate.status === 'running' && onKill && (
                  <KeyboardShortcutHint shortcut="x" action="stop" />
                )}
                {teammate.status === 'running' && onForeground && (
                  <KeyboardShortcutHint shortcut="f" action="foreground" />
                )}
              </Byline>
            )
          }
        >
          {progressSection}
          {
            <Box flexDirection="column" marginTop={1}>
              {
                <Text bold={true} dimColor={true}>
                  {tSync('backgroundTasks.prompt')}
                </Text>
              }
              <Text wrap="wrap">{displayPrompt}</Text>
            </Box>
          }
          {teammate.status === 'failed' && teammate.error && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold={true} color="error">
                {tSync('backgroundTasks.error')}
              </Text>
              <Text color="error" wrap="wrap">
                {teammate.error}
              </Text>
            </Box>
          )}
        </Dialog>
      }
    </Box>
  )
}
