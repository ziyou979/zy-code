import * as React from 'react'
import type { z } from 'zod/v4'
import { MessageResponse } from '../../components/MessageResponse.js'
import { OutputLine } from '../../components/shell/OutputLine.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink/index.js'
import type { ToolProgressData } from '../../tools/Tool.js'
import type { ProgressMessage } from '../../types/message.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { inputSchema, Output } from './ReadMcpResourceTool.js'
export function renderToolUseMessage(
  input: Partial<z.infer<ReturnType<typeof inputSchema>>>,
): React.ReactNode {
  if (!input.uri || !input.server) {
    return null
  }
  return tSync('readMcpResource.readFromServer', { uri: input.uri, server: input.server })
}
export function userFacingName(): string {
  return 'readMcpResource'
}
export function renderToolResultMessage(
  output: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode {
  if (!output?.contents || output.contents.length === 0) {
    return (
      <Box justifyContent="space-between" overflowX="hidden" width="100%">
        <MessageResponse height={1}>
          <Text dimColor>{tSync('readMcpResource.noContent')}</Text>
        </MessageResponse>
      </Box>
    )
  }

  // 格式化为 JSON 以提高可读性
  // eslint-disable-next-line no-restricted-syntax -- human-facing UI, not tool_result
  const formattedOutput = jsonStringify(output, null, 2)
  return <OutputLine content={formattedOutput} verbose={verbose} />
}
