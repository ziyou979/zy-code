import { randomUUID } from 'node:crypto'
import { getDefaultCompactModel } from 'src/services/model/model.js'
import type { HookEvent } from 'src/types/index.js'
import { query } from '../../query/index.js'
import { logEvent } from '../analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../analytics/metadata.js'
import type { ToolUseContext } from '../../tools/tool.js'
import { type Tool, toolMatchesName } from '../../tools/tool.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { ALL_AGENT_DISALLOWED_TOOLS } from '../../tools/tools.js'
import { asAgentId } from '../../types/ids.js'
import type { HookResultMessage, Message } from '../../types/message.js'
import { createAbortController } from '../../utils/abortController.js'
import { createAttachmentMessage } from '../attachments/attachments.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { createDebugLog } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { createUserMessage } from '../messages/constructors.js'
import { handleMessageFromStream } from '../messages/streaming.js'
import { hasPermissionsToUseTool } from '../permissions/permissions.js'
import { getAgentTranscriptPath, getTranscriptPath } from '../sessionStorage.js'
import type { AgentHook } from '../settings/types.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import {
  addArgumentsToPrompt,
  createStructuredOutputTool,
  hookResponseSchema,
  registerStructuredOutputEnforcement,
} from './hookHelpers.js'
import { clearSessionHooks } from './sessionHooks.js'
import type { HookResult } from './types.js'

const hookLog = createDebugLog('hooks')

/**
 * Execute an agent-based hook using a multi-turn LLM query
 */
