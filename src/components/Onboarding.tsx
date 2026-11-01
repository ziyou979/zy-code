import React, { useCallback, useEffect, useState } from 'react'
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
import { type EffortLevel, toPersistableEffort } from '../services/effort/effort.js'
import { buildOnboardingModels } from '../services/settings/onboardingModelSettings.js'
import { updateSettingsForSource } from '../services/settings/settings.js'
import { ApiKeySetup, type ApiKeyProvider } from './ApiKeySetup.js'
import { Select } from './CustomSelect/select.js'
import { ProviderModelPicker } from './ProviderModelPicker.js'
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

type PlatformProvider = ApiKeyProvider

export function Onboarding({ onDone }: Props): React.ReactNode {
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [theme, setTheme] = useTheme()
  const [selectedProvider, setSelectedProvider] = useState<PlatformProvider | null>(null)
  const [modelSaveError, setModelSaveError] = useState(false)

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

  function handlePlatformDone(provider: PlatformProvider) {
    setSelectedProvider(provider)
    goToNextStep()
  }

  const platformStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <ApiKeySetup onDone={handlePlatformDone} onCancel={() => handlePlatformDone('anthropic')} />
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
      <ProviderModelPicker
        provider={selectedProvider ?? 'anthropic'}
        title={tSync('onboarding.tier.standard.title')}
        description={tSync('onboarding.tier.standard.desc')}
        onDone={handleStandardDone}
        onCancel={() => {}}
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
      <ProviderModelPicker
        provider={selectedProvider ?? 'anthropic'}
        title={tSync('onboarding.tier.advanced.title')}
        description={tSync('onboarding.tier.advanced.desc')}
        onDone={handleAdvancedDone}
        onCancel={() => handleAdvancedDone('')}
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
      <ProviderModelPicker
        provider={selectedProvider ?? 'anthropic'}
        title={tSync('onboarding.tier.compact.title')}
        description={tSync('onboarding.tier.compact.desc')}
        onDone={handleCompactDone}
        onCancel={() => handleCompactDone('')}
        allowSkip={true}
      />
    </Box>
  )

  // mainLoopModel tier selection — choose which tier is the default
  function handleTierDone(tier: string) {
    // 模型引用必须携带连接 id，避免首次启动依赖顶层 provider 或 auth.json 条目顺序。
    const models = buildOnboardingModels(selectedProvider ?? 'anthropic', tierModels)

    const mainLoopModel = (['advanced', 'standard', 'compact'] as const).includes(
      tier as 'advanced' | 'standard' | 'compact',
    )
      ? (tier as 'advanced' | 'standard' | 'compact')
      : 'standard'

    // Write to settings.json
    const result = updateSettingsForSource('userSettings', {
      models,
      mainLoopModel,
      model: undefined,
    })
    if (result.error) {
      setModelSaveError(true)
      return
    }
    setModelSaveError(false)
    goToNextStep()
  }
  const tierStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      {modelSaveError && <Text color="error">{tSync('settings.modelConfigSaveFailed')}</Text>}
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
