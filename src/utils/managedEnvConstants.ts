/**
 * Environment variables that control inference routing: which provider to use,
 * which endpoint to hit, and which model IDs to send.
 *
 * When ZY_CODE_PROVIDER_MANAGED_BY_HOST is truthy in the spawn env, these
 * are stripped from settings-sourced env so the host's routing config isn't
 * overridden by a user's ~/.zy/settings.json — e.g. a Bedrock setup for
 * terminal CLI that would break a host that only supports direct auth.
 *
 * @[MODEL LAUNCH]: New models usually don't need changes here —
 * VERTEX_REGION_CLAUDE_* is prefix-matched. New providers or new routing
 * config vars (endpoint, project, region, auth) do.
 */
const PROVIDER_MANAGED_ENV_VARS = new Set([
  // The flag itself — settings can't unset it once the host set it
  'ZY_CODE_PROVIDER_MANAGED_BY_HOST',
  // Endpoint config (base URLs, project/resource identifiers)
  'ZY_CODE_BASE_URL',
  'ANTHROPIC_BASE_URL', // 向后兼容
  // Auth
  'ZY_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ZY_CODE_OAUTH_TOKEN',
  // Model defaults — often set to provider-specific ID formats
  'ZY_CODE_MODEL',
  'ZY_CODE_DEFAULT_COMPACT_MODEL',
  'ZY_CODE_DEFAULT_BEST_MODEL',
  'ZY_CODE_DEFAULT_ADVANCED_MODEL',
  'ZY_CODE_SUBAGENT_MODEL',
])

const PROVIDER_MANAGED_ENV_PREFIXES = [
  // Per-model Vertex region overrides — scales with model releases, so
  // prefix-matched to avoid drift on each launch.
  'VERTEX_REGION_CLAUDE_',
]

export function isProviderManagedEnvVar(key: string): boolean {
  const upper = key.toUpperCase()
  return (
    PROVIDER_MANAGED_ENV_VARS.has(upper) ||
    PROVIDER_MANAGED_ENV_PREFIXES.some((p) => upper.startsWith(p))
  )
}

/**
 * Dangerous shell settings that can execute arbitrary shell code
 */
export const DANGEROUS_SHELL_SETTINGS = [
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
] as const

/**
 * Safe environment variables that can be applied before trust dialog.
 * These are ZY Code specific settings that don't pose security risks.
 *
 * IMPORTANT: This is the source of truth for which env vars are safe.
 * Any env var NOT in this list is considered dangerous and will trigger
 * a security dialog when set via remote managed settings.
 *
 * Dangerous env vars (NOT in this list):
 *
 * === REDIRECT TO ATTACKER-CONTROLLED SERVER ===
 * - ZY_CODE_BASE_URL (formerly ANTHROPIC_BASE_URL), ANTHROPIC_BEDROCK_BASE_URL, ANTHROPIC_VERTEX_BASE_URL
 * - HTTP_PROXY, HTTPS_PROXY, NO_PROXY, http_proxy, https_proxy, no_proxy
 * - OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
 *
 * === TRUST ATTACKER-CONTROLLED SERVER ===
 * - NODE_TLS_REJECT_UNAUTHORIZED
 * - NODE_EXTRA_CA_CERTS
 *
 * === SWITCH TO ATTACKER-CONTROLLED PROJECT ===
 * - ZY_API_KEY, ANTHROPIC_AUTH_TOKEN
 * - AWS_BEARER_TOKEN_BEDROCK
 */
export const SAFE_ENV_VARS = new Set([
  'ZY_CODE_CUSTOM_HEADERS',
  'ZY_CODE_CUSTOM_MODEL_OPTION',
  'ZY_CODE_CUSTOM_MODEL_OPTION_DESCRIPTION',
  'ZY_CODE_CUSTOM_MODEL_OPTION_NAME',
  'ZY_CODE_DEFAULT_COMPACT_MODEL',
  'ZY_CODE_DEFAULT_BEST_MODEL',
  'ZY_CODE_DEFAULT_ADVANCED_MODEL',
  'ZY_CODE_MODEL',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_REGION',
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_OUTPUT_LENGTH',
  'BASH_MAX_TIMEOUT_MS',
  'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR',
  'ZY_CODE_API_KEY_HELPER_TTL_MS',
  'ZY_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'ZY_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'ZY_CODE_DISABLE_TERMINAL_TITLE',
  'ZY_CODE_ENABLE_TELEMETRY',
  'ZY_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'ZY_CODE_IDE_SKIP_AUTO_INSTALL',
  'ZY_CODE_MAX_OUTPUT_TOKENS',
  'ZY_CODE_SUBAGENT_MODEL',
  'DISABLE_AUTOUPDATER',
  'DISABLE_BUG_COMMAND',
  'DISABLE_COST_WARNINGS',
  'DISABLE_ERROR_REPORTING',
  'DISABLE_FEEDBACK_COMMAND',
  'DISABLE_TELEMETRY',
  'ENABLE_TOOL_SEARCH',
  'MAX_MCP_OUTPUT_TOKENS',
  'MAX_THINKING_TOKENS',
  'MCP_TIMEOUT',
  'MCP_TOOL_TIMEOUT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOGS_EXPORT_INTERVAL',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_METRICS_EXPORTER',
  'OTEL_METRICS_INCLUDE_ACCOUNT_UUID',
  'OTEL_METRICS_INCLUDE_SESSION_ID',
  'OTEL_METRICS_INCLUDE_VERSION',
  'OTEL_RESOURCE_ATTRIBUTES',
  'VERTEX_REGION_CLAUDE_3_5_HAIKU',
  'VERTEX_REGION_CLAUDE_3_5_SONNET',
  'VERTEX_REGION_CLAUDE_3_7_SONNET',
  'VERTEX_REGION_CLAUDE_4_0_OPUS',
  'VERTEX_REGION_CLAUDE_4_0_SONNET',
  'VERTEX_REGION_CLAUDE_4_1_OPUS',
  'VERTEX_REGION_CLAUDE_4_5_SONNET',
  'VERTEX_REGION_CLAUDE_4_6_SONNET',
  'VERTEX_REGION_CLAUDE_HAIKU_4_5',
])
