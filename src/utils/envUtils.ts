import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Checks if this is an internal (zy-super) build.
 * Internal builds have access to extra features like model overrides,
 * internal tools, and shorter GrowthBook refresh intervals.
 */
export function isInternalBuild(): boolean {
  return process.env.USER_TYPE === 'zy-super'
}

/**
 * Returns the raw USER_TYPE value ('zy-super' or 'external').
 * USER_TYPE is replaced at build time by the bundler's --define config.
 */
export function getUserType(): string {
  return process.env.USER_TYPE || 'external'
}

/**
 * Checks if the current environment is a test environment.
 * NODE_ENV is replaced at build time by esbuild's define config.
 */
export function isTestEnv(): boolean {
  return process.env.NODE_ENV === 'test'
}

/**
 * Checks if the current environment is a development environment.
 * NODE_ENV is replaced at build time by esbuild's define config.
 */
export function isDevEnv(): boolean {
  return process.env.NODE_ENV === 'development'
}

// Memoized: 150+ callers, many on hot paths. Keyed off ZY_CONFIG_DIR so
// tests that change the env var get a fresh value without explicit cache.clear.
export const getZyConfigHomeDir = memoize(
  (): string => {
    return (process.env.ZY_CONFIG_DIR ?? join(homedir(), '.zy')).normalize('NFC')
  },
  () => process.env.ZY_CONFIG_DIR,
)

export function getTeamsDir(): string {
  return join(getZyConfigHomeDir(), 'teams')
}

/**
 * Check if NODE_OPTIONS contains a specific flag.
 * Splits on whitespace and checks for exact match to avoid false positives.
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }
  return nodeOptions.split(/\s+/).includes(flag)
}

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false
  if (typeof envVar === 'boolean') return envVar
  const normalizedValue = envVar.toLowerCase().trim()
  return ['1', 'true', 'yes', 'on'].includes(normalizedValue)
}

export function isEnvDefinedFalsy(envVar: string | boolean | undefined): boolean {
  if (envVar === undefined) return false
  if (typeof envVar === 'boolean') return !envVar
  if (!envVar) return false
  const normalizedValue = envVar.toLowerCase().trim()
  return ['0', 'false', 'no', 'off'].includes(normalizedValue)
}

/**
 * --bare / ZY_CODE_SIMPLE — skip hooks, LSP, plugin sync, skill dir-walk,
 * attribution, background prefetches, and ALL keychain/credential reads.
 * Auth is strictly ZY_API_KEY env or apiKeyHelper from --settings.
 * Explicit CLI flags (--plugin-dir, --add-dir, --mcp-config) still honored.
 * ~30 gates across the codebase.
 *
 * Checks argv directly (in addition to the env var) because several gates
 * run before main.tsx's action handler sets ZY_CODE_SIMPLE=1 from --bare
 * — notably startKeychainPrefetch() at main.tsx top-level.
 */
export function isBareMode(): boolean {
  return isEnvTruthy(process.env.ZY_CODE_SIMPLE) || process.argv.includes('--bare')
}

/**
 * Parses an array of environment variable strings into a key-value object
 * @param envVars Array of strings in KEY=VALUE format
 * @returns Object with key-value pairs
 */
export function parseEnvVars(rawEnvArgs: string[] | undefined): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  // Parse individual env vars
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split('=')
      if (!key || valueParts.length === 0) {
        throw new Error(
          `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
        )
      }
      parsedEnv[key] = valueParts.join('=')
    }
  }
  return parsedEnv
}

/**
 * Check if bash commands should maintain project working directory (reset to original after each command)
 * @returns true if CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR is set to a truthy value
 */
export function shouldMaintainProjectWorkingDir(): boolean {
  return isEnvTruthy(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)
}

/**
 * Check if running on Homespace (ant-internal cloud environment)
 */
export function isRunningOnHomespace(): boolean {
  return isInternalBuild() && isEnvTruthy(process.env.COO_RUNNING_ON_HOMESPACE)
}

/**
 * Conservative check for whether ZY Code is running inside a protected
 * (privileged or ASL3+) COO namespace or cluster.
 *
 * Conservative means: when signals are ambiguous, assume protected. We would
 * rather over-report protected usage than miss it. Unprotected environments
 * are homespace, namespaces on the open allowlist, and no k8s/COO signals
 * at all (laptop/local dev).
 *
 * Used for telemetry to measure auto-mode usage in sensitive environments.
 */
export function isInProtectedNamespace(): boolean {
  // USER_TYPE is build-time --define'd; in external builds this block is
  // DCE'd so the require() and namespace allowlist never appear in the bundle.
  if (isInternalBuild()) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return (
      require('./protectedNamespace.js') as typeof import('./protectedNamespace.js')
    ).checkProtectedNamespace()
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
  return false
}
