# Google Generative AI 原生 API 格式实现完成

## 实现概述

成功为 zy-code 添加了 Google Generative AI 原生 API 格式支持，使 Gemini 等模型可以使用 Google 原生格式而非 OpenAI 兼容端点。

## 核心改动

### 1. 类型系统扩展

**文件**: `src/services/model/providerRegistry.ts`
- `ApiFormat` 类型新增 `'google'`
- `ProviderEntry.defaultBaseUrls` 新增 `google?: string` 字段
- 新增 `GoogleCompat` 接口，用于声明 Google API 特有的行为（如 `thinkingConfig`）

**文件**: `src/types/llm.ts`
- `ProviderExtras` 新增 `google` 命名空间，支持 `thinkingConfig` 和 `safetySettings`

### 2. Provider 检测与配置

**文件**: `src/services/model/providers.ts`
- 新增 `getEffectiveApiFormat(provider)` - 统一处理格式选择逻辑
- 新增 `isGoogleProvider(provider)` - 检测是否使用 Google 格式
- 新增 `isAnthropicProvider(provider)` - 检测是否使用 Anthropic 格式
- 更新 `isOpenAIProvider(provider)` - 使用 `getEffectiveApiFormat`

**格式选择优先级**:
1. 用户显式设置 `settings.apiFormat`（若 provider 支持）
2. Provider 注册表声明的 `supportedFormats[0]`（默认首选格式）

**文件**: `src/services/model/providerRegistry.ts`
- Gemini provider 更新为 `supportedFormats: ['google', 'openai']`
- 新增 `googleCompat.thinking` 配置，支持 `thinkingBudget`、`thinkingLevel`、`includeThoughts`

### 3. 客户端工厂

**文件**: `src/services/api/client.ts`
- 新增 `getGoogleClient()` - 创建 Google Generative AI SDK 客户端
- 更新 `getLLMAdapter()` - 添加 Google 格式分支
- 支持环境变量: `GOOGLE_API_KEY`、`GOOGLE_BASE_URL`

### 4. 消息转换层

**文件**: `src/services/api/conversions/google.ts` (新建, ~22KB)
- `messagesToGoogle()` - 标准消息 → Google Content[]
- `buildGoogleRequestParams()` - 构建完整请求参数
- `googleStreamToStandard()` - 流式响应转换（处理累积式内容）
- `googleResponseToStandard()` - 非流式响应转换

**关键转换规则**:
- `role: 'assistant'` → `role: 'model'`
- 系统消息提取为 `systemInstruction`（独立字段）
- 内容块包装在 `parts[]` 数组中
- `tool_use` → `functionCall`
- `tool_result` → `functionResponse`
- 思考内容标记为 `thought: true` + `thoughtSignature`

### 5. 适配器实现

**文件**: `src/services/api/GoogleProviderAdapter.ts` (新建, ~5.2KB)
- 实现 `LLMAdapter` 接口
- `createStream()` - 流式请求
- `createMessage()` - 非流式请求
- `countTokens()` - Token 计数
- `verifyApiKey()` - API Key 验证

### 6. UI 与国际化

**文件**: `src/i18n/locales/zh-CN/onboarding.ts` & `en/onboarding.ts`
- 新增 `onboarding.apiFormat.google` 翻译
- 新增 `onboarding.apiFormat.googleDesc` 翻译

**文件**: `src/utils/settings/types.ts`
- `apiFormat` 设置新增 `'google'` 选项
- 更新描述文本

**文件**: `src/components/Onboarding.tsx`
- `PlatformConfig.defaultBaseUrls` 新增 `google?: string`
- Base URL 选择逻辑支持 Google 格式

### 7. 依赖

**文件**: `package.json`
- 新增 `@google/generative-ai@0.24.1`

## 支持的 Provider

### Gemini (Google 原生格式为默认)
```typescript
{
  id: 'gemini',
  supportedFormats: ['google', 'openai'],  // google 为首选
  defaultBaseUrls: {
    google: 'https://generativelanguage.googleapis.com/v1beta',
    openai: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  },
  googleCompat: {
    thinking: {
      enable: (effort) => ({
        thinkingConfig: {
          thinkingBudget: -1,  // -1 表示自动
          thinkingLevel: 'MEDIUM',  // LOW/MEDIUM/HIGH
          includeThoughts: true,
        }
      })
    }
  }
}
```

### 其他 Provider
- **DashScope**: `['anthropic', 'openai']` - 默认 openai
- **Anthropic**: `['anthropic']` - 仅 anthropic
- **OpenAI**: `['openai']` - 仅 openai

## 使用方式

### 1. 默认行为（无需配置）
```bash
# Gemini 自动使用 Google 原生格式
zy-code --provider gemini --api-key YOUR_KEY
```

### 2. 显式选择格式
```json
{
  "provider": "gemini",
  "apiFormat": "google"
}
```

### 3. 切换到 OpenAI 兼容格式
```json
{
  "provider": "gemini",
  "apiFormat": "openai"
}
```

## Google API 特性支持

### ✅ 已支持
- 文本生成（流式/非流式）
- 工具调用（function calling）
- 思考/推理（thinking）
- 图片输入（inline data）
- Token 计数
- 停止原因映射

### 🔄 转换细节
- **思考内容**: `Part.thought: true` ↔ `ThinkingBlock`
- **工具调用**: `functionCall` ↔ `tool_use`
- **工具结果**: `functionResponse` ↔ `tool_result`（合并到 user 消息）
- **流式响应**: 累积式内容 → 增量 delta 计算

## 状态栏修复

修复了默认格式逻辑导致的状态栏显示问题：
- **问题**: 之前的逻辑对所有多格式 provider 都默认使用 'openai'
- **修复**: 使用 `getEffectiveApiFormat()` 统一处理，尊重 `supportedFormats[0]` 作为默认值

## 验证结果

✅ TypeScript 类型检查通过 (`bun tsc --noEmit`)
✅ Biome 格式检查通过 (`bun run format:check`)
✅ 所有组件就位并正确集成

## 文件清单

### 新建文件 (2)
- `src/services/api/conversions/google.ts` (~22KB)
- `src/services/api/GoogleProviderAdapter.ts` (~5.2KB)

### 修改文件 (8)
- `src/services/model/providerRegistry.ts` - 类型扩展 + Gemini 配置
- `src/services/model/providers.ts` - 新增检测函数
- `src/services/api/client.ts` - Google 客户端工厂
- `src/types/llm.ts` - ProviderExtras 扩展
- `src/utils/settings/types.ts` - 设置 schema
- `src/components/Onboarding.tsx` - UI 支持
- `src/i18n/locales/zh-CN/onboarding.ts` - 中文翻译
- `src/i18n/locales/en/onboarding.ts` - 英文翻译
- `package.json` - 依赖

## 架构决策

1. **格式选择**: 使用 `supportedFormats[0]` 作为默认，而非硬编码
2. **类型安全**: 适配层使用 `as any` 处理 SDK 类型不兼容（符合 AGENTS.md §9）
3. **转换层**: 独立的 `conversions/google.ts` 处理所有格式转换
4. **向后兼容**: 不影响现有 OpenAI/Anthropic provider 的行为

## 下一步

可选的增强：
- 添加 Google API 特有功能的 UI 配置（如 `safetySettings`）
- 支持 Google 的 `cachedContent` 功能
- 支持 `googleSearch` 和 `codeExecution` 工具
- 添加更多单元测试覆盖
