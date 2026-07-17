import * as React from 'react'
import { Markdown } from 'src/components/Markdown.js'
import { MessageResponse } from 'src/components/MessageResponse.js'
import { RejectedPlanMessage } from 'src/components/messages/UserToolResultMessage/RejectedPlanMessage.js'
import { BLACK_CIRCLE } from 'src/constants/figures.js'
import { getModeColor } from 'src/services/permissions/permissionMode.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink/index.js'
import type { ToolProgressData } from '../../tools/tool.js'
import type { ProgressMessage } from '../../types/message.js'
import { getDisplayPath } from '../../utils/file.js'
import { getPlan } from '../../services/plans/plans.js'
import type { ThemeName } from '../../utils/theme.js'
import type { Output } from './ExitPlanModeTool.js'
export function renderToolUseMessage(): React.ReactNode {
  return null
}
export function renderToolResultMessage(
  output: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  {
    theme: _theme,
  }: {
    theme: ThemeName
  },
): React.ReactNode {
  const { plan, filePath } = output
  const isEmpty = !plan || plan.trim() === ''
  const displayPath = filePath ? getDisplayPath(filePath) : ''
  const awaitingLeaderApproval = output.awaitingLeaderApproval

  // Simplified message for empty plans
  if (isEmpty) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color={getModeColor('plan')}>{BLACK_CIRCLE}</Text>
          <Text> {tSync('exitPlanMode.exitedPlanMode')}</Text>
        </Box>
      </Box>
    )
  }

  // When awaiting leader approval, show a different message
  if (awaitingLeaderApproval) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color={getModeColor('plan')}>{BLACK_CIRCLE}</Text>
          <Text> {tSync('exitPlanMode.planSubmitted')}</Text>
        </Box>
        <MessageResponse>
          <Box flexDirection="column">
            {filePath && (
              <Text dimColor>{tSync('exitPlanMode.planFile', { path: displayPath })}</Text>
            )}
            <Text dimColor>{tSync('exitPlanMode.waitingForApproval')}</Text>
          </Box>
        </MessageResponse>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={getModeColor('plan')}>{BLACK_CIRCLE}</Text>
        <Text> {tSync('exitPlanMode.userApprovedPlan')}</Text>
      </Box>
      <MessageResponse>
        <Box flexDirection="column">
          {filePath && (
            <Text dimColor>{tSync('exitPlanMode.planSavedTo', { path: displayPath })}</Text>
          )}
          <Markdown>{plan}</Markdown>
        </Box>
      </MessageResponse>
    </Box>
  )
}
export function renderToolUseRejectedMessage(
  {
    plan,
  }: {
    plan?: string
  },
  {
    theme: _theme,
  }: {
    theme: ThemeName
  },
): React.ReactNode {
  const planContent = plan ?? getPlan() ?? 'No plan found'
  return (
    <Box flexDirection="column">
      <RejectedPlanMessage plan={planContent} />
    </Box>
  )
}
