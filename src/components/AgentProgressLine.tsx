import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink/index.js'
import { formatNumber } from '../utils/format.js'
import type { Theme } from '../services/environment/theme.js'

export type AgentStepInfo = {
  id: string
  text: string
  status: 'running' | 'success' | 'error'
}

type Props = {
  agentType: string
  description?: string
  name?: string
  descriptionColor?: keyof Theme
  taskDescription?: string
  model?: string
  toolUseCount: number
  tokens: number | null
  color?: keyof Theme
  isLast: boolean
  isResolved: boolean
  isError: boolean
  isAsync?: boolean
  shouldAnimate: boolean
  lastToolInfo?: string | null
  steps?: AgentStepInfo[]
  hideType?: boolean
}
export function AgentProgressLine({
  agentType,
  description,
  name,
  descriptionColor,
  taskDescription,
  model,
  toolUseCount,
  tokens,
  color,
  isLast,
  isResolved,
  isAsync = false,
  lastToolInfo,
  steps,
  hideType = false,
}: Props) {
  const treeChar = isLast ? '\u2514\u2500' : '\u251C\u2500'
  const isBackgrounded = isAsync && isResolved
  const getStatusText = () => {
    if (!isResolved) {
      return lastToolInfo || tSync('agentProgress.initializing')
    }
    if (isBackgrounded) {
      return taskDescription ?? tSync('agentProgress.runningBackground')
    }
    return tSync('agentProgress.done')
  }
  return (
    <Box flexDirection="column">
      {
        <Box paddingLeft={3}>
          {<Text dimColor={true}>{treeChar} </Text>}
          {
            <Text dimColor={!isResolved}>
              {hideType ? (
                <>
                  <Text bold={true}>{name ?? description ?? agentType}</Text>
                  {name && description && <Text dimColor={true}>: {description}</Text>}
                </>
              ) : (
                <>
                  <Text
                    bold={true}
                    backgroundColor={color}
                    color={color ? 'inverseText' : undefined}
                  >
                    {agentType}
                  </Text>
                  {description && (
                    <>
                      {' ('}
                      <Text
                        backgroundColor={descriptionColor}
                        color={descriptionColor ? 'inverseText' : undefined}
                      >
                        {description}
                      </Text>
                      {')'}
                    </>
                  )}
                </>
              )}
              {model && (
                <>
                  {' \xB7 '}
                  {model}
                </>
              )}
              {!isBackgrounded && (
                <>
                  {' \xB7 '}
                  {toolUseCount}{' '}
                  {tSync(
                    toolUseCount === 1
                      ? 'agentProgress.toolUse_one'
                      : 'agentProgress.toolUse_other',
                  )}
                  {tokens !== null && <> · {formatNumber(tokens)} tokens</>}
                </>
              )}
            </Text>
          }
        </Box>
      }
      {!isBackgrounded &&
        (steps && steps.length > 0 ? (
          steps.map((step) => (
            <Box key={step.id} paddingLeft={3} flexDirection="row" height={1} overflow="hidden">
              <Text dimColor={true}>{isLast ? '   \u23BF  ' : '\u2502  \u23BF  '}</Text>
              <Text dimColor={true} wrap="truncate-end">
                {step.text}
                {step.status === 'success' ? (
                  <Text color="success">{' \u2713'}</Text>
                ) : step.status === 'error' ? (
                  <Text color="error">{' \u2717'}</Text>
                ) : (
                  <Text dimColor={true}>{' \u2026'}</Text>
                )}
              </Text>
            </Box>
          ))
        ) : (
          <Box paddingLeft={3} flexDirection="row">
            <Text dimColor={true}>{isLast ? '   \u23BF  ' : '\u2502  \u23BF  '}</Text>
            <Text dimColor={true}>{getStatusText()}</Text>
          </Box>
        ))}
    </Box>
  )
}
