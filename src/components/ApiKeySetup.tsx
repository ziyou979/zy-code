import React, { useRef, useState } from 'react'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink/index.js'
import { setAuthConfigConnection } from '../services/auth/authConfig.js'
import { normalizeApiKeyForConfig } from '../services/auth/authPortable.js'
import { approveApiKeyFingerprint } from '../services/config/config.js'
import type { ApiFormat } from '../services/model/apiFormat.js'
import { resolveDefaultModelsUrl } from '../services/model/fetchProviderModels.js'
import {
  getDefaultBaseUrl,
  getDefaultBaseUrlForFormat,
  getSupportedFormats,
  PROVIDER_REGISTRY,
  type ProviderEntry,
} from '../services/model/providerRegistry.js'
import { Select } from './CustomSelect/select.js'
import { VertexLogin } from './VertexLogin.js'

export type ApiKeyProvider = (typeof PROVIDER_REGISTRY)[number]['id']

interface PlatformConfig {
  id: string
  provider: ApiKeyProvider
  label: string
  description: string
  apiKeyLabel: string
  baseUrlHint?: string
  entry?: ProviderEntry
}

/** 平台在中文环境下的拼音排序映射表，用于支持中英文平台按拼音/英文 A-Z 统一字母序排列。 */
const PLATFORM_PINYIN_MAP: Record<string, string> = {
  qianfan: 'Baidu Qianfan',
  dashscope: 'Bailian DashScope',
  siliconflow: 'Guiji SiliconFlow',
  pangu: 'Huawei Pangu',
  ark: 'Huoshan Ark',
  stepfun: 'Jieyue StepFun',
  'ant-ling': 'Mayi Ant Ling',
  tencent: 'Tengxun Hunyuan',
  generic: 'Zidingyi Custom',
  zhipu: 'Zhipu AI',
  local: 'Bendi Local',
}

export function getPlatformSortKey(id: string, label: string): string {
  // 如果首字符是英文字母（如 OpenAI、Anthropic、DeepSeek），直接按自身名称排序
  if (/^[A-Za-z]/.test(label)) {
    return label
  }
  // 中文平台按拼音首字母/全拼排序
  if (PLATFORM_PINYIN_MAP[id]) {
    return PLATFORM_PINYIN_MAP[id]
  }
  return label
}

/** 每次渲染时重新读取翻译，确保引导过程中切换语言后文案立即更新。 */
export function getPlatforms(): PlatformConfig[] {
  return (
    PROVIDER_REGISTRY.filter((entry) => entry.showInOnboarding !== false)
      .map((entry) => ({
        id: entry.id,
        provider: entry.id,
        label: tSync(`onboarding.platform.${entry.id}`),
        description: tSync(`onboarding.platform.${entry.id}Desc`),
        apiKeyLabel:
          entry.id === 'local'
            ? tSync('onboarding.platform.localApiKey')
            : (entry.apiKeyLabel ?? tSync('onboarding.defaultApiKeyLabel')),
        baseUrlHint: entry.baseUrlHint,
        entry,
      }))
      // 统一按拼音与英文字母顺序（A-Z）排列，方便用户查找中英文平台。
      .sort((a, b) => {
        const keyA = getPlatformSortKey(a.id, a.label)
        const keyB = getPlatformSortKey(b.id, b.label)
        return keyA.localeCompare(keyB, 'en', { sensitivity: 'base' })
      })
  )
}

