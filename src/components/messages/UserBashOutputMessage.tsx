import * as React from 'react'
import BashToolResultMessage from '../../tools/BashTool/BashToolResultMessage.js'
import { extractTag } from '../../utils/messages.js'
export function UserBashOutputMessage({
  content,
  verbose,
}: {
  content: string
  verbose?: boolean
}) {
  const rawStdout = extractTag(content, 'bash-stdout') ?? ''
  const stdout = extractTag(rawStdout, 'persisted-output') ?? rawStdout
  const stderr = extractTag(content, 'bash-stderr') ?? ''
  const ResultComponent = BashToolResultMessage as React.ComponentType<{
    content: { stdout: string; stderr: string }
    verbose: boolean
  }>
  return (
    <ResultComponent
      content={{
        stdout,
        stderr,
      }}
      verbose={!!verbose}
    />
  )
}
