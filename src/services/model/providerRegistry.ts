/**
 * 集中式 Provider 注册表。
 *
 * 新增平台只需在下方 PROVIDER_REGISTRY 中添加一条记录即可。
 * 其他模块（providers.ts、config.ts、client.ts、Onboarding.tsx）
 * 均从此注册表自动派生行为，无需额外修改。
 */

import {
  localModelHasAdaptiveThinking,
  type ModelCapabilityMatchContext,
} from '../settings/localModelCapabilities.js'
import type { ApiFormat } from './apiFormat.js'
import type { ProviderCapability } from './providers.js'

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
 * - `'openai-chat'`    — 直接使用 OpenAI SDK（不走 Anthropic SDK）
 * - `'google'`    — Google Generative AI 原生 API 格式（Gemini）
 */
/**
 * Provider base URL 解析模式（单值，可组合为数组使用）：
 * - `'env'`     — 支持通过环境变量覆盖 base URL
 * - `'default'` — 有内置默认值（formatEndpoints[].baseUrl）
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

/**
 * 单一 API 消息格式及其内置端点。
 *
 * `formatEndpoints` 是 provider 格式能力的唯一事实来源：
 * - 支持哪些格式 = 数组中所有 `format`
 * - 默认格式 = 数组首位（原 supportedFormats[0] 语义）
 * - 各格式的默认端点 = 对应条目的 `baseUrl`（省略表示由 SDK 决定，
 *   如 Anthropic SDK 自带的官方端点）
 */
export interface FormatEndpoint {
  format: ApiFormat
  baseUrl?: string
}

export interface ProviderEntry {
  /** 唯一标识符 — 会成为 APIProvider 联合类型的成员 */
  id: string

  /**
   * 该 provider 支持的 API 消息格式及各格式内置端点。
   * - 单条 `{ format: 'anthropic' }`          — 仅 Anthropic 格式
   * - `{ format: 'openai-chat', baseUrl }`     — OpenAI SDK 直连并指定端点
   * - 双条目                                    — 双格式，用户在 onboarding 时选择；
   *   数组顺序即回落优先级，首位为该 provider 默认格式
   */
  formatEndpoints: FormatEndpoint[]

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
  thinking?: OpenAiThinkingAttr

  /**
   * 是否需要从流式 content 中剥离泄漏的 think/thinking 标签。
   * DashScope/Qwen 模型在 thinking 结束时可能将 `</think>` 标签泄漏到 content 字段。
   */
  stripThinkingTags?: boolean
}

type OpenAiThinkingParamsFactory = (
  effort: string | undefined,
  model?: string,
  context?: ModelCapabilityMatchContext,
) => Record<string, unknown>

type OpenAiThinkingDisable =
  | Record<string, unknown>
  | ((effort: string | undefined, model?: string) => Record<string, unknown>)

export interface OpenAiThinkingAttr {
  /** 启用 thinking 时传给 API 的参数。effort 为映射后的 provider 参数值，model 为模型名 */
  enable: OpenAiThinkingParamsFactory
  /** 显式禁用 thinking 时传给 API 的参数（省略则不传），支持按模型动态生成 */
  disable?: OpenAiThinkingDisable
  /**
   * 同一兼容端点可为不同模型暴露不同的思考参数。转换层按最长 pattern 优先匹配，
   * 避免 provider 配置退化为持续增长的模型名称条件链。
   */
  modelOverrides?: Array<{
    pattern: string
    enable?: OpenAiThinkingParamsFactory
    disable?: OpenAiThinkingDisable
  }>
}

/**
 * 将 provider 默认思考映射与最具体的模型级覆盖合并。
 * pattern 使用大小写不敏感的 substring match，与模型能力配置保持一致。
 */
