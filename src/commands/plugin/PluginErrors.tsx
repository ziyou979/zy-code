import { tSync } from '../../i18n/index.js'
import { getPluginErrorMessage, type PluginError } from '../../services/plugins/types.js'
export function formatErrorMessage(error: PluginError): string {
  switch (error.type) {
    case 'path-not-found':
      return `${error.component} path not found: ${error.path}`
    case 'git-auth-failed':
      return `Git ${error.authType.toUpperCase()} authentication failed for ${error.gitUrl}`
    case 'git-timeout':
      return `Git ${error.operation} timed out for ${error.gitUrl}`
    case 'network-error':
      return `Network error accessing ${error.url}${error.details ? `: ${error.details}` : ''}`
    case 'manifest-parse-error':
      return `Failed to parse manifest at ${error.manifestPath}: ${error.parseError}`
    case 'manifest-validation-error':
      return `Invalid manifest at ${error.manifestPath}: ${error.validationErrors.join(', ')}`
    case 'plugin-not-found':
      return `Plugin "${error.pluginId}" not found in marketplace "${error.marketplace}"`
    case 'marketplace-not-found':
      return `Marketplace "${error.marketplace}" not found`
    case 'marketplace-load-failed':
      return `Failed to load marketplace "${error.marketplace}": ${error.reason}`
    case 'mcp-config-invalid':
      return `Invalid MCP server config for "${error.serverName}": ${error.validationError}`
    case 'mcp-server-suppressed-duplicate': {
      const dup = error.duplicateOf.startsWith('plugin:')
        ? `server provided by plugin "${error.duplicateOf.split(':')[1] ?? '?'}"`
        : `already-configured "${error.duplicateOf}"`
      return `MCP server "${error.serverName}" skipped — same command/URL as ${dup}`
    }
    case 'hook-load-failed':
      return `Failed to load hooks from ${error.hookPath}: ${error.reason}`
    case 'component-load-failed':
      return `Failed to load ${error.component} from ${error.path}: ${error.reason}`
    case 'mcpb-download-failed':
      return `Failed to download MCPB from ${error.url}: ${error.reason}`
    case 'mcpb-extract-failed':
      return `Failed to extract MCPB ${error.mcpbPath}: ${error.reason}`
    case 'mcpb-invalid-manifest':
      return `MCPB manifest invalid at ${error.mcpbPath}: ${error.validationError}`
    case 'marketplace-blocked-by-policy':
      return error.blockedByBlocklist
        ? `Marketplace "${error.marketplace}" is blocked by enterprise policy`
        : `Marketplace "${error.marketplace}" is not in the allowed marketplace list`
    case 'dependency-unsatisfied':
      return error.reason === 'not-enabled'
        ? `Dependency "${error.dependency}" is disabled`
        : `Dependency "${error.dependency}" is not installed`
    case 'lsp-config-invalid':
      return `Invalid LSP server config for "${error.serverName}": ${error.validationError}`
    case 'lsp-server-start-failed':
      return `LSP server "${error.serverName}" failed to start: ${error.reason}`
    case 'lsp-server-crashed':
      return error.signal
        ? `LSP server "${error.serverName}" crashed with signal ${error.signal}`
        : `LSP server "${error.serverName}" crashed with exit code ${error.exitCode ?? 'unknown'}`
    case 'lsp-request-timeout':
      return `LSP server "${error.serverName}" timed out on ${error.method} after ${error.timeoutMs}ms`
    case 'lsp-request-failed':
      return `LSP server "${error.serverName}" ${error.method} failed: ${error.error}`
    case 'plugin-cache-miss':
      return `Plugin "${error.plugin}" not cached at ${error.installPath}`
    case 'generic-error':
      return error.error
  }
  const _exhaustive: never = error
  return getPluginErrorMessage(_exhaustive)
}
export function getErrorGuidance(error: PluginError): string | null {
  switch (error.type) {
    case 'path-not-found':
      return tSync('pluginErr.pathNotFound')
    case 'git-auth-failed':
      return error.authType === 'ssh'
        ? tSync('pluginErr.gitAuthFailedSsh')
        : tSync('pluginErr.gitAuthFailedHttps')
    case 'git-timeout':
    case 'network-error':
      return tSync('pluginErr.networkTimeout')
    case 'manifest-parse-error':
      return tSync('pluginErr.manifestParse')
    case 'manifest-validation-error':
      return tSync('pluginErr.manifestValidation')
    case 'plugin-not-found':
      return tSync('pluginErr.pluginNotFound', { marketplace: error.marketplace })
    case 'marketplace-not-found':
      return error.availableMarketplaces.length > 0
        ? tSync('pluginErr.marketplaceNotFoundAvailable', {
            marketplaces: error.availableMarketplaces.join(', '),
          })
        : tSync('pluginErr.marketplaceNotFoundNone')
    case 'mcp-config-invalid':
      return tSync('pluginErr.mcpConfigInvalid')
    case 'mcp-server-suppressed-duplicate': {
      // duplicateOf is "plugin:name:srv" when another plugin won dedup —
      // users can't remove plugin-provided servers from their MCP config,
      // so point them at the winning plugin instead.
      if (error.duplicateOf.startsWith('plugin:')) {
        const winningPlugin = error.duplicateOf.split(':')[1] ?? 'the other plugin'
        return tSync('pluginErr.mcpSuppressedPlugin', { plugin: winningPlugin })
      }
      return tSync('pluginErr.mcpSuppressedConfig', { server: error.duplicateOf })
    }
    case 'hook-load-failed':
      return tSync('pluginErr.hookLoadFailed')
    case 'component-load-failed':
      return tSync('pluginErr.componentLoadFailed', { component: error.component })
    case 'mcpb-download-failed':
      return tSync('pluginErr.mcpbDownloadFailed')
    case 'mcpb-extract-failed':
      return tSync('pluginErr.mcpbExtractFailed')
    case 'mcpb-invalid-manifest':
      return tSync('pluginErr.mcpbInvalidManifest')
    case 'marketplace-blocked-by-policy':
      if (error.blockedByBlocklist) {
        return tSync('pluginErr.marketplaceBlockedByPolicy')
      }
      return error.allowedSources.length > 0
        ? tSync('pluginErr.marketplaceAllowedSources', {
            sources: error.allowedSources.join(', '),
          })
        : tSync('pluginErr.marketplaceNoSources')
    case 'dependency-unsatisfied':
      return error.reason === 'not-enabled'
        ? tSync('pluginErr.dependencyNotEnabled', {
            dependency: error.dependency,
            plugin: error.plugin,
          })
        : tSync('pluginErr.dependencyNotInstalled', {
            dependency: error.dependency,
            plugin: error.plugin,
          })
    case 'lsp-config-invalid':
      return tSync('pluginErr.lspConfigInvalid')
    case 'lsp-server-start-failed':
    case 'lsp-server-crashed':
    case 'lsp-request-timeout':
    case 'lsp-request-failed':
      return tSync('pluginErr.lspServerFailed')
    case 'plugin-cache-miss':
      return tSync('pluginErr.pluginCacheMiss')
    case 'marketplace-load-failed':
    case 'generic-error':
      return null
  }
  const _exhaustive: never = error
  return null
}
