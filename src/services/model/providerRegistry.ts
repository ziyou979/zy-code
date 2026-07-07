/**
 * 集中式 Provider 注册表。
 *
 * 新增平台只需在下方 PROVIDER_REGISTRY 中添加一条记录即可。
 * 其他模块（providers.ts、config.ts、client.ts、Onboarding.tsx）
 * 均从此注册表自动派生行为，无需额外修改。
 */

import type { ProviderCapability } from './providers.js'
import {
  type ModelCapabilityMatchContext,
  localModelHasAdaptiveThinking,
} from '../../utils/settings/localModelCapabilities.js'
import { API_FORMATS, type ApiFormat } from './apiFormat.js'

/**
 * 模型推荐档位 — 对应 ZY Code 的 advanced / standard / compact 三个模型档位。
 */
export type ModelTier = 'advanced' | 'standard' | 'compact'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * 支持的 API 消息格式：
 * - `'anthropic'` — Anthropic Messages API 格式
 * - `'openai'`    — 直接使用 OpenAI SDK（不走 Anthropic SDK）
 * - `'google'`    — Google Generative AI 原生 API 格式（Gemini）
 */
/**
 * Provider base URL 解析模式（单值，可组合为数组使用）：
 * - `'env'`     — 支持通过环境变量覆盖 base URL
 * - `'default'` — 有内置默认值（defaultBaseUrls）
 * - `'custom'`  — 用户可手动输入 base URL（onboarding 或 settings）
 */
export type EndpointMode = 'env' | 'default' | 'custom'

/**
 * Provider base URL 解析方式（EndpointMode 的组合）。
 * 常见组合：
 * - `['default']`           — 只用默认值（anthropic、bedrock 等）
 * - `['env', 'default']`    — 优先环境变量，否则默认值（dashscope、zhipu 等）
 * - `['default', 'custom']` — 有默认值但用户可覆盖（deepseek、siliconflow 等）
 * - `['custom']`            — 纯用户自定义（ollama、lmstudio 等）
 */
export type EndpointType = EndpointMode[]

export interface ProviderEntry {
  /** 唯一标识符 — 会成为 APIProvider 联合类型的成员 */
  id: string

  /**
   * 该 provider 支持的 API 消息格式列表。
   * - `['anthropic']`        — 仅 Anthropic 格式
   * - `['openai']`           — 使用 OpenAI SDK 直连
   * - `['google']`           — 使用 Google Generative AI 原生格式
   * - `['anthropic', 'openai']` — 双格式，用户在 onboarding 时选择
   */
  supportedFormats: ApiFormat[]

  /**
   * 同一 provider 下按模型选择不同 API 消息格式。
   * pattern 为大小写不敏感的 substring match，优先级低于用户本地 model-capabilities。
   */
  modelApiFormats?: Array<{
    pattern: string
    apiFormat: ApiFormat
  }>

  /** 运行时 base URL 的解析方式 */
  endpointType: EndpointType

  /** Provider 级别的能力声明 */
  capabilities: ProviderCapability[]

  /**
   * 默认 base URL。
   * - env-or-default 类型：环境变量未设置时使用
   * - preconfigured 类型：onboarding 时保存到 configuredBaseUrl
   * - 多格式 provider：按 'openai'、'anthropic'、'google' 分别配置
   */
  defaultBaseUrls?: {
    openai?: string
    anthropic?: string
    google?: string
  }

  /** 覆盖 base URL 的环境变量名（仅 env-or-default 类型，如 DASHSCOPE_BASE_URL） */
  baseUrlEnvVar?: string

  // -- Onboarding UI 元数据 --------------------------------------------------

  /** onboarding 中显示的 API Key 标签（如 "DashScope API Key"） */
  apiKeyLabel?: string

  /** API Key 输入框下方显示的 base URL 提示 */
  baseUrlHint?: string

  /** onboarding 模型选择步骤中显示的推荐模型（每个档位推荐一个） */
  suggestedModels?: Array<{
    label: string
    value: string
    /** 模型档位，Onboarding 会据此渲染 i18n 描述 */
    tier: ModelTier
  }>

  /** 是否在 onboarding 平台列表中显示，默认 true。基础设施 provider（bedrock 等）设为 false */
  showInOnboarding?: boolean

