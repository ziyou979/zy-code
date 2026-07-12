/**
 * Plugin option storage and substitution.
 *
 * Plugins declare user-configurable options in `manifest.userConfig` — a record
 * of field schemas matching `McpbUserConfigurationOption`. At enable time the
 * user is prompted for values. Storage splits by `sensitive`:
 *   - `sensitive: true`  → secureStorage (keychain on macOS, .credentials.json elsewhere)
 *   - everything else    → settings.json `pluginConfigs[pluginId].options`
 *
 * `loadPluginOptions` reads and merges both. The substitution helpers are also
 * here (moved from mcpPluginIntegration.ts) so hooks/LSP/skills don't all
 * import from MCP-specific code.
 */

import memoize from 'lodash-es/memoize.js'
import { getSecureStorage } from 'src/services/secureStorage/index.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import type { SettingSource } from '../../utils/settings/constants.js'
import {
  getInitialSettings,
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { type UserConfigSchema, type UserConfigValues, validateUserConfig } from './mcpbHandler.js'
import { getPluginDataDir } from './pluginDirectories.js'

export type PluginOptionValues = UserConfigValues
export type PluginOptionSchema = UserConfigSchema

/**
 * pluginConfigs 仅从这些源读取（对齐 Claude Code 2.1.207）。
 * projectSettings / localSettings 为仓库可控，不得影响插件选项（注入/改行为面）。
 * 合并顺序：user → flag → policy（后者覆盖前者）。
 */
export const TRUSTED_PLUGIN_CONFIG_SOURCES: readonly SettingSource[] = [
  'userSettings',
  'flagSettings',
  'policySettings',
]

/**
 * 从可信 settings 源合并 pluginConfigs[pluginId].options。
 * 不读 project/local，也不使用 getInitialSettings() 的全量合并结果。
 */
export function loadTrustedPluginConfigOptions(pluginId: string): PluginOptionValues {
  let merged: PluginOptionValues = {}
  for (const source of TRUSTED_PLUGIN_CONFIG_SOURCES) {
    const options = getSettingsForSource(source)?.pluginConfigs?.[pluginId]?.options
    if (options && typeof options === 'object') {
      merged = { ...merged, ...options }
    }
  }
  return merged
}

/**
 * Canonical storage key for a plugin's options in both `settings.pluginConfigs`
 * and `secureStorage.pluginSecrets`. Today this is `plugin.source` — always
 * `"${name}@${marketplace}"` (pluginLoader.ts:1400). `plugin.repository` is
 * a backward-compat alias that's set to the same string (1401); don't use it
 * for storage. UI code that manually constructs `` `${name}@${marketplace}` ``
 * produces the same key by convention — see PluginOptionsFlow, ManagePlugins.
 *
 * Exists so there's exactly one place to change if the key format ever drifts.
 */
export function getPluginStorageId(plugin: LoadedPlugin): string {
  return plugin.source
}

/**
 * Load saved option values for a plugin, merging non-sensitive (from settings)
 * with sensitive (from secureStorage). SecureStorage wins on key collision.
 *
 * Memoized per-pluginId because hooks can fire per-tool-call and each call
 * would otherwise do a settings read + keychain spawn. Cache cleared via
 * `clearPluginOptionsCache` when settings change or plugins reload.
 *
 * 非敏感选项只从 user / flag / policy 读取（见 TRUSTED_PLUGIN_CONFIG_SOURCES）。
 */
export const loadPluginOptions = memoize((pluginId: string): PluginOptionValues => {
  const nonSensitive = loadTrustedPluginConfigOptions(pluginId)

  // NOTE: storage.read() spawns `security find-generic-password` on macOS
  // (~50-100ms, synchronous). Mitigated by the memoize above (per-pluginId,
  // session-lifetime) + keychain's own 30s TTL cache — so one blocking spawn
  // per session per plugin-with-options. /reload-plugins clears the memoize
  // and the next hook/MCP-load after that eats a fresh spawn.
  const storage = getSecureStorage()
  const sensitive =
    // biome-ignore lint/suspicious/noExplicitAny: 插件动态加载类型处理
    (storage as any).read()?.pluginSecrets?.[pluginId] ?? ({} as Record<string, string>)

  // secureStorage wins on collision — schema determines destination so
  // collision shouldn't happen, but if a user hand-edits settings.json we
  // trust the more secure source.
  return { ...nonSensitive, ...sensitive }
})

export function clearPluginOptionsCache(): void {
  loadPluginOptions.cache?.clear?.()
}

/**
 * Save option values, splitting by `schema[key].sensitive`. Non-sensitive go
 * to userSettings; sensitive go to secureStorage. Writes are skipped if nothing
 * in that category is present.
 *
 * Clears the load cache on success so the next `loadPluginOptions` sees fresh.
 */
export function savePluginOptions(
  pluginId: string,
  values: PluginOptionValues,
  schema: PluginOptionSchema,
): void {
  const nonSensitive: PluginOptionValues = {}
  const sensitive: Record<string, string> = {}

  for (const [key, value] of Object.entries(values)) {
    if (schema[key]?.sensitive === true) {
      sensitive[key] = String(value)
    } else {
      nonSensitive[key] = value
    }
  }

  // Scrub sets — see saveMcpServerUserConfig (mcpbHandler.ts) for the
  // rationale. Only keys in THIS save are scrubbed from the other store,
  // so partial reconfigures don't lose data.
  const sensitiveKeysInThisSave = new Set(Object.keys(sensitive))
  const nonSensitiveKeysInThisSave = new Set(Object.keys(nonSensitive))

  // secureStorage FIRST — if keychain fails, throw before touching
  // settings.json so old plaintext (if any) stays as fallback.
  const storage = getSecureStorage()
  // biome-ignore lint/suspicious/noExplicitAny: 插件动态加载类型处理
  const existingInSecureStorage = (storage as any).read()?.pluginSecrets?.[pluginId] ?? undefined
  const secureScrubbed = existingInSecureStorage
    ? Object.fromEntries(
        Object.entries(existingInSecureStorage).filter(([k]) => !nonSensitiveKeysInThisSave.has(k)),
      )
    : undefined
  const needSecureScrub =
    secureScrubbed &&
    existingInSecureStorage &&
    Object.keys(secureScrubbed).length !== Object.keys(existingInSecureStorage).length
  if (Object.keys(sensitive).length > 0 || needSecureScrub) {
    // biome-ignore lint/suspicious/noExplicitAny: 插件动态加载类型处理
    const existing = (storage as any).read() ?? {}
    if (!existing.pluginSecrets) {
      existing.pluginSecrets = {}
    }
    existing.pluginSecrets[pluginId] = {
      ...secureScrubbed,
      ...sensitive,
    }
    // biome-ignore lint/suspicious/noExplicitAny: 插件动态加载类型处理
    const result = (storage as any).update(existing)
    if (!result.success) {
      const err = new Error(
        `Failed to save sensitive plugin options for ${pluginId} to secure storage`,
      )
      logError(err)
      throw err
    }
    if (result.warning) {
      logForDebugging(`Plugin secrets save warning: ${result.warning}`, {
        level: 'warn',
      })
    }
  }

  // settings.json AFTER secureStorage — scrub sensitive keys via explicit
  // undefined (mergeWith deletion pattern)。
  // 只读写 userSettings 上的 pluginConfigs，避免把 project/local 合并结果写回用户配置。
  const existingInSettings =
    getSettingsForSource('userSettings')?.pluginConfigs?.[pluginId]?.options ?? {}
  const keysToScrubFromSettings = Object.keys(existingInSettings).filter((k) =>
    sensitiveKeysInThisSave.has(k),
  )
  if (Object.keys(nonSensitive).length > 0 || keysToScrubFromSettings.length > 0) {
    const scrubbed = Object.fromEntries(
      keysToScrubFromSettings.map((k) => [k, undefined]),
    ) as Record<string, undefined>
    const result = updateSettingsForSource('userSettings', {
      pluginConfigs: {
        [pluginId]: {
          options: {
            ...nonSensitive,
            ...scrubbed,
          } as PluginOptionValues,
        },
      },
    })
    if (result.error) {
      logError(result.error)
      throw new Error(`Failed to save plugin options for ${pluginId}: ${result.error.message}`)
    }
  }

  clearPluginOptionsCache()
}

/**
 * Delete all stored option values for a plugin — both the non-sensitive
 * `settings.pluginConfigs[pluginId]` entry and the sensitive
 * `secureStorage.pluginSecrets[pluginId]` entry.
 *
 * Call this when the LAST installation of a plugin is uninstalled (i.e.,
 * alongside `markPluginVersionOrphaned`). Don't call on every uninstall —
 * a plugin can be installed in multiple scopes and the user's config should
 * survive removing it from one scope while it remains in another.
 *
 * Best-effort: keychain write failure is logged but doesn't throw, since
 * the uninstall itself succeeded and we don't want to surface a confusing
 * "uninstall failed" message for a cleanup side-effect.
 */
export function deletePluginOptions(pluginId: string): void {
  // Settings side — also wipes the legacy mcpServers sub-key (same story:
  // orphaned on uninstall, never cleaned up before this PR).
  //
  // Use `undefined` (not `delete`) because `updateSettingsForSource` merges
  // via `mergeWith` — absent keys are ignored, only `undefined` triggers
  // removal. Cast is deliberate (AGENTS.md's 10% case): adding z.undefined()
  // to the schema instead (like enabledPlugins:466 does) leaks
  // `| {[k: string]: unknown}` into the public SDK type, which subsumes the
  // real object arm and kills excess-property checks for SDK consumers. The
  // mergeWith-deletion contract is internal plumbing — it shouldn't shape
  // the Zod schema. enabledPlugins gets away with it only because its other
  // arms (string[] | boolean) are non-objects that stay distinct.
  const settings = getInitialSettings()
  type PluginConfigs = NonNullable<typeof settings.pluginConfigs>
  if (settings.pluginConfigs?.[pluginId]) {
    // Partial<Record<K,V>> = Record<K, V | undefined> — gives us the widening
    // for the undefined value, and Partial-of-X overlaps with X so the cast
    // is a narrowing TS accepts (same approach as marketplaceManager.ts:1795).
    const pluginConfigs: Partial<PluginConfigs> = { [pluginId]: undefined }
    const { error } = updateSettingsForSource('userSettings', {
      pluginConfigs: pluginConfigs as PluginConfigs,
    })
    if (error) {
      logForDebugging(
        `deletePluginOptions: failed to clear settings.pluginConfigs[${pluginId}]: ${error.message}`,
        { level: 'warn' },
      )
    }
  }

  // Secure storage side — delete both the top-level pluginSecrets[pluginId]
  // and any per-server composite keys `${pluginId}/${server}` (from
  // saveMcpServerUserConfig's sensitive split). `/` prefix match is safe:
  // plugin IDs are `name@marketplace`, never contain `/`, so
  // startsWith(`${id}/`) can't false-positive on a different plugin.
  const storage = getSecureStorage()
  // biome-ignore lint/suspicious/noExplicitAny: 插件动态加载类型处理
  const existing = (storage as any).read()
  if (existing?.pluginSecrets) {
    const prefix = `${pluginId}/`
    const survivingEntries = Object.entries(existing.pluginSecrets).filter(
      ([k]) => k !== pluginId && !k.startsWith(prefix),
    )
    if (survivingEntries.length !== Object.keys(existing.pluginSecrets).length) {
      // biome-ignore lint/suspicious/noExplicitAny: 插件动态加载类型处理
      const result = (storage as any).update({
        ...existing,
        pluginSecrets:
          survivingEntries.length > 0 ? Object.fromEntries(survivingEntries) : undefined,
      })
      if (!result.success) {
        logForDebugging(
          `deletePluginOptions: failed to clear pluginSecrets for ${pluginId} from keychain`,
          { level: 'warn' },
        )
      }
    }
  }

  clearPluginOptionsCache()
}

/**
 * Find option keys whose saved values don't satisfy the schema — i.e., what to
 * prompt for. Returns the schema slice for those keys, or empty if everything
 * validates. Empty manifest.userConfig → empty result.
 *
 * Used by PluginOptionsFlow to decide whether to show the prompt after enable.
 */
export function getUnconfiguredOptions(plugin: LoadedPlugin): PluginOptionSchema {
  const manifestSchema = plugin.manifest.userConfig
  if (!manifestSchema || Object.keys(manifestSchema).length === 0) {
    return {}
  }

  const saved = loadPluginOptions(getPluginStorageId(plugin))
  const validation = validateUserConfig(saved, manifestSchema)
  if (validation.valid) {
    return {}
  }

  // Return only the fields that failed. validateUserConfig reports errors as
  // strings keyed by title/key — simpler to just re-check each field here than
  // parse error strings.
  const unconfigured: PluginOptionSchema = {}
  for (const [key, fieldSchema] of Object.entries(manifestSchema)) {
    const single = validateUserConfig({ [key]: saved[key] } as PluginOptionValues, {
      [key]: fieldSchema,
    })
    if (!single.valid) {
      unconfigured[key] = fieldSchema
    }
  }
  return unconfigured
}

/**
 * Substitute ${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_PLUGIN_DATA} with their paths.
 * On Windows, normalizes backslashes to forward slashes so shell commands
 * don't interpret them as escape characters.
 *
 * ${CLAUDE_PLUGIN_ROOT} — version-scoped install dir (recreated on update)
 * ${CLAUDE_PLUGIN_DATA} — persistent state dir (survives updates)
 *
 * Both patterns use the function-replacement form of .replace(): ROOT so
 * `$`-patterns in NTFS paths ($$, $', $`, $&) aren't interpreted; DATA so
 * getPluginDataDir (which lazily mkdirs) only runs when actually present.
 *
 * Used in MCP/LSP server command/args/env, hook commands, skill/agent content.
 */
export function substitutePluginVariables(
  value: string,
  plugin: { path: string; source?: string },
): string {
  const normalize = (p: string) => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p)
  let out = value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => normalize(plugin.path))
  // source can be absent (e.g. hooks where pluginRoot is a skill root without
  // a plugin context). In that case ${CLAUDE_PLUGIN_DATA} is left literal.
  if (plugin.source) {
    const source = plugin.source
    out = out.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, () => normalize(getPluginDataDir(source)))
  }
  return out
}

