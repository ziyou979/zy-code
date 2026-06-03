import type { DeepImmutable } from 'src/types/utils.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { DreamTaskState } from '../../tasks/DreamTask/DreamTask.js'
import { plural } from '../../utils/stringUtils.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

type Props = {
  task: DeepImmutable<DreamTaskState>
  onDone: () => void
  onBack?: () => void
  onKill?: () => void
}

// How many recent turns to render. Earlier turns collapse to a count.
const VISIBLE_TURNS = 6
export function DreamDetailDialog({ task, onDone, onBack, onKill }: Props) {
  const elapsedTime = useElapsedTime(task.startTime, task.status === 'running', 1000, 0)
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
        if (e.key === 'x' && task.status === 'running' && onKill) {
          e.preventDefault()
          onKill()
        }
      }
    }
  }
  const visibleTurns = task.turns.filter((t) => t.text !== '')
  const shown = visibleTurns.slice(-VISIBLE_TURNS)
  const hidden = visibleTurns.length - shown.length
  const sessionsReviewingCount = task.sessionsReviewing
  const sessionsReviewingLabel = plural(task.sessionsReviewing, 'session')
  const dialogContent = (
    <Box flexDirection={'column'} gap={1}>
      {
        <Text>
          {<Text bold={true}>{tSync('backgroundTasks.status')}:</Text>}{' '}
          {task.status === 'running' ? (
            <Text color="background">{tSync('backgroundTasks.running')}</Text>
          ) : task.status === 'completed' ? (
            <Text color="success">{task.status}</Text>
          ) : (
            <Text color="error">{task.status}</Text>
          )}
        </Text>
      }
      {shown.length === 0 ? (
        <Text dimColor={true}>
          {task.status === 'running'
            ? tSync('backgroundTasks.starting')
            : tSync('backgroundTasks.noTextOutput')}
        </Text>
      ) : (
        <>
          {hidden > 0 && (
            <Text dimColor={true}>
              ({hidden} {tSync('backgroundTasks.earlierTurns', { count: hidden })})
            </Text>
          )}
          {shown.map((turn, i) => (
            <Box key={i} flexDirection="column">
              <Text wrap="wrap">{turn.text}</Text>
              {turn.toolUseCount > 0 && (
                <Text dimColor={true}>
                  {'  '}({turn.toolUseCount} {plural(turn.toolUseCount, 'tool')})
                </Text>
              )}
            </Box>
          ))}
        </>
      )}
    </Box>
  )
  return (
    <Box flexDirection={'column'} tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>
      {
        <Dialog
          title={tSync('backgroundTasks.memoryConsolidation')}
          subtitle={
            <Text dimColor={true}>
              {elapsedTime} ·{' '}
              {tSync('backgroundTasks.reviewing', {
                count: sessionsReviewingCount,
                unit: sessionsReviewingLabel,
              })}
              {task.filesTouched.length > 0 && (
                <>
                  {' '}
                  · {task.filesTouched.length} {plural(task.filesTouched.length, 'file')}{' '}
                  {tSync('backgroundTasks.touched')}
                </>
              )}
            </Text>
          }
          onCancel={onDone}
          color={'background'}
          inputGuide={(exitState) =>
            exitState.pending ? (
              <Text>Press {exitState.keyName} again to exit</Text>
            ) : (
              <Byline>
                {onBack && <KeyboardShortcutHint shortcut={'←'} action="go back" />}
                <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
                {task.status === 'running' && onKill && (
                  <KeyboardShortcutHint shortcut="x" action="stop" />
                )}
              </Byline>
            )
          }
        >
          {dialogContent}
        </Dialog>
      }
    </Box>
  )
}
