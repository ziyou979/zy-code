import React, { useCallback, useEffect, useState } from 'react';
import { setupTerminal, shouldOfferTerminalSetup } from '../commands/terminalSetup/terminalSetup.js';
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Link, Newline, Text, useTheme } from '../ink.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { normalizeApiKeyForConfig } from '../utils/authPortable.js';
import { saveGlobalConfig } from '../utils/config.js';
import { warmI18n, tSync } from '../i18n/index.js';
import type { UiLanguage } from '../i18n/types.js';
import { updateSettingsForSource } from '../utils/settings/settings.js';
import { Select } from './CustomSelect/select.js';
import { WelcomeV2 } from './LogoV2/WelcomeV2.js';
import { PressEnterToContinue } from './PressEnterToContinue.js';
import { ThemePicker } from './ThemePicker.js';
import { OrderedList } from './ui/OrderedList.js';

type StepId = 'language' | 'theme' | 'platform' | 'model' | 'security' | 'terminal-setup';

interface OnboardingStep {
  id: StepId;
  component: React.ReactNode;
}

type Props = {
  onDone(): void;
};

type PlatformProvider = 'anthropic' | 'dashscope' | 'openrouter' | 'openai' | 'ollama' | 'zhipu' | 'kimi' | 'generic';

interface PlatformConfig {
  provider: PlatformProvider;
  label: string;
  description: string;
  apiKeyLabel: string;
  baseUrlHint?: string;
  /** Default model suggestion and common models for this provider */
  suggestedModels?: Array<{ label: string; value: string; description: string }>;
}

/**
 * Factory functions for platform/model options.
 * Must be functions (not constants) so that tSync() reads the current
 * language cache on each render — after a language switch during onboarding,
 * the cached messages change but module-level constants would be stale.
 */
function getPlatforms(): PlatformConfig[] {
  return [
    {
      provider: 'dashscope',
      label: tSync('onboarding.platform.dashscope'),
      description: tSync('onboarding.platform.dashscopeDesc'),
      apiKeyLabel: 'DashScope API Key',
      suggestedModels: [
        { label: 'qwen3.6-plus', value: 'qwen3.6-plus', description: tSync('onboarding.model.qwen36plusDesc') },
        { label: 'qwen3.5-plus', value: 'qwen3.5-plus', description: tSync('onboarding.model.qwen35plusDesc') },
        { label: 'qwen3.5-flash', value: 'qwen3.5-flash', description: tSync('onboarding.model.qwen35flashDesc') },
      ],
    },
    {
      provider: 'openai',
      label: tSync('onboarding.platform.openai'),
      description: tSync('onboarding.platform.openaiDesc'),
      apiKeyLabel: 'OpenAI API Key',
      suggestedModels: [
        { label: 'gpt-4o', value: 'gpt-4o', description: tSync('onboarding.model.gpt4oDesc') },
        { label: 'gpt-4o-mini', value: 'gpt-4o-mini', description: tSync('onboarding.model.gpt4oMiniDesc') },
      ],
    },
    {
      provider: 'zhipu',
      label: tSync('onboarding.platform.zhipu'),
      description: tSync('onboarding.platform.zhipuDesc'),
      apiKeyLabel: 'ZHIPU API Key',
      suggestedModels: [
        { label: 'glm-4-plus', value: 'glm-4-plus', description: tSync('onboarding.model.glm4PlusDesc') },
        { label: 'glm-4-flash', value: 'glm-4-flash', description: tSync('onboarding.model.glm4FlashDesc') },
      ],
    },
    {
      provider: 'kimi',
      label: tSync('onboarding.platform.kimi'),
      description: tSync('onboarding.platform.kimiDesc'),
      apiKeyLabel: 'Kimi API Key',
      suggestedModels: [
        { label: 'moonshot-v1', value: 'moonshot-v1', description: tSync('onboarding.model.kimiMoonDesc') },
        { label: 'moonshot-v1-8k', value: 'moonshot-v1-8k', description: tSync('onboarding.model.kimiMoon8kDesc') },
      ],
    },
    {
      provider: 'ollama',
      label: tSync('onboarding.platform.ollama'),
      description: tSync('onboarding.platform.ollamaDesc'),
      apiKeyLabel: tSync('onboarding.platform.ollamaApiKey'),
      baseUrlHint: 'http://localhost:11434/v1',
      suggestedModels: [
        { label: 'qwen2.5-coder', value: 'qwen2.5-coder', description: 'Qwen2.5-Coder' },
        { label: 'llama3.1', value: 'llama3.1', description: 'Llama 3.1' },
      ],
    },
    {
      provider: 'openrouter',
      label: tSync('onboarding.platform.openrouter'),
      description: tSync('onboarding.platform.openrouterDesc'),
      apiKeyLabel: 'OpenRouter API Key',
      baseUrlHint: 'https://openrouter.ai/api/v1',
    },
    {
      provider: 'anthropic',
      label: tSync('onboarding.platform.anthropic'),
      description: tSync('onboarding.platform.anthropicDesc'),
      apiKeyLabel: 'Anthropic API Key',
    },
    {
      provider: 'generic',
      label: 'Generic',
      description: tSync('onboarding.platform.genericDesc'),
      apiKeyLabel: 'API Key',
    },
  ];
}

