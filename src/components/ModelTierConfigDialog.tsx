/**
 * 模型档位与供应商配置流程组件。
 *
 * 解决会话中 /settings 和 /login 无法挑选/切换底层 Provider 和模型的断层。
 * 支持：
 * 1. 动态拉取指定 Provider 的最新可用模型（支持刷新与自定义输入）；
 * 2. 浏览已授权与可用平台并为 Standard / Advanced / Compact 绑定具体连接与模型；
 * 3. 显式配置和可视化管理各档位的降级备选链（添加、上移/下移、删除备选）；
 * 4. 显式配置模型故障降级触发策略（交互确认、自动通知、关闭降级）。
 */

import React, { useContext, useState } from 'react'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink/index.js'
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'
import {
  addModelTierCandidate,
  clearModelTierFallbacks,
  getModelTierCandidates,
  getModelTierProviderConnections,
  removeModelTierCandidate,
  reorderModelTierCandidates,
  saveModelFailoverPolicy,
  saveModelTierSelection,
  ShadowedModelTierError,
} from '../services/settings/modelTierSettings.js'
import { getInitialSettings } from '../services/settings/settings.js'
import type { ModelTier } from '../services/model/model.js'
import { getModelFailoverConfig } from '../services/model/modelChainState.js'
import { getAuthConfigForProvider } from '../services/auth/authConfig.js'
import { getProviderEntry } from '../services/model/providerRegistry.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { Select } from './CustomSelect/select.js'
import { ProviderModelPicker } from './ProviderModelPicker.js'

// ─── 全量模型档位与降级链展示工具函数 ─────────────────────────────────────

/** 命名连接没有翻译键；仅翻译注册平台，并保留用户设置的连接名。 */
export function formatModelTierProviderLabel(connectionId: string, provider: string): string {
  const key = `onboarding.platform.${provider}`
  const translated = tSync(key)
  const providerLabel = translated === key ? provider : translated
  return connectionId === provider ? providerLabel : `${connectionId} (${providerLabel})`
}

/** 清空会暴露旧列表时说明原因与替代操作，其余写入失败沿用通用提示。 */
export function getModelTierSaveErrorMessage(error: Error): string {
  if (error instanceof ShadowedModelTierError) {
    return tSync('settings.modelTierClearShadowed', {
      tier: error.tier,
      path: error.settingsPath,
    })
  }
  return tSync('settings.modelConfigSaveFailed')
}

export function formatModelTierSummary(entry: unknown): string {
  if (!entry) return tSync('settings.notConfigured')
  if (typeof entry === 'string') return entry
  if (Array.isArray(entry)) {
    if (entry.length === 0) return tSync('settings.notConfigured')
    const first = entry[0]
    const p =
      typeof first === 'object' && first !== null
        ? (first as { provider?: string }).provider
        : undefined
    const m =
      typeof first === 'object' && first !== null
        ? (first as { model?: string }).model
        : String(first)
    const primaryLabel = p ? `${p} · ${m}` : (m ?? '')
    if (entry.length > 1) {
      return tSync('settings.tierCandidatesSummary', {
        primary: primaryLabel,
        count: entry.length - 1,
      })
    }
    return tSync('settings.singleModelSummary', { model: primaryLabel })
  }
  if (typeof entry === 'object' && entry !== null) {
    const obj = entry as { model?: string; provider?: string }
    const label = obj.provider ? `${obj.provider} · ${obj.model}` : (obj.model ?? '')
    return tSync('settings.singleModelSummary', { model: label })
  }
  return tSync('settings.notConfigured')
}

export function formatFailoverPolicySummary(settings = getInitialSettings()): string {
  const config = getModelFailoverConfig(settings)
  return tSync(`settings.modelFailoverMode.${config.mode}`)
}

type ConfigStep =
  | 'select_tier'
  | 'manage_tier'
  | 'select_provider'
  | 'select_model'
  | 'manage_candidates'
  | 'candidate_action'
  | 'configure_policy'

