/**
 * 集中式 Provider 注册表。
 *
 * 新增平台只需在下方 PROVIDER_REGISTRY 中添加一条记录即可。
 * 其他模块（providers.ts、config.ts、client.ts、Onboarding.tsx）
 * 均从此注册表自动派生行为，无需额外修改。
 */

import type { ProviderCapability } from './providers.js'
import { localModelHasAdaptiveThinking } from '../../utils/settings/localModelCapabilities.js'

/**
 * 模型能力标签 — 用于 onboarding 中统一渲染模型描述。
 * 新增标签时需同步在 i18n 中添加 'model.tag.{tag}' 的翻译。
 */
export type ModelTag =
  | 'recommended'
  | 'fast'
  | 'lightweight'
  | 'reasoning'
  | 'balanced'
  | 'coding'
  | 'flagship'
  | 'budget'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * 支持的 API 消息格式：
 * - `'anthropic'` — Anthropic Messages API 格式
 * - `'openai'`    — 直接使用 OpenAI SDK（不走 Anthropic SDK）
 * - `'google'`    — Google Generative AI 原生 API 格式（Gemini）
 */
export type ApiFormat = 'anthropic' | 'openai' | 'google'

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

  /** onboarding 模型选择步骤中显示的推荐模型 */
  suggestedModels?: Array<{
    label: string
    value: string
    /** 通用能力标签，Onboarding 会根据标签自动渲染 i18n 描述 */
    tags?: ModelTag[]
  }>

  /** 是否在 onboarding 平台列表中显示，默认 true。基础设施 provider（bedrock 等）设为 false */
  showInOnboarding?: boolean

  /** OpenAI 兼容协议的扩展属性（thinking 参数、reasoning_content 支持等）。消息转换层读取此配置而非判断 provider 名称 */
  openaiAttr?: OpenAiAttr

  /** 内部 effort 档位 → provider API 参数值的映射表。省略时回退到 anthropic 映射 */
  effortMapping?: Record<string, string>
}

/**
 * OpenAI 兼容协议的扩展属性声明。
 * 协议实现代码通过读取此字段决定行为，新增 provider 只需声明配置。
 */