export function resolveOpenAiThinkingAttr(
  attr: OpenAiThinkingAttr,
  model?: string,
): OpenAiThinkingAttr {
  if (!model || !attr.modelOverrides?.length) {
    return attr
  }
  const normalizedModel = model.toLowerCase()
  const override = attr.modelOverrides
    .filter(({ pattern }) => normalizedModel.includes(pattern.toLowerCase()))
    .sort((a, b) => b.pattern.length - a.pattern.length)[0]
  if (!override) {
    return attr
  }
  return {
    ...attr,
    enable: override.enable ?? attr.enable,
    disable: override.disable ?? attr.disable,
  }
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
    // OpenAI 标准参数 reasoning_effort（如 o1/o3 系列的 low/medium/high）。
    // "on" 是内部 toggle 档，不是合法 API 值——只开启思考、不传 reasoning_effort。
    if (!effort || effort === 'on') {
      return { thinking: { type: 'enabled' } }
    }
    return { thinking: { type: 'enabled' }, reasoning_effort: effort }
  },
  disable: { thinking: { type: 'disabled' } },
}

/**
 * xAI Grok：chat 用 reasoning_effort，常见合法值为 low/medium/high。
 * 勿传 `none`：grok-4.5 等会 400「does not support reasoning_effort value none」
 * （auto-mode 分类器 sideQuery 关 thinking 时踩过）。
 * 关闭思考：省略字段，交给模型默认非推理路径 / API 缺省。
 * 内部 "on" 或缺省按 high 显式下发，行为更可预测。
 */
const XAI_THINKING_ATTR: NonNullable<OpenAiAttr['thinking']> = {
  enable: (effort) => {
    if (!effort || effort === 'on') {
      return { reasoning_effort: 'high' }
    }
    // off/none：省略，与 disable 一致；勿发 reasoning_effort:none
    if (effort === 'off' || effort === 'none') {
      return {}
    }
    const e = effort.toLowerCase()
    if (e === 'low' || e === 'medium' || e === 'high') {
      return { reasoning_effort: e }
    }
    // xhigh / thorough 等未映射：回落 high，避免非法字符串
    if (e === 'xhigh') {
      return { reasoning_effort: 'high' }
    }
    return { reasoning_effort: 'high' }
  },
  // 分类器等关 thinking：不传 reasoning_effort（响应侧 convertThinkingForResponses 同策略）
  disable: {},
}

// ---------------------------------------------------------------------------
// 预设能力集（减少重复）
// ---------------------------------------------------------------------------

/** 完整能力集 — 适用于 Anthropic 官方 API、generic 等。 */
const FULL_CAPABILITIES: ProviderCapability[] = ['context_management']

/** 标准能力集 — 适用于大多数第三方平台和本地推理引擎 */
const STANDARD_CAPABILITIES: ProviderCapability[] = ['context_management']

// ---------------------------------------------------------------------------
// 注册表（按 id 字母序排列）
// ---------------------------------------------------------------------------

