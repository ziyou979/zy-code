import React from 'react'
import { tSync } from 'src/i18n/index.js'
import { Text } from 'src/ink.js'
import type { TaskStatus } from 'src/Task.js'
import type { Theme } from 'src/utils/theme.ts'

type TaskStatusTextProps = {
  status: TaskStatus
  label?: string
  suffix?: string
}

export function TaskStatusText({ status, label, suffix }: TaskStatusTextProps) {
  const displayLabel = label ?? status
  let color: keyof Theme
  switch (status) {
    case 'completed':
      color = 'success'
      break
    case 'failed':
      color = 'error'
      break
    case 'killed':
      color = 'warning'
      break
    default:
      color = undefined
  }
  return (
    <Text color={color} dimColor={true}>
      ({displayLabel}
      {suffix})
    </Text>
  )
}

type ShellProgressProps = {
  shell: { status: TaskStatus }
}

export function ShellProgress({ shell }: ShellProgressProps) {
  switch (shell.status) {
    case 'completed': {
      return <TaskStatusText status="completed" label={tSync('shellProgress.done')} />
    }
    case 'failed': {
      return <TaskStatusText status="failed" label={tSync('shellProgress.error')} />
    }
    case 'killed': {
      return <TaskStatusText status="killed" label={tSync('shellProgress.stopped')} />
    }
    case 'running':
    case 'pending': {
      return <TaskStatusText status="running" />
    }
  }
}