export function ModelTierConfigFlow({
  onDone,
  onCancel,
}: {
  onDone(resultMessage?: string): void
  onCancel(): void
}): React.ReactNode {
  const [step, setStep] = useState<ConfigStep>('select_tier')
  const [selectedTier, setSelectedTier] = useState<ModelTier>('standard')
  const [selectedProvider, setSelectedProvider] = useState<string>('')
  const [actionType, setActionType] = useState<'primary' | 'fallback'>('primary')
  const [selectedCandidateIndex, setSelectedCandidateIndex] = useState<number>(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  const setAppState = useSetAppState()
  const currentModel = useAppState((state) => state.mainLoopModel)

  const settings = getInitialSettings()
  const models = settings.models ?? {}
  const currentTierCandidates = getModelTierCandidates(selectedTier, settings)
  const report = (result: { error: Error | null }): boolean => {
    setSaveError(result.error ? getModelTierSaveErrorMessage(result.error) : null)
    return !result.error
  }

  const terminalSize = useContext(TerminalSizeContext)
  const columns = terminalSize?.columns ?? process.stdout?.columns ?? 80
  // 动态自适应弹窗宽度（最小 76 列，终端较宽时延伸至上限 100 列），给右侧描述留出充裕空间，防止挤压折行
  const dialogWidth = Math.max(Math.min(columns - 4, 100), 76)

  // 步骤 1：选择要配置的档位或故障降级策略
  if (step === 'select_tier') {
    const tierOptions = [
      {
        label: `${tSync('onboarding.tier.option.standard')}`,
        value: 'standard',
        description: formatModelTierSummary(models.standard),
      },
      {
        label: `${tSync('onboarding.tier.option.advanced')}`,
        value: 'advanced',
        description: formatModelTierSummary(models.advanced),
      },
      {
        label: `${tSync('onboarding.tier.option.compact')}`,
        value: 'compact',
        description: formatModelTierSummary(models.compact),
      },
      {
        label: tSync('settings.modelFailoverPolicyOption'),
        value: '__policy__',
        description: formatFailoverPolicySummary(settings),
      },
    ]

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{tSync('settings.selectTierToConfigure')}</Text>
        <Box flexDirection="column" width={dialogWidth} gap={1}>
          <Select
            options={tierOptions}
            onChange={(selected) => {
              if (selected === '__policy__') {
                setStep('configure_policy')
                return
              }
              const tier = selected as ModelTier
              setSelectedTier(tier)
              setSaveError(null)
              const existing = getModelTierCandidates(tier, settings)
              if (existing.length === 0) {
                // 未配置时直接引导选择主模型
                setActionType('primary')
                setStep('select_provider')
              } else {
                // 已有配置时进入该档位的显式模型与降级管理面板
                setStep('manage_tier')
              }
            }}
            onCancel={onCancel}
          />
          <Text dimColor>{tSync('onboarding.enterToConfirm')}</Text>
        </Box>
      </Box>
    )
  }

  // 步骤 2：特定档位的显式管理面板（展示候选链，提供更换主选/追加备选/调序/清空）
  if (step === 'manage_tier') {
    const tierLabel = tSync(`onboarding.tier.option.${selectedTier}`) || selectedTier
    const options = [
      {
        label: tSync('settings.actionChangePrimary'),
        value: 'change_primary',
        description: tSync('settings.actionChangePrimaryDesc'),
      },
      {
        label: tSync('settings.actionAddFallback'),
        value: 'add_fallback',
        description: tSync('settings.actionAddFallbackDesc'),
      },
      ...(currentTierCandidates.length > 1
        ? [
            {
              label: tSync('settings.actionReorderCandidates'),
              value: 'reorder',
              description: tSync('settings.actionReorderCandidatesDesc'),
            },
            {
              label: tSync('settings.actionClearFallbacks'),
              value: 'clear_fallbacks',
              description: tSync('settings.actionClearFallbacksDesc'),
            },
          ]
        : []),
      {
        label: tSync('settings.backToTierList'),
        value: 'back',
      },
    ]

    return (
      <Box flexDirection="column" gap={1}>
        {saveError && <Text color="error">{saveError}</Text>}
        <Text bold>{tSync('settings.manageTierHeading', { tier: tierLabel })}</Text>
        <Text dimColor>{tSync('settings.currentCandidateQueue')}</Text>
        <Box flexDirection="column" paddingLeft={1}>
          {currentTierCandidates.map((c, i) => (
            <Text key={i}>
              {i === 0 ? (
                <Text color="success">{tSync('settings.primaryCandidateBadge')} </Text>
              ) : (
                <Text color="suggestion">
                  {tSync('settings.fallbackCandidateBadge', { index: i })}{' '}
                </Text>
              )}
              <Text bold>{c.provider}</Text> · {c.model}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" width={dialogWidth} gap={1} marginTop={1}>
          <Select
            options={options}
            onChange={(action) => {
              if (action === 'change_primary') {
                setActionType('primary')
                setStep('select_provider')
              } else if (action === 'add_fallback') {
                setActionType('fallback')
                setStep('select_provider')
              } else if (action === 'reorder') {
                setStep('manage_candidates')
              } else if (action === 'clear_fallbacks') {
                clearModelTierFallbacks(selectedTier, setAppState)
              } else {
                setStep('select_tier')
              }
            }}
            onCancel={() => setStep('select_tier')}
          />
          <Text dimColor>{tSync('onboarding.confirmBack')}</Text>
        </Box>
      </Box>
    )
  }

  // 步骤 3：选择候选列表中的某项进行调序或删除
  if (step === 'manage_candidates') {
    const candidateOptions = currentTierCandidates.map((c, i) => {
      const badge =
        i === 0
          ? tSync('settings.primaryCandidateBadge')
          : tSync('settings.fallbackCandidateBadge', { index: i })
      return {
        label: `${badge} ${c.provider} · ${c.model}`,
        value: String(i),
      }
    })
    candidateOptions.push({
      label: tSync('settings.backToManageTier'),
      value: '__back__',
    })

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{tSync('settings.reorderSelectPrompt')}</Text>
        <Box flexDirection="column" width={dialogWidth} gap={1}>
          <Select
            options={candidateOptions}
            onChange={(val) => {
              if (val === '__back__') {
                setStep('manage_tier')
                return
              }
              setSelectedCandidateIndex(Number(val))
              setStep('candidate_action')
            }}
            onCancel={() => setStep('manage_tier')}
          />
          <Text dimColor>{tSync('onboarding.confirmBack')}</Text>
        </Box>
      </Box>
    )
  }

  // 步骤 4：对具体候选节点执行动作（设为主选 / 上移 / 下移 / 移除）
  if (step === 'candidate_action') {
    const candidate = currentTierCandidates[selectedCandidateIndex]
    if (!candidate) {
      setStep('manage_tier')
      return null
    }

    const isPrimary = selectedCandidateIndex === 0
    const canMoveUp = selectedCandidateIndex > 0
    const canMoveDown = selectedCandidateIndex < currentTierCandidates.length - 1

    const actions = [
      ...(!isPrimary
        ? [
            {
              label: tSync('settings.candidateActionSetPrimary'),
              value: 'set_primary',
            },
          ]
        : []),
      ...(canMoveUp
        ? [
            {
              label: tSync('settings.candidateActionMoveUp'),
              value: 'move_up',
            },
          ]
        : []),
      ...(canMoveDown
        ? [
            {
              label: tSync('settings.candidateActionMoveDown'),
              value: 'move_down',
            },
          ]
        : []),
      {
        label: tSync('settings.candidateActionRemove'),
        value: 'remove',
      },
      {
        label: tSync('settings.backToManageTier'),
        value: 'back',
      },
    ]

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>
          {tSync('settings.candidateActionPrompt', {
            model: `${candidate.provider} · ${candidate.model}`,
          })}
        </Text>
        <Box flexDirection="column" width={dialogWidth} gap={1}>
          <Select
            options={actions}
            onChange={(action) => {
              if (action === 'set_primary') {
                reorderModelTierCandidates(selectedTier, selectedCandidateIndex, 0, setAppState)
                setStep('manage_tier')
              } else if (action === 'move_up') {
                reorderModelTierCandidates(
                  selectedTier,
                  selectedCandidateIndex,
                  selectedCandidateIndex - 1,
                  setAppState,
                )
                setStep('manage_tier')
              } else if (action === 'move_down') {
                reorderModelTierCandidates(
                  selectedTier,
                  selectedCandidateIndex,
                  selectedCandidateIndex + 1,
                  setAppState,
                )
                setStep('manage_tier')
              } else if (action === 'remove') {
                report(removeModelTierCandidate(selectedTier, selectedCandidateIndex, setAppState))
                setStep('manage_tier')
              } else {
                setStep('manage_tier')
              }
            }}
            onCancel={() => setStep('manage_tier')}
          />
          <Text dimColor>{tSync('onboarding.confirmBack')}</Text>
        </Box>
      </Box>
    )
  }

  // 步骤 5：故障降级策略设置
  if (step === 'configure_policy') {
    const policyOptions = [
      {
        label: tSync('settings.modelFailoverMode.confirm'),
        value: 'confirm',
        description: tSync('settings.modelFailoverMode.confirmDesc'),
      },
      {
        label: tSync('settings.modelFailoverMode.notify'),
        value: 'notify',
        description: tSync('settings.modelFailoverMode.notifyDesc'),
      },
      {
        label: tSync('settings.modelFailoverMode.off'),
        value: 'off',
        description: tSync('settings.modelFailoverMode.offDesc'),
      },
    ]

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{tSync('settings.modelFailoverPolicyPrompt')}</Text>
        <Box flexDirection="column" width={dialogWidth} gap={1}>
          <Select
            options={policyOptions}
            onChange={(mode) => {
              saveModelFailoverPolicy({
                mode: mode as 'confirm' | 'notify' | 'off',
                enabled: mode !== 'off',
              })
              const modeLabel = tSync(`settings.modelFailoverMode.${mode}`)
              onDone(tSync('settings.failoverPolicyUpdated', { mode: modeLabel }))
            }}
            onCancel={() => setStep('select_tier')}
          />
          <Text dimColor>{tSync('onboarding.confirmBack')}</Text>
        </Box>
      </Box>
    )
  }

  // 步骤 6：选择该档位使用的 Provider（用于主选或备选追加）
  if (step === 'select_provider') {
    const providerOptions = getModelTierProviderConnections().map((entry) => {
      const label = formatModelTierProviderLabel(entry.id, entry.provider)
      return {
        label: entry.configured ? `${label} [${tSync('settings.configuredBadge')}]` : label,
        value: entry.id,
        description: getProviderEntry(entry.provider)
          ? tSync(`onboarding.platform.${entry.provider}Desc`)
          : undefined,
      }
    })

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{tSync('settings.selectProviderForTier', { tier: selectedTier })}</Text>
        <Box flexDirection="column" width={dialogWidth} gap={1}>
          <Select
            options={providerOptions}
            onChange={(providerId) => {
              setSelectedProvider(providerId)
              setStep('select_model')
            }}
            onCancel={() => {
              if (currentTierCandidates.length > 0) {
                setStep('manage_tier')
              } else {
                setStep('select_tier')
              }
            }}
          />
          <Text dimColor>{tSync('onboarding.confirmBack')}</Text>
        </Box>
      </Box>
    )
  }

  // 步骤 7：选择该 Provider 下的模型并保存
  return (
    <Box flexDirection="column" gap={1}>
      {saveError && <Text color="error">{saveError}</Text>}
      <ProviderModelPicker
        provider={selectedProvider}
        title={tSync('settings.selectModelForTier', {
          tier: selectedTier,
          provider: formatModelTierProviderLabel(
            selectedProvider,
            getAuthConfigForProvider(selectedProvider)?.provider ?? selectedProvider,
          ),
        })}
        allowSkip={actionType === 'primary' && selectedTier !== 'standard'}
        skipLabel={tSync('onboarding.tier.skip')}
        onDone={(chosenModel) => {
          if (!chosenModel) {
            setStep(currentTierCandidates.length > 0 ? 'manage_tier' : 'select_tier')
            return
          }

          if (actionType === 'fallback') {
            // 追加备用降级节点
            const result = addModelTierCandidate(
              selectedTier,
              { provider: selectedProvider, model: chosenModel },
              setAppState,
            )
            if (!report(result)) {
              return
            }
            setStep('manage_tier')
          } else {
            // 设置/更换主选模型（自动保留现有备用降级链）
            const result = saveModelTierSelection(
              {
                tier: selectedTier,
                provider: selectedProvider,
                model: chosenModel,
                activate:
                  selectedTier === 'standard' ||
                  currentModel === selectedTier ||
                  settings.mainLoopModel === selectedTier,
              },
              setAppState,
            )
            if (!report(result)) {
              return
            }
            setStep('manage_tier')
          }
        }}
        onCancel={() => {
          setSaveError(null)
          setStep('select_provider')
        }}
      />
    </Box>
  )
}
