// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { Box, Text } from '../../ink.js'
import { feature } from 'bun:bundle'
import { useState } from 'react'
import sample from 'lodash-es/sample.js'
import { BLACK_CIRCLE, REFERENCE_MARK, TEARDROP_ASTERISK } from '../../constants/figures.js'
import { basename } from 'node:path'
import { MessageResponse } from '../MessageResponse.js'
import { FilePathLink } from '../FilePathLink.js'
import { openPath } from '../../utils/browser.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemSaved = feature('TEAMMEM')
  ? (require('./teamMemSaved.js') as typeof import('./teamMemSaved.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import { getTurnCompletionVerbs } from '../../constants/turnCompletionVerbs.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type {
  SystemMessage,
  SystemStopHookSummaryMessage,
  SystemMemorySavedMessage,
} from '../../types/message.js'
import { SystemAPIErrorMessage } from './SystemAPIErrorMessage.js'
import { formatSecondsShort, getLocalizedDurationFormatter } from '../../utils/format.js'
import { getGlobalConfig } from '../../utils/config.js'
import Link from '../../ink/components/Link.js'
import ThemedText from '../design-system/ThemedText.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { useAppStateStore } from '../../state/AppState.js'
import { isBackgroundTask, type TaskState } from '../../tasks/types.js'
import { getPillLabel } from '../../tasks/pillLabel.js'
import { useSelectedMessageBg } from '../messageActions.js'
import { tSync } from '../../i18n/index.js'
type Props = {
  message: SystemMessage
  addMargin: boolean
  verbose: boolean
  isTranscriptMode?: boolean
}
export function SystemTextMessage({ message, addMargin, verbose, isTranscriptMode }: Props) {
  const bg = useSelectedMessageBg()
  if ('subtype' in message && message.subtype === 'turn_duration') {
    return <TurnDurationMessage message={message} addMargin={addMargin} />
  }
  if ('subtype' in message && message.subtype === 'memory_saved') {
    return <MemorySavedMessage message={message} addMargin={addMargin} />
  }
  if ('subtype' in message && message.subtype === 'away_summary') {
    return (
      <Box
        flexDirection="row"
        marginTop={addMargin ? 1 : 0}
        backgroundColor={bg as any}
        width="100%"
      >
        {
          <Box minWidth={2}>
            <Text dimColor={true}>{REFERENCE_MARK}</Text>
          </Box>
        }
        {<Text dimColor={true}>{message.content}</Text>}
      </Box>
    )
  }
  if ('subtype' in message && message.subtype === 'agents_killed') {
    return (
      <Box
        flexDirection="row"
        marginTop={addMargin ? 1 : 0}
        backgroundColor={bg as any}
        width="100%"
      >
        {
          <Box minWidth={2}>
            <Text color={'error' as any}>{BLACK_CIRCLE}</Text>
          </Box>
        }
        {<Text dimColor={true}>All background agents stopped</Text>}
      </Box>
    )
  }
  const subtypeValue: string = 'subtype' in message ? (message as { subtype: string }).subtype : ''
  if (subtypeValue === 'thinking') {
    return null
  }
  if ('subtype' in message && message.subtype === 'bridge_status') {
    return <BridgeStatusMessage message={message} addMargin={addMargin} />
  }
  if ('subtype' in message && message.subtype === 'scheduled_task_fire') {
    return (
      <Box marginTop={addMargin ? 1 : 0} backgroundColor={bg as any} width="100%">
        {
          <Text dimColor={true}>
            {TEARDROP_ASTERISK} {message.content}
          </Text>
        }
      </Box>
    )
  }
  if ('subtype' in message && message.subtype === 'permission_retry') {
    const joinedCommands = message.commands.join(', ')
    return (
      <Box marginTop={addMargin ? 1 : 0} backgroundColor={bg as any} width="100%">
        {<Text dimColor={true}>{TEARDROP_ASTERISK} </Text>}
        {<Text>Allowed </Text>}
        {<Text bold={true}>{joinedCommands}</Text>}
      </Box>
    )
  }
  const isStopHookSummary = 'subtype' in message && message.subtype === 'stop_hook_summary'
  if (!isStopHookSummary && !verbose && 'level' in message && message.level === 'info') {
    return null
  }
  if ('subtype' in message && message.subtype === 'api_error') {
    return <SystemAPIErrorMessage message={message} verbose={verbose} />
  }
  if ('subtype' in message && message.subtype === 'stop_hook_summary') {
    return (
      <StopHookSummaryMessage
        message={message}
        addMargin={addMargin}
        verbose={verbose}
        isTranscriptMode={isTranscriptMode}
      />
    )
  }
  const content = message.content
  if (typeof content !== 'string') {
    return null
  }
  return (
    <Box flexDirection="row" width="100%">
      <SystemTextMessageInner
        content={content}
        addMargin={addMargin}
        dot={'level' in message && message.level !== 'info'}
        color={'level' in message && message.level === 'warning' ? ('warning' as any) : undefined}
        dimColor={'level' in message && message.level === 'info'}
      />
    </Box>
  )
}
function StopHookSummaryMessage({
  message,
  addMargin,
  verbose,
  isTranscriptMode,
}: {
  message: SystemStopHookSummaryMessage
  addMargin: boolean
  verbose: boolean
  isTranscriptMode?: boolean
}) {
  const bg = useSelectedMessageBg()
  const { hookCount, hookInfos, hookErrors, preventedContinuation, stopReason } = message
  const { columns } = useTerminalSize()
  const totalDurationMs =
    message.totalDurationMs ?? hookInfos.reduce((sum, h) => sum + (h.durationMs ?? 0), 0)
  if (hookErrors.length === 0 && !preventedContinuation && !message.hookLabel) {
    return null
  }
  const totalStr = totalDurationMs > 0 ? ` (${formatSecondsShort(totalDurationMs)})` : ''
  if (message.hookLabel) {
    const transcriptHookItems =
      isTranscriptMode &&
      hookInfos.map((info, idx) => {
        const durationStr =
          false && info.durationMs !== undefined ? ` (${formatSecondsShort(info.durationMs)})` : ''
        return (
          <Text key={`cmd-${idx}`} dimColor={true}>
            {'     \u23BF '}
            {info.command === 'prompt' ? `prompt: ${info.command || ''}` : info.command}
            {durationStr}
          </Text>
        )
      })
    return (
      <Box flexDirection="column" width="100%">
        {
          <Text dimColor={true}>
            {'  \u23BF  '}
            {tSync('systemMessage.hookSummary', {
              count: hookCount,
              label: message.hookLabel,
              hookCount,
            })}
            {totalStr}
          </Text>
        }
        {transcriptHookItems}
      </Box>
    )
  }
  const verboseHookItems =
    verbose &&
    hookInfos.length > 0 &&
    hookInfos.map((info_0, idx_0) => {
      const durationStr_0 =
        false && info_0.durationMs !== undefined
          ? ` (${formatSecondsShort(info_0.durationMs)})`
          : ''
      return (
        <Text key={`cmd-${idx_0}`} dimColor={true}>
          ⎿ {info_0.command === 'prompt' ? `prompt: ${info_0.command || ''}` : info_0.command}
          {durationStr_0}
        </Text>
      )
    })
  const hookErrorItems =
    hookErrors.length > 0 &&
    hookErrors.map((err, idx_1) => (
      <Text key={idx_1}>
        <Text dimColor={true}>⎿ </Text>
        {tSync('systemMessage.hookError', {
          label: message.hookLabel ?? tSync('systemMessage.stopHookLabel'),
          error: err,
        })}
      </Text>
    ))
  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0} backgroundColor={bg as any} width="100%">
      {
        <Box minWidth={2}>
          <Text>{BLACK_CIRCLE}</Text>
        </Box>
      }
      {
        <Box flexDirection="column" width={columns - 10}>
          {
            <Text>
              {tSync('systemMessage.hookSummary', {
                count: hookCount,
                label: message.hookLabel ?? tSync('systemMessage.stopHookLabel'),
                hookCount,
              })}
              {totalStr}
              {!verbose && hookInfos.length > 0 && (
                <>
                  {' '}
                  <CtrlOToExpand />
                </>
              )}
            </Text>
          }
          {verboseHookItems}
          {preventedContinuation && stopReason && (
            <Text>
              <Text dimColor={true}>⎿ </Text>
              {stopReason}
            </Text>
          )}
          {hookErrorItems}
        </Box>
      }
    </Box>
  )
}
function SystemTextMessageInner({ content, addMargin, dot, color, dimColor }: any) {
  const { columns } = useTerminalSize()
  const bg = useSelectedMessageBg()
  const trimmedContent = content.trim()
  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0} backgroundColor={bg as any} width="100%">
      {dot && (
        <Box minWidth={2}>
          <Text color={color as any} dimColor={dimColor}>
            {BLACK_CIRCLE}
          </Text>
        </Box>
      )}
      {
        <Box flexDirection="column" width={columns - 10}>
          {
            <Text color={color as any} dimColor={dimColor} wrap="wrap">
              {trimmedContent}
            </Text>
          }
        </Box>
      }
    </Box>
  )
}
function TurnDurationMessage({ message, addMargin }) {
  const bg = useSelectedMessageBg()
  const [verb] = useState(
    () => sample(getTurnCompletionVerbs()) ?? tSync('systemMessage.defaultVerb'),
  )
  const store = useAppStateStore()
  const [backgroundTaskSummary] = useState(() => {
    const tasks = store.getState().tasks
    const running = (Object.values(tasks ?? {}) as TaskState[]).filter(isBackgroundTask)
    return running.length > 0 ? getPillLabel(running) : null
  })
  const showTurnDuration = getGlobalConfig().showTurnDuration ?? true
  const durationFormatter = getLocalizedDurationFormatter()
  const duration = durationFormatter(message.durationMs)
  const hasBudget = message.budgetLimit !== undefined
  let budgetSuffix
  if (!hasBudget) {
    // ... existing code ...
  }
  const verbWithDuration =
    showTurnDuration &&
    tSync('systemMessage.verbWithDuration', {
      verb,
      duration,
    })
  const backgroundTaskText =
    backgroundTaskSummary &&
    tSync('systemMessage.tasksStillRunning', {
      count: backgroundTaskSummary,
    })
  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0} backgroundColor={bg as any} width="100%">
      {
        <Box minWidth={2}>
          <Text dimColor={true}>{TEARDROP_ASTERISK}</Text>
        </Box>
      }
      {
        <Text dimColor={true}>
          {verbWithDuration}
          {budgetSuffix}
          {backgroundTaskText}
        </Text>
      }
    </Box>
  )
}
function MemorySavedMessage({
  message,
  addMargin,
}: {
  message: SystemMemorySavedMessage
  addMargin: boolean
}) {
  const bg = useSelectedMessageBg()
  const { writtenPaths } = message
  const team = feature('TEAMMEM') ? teamMemSaved.teamMemSavedPart(message) : null
  const privateCount = writtenPaths.length - (team?.count ?? 0)
  const teamSegment = team?.segment
  const parts = [
    privateCount > 0 ? `${privateCount} ${privateCount === 1 ? 'memory' : 'memories'}` : null,
    teamSegment,
  ].filter(Boolean)
  const memorySummaryText = parts.join(' · ')
  const fileRowElements = writtenPaths.map((p) => <MemoryFileRow key={p} path={p} />)
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0} backgroundColor={bg as any}>
      {
        <Box flexDirection="row">
          {
            <Box minWidth={2}>
              <Text dimColor={true}>{BLACK_CIRCLE}</Text>
            </Box>
          }
          <Text>
            {'Saved'} {memorySummaryText}
          </Text>
        </Box>
      }
      {fileRowElements}
    </Box>
  )
}
function MemoryFileRow({ path }) {
  const [hover, setHover] = useState(false)
  const fileName = basename(path)
  return (
    <MessageResponse>
      <Box
        onClick={() => void openPath(path)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {
          <Text dimColor={!hover} underline={hover}>
            {<FilePathLink filePath={path}>{fileName}</FilePathLink>}
          </Text>
        }
      </Box>
    </MessageResponse>
  )
}
function _ThinkingMessage({ message, addMargin }) {
  const bg = useSelectedMessageBg()
  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0} backgroundColor={bg as any} width="100%">
      {
        <Box minWidth={2}>
          <Text dimColor={true}>{TEARDROP_ASTERISK}</Text>
        </Box>
      }
      {<Text dimColor={true}>{message.content}</Text>}
    </Box>
  )
}
function BridgeStatusMessage({ message, addMargin }) {
  const bg = useSelectedMessageBg()
  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0} backgroundColor={bg as any} width={999}>
      {<Box minWidth={2} />}
      {
        <Box flexDirection="column">
          {
            <Text>
              <ThemedText color={'suggestion' as any}>/remote-control</ThemedText> is active. Code
              in CLI or at
            </Text>
          }
          {<Link url={message.url}>{message.url}</Link>}
          {message.upgradeNudge && <Text dimColor={true}>⎿ {message.upgradeNudge}</Text>}
        </Box>
      }
    </Box>
  )
}
