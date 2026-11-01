/** 首次设置、登录和档位配置共用的实时模型选择器。 */
import React, { useContext, useEffect, useRef, useState } from 'react'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink/index.js'
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'
import { getAuthConfigForProvider } from '../services/auth/authConfig.js'
import { getApiKey, getApiKeyFromApiKeyHelper } from '../services/auth/auth.js'
import {
  isOAuthTokenExpiredForConnection,
  refreshOAuthTokenForConnection,
} from '../services/oauth/oauthStorage.js'
import {
  fetchProviderModels,
  type ModelDiscoveryResult,
  type FetchProviderModelsOptions,
} from '../services/model/fetchProviderModels.js'
import { getProviderEntry } from '../services/model/providerRegistry.js'
import {
  getLocalModelCapability,
  type ModelCapabilityMatchContext,
} from '../services/settings/localModelCapabilities.js'
import { saveDiscoveredModelCapability } from '../services/settings/discoveredModelCapabilities.js'
import {
  isModelCapabilityComplete,
  type ModelCatalogCapability,
} from '../services/model/modelCatalogCapabilities.js'
import {
  resolveModelCapabilities,
  type ModelCapabilityResolution,
} from '../services/model/resolveModelCapabilities.js'
import { ModelCapabilityEditor } from './ModelCapabilityEditor.js'
import { Select } from './CustomSelect/select.js'

function CustomModelInput({
  onSubmit,
  onBack,
}: {
  onSubmit(value: string): void
  onBack(): void
}): React.ReactNode {
  const valueRef = useRef('')
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{tSync('onboarding.enterModelName')}</Text>
      <Select
        options={[
          {
            type: 'input',
            label: tSync('onboarding.modelNameLabel'),
            value: 'input',
            placeholder: tSync('onboarding.modelNamePlaceholder'),
            onChange: (value: string) => {
              valueRef.current = value
            },
            allowEmptySubmitToCancel: true,
            resetCursorOnUpdate: true,
          },
        ]}
        onChange={() => {
          if (valueRef.current.trim()) onSubmit(valueRef.current.trim())
        }}
        onCancel={onBack}
      />
      <Text dimColor>{tSync('onboarding.confirmBack')}</Text>
    </Box>
  )
}

type DiscoveryState = { status: 'loading' } | ModelDiscoveryResult

