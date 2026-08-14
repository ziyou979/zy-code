// 为打破循环依赖而抽出的关键系统常量。

import { getAPIProvider } from '../services/model/providers.js'

const DEFAULT_PREFIX = `You are ZY Code, an AI-powered CLI.`
const AGENT_SDK_ZY_CODE_PRESET_PREFIX = `You are ZY Code, an AI-powered CLI, running within the Agent SDK.`
const AGENT_SDK_PREFIX = `You are an agent, built on Agent SDK.`

const CLI_SYSPROMPT_PREFIX_VALUES = [
  DEFAULT_PREFIX,
  AGENT_SDK_ZY_CODE_PRESET_PREFIX,
  AGENT_SDK_PREFIX,
] as const

export type CLISyspromptPrefix = (typeof CLI_SYSPROMPT_PREFIX_VALUES)[number]

/**
 * CLI sysprompt 所有可能的前缀值，供 splitSysPromptPrefix 按内容而非位置识别前缀块。
 */
export const CLI_SYSPROMPT_PREFIXES: ReadonlySet<string> = new Set(CLI_SYSPROMPT_PREFIX_VALUES)

export function getCLISyspromptPrefix(options?: {
  isNonInteractive: boolean
  hasAppendSystemPrompt: boolean
}): CLISyspromptPrefix {
  if (options?.isNonInteractive) {
    if (options.hasAppendSystemPrompt) {
      return AGENT_SDK_ZY_CODE_PRESET_PREFIX
    }
    return AGENT_SDK_PREFIX
  }
  return DEFAULT_PREFIX
}
