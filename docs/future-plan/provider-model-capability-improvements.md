# Provider 与模型能力配置改进方案

> 参考项目：[pi](https://github.com/earendil-works/pi-mono) (`packages/ai`)
> 最后更新：2026-06-06
>
> 本文档整理 Provider 架构改进方向，标注已完成项，对未完成项给出可执行方案。

---

## 已完成的改进

### ~~2. 声明式 compat 兼容层~~ ✅

2026-06 完成。在 `providerRegistry.ts` 中新增 `OpenAICompat` 接口和 `effortMapping` 字段。

**当前 `OpenAICompat` 接口**（`src/services/model/providerRegistry.ts`）：

```typescript
interface OpenAICompat {
  thinking?: {
    enable: (effort: string | undefined, model?: string) => Record<string, unknown>
    disable?: Record<string, unknown>
    supportsPreserveThinking?: boolean
  }
  supportsReasoningContent?: boolean
  stripThinkingTags?: boolean
}
```

**声明式化进度**：

| 维度 | 状态 | 字段 |
|------|------|------|
| thinking 参数适配（7 provider） | ✅ | `OpenAICompat.thinking` |
| effort 映射（7 provider） | ✅ | `ProviderEntry.effortMapping` |
| reasoning_content 回传（3 provider） | ✅ | `OpenAICompat.supportsReasoningContent` |
| think 标签剥离（1 provider） | ✅ | `OpenAICompat.stripThinkingTags` |

`conversions/openai.ts` 中 **0 处** provider 名称硬编码条件分支。仅保留 3 处 `deepseek` 模型名启发式兜底（generic provider 接入场景）。

### ~~5. API error 探测 thinking 能力~~ ✅

原在 `zy-code-todo-stub-cc-analysis.md` 中，与本方案强关联。2026-06 完成。

`src/services/api/modelCapabilityProbe.ts`：API 返回 "thinking not supported" 时自动降级运行时缓存。优先级链：`model-capabilities.json` → API error 运行时降级 → provider 默认能力。

### ~~6. capabilities 结构化对象~~ ✅

2026-06 完成。`model-capabilities.json` 的 `capabilities` 从字符串数组改为结构化对象，将所有能力维度聚合到一个字段中。思考相关能力（adaptive、preserve、effort）合并到 `thinking` 对象内：

```jsonc
{
  "pattern": "qwen3.6-max-preview",
  "capabilities": {
    "thinking": {                           // key 存在 = 支持 thinking
      "adaptive": true,                     // 自适应思考
      "preserve": "optional",               // 思考块回传
      "effort": ["off", "balanced"]         // effort 档位（数组或 { levels, map }）
    },
    "structured_outputs": true,             // bool
    "auto_mode": true,                      // bool
    "prompt_caching": "explicit"            // string
  },
  "maxThinkingTokens": "32k",               // token 限制保留顶层
  "contextWindow": "200k",
  "costs": { ... }
}
```

`localModelHasCapability()` 简化为检查 `capabilities[key]` 是否存在且不为 false。thinking 子配置通过专用访问器读取（`localModelHasAdaptiveThinking()`、`getLocalModelPreserveThinking()`、`getLocalModelEffortLevels()`、`getLocalModelEffortMap()`）。旧格式（数组 + 独立顶层字段 + 散落子配置）通过迁移垫片自动转换。

---

## 1. API 协议与 Provider 解耦

### 现状

zy-code 有 `AnthropicProviderAdapter` 和 `OpenAIProviderAdapter` 两个 adapter。26 个 provider 全部通过 `isOpenAIProvider()` 二选一。双格式 provider（dashscope/zhipu/kimi 等）通过 `settings.apiFormat` 切换。

声明式 compat 层已消除了 `conversions/openai.ts` 中的 provider 条件分支，但 `llmOrchestrator.ts` 中仍有 5 处 provider 名称判断：

| 行号 | 判断 | 用途 |
|------|------|------|
| 597 | `!== 'bedrock'` | bedrock 的 tool search beta 走 extraBodyParams |
| 809/990/994 | `=== 'anthropic'` | cached microcompact 仅 anthropic 启用 |
| 1125 | `=== 'anthropic' && isAnthropicBaseUrl()` | client request ID 追踪仅直连 API |

### 改进方向

**不建议做全面的 Api 层重构**（收益不匹配复杂度）。当前两个 adapter 已经稳定，compat 层处理了 OpenAI 侧的差异。`llmOrchestrator.ts` 中的 5 处判断是 Anthropic 专属特性（cache microcompact、client request ID），不属于"provider 差异"而是"Anthropic 专有功能门控"，可以通过 `ProviderCapability` 声明式化：

```typescript
// 在 ProviderCapability 联合类型中新增：
| 'cached_microcompact'    // 支持缓存编辑 microcompact
| 'client_request_id'      // 支持 client request ID 追踪
```

然后 `llmOrchestrator.ts` 中用 `providerHasCapability(provider, 'cached_microcompact')` 替代 `=== 'anthropic'`。

### 优先级

**低** — 当前 5 处判断是稳定的 Anthropic 专属逻辑，不随 provider 增加而增长。

---

## 3. 模型作为自描述值对象

### 现状

模型仍是裸字符串。运行时通过 5+ 个全局函数拼凑信息：

```
getAPIProvider()          → provider ID
getMainLoopModel()        → 模型名
localModelHasCapability() → 能力查询（model-capabilities.json，支持派生能力）
getProviderEntry()        → 注册表条目
getProviderCompat()       → compat 配置
mapEffortToProvider()     → effort 映射
getModelMaxInputTokens()  → token 限制
getModelCostsFromSettings() → 定价
```

每个调用点都要独立解析。`llmOrchestrator.ts` 的 `paramsFromContext` 在每次 API 调用前重复执行这些查询。

### 改进方案

定义 `ResolvedModel` 类型，在模型选择时一次性解析：

```typescript
// src/services/model/resolvedModel.ts

interface ResolvedModel {
  id: string                          // 原始模型名
  normalizedId: string                // API 规范化后的模型名
  provider: APIProvider               // 解析后的 provider
  baseUrl: string                     // 最终 base URL
  capabilities: Set<ProviderCapability>  // 合并后的能力集
  effortMapping: Record<string, string>  // 合并后的 effort 映射
  openaiCompat?: OpenAICompat         // compat 配置
  contextWindow?: number              // 上下文窗口
  maxOutputTokens?: number            // 最大输出 token
  maxThinkingTokens?: number          // 最大思考 token
  costs?: ModelCosts                  // 定价
}

function resolveModel(modelName: string): ResolvedModel
```

**实施路径**（渐进式，不一次全改）：

1. 先建 `ResolvedModel` 类型和 `resolveModel()` 函数
2. 在 `llmOrchestrator.ts` 的 `paramsFromContext` 入口处调用一次，替换后续的散落查询
3. 逐步把 `ResolvedModel` 向上传播（`QueryParams` → `query.ts` → `QueryEngine.ts`）
4. 最终 `convertThinkingForOpenAI` 等函数直接读 `resolvedModel.openaiCompat`，不再调用 `getProviderEntry`

### 优先级

**P0** — 消除全局状态依赖，简化调用链，为后续所有改进奠基。预估 3-5 天。

---

## 4. 模型级 effortMap

### 现状

effort 映射分两层：
- `ProviderEntry.effortMapping`（provider 级）：声明内部档位→API 参数值
- `model-capabilities.json` 的 `effortLevels`（模型级）：只声明"支持哪些档位"，不声明映射值

同一 provider 下不同模型的 effort 支持可能不同（如 DashScope 托管 Qwen/MiniMax/DeepSeek V4），但映射表是 provider 级的，无法精确控制。

### 改进方案

扩展 `model-capabilities.json` 的 schema，新增 `effortMap` 字段：

```jsonc
// ~/.zy/model-capabilities.json
{
  "models": [{
    "pattern": "deepseek-v4",
    "effortLevels": ["light", "balanced", "thorough"],
    "effortMap": {
      "light": "high",
      "balanced": "high",
      "thorough": "max"
    }
  }]
}
```

`mapEffortToProvider()` 查找链改为：模型级 `effortMap` → provider 级 `effortMapping` → anthropic 默认。

### 优先级

**P1** — 在 ResolvedModel 完成后自然落地。预估 1 天。

---

## 5. 统一的跨 provider 消息转换层

### 现状

`conversions/openai.ts`（896 行）和 `conversions/anthropic.ts`（518 行）各自独立处理：
- thinking block 兼容
- tool call/result 配对
- 消息格式规范化

两个文件没有共享的预处理步骤。跨模型切换时（如从 Anthropic 切到 OpenAI 兼容模型），thinking signature 失效、orphaned tool call 等问题由各自的 conversion 独立处理。

### 改进方案

提取 `src/services/api/conversions/preprocess.ts`，在任一 conversion 之前统一执行：

```typescript
export function preprocessMessagesForAPI(
  messages: Message[],
  targetModel: ResolvedModel,
  sourceModel?: string,
): Message[] {
  let result = messages
  result = stripInvalidThinkingSignatures(result, targetModel)
  result = synthesizeOrphanedToolResults(result)
  result = filterAbortedAssistantMessages(result)
  result = downgradeUnsupportedImages(result, targetModel)
  return result
}
```

### 优先级

**P1** — 需要 ResolvedModel 作为前置。预估 3-5 天。当前两个 conversion 文件各自处理这些问题（且都处理得正确），改进的主要收益是减少重复和统一行为。

---

## 6. 类型安全的 API 关联

### 现状

`LLMAdapter` 接口和 `CreateParams` 是 provider 无关的通用类型。`buildOpenAIRequestParams` 和 `buildAnthropicCreateParams` 的入参类型相同，类型系统无法区分。

### 改进方案

需要 ResolvedModel 完成后，通过泛型约束实现编译时检查。当前收益不大（adapter 选择已经稳定），留到 ResolvedModel 落地后评估。

### 优先级

**P2** — 依赖 ResolvedModel。

---

## 7. Faux Provider（可编程测试基础设施）

### 现状

测试通过 `bun:test` 的 `mock.module` mock 各模块，存在跨文件缓存污染问题（已在声明式 compat 测试中遇到并修复）。没有可编程的 mock provider。

### 改进方案

实现 `src/services/api/__test__/fauxProvider.ts`：

```typescript
export function createFauxProvider(responses: FauxResponse[]): {
  adapter: LLMAdapter
  entry: ProviderEntry
}
```

注册到标准 adapter 路径，通过 `QueryDeps` 注入（`deps.ts` 已预留扩展点）。无需 mock.module，消除跨文件污染问题。

### 优先级

**P2** — 当前测试已能工作（`overrideProvider` 参数注入），但 FauxProvider 会显著改善集成测试体验。预估 2 天。

---

## 8. 模型元数据自动生成

### 现状

模型信息来自：
- `providerRegistry.ts` 的 `suggestedModels`（手动维护，约 26 个 provider × 2-4 个推荐模型）
- `model-capabilities.json`（用户本地配置）
- `configs.ts` 中的静态定价

新模型发布或价格变更需要手动更新代码。

### 改进方案

编写 `scripts/generate-models.ts`，从各平台 API 拉取模型列表：

| 平台 | API | 数据 |
|------|-----|------|
| DashScope | `dashscope.aliyuncs.com/api/v1/models` | 模型列表 + 定价 |
| DeepSeek | `api.deepseek.com/models` | 模型列表 |
| OpenAI | `api.openai.com/v1/models` | 模型列表 |
| OpenRouter | `openrouter.ai/api/v1/models` | 模型列表 + 定价 + 能力 |

生成 `src/services/model/models.generated.ts`，在构建时 import。手动维护的 `suggestedModels` 保留作为 onboarding 推荐，但模型能力和定价从生成文件读取。

### 优先级

**P2** — 减少手动维护成本，但当前模型变更频率可控。预估 2-3 天。

---

## 落地顺序

```
1. [P0] ResolvedModel 值对象 — ✅ Phase 1 完成（llmOrchestrator 内部使用）
2. [P1] 模型级 effortMap — ✅ 完成（model-capabilities.json schema + 三层查找链）
3. [P1] 统一消息预处理层 — ❌ 不做（两个 conversion 无实际重复逻辑，预处理已在 apiNormalize.ts 统一）
4. [P1] capabilities 结构化对象 — ✅ 完成（数组→对象，promptCaching/effortLevels/effortMap/preserveThinking 收编）
5. [P2] Faux Provider — 待做（改善测试体验，2 天）
6. [P2] 模型元数据自动生成 — 待做（减少手动维护，2-3 天）
7. [P2] 类型安全 API 关联 — 待做（依赖 ResolvedModel 完全推广）
8. [低] llmOrchestrator 的 5 处 provider 判断 → ProviderCapability 声明式
```
