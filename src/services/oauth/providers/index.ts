/**
 * OAuth Provider 模块入口
 *
 * 统一导出所有 provider 实现、注册表 API 和类型定义。
 */

// Anthropic
export { anthropicOAuthProvider, loginAnthropic, refreshAnthropicToken } from './anthropic.js'

// Device Code（RFC 8628）
export * from './deviceCode.js'

// GitHub Copilot
export {
  getGitHubCopilotBaseUrl,
  githubCopilotOAuthProvider,
  loginGitHubCopilot,
  normalizeDomain,
  refreshGitHubCopilotToken,
} from './githubCopilot.js'

// OpenAI Codex
export {
  loginOpenAICodex,
  loginOpenAICodexDeviceCode,
  OPENAI_CODEX_BROWSER_LOGIN_METHOD,
  OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD,
  openaiCodexOAuthProvider,
  refreshOpenAICodexToken,
} from './openaiCodex.js'

// xAI Grok OAuth（SuperGrok / X Premium+）
export {
  DEFAULT_XAI_API_BASE_URL,
  discoverXaiOAuth,
  loginXaiOAuth,
  refreshXaiOAuthToken,
  validateXaiOAuthEndpoint,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_DEVICE_CODE_URL,
  XAI_OAUTH_DISCOVERY_URL,
  XAI_OAUTH_ISSUER,
  XAI_OAUTH_SCOPE,
  xaiOAuthProvider,
  type XaiOAuthCredentials,
} from './xai.js'

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