export interface OpenAiAttr {
  thinking?: {
    /** 启用 thinking 时传给 API 的参数。effort 为映射后的 provider 参数值，model 为模型名 */
    enable: (effort: string | undefined, model?: string) => Record<string, unknown>
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

// ---------------------------------------------------------------------------
// 预设能力集（减少重复）
// ---------------------------------------------------------------------------

/** 完整能力集 — 适用于 Anthropic 官方 API、generic 等。effort 档位见 effortMapping。 */
const FULL_CAPABILITIES: ProviderCapability[] = [
  'context_management',
  'advisor',
]

/** 标准能力集 — 适用于大多数第三方平台和本地推理引擎 */
const STANDARD_CAPABILITIES: ProviderCapability[] = [
  'context_management',
]

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
      { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6', tags: ['recommended', 'balanced'] },
      { label: 'claude-opus-4-8', value: 'claude-opus-4-8', tags: ['flagship'] },
      { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5', tags: ['fast', 'budget'] },
    ],
    effortMapping: {
      off: 'off',
      quick: 'low',
      light: 'medium',
      balanced: 'high',
      thorough: 'xhigh',
      extreme: 'max',
      orchestrate: 'max',
    },
  },
  {
    id: 'qianfan',
    supportedFormats: ['openai'],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { openai: 'https://aistudio.baidu.com/llm/lmapi/v3' },
    apiKeyLabel: 'Baidu API Key',
    suggestedModels: [
      { label: 'ernie-4.5-8k', value: 'ernie-4.5-8k', tags: ['recommended', 'balanced'] },
      { label: 'ernie-4.5-turbo-8k', value: 'ernie-4.5-turbo-8k', tags: ['fast'] },
      { label: 'deepseek-r1', value: 'deepseek-r1', tags: ['reasoning'] },
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
      { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6', tags: ['recommended', 'balanced'] },
      { label: 'claude-opus-4-8', value: 'claude-opus-4-8', tags: ['flagship'] },
      { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5', tags: ['fast', 'budget'] },
    ],
    effortMapping: {
      off: 'off',
      quick: 'low',
      light: 'medium',
      balanced: 'high',
      thorough: 'xhigh',
      extreme: 'max',
      orchestrate: 'max',
    },
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
      { label: 'qwen3.6-plus', value: 'qwen3.6-plus', tags: ['recommended', 'balanced'] },
      { label: 'qwen3.5-plus', value: 'qwen3.5-plus', tags: ['reasoning'] },
      { label: 'qwen3.5-flash', value: 'qwen3.5-flash', tags: ['fast', 'lightweight'] },
    ],
    effortMapping: {
      off: 'off',
      balanced: 'high',
      extreme: 'max',
    },
    openaiAttr: {
      thinking: {
        // DashScope 平台统一使用 thinking.type 控制思考模式，避免与
        // enable_thinking 混发导致 API 冲突。按模型区分 type 值：
        // 根据模型能力配置判断使用 adaptive 还是 enabled：
        // - 配置了 thinking.adaptive: true 的模型用 'adaptive'
        // - 其余模型用 'enabled'
        enable: (_effort, model) => {
          if (model && localModelHasAdaptiveThinking(model)) {
            return { thinking: { type: 'adaptive' } }
          }
          return { thinking: { type: 'enabled' } }
        },
        disable: () => ({ thinking: { type: 'disabled' } }),
      },
      stripThinkingTags: true,
    },
  },
  {
    id: 'deepseek',
    supportedFormats: ['openai', 'anthropic'],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    // DeepSeek reasoning_effort 支持 low/medium/high（映射由 mapEffortToProvider 处理）。
    defaultBaseUrls: { openai: 'https://api.deepseek.com' },
    apiKeyLabel: 'DeepSeek API Key',
    suggestedModels: [
      { label: 'deepseek-chat', value: 'deepseek-chat', tags: ['recommended', 'balanced'] },
      { label: 'deepseek-reasoner', value: 'deepseek-reasoner', tags: ['reasoning'] },
    ],
    effortMapping: {
      off: 'off',
      balanced: 'high',
      extreme: 'max',
    },
    openaiAttr: {
      thinking: {
        enable: (effort) => ({ reasoning_effort: (effort === 'on' ? undefined : effort) ?? 'medium' }),
      },
    },
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
        tags: ['flagship'],
      },
      {
        label: 'accounts/fireworks/models/deepseek-r1',
        value: 'accounts/fireworks/models/deepseek-r1',
        tags: ['reasoning'],
      },
      {
        label: 'accounts/fireworks/models/llama4-maverick-instruct-basic',
        value: 'accounts/fireworks/models/llama4-maverick-instruct-basic',
        tags: ['recommended', 'balanced'],
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
      { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6', tags: ['recommended', 'balanced'] },
      { label: 'claude-opus-4-8', value: 'claude-opus-4-8', tags: ['flagship'] },
      { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5', tags: ['fast', 'budget'] },
    ],
    effortMapping: {
      off: 'off',
      quick: 'low',
      light: 'medium',
      balanced: 'high',
      thorough: 'xhigh',
      extreme: 'max',
      orchestrate: 'max',
    },
    openaiAttr: {
      thinking: {
        enable: (effort) => ({ reasoning_effort: (effort === 'on' ? undefined : effort) ?? 'medium' }),
      },
    },
  },
  {
    id: 'gemini',
    supportedFormats: ['google', 'openai'],
    endpointType: ['env', 'default'],
    capabilities: ['context_management'],
    // Gemini reasoning_effort 支持 minimal/low/medium/high（映射由 mapEffortToProvider 处理）。
    apiKeyLabel: 'Google AI API Key',
    defaultBaseUrls: {
      google: 'https://generativelanguage.googleapis.com/v1beta',
      openai: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    },
    suggestedModels: [
      { label: 'gemini-2.5-flash', value: 'gemini-2.5-flash', tags: ['recommended', 'fast'] },
      { label: 'gemini-2.5-pro', value: 'gemini-2.5-pro', tags: ['reasoning', 'flagship'] },
      { label: 'gemini-3-flash', value: 'gemini-3-flash', tags: ['fast', 'balanced'] },
    ],
    effortMapping: {
      off: 'off',
      quick: 'minimal',
      light: 'low',
      balanced: 'medium',
      thorough: 'high',
      extreme: 'high',
      orchestrate: 'high',
    },
    openaiAttr: {
      thinking: {
        enable: (effort) => ({ reasoning_effort: (effort === 'on' ? undefined : effort) ?? 'medium' }),
      },
    },
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
        label: 'llama-3.3-70b-versatile',
        value: 'llama-3.3-70b-versatile',
        tags: ['recommended', 'balanced'],
      },
      {
        label: 'deepseek-r1-distill-llama-70b',
        value: 'deepseek-r1-distill-llama-70b',
        tags: ['reasoning'],
      },
      { label: 'llama-3.1-8b-instant', value: 'llama-3.1-8b-instant', tags: ['fast', 'budget'] },
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
      { label: 'DeepSeek-V4-pro', value: 'DeepSeek-V4-pro', tags: ['recommended', 'balanced'] },
      { label: 'DeepSeek-R1', value: 'DeepSeek-R1', tags: ['reasoning'] },
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
      { label: 'moonshot-v1', value: 'moonshot-v1', tags: ['recommended'] },
      { label: 'moonshot-v1-8k', value: 'moonshot-v1-8k', tags: ['lightweight'] },
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
      { label: 'MiniMax-M1', value: 'MiniMax-M1', tags: ['flagship', 'reasoning'] },
      { label: 'MiniMax-Text-01', value: 'MiniMax-Text-01', tags: ['recommended', 'balanced'] },
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
      { label: 'mimo-v2.5-pro', value: 'mimo-v2.5-pro', tags: ['flagship', 'reasoning'] },
      { label: 'mimo-v2.5', value: 'mimo-v2.5', tags: ['recommended', 'balanced'] },
      { label: 'mimo-v2-flash', value: 'mimo-v2-flash', tags: ['fast', 'lightweight'] },
    ],
    openaiAttr: {
      thinking: {
        enable: () => ({ thinking: { type: 'enabled' } }),
        disable: { thinking: { type: 'disabled' } },
      },
    },
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
      { label: 'qwen2.5-coder', value: 'qwen2.5-coder', tags: ['coding'] },
      { label: 'llama3.1', value: 'llama3.1', tags: ['balanced'] },
      { label: 'deepseek-r1', value: 'deepseek-r1', tags: ['reasoning'] },
    ],
  },
  {
    id: 'openai',
    supportedFormats: ['openai'],
    endpointType: ['default'],
    capabilities: ['context_management'],
    // OpenAI reasoning_effort 支持 minimal/low/medium/high（映射由 mapEffortToProvider 处理）。
    apiKeyLabel: 'OpenAI API Key',
    suggestedModels: [
      { label: 'gpt-4o', value: 'gpt-4o', tags: ['recommended', 'balanced'] },
      { label: 'gpt-4o-mini', value: 'gpt-4o-mini', tags: ['fast', 'lightweight'] },
    ],
    effortMapping: {
      off: 'off',
      quick: 'minimal',
      light: 'low',
      balanced: 'medium',
      thorough: 'high',
      extreme: 'high',
      orchestrate: 'high',
    },
    openaiAttr: {
      thinking: {
        enable: (effort) => ({ reasoning_effort: (effort === 'on' ? undefined : effort) ?? 'medium' }),
      },
    },
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
      {
        label: 'anthropic/claude-sonnet-4',
        value: 'anthropic/claude-sonnet-4',
        tags: ['recommended', 'balanced'],
      },
      { label: 'anthropic/claude-opus-4', value: 'anthropic/claude-opus-4', tags: ['flagship'] },
      { label: 'google/gemini-2.5-pro', value: 'google/gemini-2.5-pro', tags: ['reasoning'] },
      {
        label: 'anthropic/claude-haiku-3.5',
        value: 'anthropic/claude-haiku-3.5',
        tags: ['fast', 'budget'],
      },
    ],
    effortMapping: {
      off: 'off',
      quick: 'low',
      light: 'low',
      balanced: 'medium',
      thorough: 'high',
      extreme: 'high',
      orchestrate: 'high',
    },
    openaiAttr: {
      thinking: {
        enable: (effort) => ({ reasoning: { effort: (effort === 'on' ? undefined : effort) ?? 'medium' } }),
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
      { label: 'sonar-pro', value: 'sonar-pro', tags: ['recommended', 'flagship'] },
      { label: 'sonar', value: 'sonar', tags: ['fast', 'budget'] },
      { label: 'sonar-reasoning-pro', value: 'sonar-reasoning-pro', tags: ['reasoning'] },
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
      { label: 'Qwen/Qwen3-235B-A22B', value: 'Qwen/Qwen3-235B-A22B', tags: ['flagship'] },
      {
        label: 'deepseek-ai/DeepSeek-V3',
        value: 'deepseek-ai/DeepSeek-V3',
        tags: ['recommended', 'balanced'],
      },
      { label: 'deepseek-ai/DeepSeek-R1', value: 'deepseek-ai/DeepSeek-R1', tags: ['reasoning'] },
      { label: 'Qwen/Qwen3-30B-A3B', value: 'Qwen/Qwen3-30B-A3B', tags: ['fast', 'budget'] },
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
      { label: 'deepseek-v3', value: 'deepseek-v3', tags: ['recommended', 'balanced'] },
      { label: 'deepseek-r1', value: 'deepseek-r1', tags: ['reasoning'] },
      { label: 'hunyuan-turbos', value: 'hunyuan-turbos', tags: ['fast'] },
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
      { label: 'Qwen/Qwen3-235B-A22B', value: 'Qwen/Qwen3-235B-A22B', tags: ['flagship'] },
      { label: 'deepseek-ai/DeepSeek-R1', value: 'deepseek-ai/DeepSeek-R1', tags: ['reasoning'] },
      {
        label: 'meta-llama/Llama-4-Maverick-17B-128E',
        value: 'meta-llama/Llama-4-Maverick-17B-128E',
        tags: ['recommended', 'balanced'],
      },
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
      { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6', tags: ['recommended', 'balanced'] },
      { label: 'claude-opus-4-8', value: 'claude-opus-4-8', tags: ['flagship'] },
      { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5', tags: ['fast', 'budget'] },
    ],
    effortMapping: {
      off: 'off',
      quick: 'low',
      light: 'medium',
      balanced: 'high',
      thorough: 'xhigh',
      extreme: 'max',
      orchestrate: 'max',
    },
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
      {
        label: 'doubao-1.5-pro-256k',
        value: 'doubao-1.5-pro-256k',
        tags: ['recommended', 'balanced'],
      },
      { label: 'doubao-1.5-lite-32k', value: 'doubao-1.5-lite-32k', tags: ['fast', 'budget'] },
      { label: 'deepseek-r1', value: 'deepseek-r1', tags: ['reasoning'] },
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
      { label: 'glm-4-plus', value: 'glm-4-plus', tags: ['recommended', 'balanced'] },
      { label: 'glm-4-flash', value: 'glm-4-flash', tags: ['fast'] },
    ],
    openaiAttr: {
      thinking: {
        enable: () => ({ thinking: { type: 'enabled', clear_thinking: false } }),
      },
    },
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
