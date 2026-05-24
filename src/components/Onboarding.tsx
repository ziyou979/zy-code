import React, { useCallback, useEffect, useState } from 'react'
import { setupTerminal, shouldOfferTerminalSetup } from '../commands/terminalSetup/terminalSetup.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { tSync, warmI18n } from '../i18n/index.js'
import type { UiLanguage } from '../i18n/types.js'
import { Box, Link, Newline, Text, useTheme } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { normalizeApiKeyForConfig } from '../utils/authPortable.js'
import { saveGlobalConfig } from '../utils/config.js'
import { toPersistableEffort } from '../utils/effort.js'
import { PROVIDER_REGISTRY } from '../services/model/providerRegistry.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
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
    openai?: string
    anthropic?: string
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
    const i18nLabel = tSync(`onboarding.platform.${entry.id}` as any)
    const i18nDesc = tSync(`onboarding.platform.${entry.id}Desc` as any)
    // For 'local' provider, apiKeyLabel is also i18n
    const apiKeyLabel =
      entry.id === 'local'
        ? tSync('onboarding.platform.localApiKey')
        : (entry.apiKeyLabel ?? tSync('onboarding.defaultApiKeyLabel'))

    // 根据 tags 自动渲染模型描述
    const suggestedModels = entry.suggestedModels?.map((model) => ({
      label: model.label,
      value: model.value,
      description: model.tags?.length
        ? model.tags.map((tag) => tSync(`model.tag.${tag}` as any)).join(' · ')
        : '',
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
    // Re-warm i18n cache with the new language so subsequent steps render in the selected language
    await warmI18n()
    goToNextStep()
  }

  function handleThemeSelection(newTheme: ReturnType<typeof useTheme>[0]) {
    setTheme(newTheme)
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
          onChange={(value) => {
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
    const provider = platform?.provider ?? 'generic'
    const normalizedKey = normalizeApiKeyForConfig(apiKey)

    // Resolve base URL from platform defaults based on supported formats
    let baseUrl: string | undefined
    if (platform?.defaultBaseUrls) {
      // If provider supports openai, use openai base URL; otherwise use anthropic base URL
      const supportsNativeOpenai = PROVIDER_REGISTRY.find(
        (e) => e.id === platform.provider,
      )?.supportedFormats.includes('openai')
      baseUrl = supportsNativeOpenai
        ? platform.defaultBaseUrls.openai
        : platform.defaultBaseUrls.anthropic
    }

    saveGlobalConfig((current) => ({
      ...current,
      configuredProvider: provider,
      configuredApiKey: apiKey,
      configuredBaseUrl: baseUrl,
      apiKeyResponses: {
        ...current.apiKeyResponses,
        approved: [...(current.apiKeyResponses?.approved ?? []), normalizedKey],
      },
    }))
    setSelectedProvider(provider as PlatformProvider)
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
      effortLevel: toPersistableEffort(effortLevel as any),
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
              label: `${effortLevelToSymbol('medium')} ${tSync('effort.mediumRecommended')}`,
              value: 'medium',
            },
            {
              label: `${effortLevelToSymbol('high')} ${tSync('effort.high')}`,
              value: 'high',
            },
            {
              label: `${effortLevelToSymbol('low')} ${tSync('effort.low')}`,
              value: 'low',
            },
          ]}
          onChange={(value) => handleEffortDone(value)}
          onCancel={() => handleEffortDone('medium')}
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
  const steps = []
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
              onChange={(value) => {
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
                ? tSync('onboarding.pressAgainToExit', { key: exitState.keyName })
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
            <Text dimColor>{tSync('onboarding.pressAgainToExit', { key: exitState.keyName })}</Text>
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
              onChange: (value) => {
                if (value.trim().length > 0) {
                  onDone(value.trim())
                }
              },
              allowEmptySubmitToCancel: true,
              resetCursorOnUpdate: true,
            },
          ]}
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

/**
 * Tier-based model selection step during onboarding.
 * Shows provider-suggested models for each tier, with optional skip for non-required tiers.
 */
function TierModelSetup({
  tier,
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
                onChange: (value) => {
                  if (value.trim().length > 0) {
                    onDone(value.trim())
                  }
                },
                allowEmptySubmitToCancel: true,
                resetCursorOnUpdate: true,
              },
            ]}
            onCancel={() => setPhase('select')}
          />
          <Text dimColor>{tSync('onboarding.confirmBack')}</Text>
        </Box>
      </>
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