export function ProviderModelPicker({
  provider,
  title,
  description,
  allowSkip,
  skipLabel,
  onDone,
  onCancel,
  onInputModeChange,
}: {
  /** auth.json 中的命名连接 id，允许与底层 provider 不同。 */
  provider: string
  title?: string
  description?: string
  allowSkip?: boolean
  skipLabel?: string
  onDone(model: string): void
  onCancel(): void
  onInputModeChange?(active: boolean): void
}): React.ReactNode {
  const [phase, setPhase] = useState<'select' | 'custom' | 'resolving' | 'capabilities'>('select')
  useEffect(() => {
    if (phase !== 'capabilities') {
      onInputModeChange?.(phase === 'custom')
    }
    return () => onInputModeChange?.(false)
  }, [phase, onInputModeChange])
  const [discovery, setDiscovery] = useState<DiscoveryState>({ status: 'loading' })
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [focusedModel, setFocusedModel] = useState<string>()
  const [capabilitySaveError, setCapabilitySaveError] = useState(false)
  const catalogContext = useRef<ModelCapabilityMatchContext>({})
  const catalogOptions = useRef<FetchProviderModelsOptions>({ provider })
  const selectionAbort = useRef<AbortController | null>(null)
  const lastModel = useRef<string | undefined>(undefined)
  const terminalSize = useContext(TerminalSizeContext)
  const columns = terminalSize?.columns ?? process.stdout?.columns ?? 80
  const dialogWidth = Math.max(Math.min(columns - 4, 100), 70)
  const [selection, setSelection] = useState<{
    model: string
    resolution: ModelCapabilityResolution
  }>()

  useEffect(() => {
    const controller = new AbortController()
    selectionAbort.current?.abort()
    setPhase('select')
    setSelection(undefined)
    setFocusedModel(undefined)
    lastModel.current = undefined
    setCapabilitySaveError(false)
    setDiscovery({ status: 'loading' })
    // 每次刷新重新读取连接和凭证，不能沿用更新前的 token 或旧目录。
    const load = async () => {
      const auth = getAuthConfigForProvider(provider)
      const actualProvider = auth?.provider ?? provider
      const entry = getProviderEntry(actualProvider)
      const apiFormat = auth?.apiFormat ?? entry?.formatEndpoints[0]?.format
      const baseUrl = entry?.baseUrlEnvVar
        ? process.env[entry.baseUrlEnvVar] || auth?.baseUrl
        : auth?.baseUrl
      catalogOptions.current = {
        provider: actualProvider,
        connectionId: provider,
        apiFormat,
        baseUrl,
        location: auth?.vertex?.location,
      }
      catalogContext.current = { provider: actualProvider, apiFormat, connectionId: provider }
      if (!auth?.apiKey && isOAuthTokenExpiredForConnection(provider)) {
        await refreshOAuthTokenForConnection(provider)
      }
      if (controller.signal.aborted) return
      const apiKey =
        auth?.apiKey ||
        (await getApiKeyFromApiKeyHelper(false, provider)) ||
        getApiKey(provider) ||
        undefined
      if (controller.signal.aborted) return
      const result = await fetchProviderModels({
        provider: actualProvider,
        connectionId: provider,
        baseUrl,
        apiKey,
        apiFormat,
        modelsUrl: auth?.modelsUrl,
        location: auth?.vertex?.location,
        signal: controller.signal,
      })
      if (!controller.signal.aborted) {
        catalogContext.current = { provider: actualProvider, apiFormat, connectionId: provider }
        setDiscovery(result)
      }
    }
    void load().catch(() => {
      if (!controller.signal.aborted)
        setDiscovery({ status: 'unavailable', reason: 'authentication' })
    })
    return () => {
      controller.abort()
      selectionAbort.current?.abort()
    }
  }, [provider, refreshVersion])
  useEffect(() => () => selectionAbort.current?.abort(), [])

  const finishSelection = (
    model: string,
    resolution: ModelCapabilityResolution,
    overrides?: ModelCatalogCapability,
  ) => {
    const context = catalogContext.current
    if (resolution.automatic && context.provider) {
      const result = saveDiscoveredModelCapability(
        {
          model,
          connectionId: provider,
          provider: context.provider,
          apiFormat: context.apiFormat ?? undefined,
        },
        resolution.automatic,
        resolution.source === 'registry' ? 'registry' : 'catalog',
      )
      if (result.error) {
        setCapabilitySaveError(true)
        return
      }
    }
    if (overrides && context.provider) {
      const result = saveDiscoveredModelCapability(
        {
          model,
          connectionId: provider,
          provider: context.provider,
          apiFormat: context.apiFormat ?? undefined,
        },
        overrides,
        'user',
      )
      if (result.error) {
        setCapabilitySaveError(true)
        return
      }
    }
    setCapabilitySaveError(false)
    onDone(model)
  }
  const handleModelDone = async (model: string, edit = false) => {
    if (!model) {
      onDone('')
      return
    }
    selectionAbort.current?.abort()
    const controller = new AbortController()
    selectionAbort.current = controller
    setCapabilitySaveError(false)
    setPhase('resolving')
    const selected =
      discovery.status === 'success'
        ? discovery.models.find((item) => item.id === model)
        : undefined
    const resolution = await resolveModelCapabilities(selected ?? { id: model }, {
      ...catalogOptions.current,
      connectionId: provider,
      refresh: refreshVersion > 0,
      signal: controller.signal,
    })
    if (controller.signal.aborted) return
    setSelection({ model, resolution })
    if (edit || !isModelCapabilityComplete(resolution.effective)) {
      setPhase('capabilities')
    } else {
      setPhase('select')
      finishSelection(model, resolution)
    }
  }
  if (phase === 'resolving') {
    const cancel = () => {
      selectionAbort.current?.abort()
      setPhase('select')
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Text>{tSync('modelCapability.resolving')}</Text>
        <Select
          options={[{ value: 'back', label: tSync('modelCapability.back') }]}
          onChange={cancel}
          onCancel={cancel}
        />
      </Box>
    )
  }
  if (phase === 'capabilities' && selection) {
    return (
      <ModelCapabilityEditor
        onInputModeChange={onInputModeChange}
        model={selection.model}
        initial={selection.resolution.base}
        overrides={selection.resolution.overrides}
        source={selection.resolution.source}
        catalogIssue={selection.resolution.catalogIssue}
        error={capabilitySaveError}
        onDone={(overrides) => finishSelection(selection.model, selection.resolution, overrides)}
        onCancel={() => setPhase('select')}
      />
    )
  }
  if (phase === 'custom') {
    return (
      <CustomModelInput
        onSubmit={(model) => {
          void handleModelDone(model, true)
        }}
        onBack={() => setPhase('select')}
      />
    )
  }

  const options =
    discovery.status === 'success'
      ? discovery.models.map((model) => ({
          label: model.label ?? model.id,
          value: model.id,
          description: model.description ?? tSync('onboarding.discoveredModel'),
        }))
      : []
  if (allowSkip)
    options.push({
      label: skipLabel ?? tSync('onboarding.tier.skip'),
      value: '__skip__',
      description: '',
    })
  options.push({
    label: tSync('onboarding.tier.custom'),
    value: '__custom__',
    description: tSync('onboarding.tier.customDesc'),
  })
  options.push({ label: tSync('onboarding.models.refresh'), value: '__refresh__', description: '' })
  if (discovery.status === 'success' && discovery.models.length)
    options.push({
      label: tSync('modelCapability.edit'),
      value: '__edit_capabilities__',
      description: '',
    })

  const statusText =
    discovery.status === 'loading'
      ? tSync('onboarding.fetchingModels')
      : discovery.status === 'success'
        ? discovery.models.length === 0
          ? tSync('onboarding.models.empty')
          : undefined
        : tSync(`onboarding.models.${discovery.reason}`, { status: discovery.httpStatus ?? '' })

  const focused =
    discovery.status === 'success'
      ? (discovery.models.find((model) => model.id === focusedModel) ??
        (!focusedModel ? discovery.models[0] : undefined))
      : undefined
  const local = focused ? getLocalModelCapability(focused.id, catalogContext.current) : undefined
  const incomplete =
    focused &&
    (!(local?.capabilities.input ?? focused.capability?.capabilities.input) ||
      !(local?.capabilities.thinking ?? focused.capability?.capabilities.thinking) ||
      !(local?.tokens?.contextWindow ?? focused.capability?.tokens?.contextWindow))
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{title ?? tSync('onboarding.selectDefaultModel')}</Text>
      {description && <Text dimColor>{description}</Text>}
      {statusText && <Text dimColor>{statusText}</Text>}
      {incomplete && <Text dimColor>{tSync('onboarding.models.capabilitiesIncomplete')}</Text>}
      {capabilitySaveError && (
        <Text color="error">{tSync('onboarding.models.capabilitySaveFailed')}</Text>
      )}
      <Box flexDirection="column" width={dialogWidth} gap={1}>
        <Select
          key={`${provider}:${refreshVersion}:${discovery.status}`}
          visibleOptionCount={10}
          options={options}
          onFocus={(value) => {
            setFocusedModel(value)
            if (
              discovery.status === 'success' &&
              discovery.models.some((model) => model.id === value)
            )
              lastModel.current = value
          }}
          onChange={(value) => {
            if (value === '__custom__') setPhase('custom')
            else if (value === '__skip__') {
              void handleModelDone('')
            } else if (value === '__refresh__') setRefreshVersion((version) => version + 1)
            else if (value === '__edit_capabilities__') {
              const model =
                lastModel.current ??
                (discovery.status === 'success' ? discovery.models[0]?.id : undefined)
              if (model) void handleModelDone(model, true)
            } else {
              void handleModelDone(value)
            }
          }}
          onCancel={onCancel}
        />
        <Text dimColor>{tSync('onboarding.enterToConfirm')}</Text>
      </Box>
    </Box>
  )
}
