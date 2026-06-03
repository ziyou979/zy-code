# Provider 与模型能力配置改进方案

> 参考项目：[pi](https://github.com/earendil-works/pi-mono) (`packages/ai`)
>
> 本文档整理 pi 在 Provider 架构和模型能力配置上值得 zy-code 借鉴的设计，按优先级排列。

---

## 1. API 协议与 Provider 解耦

### 现状

zy-code 只有 `AnthropicProviderAdapter` 和 `OpenAIProviderAdapter` 两个 adapter，所有 provider 必须走这两条路径之一。同一个 `OpenAIProviderAdapter` 要处理 dashscope、deepseek、ollama 等行为差异巨大的平台，差异通过散落的 `if/else` 处理。

### pi 的做法

pi 将 `Api`（协议）和 `Provider`（厂商）分为独立维度。一个模型同时携带 `api: "openai-completions"` 和 `provider: "deepseek"`——流处理逻辑按 `api` 分发，鉴权/计费/UI 按 `provider` 分发。

已有的 `Api` 类型：

- `openai-completions` — 服务于 deepseek、groq、together、nvidia、xai 等 20+ provider
- `openai-responses` — OpenAI Responses API
- `anthropic-messages` — Anthropic / OpenRouter / Fireworks 等
- `bedrock-converse-stream` — AWS Bedrock 原生协议
- `google-generative-ai` / `google-vertex` — Google 原生协议
- `mistral-conversations` — Mistral 原生协议

新增 provider 不需要新 adapter——只要协议是已有 `Api` 之一，只需注册模型即可。

### 改进方向

引入 `Api` 层，将当前两个 adapter 拆分为按协议组织的流处理实现。provider 退化为模型元数据的一部分，不再承担协议分发职责。

---

## 2. 声明式 compat 兼容层

### 现状

各 provider 的 OpenAI-compatible API 差异（如 dashscope 只接受 `enable_thinking` 开关而不接受 `reasoning_effort` 参数）通过 adapter 内部的条件分支处理，新增 provider 时需要修改 adapter 逻辑。

### pi 的做法

pi 定义了 `OpenAICompletionsCompat` 接口（15+ 字段），每个模型在生成时携带自己的 `compat` 覆盖，运行时与 URL-based auto-detection 合并：

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?: "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen" | ...;
  supportsStrictMode?: boolean;
  cacheControlFormat?: "anthropic";
  sendSessionAffinityHeaders?: boolean;
  supportsLongCacheRetention?: boolean;
  // ...
}
```

Anthropic 侧同理有 `AnthropicMessagesCompat`（`supportsEagerToolInputStreaming`、`supportsTemperature`、`forceAdaptiveThinking` 等）。

协议实现代码通过读取 `compat` 字段决定行为，而非判断 provider 名称。新增 provider 只需声明其 compat 配置。

### 改进方向

将 OpenAI adapter 中散落的 provider 差异判断提取为声明式 compat 配置，挂载在模型或 provider 注册表上。adapter 逻辑只读 compat 字段，不依赖 provider 名称。

---

## 3. 模型作为自描述值对象

### 现状

zy-code 的模型是裸字符串 `ModelName = string`。运行时需要调用 `getAPIProvider()`、`getMainLoopModel()`、`modelHasCapability()`、`getLocalModelCapability()`、`getStaticPricingForModel()` 等多个函数拼凑信息，依赖全局状态（settings、环境变量、缓存文件）。

### pi 的做法

pi 的 `Model<TApi>` 是完整的自描述值对象：

```typescript
interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: OpenAICompletionsCompat | AnthropicMessagesCompat;
}
```

调用方拿到一个 `Model` 对象就能直接发起 stream 请求，不需要再查询 provider registry、settings 或环境变量。

### 改进方向

定义结构化的 `ResolvedModel` 类型，在模型选择时一次性解析所有信息（provider、base URL、能力、费用、compat），后续流程只传递该对象。

---

## 4. 模型级 thinkingLevelMap

### 现状

zy-code 的 effort 映射是 provider 级别的 `PROVIDER_EFFORT_MAP`（anthropic、openai、deepseek 各一个映射表），无法区分同一 provider 下不同模型的 effort 支持差异。`model-capabilities.json` 的 `effortLevels` 只声明"支持哪些档位"，不声明"映射到什么 API 值"。

### pi 的做法

每个模型携带 `thinkingLevelMap`，精确声明该模型支持哪些 thinking level 以及映射到什么 API 参数值：

```typescript
// 示例：Claude Opus 4.7
thinkingLevelMap: { xhigh: "xhigh" }

// 示例：Together DeepSeek-V4-Pro
thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null }

