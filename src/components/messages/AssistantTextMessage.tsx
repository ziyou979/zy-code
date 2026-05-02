import type { TextBlock } from '../../types/llm.js'
import React, { useContext } from 'react'
import { ERROR_MESSAGE_USER_ABORT } from 'src/services/compact/compact.js'
import { isRateLimitErrorMessage } from 'src/services/rateLimitMessages.js'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import { Box, NoSelect, Text } from '../../ink.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  API_TIMEOUT_ERROR_MESSAGE,
  CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
  CUSTOM_OFF_SWITCH_MESSAGE,
  getInvalidApiKeyErrorMessage,
  INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL,
  ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
  ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  startsWithApiErrorPrefix,
  TOKEN_REVOKED_ERROR_MESSAGE,
} from '../../services/api/errors.js'
import { isEmptyMessageText, NO_RESPONSE_REQUESTED } from '../../utils/messages.js'
import { getUpgradeMessage } from '../../utils/model/contextWindowUpgradeCheck.js'
import { getDefaultStandardModel, renderModelName } from '../../utils/model/model.js'
import { isMacOsKeychainLocked } from '../../utils/secureStorage/macOsKeychainStorage.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { InterruptedByUser } from '../InterruptedByUser.js'
import { Markdown } from '../Markdown.js'
import { MessageResponse } from '../MessageResponse.js'
import { MessageActionsSelectedContext } from '../messageActions.js'
import { RateLimitMessage } from './RateLimitMessage.js'
const MAX_API_ERROR_CHARS = 1000
type Props = {
  param: TextBlock
  addMargin: boolean
  shouldShowDot: boolean
  verbose: boolean
  width?: number | string
  onOpenRateLimitOptions?: () => void
}
function InvalidApiKeyMessage() {
  const isKeychainLocked = isMacOsKeychainLocked()
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color="error">{getInvalidApiKeyErrorMessage()}</Text>
        {isKeychainLocked && (
          <Text dimColor={true}>· Run in another terminal: security unlock-keychain</Text>
        )}
      </Box>
    </MessageResponse>
  )
}
export function AssistantTextMessage({
  param,
  addMargin,
  shouldShowDot,
  verbose,
  onOpenRateLimitOptions,
}: Props) {
  const { text } = param
  const isSelected = useContext(MessageActionsSelectedContext)
  if (isEmptyMessageText(text)) {
    return null
  }
  if (isRateLimitErrorMessage(text)) {
    return <RateLimitMessage text={text} onOpenRateLimitOptions={onOpenRateLimitOptions} />
  }
  // 检查运行时解析的 API key 错误消息（不能是 switch case 常量）
  if (text === getInvalidApiKeyErrorMessage()) {
    return <InvalidApiKeyMessage />
  }
  if (text === INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL) {
    return (
      <MessageResponse height={1}>
        <Text color="error">{INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL}</Text>
      </MessageResponse>
    )
  }
  switch (text) {
    case NO_RESPONSE_REQUESTED: {
      return null
    }
    case PROMPT_TOO_LONG_ERROR_MESSAGE: {
      let t2
      t2 = getUpgradeMessage('warning')
      const upgradeHint = t2
      let t3
      t3 = (
        <MessageResponse height={1}>
          <Text color="error">
            Context limit reached · /compact or /clear to continue
            {upgradeHint ? ` · ${upgradeHint}` : ''}
          </Text>
        </MessageResponse>
      )
      return t3
    }
    case CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE: {
      let t2
      t2 = (
        <MessageResponse height={1}>
          <Text color="error">
            Credit balance too low · Add funds: https://platform.zy.com/settings/billing
          </Text>
        </MessageResponse>
      )
      return t2
    }
    case ORG_DISABLED_ERROR_MESSAGE_ENV_KEY:
    case ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH: {
      let t2
      t2 = (
        <MessageResponse>
          <Text color="error">{text}</Text>
        </MessageResponse>
      )
      return t2
    }
    case TOKEN_REVOKED_ERROR_MESSAGE: {
      let t2
      t2 = (
        <MessageResponse height={1}>
          <Text color="error">{TOKEN_REVOKED_ERROR_MESSAGE}</Text>
        </MessageResponse>
      )
      return t2
    }
    case API_TIMEOUT_ERROR_MESSAGE: {
      let t2
      t2 = (
        <MessageResponse height={1}>
          <Text color="error">
            {API_TIMEOUT_ERROR_MESSAGE}
            {process.env.API_TIMEOUT_MS && (
              <> (API_TIMEOUT_MS={process.env.API_TIMEOUT_MS}ms, try increasing it)</>
            )}
          </Text>
        </MessageResponse>
      )
      return t2
    }
    case CUSTOM_OFF_SWITCH_MESSAGE: {
      let t2
      t2 = <Text color="error">We are experiencing high demand for Opus 4.</Text>
      let t3
      t3 = (
        <MessageResponse>
          <Box flexDirection="column" gap={1}>
            {t2}
            <Text>
              To continue immediately, use /model to switch to{' '}
              {renderModelName(getDefaultStandardModel())} and continue coding.
            </Text>
          </Box>
        </MessageResponse>
      )
      return t3
    }
    case ERROR_MESSAGE_USER_ABORT: {
      let t2
      t2 = (
        <MessageResponse height={1}>
          <InterruptedByUser />
        </MessageResponse>
      )
      return t2
    }
    default: {
      if (startsWithApiErrorPrefix(text)) {
        const truncated = !verbose && text.length > MAX_API_ERROR_CHARS
        const t2 =
          text === API_ERROR_MESSAGE_PREFIX
            ? `${API_ERROR_MESSAGE_PREFIX}: Please wait a moment and try again.`
            : truncated
              ? text.slice(0, MAX_API_ERROR_CHARS) + '\u2026'
              : text
        let t3
        t3 = <Text color="error">{t2}</Text>
        let t4
        t4 = truncated && <CtrlOToExpand />
        let t5
        t5 = (
          <MessageResponse>
            <Box flexDirection="column">
              {t3}
              {t4}
            </Box>
          </MessageResponse>
        )
        return t5
      }
      const t2 = addMargin ? 1 : 0
      const t3 = isSelected ? 'messageActionsBackground' : undefined
      let t4
      t4 = shouldShowDot && (
        <NoSelect fromLeftEdge={true} minWidth={2}>
          <Text color={isSelected ? 'suggestion' : 'text'}>{BLACK_CIRCLE}</Text>
        </NoSelect>
      )
      let t5
      t5 = (
        <Box flexDirection="column">
          <Markdown>{text}</Markdown>
        </Box>
      )
      let t6
      t6 = (
        <Box flexDirection="row">
          {t4}
          {t5}
        </Box>
      )
      let t7
      t7 = (
        <Box
          alignItems="flex-start"
          flexDirection="row"
          justifyContent="space-between"
          marginTop={t2}
          width="100%"
          backgroundColor={t3}
        >
          {t6}
        </Box>
      )
      return t7
    }
  }
}
