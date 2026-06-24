import figures from 'figures'
import * as React from 'react'
import { modelDisplayString } from 'src/services/model/model.js'
import { getAPIProvider } from 'src/services/model/providers.js'
import { checkInstall } from 'src/services/nativeInstaller/index.js'
import { SandboxManager } from 'src/services/sandbox/sandbox-adapter.js'
import { tSync } from '../i18n/index.js'
import { color, Text } from '../ink.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { getLargeMemoryFiles, getMemoryFiles, MAX_MEMORY_CHARACTER_COUNT } from './agentsMd.js'
import { getAccountInformation } from './auth.js'
import { getDoctorDiagnostic } from './doctorDiagnostic.js'
import { isInternalBuild } from './envUtils.js'
import { getDisplayPath } from './file.js'
import { formatNumber } from './format.js'
import {
  getIdeClientName,
  type IDEExtensionInstallationStatus,
  isJetBrainsIde,
  toIDEDisplayName,
} from './ide.js'
import { getMTLSConfig } from './mtls.js'
import { getProxyUrl } from './proxy.js'
import { getSettingsWithAllErrors } from './settings/allErrors.js'
import {
  getEnabledSettingSources,
  getSettingSourceDisplayNameCapitalized,
} from './settings/constants.js'
import {
  getManagedFileSettingsPresence,
  getPolicySettingsOrigin,
  getSettingsForSource,
} from './settings/settings.js'
import type { ThemeName } from './theme.js'
export type Property = {
  label?: string
  value: React.ReactNode | Array<string>
}
export type Diagnostic = React.ReactNode
export function buildSandboxProperties(): Property[] {
  if (!isInternalBuild()) {
    return []
  }
  const isSandboxed = SandboxManager.isSandboxingEnabled()
  return [
    {
      label: tSync('status.bashSandbox'),
      value: isSandboxed ? tSync('status.enabled') : tSync('status.disabled'),
    },
  ]
}
export function buildIDEProperties(
  mcpClients: MCPServerConnection[],
  ideInstallationStatus: IDEExtensionInstallationStatus | null = null,
  theme: ThemeName,
): Property[] {
  const ideClient = mcpClients?.find((client) => client.name === 'ide')
  if (ideInstallationStatus) {
    const ideName = toIDEDisplayName(ideInstallationStatus.ideType)
    const pluginOrExtension = isJetBrainsIde(ideInstallationStatus.ideType) ? 'plugin' : 'extension'
    if (ideInstallationStatus.error) {
      return [
        {
          label: tSync('status.ide'),
          value: (
            <Text>
              {color('error', theme)(figures.cross)} Error installing {ideName} {pluginOrExtension}:{' '}
              {ideInstallationStatus.error}
              {'\n'}Please restart your IDE and try again.
            </Text>
          ),
        },
      ]
    }
    if (ideInstallationStatus.installed) {
      if (ideClient && ideClient.type === 'connected') {
        if (ideInstallationStatus.installedVersion !== ideClient.serverInfo?.version) {
          return [
            {
              label: tSync('status.ide'),
              value: `Connected to ${ideName} ${pluginOrExtension} version ${ideInstallationStatus.installedVersion} (server version: ${ideClient.serverInfo?.version})`,
            },
          ]
        } else {
          return [
            {
              label: tSync('status.ide'),
              value: `Connected to ${ideName} ${pluginOrExtension} version ${ideInstallationStatus.installedVersion}`,
            },
          ]
        }
      } else {
        return [
          {
            label: tSync('status.ide'),
            value: `Installed ${ideName} ${pluginOrExtension}`,
          },
        ]
      }
    }
  } else if (ideClient) {
    const ideName = getIdeClientName(ideClient) ?? 'IDE'
    if (ideClient.type === 'connected') {
      return [
        {
          label: tSync('status.ide'),
          value: `Connected to ${ideName} extension`,
        },
      ]
    } else {
      return [
        {
          label: tSync('status.ide'),
          value: `${color('error', theme)(figures.cross)} Not connected to ${ideName}`,
        },
      ]
    }
  }
  return []
}
export function buildMcpProperties(
  clients: MCPServerConnection[] = [],
  theme: ThemeName,
): Property[] {
  const servers = clients.filter((client) => client.name !== 'ide')
  if (!servers.length) {
    return []
  }

  // Summary instead of a full server list — 20+ servers wrapped onto many
  // rows, dominating the Status pane. Show counts by state + /mcp hint.
  const byState = {
    connected: 0,
    pending: 0,
    needsAuth: 0,
    failed: 0,
  }
  for (const s of servers) {
    if (s.type === 'connected') {
      byState.connected++
    } else if (s.type === 'pending') {
      byState.pending++
    } else if (s.type === 'needs-auth') {
      byState.needsAuth++
    } else {
      byState.failed++
    }
  }
  const parts: string[] = []
  if (byState.connected) {
    parts.push(color('success', theme)(`${byState.connected} connected`))
  }
  if (byState.needsAuth) {
    parts.push(color('warning', theme)(`${byState.needsAuth} need auth`))
  }
  if (byState.pending) {
    parts.push(color('inactive', theme)(`${byState.pending} pending`))
  }
  if (byState.failed) {
    parts.push(color('error', theme)(`${byState.failed} failed`))
  }
  return [
    {
      label: tSync('status.mcpServers'),
      value: `${parts.join(', ')} ${color('inactive', theme)('· /mcp')}`,
    },
  ]
}
export async function buildMemoryDiagnostics(): Promise<Diagnostic[]> {
  const files = await getMemoryFiles()
  const largeFiles = getLargeMemoryFiles(files)
  const diagnostics: Diagnostic[] = []
  largeFiles.forEach((file) => {
    const displayPath = getDisplayPath(file.path)
    diagnostics.push(
      `Large ${displayPath} will impact performance (${formatNumber(file.content.length)} chars > ${formatNumber(MAX_MEMORY_CHARACTER_COUNT)})`,
    )
  })
  return diagnostics
}
export function buildSettingSourcesProperties(): Property[] {
  const enabledSources = getEnabledSettingSources()

  // Filter to only sources that actually have settings loaded
  const sourcesWithSettings = enabledSources.filter((source) => {
    const settings = getSettingsForSource(source)
    return settings !== null && Object.keys(settings).length > 0
  })

  // Map internal names to user-friendly names
  // For policySettings, distinguish between remote and local (or skip if neither exists)
  const sourceNames = sourcesWithSettings
    .map((source) => {
      if (source === 'policySettings') {
        const origin = getPolicySettingsOrigin()
        if (origin === null) {
          return null // Skip - no policy settings exist
        }
        const base = tSync('status.settingSource.policySettings')
        switch (origin) {
          case 'remote':
            return `${base} (remote)`
          case 'plist':
            return `${base} (plist)`
          case 'hklm':
            return `${base} (HKLM)`
          case 'file': {
            const { hasBase, hasDropIns } = getManagedFileSettingsPresence()
            if (hasBase && hasDropIns) {
              return `${base} (file + drop-ins)`
            }
            if (hasDropIns) {
              return `${base} (drop-ins)`
            }
            return `${base} (file)`
          }
          case 'hkcu':
            return `${base} (HKCU)`
        }
      }
      return getSettingSourceDisplayNameCapitalized(source)
    })
    .filter((name): name is string => name !== null)
  return [
    {
      label: tSync('status.settingSources'),
      value: sourceNames,
    },
  ]
}
export async function buildInstallationDiagnostics(): Promise<Diagnostic[]> {
  const installWarnings = await checkInstall()
  return installWarnings.map((warning) => warning.message)
}
export async function buildInstallationHealthDiagnostics(): Promise<Diagnostic[]> {
  const diagnostic = await getDoctorDiagnostic()
  const items: Diagnostic[] = []
  const { errors: validationErrors } = getSettingsWithAllErrors()
  if (validationErrors.length > 0) {
    const invalidFiles = Array.from(new Set(validationErrors.map((error) => error.file)))
    const fileList = invalidFiles.join(', ')
    items.push(`Found invalid settings files: ${fileList}. They will be ignored.`)
  }

  // Add warnings from doctor diagnostic (includes leftover installations, config mismatches, etc.)
  diagnostic.warnings.forEach((warning) => {
    items.push(warning.issue)
  })
  if (diagnostic.hasUpdatePermissions === false) {
    items.push('No write permissions for auto-updates (requires sudo)')
  }
  return items
}
export function buildAccountProperties(): Property[] {
  const accountInfo = getAccountInformation()
  if (!accountInfo) {
    return []
  }
  const properties: Property[] = []
  if (accountInfo.subscription) {
    properties.push({
      label: tSync('status.loginMethod'),
      value: `${accountInfo.subscription} Account`,
    })
  }
  if (accountInfo.tokenSource) {
    properties.push({
      label: tSync('status.authToken'),
      value: accountInfo.tokenSource,
    })
  }
  if (accountInfo.apiKeySource) {
    properties.push({
      label: tSync('status.apiKey'),
      value: accountInfo.apiKeySource,
    })
  }

  // Hide sensitive account info in demo mode
  if (accountInfo.organization && !process.env.IS_DEMO) {
    properties.push({
      label: tSync('status.organization'),
      value: accountInfo.organization,
    })
  }
  if (accountInfo.email && !process.env.IS_DEMO) {
    properties.push({
      label: tSync('status.email'),
      value: accountInfo.email,
    })
  }
  return properties
}
export function buildAPIProviderProperties(): Property[] {
  const apiProvider = getAPIProvider()
  const properties: Property[] = []
  if (apiProvider !== 'anthropic') {
    const providerLabel = {
      bedrock: 'AWS Bedrock',
      vertex: 'Google Vertex AI',
      azure: 'Microsoft Azure',
    }[apiProvider]
    properties.push({
      label: tSync('status.apiProvider'),
      value: providerLabel,
    })
  }
  if (apiProvider === 'anthropic') {
    const anthropicBaseUrl = process.env.ZY_CODE_BASE_URL
    if (anthropicBaseUrl) {
      properties.push({
        label: tSync('status.anthropicBaseUrl'),
        value: anthropicBaseUrl,
      })
    }
  }

  const proxyUrl = getProxyUrl()
  if (proxyUrl) {
    properties.push({
      label: tSync('status.proxy'),
      value: proxyUrl,
    })
  }
  const mtlsConfig = getMTLSConfig()
  if (process.env.NODE_EXTRA_CA_CERTS) {
    properties.push({
      label: tSync('status.additionalCaCerts'),
      value: process.env.NODE_EXTRA_CA_CERTS,
    })
  }
  if (mtlsConfig) {
    if (mtlsConfig.cert && process.env.ZY_CODE_CLIENT_CERT) {
      properties.push({
        label: tSync('status.mtlsClientCert'),
        value: process.env.ZY_CODE_CLIENT_CERT,
      })
    }
    if (mtlsConfig.key && process.env.ZY_CODE_CLIENT_KEY) {
      properties.push({
        label: tSync('status.mtlsClientKey'),
        value: process.env.ZY_CODE_CLIENT_KEY,
      })
    }
  }
  return properties
}
export function getModelDisplayLabel(mainLoopModel: string | null): string {
  return modelDisplayString(mainLoopModel)
}
