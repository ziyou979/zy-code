import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { ExitPlanModeTool } from 'src/tools/ExitPlanModeTool/ExitPlanModeTool.js'
import { SEND_MESSAGE_TOOL_NAME } from 'src/tools/SendMessageTool/constants.js'
import { TASK_OUTPUT_TOOL_NAME } from 'src/tools/TaskOutputTool/constants.js'
import type { ContentBlock, UserContentBlock } from '../../../types/llm.js'
import type { UserMessage } from '../../../types/message.js'
import { formatNumber } from '../../utils/format.js'
import { logMCPDebug } from '../../utils/log.js'
import type { Attachment } from '../../attachments/attachments.js'
import { DiagnosticTrackingService } from '../../diagnosticTracking.js'
import { getWorkflowReminderContent } from '../../workflow/reminderContent.js'
import { textContent } from '../apiNormalize.js'
import { createUserMessage } from '../constructors.js'
import { wrapInSystemReminder, wrapMessagesInSystemReminder } from '../systemReminder.js'

function createMetaMessages(text: string): UserMessage[] {
  return wrapMessagesInSystemReminder([
    createUserMessage({
      content: textContent(text),
      isMeta: true,
    }),
  ])
}

function createSystemReminderMessages(text: string): UserMessage[] {
  return [
    createUserMessage({
      content: textContent(wrapInSystemReminder(text)),
      isMeta: true,
    }),
  ]
}

function buildTaskStatusMessages(
  attachment: Extract<Attachment, { type: 'task_status' }>,
): UserMessage[] {
  const displayStatus = attachment.status === 'killed' ? 'stopped' : attachment.status

  if (attachment.status === 'killed') {
    return createSystemReminderMessages(
      `Task "${attachment.description}" (${attachment.taskId}) was stopped by the user.`,
    )
  }

  if (attachment.status === 'running') {
    const parts = [
      `Background agent "${attachment.description}" (${attachment.taskId}) is still running.`,
    ]
    if (attachment.deltaSummary) {
      parts.push(`Progress: ${attachment.deltaSummary}`)
    }
    if (attachment.outputFilePath) {
      parts.push(
        `Do NOT spawn a duplicate. You will be notified when it completes. You can read partial output at ${attachment.outputFilePath} or send it a message with ${SEND_MESSAGE_TOOL_NAME}.`,
      )
    } else {
      parts.push(
        `Do NOT spawn a duplicate. You will be notified when it completes. You can check its progress with the ${TASK_OUTPUT_TOOL_NAME} tool or send it a message with ${SEND_MESSAGE_TOOL_NAME}.`,
      )
    }
    return createSystemReminderMessages(parts.join(' '))
  }

  const messageParts: string[] = [
    `Task ${attachment.taskId}`,
    `(type: ${attachment.taskType})`,
    `(status: ${displayStatus})`,
    `(description: ${attachment.description})`,
  ]

  if (attachment.deltaSummary) {
    messageParts.push(`Delta: ${attachment.deltaSummary}`)
  }

  if (attachment.outputFilePath) {
    messageParts.push(`Read the output file to retrieve the result: ${attachment.outputFilePath}`)
  } else {
    messageParts.push(`You can check its output using the ${TASK_OUTPUT_TOOL_NAME} tool.`)
  }

  return createSystemReminderMessages(messageParts.join(' '))
}

function buildAsyncHookResponseMessages(
  attachment: Extract<Attachment, { type: 'async_hook_response' }>,
): UserMessage[] {
  const messages: UserMessage[] = []

  if (attachment.response.systemMessage) {
    messages.push(
      createUserMessage({
        content: textContent(attachment.response.systemMessage),
        isMeta: true,
      }),
    )
  }

  if (
    attachment.response.hookSpecificOutput &&
    'additionalContext' in attachment.response.hookSpecificOutput &&
    attachment.response.hookSpecificOutput.additionalContext
  ) {
    messages.push(
      createUserMessage({
        content: textContent(attachment.response.hookSpecificOutput.additionalContext),
        isMeta: true,
      }),
    )
  }

  return wrapMessagesInSystemReminder(messages)
}

