import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from '../ink/index.js'

type AssistantSession = { id: string; name: string }

type Props = {
  sessions: AssistantSession[]
  onSelect: (id: string) => void
  onCancel: () => void
}

/**
 * 会话选择器 — 在 assistant mode resume 时选择要恢复的会话。
 * 显示会话列表，方向键/数字选择，Enter 确认，Escape 取消。
 */
export function AssistantSessionChooser({
  sessions,
  onSelect,
  onCancel,
}: Props): React.ReactElement {
  const [selected, setSelected] = useState(0)
  const safeSelected = Math.min(selected, Math.max(0, sessions.length - 1))

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    if (key.return) {
      const s = sessions[safeSelected]
      if (s) {
        onSelect(s.id)
      }
      return
    }
    if (key.upArrow) {
      setSelected((p) => Math.max(0, p - 1))
    } else if (key.downArrow) {
      setSelected((p) => Math.min(sessions.length - 1, p + 1))
    }
  })

  // 若无会话直接取消
  useEffect(() => {
    if (sessions.length === 0) {
      onCancel()
    }
  }, [sessions.length, onCancel])

  if (sessions.length === 0) {
    return <Text>No sessions available.</Text>
  }

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold>Select a session to resume:</Text>
      {sessions.map((s, i) => (
        <Text key={s.id} color={i === safeSelected ? 'ansi:cyan' : undefined}>
          {i === safeSelected ? '> ' : '  '}
          {s.name || s.id}
        </Text>
      ))}
      <Text dimColor>↑↓ to choose · Enter to select · Esc to cancel</Text>
    </Box>
  )
}
