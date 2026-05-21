import { readFileSync } from 'node:fs'
import codeExcerpt, { type CodeExcerpt } from 'code-excerpt'
import StackUtils from 'stack-utils'
import Box from './Box.js'
import Text from './Text.js'

/* eslint-disable custom-rules/no-process-cwd -- stack trace file:// paths are relative to the real OS cwd, not the virtual cwd */

// Error 的源文件报告为 file:///home/user/file.js
// 此函数移除 file://[cwd] 部分
const cleanupPath = (path: string | undefined): string | undefined => {
  return path?.replace(`file://${process.cwd()}/`, '')
}
let stackUtils: StackUtils | undefined
function getStackUtils(): StackUtils {
  return (stackUtils ??= new StackUtils({
    cwd: process.cwd(),
    internals: StackUtils.nodeInternals(),
  }))
}

/* eslint-enable custom-rules/no-process-cwd */

type Props = {
  readonly error: Error
}
export default function ErrorOverview({ error }: Props) {
  const stack = error.stack ? error.stack.split('\n').slice(1) : undefined
  const origin = stack ? getStackUtils().parseLine(stack[0]!) : undefined
  const filePath = cleanupPath(origin?.file)
  let excerpt: CodeExcerpt[] | undefined
  let lineWidth = 0
  if (filePath && origin?.line) {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- sync render path; error overlay can't go async without suspense restructuring
      const sourceCode = readFileSync(filePath, 'utf8')
      excerpt = codeExcerpt(sourceCode, origin.line)
      if (excerpt) {
        for (const { line } of excerpt) {
          lineWidth = Math.max(lineWidth, String(line).length)
        }
      }
    } catch {
      // file not readable — skip source context
    }
  }
  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text backgroundColor="ansi:red" color="ansi:white">
          {' '}
          ERROR{' '}
        </Text>

        <Text> {error.message}</Text>
      </Box>

      {origin && filePath && (
        <Box marginTop={1}>
          <Text dim>
            {filePath}:{origin.line}:{origin.column}
          </Text>
        </Box>
      )}

      {origin && excerpt && (
        <Box marginTop={1} flexDirection="column">
          {excerpt.map(({ line: lineNumber, value }) => (
            <Box key={lineNumber}>
              <Box width={lineWidth + 1}>
                <Text
                  dim={lineNumber !== origin.line}
                  backgroundColor={lineNumber === origin.line ? 'ansi:red' : undefined}
                  color={lineNumber === origin.line ? 'ansi:white' : undefined}
                >
                  {String(lineNumber).padStart(lineWidth, ' ')}:
                </Text>
              </Box>

              <Text
                key={lineNumber}
                backgroundColor={lineNumber === origin.line ? 'ansi:red' : undefined}
                color={lineNumber === origin.line ? 'ansi:white' : undefined}
              >
                {` ${value}`}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {error.stack && (
        <Box marginTop={1} flexDirection="column">
          {error.stack
            .split('\n')
            .slice(1)
            .map((stackLine) => {
              const parsedLine = getStackUtils().parseLine(stackLine)

              // 如果无法解析该行，则输出未解析的行。
              if (!parsedLine) {
                return (
                  <Box key={stackLine}>
                    <Text dim>- </Text>
                    <Text bold>{stackLine}</Text>
                  </Box>
                )
              }
              return (
                <Box key={stackLine}>
                  <Text dim>- </Text>
                  <Text bold>{parsedLine.function}</Text>
                  <Text dim>
                    {' '}
                    ({cleanupPath(parsedLine.file) ?? ''}:{parsedLine.line}:{parsedLine.column})
                  </Text>
                </Box>
              )
            })}
        </Box>
      )}
    </Box>
  )
}
