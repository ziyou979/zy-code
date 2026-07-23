import {
  hookJSONOutputSchema,
  isAsyncHookJSONOutput,
  type PromptRequest,
  promptRequestSchema,
} from 'src/types/hooks/index.js'
import type {
  AsyncHookJSONOutput,
  HookEvent,
  HookJSONOutput,
  SyncHookJSONOutput,
} from 'src/types/index.js'
import type { HookResultMessage } from 'src/types/message.js'
import { createAttachmentMessage } from '../attachments/attachments.js'
import { jsonParse, jsonStringify } from '../../services/infra/slowOperations.js'
import { maybeSpillHookOutput } from './spillOutput.js'
import type { ElicitationResponse, HookResult } from './types.js'

export type HookPromptDetection = {
  promptRequestSchema: typeof promptRequestSchema
  isAsyncHookJSONOutput: typeof isAsyncHookJSONOutput
}

function validateHookJson(
  jsonString: string,
): { json: HookJSONOutput } | { validationError: string } {
  const parsed = jsonParse(jsonString)
  const validation = hookJSONOutputSchema().safeParse(parsed)
  if (validation.success) {
    return { json: validation.data }
  }
  const errors = validation.error.issues
    .map((err) => `  - ${err.path.join('.')}: ${err.message}`)
    .join('\n')
  return {
    validationError: `Hook JSON output validation failed:\n${errors}\n\nThe hook's output was: ${jsonStringify(parsed, null, 2)}`,
  }
}

export function createHookPromptDetection(): HookPromptDetection {
  return {
    promptRequestSchema,
    isAsyncHookJSONOutput,
  }
}

export function parseHookOutput(stdout: string): {
  json?: HookJSONOutput
  plainText?: string
  validationError?: string
} {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) {
    return { plainText: stdout }
  }

  try {
    const result = validateHookJson(trimmed)
    if ('json' in result) {
      return result
    }
    const validationError = `${result.validationError}\n\nExpected schema:\n${jsonStringify(
      {
        continue: 'boolean (optional)',
        suppressOutput: 'boolean (optional)',
        stopReason: 'string (optional)',
        decision: '"approve" | "block" (optional)',
        reason: 'string (optional)',
        systemMessage: 'string (optional)',
        permissionDecision: '"allow" | "deny" | "ask" (optional)',
        hookSpecificOutput: {
          'for PreToolUse': {
            hookEventName: '"PreToolUse"',
            permissionDecision: '"allow" | "deny" | "ask" (optional)',
            permissionDecisionReason: 'string (optional)',
            updatedInput: 'object (optional) - Modified tool input to use',
          },
          'for UserPromptSubmit': {
            hookEventName: '"UserPromptSubmit"',
            additionalContext: 'string (required)',
          },
          'for PostToolUse': {
            hookEventName: '"PostToolUse"',
            additionalContext: 'string (optional)',
          },
        },
      },
      null,
      2,
    )}`
    return { plainText: stdout, validationError }
  } catch {
    return { plainText: stdout }
  }
}

export function parseHttpHookOutput(body: string): {
  json?: HookJSONOutput
  validationError?: string
} {
  const trimmed = body.trim()

  if (trimmed === '') {
    const validation = hookJSONOutputSchema().safeParse({})
    if (validation.success) {
      return { json: validation.data }
    }
  }

  if (!trimmed.startsWith('{')) {
    const validationError = `HTTP hook must return JSON, but got non-JSON response body: ${trimmed.length > 200 ? `${trimmed.slice(0, 200)}\u2026` : trimmed}`
    return { validationError }
  }

  try {
    const result = validateHookJson(trimmed)
    if ('json' in result) {
      return result
    }
    return result
  } catch (error) {
    const validationError = `HTTP hook must return valid JSON, but parsing failed: ${error}`
    return { validationError }
  }
}

