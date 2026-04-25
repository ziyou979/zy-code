// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getInitialMainLoopModel } from '../../bootstrap/state.js';
import { getModelStrings } from './modelStrings.js';
import { COST_TIER_3_15, COST_HAIKU_35, COST_HAIKU_45, formatModelPricing } from '../modelCost.js';
import { getSettings_DEPRECATED } from '../settings/settings.js';
import { getLocalModelCapability } from '../settings/localModelCapabilities.js';
import { getAPIProvider, providerHasCapability } from './providers.js';
import { isModelAllowed } from './modelAllowlist.js';
import { getDefaultHaikuModel, getDefaultMainLoopModelSetting, getMarketingNameForModel, getUserSpecifiedModelSetting, isOpus1mMergeEnabled, renderDefaultModelSetting, type ModelSetting } from './model.js';
import { getGlobalConfig } from '../config.js';
import { isInternalBuild } from '../envUtils.js';

// @[MODEL LAUNCH]: Update all the available and default model option strings below.

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

  // PAYG
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  return {
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model (currently ${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`
  };
}

/**
 * 为 3P Provider 用户构建 tier 对应的自定义模型选项。
 * 从 settings.json 的 models tier 映射读取实际模型 ID，
 * label 从 model-capabilities.json 的 pattern 获取（或直接用模型 ID）。
 */
function getCustomTierOption(tier: string, alias: ModelSetting): ModelOption | undefined {
  const settings = getSettings_DEPRECATED()
  const tierModel = settings?.models?.[tier]
  if (!tierModel) return undefined

  // 从 model-capabilities.json 获取配置信息（如果有）
  const cap = getLocalModelCapability(tierModel)

  return {
    value: alias,
    label: cap?.pattern ?? tierModel,
    description: `${tierModel}`,
    descriptionForModel: `${tierModel}`,
  }
}

function getCustomSonnetOption(): ModelOption | undefined {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  if (!is3P) return undefined;
  return getCustomTierOption('advanced', 'sonnet');
}

// @[MODEL LAUNCH]: Update or add model option functions (getSonnetXXOption, getOpusXXOption, etc.)
// with the new model's label and description. These appear in the /model picker.
function getSonnet46Option(): ModelOption {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  return {
    value: is3P ? (getModelStrings() as any).sonnet46 : 'sonnet',
    label: 'Sonnet',
    description: `Sonnet 4.6 · Best for everyday tasks${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel: 'Sonnet 4.6 - best for everyday tasks. Generally recommended for most coding tasks'
  };
}
function getCustomOpusOption(): ModelOption | undefined {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  if (!is3P) return undefined;
  return getCustomTierOption('best', 'opus');
}
function getOpus41Option(): ModelOption {
  return {
    value: 'opus',
    label: 'Opus 4.1',
    description: `Opus 4.1 · Legacy`,
    descriptionForModel: 'Opus 4.1 - legacy version'
  };
}
function getOpus46Option(): ModelOption {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  return {
    value: is3P ? (getModelStrings() as any).opus46 : 'opus',
    label: 'Opus',
    description: `Opus 4.6 · Most capable for complex work`,
    descriptionForModel: 'Opus 4.6 - most capable for complex work'
  };
}
export function getSonnet46_1MOption(): ModelOption {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  return {
    value: is3P ? (getModelStrings() as any).sonnet46 + '[1m]' : 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 4.6 for long sessions${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel: 'Sonnet 4.6 with 1M context window - for long sessions with large codebases'
  };
}
export function getOpus46_1MOption(): ModelOption {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  return {
    value: is3P ? (getModelStrings() as any).opus46 + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.6 for long sessions`,
    descriptionForModel: 'Opus 4.6 with 1M context window - for long sessions with large codebases'
  };
}
function getCustomHaikuOption(): ModelOption | undefined {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  if (!is3P) return undefined;
  return getCustomTierOption('compact', 'haiku');
}
function getHaiku45Option(): ModelOption {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 4.5 · Fastest for quick answers${is3P ? '' : ` · ${formatModelPricing(COST_HAIKU_45)}`}`,
    descriptionForModel: 'Haiku 4.5 - fastest for quick answers. Lower cost but less capable than Sonnet 4.6.'
  };
}
function getHaiku35Option(): ModelOption {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 3.5 for simple tasks${is3P ? '' : ` · ${formatModelPricing(COST_HAIKU_35)}`}`,
    descriptionForModel: 'Haiku 3.5 - faster and lower cost, but less capable than Sonnet. Use for simple tasks.'
  };
}
function getHaikuOption(): ModelOption {
  // Return correct Haiku option based on provider
  const haikuModel = getDefaultHaikuModel();
  return haikuModel === (getModelStrings() as any).haiku45 ? getHaiku45Option() : getHaiku35Option();
}
function getMaxOpusOption(): ModelOption {
  return {
    value: 'opus',
    label: 'Opus',
    description: `Opus 4.6 · Most capable for complex work`
  };
}
export function getMaxSonnet46_1MOption(): ModelOption {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  return {
    value: 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 4.6 with 1M context${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`
  };
}
export function getMaxOpus46_1MOption(): ModelOption {
  return {
    value: 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.6 with 1M context`
  };
}
function getMergedOpus1MOption(): ModelOption {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  return {
    value: is3P ? (getModelStrings() as any).opus46 + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.6 with 1M context · Most capable for complex work`,
    descriptionForModel: 'Opus 4.6 with 1M context - most capable for complex work'
  };
}
const MaxSonnet46Option: ModelOption = {
  value: 'sonnet',
  label: 'Sonnet',
  description: 'Sonnet 4.6 · Best for everyday tasks'
};
const MaxHaiku45Option: ModelOption = {
  value: 'haiku',
  label: 'Haiku',
  description: 'Haiku 4.5 · Fastest for quick answers'
};
function getOpusPlanOption(): ModelOption {
  return {
    value: 'opusplan',
    label: 'Opus Plan Mode',
    description: 'Use Opus 4.6 in plan mode, Sonnet 4.6 otherwise'
  };
}

// @[MODEL LAUNCH]: Update the model picker lists below to include/reorder options for the new model.
// Each user tier (ant, Max/Team Premium, Pro/Team Standard/Enterprise, direct API, cloud provider API) has its own list.
function getModelOptionsBase(): ModelOption[] {
  // If user has defined custom models in settings, use those exclusively
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
    // Build options from antModels config
    // @ts-ignore
    const antModelOptions: ModelOption[] = getAntModels().map(m => ({
      value: m.alias,
      label: m.label,
      description: m.description ?? `[INNER-ONLY] ${m.label} (${m.model})`
    }));
    return [getDefaultOptionForUser(), ...antModelOptions, getMergedOpus1MOption(), getSonnet46Option(), getSonnet46_1MOption(), getHaiku45Option()];
  }

  // Direct API (PAYG): Default (Sonnet) + Opus 4.6 + Haiku
  if (providerHasCapability(getAPIProvider(), 'prompt_caching')) {
    const payg1POptions = [getDefaultOptionForUser()];
    payg1POptions.push(getOpus46Option());
    payg1POptions.push(getHaiku45Option());
    return payg1POptions;
  }

  // PAYG 3P: Default (Sonnet 4.5) + Sonnet (3P custom) or Sonnet 4.6 + Opus (3P custom) or Opus 4.1/Opus 4.6 + Haiku
  const payg3pOptions = [getDefaultOptionForUser()];
  const customSonnet = getCustomSonnetOption();
  if (customSonnet !== undefined) {
    payg3pOptions.push(customSonnet);
  } else {
    payg3pOptions.push(getSonnet46Option());
  }
  const customOpus = getCustomOpusOption();
  if (customOpus !== undefined) {
    payg3pOptions.push(customOpus);
  } else {
    payg3pOptions.push(getOpus41Option());
    payg3pOptions.push(getOpus46Option());
  }
  const customHaiku = getCustomHaikuOption();
  if (customHaiku !== undefined) {
    payg3pOptions.push(customHaiku);
  } else {
    payg3pOptions.push(getHaikuOption());
  }
  return payg3pOptions;
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

  // Add the custom model from the ZY_CODE_CUSTOM_MODEL_OPTION env var
  const envCustomModel = process.env.ZY_CODE_CUSTOM_MODEL_OPTION;
  if (envCustomModel && !options.some(existing => existing.value === envCustomModel)) {
    options.push({
      value: envCustomModel,
      label: process.env.ZY_CODE_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description: process.env.ZY_CODE_CUSTOM_MODEL_OPTION_DESCRIPTION ?? `Custom model (${envCustomModel})`
    });
  }

  // Append additional model options fetched during bootstrap
  for (const opt of getGlobalConfig().additionalModelOptionsCache ?? []) {
    if (!options.some(existing => existing.value === opt.value)) {
      options.push(opt);
    }
  }

  // Add custom model from either the current model value or the initial one
  // if it is not already in the options.
  let customModel: ModelSetting = null;
  const currentMainLoopModel = getUserSpecifiedModelSetting();
  const initialMainLoopModel = getInitialMainLoopModel();
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel;
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel;
  }
  if (customModel === null || options.some(opt => opt.value === customModel)) {
    return filterModelOptionsByAllowlist(options);
  } else if (customModel === 'opusplan') {
    return filterModelOptionsByAllowlist([...options, getOpusPlanOption()]);
  } else if (customModel === 'opus' && providerHasCapability(getAPIProvider(), 'interleaved_thinking')) {
    return filterModelOptionsByAllowlist([...options, getMaxOpusOption()]);
  } else if (customModel === 'opus[1m]' && providerHasCapability(getAPIProvider(), 'interleaved_thinking')) {
    return filterModelOptionsByAllowlist([...options, getMergedOpus1MOption()]);
  } else {
    // Try to show a human-readable label for known Anthropic models, with an
    // upgrade hint if the alias now resolves to a newer version.
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
    return filterModelOptionsByAllowlist(options);
  }
}

/**
 * Filter model options by the availableModels allowlist.
 * Always preserves the "Default" option (value: null).
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getSettings_DEPRECATED() || {};
  if (!settings.availableModels) {
    return options; // No restrictions
  }
  return options.filter(opt => opt.value === null || opt.value !== null && isModelAllowed(opt.value));
}
