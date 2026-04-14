import React, { useCallback, useEffect, useState } from 'react';
import { setupTerminal, shouldOfferTerminalSetup } from '../commands/terminalSetup/terminalSetup.js';
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Link, Newline, Text, useTheme } from '../ink.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { normalizeApiKeyForConfig } from '../utils/authPortable.js';
import { saveGlobalConfig } from '../utils/config.js';
import { Select } from './CustomSelect/select.js';
import { WelcomeV2 } from './LogoV2/WelcomeV2.js';
import { PressEnterToContinue } from './PressEnterToContinue.js';
import { ThemePicker } from './ThemePicker.js';
import { OrderedList } from './ui/OrderedList.js';
import { tSync } from '../i18n/index.js';

type StepId = 'preflight' | 'theme' | 'platform' | 'model' | 'security' | 'terminal-setup';

interface OnboardingStep {
  id: StepId;
  component: React.ReactNode;
}

type Props = {
  onDone(): void;
};

type PlatformProvider = 'anthropic' | 'dashscope' | 'openrouter' | 'generic';

interface PlatformConfig {
  provider: PlatformProvider;
  label: string;
  description: string;
  apiKeyLabel: string;
  baseUrlHint?: string;
  /** Default model suggestion and common models for this provider */
  suggestedModels?: Array<{ label: string; value: string; description: string }>;
}

const PLATFORMS: PlatformConfig[] = [
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
    provider: 'generic',
    label: 'Generic',
    description: tSync('onboarding.platform.genericDesc'),
    apiKeyLabel: 'API Key',
  },
];

/**
 * Model options for providers without pre-configured suggestions (generic).
 */
const GENERIC_MODEL_OPTIONS: Array<{ label: string; value: string; description: string }> = [
  { label: tSync('onboarding.model.custom'), value: '__custom__', description: tSync('onboarding.model.customDesc') },
];

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

  function handleThemeSelection(newTheme: ReturnType<typeof useTheme>[0]) {
    setTheme(newTheme);
    goToNextStep();
  }

  const exitState = useExitOnCtrlCDWithKeybindings();

  // Theme step
  const themeStep = (
    <Box marginX={1}>
      <ThemePicker
        onThemeSelect={handleThemeSelection}
        showIntroText={true}
        helpText="To change this later, run /theme"
        hideEscToCancel={true}
        skipExitHandling={true}
      />
    </Box>
  );

  // Platform setup step (replaces OAuth + API key approval)
  function handlePlatformDone(provider: PlatformProvider, apiKey: string) {
    const normalizedKey = normalizeApiKeyForConfig(apiKey);
    saveGlobalConfig(current => ({
      ...current,
      configuredProvider: provider,
      configuredApiKey: apiKey,
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

  // Build steps array
  let steps;
  steps = [];
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
  onDone(provider: PlatformProvider, apiKey: string): void;
}): React.ReactNode {
  const [phase, setPhase] = useState<'provider' | 'apiKey'>('provider');
  const [selectedProvider, setSelectedProvider] = useState<PlatformProvider | null>(null);

  const handleProviderSelect = (value: string) => {
    const provider = value as PlatformProvider;
    setSelectedProvider(provider);
    setPhase('apiKey');
  };

  const handleApiKeyDone = (apiKey: string) => {
    if (selectedProvider) {
      onDone(selectedProvider, apiKey);
    }
  };

  if (phase === 'provider') {
    return (
      <>
        <Text bold>{tSync('onboarding.selectPlatform')}</Text>
        <Box flexDirection="column" width={60} gap={1}>
          <Select
            options={PLATFORMS.map(p => ({
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

  // apiKey phase
  const platform = PLATFORMS.find(p => p.provider === selectedProvider);
  return (
    <ApiKeyInput
      apiKeyLabel={platform?.apiKeyLabel ?? 'API Key'}
      baseUrlHint={platform?.baseUrlHint}
      onDone={handleApiKeyDone}
      onBack={() => setPhase('provider')}
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

  const platform = PLATFORMS.find(p => p.provider === provider);
  const modelOptions = platform?.suggestedModels ?? GENERIC_MODEL_OPTIONS;
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
