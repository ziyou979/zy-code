import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { tSync } from '../../i18n/index.js'
import { Text } from '../../ink.js'
import { truncate } from '../../utils/format.js'
import type { CreateOutput } from './cronCreateTool.js'
import type { DeleteOutput } from './cronDeleteTool.js'
import type { ListOutput } from './cronListTool.js'

// --- CronCreate -------------------------------------------------------------

export function renderCreateToolUseMessage(
  input: Partial<{
    cron: string
    prompt: string
  }>,
): React.ReactNode {
  return `${input.cron ?? ''}${input.prompt ? `: ${truncate(input.prompt, 60, true)}` : ''}`
}
export function renderCreateResultMessage(output: CreateOutput): React.ReactNode {
  return (
    <MessageResponse>
      <Text>
        {tSync('toolScheduleCron.scheduled')} <Text bold>{output.id}</Text>{' '}
        <Text dimColor>({output.humanSchedule})</Text>
      </Text>
    </MessageResponse>
  )
}

// --- CronDelete -------------------------------------------------------------

export function renderDeleteToolUseMessage(
  input: Partial<{
    id: string
  }>,
): React.ReactNode {
  return input.id ?? ''
}
export function renderDeleteResultMessage(output: DeleteOutput): React.ReactNode {
  return (
    <MessageResponse>
      <Text>
        {tSync('toolScheduleCron.cancelled')} <Text bold>{output.id}</Text>
      </Text>
    </MessageResponse>
  )
}

// --- CronList ---------------------------------------------------------------

export function renderListToolUseMessage(): React.ReactNode {
  return ''
}
export function renderListResultMessage(output: ListOutput): React.ReactNode {
  if (output.jobs.length === 0) {
    return (
      <MessageResponse>
        <Text dimColor>{tSync('toolScheduleCron.noJobs')}</Text>
      </MessageResponse>
    )
  }
  return (
    <MessageResponse>
      {output.jobs.map((j) => (
        <Text key={j.id}>
          <Text bold>{j.id}</Text> <Text dimColor>{j.humanSchedule}</Text>
        </Text>
      ))}
    </MessageResponse>
  )
}

// --- Shared -----------------------------------------------------------------