  /** OpenAI 兼容协议的扩展属性（thinking 参数、reasoning_content 支持等）。消息转换层读取此配置而非判断 provider 名称 */
  openaiAttr?: OpenAiAttr
}

/**
 * OpenAI 兼容协议的扩展属性声明。
 * 协议实现代码通过读取此字段决定行为，新增 provider 只需声明配置。
 */
export interface OpenAiAttr {
  thinking?: {
    /** 启用 thinking 时传给 API 的参数。effort 为映射后的 provider 参数值，model 为模型名 */
    enable: (
      effort: string | undefined,
      model?: string,
      context?: ModelCapabilityMatchContext,
    ) => Record<string, unknown>
    /** 显式禁用 thinking 时传给 API 的参数（省略则不传），支持按模型动态生成 */
    disable?:
      | Record<string, unknown>
      | ((effort: string | undefined, model?: string) => Record<string, unknown>)
  }

  /**
   * 是否需要从流式 content 中剥离泄漏的 think/thinking 标签。
   * DashScope/Qwen 模型在 thinking 结束时可能将 `</think>` 标签泄漏到 content 字段。
   */
  stripThinkingTags?: boolean
}

/**
 * OpenAI 兼容协议默认 thinking 映射。
 *
 * 大多数 OpenAI-compatible 平台逐步收敛到 `thinking.type` 形态；
 * provider 只有在确实使用私有字段时才覆盖对应分支。
 */
export const DEFAULT_OPENAI_THINKING_ATTR: NonNullable<OpenAiAttr['thinking']> = {
  enable: (effort, model, context) => {
    if (model && localModelHasAdaptiveThinking(model, context)) {
      return { thinking: { type: 'adaptive' } }
    }
    // OpenAI 标准参数 reasoning_effort（如 o1/o3 系列的 low/medium/high）
    return effort
      ? { thinking: { type: 'enabled' }, reasoning_effort: effort }
      : { thinking: { type: 'enabled' } }
  },
  disable: { thinking: { type: 'disabled' } },
}

// ---------------------------------------------------------------------------
// 预设能力集（减少重复）
// ---------------------------------------------------------------------------

/** 完整能力集 — 适用于 Anthropic 官方 API、generic 等。 */
const FULL_CAPABILITIES: ProviderCapability[] = ['context_management', 'advisor']

/** 标准能力集 — 适用于大多数第三方平台和本地推理引擎 */
const STANDARD_CAPABILITIES: ProviderCapability[] = ['context_management']

// ---------------------------------------------------------------------------
// 注册表（按 id 字母序排列）
// ---------------------------------------------------------------------------

