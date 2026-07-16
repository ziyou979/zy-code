import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { tSync } from '../../i18n/index.js'
import { Text } from '../../ink/index.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { Input, Output } from './ConfigTool.js'
export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  if (!input.setting) {
    return null
  }
  if (input.value === undefined) {
    return <Text dimColor>{tSync('toolConfig.getting', { setting: input.setting })}</Text>
  }
  return (
    <Text dimColor>
      {tSync('toolConfig.settingTo', { setting: input.setting, value: jsonStringify(input.value) })}
    </Text>
  )
}
export function renderToolResultMessage(content: Output): React.ReactNode {
  if (!content.success) {
    return (
      <MessageResponse>
        <Text color="error">{tSync('toolConfig.failed', { error: content.error ?? '' })}</Text>
      </MessageResponse>
    )
  }
  if (content.operation === 'get') {
    return (
      <MessageResponse>
        <Text>
          <Text bold>{content.setting}</Text> = {jsonStringify(content.value)}
        </Text>
      </MessageResponse>
    )
  }
  return (
    <MessageResponse>
      <Text>
        {tSync('toolConfig.setValue', {
          setting: content.setting ?? '',
          value: jsonStringify(content.newValue),
        })}
      </Text>
    </MessageResponse>
  )
}
export function renderToolUseRejectedMessage(): React.ReactNode {
  return <Text color="warning">{tSync('toolConfig.changeRejected')}</Text>
}
