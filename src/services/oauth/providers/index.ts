/**
 * OAuth Provider 模块入口
 *
 * 统一导出所有 provider 实现、注册表 API 和类型定义。
 */

// Anthropic
export { anthropicOAuthProvider, loginAnthropic, refreshAnthropicToken } from './anthropic.js'

// Device Code（RFC 8628）
export * from './device-code.js'

// GitHub Copilot
export {
  getGitHubCopilotBaseUrl,
  githubCopilotOAuthProvider,
  loginGitHubCopilot,
  normalizeDomain,
  refreshGitHubCopilotToken,
} from './github-copilot.js'

// OpenAI Codex
export {
  loginOpenAICodex,
  loginOpenAICodexDeviceCode,
  OPENAI_CODEX_BROWSER_LOGIN_METHOD,
  OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD,
  openaiCodexOAuthProvider,
  refreshOpenAICodexToken,
} from './openai-codex.js'

// PKCE
export { generatePKCE } from './pkce.js'

// 注册表
export {
  getOAuthApiKey,
  getOAuthProvider,
  getOAuthProviders,
  registerOAuthProvider,
  resetOAuthProviders,
  unregisterOAuthProvider,
} from './registry.js'

// 类型
export * from './types.js'
