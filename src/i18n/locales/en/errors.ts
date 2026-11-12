import type { TranslationResource } from '../resourceTypes.js'

/**
 * 报错路径的文案：API 错误、重试提示、-p 模式输出、CLI 参数校验。
 *
 * apiError.* 的英文值同时是「持久化内容模板」：assistant 错误消息的 content 固定写英文
 * （会话 jsonl 回放、字符串匹配都依赖它），渲染层按这些英文模板反查 key 再取当前语言
 * （services/api/errorText.ts）。所以 apiError.* 的英文值改动 = 改变持久化内容，
 * 必须与 services/api/errors.ts 的常量保持一致（有单测守护）。
 */
export const enErrors: TranslationResource = {
  'apiError.authFailed.interactive': 'Please run /login · API Error: {detail}',
  'apiError.authFailed.nonInteractive': 'Failed to authenticate. API Error: {detail}',
  'apiError.autoModeUnavailable': 'Auto mode is unavailable for your plan',
  'apiError.ccrAuth':
    'Authentication error · This may be a temporary network issue, please try again',
  'apiError.contextLimitReached': 'Context limit reached · /compact or /clear to continue',
  'apiError.contextWindowExceeded': 'API Error: The model has reached its context window limit.',
  'apiError.creditBalanceTooLow': 'Credit balance is too low',
  'apiError.creditBalanceTooLowHint':
    'Credit balance too low · Add funds: https://platform.zy.com/settings/billing',
  'apiError.customOffSwitch':
    'Current model is experiencing high demand. Please use /model to switch to another model.',
  'apiError.duplicateToolUseId': 'API Error: 400 duplicate tool_use ID in conversation history.',
  'apiError.duplicateToolUseId.withRewind':
    'API Error: 400 duplicate tool_use ID in conversation history. Run /rewind to recover the conversation.',
  'apiError.extraUsageRequired.interactive':
    'API Error: Extra usage is required for 1M context · run /extra-usage to enable, or /model to switch to standard context',
  'apiError.extraUsageRequired.nonInteractive':
    'API Error: Extra usage is required for 1M context · enable extra usage at zy.ai/settings/usage, or use --model to switch to standard context',
  'apiError.generic': 'API Error: {detail}',
  'apiError.imageTooLarge.interactive':
    'Image was too large. Double press esc to go back and try again with a smaller image.',
  'apiError.imageTooLarge.nonInteractive':
    'Image was too large. Try resizing the image or using a different approach.',
  'apiError.invalidApiKeyExternal': 'Invalid API key · Fix external API key',
  'apiError.keychainLockedHint': '· Run in another terminal: security unlock-keychain',
  'apiError.manyImageDimensions.interactive':
    'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Run /compact to remove old images from context, or start a new session.',
  'apiError.manyImageDimensions.nonInteractive':
    'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.',
  'apiError.maxOutputTokens':
    "API Error: Zy's response exceeded the {max} output token maximum. To configure this behavior, set the ZY_CODE_MAX_OUTPUT_TOKENS environment variable.",
  'apiError.modelNotFound':
    "There's an issue with the selected model ({model}). It may not exist or you may not have access to it. Run {switchCmd} to pick a different model.",
  'apiError.notLoggedIn': 'Not logged in · Please run /login',
  'apiError.oauthOrgNotAllowed': 'Your account does not have access to ZY Code. Please run /login.',
  'apiError.oauthOrgNotAllowedNonInteractive':
    'Your organization does not have access to ZY. Please login again or contact your administrator.',
  'apiError.orgDisabledEnvKey':
    'Your API key belongs to a disabled organization · Update or unset the environment variable',
  'apiError.orgDisabledEnvKeyWithOAuth':
    'Your API key belongs to a disabled organization · Unset the environment variable to use your subscription instead',
  'apiError.pdfInvalid.interactive':
    'The PDF file was not valid. Double press esc to go back and try again with a different file.',
  'apiError.pdfInvalid.nonInteractive':
    'The PDF file was not valid. Try converting it to text first (e.g., pdftotext).',
  'apiError.pdfPasswordProtected.interactive':
    'PDF is password protected. Please double press esc to edit your message and try again.',
  'apiError.pdfPasswordProtected.nonInteractive':
    'PDF is password protected. Try using a CLI tool to extract or convert the PDF.',
  'apiError.pdfTooLarge.interactive':
    'PDF too large (max {pages} pages, {size}). Double press esc to go back and try again, or use pdftotext to convert to text first.',
  'apiError.pdfTooLarge.nonInteractive':
    'PDF too large (max {pages} pages, {size}). Try reading the file a different way (e.g., extract text with pdftotext).',
  'apiError.promptTooLong': 'Prompt is too long',
  'apiError.refusal.interactive':
    'API Error: ZY Code is unable to respond to this request, which appears to violate our Usage Policy. Please double press esc to edit your last message or start a new session for ZY Code to assist with a different task.',
  'apiError.refusal.nonInteractive':
    'API Error: ZY Code is unable to respond to this request, which appears to violate our Usage Policy. Try rephrasing the request or attempting a different approach.',
  'apiError.repeated529': 'Repeated 529 Overloaded errors',
  'apiError.requestRejected429': 'API Error: Request rejected (429) · {detail}',
  'apiError.requestTooLarge.interactive':
    'Request too large (max {size}). Double press esc to go back and try with a smaller file.',
  'apiError.requestTooLarge.nonInteractive': 'Request too large (max {size}). Try with a smaller file.',
  'apiError.retrying_one': 'Retrying in {seconds} second… (attempt {attempt}/{max})',
  'apiError.retrying_other': 'Retrying in {seconds} seconds… (attempt {attempt}/{max})',
  'apiError.retryTimeoutHint': ' · API_TIMEOUT_MS={ms}ms, try increasing it',
  'apiError.timeout': 'Request timed out',
  'apiError.timeoutHint': ' (API_TIMEOUT_MS={ms}ms, try increasing it)',
  'apiError.tokenRevoked': 'OAuth token revoked · Please run /login',
  'apiError.tokenRevokedNonInteractive':
    'Your account does not have access to ZY. Please login again or contact your administrator.',
  'apiError.toolUseConcurrency': 'API Error: 400 due to tool use concurrency issues.',
  'apiError.toolUseConcurrency.withRewind':
    'API Error: 400 due to tool use concurrency issues. Run /rewind to recover the conversation.',
  'apiError.waitAndRetry': 'API Error: Please wait a moment and try again.',
  'print.executionError': 'Execution error',
  'print.maxBudget': 'Error: Exceeded USD budget ({budget})',
  'print.maxTurns': 'Error: Reached max turns ({maxTurns})',
  'print.structuredOutputRetries':
    'Error: Failed to provide valid structured output after maximum retries',
}
