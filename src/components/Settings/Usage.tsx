import type * as React from 'react'
import { Box, Text } from '../../ink/index.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { SessionCost } from './SessionCost.js'

/**
 * 设置面板的 Usage 页签：只展示本地统计的会话成本。
 *
 * 上游还会向 Anthropic 后端 `/api/oauth/usage` 拉取订阅额度与限流利用率；ZY Code
 * 已移除该后端调用，因此不再显示订阅额度条。
 */
export function Usage(): React.ReactNode {
  return (
    <Box flexDirection="column" gap={1} width="100%">
      <SessionCost />
      <Text dimColor>
        <ConfigurableShortcutHint
          action="confirm:no"
          context="Settings"
          fallback="Esc"
          description="cancel"
        />
      </Text>
    </Box>
  )
}