export const PROVIDER_REGISTRY: readonly ProviderEntry[] = [
  {
    id: 'anthropic',
    // 官方 SDK 自带默认端点，无需显式 baseUrl
    formatEndpoints: [{ format: 'anthropic' }],
    endpointType: ['default'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'Anthropic API Key',
    suggestedModels: [
      { label: 'claude-opus-5', value: 'claude-opus-5', tier: 'advanced' },
      { label: 'claude-sonnet-5', value: 'claude-sonnet-5', tier: 'standard' },
      { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5', tier: 'compact' },
    ],
  },
  {
    id: 'qianfan',
    formatEndpoints: [
      { format: 'openai-chat', baseUrl: 'https://aistudio.baidu.com/llm/lmapi/v3' },
    ],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'Baidu API Key',
    suggestedModels: [
      { label: 'ernie-5.1', value: 'ernie-5.1', tier: 'advanced' },
      { label: 'deepseek-v4-pro', value: 'deepseek-v4-pro', tier: 'standard' },
      { label: 'ernie-4.5-turbo-128k', value: 'ernie-4.5-turbo-128k', tier: 'compact' },
    ],
  },
  {
    id: 'bedrock',
    formatEndpoints: [
      { format: 'anthropic', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com' },
    ],
    endpointType: ['env', 'default'],
    capabilities: STANDARD_CAPABILITIES,
    baseUrlEnvVar: 'BEDROCK_BASE_URL',
    apiKeyLabel: 'AWS Access Key',
    baseUrlHint: 'https://bedrock-runtime.{region}.amazonaws.com',
    suggestedModels: [
      { label: 'claude-opus-5', value: 'claude-opus-5', tier: 'advanced' },
      { label: 'claude-sonnet-5', value: 'claude-sonnet-5', tier: 'standard' },
      { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5', tier: 'compact' },
    ],
  },
  {
    id: 'dashscope',
    formatEndpoints: [
      {
        format: 'openai-chat',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
      { format: 'anthropic', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic/' },
    ],
    endpointType: ['env', 'default'],
    capabilities: STANDARD_CAPABILITIES,
    baseUrlEnvVar: 'DASHSCOPE_BASE_URL',
    apiKeyLabel: 'DashScope API Key',
    suggestedModels: [
      { label: 'qwen3.8-max', value: 'qwen3.8-max', tier: 'advanced' },
      { label: 'qwen3.7-plus', value: 'qwen3.7-plus', tier: 'standard' },
      { label: 'qwen3.7-flash', value: 'qwen3.7-flash', tier: 'compact' },
    ],
    openaiAttr: {
      stripThinkingTags: true,
    },
  },
  {
    id: 'deepseek',
    formatEndpoints: [{ format: 'openai-chat', baseUrl: 'https://api.deepseek.com' }],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'DeepSeek API Key',
    suggestedModels: [
      { label: 'deepseek-v4-pro', value: 'deepseek-v4-pro', tier: 'advanced' },
      { label: 'deepseek-v4-flash', value: 'deepseek-v4-flash', tier: 'standard' },
    ],
  },
  {
    id: 'fireworks',
    formatEndpoints: [
      { format: 'anthropic', baseUrl: 'https://api.fireworks.ai/inference/v1' },
      { format: 'openai-chat', baseUrl: 'https://api.fireworks.ai/inference/v1' },
    ],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'Fireworks API Key',
    suggestedModels: [
      {
        label: 'accounts/fireworks/models/deepseek-v4-pro',
        value: 'accounts/fireworks/models/deepseek-v4-pro',
        tier: 'advanced',
      },
      {
        label: 'accounts/fireworks/models/gpt-oss-120b',
        value: 'accounts/fireworks/models/gpt-oss-120b',
        tier: 'standard',
      },
      {
        label: 'accounts/fireworks/models/gpt-oss-20b',
        value: 'accounts/fireworks/models/gpt-oss-20b',
        tier: 'compact',
      },
    ],
  },
  {
    id: 'azure',
    formatEndpoints: [
      {
        format: 'anthropic',
        baseUrl: 'https://models.inference.ai.azure.com',
      },
      { format: 'openai-chat', baseUrl: 'https://models.inference.ai.azure.com' },
    ],
    endpointType: ['env', 'default'],
    capabilities: STANDARD_CAPABILITIES,
    baseUrlEnvVar: 'AZURE_BASE_URL',
    apiKeyLabel: 'Microsoft Azure API Key',
    baseUrlHint: 'https://{resource}.services.ai.azure.com/models',
    suggestedModels: [
      { label: 'claude-opus-5', value: 'claude-opus-5', tier: 'advanced' },
      { label: 'claude-sonnet-5', value: 'claude-sonnet-5', tier: 'standard' },
      { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5', tier: 'compact' },
    ],
  },
  {
    id: 'gemini',
    formatEndpoints: [
      {
        format: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      },
      {
        format: 'openai-chat',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      },
    ],
    endpointType: ['env', 'default'],
    capabilities: ['context_management'],
    apiKeyLabel: 'Google AI API Key',
    suggestedModels: [
      { label: 'gemini-3.1-pro-preview', value: 'gemini-3.1-pro-preview', tier: 'advanced' },
      { label: 'gemini-3.7-flash', value: 'gemini-3.7-flash', tier: 'standard' },
      { label: 'gemini-3.5-flash-lite', value: 'gemini-3.5-flash-lite', tier: 'compact' },
    ],
  },
  {
    id: 'generic',
    formatEndpoints: [{ format: 'anthropic' }, { format: 'openai-chat' }],
    endpointType: ['custom'],
    capabilities: FULL_CAPABILITIES,
    apiKeyLabel: 'API Key',
  },
  {
    id: 'groq',
    formatEndpoints: [{ format: 'openai-chat', baseUrl: 'https://api.groq.com/openai/v1' }],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'Groq API Key',
    suggestedModels: [
      {
        label: 'openai/gpt-oss-120b',
        value: 'openai/gpt-oss-120b',
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
    // SuperGrok / X Premium+ 订阅走 OAuth（xai-oauth）；也可在 auth.json 配 API Key
    id: 'xai',
    formatEndpoints: [
      { format: 'openai-responses', baseUrl: 'https://api.x.ai/v1' },
      { format: 'openai-chat', baseUrl: 'https://api.x.ai/v1' },
    ],
    // Grok 订阅路径与 Hermes 一致，默认 Responses API
    modelApiFormats: [{ pattern: 'grok', apiFormat: 'openai-responses' }],
    endpointType: ['env', 'default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    baseUrlEnvVar: 'XAI_BASE_URL',
    apiKeyLabel: 'xAI API Key',
    baseUrlHint: 'https://api.x.ai/v1',
    openaiAttr: {
      thinking: XAI_THINKING_ATTR,
    },
    suggestedModels: [
      { label: 'grok-4.6', value: 'grok-4.6', tier: 'advanced' },
      { label: 'grok-4.3', value: 'grok-4.3', tier: 'standard' },
    ],
  },
  {
    id: 'pangu',
    formatEndpoints: [
      { format: 'openai-chat', baseUrl: 'https://api.modelarts-maas.com/openai/v1' },
    ],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: '华为盘古 API Key',
    suggestedModels: [
      { label: 'DeepSeek-V4-pro', value: 'DeepSeek-V4-pro', tier: 'advanced' },
      { label: 'DeepSeek-V4-flash', value: 'DeepSeek-V4-flash', tier: 'standard' },
    ],
  },
  {
    id: 'kimi',
    formatEndpoints: [
      { format: 'anthropic', baseUrl: 'https://api.moonshot.cn/anthropic' },
      { format: 'openai-chat', baseUrl: 'https://api.moonshot.cn/v1' },
    ],
    endpointType: ['env', 'default'],
    capabilities: STANDARD_CAPABILITIES,
    baseUrlEnvVar: 'KIMI_BASE_URL',
    apiKeyLabel: 'Kimi API Key',
    suggestedModels: [
      { label: 'kimi-k2.7-code', value: 'kimi-k2.7-code', tier: 'advanced' },
      { label: 'kimi-k2.6', value: 'kimi-k2.6', tier: 'standard' },
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
    formatEndpoints: [{ format: 'openai-chat', baseUrl: 'http://localhost:1234/v1' }],
    endpointType: ['custom'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'API Key',
    baseUrlHint: 'http://localhost:1234/v1',
  },
  {
    id: 'llamacpp',
    formatEndpoints: [{ format: 'openai-chat', baseUrl: 'http://localhost:8080/v1' }],
    endpointType: ['custom'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'API Key',
    baseUrlHint: 'http://localhost:8080/v1',
  },
  {
    id: 'minimax',
    formatEndpoints: [
      { format: 'anthropic', baseUrl: 'https://api.minimaxi.com/anthropic' },
      { format: 'openai-chat', baseUrl: 'https://api.minimaxi.com/v1' },
    ],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'MiniMax API Key',
    suggestedModels: [
      { label: 'MiniMax-M2.7', value: 'MiniMax-M2.7', tier: 'advanced' },
      { label: 'MiniMax-M2.5', value: 'MiniMax-M2.5', tier: 'standard' },
      { label: 'MiniMax-M2.1', value: 'MiniMax-M2.1', tier: 'compact' },
    ],
  },
  {
    id: 'mimo',
    formatEndpoints: [
      { format: 'anthropic', baseUrl: 'https://api.xiaomimimo.com/anthropic' },
      { format: 'openai-chat', baseUrl: 'https://api.xiaomimimo.com/v1' },
    ],
    endpointType: ['env', 'default'],
    capabilities: STANDARD_CAPABILITIES,
    baseUrlEnvVar: 'MIMO_BASE_URL',
    apiKeyLabel: 'MiMo API Key',
    suggestedModels: [
      { label: 'mimo-v2.5-pro', value: 'mimo-v2.5-pro', tier: 'advanced' },
      { label: 'mimo-v2.5', value: 'mimo-v2.5', tier: 'standard' },
    ],
  },
  {
    id: 'nim',
    formatEndpoints: [{ format: 'openai-chat', baseUrl: 'https://integrate.api.nvidia.com/v1' }],
    endpointType: ['custom'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'NVIDIA API Key',
    baseUrlHint: 'https://integrate.api.nvidia.com/v1',
    openaiAttr: {
      thinking: {
        ...DEFAULT_OPENAI_THINKING_ATTR,
        modelOverrides: [
          {
            pattern: 'nemotron-3-ultra',
            // Ultra 仅接受 none / medium / high；未指定时沿用端点默认的 high。
            enable: (effort) => ({ reasoning_effort: effort === 'medium' ? 'medium' : 'high' }),
            disable: { reasoning_effort: 'none' },
          },
          {
            pattern: 'gpt-oss-120b',
            enable: (effort) => {
              // gpt-oss 仅接受 low / medium / high，且不提供关闭档位。
              const normalizedEffort = effort?.toLowerCase()
              return {
                reasoning_effort:
                  normalizedEffort === 'low' ||
                  normalizedEffort === 'medium' ||
                  normalizedEffort === 'high'
                    ? normalizedEffort
                    : 'medium',
              }
            },
            disable: {},
          },
          {
            pattern: 'inkling',
            // 端点未公开 effort/关闭参数，省略字段以保留模型默认行为。
            enable: () => ({}),
            disable: {},
          },
        ],
      },
    },
    suggestedModels: [
      {
        label: 'nvidia/nemotron-3-ultra-550b-a55b',
        value: 'nvidia/nemotron-3-ultra-550b-a55b',
        tier: 'advanced',
      },
      { label: 'openai/gpt-oss-120b', value: 'openai/gpt-oss-120b', tier: 'standard' },
      {
        label: 'nvidia/nemotron-3-nano-30b-a3b',
        value: 'nvidia/nemotron-3-nano-30b-a3b',
        tier: 'compact',
      },
    ],
  },
  {
    id: 'ollama',
    formatEndpoints: [{ format: 'openai-chat', baseUrl: 'http://localhost:11434/v1' }],
    endpointType: ['custom'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'API Key',
    baseUrlHint: 'http://localhost:11434/v1',
    suggestedModels: [
      { label: 'qwen3-coder-next', value: 'qwen3-coder-next', tier: 'advanced' },
      { label: 'gpt-oss:20b', value: 'gpt-oss:20b', tier: 'standard' },
      { label: 'qwen3.5', value: 'qwen3.5', tier: 'compact' },
    ],
  },
  {
    id: 'openai',
    // OpenAI 官方 SDK 自带默认端点，无需显式 baseUrl
    formatEndpoints: [{ format: 'openai-chat' }, { format: 'openai-responses' }],
    // gpt-5 系列默认走 Responses API（新模型已不再支持 chat/completions 的
    // 推理参数；gpt-4o 等旧模型仍走 chat）。想强制 chat 需在
    // model-capabilities.json 声明模型级 apiFormat（优先级高于此处）。
    modelApiFormats: [{ pattern: 'gpt-5', apiFormat: 'openai-responses' }],
    endpointType: ['default'],
    capabilities: ['context_management'],
    apiKeyLabel: 'OpenAI API Key',
    suggestedModels: [
      { label: 'gpt-5.6-sol', value: 'gpt-5.6-sol', tier: 'advanced' },
      { label: 'gpt-5.6-terra', value: 'gpt-5.6-terra', tier: 'standard' },
      { label: 'gpt-5.6-luna', value: 'gpt-5.6-luna', tier: 'compact' },
    ],
  },
  {
    id: 'opencode-go',
    formatEndpoints: [
      { format: 'openai-chat', baseUrl: 'https://opencode.ai/zen/go/v1' },
      { format: 'anthropic', baseUrl: 'https://opencode.ai/zen/go' },
    ],
    modelApiFormats: [
      { pattern: 'glm-5.2', apiFormat: 'openai-chat' },
      { pattern: 'glm-5.1', apiFormat: 'openai-chat' },
      { pattern: 'kimi-k2.7-code', apiFormat: 'openai-chat' },
      { pattern: 'kimi-k2.6', apiFormat: 'openai-chat' },
      { pattern: 'deepseek-v4-pro', apiFormat: 'openai-chat' },
      { pattern: 'deepseek-v4-flash', apiFormat: 'openai-chat' },
      { pattern: 'mimo-v2.5-pro', apiFormat: 'openai-chat' },
      { pattern: 'mimo-v2.5', apiFormat: 'openai-chat' },
      { pattern: 'minimax-m3', apiFormat: 'anthropic' },
      { pattern: 'minimax-m2.7', apiFormat: 'anthropic' },
      { pattern: 'minimax-m2.5', apiFormat: 'anthropic' },
      { pattern: 'qwen3.7-max', apiFormat: 'anthropic' },
      { pattern: 'qwen3.7-plus', apiFormat: 'anthropic' },
      { pattern: 'qwen3.6-plus', apiFormat: 'anthropic' },
    ],
    endpointType: ['default'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'OpenCode Go API Key',
    suggestedModels: [
      { label: 'Qwen3.7 Max', value: 'qwen3.7-max', tier: 'advanced' },
      { label: 'GLM-5.2', value: 'glm-5.2', tier: 'standard' },
      { label: 'DeepSeek V4 Flash', value: 'deepseek-v4-flash', tier: 'compact' },
    ],
  },
  {
    id: 'openrouter',
    formatEndpoints: [
      { format: 'anthropic', baseUrl: 'https://openrouter.ai/api' },
      { format: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1' },
      // Responses 与 chat 共用端点
      { format: 'openai-responses', baseUrl: 'https://openrouter.ai/api/v1' },
    ],
    endpointType: ['default'],
    capabilities: ['context_management'],
    // OpenRouter reasoning.effort 支持 low/medium/high（映射由 mapEffortToProvider 处理）。
    apiKeyLabel: 'OpenRouter API Key',
    suggestedModels: [
      { label: 'anthropic/claude-opus-5', value: 'anthropic/claude-opus-5', tier: 'advanced' },
      {
        label: 'anthropic/claude-sonnet-5',
        value: 'anthropic/claude-sonnet-5',
        tier: 'standard',
      },
      {
        label: 'anthropic/claude-haiku-4.5',
        value: 'anthropic/claude-haiku-4.5',
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
    formatEndpoints: [{ format: 'openai-chat', baseUrl: 'https://api.perplexity.ai' }],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'Perplexity API Key',
    suggestedModels: [
      { label: 'sonar-reasoning-pro', value: 'sonar-reasoning-pro', tier: 'advanced' },
      { label: 'sonar-pro', value: 'sonar-pro', tier: 'standard' },
      { label: 'sonar', value: 'sonar', tier: 'compact' },
    ],
  },
  {
    id: 'siliconflow',
    formatEndpoints: [
      { format: 'anthropic', baseUrl: 'https://api.siliconflow.cn/' },
      { format: 'openai-chat', baseUrl: 'https://api.siliconflow.cn/v1' },
    ],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'SiliconFlow API Key',
    suggestedModels: [
      {
        label: 'deepseek-ai/DeepSeek-V4-Pro',
        value: 'deepseek-ai/DeepSeek-V4-Pro',
        tier: 'advanced',
      },
      {
        label: 'Pro/moonshotai/Kimi-K2.6',
        value: 'Pro/moonshotai/Kimi-K2.6',
        tier: 'standard',
      },
      {
        label: 'deepseek-ai/DeepSeek-V4-Flash',
        value: 'deepseek-ai/DeepSeek-V4-Flash',
        tier: 'compact',
      },
    ],
  },
  {
    id: 'tencent',
    formatEndpoints: [
      { format: 'anthropic', baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/anthropic' },
      { format: 'openai-chat', baseUrl: 'https://api.lkeap.cloud.tencent.com/v1' },
    ],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'Tencent Cloud API Key',
    suggestedModels: [
      { label: 'deepseek-v3.2', value: 'deepseek-v3.2', tier: 'advanced' },
      { label: 'deepseek-r1-0528', value: 'deepseek-r1-0528', tier: 'standard' },
      { label: 'hunyuan-turbos', value: 'hunyuan-turbos', tier: 'compact' },
    ],
  },
  {
    id: 'together',
    formatEndpoints: [{ format: 'openai-chat', baseUrl: 'https://api.together.xyz/v1' }],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'Together AI API Key',
    suggestedModels: [
      {
        label: 'deepseek-ai/DeepSeek-V4-Pro',
        value: 'deepseek-ai/DeepSeek-V4-Pro',
        tier: 'advanced',
      },
      {
        label: 'MiniMaxAI/MiniMax-M2.7',
        value: 'MiniMaxAI/MiniMax-M2.7',
        tier: 'standard',
      },
      { label: 'openai/gpt-oss-20b', value: 'openai/gpt-oss-20b', tier: 'compact' },
    ],
  },
  {
    id: 'vertex',
    formatEndpoints: [
      {
        format: 'anthropic',
        baseUrl: 'https://us-central1-aiplatform.googleapis.com/v1',
      },
    ],
    endpointType: ['env', 'default'],
    capabilities: STANDARD_CAPABILITIES,
    baseUrlEnvVar: 'VERTEX_BASE_URL',
    apiKeyLabel: 'GCP API Key',
    baseUrlHint: 'https://{region}-aiplatform.googleapis.com/v1',
    suggestedModels: [
      { label: 'claude-opus-5', value: 'claude-opus-5', tier: 'advanced' },
      { label: 'claude-sonnet-5', value: 'claude-sonnet-5', tier: 'standard' },
      { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5', tier: 'compact' },
    ],
  },
  {
    id: 'ark',
    // 方舟同时提供 Responses、Chat Completions 与 Anthropic 兼容端点；优先使用
    // Responses 以保留原生 Agent / 工具调用能力，其他协议仅作为兼容回退。
    formatEndpoints: [
      // Responses 与 chat 共用端点（/api/v3）
      { format: 'openai-responses', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
      { format: 'openai-chat', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
      { format: 'anthropic', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding' },
    ],
    endpointType: ['default', 'custom'],
    capabilities: STANDARD_CAPABILITIES,
    apiKeyLabel: 'ARK API Key',
    suggestedModels: [
      { label: 'doubao-seed-evolving', value: 'doubao-seed-evolving', tier: 'advanced' },
      { label: 'doubao-seed-code', value: 'doubao-seed-code', tier: 'standard' },
      { label: 'deepseek-v3.2', value: 'deepseek-v3.2', tier: 'compact' },
    ],
  },
  {
    id: 'zhipu',
    formatEndpoints: [
      { format: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
      { format: 'openai-chat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/' },
    ],
    endpointType: ['env', 'default'],
    capabilities: STANDARD_CAPABILITIES,
    baseUrlEnvVar: 'ZHIPU_BASE_URL',
    apiKeyLabel: 'ZHIPU API Key',
    suggestedModels: [
      { label: 'glm-5.2', value: 'glm-5.2', tier: 'advanced' },
      { label: 'glm-5-turbo', value: 'glm-5-turbo', tier: 'standard' },
      { label: 'glm-4.5-flash', value: 'glm-4.5-flash', tier: 'compact' },
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

/**
 * 获取 provider 支持的 API 消息格式列表。
 * 数组顺序与 formatEndpoints 一致，首位即默认格式。
 */
export function getSupportedFormats(entry: ProviderEntry): ApiFormat[] {
  return entry.formatEndpoints.map(({ format }) => format)
}

/** 获取 provider 某一格式的内置默认端点；该格式未配置端点时返回 undefined */
export function getDefaultBaseUrl(entry: ProviderEntry, format: ApiFormat): string | undefined {
  return entry.formatEndpoints.find((endpoint) => endpoint.format === format)?.baseUrl
}

/**
 * 按格式取 provider 的内置默认端点。
 *
 * 统一回落规则（此前散落在 client.ts 三处、各不相同）：
 * 目标格式端点 → openai-chat → openai-responses → 首位声明的格式。
 * Responses 与 chat 在多数平台共用端点且常只配其一，故互为回落；
 * 最后落到 formatEndpoints 首位，保证「声明了默认格式就一定有端点可用」
 * （无显式 baseUrl 的格式如 anthropic 官方端点由 SDK 决定，返回 undefined）。
 */
export function getDefaultBaseUrlForFormat(
  entry: ProviderEntry,
  targetFormat: ApiFormat,
): string | undefined {
  return (
    getDefaultBaseUrl(entry, targetFormat) ??
    getDefaultBaseUrl(entry, 'openai-chat') ??
    getDefaultBaseUrl(entry, 'openai-responses') ??
    getDefaultBaseUrl(entry, entry.formatEndpoints[0].format)
  )
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
