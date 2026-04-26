import { getInitialMainLoopModel } from '../../bootstrap/state.js';
import { getSettings_DEPRECATED } from '../settings/settings.js';
import { getLocalModelCapability } from '../settings/localModelCapabilities.js';
import { getAPIProvider } from './providers.js';
import { isModelAllowed } from './modelAllowlist.js';
import { getDefaultMainLoopModelSetting, getMarketingNameForModel, getUserSpecifiedModelSetting, renderDefaultModelSetting, type ModelSetting } from './model.js';
import { getGlobalConfig } from '../config.js';
import { isInternalBuild } from '../envUtils.js';

export type ModelOption = {
  value: ModelSetting;
  label: string;
  description: string;
  descriptionForModel?: string;
};

export function getDefaultOptionForUser(): ModelOption {
  if (isInternalBuild()) {
    const currentModel = renderDefaultModelSetting(getDefaultMainLoopModelSetting());
    return {
      value: null,
      label: 'Default (recommended)',
      description: `Use the default model for Ants (currently ${currentModel})`,
      descriptionForModel: `Default model (currently ${currentModel})`
    };
  }

  return {
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model (currently ${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})`
  };
}

/**
 * 为指定 tier 构建模型选项。
 * 从 settings.json 的 models tier 映射读取实际模型 ID，
 * label 从 model-capabilities.json 的 pattern 获取（或直接用模型 ID）。
 */
function getTierOption(tier: string): ModelOption | undefined {
  const settings = getSettings_DEPRECATED()
  const tierModel = settings?.models?.[tier]
  if (!tierModel) return undefined

  const cap = getLocalModelCapability(tierModel)

  return {
    value: tier,
    label: cap?.pattern ?? tierModel,
    description: `${tierModel}`,
    descriptionForModel: `${tierModel}`,
  }
}

function getStandardOption(): ModelOption {
  return getTierOption('standard') ?? {
    value: 'standard',
    label: 'Standard',
    description: 'Standard tier · Best for everyday tasks',
    descriptionForModel: 'Standard tier - best for everyday tasks. Generally recommended for most coding tasks'
  };
}

function getAdvancedOption(): ModelOption {
  return getTierOption('advanced') ?? {
    value: 'advanced',
    label: 'Advanced',
    description: 'Advanced tier · Most capable for complex work',
    descriptionForModel: 'Advanced tier - most capable for complex work'
  };
}

function getCompactOption(): ModelOption {
  return getTierOption('compact') ?? {
    value: 'compact',
    label: 'Compact',
    description: 'Compact tier · Fastest for quick answers',
    descriptionForModel: 'Compact tier - faster and lower cost, but less capable than standard tier. Use for simple tasks.'
  };
}

function getModelOptionsBase(): ModelOption[] {
  // 自定义模型优先：完全替换内置 tier 选项
  const settings = getSettings_DEPRECATED() || {};
  if (settings.customModels && settings.customModels.length > 0) {
    const customModelOptions: ModelOption[] = settings.customModels.map(m => ({
      value: m.alias,
      label: m.label ?? m.alias,
      description: m.description ?? `Custom model (${m.model})`
    }));
    return [getDefaultOptionForUser(), ...customModelOptions];
  }

  if (isInternalBuild()) {
    // @ts-ignore
    const antModelOptions: ModelOption[] = getAntModels().map(m => ({
      value: m.alias,
      label: m.label,
      description: m.description ?? `[INNER-ONLY] ${m.label} (${m.model})`
    }));
    return [getDefaultOptionForUser(), ...antModelOptions, getAdvancedOption(), getStandardOption(), getCompactOption()];
  }

  // 外部用户：Default + 三个 tier
  return [
    getDefaultOptionForUser(),
    getStandardOption(),
    getAdvancedOption(),
    getCompactOption(),
  ];
}

/**
 * Returns a ModelOption for a known model with a human-readable label.
 * Returns null if the model is not recognized.
 */
function getKnownModelOption(model: string): ModelOption | null {
  const marketingName = getMarketingNameForModel(model);
  if (!marketingName) return null;
  return {
    value: model,
    label: marketingName,
    description: model
  };
}

export function getModelOptions(): ModelOption[] {
  const options = getModelOptionsBase();

  // 通过环境变量注入的自定义模型选项
  const envCustomModel = process.env.ZY_CODE_CUSTOM_MODEL_OPTION;
  if (envCustomModel && !options.some(existing => existing.value === envCustomModel)) {
    options.push({
      value: envCustomModel,
      label: process.env.ZY_CODE_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description: process.env.ZY_CODE_CUSTOM_MODEL_OPTION_DESCRIPTION ?? `Custom model (${envCustomModel})`
    });
  }

  // bootstrap 期间获取的额外模型选项
  for (const opt of getGlobalConfig().additionalModelOptionsCache ?? []) {
    if (!options.some(existing => existing.value === opt.value)) {
      options.push(opt);
    }
  }

  // 确保当前使用的模型出现在选项列表中
  let customModel: ModelSetting = null;
  const currentMainLoopModel = getUserSpecifiedModelSetting();
  const initialMainLoopModel = getInitialMainLoopModel();
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel;
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel;
  }
  if (customModel !== null && !options.some(opt => opt.value === customModel)) {
    const knownOption = getKnownModelOption(customModel);
    if (knownOption) {
      options.push(knownOption);
    } else {
      options.push({
        value: customModel,
        label: customModel,
        description: 'Custom model'
      });
    }
  }

  return filterModelOptionsByAllowlist(options);
}

/**
 * Filter model options by the availableModels allowlist.
 * Always preserves the "Default" option (value: null).
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getSettings_DEPRECATED() || {};
  if (!settings.availableModels) {
    return options;
  }
  return options.filter(opt => opt.value === null || (opt.value !== null && isModelAllowed(opt.value)));
}
