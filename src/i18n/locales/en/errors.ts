import type { TranslationResource } from '../resourceTypes.js'

/**
 * 报错路径的文案：apiError.*（API 错误、重试提示）、print.*（-p 文本输出）、
 * cli.*（CLI 参数校验与命令行输出）、config.*（全局配置文件损坏 / 缺失）。
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
  'apiError.requestTooLarge.nonInteractive':
    'Request too large (max {size}). Try with a smaller file.',
  'apiError.retryTimeoutHint': ' · API_TIMEOUT_MS={ms}ms, try increasing it',
  'apiError.retrying_one': 'Retrying in {seconds} second… (attempt {attempt}/{max})',
  'apiError.retrying_other': 'Retrying in {seconds} seconds… (attempt {attempt}/{max})',
  'apiError.timeout': 'Request timed out',
  'apiError.timeoutHint': ' (API_TIMEOUT_MS={ms}ms, try increasing it)',
  'apiError.tokenRevoked': 'OAuth token revoked · Please run /login',
  'apiError.tokenRevokedNonInteractive':
    'Your account does not have access to ZY. Please login again or contact your administrator.',
  'apiError.toolUseConcurrency': 'API Error: 400 due to tool use concurrency issues.',
  'apiError.toolUseConcurrency.withRewind':
    'API Error: 400 due to tool use concurrency issues. Run /rewind to recover the conversation.',
  'apiError.waitAndRetry': 'API Error: Please wait a moment and try again.',
  'cli.auth.availableProviders': 'Available providers: {providers}',
  'cli.auth.availableProvidersHeader': 'Available providers:',
  'cli.auth.loggingInWith': 'Logging in with {provider}...',
  'cli.auth.loginUsage': 'Usage: zy auth login --provider <provider>',
  'cli.auth.pasteCode': 'Paste the authorization code:',
  'cli.auth.unknownProvider': 'Unknown provider: {provider}',
  'cli.betaNotAllowed':
    "Warning: Beta header '{beta}' is not allowed. Only the following betas are supported: {allowed}",
  'cli.chromeFailed': 'Error: Failed to run with ZY in Chrome.',
  'cli.configErrorIn': 'Configuration error in {file}: {error}',
  'cli.continueNotFound': 'No conversation found to continue',
  'cli.deepLink.error': 'Deep link error: {error}',
  'cli.deepLink.noTerminal':
    'Failed to open a terminal. Make sure a supported terminal emulator is installed.',
  'cli.directConnect.disconnected': 'Server disconnected.',
  'cli.directConnect.failed': 'Failed to connect to server at {url}',
  'cli.errorPrefix': 'Error: {error}',
  'cli.filesRewound': 'Files rewound to state at message {uuid}',
  'cli.gitBashPathNotFound': 'ZY Code was unable to find ZY_CODE_GIT_BASH_PATH path "{path}"',
  'cli.gitBashRequired':
    'ZY Code on Windows requires git-bash (https://git-scm.com/downloads/win). If installed but not in PATH, set environment variable pointing to your bash.exe, similar to: ZY_CODE_GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe',
  'cli.includePartialMessagesRequires':
    'Error: --include-partial-messages requires --print and --output-format=stream-json.',
  'cli.inputStreamJsonRequiresOutput':
    'Error: --input-format=stream-json requires output-format=stream-json.',
  'cli.invalidInputFormat': 'Error: Invalid input format "{format}".',
  'cli.invalidMcpConfig': 'Error: Invalid MCP configuration:',
  'cli.maxBudgetInvalid': '--max-budget-usd must be a positive number greater than 0',
  'cli.mcp.addedJson': 'Added {transport} MCP server {name} to {scope} config',
  'cli.mcp.checkingHealth': 'Checking MCP server health...',
  'cli.mcp.choicesReset':
    'All project-scoped (.mcp.json) server approvals and rejections have been reset.',
  'cli.mcp.choicesResetHint': 'You will be prompted for approval next time you start ZY Code.',
  'cli.mcp.dirNotExist': 'Error: Directory {dir} does not exist',
  'cli.mcp.fileModified': 'File modified: {file}',
  'cli.mcp.health.connected': 'Connected',
  'cli.mcp.health.error': 'Connection error',
  'cli.mcp.health.failed': 'Failed to connect',
  'cli.mcp.health.needsAuth': 'Needs authentication',
  'cli.mcp.multipleScopes': 'MCP server "{name}" exists in multiple scopes:',
  'cli.mcp.noDesktopServers':
    'No MCP servers found in Zy Desktop configuration or configuration file does not exist.',
  'cli.mcp.noneConfigured': 'No MCP servers configured. Use `zy mcp add` to add a server.',
  'cli.mcp.notFound': 'No MCP server found with name: "{name}"',
  'cli.mcp.notFoundUnquoted': 'No MCP server found with name: {name}',
  'cli.mcp.removeFromScopeHint': 'To remove from a specific scope, use:',
  'cli.mcp.removeThisHint': 'To remove this server, run: zy mcp remove "{name}" -s {scope}',
  'cli.mcp.removed': 'Removed MCP server "{name}" from {scope} config',
  'cli.mcp.removedExplicitScope': 'Removed MCP server {name} from {scope} config',
  'cli.mcp.serveFailed': 'Error: Failed to start MCP server: {error}',
  'cli.mcpAdd.addedHttp': 'Added HTTP MCP server {name} with URL: {url} to {scope} config',
  'cli.mcpAdd.addedSse': 'Added SSE MCP server {name} with URL: {url} to {scope} config',
  'cli.mcpAdd.addedStdio':
    'Added stdio MCP server {name} with command: {command} to {scope} config',
  'cli.mcpAdd.commandRequired': 'Error: Command is required when server name is provided.',
  'cli.mcpAdd.ifHttp':
    'If this is an HTTP server, use: zy mcp add --transport http {name} {command}',
  'cli.mcpAdd.ifSse': 'If this is an SSE server, use: zy mcp add --transport sse {name} {command}',
  'cli.mcpAdd.looksLikeUrl':
    'Warning: The command "{command}" looks like a URL, but is being interpreted as a stdio server as --transport was not specified.',
  'cli.mcpAdd.nameRequired': 'Error: Server name is required.',
  'cli.mcpAdd.oauthFlagsIgnored':
    'Warning: --client-id, --client-secret, --callback-port, and --xaa are only supported for HTTP/SSE transports and will be ignored for stdio.',
  'cli.mcpAdd.urlRequiredHttp': 'Error: URL is required for HTTP transport.',
  'cli.mcpAdd.urlRequiredSse': 'Error: URL is required for SSE transport.',
  'cli.mcpAdd.usage': 'Usage: zy mcp add <name> <command> [args...]',
  'cli.mcpAdd.xaaNotEnabled': 'Error: --xaa requires ZY_CODE_ENABLE_XAA=1 in your environment',
  'cli.mcpAdd.xaaRequires': 'Error: --xaa requires: {missing}',
  'cli.mcpBlockedByPolicy_one': 'Warning: MCP server blocked by enterprise policy: {servers}',
  'cli.mcpBlockedByPolicy_other': 'Warning: MCP servers blocked by enterprise policy: {servers}',
  'cli.mcpReservedName': 'Invalid MCP configuration: "{name}" is a reserved MCP name.',
  'cli.mustBeOneOf': 'It must be one of: {values}',
  'cli.noSessionPersistencePrintOnly':
    'Error: --no-session-persistence can only be used with --print mode.',
  'cli.printRequiresInput':
    'Error: Input must be provided either through stdin or as a prompt argument when using --print',
  'cli.replayUserMessagesRequiresStreamJson':
    'Error: --replay-user-messages requires both --input-format=stream-json and --output-format=stream-json.',
  'cli.resumeFailed': 'Failed to resume session {sessionId}',
  'cli.resumeLoadTranscriptFailed': 'Unable to load transcript from file: {file}',
  'cli.resumeSessionAtRequiresResume': 'Error: --resume-session-at requires --resume',
  'cli.resumeSessionNotFound': 'No conversation found with session ID: {sessionId}',
  'cli.rewindFilesNotUserMessage':
    'Error: --rewind-files requires a user message UUID, but {uuid} is not a user message in this session',
  'cli.rewindFilesRequiresResume': 'Error: --rewind-files requires --resume',
  'cli.rewindFilesStandalone':
    'Error: --rewind-files is a standalone operation and cannot be used with a prompt',
  'cli.sandboxDisabled': 'Sandbox disabled: {reason}',
  'cli.sandboxDisabledWarning':
    'Commands will run WITHOUT sandboxing. Network and filesystem restrictions will NOT be enforced.',
  'cli.sandboxError': 'Sandbox Error: {error}',
  'cli.sandboxFailIfUnavailable':
    'sandbox.failIfUnavailable is set — refusing to start without a working sandbox.',
  'cli.sandboxRequiredUnavailable': 'Error: sandbox required but unavailable: {reason}',
  'cli.sessionEndHookFailed': 'SessionEnd hook [{command}] failed: {output}',
  'cli.sshNoPrintMode': 'Error: headless (-p/--print) mode is not supported with zy ssh',
  'cli.streamJsonRequiresVerbose':
    'Error: When using --print, --output-format=stream-json requires --verbose',
  'cli.taskBudgetInvalid': '--task-budget must be a positive integer',
  'cli.unexpectedError': 'Unexpected error',
  'config.backupExists': 'A backup file exists at: {backup}',
  'config.corrupted': 'Zy configuration file at {file} is corrupted: {error}',
  'config.corruptedAlreadyBackedUp': 'The corrupted file has already been backed up.',
  'config.corruptedBackedUp': 'The corrupted file has been backed up to: {backup}',
  'config.fileNotFound': 'Zy configuration file not found at: {file}',
  'config.restoreHint': 'You can manually restore it by running: cp "{backup}" "{file}"',
  'print.executionError': 'Execution error',
  'print.maxBudget': 'Error: Exceeded USD budget ({budget})',
  'print.maxTurns': 'Error: Reached max turns ({maxTurns})',
  'print.structuredOutputRetries':
    'Error: Failed to provide valid structured output after maximum retries',
}