export const PROVIDER_REGISTRY: readonly ProviderEntry[] = [
  {
    id: 'anthropic',
    supportedFormats: ['anthropic'],
    endpointType: ['default'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'Anthropic API Key',
    suggestedModels: [
      { label: 'claude-opus-4-8', value: 'claude-opus-4-8', tier: 'advanced' },
      { label: 'claude-sonnet-5', value: 'claude-sonnet-5', tier: 'standard' },
      { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5', tier: 'compact' },
    ],
  },
  {
    id: 'qianfan',
    supportedFormats: ['openai'],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { openai: 'https://aistudio.baidu.com/llm/lmapi/v3' },
    apiKeyLabel: 'Baidu API Key',
    suggestedModels: [
      { label: 'deepseek-r1', value: 'deepseek-r1', tier: 'advanced' },
      { label: 'ernie-4.5-8k', value: 'ernie-4.5-8k', tier: 'standard' },
      { label: 'ernie-4.5-turbo-8k', value: 'ernie-4.5-turbo-8k', tier: 'compact' },
    ],
  },
  {
    id: 'bedrock',
    supportedFormats: ['anthropic'],
    endpointType: ['env', 'default'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { anthropic: 'https://bedrock-runtime.us-east-1.amazonaws.com' },
    baseUrlEnvVar: 'BEDROCK_BASE_URL',
    apiKeyLabel: 'AWS Access Key',
    baseUrlHint: 'https://bedrock-runtime.{region}.amazonaws.com',
    suggestedModels: [
      { label: 'claude-opus-4-8', value: 'claude-opus-4-8', tier: 'advanced' },
      { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6', tier: 'standard' },
      { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5', tier: 'compact' },
    ],
  },
  {
    id: 'dashscope',
    supportedFormats: ['openai', 'anthropic'],
    endpointType: ['env', 'default'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: {
      openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic/',
    },
    baseUrlEnvVar: 'DASHSCOPE_BASE_URL',
    apiKeyLabel: 'DashScope API Key',
    suggestedModels: [
      { label: 'qwen3.7-max', value: 'qwen3.5-plus', tier: 'advanced' },
      { label: 'qwen3.7-plus', value: 'qwen3.6-plus', tier: 'standard' },
      { label: 'qwen3.6-flash', value: 'qwen3.5-flash', tier: 'compact' },
    ],
    openaiAttr: {
      stripThinkingTags: true,
    },
  },
  {
    id: 'deepseek',
    supportedFormats: ['openai', 'anthropic'],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { openai: 'https://api.deepseek.com' },
    apiKeyLabel: 'DeepSeek API Key',
    suggestedModels: [
      { label: 'deepseek-v4-pro', value: 'deepseek-v4-pro', tier: 'advanced' },
      { label: 'deepseek-v4-pro', value: 'deepseek-v4-pro', tier: 'standard' },
      { label: 'deepseek-v4-flash', value: 'deepseek-v4-flash', tier: 'compact' },
    ],
  },
  {
    id: 'fireworks',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: {
      openai: 'https://api.fireworks.ai/inference/v1',
      anthropic: 'https://api.fireworks.ai/inference/v1',
    },
    apiKeyLabel: 'Fireworks API Key',
    suggestedModels: [
      {
        label: 'accounts/fireworks/models/qwen3-235b-a22b',
        value: 'accounts/fireworks/models/qwen3-235b-a22b',
        tier: 'advanced',
      },
      {
        label: 'accounts/fireworks/models/llama4-maverick-instruct-basic',
        value: 'accounts/fireworks/models/llama4-maverick-instruct-basic',
        tier: 'standard',
      },
      {
        label: 'accounts/fireworks/models/deepseek-r1',
        value: 'accounts/fireworks/models/deepseek-r1',
        tier: 'compact',
      },
    ],
  },
  {
    id: 'azure',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: ['env', 'default'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: {
      anthropic: 'https://models.inference.ai.azure.com',
      openai: 'https://models.inference.ai.azure.com',
    },
    baseUrlEnvVar: 'AZURE_BASE_URL',
    apiKeyLabel: 'Microsoft Azure API Key',
    baseUrlHint: 'https://{resource}.services.ai.azure.com/models',
    suggestedModels: [
      { label: 'claude-opus-4-8', value: 'claude-opus-4-8', tier: 'advanced' },
      { label: 'claude-sonnet-5', value: 'claude-sonnet-5', tier: 'standard' },
      { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5', tier: 'compact' },
    ],
  },
  {
    id: 'gemini',
    supportedFormats: ['google', 'openai'],
    endpointType: ['env', 'default'],
    capabilities: ['context_management'],
    apiKeyLabel: 'Google AI API Key',
    defaultBaseUrls: {
      google: 'https://generativelanguage.googleapis.com/v1beta',
      openai: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    },
    suggestedModels: [
      { label: 'gemini-2.5-pro', value: 'gemini-2.5-pro', tier: 'advanced' },
      { label: 'gemini-2.5-flash', value: 'gemini-2.5-flash', tier: 'standard' },
      { label: 'gemini-3-flash', value: 'gemini-3-flash', tier: 'compact' },
    ],
  },
  {
    id: 'generic',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: ['custom'],
    capabilities: FULL_CAPABILITIES,
    apiKeyLabel: 'API Key',
  },
  {
    id: 'groq',
    supportedFormats: ['openai'],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { openai: 'https://api.groq.com/openai/v1' },
    apiKeyLabel: 'Groq API Key',
    suggestedModels: [
      {
        label: 'deepseek-r1-distill-llama-70b',
        value: 'deepseek-r1-distill-llama-70b',
        tier: 'advanced',
      },
      {
        label: 'llama-3.3-70b-versatile',
        value: 'llama-3.3-70b-versatile',
        tier: 'standard',
      },
      { label: 'llama-3.1-8b-instant', value: 'llama-3.1-8b-instant', tier: 'compact' },
    ],
  },
  {
    id: 'pangu',
    supportedFormats: ['openai'],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { openai: 'https://api.modelarts-maas.com/openai/v1' },
    apiKeyLabel: '华为盘古 API Key',
    suggestedModels: [
      { label: 'DeepSeek-R1', value: 'DeepSeek-R1', tier: 'advanced' },
      { label: 'DeepSeek-V4-pro', value: 'DeepSeek-V4-pro', tier: 'standard' },
    ],
  },
  {
    id: 'kimi',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: ['env', 'default'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: {
      openai: 'https://api.moonshot.cn/v1',
      anthropic: 'https://api.moonshot.cn/anthropic',
    },
    baseUrlEnvVar: 'KIMI_BASE_URL',
    apiKeyLabel: 'Kimi API Key',
    suggestedModels: [
      { label: 'moonshot-v1', value: 'moonshot-v1', tier: 'standard' },
      { label: 'moonshot-v1-8k', value: 'moonshot-v1-8k', tier: 'compact' },
    ],
    openaiAttr: {
      thinking: {
        enable: (_effort, model) => {
          const m = (model ?? '').toLowerCase()
          if (m.includes('kimi-k2-thinking') || m.includes('k2-thinking')) {
            return { chat_template_args: { enable_thinking: true } }
          }
          return { enable_thinking: true }
        },
      },
    },
  },
  {
    id: 'lmstudio',
    supportedFormats: ['openai'],
    endpointType: ['custom'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { openai: 'http://localhost:1234/v1' },
    apiKeyLabel: 'API Key',
    baseUrlHint: 'http://localhost:1234/v1',
  },
  {
    id: 'llamacpp',
    supportedFormats: ['openai'],
    endpointType: ['custom'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { openai: 'http://localhost:8080/v1' },
    apiKeyLabel: 'API Key',
    baseUrlHint: 'http://localhost:8080/v1',
  },
  {
    id: 'minimax',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: {
      openai: 'https://api.minimaxi.com/v1',
      anthropic: 'https://api.minimaxi.com/anthropic',
    },
    apiKeyLabel: 'MiniMax API Key',
    suggestedModels: [
      { label: 'MiniMax-M1', value: 'MiniMax-M1', tier: 'advanced' },
      { label: 'MiniMax-Text-01', value: 'MiniMax-Text-01', tier: 'standard' },
    ],
  },
  {
    id: 'mimo',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: ['env', 'default'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: {
      openai: 'https://api.xiaomimimo.com/v1',
      anthropic: 'https://api.xiaomimimo.com/anthropic',
    },
    baseUrlEnvVar: 'MIMO_BASE_URL',
    apiKeyLabel: 'MiMo API Key',
    suggestedModels: [
      { label: 'mimo-v2.5-pro', value: 'mimo-v2.5-pro', tier: 'advanced' },
      { label: 'mimo-v2.5', value: 'mimo-v2.5', tier: 'standard' },
      { label: 'mimo-v2-flash', value: 'mimo-v2-flash', tier: 'compact' },
    ],
  },
  {
    id: 'nim',
    supportedFormats: ['openai'],
    endpointType: ['custom'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { openai: 'https://integrate.api.nvidia.com/v1' },
    apiKeyLabel: 'NVIDIA API Key',
    baseUrlHint: 'https://integrate.api.nvidia.com/v1',
  },
  {
    id: 'ollama',
    supportedFormats: ['openai'],
    endpointType: ['custom'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { openai: 'http://localhost:11434/v1' },
    apiKeyLabel: 'API Key',
    baseUrlHint: 'http://localhost:11434/v1',
    suggestedModels: [
      { label: 'deepseek-r1', value: 'deepseek-r1', tier: 'advanced' },
      { label: 'qwen2.5-coder', value: 'qwen2.5-coder', tier: 'standard' },
      { label: 'llama3.1', value: 'llama3.1', tier: 'compact' },
    ],
  },
  {
    id: 'openai',
    supportedFormats: ['openai'],
    endpointType: ['default'],
    capabilities: ['context_management'],
    apiKeyLabel: 'OpenAI API Key',
    suggestedModels: [
      { label: 'gpt-4o', value: 'gpt-4o', tier: 'standard' },
      { label: 'gpt-4o-mini', value: 'gpt-4o-mini', tier: 'compact' },
    ],
  },
  {
    id: 'opencode-go',
    supportedFormats: ['openai', 'anthropic'],
    modelApiFormats: [
      { pattern: 'glm-5.2', apiFormat: 'openai' },
      { pattern: 'glm-5.1', apiFormat: 'openai' },
      { pattern: 'kimi-k2.7-code', apiFormat: 'openai' },
      { pattern: 'kimi-k2.6', apiFormat: 'openai' },
      { pattern: 'deepseek-v4-pro', apiFormat: 'openai' },
      { pattern: 'deepseek-v4-flash', apiFormat: 'openai' },
      { pattern: 'mimo-v2.5-pro', apiFormat: 'openai' },
      { pattern: 'mimo-v2.5', apiFormat: 'openai' },
      { pattern: 'minimax-m3', apiFormat: 'anthropic' },
      { pattern: 'minimax-m2.7', apiFormat: 'anthropic' },
      { pattern: 'minimax-m2.5', apiFormat: 'anthropic' },
      { pattern: 'qwen3.7-max', apiFormat: 'anthropic' },
      { pattern: 'qwen3.7-plus', apiFormat: 'anthropic' },
      { pattern: 'qwen3.6-plus', apiFormat: 'anthropic' },
    ],
    endpointType: ['default'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: {
      openai: 'https://opencode.ai/zen/go/v1',
      anthropic: 'https://opencode.ai/zen/go',
    },
    apiKeyLabel: 'OpenCode Go API Key',
    suggestedModels: [
      { label: 'Qwen3.7 Max', value: 'qwen3.7-max', tier: 'advanced' },
      { label: 'GLM-5.2', value: 'glm-5.2', tier: 'standard' },
      { label: 'DeepSeek V4 Flash', value: 'deepseek-v4-flash', tier: 'compact' },
    ],
  },
  {
    id: 'openrouter',
    supportedFormats: ['anthropic'],
    endpointType: ['default'],
    capabilities: ['context_management'],
    // OpenRouter reasoning.effort 支持 low/medium/high（映射由 mapEffortToProvider 处理）。
    apiKeyLabel: 'OpenRouter API Key',
    defaultBaseUrls: {
      openai: 'https://openrouter.ai/api/v1',
      anthropic: 'https://openrouter.ai/api',
    },
    suggestedModels: [
      { label: 'anthropic/claude-opus-4', value: 'anthropic/claude-opus-4', tier: 'advanced' },
      {
        label: 'anthropic/claude-sonnet-4',
        value: 'anthropic/claude-sonnet-4',
        tier: 'standard',
      },
      {
        label: 'anthropic/claude-haiku-3.5',
        value: 'anthropic/claude-haiku-3.5',
        tier: 'compact',
      },
    ],
    openaiAttr: {
      thinking: {
        enable: (effort) => ({
          reasoning: { effort: (effort === 'on' ? undefined : effort) ?? 'medium' },
        }),
      },
    },
  },
  {
    id: 'perplexity',
    supportedFormats: ['openai'],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { openai: 'https://api.perplexity.ai' },
    apiKeyLabel: 'Perplexity API Key',
    suggestedModels: [
      { label: 'sonar-pro', value: 'sonar-pro', tier: 'advanced' },
      { label: 'sonar-reasoning-pro', value: 'sonar-reasoning-pro', tier: 'standard' },
      { label: 'sonar', value: 'sonar', tier: 'compact' },
    ],
  },
  {
    id: 'siliconflow',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: {
      openai: 'https://api.siliconflow.cn/v1',
      anthropic: 'https://api.siliconflow.cn/',
    },
    apiKeyLabel: 'SiliconFlow API Key',
    suggestedModels: [
      { label: 'Qwen/Qwen3-235B-A22B', value: 'Qwen/Qwen3-235B-A22B', tier: 'advanced' },
      {
        label: 'deepseek-ai/DeepSeek-V3',
        value: 'deepseek-ai/DeepSeek-V3',
        tier: 'standard',
      },
      { label: 'Qwen/Qwen3-30B-A3B', value: 'Qwen/Qwen3-30B-A3B', tier: 'compact' },
    ],
  },
  {
    id: 'tencent',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: {
      openai: 'https://api.lkeap.cloud.tencent.com/v1',
      anthropic: 'https://api.lkeap.cloud.tencent.com/coding/anthropic',
    },
    apiKeyLabel: 'Tencent Cloud API Key',
    suggestedModels: [
      { label: 'deepseek-r1', value: 'deepseek-r1', tier: 'advanced' },
      { label: 'deepseek-v3', value: 'deepseek-v3', tier: 'standard' },
      { label: 'hunyuan-turbos', value: 'hunyuan-turbos', tier: 'compact' },
    ],
  },
  {
    id: 'together',
    supportedFormats: ['openai'],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { openai: 'https://api.together.xyz/v1' },
    apiKeyLabel: 'Together AI API Key',
    suggestedModels: [
      { label: 'Qwen/Qwen3-235B-A22B', value: 'Qwen/Qwen3-235B-A22B', tier: 'advanced' },
      {
        label: 'meta-llama/Llama-4-Maverick-17B-128E',
        value: 'meta-llama/Llama-4-Maverick-17B-128E',
        tier: 'standard',
      },
      { label: 'deepseek-ai/DeepSeek-R1', value: 'deepseek-ai/DeepSeek-R1', tier: 'compact' },
    ],
  },
  {
    id: 'vertex',
    supportedFormats: ['anthropic'],
    endpointType: ['env', 'default'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { anthropic: 'https://us-central1-aiplatform.googleapis.com/v1' },
    baseUrlEnvVar: 'VERTEX_BASE_URL',
    apiKeyLabel: 'GCP API Key',
    baseUrlHint: 'https://{region}-aiplatform.googleapis.com/v1',
    suggestedModels: [
      { label: 'claude-opus-4-8', value: 'claude-opus-4-8', tier: 'advanced' },
      { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6', tier: 'standard' },
      { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5', tier: 'compact' },
    ],
  },
  {
    id: 'ark',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: {
      openai: 'https://ark.cn-beijing.volces.com/api/v3',
      anthropic: 'https://ark.cn-beijing.volces.com/api/coding',
    },
    apiKeyLabel: 'ARK API Key',
    suggestedModels: [
      { label: 'deepseek-r1', value: 'deepseek-r1', tier: 'advanced' },
      {
        label: 'doubao-1.5-pro-256k',
        value: 'doubao-1.5-pro-256k',
        tier: 'standard',
      },
      { label: 'doubao-1.5-lite-32k', value: 'doubao-1.5-lite-32k', tier: 'compact' },
    ],
  },
  {
    id: 'zhipu',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: ['env', 'default'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: {
      openai: 'https://open.bigmodel.cn/api/paas/v4/',
      anthropic: 'https://open.bigmodel.cn/api/anthropic',
    },
    baseUrlEnvVar: 'ZHIPU_BASE_URL',
    apiKeyLabel: 'ZHIPU API Key',
    suggestedModels: [
      { label: 'glm-4-plus', value: 'glm-4-plus', tier: 'standard' },
      { label: 'glm-4-flash', value: 'glm-4-flash', tier: 'compact' },
    ],
  },
] as const

// ---------------------------------------------------------------------------
// 查询辅助函数
// ---------------------------------------------------------------------------

/** provider id → entry 的映射，O(1) 查找 */
const REGISTRY_MAP = new Map<string, ProviderEntry>(
  PROVIDER_REGISTRY.map((entry) => [entry.id, entry]),
)

/** 根据 id 获取 provider 配置，未找到返回 undefined */
export function getProviderEntry(id: string): ProviderEntry | undefined {
  return REGISTRY_MAP.get(id)
}

/** 获取所有应在 onboarding 平台列表中显示的 provider ID */
export function getOnboardingProviderIds(): string[] {
  return PROVIDER_REGISTRY.filter((entry) => entry.showInOnboarding !== false).map(
    (entry) => entry.id,
  )
}

/** 获取所有已注册的 provider ID */
export function getAllProviderIds(): string[] {
  return PROVIDER_REGISTRY.map((entry) => entry.id)
}
