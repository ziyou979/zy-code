import React from 'react'
import { useTerminalSize } from 'src/hooks/useTerminalSize.js'
import type { ThemeName } from 'src/utils/theme.js'
import type { Command } from '../../commands.js'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text, useTheme } from '../../ink.js'
import type { AppState } from '../../state/AppState.js'
import { useAppStateMaybeOutsideOfProvider } from '../../state/AppState.js'
import { findToolByName, type Tool, type ToolProgressData, type Tools } from '../../tool.js'
import type { ToolCallBlock } from '../../types/llm.js'
import type { ProgressMessage } from '../../types/message.js'
import { useIsClassifierChecking } from '../../utils/classifierApprovalsHook.js'
import { logError } from '../../utils/log.js'
import type { buildMessageLookups } from '../../services/messages/index.js'
import { MessageResponse } from '../MessageResponse.js'
import { useSelectedMessageBg } from '../MessageActions.js'
import { SentryErrorBoundary } from '../SentryErrorBoundary.js'
import { ToolUseLoader } from '../ToolUseLoader.js'
import { HookProgressMessage } from './HookProgressMessage.js'

type Props = {
  param: ToolCallBlock
  addMargin: boolean
  tools: Tools
  commands: Command[]
  verbose: boolean
  inProgressToolUseIDs: Set<string>
  progressMessagesForMessage: ProgressMessage[]
  shouldAnimate: boolean
  shouldShowDot: boolean
  inProgressToolCallCount?: number
  lookups: ReturnType<typeof buildMessageLookups>
  isTranscriptMode?: boolean
}
export function AssistantToolUseMessage({
  param,
  addMargin,
  tools,
  commands,
  verbose,
  inProgressToolUseIDs,
  progressMessagesForMessage,
  shouldAnimate,
  shouldShowDot,
  inProgressToolCallCount,
  lookups,
  isTranscriptMode,
}: Props) {
  const terminalSize = useTerminalSize()
  const [theme] = useTheme()
  const bg = useSelectedMessageBg()
  const pendingWorkerRequest = useAppStateMaybeOutsideOfProvider(
    (state: AppState) => state.pendingWorkerRequest,
  )
  const isClassifierCheckingRaw = useIsClassifierChecking(param.id)
  const permissionMode = useAppStateMaybeOutsideOfProvider(
    (state_0: AppState) => state_0.toolPermissionContext.mode,
  )
  const hasStrippedRules = useAppStateMaybeOutsideOfProvider(
    (state_1: AppState) => !!state_1.toolPermissionContext.strippedDangerousRules,
  )
  const isAutoClassifier =
    permissionMode === 'auto' || (permissionMode === 'plan' && hasStrippedRules)
  const isClassifierChecking = false && isClassifierCheckingRaw && permissionMode !== 'auto'
  let parsed
  if (!tools) {
    parsed = null
  } else {
    const tool = findToolByName(tools, param.name)
    if (!tool) {
      parsed = null
    } else {
      const input = tool.inputSchema.safeParse(param.input)
      const data = input.success ? input.data : undefined
      parsed = {
        tool,
        input,
        userFacingToolName: tool.userFacingName(data),
        userFacingToolNameBackgroundColor: tool.userFacingNameBackgroundColor?.(data),
        isTransparentWrapper: tool.isTransparentWrapper?.() ?? false,
      }
    }
  }
  if (!parsed) {
    logError(
      new Error(
        tools ? `Tool ${param.name} not found` : `Tools array is undefined for tool ${param.name}`,
      ),
    )
    return null
  }
  const {
    tool: tool_0,
    input: input_0,
    userFacingToolName,
    userFacingToolNameBackgroundColor,
    isTransparentWrapper,
  } = parsed
  const isResolved = lookups.resolvedToolUseIDs.has(param.id)
  const isQueued = !inProgressToolUseIDs.has(param.id) && !isResolved
  const isWaitingForPermission = pendingWorkerRequest?.toolUseId === param.id
  if (isTransparentWrapper) {
    if (isQueued || isResolved) {
      return null
    }
    const progressMessageElement = renderToolUseProgressMessage(
      tool_0,
      tools,
      lookups,
      param.id,
      progressMessagesForMessage,
      {
        verbose,
        inProgressToolCallCount,
        isTranscriptMode,
      },
      terminalSize,
    )
    return (
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      <Box flexDirection="column" width="100%" backgroundColor={bg as any}>
        {progressMessageElement}
      </Box>
    )
  }
  if (userFacingToolName === '') {
    return null
  }
  const renderedToolUseMessage = input_0.success
    ? renderToolUseMessage(tool_0, input_0.data, {
        theme,
        verbose,
        commands,
      })
    : null
  if (renderedToolUseMessage === null) {
    return null
  }
  const minBoxWidth = stringWidth(userFacingToolName) + (shouldShowDot ? 2 : 0)
  const toolTagElement = input_0.success && tool_0.renderToolUseTag?.(input_0.data)
  const progressOrStatusElement =
    !isResolved &&
    !isQueued &&
    (isClassifierChecking ? (
      <MessageResponse height={1}>
        <Text dimColor={true}>
          {isAutoClassifier ? 'Auto classifier checking\u2026' : 'Bash classifier checking\u2026'}
        </Text>
      </MessageResponse>
    ) : isWaitingForPermission ? (
      <MessageResponse height={1}>
        <Text dimColor={true}>Waiting for permission…</Text>
      </MessageResponse>
    ) : (
      renderToolUseProgressMessage(
        tool_0,
        tools,
        lookups,
        param.id,
        progressMessagesForMessage,
        {
          verbose,
          inProgressToolCallCount,
          isTranscriptMode,
        },
        terminalSize,
      )
    ))
  const queuedMessageElement = !isResolved && isQueued && renderToolUseQueuedMessage(tool_0)
  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      marginTop={addMargin ? 1 : 0}
      width="100%"
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      backgroundColor={bg as any}
    >
      {
        <Box flexDirection="column">
          {
            <Box flexDirection="row" flexWrap="nowrap" minWidth={minBoxWidth}>
              {shouldShowDot &&
                (isQueued ? (
                  <Box minWidth={2}>
                    <Text dimColor={isQueued}>{BLACK_CIRCLE}</Text>
                  </Box>
                ) : (
                  <ToolUseLoader
                    shouldAnimate={shouldAnimate}
                    isUnresolved={!isResolved}
                    isError={lookups.erroredToolUseIDs.has(param.id)}
                  />
                ))}
              {
                <Box flexShrink={0}>
                  <Text
                    bold={true}
                    wrap="truncate-end"
                    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
                    backgroundColor={userFacingToolNameBackgroundColor as any}
                    color={userFacingToolNameBackgroundColor ? 'inverseText' : undefined}
                  >
                    {userFacingToolName}
                  </Text>
                </Box>
              }
              {renderedToolUseMessage !== '' && (
                <Box flexWrap="nowrap">
                  <Text>({renderedToolUseMessage})</Text>
                </Box>
              )}
              {toolTagElement}
            </Box>
          }
          {progressOrStatusElement}
          {queuedMessageElement}
        </Box>
      }
    </Box>
  )
}
function renderToolUseMessage(
  tool: Tool,
  input: unknown,
  {
    theme,
    verbose,
    commands,
  }: {
    theme: ThemeName
    verbose: boolean
    commands: Command[]
  },
): React.ReactNode {
  try {
    const parsed = tool.inputSchema.safeParse(input)
    if (!parsed.success) {
      return ''
    }
    return tool.renderToolUseMessage(parsed.data, {
      theme,
      verbose,
      commands,
    })
  } catch (error) {
    logError(new Error(`Error rendering tool use message for ${tool.name}: ${error}`))
    return ''
  }
}
function renderToolUseProgressMessage(
  tool: Tool,
  tools: Tools,
  lookups: ReturnType<typeof buildMessageLookups>,
  toolUseID: string,
  progressMessagesForMessage: ProgressMessage[],
  {
    verbose,
    inProgressToolCallCount,
    isTranscriptMode,
  }: {
    verbose: boolean
    inProgressToolCallCount?: number
    isTranscriptMode?: boolean
  },
  terminalSize: {
    columns: number
    rows: number
  },
): React.ReactNode {
  const toolProgressMessages = progressMessagesForMessage.filter(
    (msg): msg is ProgressMessage<ToolProgressData> => msg.data.type !== 'hook_progress',
  )
  try {
    const toolMessages =
      tool.renderToolUseProgressMessage?.(toolProgressMessages, {
        tools,
        verbose,
        terminalSize,
        inProgressToolCallCount: inProgressToolCallCount ?? 1,
        isTranscriptMode,
      }) ?? null
    return (
      <>
        <SentryErrorBoundary>
          <HookProgressMessage
            hookEvent="PreToolUse"
            lookups={lookups}
            toolUseID={toolUseID}
            verbose={verbose}
            isTranscriptMode={isTranscriptMode}
          />
        </SentryErrorBoundary>
        {toolMessages}
      </>
    )
  } catch (error) {
    logError(new Error(`Error rendering tool use progress message for ${tool.name}: ${error}`))
    return null
  }
}
function renderToolUseQueuedMessage(tool: Tool): React.ReactNode {
  try {
    return tool.renderToolUseQueuedMessage?.()
  } catch (error) {
    logError(new Error(`Error rendering tool use queued message for ${tool.name}: ${error}`))
    return null
  }
}
