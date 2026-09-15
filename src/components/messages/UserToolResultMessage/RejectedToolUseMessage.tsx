import { Text } from '../../../ink/index.js'
import { MessageResponse } from '../../MessageResponse.js'
import { tSync } from '../../../i18n/index.js'

export function RejectedToolUseMessage() {
  return (
    <MessageResponse height={1}>
      <Text dimColor={true}>{tSync('ui.rejection.rejectedTool')}</Text>
    </MessageResponse>
  )
}