/** 匹配 `${user_config.KEY}`（CC 2.1.207 shell 注入防护同源模式） */
const USER_CONFIG_REF_RE = /\$\{user_config\.([^}]+)\}/g

/**
 * 字符串是否包含 `${user_config.*}` 引用。
 * shell-form hook 命令在展开前必须拒绝此类引用（值会经 shell 二次解析）。
 */
export function containsUserConfigRef(value: string): boolean {
  USER_CONFIG_REF_RE.lastIndex = 0
  return USER_CONFIG_REF_RE.test(value)
}

/**
 * Substitute ${user_config.KEY} with saved option values.
 *
 * Throws on missing keys — callers pass this only after `validateUserConfig`
 * succeeded, so a miss here means a plugin references a key it never declared
 * in its schema. That's a plugin authoring bug; failing loud surfaces it.
 *
 * 仅用于 exec-form（argv 字面传递）或非 shell 上下文。shell-form 命令必须先
 * 用 `containsUserConfigRef` 拒绝，改走 exec form 或 `$CLAUDE_PLUGIN_OPTION_*`。
 *
 * Use `substituteUserConfigInContent` for skill/agent prose — it handles
 * missing keys and sensitive-filtering instead of throwing.
 */
export function substituteUserConfigVariables(
  value: string,
  userConfig: PluginOptionValues,
): string {
  return value.replace(/\$\{user_config\.([^}]+)\}/g, (_match, key) => {
    const configValue = userConfig[key]
    if (configValue === undefined) {
      throw new Error(
        `Missing required user configuration value: ${key}. ` +
          `This should have been validated before variable substitution.`,
      )
    }
    return String(configValue)
  })
}

/**
 * Content-safe variant for skill/agent prose. Differences from
 * `substituteUserConfigVariables`:
 *
 *   - Sensitive-marked keys substitute to a descriptive placeholder instead of
 *     the actual value — skill/agent content goes to the model prompt, and
 *     we don't put secrets in the model's context.
 *   - Unknown keys stay literal (no throw) — matches how `${VAR}` env refs
 *     behave today when the var is unset.
 *
 * A ref to a sensitive key produces obvious-looking output so plugin authors
 * notice and move the ref into a hook/MCP env instead.
 */
export function substituteUserConfigInContent(
  content: string,
  options: PluginOptionValues,
  schema: PluginOptionSchema,
): string {
  return content.replace(/\$\{user_config\.([^}]+)\}/g, (match, key) => {
    if (schema[key]?.sensitive === true) {
      return `[sensitive option '${key}' not available in skill content]`
    }
    const value = options[key]
    if (value === undefined) {
      return match
    }
    return String(value)
  })
}
