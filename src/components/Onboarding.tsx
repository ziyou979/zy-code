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

type StepId = 'preflight' | 'theme' | 'platform' | 'security' | 'terminal-setup';

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
}

const PLATFORMS: PlatformConfig[] = [
  {
    provider: 'anthropic',
    label: 'Anthropic',
    description: '官方 API (api.anthropic.com)',
    apiKeyLabel: 'Anthropic API Key',
  },
  {
    provider: 'dashscope',
    label: '百炼 DashScope',
    description: '阿里云百炼平台',
    apiKeyLabel: 'DashScope API Key',
  },
  {
    provider: 'openrouter',
    label: 'OpenRouter',
    description: 'OpenRouter 代理',
    apiKeyLabel: 'OpenRouter API Key',
  },
  {
    provider: 'generic',
    label: 'Generic',
    description: '自定义兼容 Anthropic 格式的 API',
    apiKeyLabel: 'API Key',
  },
];

export function Onboarding({ onDone }: Props): React.ReactNode {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [theme, setTheme] = useTheme();

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
    goToNextStep();
  }

  const platformStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <PlatformSetup onDone={handlePlatformDone} />
    </Box>
  );

  // Security step
  const securityStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Security notes:</Text>
      <Box flexDirection="column" width={70}>
        <OrderedList>
          <OrderedList.Item>
            <Text>ZY Code can make mistakes</Text>
            <Text dimColor wrap="wrap">
              You should always review ZY Code&apos;s responses, especially when
              <Newline />
              running code.
              <Newline />
            </Text>
          </OrderedList.Item>
          <OrderedList.Item>
            <Text>
              Due to prompt injection risks, only use it with code you trust
            </Text>
            <Text dimColor wrap="wrap">
              For more details see:
              <Newline />
              <Link url="https://code.claude.com/docs/en/security" />
            </Text>
          </OrderedList.Item>
        </OrderedList>
      </Box>
      <PressEnterToContinue />
    </Box>
  );

  // Build steps array
  const steps: OnboardingStep[] = [];
  steps.push({ id: 'theme', component: themeStep });
  steps.push({ id: 'platform', component: platformStep });
  steps.push({ id: 'security', component: securityStep });

  if (shouldOfferTerminalSetup()) {
    steps.push({
      id: 'terminal-setup',
      component: (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Use ZY Code&apos;s terminal setup?</Text>
          <Box flexDirection="column" width={70} gap={1}>
            <Text>
              For the optimal coding experience, enable the recommended settings
              <Newline />
              for your terminal:{' '}
              {process.env.TERM_PROGRAM === 'Apple_Terminal' ? 'Option+Enter for newlines and visual bell' : 'Shift+Enter for newlines'}
            </Text>
            <Select
              options={[
                { label: 'Yes, use recommended settings', value: 'install' },
                { label: 'No, maybe later with /terminal-setup', value: 'no' },
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
              {exitState.pending ? <>Press {exitState.keyName} again to exit</> : <>Enter to confirm · Esc to skip</>}
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
            <Text dimColor>Press {exitState.keyName} again to exit</Text>
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
        <Text bold>选择 AI 平台</Text>
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
          <Text dimColor>Enter to confirm · Esc to exit</Text>
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
      <Text bold>输入 {apiKeyLabel}</Text>
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
        <Text dimColor>Enter to confirm · 9 to go back</Text>
      </Box>
    </Box>
  );
}