export function saveApiKeyConnection({
  platformId,
  apiKey,
  customBaseUrl,
  customApiFormat,
  customModelsUrl,
}: {
  platformId: string
  apiKey: string
  customBaseUrl?: string
  customApiFormat?: ApiFormat
  customModelsUrl?: string
}): ApiKeyProvider {
  const platform = getPlatforms().find((candidate) => candidate.id === platformId)
  const provider: ApiKeyProvider = platform?.provider ?? 'generic'
  const trimmedKey = apiKey.trim()
  const fingerprint = trimmedKey ? normalizeApiKeyForConfig(trimmedKey) : ''

  let baseUrl: string | undefined = customBaseUrl
  let apiFormat: ApiFormat | undefined = customApiFormat
  const entry = platform?.entry

  if (!baseUrl && entry && entry.formatEndpoints.some(({ baseUrl }) => baseUrl)) {
    // 首位声明的格式即默认格式；端点缺失时按统一回落规则取其他格式端点
    apiFormat = getSupportedFormats(entry)[0]
    baseUrl = getDefaultBaseUrl(entry, apiFormat) ?? getDefaultBaseUrlForFormat(entry, apiFormat)
  }

  const modelsUrl =
    customModelsUrl || resolveDefaultModelsUrl(provider, baseUrl, apiFormat) || undefined

  if (fingerprint) {
    approveApiKeyFingerprint(fingerprint)
  }
  setAuthConfigConnection(provider, {
    provider,
    baseUrl,
    modelsUrl,
    apiFormat,
    apiKey: trimmedKey,
  })
  // 此步骤只保存连接；完整 onboarding 会在模型选择完成后把连接 id 写入模型引用。
  return provider
}

type GenericFlowState = {
  baseUrl: string
  apiFormat: ApiFormat
  modelsUrl?: string
}

export function ApiKeySetup({
  onDone,
  onCancel,
  initialProvider,
  onInputModeChange,
}: {
  onDone(provider: ApiKeyProvider): void
  onCancel(): void
  initialProvider?: ApiKeyProvider
  onInputModeChange?(active: boolean): void
}): React.ReactNode {
  const [phase, setPhase] = useState<
    'provider' | 'genericBaseUrl' | 'genericApiFormat' | 'genericModelsUrl' | 'apiKey' | 'vertex'
  >(initialProvider === 'vertex' ? 'vertex' : 'provider')
  const [selectedPlatformId, setSelectedPlatformId] = useState<string | null>(
    initialProvider ?? null,
  )
  const [genericState, setGenericState] = useState<GenericFlowState>({
    baseUrl: '',
    apiFormat: 'openai-chat',
  })

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
              if (value === 'generic') {
                setPhase('genericBaseUrl')
              } else if (value === 'vertex') {
                setPhase('vertex')
              } else {
                setPhase('apiKey')
              }
            }}
            onCancel={onCancel}
          />
          <Text dimColor>{tSync('onboarding.confirmBack')}</Text>
        </Box>
      </>
    )
  }

  if (phase === 'vertex') {
    return (
      <VertexLogin
        onDone={onDone}
        onBack={() => setPhase('provider')}
        onInputModeChange={onInputModeChange}
      />
    )
  }

  // Generic 步骤 1：输入基础 URL
  if (phase === 'genericBaseUrl') {
    return (
      <TextInputPrompt
        title={tSync('onboarding.generic.enterBaseUrl')}
        placeholder={tSync('onboarding.generic.baseUrlPlaceholder')}
        onSubmit={(url) => {
          setGenericState((prev) => ({ ...prev, baseUrl: url }))
          setPhase('genericApiFormat')
        }}
        onBack={() => setPhase('provider')}
      />
    )
  }

  // Generic 步骤 2：选择协议格式
  if (phase === 'genericApiFormat') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{tSync('onboarding.generic.selectApiFormat')}</Text>
        <Box flexDirection="column" width={60} gap={1}>
          <Select
            options={[
              {
                label: tSync('onboarding.apiFormat.openai-chat'),
                description: tSync('onboarding.apiFormat.openai-chatDesc'),
                value: 'openai-chat',
              },
              {
                label: tSync('onboarding.apiFormat.openai-responses'),
                description: tSync('onboarding.apiFormat.openai-responsesDesc'),
                value: 'openai-responses',
              },
              {
                label: tSync('onboarding.apiFormat.anthropic'),
                description: tSync('onboarding.apiFormat.anthropicDesc'),
                value: 'anthropic',
              },
              {
                label: tSync('onboarding.apiFormat.google'),
                description: tSync('onboarding.apiFormat.googleDesc'),
                value: 'google',
              },
            ]}
            onChange={(value: string) => {
              setGenericState((prev) => ({
                ...prev,
                apiFormat: value as ApiFormat,
              }))
              setPhase('genericModelsUrl')
            }}
            onCancel={() => setPhase('genericBaseUrl')}
          />
          <Text dimColor>{tSync('onboarding.confirmBack')}</Text>
        </Box>
      </Box>
    )
  }

  // Generic 步骤 3：输入/确认可用模型查询 URL
  if (phase === 'genericModelsUrl') {
    const inferredModelsUrl =
      resolveDefaultModelsUrl('generic', genericState.baseUrl, genericState.apiFormat) ?? ''
    return (
      <TextInputPrompt
        title={tSync('onboarding.generic.enterModelsUrl')}
        placeholder={tSync('onboarding.generic.modelsUrlPlaceholder', {
          defaultUrl: inferredModelsUrl,
        })}
        defaultValue={inferredModelsUrl}
        allowEmptySubmit={true}
        onSubmit={(url) => {
          setGenericState((prev) => ({
            ...prev,
            modelsUrl: url.trim() || inferredModelsUrl || undefined,
          }))
          setPhase('apiKey')
        }}
        onBack={() => setPhase('genericApiFormat')}
      />
    )
  }

  const platform = getPlatforms().find((candidate) => candidate.id === selectedPlatformId)
  return (
    <ApiKeyInput
      apiKeyLabel={platform?.apiKeyLabel ?? tSync('onboarding.defaultApiKeyLabel')}
      baseUrlHint={platform?.baseUrlHint ?? genericState.baseUrl}
      allowEmpty={selectedPlatformId === 'generic' || selectedPlatformId === 'local'}
      onDone={(apiKey) => {
        if (selectedPlatformId) {
          const provider = saveApiKeyConnection({
            platformId: selectedPlatformId,
            apiKey,
            customBaseUrl: selectedPlatformId === 'generic' ? genericState.baseUrl : undefined,
            customApiFormat: selectedPlatformId === 'generic' ? genericState.apiFormat : undefined,
            customModelsUrl: selectedPlatformId === 'generic' ? genericState.modelsUrl : undefined,
          })
          onDone(provider)
        }
      }}
      onBack={() => {
        if (selectedPlatformId === 'generic') {
          setPhase('genericModelsUrl')
        } else {
          setPhase('provider')
        }
      }}
    />
  )
}

