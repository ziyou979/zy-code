import * as React from 'react'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink/index.js'
import type { ToolProgressData } from '../../tools/Tool.js'
import type { ProgressMessage } from '../../types/message.js'
import type { ThemeName } from '../../utils/theme.js'
import type { Output } from './ExitWorktreeTool.js'
export function renderToolUseMessage(): React.ReactNode {
  return tSync('exitWorktree.exiting')
}
export function renderToolResultMessage(
  output: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  _options: {
    theme: ThemeName
  },
): React.ReactNode {
  const actionLabel =
    output.action === 'keep'
      ? tSync('exitWorktree.keptWorktree')
      : tSync('exitWorktree.removedWorktree')
  return (
    <Box flexDirection="column">
      <Text>
        {actionLabel}
        {output.worktreeBranch ? (
          <>
            {' '}
            ({tSync('exitWorktree.branch')} <Text bold>{output.worktreeBranch}</Text>)
          </>
        ) : null}
      </Text>
      <Text dimColor>
        {tSync('exitWorktree.returnedTo')} {output.originalCwd}
      </Text>
    </Box>
  )
}
