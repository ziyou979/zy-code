/**
 * 集中式 Provider 注册表。
 *
 * 新增平台只需在下方 PROVIDER_REGISTRY 中添加一条记录即可。
 * 其他模块（providers.ts、config.ts、client.ts、Onboarding.tsx）
 * 均从此注册表自动派生行为，无需额外修改。
 */

import type { EffortLevel } from '../../utils/effort.js'
import type { ProviderCapability } from './providers.js'

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
 */
export type ApiFormat = 'anthropic' | 'openai'

/**
 * Provider 在运行时如何解析 base URL：
 * - `'hardcoded'`      — base URL 硬编码在 client.ts 中（anthropic、bedrock、vertex、foundry）
 * - `'env-or-default'` — 优先读环境变量，否则使用 defaultBaseUrls（dashscope、zhipu、kimi）
 * - `'preconfigured'`  — onboarding 时保存到 configuredBaseUrl
 * - `'custom'`         — 用户手动提供 base URL（本地推理引擎、generic）
 */
export type EndpointType = 'hardcoded' | 'env-or-default' | 'preconfigured' | 'custom'

export interface ProviderEntry {
  /** 唯一标识符 — 会成为 APIProvider 联合类型的成员 */
  id: string

  /**
   * 该 provider 支持的 API 消息格式列表。
   * - `['anthropic']`        — 仅 Anthropic 格式
   * - `['openai']`           — 使用 OpenAI SDK 直连
   * - `['anthropic', 'openai']` — 双格式，用户在 onboarding 时选择
   */
  supportedFormats: ApiFormat[]

  /** 运行时 base URL 的解析方式 */
  endpointType: EndpointType

  /** Provider 级别的能力声明 */
  capabilities: ProviderCapability[]

  /**
   * 该 provider 默认支持的 effort(思考强度)档位列表 —— 对所有用户可见。
   * 省略或为空数组表示该 provider 不支持设置思考强度。
   * 模型级覆盖见 model-capabilities.json 的 effortLevels 字段(优先级更高)。
   */
  defaultEffortLevels?: EffortLevel[]

  /**
   * internal build 下的扩展 effort 档位列表(如解锁 'max')。
   * 省略时 internal build 也使用 defaultEffortLevels。
   */
  internalEffortLevels?: EffortLevel[]

  /**
   * 默认 base URL。
   * - env-or-default 类型：环境变量未设置时使用
   * - preconfigured 类型：onboarding 时保存到 configuredBaseUrl
   * - 双格式 provider：按 'openai' 和 'anthropic' 分别配置
   */
  defaultBaseUrls?: {
    openai?: string
    anthropic?: string
  }

  /** 覆盖 base URL 的环境变量名（仅 env-or-default 类型，如 DASHSCOPE_BASE_URL） */
  baseUrlEnvVar?: string

  /** 激活该 provider 的环境变量名（如 ZY_CODE_USE_DASHSCOPE） */
  activationEnvVar?: string

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
}

// ---------------------------------------------------------------------------
// 预设能力集（减少重复）
// ---------------------------------------------------------------------------

/** 完整能力集 — 适用于 Anthropic 官方 API、generic 等。effort 档位见 defaultEffortLevels。 */
const FULL_CAPABILITIES: ProviderCapability[] = [
  'thinking',
  'adaptive_thinking',
  'structured_outputs',
  'context_management',
  'prompt_caching',
  'interleaved_thinking',
]

/** Anthropic 系 effort 档位（兼容旧代码引用）。新体系下由 mapEffortToProvider 处理映射。 */
const ANTHROPIC_EFFORT_LEVELS: EffortLevel[] = ['light', 'balanced', 'thorough', 'extreme']

/** 标准能力集 — 适用于大多数第三方平台和本地推理引擎 */
const STANDARD_CAPABILITIES: ProviderCapability[] = [
  'thinking',
  'adaptive_thinking',
  'structured_outputs',
  'context_management',
  'prompt_caching',
  'interleaved_thinking',
]

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