function getGenericModelOptions(): Array<{ label: string; value: string; description: string }> {
  return [
    { label: tSync('onboarding.model.custom'), value: '__custom__', description: tSync('onboarding.model.customDesc') },
  ];
}

export function Onboarding({ onDone }: Props): React.ReactNode {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [theme, setTheme] = useTheme();
  const [selectedProvider, setSelectedProvider] = useState<PlatformProvider | null>(null);

  useEffect(() => {
    // onboarding started
  }, []);

  function goToNextStep() {
    if (currentStepIndex < steps.length - 1) {
      const nextIndex = currentStepIndex + 1;
      setCurrentStepIndex(nextIndex);
    } else {
      onDone();
    }
  }

  async function handleLanguageSelection(lang: UiLanguage) {
    // Save language to user settings
    updateSettingsForSource('userSettings', { language: lang === 'en' ? undefined : lang });
    // Re-warm i18n cache with the new language so subsequent steps render in the selected language
    await warmI18n();
    goToNextStep();
  }

  function handleThemeSelection(newTheme: ReturnType<typeof useTheme>[0]) {
    setTheme(newTheme);
    goToNextStep();
  }

  const exitState = useExitOnCtrlCDWithKeybindings();

  // Language selection step — must be first so all subsequent steps render in the chosen language
  const languageStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>{tSync('onboarding.selectLanguage')}</Text>
      <Text dimColor>{tSync('onboarding.languageDescription')}</Text>
      <Box flexDirection="column" width={60} gap={1}>
        <Select
          options={[
            { label: 'English', value: 'en', description: tSync('onboarding.language.english') },
            { label: '中文', value: 'zh-CN', description: tSync('onboarding.language.chinese') },
          ]}
          onChange={value => {
            void handleLanguageSelection(value as UiLanguage);
          }}
          onCancel={() => {
            // Default to English if skipped
            void handleLanguageSelection('en');
          }}
        />
        <Text dimColor>{tSync('onboarding.enterToConfirm')}</Text>
      </Box>
    </Box>
  );

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
  );

  // Platform setup step (replaces OAuth + API key approval)
  function handlePlatformDone(provider: PlatformProvider, apiKey: string, apiFormat?: 'anthropic' | 'openai') {
    const normalizedKey = normalizeApiKeyForConfig(apiKey);
    saveGlobalConfig(current => ({
      ...current,
      configuredProvider: provider,
      configuredApiKey: apiKey,
      configuredApiFormat: provider === 'generic' ? apiFormat : undefined,
      customApiKeyResponses: {
        ...current.customApiKeyResponses,
        approved: [...(current.customApiKeyResponses?.approved ?? []), normalizedKey],
      },
    }));
    setSelectedProvider(provider);
    goToNextStep();
  }

  const platformStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <PlatformSetup onDone={handlePlatformDone} />
    </Box>
  );

  // Model selection step
  function handleModelDone(model: string) {
    saveGlobalConfig(current => ({
      ...current,
      configuredModel: model,
    }));
    goToNextStep();
  }

  const modelStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <ModelSetup provider={selectedProvider} onDone={handleModelDone} />
    </Box>
  );

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
            <Text>
              {tSync('onboarding.security.risk2')}
            </Text>
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
  );

  // Build steps array — language must be first
  const steps = [];
  steps.push({ id: 'language', component: languageStep });
  steps.push({ id: 'theme', component: themeStep });
  steps.push({ id: 'platform', component: platformStep });
  steps.push({ id: 'model', component: modelStep });
  steps.push({ id: 'security', component: securityStep });

  if (shouldOfferTerminalSetup()) {
    steps.push({
      id: 'terminal-setup',
      component: (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>{tSync('onboarding.terminalSetup.title')}</Text>
          <Box flexDirection="column" width={70} gap={1}>
            <Text>
              {tSync('onboarding.terminalSetup.description', {
                settings: process.env.TERM_PROGRAM === 'Apple_Terminal'
                  ? tSync('onboarding.terminalSetup.appleSettings')
                  : tSync('onboarding.terminalSetup.otherSettings')
              })}
            </Text>
            <Select
              options={[
                { label: tSync('onboarding.terminalSetup.yes'), value: 'install' },
                { label: tSync('onboarding.terminalSetup.no'), value: 'no' },
              ]}
              onChange={value => {
                if (value === 'install') {
                  void setupTerminal(theme).catch(() => {}).finally(goToNextStep);
                } else {
                  goToNextStep();
                }
              }}
              onCancel={() => goToNextStep()}
            />
            <Text dimColor>
              {exitState.pending
                ? tSync('onboarding.pressAgainToExit', { key: exitState.keyName })
                : tSync('onboarding.enterToConfirmSkip')
              }
            </Text>
          </Box>
        </Box>
      ),
    });
  }

  const currentStep = steps[currentStepIndex];

  const handleSecurityContinue = useCallback(() => {
    if (currentStepIndex === steps.length - 1) {
      onDone();
    } else {
      goToNextStep();
    }
  }, [currentStepIndex, steps.length, onDone]);

  const handleTerminalSetupSkip = useCallback(() => {
    goToNextStep();
  }, [currentStepIndex, steps.length, onDone]);

  useKeybindings(
    { 'confirm:yes': handleSecurityContinue },
    { context: 'Confirmation', isActive: currentStep?.id === 'security' }
  );
  useKeybindings(
    { 'confirm:no': handleTerminalSetupSkip },
    { context: 'Confirmation', isActive: currentStep?.id === 'terminal-setup' }
  );

  return (
    <Box flexDirection="column">
      <WelcomeV2 />
      <Box flexDirection="column" marginTop={1}>
        {currentStep?.component}
        {exitState.pending && (
          <Box padding={1}>
            <Text dimColor>{tSync('onboarding.pressAgainToExit', { key: exitState.keyName })}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function PlatformSetup({
  onDone,
}: {
  onDone(provider: PlatformProvider, apiKey: string, apiFormat?: 'anthropic' | 'openai'): void;
}): React.ReactNode {
  const [phase, setPhase] = useState<'provider' | 'apiFormat' | 'apiKey'>('provider');
  const [selectedProvider, setSelectedProvider] = useState<PlatformProvider | null>(null);

  const handleProviderSelect = (value: string) => {
    const provider = value as PlatformProvider;
    setSelectedProvider(provider);
    // For generic, ask about API format first
    if (provider === 'generic') {
      setPhase('apiFormat');
    } else {
      setPhase('apiKey');
    }
  };

  const handleApiFormatDone = (format: 'anthropic' | 'openai') => {
    setPhase('apiKey');
    // Store format temporarily; it will be passed through handleApiKeyDone
    (handleApiKeyDone as any)._apiFormat = format;
  };

  const handleApiKeyDone = (apiKey: string) => {
    if (selectedProvider) {
      const apiFormat = (handleApiKeyDone as any)._apiFormat;
      onDone(selectedProvider, apiKey, apiFormat);
    }
  };

  if (phase === 'provider') {
    return (
      <>
        <Text bold>{tSync('onboarding.selectPlatform')}</Text>
        <Box flexDirection="column" width={60} gap={1}>
          <Select
            options={getPlatforms().map(p => ({
              label: p.label,
              description: p.description,
              value: p.provider,
            }))}
            onChange={handleProviderSelect}
            onCancel={() => onDone('anthropic', '')}
          />
          <Text dimColor>{tSync('onboarding.enterToConfirm')}</Text>
        </Box>
      </>
    );
  }

  if (phase === 'apiFormat') {
    return (
      <>
        <Text bold>{tSync('onboarding.selectApiFormat')}</Text>
        <Text dimColor>{tSync('onboarding.apiFormatDescription')}</Text>
        <Box flexDirection="column" width={60} gap={1}>
          <Select
            options={[
              { label: tSync('onboarding.apiFormat.anthropic'), value: 'anthropic', description: tSync('onboarding.apiFormat.anthropicDesc') },
              { label: tSync('onboarding.apiFormat.openai'), value: 'openai', description: tSync('onboarding.apiFormat.openaiDesc') },
            ]}
            onChange={value => handleApiFormatDone(value as 'anthropic' | 'openai')}
            onCancel={() => setPhase('provider')}
          />
          <Text dimColor>{tSync('onboarding.enterToConfirm')}</Text>
        </Box>
      </>
    );
  }

  // apiKey phase
  const platform = getPlatforms().find(p => p.provider === selectedProvider);
  return (
    <ApiKeyInput
      apiKeyLabel={platform?.apiKeyLabel ?? 'API Key'}
      baseUrlHint={platform?.baseUrlHint}
      onDone={handleApiKeyDone}
      onBack={() => {
        if (selectedProvider === 'generic') {
          setPhase('apiFormat');
        } else {
          setPhase('provider');
        }
      }}
    />
  );
}

function ApiKeyInput({
  apiKeyLabel,
  baseUrlHint,
  onDone,
  onBack,
}: {
  apiKeyLabel: string;
  baseUrlHint?: string;
  onDone(apiKey: string): void;
  onBack(): void;
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
              onChange: value => {
                if (value.trim().length > 0) {
                  onDone(value.trim());
                }
              },
              allowEmptySubmitToCancel: true,
              resetCursorOnUpdate: true,
            },
          ]}
          onCancel={onBack}
        />
        {baseUrlHint && (
          <Text dimColor>Base URL: {baseUrlHint}</Text>
        )}
        <Text dimColor>{tSync('onboarding.confirmBack')}</Text>
      </Box>
    </Box>
  );
}

