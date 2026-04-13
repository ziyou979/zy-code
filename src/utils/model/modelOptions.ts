// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getInitialMainLoopModel } from '../../bootstrap/state.js';
import { getModelStrings } from './modelStrings.js';
import { COST_TIER_3_15, COST_HAIKU_35, COST_HAIKU_45, formatModelPricing } from '../modelCost.js';
import { getSettings_DEPRECATED } from '../settings/settings.js';
import { checkOpus1mAccess, checkSonnet1mAccess } from './check1mAccess.js';
import { getAPIProvider, providerHasCapability } from './providers.js';
import { isModelAllowed } from './modelAllowlist.js';
import { getDefaultHaikuModel, getDefaultMainLoopModelSetting, getMarketingNameForModel, getUserSpecifiedModelSetting, isOpus1mMergeEnabled, getOpus46PricingSuffix, renderDefaultModelSetting, type ModelSetting } from './model.js';
import { has1mContext } from '../context.js';
import { getGlobalConfig } from '../config.js';
import { isInternalBuild } from '../envUtils.js';

// @[MODEL LAUNCH]: Update all the available and default model option strings below.

export type ModelOption = {
  value: ModelSetting;
  label: string;
  description: string;
  descriptionForModel?: string;
};
export function getDefaultOptionForUser(fastMode = false): ModelOption {
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
function getCustomSonnetOption(): ModelOption | undefined {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  const customSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  // When a 3P user has a custom sonnet model string, show it directly
  if (is3P && customSonnetModel) {
    const is1m = has1mContext(customSonnetModel);
    return {
      value: 'sonnet',
      label: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME ?? customSonnetModel,
      description: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ?? `Custom Sonnet model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ?? `Custom Sonnet model${is1m ? ' with 1M context' : ''}`} (${customSonnetModel})`
    };
  }
}

// @[MODEL LAUNCH]: Update or add model option functions (getSonnetXXOption, getOpusXXOption, etc.)
// with the new model's label and description. These appear in the /model picker.
function getSonnet46Option(): ModelOption {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  return {
    value: is3P ? getModelStrings().sonnet46 : 'sonnet',
    label: 'Sonnet',
    description: `Sonnet 4.6 · Best for everyday tasks${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel: 'Sonnet 4.6 - best for everyday tasks. Generally recommended for most coding tasks'
  };
}
function getCustomOpusOption(): ModelOption | undefined {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  const customOpusModel = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  // When a 3P user has a custom opus model string, show it directly
  if (is3P && customOpusModel) {
    const is1m = has1mContext(customOpusModel);
    return {
      value: 'opus',
      label: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME ?? customOpusModel,
      description: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ?? `Custom Opus model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ?? `Custom Opus model${is1m ? ' with 1M context' : ''}`} (${customOpusModel})`
    };
  }
}
function getOpus41Option(): ModelOption {
  return {
    value: 'opus',
    label: 'Opus 4.1',
    description: `Opus 4.1 · Legacy`,
    descriptionForModel: 'Opus 4.1 - legacy version'
  };
}
function getOpus46Option(fastMode = false): ModelOption {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  return {
    value: is3P ? getModelStrings().opus46 : 'opus',
    label: 'Opus',
    description: `Opus 4.6 · Most capable for complex work${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel: 'Opus 4.6 - most capable for complex work'
  };
}
export function getSonnet46_1MOption(): ModelOption {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  return {
    value: is3P ? getModelStrings().sonnet46 + '[1m]' : 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 4.6 for long sessions${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel: 'Sonnet 4.6 with 1M context window - for long sessions with large codebases'
  };
}
export function getOpus46_1MOption(fastMode = false): ModelOption {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  return {
    value: is3P ? getModelStrings().opus46 + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.6 for long sessions${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel: 'Opus 4.6 with 1M context window - for long sessions with large codebases'
  };
}
function getCustomHaikuOption(): ModelOption | undefined {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  const customHaikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  // When a 3P user has a custom haiku model string, show it directly
  if (is3P && customHaikuModel) {
    return {
      value: 'haiku',
      label: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME ?? customHaikuModel,
      description: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ?? 'Custom Haiku model',
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ?? 'Custom Haiku model'} (${customHaikuModel})`
    };
  }
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
  return haikuModel === getModelStrings().haiku45 ? getHaiku45Option() : getHaiku35Option();
}
function getMaxOpusOption(fastMode = false): ModelOption {
  return {
    value: 'opus',
    label: 'Opus',
    description: `Opus 4.6 · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true) : ''}`
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
export function getMaxOpus46_1MOption(fastMode = false): ModelOption {
  return {
    value: 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.6 with 1M context${getOpus46PricingSuffix(fastMode)}`
  };
}
function getMergedOpus1MOption(fastMode = false): ModelOption {
  const is3P = !providerHasCapability(getAPIProvider(), 'interleaved_thinking');
  return {
    value: is3P ? getModelStrings().opus46 + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.6 with 1M context · Most capable for complex work${!is3P && fastMode ? getOpus46PricingSuffix(fastMode) : ''}`,
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
function getModelOptionsBase(fastMode = false): ModelOption[] {
  // If user has defined custom models in settings, use those exclusively
  const settings = getSettings_DEPRECATED() || {};
  if (settings.customModels && settings.customModels.length > 0) {
    const customModelOptions: ModelOption[] = settings.customModels.map(m => ({
      value: m.alias,
      label: m.label ?? m.alias,
      description: m.description ?? `Custom model (${m.model})`
    }));
    return [getDefaultOptionForUser(fastMode), ...customModelOptions];
  }
  if (isInternalBuild()) {
    // Build options from antModels config
    const antModelOptions: ModelOption[] = getAntModels().map(m => ({
      value: m.alias,
      label: m.label,
      description: m.description ?? `[ANT-ONLY] ${m.label} (${m.model})`
    }));
    return [getDefaultOptionForUser(), ...antModelOptions, getMergedOpus1MOption(fastMode), getSonnet46Option(), getSonnet46_1MOption(), getHaiku45Option()];
  }

  // Direct API (PAYG): Default (Sonnet) + Sonnet 1M + Opus 4.6 + Opus 1M + Haiku
  if (providerHasCapability(getAPIProvider(), 'prompt_caching')) {
    const payg1POptions = [getDefaultOptionForUser(fastMode)];
    if (checkSonnet1mAccess()) {
      payg1POptions.push(getSonnet46_1MOption());
    }
    if (isOpus1mMergeEnabled()) {
      payg1POptions.push(getMergedOpus1MOption(fastMode));
    } else {
      payg1POptions.push(getOpus46Option(fastMode));
      if (checkOpus1mAccess()) {
        payg1POptions.push(getOpus46_1MOption(fastMode));
      }
    }
    payg1POptions.push(getHaiku45Option());
    return payg1POptions;
  }

  // PAYG 3P: Default (Sonnet 4.5) + Sonnet (3P custom) or Sonnet 4.6/1M + Opus (3P custom) or Opus 4.1/Opus 4.6/Opus1M + Haiku + Opus 4.1
  const payg3pOptions = [getDefaultOptionForUser(fastMode)];
  const customSonnet = getCustomSonnetOption();
  if (customSonnet !== undefined) {
    payg3pOptions.push(customSonnet);
  } else {
    // Add Sonnet 4.6 since Sonnet 4.5 is the default
    payg3pOptions.push(getSonnet46Option());
    if (checkSonnet1mAccess()) {
      payg3pOptions.push(getSonnet46_1MOption());
    }
  }
  const customOpus = getCustomOpusOption();
  if (customOpus !== undefined) {
    payg3pOptions.push(customOpus);
  } else {
    // Add Opus 4.1, Opus 4.6 and Opus 4.6 1M
    payg3pOptions.push(getOpus41Option()); // This is the default opus
    payg3pOptions.push(getOpus46Option(fastMode));
    if (checkOpus1mAccess()) {
      payg3pOptions.push(getOpus46_1MOption(fastMode));
    }
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
export function getModelOptions(fastMode = false): ModelOption[] {
  const options = getModelOptionsBase(fastMode);

  // Add the custom model from the ANTHROPIC_CUSTOM_MODEL_OPTION env var
  const envCustomModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
  if (envCustomModel && !options.some(existing => existing.value === envCustomModel)) {
    options.push({
      value: envCustomModel,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ?? `Custom model (${envCustomModel})`
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
    return filterModelOptionsByAllowlist([...options, getMaxOpusOption(fastMode)]);
  } else if (customModel === 'opus[1m]' && providerHasCapability(getAPIProvider(), 'interleaved_thinking')) {
    return filterModelOptionsByAllowlist([...options, getMergedOpus1MOption(fastMode)]);
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
