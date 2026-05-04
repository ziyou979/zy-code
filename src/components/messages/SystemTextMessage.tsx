// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { Box, Text } from '../../ink.js'
import { feature } from 'bun:bundle'
import * as React from 'react'
import { useState } from 'react'
import sample from 'lodash-es/sample.js'
import { BLACK_CIRCLE, REFERENCE_MARK, TEARDROP_ASTERISK } from '../../constants/figures.js'
import figures from 'figures'
import { basename } from 'path'
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
import type { SystemMessage, SystemStopHookSummaryMessage, SystemMemorySavedMessage } from '../../types/message.js'
import { SystemAPIErrorMessage } from './SystemAPIErrorMessage.js'
import { formatDuration, formatNumber, formatSecondsShort } from '../../utils/format.js'
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
  if (message.subtype === 'turn_duration') {
    return <TurnDurationMessage message={message} addMargin={addMargin} />
  }
  if (message.subtype === 'memory_saved') {
    return <MemorySavedMessage message={message} addMargin={addMargin} />
  }
  if (message.subtype === 'away_summary') {
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
  if (message.subtype === 'agents_killed') {
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
  if (message.subtype === 'thinking') {
    return null
  }
  if (message.subtype === 'bridge_status') {
    return <BridgeStatusMessage message={message} addMargin={addMargin} />
  }
  if (message.subtype === 'scheduled_task_fire') {
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
  if (message.subtype === 'permission_retry') {
    const t4 = message.commands.join(', ')
    return (
      <Box marginTop={addMargin ? 1 : 0} backgroundColor={bg as any} width="100%">
        {<Text dimColor={true}>{TEARDROP_ASTERISK} </Text>}
        {<Text>Allowed </Text>}
        {<Text bold={true}>{t4}</Text>}
      </Box>
    )
  }
  const isStopHookSummary = message.subtype === 'stop_hook_summary'
  if (!isStopHookSummary && !verbose && message.level === 'info') {
    return null
  }
  if (message.subtype === 'api_error') {
    return <SystemAPIErrorMessage message={message} verbose={verbose} />
  }
  if (message.subtype === 'stop_hook_summary') {
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
        dot={message.level !== 'info'}
        color={message.level === 'warning' ? ('warning' as any) : undefined}
        dimColor={message.level === 'info'}
      />
    </Box>
  )
}
function StopHookSummaryMessage({ message, addMargin, verbose, isTranscriptMode }: {
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
  const totalStr = ''
  if (message.hookLabel) {
    const t5 =
      isTranscriptMode &&
      hookInfos.map((info, idx) => {
        const durationStr =
          false && info.durationMs !== undefined ? ` (${formatSecondsShort(info.durationMs)})` : ''
        return (
          <Text key={`cmd-${idx}`} dimColor={true}>
            {'     \u23BF '}
            {info.command === 'prompt' ? `prompt: ${info.promptText || ''}` : info.command}
            {durationStr}
          </Text>
        )
      })
    return (
      <Box flexDirection="column" width="100%">
        {
          <Text dimColor={true}>
            {'  \u23BF  '}Ran {hookCount} {message.hookLabel}{' '}
            {hookCount === 1 ? 'hook' : 'hooks'}
            {totalStr}
          </Text>
        }
        {t5}
      </Box>
    )
  }
  const t11 =
    verbose &&
    hookInfos.length > 0 &&
    hookInfos.map((info_0, idx_0) => {
      const durationStr_0 =
        false && info_0.durationMs !== undefined
          ? ` (${formatSecondsShort(info_0.durationMs)})`
          : ''
      return (
        <Text key={`cmd-${idx_0}`} dimColor={true}>
          ⎿ {info_0.command === 'prompt' ? `prompt: ${info_0.promptText || ''}` : info_0.command}
          {durationStr_0}
        </Text>
      )
    })
  const t13 =
    hookErrors.length > 0 &&
    hookErrors.map((err, idx_1) => (
      <Text key={idx_1}>
        <Text dimColor={true}>⎿ </Text>
        {message.hookLabel ?? 'Stop'} hook error: {err}
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
              Ran {<Text bold={true}>{hookCount}</Text>} {message.hookLabel ?? 'stop'}{' '}
              {hookCount === 1 ? 'hook' : 'hooks'}
              {totalStr}
              {!verbose && hookInfos.length > 0 && (
                <>
                  {' '}
                  <CtrlOToExpand />
                </>
              )}
            </Text>
          }
          {t11}
          {preventedContinuation && stopReason && (
            <Text>
              <Text dimColor={true}>⎿ </Text>
              {stopReason}
            </Text>
          )}
          {t13}
        </Box>
      }
    </Box>
  )
}
function SystemTextMessageInner({ content, addMargin, dot, color, dimColor }: any) {
  const { columns } = useTerminalSize()
  const bg = useSelectedMessageBg()
  const t4 = content.trim()
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
              {t4}
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
  const duration = formatDuration(message.durationMs)
  const hasBudget = message.budgetLimit !== undefined
  let budgetSuffix
  if (!hasBudget) {
    // ... existing code ...
  }
  const t7 =
    showTurnDuration &&
    tSync('systemMessage.verbWithDuration', {
      verb,
      duration,
    })
  const t8 =
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
          {t7}
          {budgetSuffix}
          {t8}
        </Text>
      }
    </Box>
  )
}
function MemorySavedMessage({ message, addMargin }: {
  message: SystemMemorySavedMessage
  addMargin: boolean
}) {
  const bg = useSelectedMessageBg()
  const { writtenPaths } = message
  const team = feature('TEAMMEM') ? teamMemSaved.teamMemSavedPartmessage : null
  const privateCount = writtenPaths.length - (team?.count ?? 0)
  const t3 = team?.segment
  const parts = [
    privateCount > 0 ? `${privateCount} ${privateCount === 1 ? 'memory' : 'memories'}` : null,
    t3,
  ].filter(Boolean)
  const t8 = parts.join(' · ')
  const t10 = writtenPaths.map((p) => <MemoryFileRow key={p} path={p} />)
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
            {message.verb ?? 'Saved'} {t8}
          </Text>
        </Box>
      }
      {t10}
    </Box>
  )
}
function MemoryFileRow({ path }) {
  const [hover, setHover] = useState(false)
  const t5 = basename(path)
  return (
    <MessageResponse>
      <Box
        onClick={() => void openPath(path)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {
          <Text dimColor={!hover} underline={hover}>
            {<FilePathLink filePath={path}>{t5}</FilePathLink>}
          </Text>
        }
      </Box>
    </MessageResponse>
  )
}
function ThinkingMessage({ message, addMargin }) {
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
          {message.upgradeNudge && (
            <Text dimColor={true}>⎿ {message.upgradeNudge}</Text>
          )}
        </Box>
      }
    </Box>
  )
}