function buildMcpResourceMessages(
  attachment: Extract<Attachment, { type: 'mcp_resource' }>,
): UserMessage[] {
  const content = attachment.content
  if (!content?.contents || content.contents.length === 0) {
    return createMetaMessages(
      `<mcp-resource server="${attachment.server}" uri="${attachment.uri}">(No content)</mcp-resource>`,
    )
  }

  const transformedBlocks: ContentBlock[] = []
  for (const item of content.contents) {
    if (!item || typeof item !== 'object') {
      continue
    }
    if ('text' in item && typeof item.text === 'string') {
      transformedBlocks.push(
        {
          type: 'text',
          text: 'Full contents of resource:',
        },
        {
          type: 'text',
          text: item.text,
        },
        {
          type: 'text',
          text: 'Do NOT read this resource again unless you think it may have changed, since you already have the full contents.',
        },
      )
      continue
    }
    if ('blob' in item) {
      const mimeType = 'mimeType' in item ? String(item.mimeType) : 'application/octet-stream'
      transformedBlocks.push({
        type: 'text',
        text: `[Binary content: ${mimeType}]`,
      })
    }
  }

  if (transformedBlocks.length > 0) {
    return wrapMessagesInSystemReminder([
      createUserMessage({
        content: transformedBlocks as UserContentBlock[],
        isMeta: true,
      }),
    ])
  }

  logMCPDebug(attachment.server, `No displayable content found in MCP resource ${attachment.uri}.`)
  return createMetaMessages(
    `<mcp-resource server="${attachment.server}" uri="${attachment.uri}">(No displayable content)</mcp-resource>`,
  )
}

