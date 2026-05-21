import * as React from 'react'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import {
  isShutdownApproved,
  isShutdownRejected,
  isShutdownRequest,
  type ShutdownRejectedMessage,
  type ShutdownRequestMessage,
} from '../../utils/teammateMailbox.js'

type ShutdownRequestProps = {
  request: ShutdownRequestMessage
}

/**
 * Renders a shutdown request with a warning-colored border.
 */
export function ShutdownRequestDisplay({ request }: ShutdownRequestProps) {
  return (
    <Box flexDirection="column" marginY={1}>
      <Box
        borderStyle="round"
        borderColor="warning"
        flexDirection="column"
        paddingX={1}
        paddingY={1}
      >
        {
          <Box marginBottom={1}>
            <Text color="warning" bold={true}>
              {tSync('shutdown.request', {
                from: request.from,
              })}
            </Text>
          </Box>
        }
        {request.reason && (
          <Box>
            <Text>
              {tSync('shutdown.reason', {
                reason: request.reason,
              })}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}
type ShutdownRejectedProps = {
  response: ShutdownRejectedMessage
}

/**
 * Renders a shutdown rejected message with a subtle (grey) border.
 */
export function ShutdownRejectedDisplay({ response }: ShutdownRejectedProps) {
  return (
    <Box flexDirection="column" marginY={1}>
      <Box
        borderStyle="round"
        borderColor="subtle"
        flexDirection="column"
        paddingX={1}
        paddingY={1}
      >
        {
          <Text color="subtle" bold={true}>
            {tSync('shutdown.rejected', {
              from: response.from,
            })}
          </Text>
        }
        {
          <Box
            marginTop={1}
            borderStyle="dashed"
            borderColor="subtle"
            borderLeft={false}
            borderRight={false}
            paddingX={1}
          >
            <Text>
              {tSync('shutdown.reason', {
                reason: response.reason,
              })}
            </Text>
          </Box>
        }
        {
          <Box marginTop={1}>
            <Text dimColor={true}>{tSync('shutdown.teammateContinuing')}</Text>
          </Box>
        }
      </Box>
    </Box>
  )
}

/**
 * Try to parse and render a shutdown message from raw content.
 * Returns the rendered component if it's a shutdown message, null otherwise.
 */
export function tryRenderShutdownMessage(content: string): React.ReactNode | null {
  const request = isShutdownRequest(content)
  if (request) {
    return <ShutdownRequestDisplay request={request} />
  }

  // Shutdown approved is handled inline by the caller — skip it here
  if (isShutdownApproved(content)) {
    return null
  }
  const rejected = isShutdownRejected(content)
  if (rejected) {
    return <ShutdownRejectedDisplay response={rejected} />
  }
  return null
}

/**
 * Get a brief summary text for a shutdown message.
 * Used in places like the inbox queue where we want a short description.
 * Returns null if the content is not a shutdown message.
 */
export function getShutdownMessageSummary(content: string): string | null {
  const request = isShutdownRequest(content)
  if (request) {
    return `${tSync('shutdown.summaryRequest', {
      from: request.from,
    })}${request.reason ? ` ${request.reason}` : ''}`
  }
  const approved = isShutdownApproved(content)
  if (approved) {
    return `${tSync('shutdown.summaryApproved', {
      from: approved.from,
    })}`
  }
  const rejected = isShutdownRejected(content)
  if (rejected) {
    return `${tSync('shutdown.summaryRejected', {
      from: rejected.from,
      reason: rejected.reason,
    })}`
  }
  return null
}
