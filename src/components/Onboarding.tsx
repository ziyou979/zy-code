import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  setupTerminal,
  shouldOfferTerminalSetup,
} from '../commands/terminal-setup/TerminalSetup.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { tSync, warmI18n } from '../i18n/index.js'
import { setLanguage } from '../i18n/languageStore.js'
import type { UiLanguage } from '../i18n/types.js'
import { Box, Link, Newline, Text, useTheme } from '../ink/index.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { PROVIDER_REGISTRY } from '../services/model/providerRegistry.js'
import { setAuthConfigConnection } from '../services/auth/authConfig.js'
import { normalizeApiKeyForConfig } from '../services/auth/authPortable.js'
import { saveGlobalConfig } from '../services/config/config.js'
import { type EffortLevel, toPersistableEffort } from '../services/effort/effort.js'
import { updateSettingsForSource } from '../services/settings/settings.js'
import type { SettingsJson } from '../services/settings/types.js'
import { Select } from './CustomSelect/select.js'
import { effortLevelToSymbol } from './EffortIndicator.js'
import { Welcome } from './Logo/Welcome.js'
import { PressEnterToContinue } from './PressEnterToContinue.js'
import { ThemePicker } from './ThemePicker.js'
import { OrderedList } from './ui/OrderedList.js'

type StepId =
  | 'language'
  | 'theme'
  | 'platform'
  | 'model'
  | 'model-advanced'
  | 'model-compact'
  | 'model-tier'
  | 'effort'
  | 'security'
  | 'terminal-setup'

interface OnboardingStep {
  id: StepId
  component: React.ReactNode
}

type Props = {
  onDone(): void
}

/** Provider id — derived from PROVIDER_REGISTRY */
type PlatformProvider = (typeof PROVIDER_REGISTRY)[number]['id']

interface PlatformConfig {
  /** Unique identifier for this platform entry (used as Select value) */
  id: string
  provider: PlatformProvider
  label: string
  description: string
  apiKeyLabel: string
  baseUrlHint?: string
  suggestedModels?: Array<{ label: string; value: string; description: string }>
  defaultBaseUrls?: {
    'openai-chat'?: string
    'openai-responses'?: string
    anthropic?: string
    google?: string
  }
}

/**
 * Build the onboarding platform list from PROVIDER_REGISTRY.
 *
 * This is a **function** (not a module-level constant) so it re-reads the
 * language cache on each render — after a language switch during onboarding,
 * the cached messages change but module-level constants would be stale.
 */
function getPlatforms(): PlatformConfig[] {
  return PROVIDER_REGISTRY.filter((entry) => entry.showInOnboarding !== false).map((entry) => {
    // Resolve i18n labels — convention: onboarding.platform.{id} / {id}Desc
    const i18nLabel = tSync(`onboarding.platform.${entry.id}`)
    const i18nDesc = tSync(`onboarding.platform.${entry.id}Desc`)
    // For 'local' provider, apiKeyLabel is also i18n
    const apiKeyLabel =
      entry.id === 'local'
        ? tSync('onboarding.platform.localApiKey')
        : (entry.apiKeyLabel ?? tSync('onboarding.defaultApiKeyLabel'))

    // 根据 tier 渲染模型描述
    const suggestedModels = entry.suggestedModels?.map((model) => ({
      label: model.label,
      value: model.value,
      description: tSync(`model.tier.${model.tier}`),
    }))

    return {
      id: entry.id,
      provider: entry.id,
      label: i18nLabel,
      description: i18nDesc,
      apiKeyLabel,
      baseUrlHint: entry.baseUrlHint,
      suggestedModels,
      defaultBaseUrls: entry.defaultBaseUrls,
    }
  })
}

function getGenericModelOptions(): Array<{ label: string; value: string; description: string }> {
  return [
    {
      label: tSync('onboarding.model.custom'),
      value: '__custom__',
      description: tSync('onboarding.model.customDesc'),
    },
  ]
}