export const PROVIDER_REGISTRY: readonly ProviderEntry[] = [
  // ── 云端 AI 平台（有预设 base URL） ──────────────────────────────────────
  {
    id: 'dashscope',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: 'env-or-default',
    capabilities: STANDARD_CAPABILITIES,
    defaultEffortLevels: ['light', 'balanced', 'thorough'],
    defaultBaseUrls: {
      openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic/',
    },
    baseUrlEnvVar: 'DASHSCOPE_BASE_URL',
    activationEnvVar: 'ZY_CODE_USE_DASHSCOPE',
    apiKeyLabel: 'DashScope API Key',
    suggestedModels: [
      { label: 'qwen3.6-plus', value: 'qwen3.6-plus', tags: ['recommended', 'balanced'] },
      { label: 'qwen3.5-plus', value: 'qwen3.5-plus', tags: ['reasoning'] },
      { label: 'qwen3.5-flash', value: 'qwen3.5-flash', tags: ['fast', 'lightweight'] },
    ],
  },
  {
    id: 'deepseek',
    supportedFormats: ['openai'],
    endpointType: 'preconfigured',
    capabilities: STANDARD_CAPABILITIES,
    // DeepSeek reasoning_effort 支持 low/medium/high（映射由 mapEffortToProvider 处理）。
    defaultEffortLevels: ['light', 'balanced', 'thorough'],
    defaultBaseUrls: { openai: 'https://api.deepseek.com' },
    apiKeyLabel: 'DeepSeek API Key',
    suggestedModels: [
      { label: 'deepseek-chat', value: 'deepseek-chat', tags: ['recommended', 'balanced'] },
      { label: 'deepseek-reasoner', value: 'deepseek-reasoner', tags: ['reasoning'] },
    ],
  },
  {
    id: 'openai',
    supportedFormats: ['openai'],
    endpointType: 'hardcoded',
    capabilities: ['thinking', 'structured_outputs', 'context_management'],
    // OpenAI reasoning_effort 支持 minimal/low/medium/high（映射由 mapEffortToProvider 处理）。
    defaultEffortLevels: ['quick', 'light', 'balanced', 'thorough'],
    activationEnvVar: 'ZY_CODE_USE_OPENAI',
    apiKeyLabel: 'OpenAI API Key',
    suggestedModels: [
      { label: 'gpt-4o', value: 'gpt-4o', tags: ['recommended', 'balanced'] },
      { label: 'gpt-4o-mini', value: 'gpt-4o-mini', tags: ['fast', 'lightweight'] },
    ],
  },
  {
    id: 'zhipu',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: 'env-or-default',
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: {
      openai: 'https://open.bigmodel.cn/api/paas/v4/',
      anthropic: 'https://open.bigmodel.cn/api/anthropic',
    },
    baseUrlEnvVar: 'ZHIPU_BASE_URL',
    activationEnvVar: 'ZY_CODE_USE_ZHIPU',
    apiKeyLabel: 'ZHIPU API Key',
    suggestedModels: [
      { label: 'glm-4-plus', value: 'glm-4-plus', tags: ['recommended', 'balanced'] },
      { label: 'glm-4-flash', value: 'glm-4-flash', tags: ['fast'] },
    ],
  },
  {
    id: 'kimi',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: 'env-or-default',
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: {
      openai: 'https://api.moonshot.cn/v1',
      anthropic: 'https://api.moonshot.cn/anthropic',
    },
    baseUrlEnvVar: 'KIMI_BASE_URL',
    activationEnvVar: 'ZY_CODE_USE_KIMI',
    apiKeyLabel: 'Kimi API Key',
    suggestedModels: [
      { label: 'moonshot-v1', value: 'moonshot-v1', tags: ['recommended'] },
      { label: 'moonshot-v1-8k', value: 'moonshot-v1-8k', tags: ['lightweight'] },
    ],
  },
  {
    id: 'siliconflow',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: 'preconfigured',
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
    id: 'volcark',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: 'preconfigured',
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
    id: 'tencentlke',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: 'preconfigured',
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
    id: 'minimax',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: 'preconfigured',
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
    id: 'baiduqianfan',
    supportedFormats: ['openai'],
    endpointType: 'preconfigured',
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
    id: 'huaweicloud',
    supportedFormats: ['openai'],
    endpointType: 'preconfigured',
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { openai: 'https://api.modelarts-maas.com/openai/v1' },
    apiKeyLabel: 'Huawei Cloud API Key',
    suggestedModels: [
      { label: 'DeepSeek-V4-pro', value: 'DeepSeek-V4-pro', tags: ['recommended', 'balanced'] },
      { label: 'DeepSeek-R1', value: 'DeepSeek-R1', tags: ['reasoning'] },
    ],
  },
  {
    id: 'openrouter',
    supportedFormats: ['anthropic'],
    endpointType: 'hardcoded',
    capabilities: [
      'thinking',
      'adaptive_thinking',
      'structured_outputs',
      'context_management',
      'interleaved_thinking',
    ],
    // OpenRouter reasoning.effort 支持 low/medium/high（映射由 mapEffortToProvider 处理）。
    defaultEffortLevels: ['light', 'balanced', 'thorough'],
    activationEnvVar: 'ZY_CODE_USE_OPENROUTER',
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
  },
  {
    id: 'together',
    supportedFormats: ['openai'],
    endpointType: 'preconfigured',
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
    id: 'groq',
    supportedFormats: ['openai'],
    endpointType: 'preconfigured',
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
    id: 'fireworks',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: 'preconfigured',
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
    id: 'perplexity',
    supportedFormats: ['openai'],
    endpointType: 'preconfigured',
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { openai: 'https://api.perplexity.ai' },
    apiKeyLabel: 'Perplexity API Key',
    suggestedModels: [
      { label: 'sonar-pro', value: 'sonar-pro', tags: ['recommended', 'flagship'] },
      { label: 'sonar', value: 'sonar', tags: ['fast', 'budget'] },
      { label: 'sonar-reasoning-pro', value: 'sonar-reasoning-pro', tags: ['reasoning'] },
    ],
  },

  // ── 本地推理引擎 ─────────────────────────────────────────────────────────
  {
    id: 'ollama',
    supportedFormats: ['openai'],
    endpointType: 'custom',
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
    id: 'lmstudio',
    supportedFormats: ['openai'],
    endpointType: 'custom',
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { openai: 'http://localhost:1234/v1' },
    apiKeyLabel: 'API Key',
    baseUrlHint: 'http://localhost:1234/v1',
  },
  {
    id: 'llamacpp',
    supportedFormats: ['openai'],
    endpointType: 'custom',
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { openai: 'http://localhost:8080/v1' },
    apiKeyLabel: 'API Key',
    baseUrlHint: 'http://localhost:8080/v1',
  },
  {
    id: 'nvidia-nim',
    supportedFormats: ['openai'],
    endpointType: 'custom',
    capabilities: STANDARD_CAPABILITIES,
    defaultBaseUrls: { openai: 'https://integrate.api.nvidia.com/v1' },
    apiKeyLabel: 'NVIDIA API Key',
    baseUrlHint: 'https://integrate.api.nvidia.com/v1',
  },

  {
    id: 'gemini',
    supportedFormats: ['openai'],
    endpointType: 'env-or-default',
    capabilities: ['thinking', 'adaptive_thinking', 'structured_outputs', 'context_management'],
    // Gemini reasoning_effort 支持 minimal/low/medium/high（映射由 mapEffortToProvider 处理）。
    defaultEffortLevels: ['quick', 'light', 'balanced', 'thorough'],
    activationEnvVar: 'ZY_CODE_USE_GEMINI',
    apiKeyLabel: 'Google AI API Key',
    defaultBaseUrls: {
      openai: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    },
    suggestedModels: [
      { label: 'gemini-2.5-flash', value: 'gemini-2.5-flash', tags: ['recommended', 'fast'] },
      { label: 'gemini-2.5-pro', value: 'gemini-2.5-pro', tags: ['reasoning', 'flagship'] },
      { label: 'gemini-3-flash', value: 'gemini-3-flash', tags: ['fast', 'balanced'] },
    ],
  },

  // ── 其他 provider ────────────────────────────────────────────────────────
  {
    id: 'anthropic',
    supportedFormats: ['anthropic'],
    endpointType: 'hardcoded',
    capabilities: FULL_CAPABILITIES,
    defaultEffortLevels: ANTHROPIC_EFFORT_LEVELS,
    apiKeyLabel: 'Anthropic API Key',
  },
  {
    id: 'generic',
    supportedFormats: ['anthropic', 'openai'],
    endpointType: 'custom',
    capabilities: FULL_CAPABILITIES,
    defaultEffortLevels: ANTHROPIC_EFFORT_LEVELS,
    activationEnvVar: 'ZY_CODE_USE_GENERIC',
    apiKeyLabel: 'API Key',
  },

  // ── 基础设施 provider（不在 onboarding 中显示） ──────────────────────────
  {
    id: 'bedrock',
    supportedFormats: ['anthropic'],
    endpointType: 'hardcoded',
    capabilities: ['prompt_caching'],
    showInOnboarding: false,
  },
  {
    id: 'vertex',
    supportedFormats: ['anthropic'],
    endpointType: 'hardcoded',
    capabilities: ['prompt_caching'],
    showInOnboarding: false,
  },
  {
    id: 'foundry',
    supportedFormats: ['anthropic'],
    endpointType: 'hardcoded',
    capabilities: ['thinking', 'structured_outputs', 'context_management', 'interleaved_thinking'],
    showInOnboarding: false,
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
