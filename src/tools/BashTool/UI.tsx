import * as React from 'react'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ShellProgressMessage } from '../../components/shell/ShellProgressMessage.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink/index.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { useAppStateStore, useSetAppState } from '../../state/AppState.js'
import type { Tool } from '../../tools/tool.js'
import { backgroundAll } from '../../tasks/local-shell-task/LocalShellTask.js'
import type { ToolResultBlock } from '../../types/llm.js'
import type { ProgressMessage } from '../../types/message.js'
import { env } from '../../services/environment/env.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getDisplayPath } from '../../utils/file.js'
import { isFullscreenEnvEnabled } from '../../services/terminal/fullscreen.js'
import type { ThemeName } from '../../utils/theme.js'
import type { BashProgress, BashToolInput, Out } from './BashTool.js'
import BashToolResultMessage from './BashToolResultMessage.js'
import { extractBashCommentLabel } from './commentLabel.js'
import { parseSedEditCommand } from './sedEditParser.js'

// 命令显示常量
const MAX_COMMAND_DISPLAY_LINES = 2
const MAX_COMMAND_DISPLAY_CHARS = 160

// 显示后台提示并处理 ctrl+b 的简单组件
// 按下 ctrl+b 时，将所有运行中的前台命令置于后台
export function BackgroundHint(props: { onBackground?: () => void } | undefined) {
  const { onBackground } = props === undefined ? {} : props
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const handleBackground = () => {
    backgroundAll(() => store.getState(), setAppState)
    onBackground?.()
  }
  useKeybinding('task:background', handleBackground, {
    context: 'Task',
  })
  const baseShortcut = useShortcutDisplay('task:background', 'Task', 'ctrl+b')
  const shortcut =
    env.terminal === 'tmux' && baseShortcut === 'ctrl+b' ? 'ctrl+b ctrl+b (twice)' : baseShortcut
  if (isEnvTruthy(process.env.ZY_CODE_DISABLE_BACKGROUND_TASKS)) {
    return null
  }
  return (
    <Box paddingLeft={5}>
      <Text dimColor={true}>
        <KeyboardShortcutHint shortcut={shortcut} action="run in background" parens={true} />
      </Text>
    </Box>
  )
}
export function renderToolUseMessage(
  input: Partial<BashToolInput>,
  {
    verbose,
    theme: _theme,
  }: {
    verbose: boolean
    theme: ThemeName
  },
): React.ReactNode {
  const { command } = input
  if (!command) {
    return null
  }

  // 像文件编辑一样渲染 sed 原地编辑（仅显示文件路径）
  const sedInfo = parseSedEditCommand(command)
  if (sedInfo) {
    return verbose ? sedInfo.filePath : getDisplayPath(sedInfo.filePath)
  }
  if (!verbose) {
    const lines = command.split('\n')
    if (isFullscreenEnvEnabled()) {
      const label = extractBashCommentLabel(command)
      if (label) {
        return label.length > MAX_COMMAND_DISPLAY_CHARS
          ? `${label.slice(0, MAX_COMMAND_DISPLAY_CHARS)}…`
          : label
      }
    }
    const needsLineTruncation = lines.length > MAX_COMMAND_DISPLAY_LINES
    const needsCharTruncation = command.length > MAX_COMMAND_DISPLAY_CHARS
    if (needsLineTruncation || needsCharTruncation) {
      let truncated = command

      // 如果需要，先按行截断
      if (needsLineTruncation) {
        truncated = lines.slice(0, MAX_COMMAND_DISPLAY_LINES).join('\n')
      }

      // 如果仍然太长，再按字符截断
      if (truncated.length > MAX_COMMAND_DISPLAY_CHARS) {
        truncated = truncated.slice(0, MAX_COMMAND_DISPLAY_CHARS)
      }
      return <Text>{truncated.trim()}…</Text>
    }
  }
  return command
}
export function renderToolUseProgressMessage(
  progressMessagesForMessage: ProgressMessage<BashProgress>[],
  {
    verbose,
    tools: _tools,
    terminalSize: _terminalSize,
    inProgressToolCallCount: _inProgressToolCallCount,
  }: {
    tools: Tool[]
    verbose: boolean
    terminalSize?: {
      columns: number
      rows: number
    }
    inProgressToolCallCount?: number
  },
): React.ReactNode {
  const lastProgress = progressMessagesForMessage.at(-1)
  if (!lastProgress?.data) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>{tSync('bash.running')}</Text>
      </MessageResponse>
    )
  }
  const data = lastProgress.data
  return (
    <ShellProgressMessage
      fullOutput={data.fullOutput}
      output={data.output}
      elapsedTimeSeconds={data.elapsedTimeSeconds}
      totalLines={data.totalLines}
      totalBytes={data.totalBytes}
      timeoutMs={data.timeoutMs}
      taskId={data.taskId}
      verbose={verbose}
    />
  )
}
export function renderToolUseQueuedMessage(): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Text dimColor>{tSync('bash.waiting')}</Text>
    </MessageResponse>
  )
}
export function renderToolResultMessage(
  content: Out,
  progressMessagesForMessage: ProgressMessage<BashProgress>[],
  {
    verbose,
    theme: _theme,
    tools: _tools,
    style: _style,
  }: {
    verbose: boolean
    theme: ThemeName
    tools: Tool[]
    style?: 'condensed'
  },
): React.ReactNode {
  const lastProgress = progressMessagesForMessage.at(-1)
  const timeoutMs = lastProgress?.data?.timeoutMs
  return <BashToolResultMessage content={content} verbose={verbose} timeoutMs={timeoutMs} />
}
export function renderToolUseErrorMessage(
  result: ToolResultBlock['content'],
  {
    verbose,
    progressMessagesForMessage: _progressMessagesForMessage,
    tools: _tools,
  }: {
    verbose: boolean
    progressMessagesForMessage: ProgressMessage<BashProgress>[]
    tools: Tool[]
  },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