export function Onboarding({ onDone }: Props): React.ReactNode {
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [theme, setTheme] = useTheme()
  const [selectedProvider, setSelectedProvider] = useState<PlatformProvider | null>(null)

  useEffect(() => {
    // onboarding started
  }, [])

  function goToNextStep() {
    if (currentStepIndex < steps.length - 1) {
      const nextIndex = currentStepIndex + 1
      setCurrentStepIndex(nextIndex)
    } else {
      onDone()
    }
  }

  async function handleLanguageSelection(lang: UiLanguage) {
    // Save language to user settings
    updateSettingsForSource('userSettings', { language: lang === 'en' ? undefined : lang })
    // 推送到 i18n 语言状态叶子（对标 i18next.changeLanguage）—— 必须先于 warmI18n，
    // 因为应用内切换只 resetCache 不急加载，store 不推则 warmI18n 仍读到旧语言。
    setLanguage(lang === 'en' ? undefined : lang)
    // Re-warm i18n cache with the new language so subsequent steps render in the selected language
    await warmI18n()
    goToNextStep()
  }

  function handleThemeSelection(newTheme: string) {
    setTheme(newTheme as Parameters<typeof setTheme>[0])
    goToNextStep()
  }

  const exitState = useExitOnCtrlCDWithKeybindings()

  // Language selection step — must be first so all subsequent steps render in the chosen language
  const languageStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>{tSync('onboarding.selectLanguage')}</Text>
      <Text dimColor>{tSync('onboarding.languageDescription')}</Text>
      <Box flexDirection="column" width={60} gap={1}>
        <Select
          options={[
            {
              label: tSync('languageName.English'),
              value: 'en',
              description: tSync('onboarding.language.english'),
            },
            {
              label: tSync('languageName.Chinese'),
              value: 'zh-CN',
              description: tSync('onboarding.language.chinese'),
            },
          ]}
          onChange={(value: string) => {
            void handleLanguageSelection(value as UiLanguage)
          }}
          onCancel={() => {
            // Default to English if skipped
            void handleLanguageSelection('en')
          }}
        />
        <Text dimColor>{tSync('onboarding.enterToConfirm')}</Text>
      </Box>
    </Box>
  )

  // Theme step
  const themeStep = (
    <Box marginX={1}>
      <ThemePicker
        onThemeSelect={handleThemeSelection}
        showIntroText={true}
        helpText={tSync('onboarding.themeHelpText')}
        hideEscToCancel={true}
        skipExitHandling={true}
      />
    </Box>
  )

  // Platform setup step (replaces OAuth + API key approval)
  function handlePlatformDone(platformId: string, apiKey: string) {
    const platform = getPlatforms().find((p) => p.id === platformId)
    const provider: PlatformProvider = platform?.provider ?? 'generic'
    const normalizedKey = normalizeApiKeyForConfig(apiKey)

    // Resolve base URL from platform defaults based on supported formats
    let baseUrl: string | undefined
    let apiFormat: 'anthropic' | 'openai-chat' | 'openai-responses' | 'google' | undefined
    if (platform?.defaultBaseUrls) {
      // Priority: google > openai > anthropic (based on provider's supportedFormats order)
      const entry = PROVIDER_REGISTRY.find((e) => e.id === platform.provider)
      const formats = entry?.supportedFormats ?? (['anthropic'] as const)
      const primaryFormat = formats[0]
      apiFormat = primaryFormat
      baseUrl =
        (primaryFormat ? platform.defaultBaseUrls[primaryFormat] : undefined) ??
        platform.defaultBaseUrls['openai-chat'] ??
        platform.defaultBaseUrls.google ??
        platform.defaultBaseUrls.anthropic
    }

    // 仅记录 key 指纹审批（不落全局 configuredApiKey）
    saveGlobalConfig((current) => ({
      ...current,
      apiKeyResponses: {
        ...current.apiKeyResponses,
        approved: [...(current.apiKeyResponses?.approved ?? []), normalizedKey],
      },
    }))
    // 连接细节集中进 auth.json；settings 只选择连接/模型。
    setAuthConfigConnection(provider, { provider, baseUrl, apiFormat, apiKey })
    updateSettingsForSource('userSettings', {
      provider: provider as SettingsJson['provider'],
    })
    setSelectedProvider(provider)
    goToNextStep()
  }

  const platformStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <PlatformSetup onDone={handlePlatformDone} />
    </Box>
  )

  // Tier-based model configuration steps
  const [tierModels, setTierModels] = useState<{
    standard: string
    advanced?: string
    compact?: string
  }>({ standard: '' })

  // standard tier — required
  function handleStandardDone(model: string) {
    setTierModels((prev) => ({ ...prev, standard: model }))
    goToNextStep()
  }
  const standardStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <TierModelSetup
        tier="standard"
        provider={selectedProvider}
        title={tSync('onboarding.tier.standard.title')}
        description={tSync('onboarding.tier.standard.desc')}
        onDone={handleStandardDone}
        allowSkip={false}
      />
    </Box>
  )

  // advanced tier — optional, skip → fallback to standard
  function handleAdvancedDone(model: string) {
    if (model) {
      setTierModels((prev) => ({ ...prev, advanced: model }))
    }
    goToNextStep()
  }
  const advancedStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <TierModelSetup
        tier="advanced"
        provider={selectedProvider}
        title={tSync('onboarding.tier.advanced.title')}
        description={tSync('onboarding.tier.advanced.desc')}
        onDone={handleAdvancedDone}
        allowSkip={true}
      />
    </Box>
  )

  // compact tier — optional, skip → fallback to standard
  function handleCompactDone(model: string) {
    if (model) {
      setTierModels((prev) => ({ ...prev, compact: model }))
    }
    goToNextStep()
  }
  const compactStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <TierModelSetup
        tier="compact"
        provider={selectedProvider}
        title={tSync('onboarding.tier.compact.title')}
        description={tSync('onboarding.tier.compact.desc')}
        onDone={handleCompactDone}
        allowSkip={true}
      />
    </Box>
  )

  // mainLoopModel tier selection — choose which tier is the default
  function handleTierDone(tier: string) {
    // Build models object
    const models: Record<string, string> = { standard: tierModels.standard }
    if (tierModels.advanced) {
      models.advanced = tierModels.advanced
    }
    if (tierModels.compact) {
      models.compact = tierModels.compact
    }

    const mainLoopModel = (['advanced', 'standard', 'compact'] as const).includes(
      tier as 'advanced' | 'standard' | 'compact',
    )
      ? (tier as 'advanced' | 'standard' | 'compact')
      : 'standard'

    // Write to settings.json
    updateSettingsForSource('userSettings', { models, mainLoopModel })
    goToNextStep()
  }
  const tierStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>{tSync('onboarding.tier.mainLoop.title')}</Text>
      <Text dimColor>{tSync('onboarding.tier.mainLoop.desc')}</Text>
      <Box flexDirection="column" width={60} gap={1}>
        <Select
          options={[
            { label: tSync('onboarding.tier.option.advanced'), value: 'advanced' },
            { label: tSync('onboarding.tier.option.standard'), value: 'standard' },
            { label: tSync('onboarding.tier.option.compact'), value: 'compact' },
          ]}
          onChange={handleTierDone}
          onCancel={() => handleTierDone('standard')}
        />
        <Text dimColor>{tSync('onboarding.enterToConfirm')}</Text>
      </Box>
    </Box>
  )

  // Effort step — choose how thorough model responses should be
  function handleEffortDone(effortLevel: string) {
    updateSettingsForSource('userSettings', {
      effortLevel: toPersistableEffort(effortLevel as EffortLevel),
    })
    goToNextStep()
  }

  const effortStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>{tSync('onboarding.effort.title')}</Text>
      <Text dimColor>{tSync('onboarding.effort.desc')}</Text>
      <Box flexDirection="column" width={60} gap={1}>
        <Select
          options={[
            {
              label: `${effortLevelToSymbol('balanced')} ${tSync('effort.balancedRecommended')}`,
              value: 'balanced',
            },
            {
              label: `${effortLevelToSymbol('thorough')} ${tSync('effort.thorough')}`,
              value: 'thorough',
            },
            {
              label: `${effortLevelToSymbol('light')} ${tSync('effort.light')}`,
              value: 'light',
            },
          ]}
          onChange={(value: string) => handleEffortDone(value)}
          onCancel={() => handleEffortDone('balanced')}
        />
        <Text dimColor>{tSync('onboarding.enterToConfirm')}</Text>
      </Box>
    </Box>
  )

  // Security step
  const securityStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>{tSync('onboarding.security.title')}</Text>
      <Box flexDirection="column" width={70}>
        <OrderedList>
          <OrderedList.Item>
            <Text>{tSync('onboarding.security.risk1')}</Text>
            <Text dimColor wrap="wrap">
              {tSync('onboarding.security.risk1desc')}
              <Newline />
            </Text>
          </OrderedList.Item>
          <OrderedList.Item>
            <Text>{tSync('onboarding.security.risk2')}</Text>
            <Text dimColor wrap="wrap">
              {tSync('onboarding.security.risk2desc')}
              <Newline />
              <Link url="https://code.zy.com/docs/en/security" />
            </Text>
          </OrderedList.Item>
        </OrderedList>
      </Box>
      <PressEnterToContinue />
    </Box>
  )

  // Build steps array — language must be first
  const steps: OnboardingStep[] = []
  steps.push({ id: 'language', component: languageStep })
  steps.push({ id: 'theme', component: themeStep })
  steps.push({ id: 'platform', component: platformStep })
  steps.push({ id: 'model', component: standardStep })
  steps.push({ id: 'model-advanced', component: advancedStep })
  steps.push({ id: 'model-compact', component: compactStep })
  steps.push({ id: 'model-tier', component: tierStep })
  steps.push({ id: 'effort', component: effortStep })
  steps.push({ id: 'security', component: securityStep })

  if (shouldOfferTerminalSetup()) {
    steps.push({
      id: 'terminal-setup',
      component: (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>{tSync('onboarding.terminalSetup.title')}</Text>
          <Box flexDirection="column" width={70} gap={1}>
            <Text>
              {tSync('onboarding.terminalSetup.description', {
                settings:
                  process.env.TERM_PROGRAM === 'Apple_Terminal'
                    ? tSync('onboarding.terminalSetup.appleSettings')
                    : tSync('onboarding.terminalSetup.otherSettings'),
              })}
            </Text>
            <Select
              options={[
                { label: tSync('onboarding.terminalSetup.yes'), value: 'install' },
                { label: tSync('onboarding.terminalSetup.no'), value: 'no' },
              ]}
              onChange={(value: string) => {
                if (value === 'install') {
                  void setupTerminal(theme)
                    .catch(() => {})
                    .finally(goToNextStep)
                } else {
                  goToNextStep()
                }
              }}
              onCancel={() => goToNextStep()}
            />
            <Text dimColor>
              {exitState.pending
                ? tSync('onboarding.pressAgainToExit', { key: exitState.keyName ?? '' })
                : tSync('onboarding.enterToConfirmSkip')}
            </Text>
          </Box>
        </Box>
      ),
    })
  }

  const currentStep = steps[currentStepIndex]

  const handleSecurityContinue = useCallback(() => {
    if (currentStepIndex === steps.length - 1) {
      onDone()
    } else {
      goToNextStep()
    }
  }, [currentStepIndex, steps.length, onDone, goToNextStep])

  const handleTerminalSetupSkip = useCallback(() => {
    goToNextStep()
  }, [goToNextStep])

  useKeybindings(
    { 'confirm:yes': handleSecurityContinue },
    { context: 'Confirmation', isActive: currentStep?.id === 'security' },
  )
  useKeybindings(
    { 'confirm:no': handleTerminalSetupSkip },
    { context: 'Confirmation', isActive: currentStep?.id === 'terminal-setup' },
  )

  return (
    <Box flexDirection="column">
      <Welcome />
      <Box flexDirection="column" marginTop={1}>
        {currentStep?.component}
        {exitState.pending && (
          <Box padding={1}>
            <Text dimColor>
              {tSync('onboarding.pressAgainToExit', { key: exitState.keyName ?? '' })}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}

function PlatformSetup({
  onDone,
}: {
  onDone(platformId: string, apiKey: string): void
}): React.ReactNode {
  const [phase, setPhase] = useState<'provider' | 'apiKey'>('provider')
  const [selectedPlatformId, setSelectedPlatformId] = useState<string | null>(null)

  const handleProviderSelect = (value: string) => {
    setSelectedPlatformId(value)
    setPhase('apiKey')
  }

  const handleApiKeyDone = (apiKey: string) => {
    if (selectedPlatformId) {
      onDone(selectedPlatformId, apiKey)
    }
  }

  if (phase === 'provider') {
    return (
      <>
        <Text bold>{tSync('onboarding.selectPlatform')}</Text>
        <Box flexDirection="column" width={60} gap={1}>
          <Select
            options={getPlatforms().map((p) => ({
              label: p.label,
              description: p.description,
              value: p.id,
            }))}
            onChange={handleProviderSelect}
            onCancel={() => onDone('anthropic', '')}
          />
          <Text dimColor>{tSync('onboarding.enterToConfirm')}</Text>
        </Box>
      </>
    )
  }

  // apiKey phase
  const platform = getPlatforms().find((p) => p.id === selectedPlatformId)
  return (
    <ApiKeyInput
      apiKeyLabel={platform?.apiKeyLabel ?? tSync('onboarding.defaultApiKeyLabel')}
      baseUrlHint={platform?.baseUrlHint}
      onDone={handleApiKeyDone}
      onBack={() => {
        setPhase('provider')
      }}
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
  // ref instead of state: per-keystroke option.onChange must not auto-submit;
  // the typed value is committed only on Enter via the Select's top-level onChange.
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
            const trimmed = apiKeyRef.current.trim()
            if (trimmed.length > 0) {
              onDone(trimmed)
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

function CustomModelInput({
  onSubmit,
  onBack,
}: {
  onSubmit(value: string): void
  onBack(): void
}): React.ReactNode {
  const valueRef = useRef('')
  return (
    <>
      <Text bold>{tSync('onboarding.enterModelName')}</Text>
      <Box flexDirection="column" width={60} gap={1}>
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
            const trimmed = valueRef.current.trim()
            if (trimmed.length > 0) {
              onSubmit(trimmed)
            }
          }}
          onCancel={onBack}
        />
        <Text dimColor>{tSync('onboarding.confirmBack')}</Text>
      </Box>
    </>
  )
}

/**
 * Tier-based model selection step during onboarding.
 * Shows provider-suggested models for each tier, with optional skip for non-required tiers.
 */
function TierModelSetup({
  provider,
  title,
  description,
  onDone,
  allowSkip,
}: {
  tier: 'standard' | 'advanced' | 'compact'
  provider: PlatformProvider | null
  title: string
  description: string
  onDone(model: string): void
  allowSkip: boolean
}): React.ReactNode {
  const [phase, setPhase] = useState<'select' | 'custom'>('select')

  const platform = getPlatforms().find((p) => p.provider === provider)
  const modelOptions = platform?.suggestedModels ?? getGenericModelOptions()
  const hasCustomOption = !platform?.suggestedModels || platform.provider === 'generic'

  // Build select options — add skip and custom options
  const selectOptions = modelOptions.map((m) => ({
    label: m.label,
    description: m.description,
    value: m.value,
  }))

  if (allowSkip) {
    selectOptions.push({
      label: tSync('onboarding.tier.skip'),
      value: '__skip__',
      description: '',
    })
  }
  if (hasCustomOption) {
    selectOptions.push({
      label: tSync('onboarding.tier.custom'),
      value: '__custom__',
      description: tSync('onboarding.tier.customDesc'),
    })
  }

  const handleSelect = (value: string) => {
    if (value === '__skip__') {
      onDone('')
    } else if (value === '__custom__') {
      setPhase('custom')
    } else {
      onDone(value)
    }
  }

  if (phase === 'custom') {
    return (
      <CustomModelInput onSubmit={(value) => onDone(value)} onBack={() => setPhase('select')} />
    )
  }

  return (
    <>
      <Text bold>{title}</Text>
      <Text dimColor>{description}</Text>
      <Box flexDirection="column" width={60} gap={1}>
        <Select
          options={selectOptions}
          onChange={handleSelect}
          onCancel={() => (allowSkip ? onDone('') : undefined)}
        />
        <Text dimColor>{tSync('onboarding.enterToConfirm')}</Text>
      </Box>
    </>
  )
}
