import type React from 'react'
import { removeSandboxViolationTags } from 'src/services/sandbox/sandbox-ui-utils.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { OutputLine } from '../../components/shell/OutputLine.js'
import { ShellTimeDisplay } from '../../components/shell/ShellTimeDisplay.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import type { Out as BashOut } from './BashTool.js'

type Props = {
  content: Omit<BashOut, 'interrupted'>
  verbose: boolean
  timeoutMs?: number
}

// 匹配 "Shell cwd was reset to <path>" 消息的模式
// 使用 (?:^|\n) 匹配字符串开头或换行后的位置
const SHELL_CWD_RESET_PATTERN = /(?:^|\n)(Shell cwd was reset to .+)$/

/**
 * 从 stderr 中提取沙箱违规信息（如果存在）
 * 返回清理后的 stderr 和违规内容
 */
function extractSandboxViolations(stderr: string): {
  cleanedStderr: string
} {
  const violationsMatch = stderr.match(/<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/)
  if (!violationsMatch) {
    return {
      cleanedStderr: stderr,
    }
  }

  // 从 stderr 中移除沙箱违规部分
  const cleanedStderr = removeSandboxViolationTags(stderr).trim()
  return {
    cleanedStderr,
  }
}

/**
 * 从 stderr 中提取 "Shell cwd was reset" 警告消息
 * 返回清理后的 stderr 和警告消息
 */
function extractCwdResetWarning(stderr: string): {
  cleanedStderr: string
  cwdResetWarning: string | null
} {
  const match = stderr.match(SHELL_CWD_RESET_PATTERN)
  if (!match) {
    return {
      cleanedStderr: stderr,
      cwdResetWarning: null,
    }
  }

  // 从捕获组 1 中提取警告消息
  const cwdResetWarning = match[1] ?? null
  // 从 stderr 中移除此警告（替换完整匹配）
  const cleanedStderr = stderr.replace(SHELL_CWD_RESET_PATTERN, '').trim()
  return {
    cleanedStderr,
    cwdResetWarning,
  }
}
export default function BashToolResultMessage({ content, verbose, timeoutMs }: Props) {
  const {
    stdout: rawStdout,
    stderr: rawStderr,
    isImage,
    returnCodeInterpretation,
    noOutputExpected,
    backgroundTaskId,
  } = content
  const stdout = rawStdout === undefined ? '' : rawStdout
  const stdErrWithViolations = rawStderr === undefined ? '' : rawStderr
  let BoxComponent!: typeof Box

  let outputLineElement
  let earlyReturn: React.ReactNode | symbol = Symbol.for('react.early_return_sentinel')
  const { cleanedStderr: stderrWithoutViolations } = extractSandboxViolations(stdErrWithViolations)
  let stderr: string
  let cwdResetWarning: string | null
  ;({ cleanedStderr: stderr, cwdResetWarning } = extractCwdResetWarning(stderrWithoutViolations))
  let outputLineElement2
  if (isImage) {
    earlyReturn = (
      <MessageResponse height={1}>
        <Text dimColor={true}>{tSync('bash.imageDetected')}</Text>
      </MessageResponse>
    )
  } else {
    BoxComponent = Box

    outputLineElement2 = (
      stdout.trim() !== '' ? <OutputLine content={stdout} verbose={verbose} /> : null
    ) as React.ReactNode
    outputLineElement =
      stderr.trim() !== '' ? <OutputLine content={stderr} verbose={verbose} isError={true} /> : null
  }
  if (earlyReturn !== Symbol.for('react.early_return_sentinel')) {
    return earlyReturn as React.ReactNode
  }
  // 当预期无输出且确实没有输出时，不展示 ⎿ 行
  const isEffectivelyEmpty = stdout.trim() === '' && stderr.trim() === '' && !cwdResetWarning
  const shouldHideEmptyResponse = noOutputExpected && !returnCodeInterpretation && !backgroundTaskId
  const messageResponseElement = isEffectivelyEmpty ? (
    shouldHideEmptyResponse ? null : (
      <MessageResponse height={1}>
        <Text dimColor={true}>
          {backgroundTaskId ? (
            <>
              {tSync('bash.runningInBackground')}{' '}
              <KeyboardShortcutHint shortcut={'\u2193'} action="manage" parens={true} />
            </>
          ) : (
            returnCodeInterpretation || tSync('bash.noOutput')
          )}
        </Text>
      </MessageResponse>
    )
  ) : null
  // 所有子元素为 null 时直接返回 null，避免空 Box 占据空间
  const hasCwdWarning = !!cwdResetWarning
  const hasTimeout = !!timeoutMs
  if (
    !outputLineElement2 &&
    !outputLineElement &&
    !hasCwdWarning &&
    !messageResponseElement &&
    !hasTimeout
  ) {
    return null
  }
  return (
    <BoxComponent flexDirection={'column'}>
      {outputLineElement2}
      {outputLineElement}
      {hasCwdWarning ? (
        <MessageResponse>
          <Text dimColor={true}>{cwdResetWarning}</Text>
        </MessageResponse>
      ) : null}
      {messageResponseElement}
      {hasTimeout && (
        <MessageResponse>
          <ShellTimeDisplay timeoutMs={timeoutMs} />
        </MessageResponse>
      )}
    </BoxComponent>
  )
}