/**
 * Model selection step during onboarding.
 * Shows provider-suggested models, or a custom input for generic providers.
 */
function ModelSetup({
  provider,
  onDone,
}: {
  provider: PlatformProvider | null;
  onDone(model: string): void;
}): React.ReactNode {
  const [phase, setPhase] = useState<'select' | 'custom'>('select');

  const platform = getPlatforms().find(p => p.provider === provider);
  const modelOptions = platform?.suggestedModels ?? getGenericModelOptions();
  const hasCustomOption = platform?.provider === 'generic';

  const handleSelect = (value: string) => {
    if (value === '__custom__') {
      setPhase('custom');
    } else {
      onDone(value);
    }
  };

  if (phase === 'custom') {
    return (
      <>
        <Text bold>{tSync('onboarding.enterModelName')}</Text>
        <Box flexDirection="column" width={60} gap={1}>
          <Select
            options={[
              {
                type: 'input',
                label: 'Model name',
                value: 'input',
                placeholder: 'e.g. qwen-max, qwen3.6-plus...',
                onChange: value => {
                  if (value.trim().length > 0) {
                    onDone(value.trim());
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
    );
  }

  return (
    <>
      <Text bold>{tSync('onboarding.selectDefaultModel')}</Text>
      <Text dimColor>{tSync('onboarding.modelDescription')}</Text>
      <Box flexDirection="column" width={60} gap={1}>
        <Select
          options={modelOptions.map(m => ({
            label: m.label,
            description: m.description,
            value: m.value,
          }))}
          onChange={handleSelect}
          onCancel={() => onDone('')}
        />
        {hasCustomOption && (
          <Text dimColor>{tSync('onboarding.orCustomModel')}</Text>
        )}
        <Text dimColor>{tSync('onboarding.enterToConfirmSkip')}</Text>
      </Box>
    </>
  );
}
