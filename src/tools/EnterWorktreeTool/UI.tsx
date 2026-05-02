import * as React from 'react'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import type { ToolProgressData } from '../../Tool.js'
import type { ProgressMessage } from '../../types/message.js'
import type { ThemeName } from '../../utils/theme.js'
import type { Output } from './EnterWorktreeTool.js'
export function renderToolUseMessage(): React.ReactNode {
  return tSync('toolEnterWorktree.creating')
}
export function renderToolResultMessage(
  output: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  _options: {
    theme: ThemeName
  },
): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text>{tSync('toolEnterWorktree.switched', { branch: output.worktreeBranch })}</Text>
      <Text dimColor>{output.worktreePath}</Text>
    </Box>
  )
}