export function processHookJSONOutput({
  json,
  command,
  hookName,
  toolUseID,
  hookEvent,
  expectedHookEvent,
  stdout,
  stderr,
  exitCode,
  durationMs,
}: {
  json: SyncHookJSONOutput
  command: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  expectedHookEvent?: HookEvent
  stdout?: string
  stderr?: string
  exitCode?: number
  durationMs?: number
}): Partial<HookResult> {
  const result: Partial<HookResult> = {}

  const createHookResultMessage = (attachment: Parameters<typeof createAttachmentMessage>[0]) =>
    createAttachmentMessage(attachment) as unknown as HookResultMessage

  if (json.continue === false) {
    result.preventContinuation = true
    if (json.stopReason) {
      result.stopReason = json.stopReason
    }
  }

  if (json.decision) {
    switch (json.decision) {
      case 'approve':
        result.permissionBehavior = 'allow'
        break
      case 'block':
        result.permissionBehavior = 'deny'
        result.blockingError = {
          blockingError: json.reason || 'Blocked by hook',
          command,
        }
        break
      default:
        throw new Error(
          `Unknown hook decision type: ${json.decision}. Valid types are: approve, block`,
        )
    }
  }

  if (json.systemMessage) {
    result.systemMessage = json.systemMessage
  }

  if (json.terminalSequence !== undefined) {
    result.terminalSequence = json.terminalSequence
  }

  if (
    json.hookSpecificOutput?.hookEventName === 'PreToolUse' &&
    json.hookSpecificOutput.permissionDecision
  ) {
    switch (json.hookSpecificOutput.permissionDecision) {
      case 'allow':
        result.permissionBehavior = 'allow'
        break
      case 'deny':
        result.permissionBehavior = 'deny'
        result.blockingError = {
          blockingError: json.reason || 'Blocked by hook',
          command,
        }
        break
      case 'ask':
        result.permissionBehavior = 'ask'
        break
      default:
        throw new Error(
          `Unknown hook permissionDecision type: ${json.hookSpecificOutput.permissionDecision}. Valid types are: allow, deny, ask`,
        )
    }
  }
  if (result.permissionBehavior !== undefined && json.reason !== undefined) {
    result.hookPermissionDecisionReason = json.reason
  }

  if (json.hookSpecificOutput) {
    if (expectedHookEvent && json.hookSpecificOutput.hookEventName !== expectedHookEvent) {
      throw new Error(
        `Hook returned incorrect event name: expected '${expectedHookEvent}' but got '${json.hookSpecificOutput.hookEventName}'. Full stdout: ${jsonStringify(json, null, 2)}`,
      )
    }

    switch (json.hookSpecificOutput.hookEventName) {
      case 'PreToolUse':
        if (json.hookSpecificOutput.permissionDecision) {
          switch (json.hookSpecificOutput.permissionDecision) {
            case 'allow':
              result.permissionBehavior = 'allow'
              break
            case 'deny':
              result.permissionBehavior = 'deny'
              result.blockingError = {
                blockingError:
                  json.hookSpecificOutput.permissionDecisionReason ||
                  json.reason ||
                  'Blocked by hook',
                command,
              }
              break
            case 'ask':
              result.permissionBehavior = 'ask'
              break
          }
        }
        result.hookPermissionDecisionReason = json.hookSpecificOutput.permissionDecisionReason
        if (json.hookSpecificOutput.updatedInput) {
          result.updatedInput = json.hookSpecificOutput.updatedInput
        }
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'UserPromptSubmit':
      case 'UserPromptExpansion':
      case 'Setup':
      case 'SubagentStart':
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PostToolBatch':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        if (
          json.hookSpecificOutput.hookEventName === 'PostToolUse' &&
          json.hookSpecificOutput.updatedToolOutput !== undefined
        ) {
          result.updatedToolOutput = json.hookSpecificOutput.updatedToolOutput
        }
        if (
          json.hookSpecificOutput.hookEventName === 'PostToolUse' &&
          json.hookSpecificOutput.updatedMCPToolOutput
        ) {
          result.updatedMCPToolOutput = json.hookSpecificOutput.updatedMCPToolOutput
        }
        break
      case 'SessionStart':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        result.initialUserMessage = json.hookSpecificOutput.initialUserMessage
        if ('watchPaths' in json.hookSpecificOutput && json.hookSpecificOutput.watchPaths) {
          result.watchPaths = json.hookSpecificOutput.watchPaths
        }
        break
      case 'PermissionDenied':
        result.retry = json.hookSpecificOutput.retry
        break
      case 'MessageDisplay':
        if (json.hookSpecificOutput.transformedText !== undefined) {
          result.transformedText = json.hookSpecificOutput.transformedText
        }
        if (json.hookSpecificOutput.hide !== undefined) {
          result.hide = json.hookSpecificOutput.hide
        }
        break
      case 'PermissionRequest':
        if (json.hookSpecificOutput.decision) {
          result.permissionRequestResult = json.hookSpecificOutput.decision
          result.permissionBehavior =
            json.hookSpecificOutput.decision.behavior === 'allow' ? 'allow' : 'deny'
          if (
            json.hookSpecificOutput.decision.behavior === 'allow' &&
            json.hookSpecificOutput.decision.updatedInput
          ) {
            result.updatedInput = json.hookSpecificOutput.decision.updatedInput
          }
        }
        break
      case 'Elicitation':
        if (json.hookSpecificOutput.action) {
          result.elicitationResponse = {
            action: json.hookSpecificOutput.action,
            content: json.hookSpecificOutput.content as ElicitationResponse['content'] | undefined,
          }
          if (json.hookSpecificOutput.action === 'decline') {
            result.blockingError = {
              blockingError: json.reason || 'Elicitation denied by hook',
              command,
            }
          }
        }
        break
      case 'ElicitationResult':
        if (json.hookSpecificOutput.action) {
          result.elicitationResultResponse = {
            action: json.hookSpecificOutput.action,
            content: json.hookSpecificOutput.content as ElicitationResponse['content'] | undefined,
          }
          if (json.hookSpecificOutput.action === 'decline') {
            result.blockingError = {
              blockingError: json.reason || 'Elicitation result blocked by hook',
              command,
            }
          }
        }
        break
    }
  }

  if (result.additionalContext) {
    result.additionalContext = maybeSpillHookOutput(hookName, result.additionalContext).inline
  }

  return {
    ...result,
    message: result.blockingError
      ? createHookResultMessage({
          type: 'hook_blocking_error',
          hookName,
          toolUseID,
          hookEvent,
          blockingError: result.blockingError,
        })
      : createHookResultMessage({
          type: 'hook_success',
          hookName,
          toolUseID,
          hookEvent,
          content: '',
          stdout,
          stderr,
          exitCode,
          command,
          durationMs,
        }),
  }
}