export async function execAgentHook(
  hook: AgentHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  toolUseID: string | undefined,
  // Kept for signature stability with the other exec*Hook functions.
  // Was used by hook.prompt(messages) before the .transform() was removed
  // (CC-79) — the only consumer of that was ExitPlanModeTool's
  // programmatic construction, since refactored into VerifyPlanExecutionTool.
  _messages: Message[],
  agentName?: string,
): Promise<HookResult> {
  const effectiveToolUseID = toolUseID || `hook-${randomUUID()}`

  // Get transcript path from context
  const transcriptPath = toolUseContext.agentId
    ? getAgentTranscriptPath(toolUseContext.agentId)
    : getTranscriptPath()
  const hookStartTime = Date.now()
  try {
    // Replace $ARGUMENTS with the JSON input
    const processedPrompt = addArgumentsToPrompt(hook.prompt, jsonInput)
    hookLog(`Hooks: Processing agent hook with prompt: ${processedPrompt}`)

    // Create user message directly - no need for processUserInput which would
    // trigger UserPromptSubmit hooks and cause infinite recursion
    const userMessage = createUserMessage({
      content: [{ type: 'text' as const, text: processedPrompt }],
    })
    const agentMessages = [userMessage]

    hookLog(`Hooks: Starting agent query with ${agentMessages.length} messages`)

    // Setup timeout and combine with parent signal
    const hookTimeoutMs = hook.timeout ? hook.timeout * 1000 : 60000
    const hookAbortController = createAbortController()

    // Combine parent signal with timeout, and have it abort our controller
    const { signal: parentTimeoutSignal, cleanup: cleanupCombinedSignal } =
      createCombinedAbortSignal(signal, { timeoutMs: hookTimeoutMs })
    const onParentTimeout = () => hookAbortController.abort()
    parentTimeoutSignal.addEventListener('abort', onParentTimeout)

    // Combined signal is just our controller's signal now
    const combinedSignal = hookAbortController.signal

    try {
      // Create StructuredOutput tool with our schema
      const structuredOutputTool = createStructuredOutputTool()

      // Filter out any existing StructuredOutput tool to avoid duplicates with different schemas
      // (e.g., when parent context has a StructuredOutput tool from --json-schema flag)
      const filteredTools = toolUseContext.options.tools.filter(
        (tool) => !toolMatchesName(tool, SYNTHETIC_OUTPUT_TOOL_NAME),
      )

      // Use all available tools plus our structured output tool
      // Filter out disallowed agent tools to prevent stop hook agents from spawning subagents
      // or entering plan mode, and filter out duplicate StructuredOutput tools
      const tools: Tool[] = [
        ...filteredTools.filter((tool) => !ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)),
        structuredOutputTool,
      ]

      const systemPrompt = asSystemPrompt([
        `You are verifying a stop condition in ZY Code. Your task is to verify that the agent completed the given plan. The conversation transcript is available at: ${transcriptPath}\nYou can read this file to analyze the conversation history if needed.

Use the available tools to inspect the codebase and verify the condition.
Use as few steps as possible - be efficient and direct.

When done, return your result using the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool with:
- ok: true if the condition is met
- ok: false with reason if the condition is not met`,
      ])

      const model = hook.model ?? getDefaultCompactModel()!
      const MAX_AGENT_TURNS = 50

      // Create unique agentId for this hook agent
      const hookAgentId = asAgentId(`hook-agent-${randomUUID()}`)

      // Create a modified toolUseContext for the agent
      const agentToolUseContext: ToolUseContext = {
        ...toolUseContext,
        agentId: hookAgentId,
        abortController: hookAbortController,
        options: {
          ...toolUseContext.options,
          tools,
          mainLoopModel: model,
          isNonInteractiveSession: true,
          thinkingConfig: { type: 'disabled' as const },
        },
        setInProgressToolUseIDs: () => {},
        getAppState() {
          const appState = toolUseContext.getAppState()
          // Add session rule to allow reading transcript file
          const existingSessionRules = appState.toolPermissionContext.alwaysAllowRules.session ?? []
          return {
            ...appState,
            toolPermissionContext: {
              ...appState.toolPermissionContext,
              mode: 'dontAsk' as const,
              alwaysAllowRules: {
                ...appState.toolPermissionContext.alwaysAllowRules,
                session: [...existingSessionRules, `Read(/${transcriptPath})`],
              },
            },
          }
        },
      }

      // Register a session-level stop hook to enforce structured output
      registerStructuredOutputEnforcement(toolUseContext.setAppState, hookAgentId)

      let structuredOutputResult: { ok: boolean; reason?: string } | null = null
      let turnCount = 0
      let hitMaxTurns = false

      // Use query() for multi-turn execution
      for await (const message of query({
        messages: agentMessages,
        systemPrompt,
        userContext: {},
        systemContext: {},
        canUseTool: hasPermissionsToUseTool,
        toolUseContext: agentToolUseContext,
        querySource: 'hook_agent',
      })) {
        // Process stream events to update response length in the spinner
        handleMessageFromStream(
          message,
          () => {}, // onMessage - we handle messages below
          (newContent) => toolUseContext.setResponseLength((length) => length + newContent.length),
          toolUseContext.setStreamMode ?? (() => {}),
          () => {}, // onStreamingToolUses - not needed for hooks
        )

        // Skip streaming events for further processing
        if (message.type === 'stream_event' || message.type === 'stream_request_start') {
          continue
        }

        // Count assistant turns
        if (message.type === 'assistant') {
          turnCount++

          // Check if we've hit the turn limit
          if (turnCount >= MAX_AGENT_TURNS) {
            hitMaxTurns = true
            hookLog(`Hooks: Agent turn ${turnCount} hit max turns, aborting`)
            hookAbortController.abort()
            break
          }
        }

        // Check for structured output in attachments
        if (message.type === 'attachment' && message.attachment.type === 'structured_output') {
          const parsed = hookResponseSchema().safeParse(
            (message.attachment as Record<string, unknown>).data,
          )
          if (parsed.success) {
            structuredOutputResult = parsed.data
            hookLog(`Hooks: Got structured output: ${jsonStringify(structuredOutputResult)}`)
            // Got structured output, abort and exit
            hookAbortController.abort()
            break
          }
        }
      }

      parentTimeoutSignal.removeEventListener('abort', onParentTimeout)
      cleanupCombinedSignal()

      // Clean up the session hook we registered for this agent
      clearSessionHooks(toolUseContext.setAppState, hookAgentId)

      // Check if we got a result
      if (!structuredOutputResult) {
        // If we hit max turns, just log and return cancelled (no UI message)
        if (hitMaxTurns) {
          hookLog(`Hooks: Agent hook did not complete within ${MAX_AGENT_TURNS} turns`)
          logEvent('zy_agent_stop_hook_max_turns', {
            durationMs: Date.now() - hookStartTime,
            turnCount,
            agentName: agentName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          return {
            hook,
            outcome: 'cancelled',
          }
        }

        // For other cases (e.g., agent finished without calling structured output tool),
        // just log and return cancelled (don't show error to user)
        hookLog(`Hooks: Agent hook did not return structured output`)
        logEvent('zy_agent_stop_hook_error', {
          durationMs: Date.now() - hookStartTime,
          turnCount,
          errorType: 1, // 1 = no structured output
          agentName: agentName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {
          hook,
          outcome: 'cancelled',
        }
      }

      // Return result based on structured output
      if (!structuredOutputResult.ok) {
        hookLog(`Hooks: Agent hook condition was not met: ${structuredOutputResult.reason}`)
        return {
          hook,
          outcome: 'blocking',
          blockingError: {
            blockingError: `Agent hook condition was not met: ${structuredOutputResult.reason}`,
            command: hook.prompt,
          },
        }
      }

      // Condition was met
      hookLog(`Hooks: Agent hook condition was met`)
      logEvent('zy_agent_stop_hook_success', {
        durationMs: Date.now() - hookStartTime,
        turnCount,
        agentName: agentName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return {
        hook,
        outcome: 'success',
        message: createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
          content: '',
        }) as unknown as HookResultMessage,
      }
    } catch (error) {
      parentTimeoutSignal.removeEventListener('abort', onParentTimeout)
      cleanupCombinedSignal()

      if (combinedSignal.aborted) {
        return {
          hook,
          outcome: 'cancelled',
        }
      }
      throw error
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    hookLog(`Hooks: Agent hook error: ${errorMsg}`)
    logEvent('zy_agent_stop_hook_error', {
      durationMs: Date.now() - hookStartTime,
      errorType: 2, // 2 = general error
      agentName: agentName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return {
      hook,
      outcome: 'non_blocking_error',
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: effectiveToolUseID,
        hookEvent,
        stderr: `Error executing agent hook: ${errorMsg}`,
        stdout: '',
        exitCode: 1,
      }) as unknown as HookResultMessage,
    }
  }
}