export function normalizeMetaAttachmentForAPI(attachment: Attachment): UserMessage[] | null {
  switch (attachment.type) {
    case 'diagnostics':
      if (attachment.files.length === 0) {
        return []
      }
      return createMetaMessages(
        `<new-diagnostics>The following new diagnostic issues were detected:\n\n${DiagnosticTrackingService.formatDiagnosticsSummary(attachment.files)}</new-diagnostics>`,
      )
    case 'plan_mode_reentry':
      return createMetaMessages(
        `## Re-entering Plan Mode

You are returning to plan mode after having previously exited it. A plan file exists at ${attachment.planFilePath} from your previous planning session.

**Before proceeding with any new planning, you should:**
1. Read the existing plan file to understand what was previously planned
2. Evaluate the user's current request against that plan
3. Decide how to proceed:
   - **Different task**: If the user's request is for a different task—even if it's similar or related—start fresh by overwriting the existing plan
   - **Same task, continuing**: If this is explicitly a continuation or refinement of the exact same task, modify the existing plan while cleaning up outdated or irrelevant sections
4. Continue on with the plan process and most importantly you should always edit the plan file one way or the other before calling ${ExitPlanModeTool.name}

Treat this as a fresh planning session. Do not assume the existing plan is relevant without evaluating it first.`,
      )
    case 'plan_mode_exit': {
      const planReference = attachment.planExists
        ? ` The plan file is located at ${attachment.planFilePath} if you need to reference it.`
        : ''
      return createMetaMessages(
        `## Exited Plan Mode

You have exited plan mode. You can now make edits, run tools, and take actions.${planReference}`,
      )
    }
    case 'auto_mode_exit':
      return createMetaMessages(
        `## Exited Auto Mode

You have exited auto mode. The user may now want to interact more directly. You should ask clarifying questions when the approach is ambiguous rather than making assumptions.`,
      )
    case 'critical_system_reminder':
      return createMetaMessages(attachment.content)
    case 'mcp_resource':
      return buildMcpResourceMessages(attachment)
    case 'agent_mention':
      return createMetaMessages(
        `The user has expressed a desire to invoke the agent "${attachment.agentType}". Please invoke the agent appropriately, passing in the required context to it. `,
      )
    case 'task_status':
      return buildTaskStatusMessages(attachment)
    case 'async_hook_response':
      return buildAsyncHookResponseMessages(attachment)
    case 'token_usage':
      return createSystemReminderMessages(
        `Token usage: ${attachment.used}/${attachment.total}; ${attachment.remaining} remaining`,
      )
    case 'budget_usd':
      return createSystemReminderMessages(
        `USD budget: $${attachment.used}/$${attachment.total}; $${attachment.remaining} remaining`,
      )
    case 'output_token_usage': {
      const turnText =
        attachment.budget !== null
          ? `${formatNumber(attachment.turn)} / ${formatNumber(attachment.budget)}`
          : formatNumber(attachment.turn)
      return createSystemReminderMessages(
        `Output tokens — turn: ${turnText} · session: ${formatNumber(attachment.session)}`,
      )
    }
    case 'hook_blocking_error':
      return createSystemReminderMessages(
        `${attachment.hookName} hook blocking error from command: "${attachment.blockingError.command}": ${attachment.blockingError.blockingError}`,
      )
    case 'hook_success':
      if (attachment.hookEvent !== 'SessionStart' && attachment.hookEvent !== 'UserPromptSubmit') {
        return []
      }
      if (attachment.content === '') {
        return []
      }
      return createSystemReminderMessages(
        `${attachment.hookName} hook success: ${attachment.content}`,
      )
    case 'hook_additional_context':
      if (attachment.content.length === 0) {
        return []
      }
      return createSystemReminderMessages(
        `${attachment.hookName} hook additional context: ${attachment.content.join('\n')}`,
      )
    case 'hook_stopped_continuation':
      return createSystemReminderMessages(
        `${attachment.hookName} hook stopped continuation: ${attachment.message}`,
      )
    case 'compaction_reminder':
      return createMetaMessages(
        'Auto-compact is enabled. When the context window is nearly full, older messages will be automatically summarized so you can continue working seamlessly. There is no need to stop or rush — you have unlimited context through automatic compaction.',
      )
    case 'date_change':
      return createMetaMessages(
        `The date has changed. Today's date is now ${attachment.newDate}. DO NOT mention this to the user explicitly because they are already aware.`,
      )
    case 'ultrathink_effort':
      return createMetaMessages(
        `The user has requested reasoning effort level: ${attachment.level}. Apply this to the current turn.`,
      )
    case 'workflow_reminder':
      return createMetaMessages(getWorkflowReminderContent(attachment.reminderKind))
    case 'deferred_tools_delta': {
      const parts: string[] = []
      if (attachment.addedLines.length > 0) {
        parts.push(
          `The following deferred tools are now available via ToolSearch:\n${attachment.addedLines.join('\n')}`,
        )
      }
      if (attachment.removedNames.length > 0) {
        parts.push(
          `The following deferred tools are no longer available (their MCP server disconnected). Do not search for them — ToolSearch will return no match:\n${attachment.removedNames.join('\n')}`,
        )
      }
      return createMetaMessages(parts.join('\n\n'))
    }
    case 'agent_listing_delta': {
      const parts: string[] = []
      if (attachment.addedLines.length > 0) {
        const header = attachment.isInitial
          ? 'Available agent types for the Agent tool:'
          : 'New agent types are now available for the Agent tool:'
        parts.push(`${header}\n${attachment.addedLines.join('\n')}`)
      }
      if (attachment.removedTypes.length > 0) {
        parts.push(
          `The following agent types are no longer available:\n${attachment.removedTypes.map((type) => `- ${type}`).join('\n')}`,
        )
      }
      if (attachment.isInitial && attachment.showConcurrencyNote) {
        parts.push(
          'Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses.',
        )
      }
      return createMetaMessages(parts.join('\n\n'))
    }
    case 'mcp_instructions_delta': {
      const parts: string[] = []
      if (attachment.addedBlocks.length > 0) {
        parts.push(
          `# MCP Server Instructions

The following MCP servers have provided instructions for how to use their tools and resources:

${attachment.addedBlocks.join('\n\n')}`,
        )
      }
      if (attachment.removedNames.length > 0) {
        parts.push(
          `The following MCP servers have disconnected. Their instructions above no longer apply:\n${attachment.removedNames.join('\n')}`,
        )
      }
      return createMetaMessages(parts.join('\n\n'))
    }
    case 'verify_plan_reminder': {
      // 死代码消除：外部构建中 ZY_CODE_VERIFY_PLAN='false'，因此 === 'true' 检查使 Bun 能够消除该字符串
      /* eslint-disable-next-line custom-rules/no-process-env-top-level */
      const toolName = process.env.ZY_CODE_VERIFY_PLAN === 'true' ? 'VerifyPlanExecution' : ''
      return createMetaMessages(
        `You have completed implementing the plan. Please call the "${toolName}" tool directly (NOT the ${AGENT_TOOL_NAME} tool or an agent) to verify that all plan items were completed correctly.`,
      )
    }
    default:
      return null
  }
}
