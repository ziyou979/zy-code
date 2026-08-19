import React, { useRef, useState } from 'react'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink/index.js'
import { setAuthConfigConnection } from '../services/auth/authConfig.js'
import { normalizeApiKeyForConfig } from '../services/auth/authPortable.js'
import { saveGlobalConfig } from '../services/config/config.js'
import { PROVIDER_REGISTRY } from '../services/model/providerRegistry.js'
import { updateSettingsForSource } from '../services/settings/settings.js'
import type { SettingsJson } from '../services/settings/types.js'
import { Select } from './CustomSelect/select.js'

export type ApiKeyProvider = (typeof PROVIDER_REGISTRY)[number]['id']

interface PlatformConfig {
  id: string
  provider: ApiKeyProvider
  label: string
  description: string
  apiKeyLabel: string
  baseUrlHint?: string
  defaultBaseUrls?: {
    'openai-chat'?: string
    'openai-responses'?: string
    anthropic?: string
    google?: string
  }
}

/** 每次渲染时重新读取翻译，确保引导过程中切换语言后文案立即更新。 */
function getPlatforms(): PlatformConfig[] {
  return PROVIDER_REGISTRY.filter((entry) => entry.showInOnboarding !== false).map((entry) => ({
    id: entry.id,
    provider: entry.id,
    label: tSync(`onboarding.platform.${entry.id}`),
    description: tSync(`onboarding.platform.${entry.id}Desc`),
    apiKeyLabel:
      entry.id === 'local'
        ? tSync('onboarding.platform.localApiKey')
        : (entry.apiKeyLabel ?? tSync('onboarding.defaultApiKeyLabel')),
    baseUrlHint: entry.baseUrlHint,
    defaultBaseUrls: entry.defaultBaseUrls,
  }))
}

function saveApiKeyConnection(platformId: string, apiKey: string): ApiKeyProvider {
  const platform = getPlatforms().find((candidate) => candidate.id === platformId)
  const provider: ApiKeyProvider = platform?.provider ?? 'generic'
  const normalizedKey = normalizeApiKeyForConfig(apiKey)

  let baseUrl: string | undefined
  let apiFormat: 'anthropic' | 'openai-chat' | 'openai-responses' | 'google' | undefined
  if (platform?.defaultBaseUrls) {
    const entry = PROVIDER_REGISTRY.find((candidate) => candidate.id === platform.provider)
    const primaryFormat = (entry?.supportedFormats ?? (['anthropic'] as const))[0]
    apiFormat = primaryFormat
    baseUrl =
      (primaryFormat ? platform.defaultBaseUrls[primaryFormat] : undefined) ??
      platform.defaultBaseUrls['openai-chat'] ??
      platform.defaultBaseUrls.google ??
      platform.defaultBaseUrls.anthropic
  }

  saveGlobalConfig((current) => ({
    ...current,
    apiKeyResponses: {
      ...current.apiKeyResponses,
      approved: [...(current.apiKeyResponses?.approved ?? []), normalizedKey],
    },
  }))
  setAuthConfigConnection(provider, { provider, baseUrl, apiFormat, apiKey })
  updateSettingsForSource('userSettings', {
    provider: provider as SettingsJson['provider'],
  })
  return provider
}

export function ApiKeySetup({
  onDone,
  onCancel,
}: {
  onDone(provider: ApiKeyProvider): void
  onCancel(): void
}): React.ReactNode {
  const [phase, setPhase] = useState<'provider' | 'apiKey'>('provider')
  const [selectedPlatformId, setSelectedPlatformId] = useState<string | null>(null)

  if (phase === 'provider') {
    return (
      <>
        <Text bold>{tSync('onboarding.selectPlatform')}</Text>
        <Box flexDirection="column" width={60} gap={1}>
          <Select
            options={getPlatforms().map((platform) => ({
              label: platform.label,
              description: platform.description,
              value: platform.id,
            }))}
            onChange={(value: string) => {
              setSelectedPlatformId(value)
              setPhase('apiKey')
            }}
            onCancel={onCancel}
          />
          <Text dimColor>{tSync('onboarding.enterToConfirm')}</Text>
        </Box>
      </>
    )
  }

  const platform = getPlatforms().find((candidate) => candidate.id === selectedPlatformId)
  return (
    <ApiKeyInput
      apiKeyLabel={platform?.apiKeyLabel ?? tSync('onboarding.defaultApiKeyLabel')}
      baseUrlHint={platform?.baseUrlHint}
      onDone={(apiKey) => {
        if (selectedPlatformId) {
          onDone(saveApiKeyConnection(selectedPlatformId, apiKey))
        }
      }}
      onBack={() => setPhase('provider')}
    />
  )
}

function ApiKeyInput({
  apiKeyLabel,
  baseUrlHint,
  onDone,
  onBack,
}: {
  apiKeyLabel: string
  baseUrlHint?: string
  onDone(apiKey: string): void
  onBack(): void
}): React.ReactNode {
  // 输入过程只更新 ref，避免 Select 的逐键 onChange 被误当成提交。
  const apiKeyRef = useRef('')
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{tSync('onboarding.enterApiKey', { apiKeyLabel })}</Text>
      <Box flexDirection="column" width={60} gap={1}>
        <Select
          options={[
            {
              type: 'input',
              label: apiKeyLabel,
              value: 'input',
              placeholder: 'sk-...',
              onChange: (value: string) => {
                apiKeyRef.current = value
              },
              allowEmptySubmitToCancel: true,
              resetCursorOnUpdate: true,
            },
          ]}
          onChange={() => {
            const apiKey = apiKeyRef.current.trim()
            if (apiKey) {
              onDone(apiKey)
            }
          }}
          onCancel={onBack}
        />
        {baseUrlHint && (
          <Text dimColor>
            {tSync('onboarding.baseUrlLabel')}: {baseUrlHint}
          </Text>
        )}
        <Text dimColor>{tSync('onboarding.confirmBack')}</Text>
      </Box>
    </Box>
  )
}