function TextInputPrompt({
  title,
  placeholder,
  defaultValue,
  allowEmptySubmit,
  onSubmit,
  onBack,
}: {
  title: string
  placeholder: string
  defaultValue?: string
  allowEmptySubmit?: boolean
  onSubmit(value: string): void
  onBack(): void
}): React.ReactNode {
  const valueRef = useRef('')
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{title}</Text>
      <Box flexDirection="column" width={60} gap={1}>
        <Select
          options={[
            {
              type: 'input',
              label: title,
              value: 'input',
              placeholder,
              onChange: (value: string) => {
                valueRef.current = value
              },
              allowEmptySubmitToCancel: allowEmptySubmit,
              resetCursorOnUpdate: true,
            },
          ]}
          onChange={() => {
            const raw = valueRef.current.trim()
            const result = raw || defaultValue || ''
            if (result.length > 0 || allowEmptySubmit) {
              onSubmit(result)
            }
          }}
          onCancel={onBack}
        />
        <Text dimColor>{tSync('onboarding.confirmBack')}</Text>
      </Box>
    </Box>
  )
}

function ApiKeyInput({
  apiKeyLabel,
  baseUrlHint,
  allowEmpty,
  onDone,
  onBack,
}: {
  apiKeyLabel: string
  baseUrlHint?: string
  allowEmpty?: boolean
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
              placeholder: allowEmpty ? tSync('onboarding.optionalApiKeyPlaceholder') : 'sk-...',
              onChange: (value: string) => {
                apiKeyRef.current = value
              },
              allowEmptySubmitToCancel: allowEmpty,
              resetCursorOnUpdate: true,
            },
          ]}
          onChange={() => {
            const apiKey = apiKeyRef.current.trim()
            if (apiKey || allowEmpty) {
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