// 示例：OpenAI gpt-5.5-pro
thinkingLevelMap: { off: null, minimal: null, low: null }
```

- 缺失的 key 使用 provider 默认行为
- `null` 表示该级别不可用
- 字符串值表示实际传给 API 的参数

`getSupportedThinkingLevels()` 和 `clampThinkingLevel()` 直接从这个 map 派生。

### 改进方向

扩展 `model-capabilities.json` 的 `effortLevels`，从简单的档位列表升级为 `effortMap`，同时声明档位和对应的 API 参数值。或在 `ResolvedModel` 上计算挂载。

---

## 5. 统一的跨 provider 消息转换层

### 现状

zy-code 的消息转换分散在 `conversions/anthropic.ts`（500 行）和 `conversions/openai.ts`（936 行）中，每种格式各自处理格式差异。

### pi 的做法

pi 有统一的 `transformMessages()` 预处理层，在发送给任何 provider 之前处理跨 provider 兼容问题：

- **跨模型 thinking block 兼容**：不同模型的回复重放时，thinking signature 只对同模型有效，跨模型自动降级为 text block
- **redacted thinking 处理**：加密思维链只在同模型重放时保留，跨模型时丢弃
- **orphaned tool call 合成**：对话中断后自动插入合成 tool result，避免 API 格式错误
- **image downgrade**：模型不支持图片时自动替换为 placeholder 文本
- **tool call ID 规范化**：OpenAI 生成 450+ 字符的 ID，Anthropic 要求 `^[a-zA-Z0-9_-]+$` 且最长 64 字符，统一预处理
- **error/aborted 消息过滤**：自动跳过不完整的 assistant 消息，避免 API 错误

这一层与具体协议无关，所有 provider 共享。

### 改进方向

提取一个 provider 无关的消息预处理层，在 `conversions/` 之前统一执行。将当前两个 conversion 文件中重复的兼容逻辑上移。

---

## 6. 类型安全的 API 关联

### 现状

zy-code 的 `LLMAdapter` 接口是 provider 无关的，`CreateParams` 是通用的，类型层面无法区分 Anthropic 参数和 OpenAI 参数。

### pi 的做法

通过 TypeScript 泛型实现 `Model<TApi>` 与 `compat`、`StreamFunction` 的编译时绑定：

```typescript
// compat 类型随 api 自动确定
compat?: TApi extends "openai-completions" ? OpenAICompletionsCompat
        : TApi extends "anthropic-messages" ? AnthropicMessagesCompat
        : never;

// stream 函数签名与 api/options 类型绑定
type StreamFunction<TApi, TOptions> = (
  model: Model<TApi>,
  context: Context,
  options?: TOptions,
) => AssistantMessageEventStream;
```

错误的 api/model/options 组合在编译时就会报错。

### 改进方向

为不同协议的请求参数和响应定义独立类型，通过泛型约束避免运行时的 adapter 类型混淆。

---

## 7. Faux Provider（可编程测试基础设施）

### 现状

zy-code 没有可编程的 mock provider，测试要么依赖真实 API 调用，要么需要外部 mock 框架。

### pi 的做法

pi 的 `FauxProvider` 可以：

- 注册到标准 api-registry，走正常的 stream 分发路径
- 编排预设响应序列（text、thinking、tool call 任意组合）
- 按 token 模拟流式输出延迟
- 队列耗尽时自动报错

整个 coding-agent 测试套件无需真实 API 调用、无需 API key、无需网络。

### 改进方向

实现一个可注册到标准 adapter 路径的 mock provider，支持预设响应队列和流式模拟，用于单元测试和集成测试。

---

## 8. 模型元数据自动生成

### 现状

zy-code 的模型信息来自 `configs.ts` 手动注册或 `model-capabilities.json` 用户配置，新模型/价格变更需要手动更新。

### pi 的做法

pi 的 `generate-models.ts` 脚本从上游 API 自动拉取模型列表和元数据：

- [models.dev](https://models.dev) API — 通用模型目录
- NVIDIA NIM API — NVIDIA 模型列表
- Vercel AI Gateway API — 网关支持的模型

拉取后应用本地规则（compat 覆盖、thinkingLevelMap、cost 修正），生成 `models.generated.ts`（964 个模型）。上游价格变更只需重新运行脚本。

### 改进方向

编写脚本从 dashscope、deepseek 等平台的公开 API 或文档自动拉取模型元数据，减少手动维护成本。

---

## 优先级建议

| 优先级 | 改进项 | 收益 | 复杂度 |
|--------|--------|------|--------|
| P0 | 声明式 compat 兼容层 | 消除 adapter 中散落的 provider 条件分支，新增 provider 更简单 | 中 |
| P0 | 模型作为自描述值对象 | 消除全局状态依赖，简化调用链 | 中 |
| P1 | API 协议与 Provider 解耦 | 架构层面改进，支持原生 Google/Bedrock 等协议 | 高 |
| P1 | 模型级 thinkingLevelMap | 精确控制每个模型的 effort 行为 | 低 |
| P1 | 统一消息转换层 | 减少 conversions 重复逻辑，提升跨模型切换稳定性 | 中 |
| P2 | 类型安全的 API 关联 | 编译时捕获 api/model/options 类型错误 | 中 |
| P2 | Faux Provider | 测试无需真实 API，加速 CI | 低 |
| P2 | 模型元数据自动生成 | 减少手动维护，自动跟踪上游变更 | 低 |
