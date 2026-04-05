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
    provider: 'anthropic',
    label: 'Anthropic',
    description: '官方 API (api.anthropic.com)',
    apiKeyLabel: 'Anthropic API Key',
    suggestedModels: [
      { label: 'Sonnet 4.6', value: 'zy-sonnet-4-6-20250514', description: '日常任务首选 (推荐)' },
      { label: 'Opus 4.6', value: 'zy-opus-4-6-20250514', description: '最强能力，适合复杂工作' },
      { label: 'Haiku 4.5', value: 'zy-haiku-4-5-20240307', description: '最快最便宜' },
    ],
  },
  {
    provider: 'dashscope',
    label: '百炼 DashScope',
    description: '阿里云百炼平台',
    apiKeyLabel: 'DashScope API Key',
    suggestedModels: [
      { label: 'qwen3.6-plus', value: 'qwen3.6-plus', description: '综合能力强 (推荐)' },
      { label: 'qwen3.5-plus', value: 'qwen3.5-plus', description: '高性能推理' },
      { label: 'qwen3.5-flash', value: 'qwen3.5-flash', description: '快速轻量任务' },
    ],
  },
  {
    provider: 'openrouter',
    label: 'OpenRouter',
    description: 'OpenRouter 代理',
    apiKeyLabel: 'OpenRouter API Key',
    suggestedModels: [
      { label: 'Sonnet', value: 'anthropic/zy-sonnet-4-6-20250514', description: '日常任务首选 (推荐)' },
      { label: 'Opus', value: 'anthropic/zy-opus-4-6-20250514', description: '最强能力' },
    ],
  },
  {
    provider: 'generic',
    label: 'Generic',
    description: '自定义兼容 Anthropic 格式的 API',
    apiKeyLabel: 'API Key',
  },
];

/**
 * Model options for providers without pre-configured suggestions (generic).
 */
const GENERIC_MODEL_OPTIONS: Array<{ label: string; value: string; description: string }> = [
  { label: '自定义模型', value: '__custom__', description: '输入完整的模型名称' },
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
              <Link url="https://code.zy.com/docs/en/security" />
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
  steps.push({ id: 'model', component: modelStep });
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
        <Text bold>输入模型名称</Text>
        <Box flexDirection="column" width={60} gap={1}>
          <Select
            options={[
              {
                type: 'input',
                label: 'Model name',
                value: 'input',
                placeholder: 'e.g. qwen-max, zy-sonnet-4-6...',
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
          <Text dimColor>Enter to confirm · 9 to go back</Text>
        </Box>
      </>
    );
  }

  return (
    <>
      <Text bold>选择默认对话模型</Text>
      <Text dimColor>启动对话时使用的模型，后续可通过 /model 切换</Text>
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
          <Text dimColor>或选择 "自定义模型" 输入其他模型</Text>
        )}
        <Text dimColor>Enter to confirm · Esc to skip</Text>
      </Box>
    </>
  );
}
