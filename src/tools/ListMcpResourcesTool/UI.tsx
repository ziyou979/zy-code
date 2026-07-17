import * as React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { OutputLine } from '../../components/shell/OutputLine.js'
import { tSync } from '../../i18n/index.js'
import { Text } from '../../ink/index.js'
import type { ToolProgressData } from '../../tools/tool.js'
import type { ProgressMessage } from '../../types/message.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { Output } from './ListMcpResourcesTool.js'
export function renderToolUseMessage(
  input: Partial<{
    server?: string
  }>,
): React.ReactNode {
  return input.server
    ? tSync('listMcpResources.listFromServer', { server: input.server })
    : tSync('listMcpResources.listAll')
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
  if (!output || output.length === 0) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>{tSync('listMcpResources.noResourcesFound')}</Text>
      </MessageResponse>
    )
  }

  // eslint-disable-next-line no-restricted-syntax -- human-facing UI, not tool_result
  const formattedOutput = jsonStringify(output, null, 2)
  return <OutputLine content={formattedOutput} verbose={verbose} />
}
