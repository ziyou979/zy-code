# Core–Surface 分层架构设计

> 状态：设计草案 v0.1（待评审）
>
> 目标：把 zy-code 演进为「一套 Core 驱动多个 Surface」的架构 —— LLM 协议可扩展（converter 支持 openai-chat / anthropic 等，用户可注册新协议）、工具用户可替换、内置技能、TUI 渲染与 Core 完全解耦。
>
> 关联文档：[架构](architecture.md)、[配置参考](configuration.md)、[架构地图](architecture-map.md)、[开发规范](development-guidelines.md)。
>
> 借鉴来源：DeepSeek Harness（DSH）的 Cordis 插件树、capability seam、session event 日志、profile/bundle 分层组合等思想；本设计取其 idea 而**不**引入其框架依赖。

---

## 1. 背景与目标

zy-code 目前是单一 Ink TUI 应用。长期目标是一套底层（Core）能够驱动不同 Surface：TUI、Web、headless 一次性运行、SDK。DSH 已经验证了「同一 core 包组合出 web / headless 两种 profile」的可行性；本设计把该思想映射到 zy-code 现有代码，并落在四个具体目标上：

| # | 目标 | 含义 |
|---|------|------|
| G1 | LLM 对象由 zy-code 提供 | 对话循环只面向 zy-code 自己的中立 LLM 类型（`src/types/llm.ts`），不依赖任何 SDK |
| G2 | 协议 converter 可扩展 | openai-chat / anthropic / openai-responses / google 等协议以注册表形式存在，用户可注册新协议或覆盖内置实现 |
| G3 | 工具可替换、内置技能 | 用户可新增/覆盖/禁用工具；zy-code 默认提供工具集与内置 skills；skills 维持现状 |
| G4 | TUI 渲染完全解耦 | Core 零 React 依赖；UI 通过「交互缝」请求交互、通过「事件流」投影渲染 |

设计原则（借自 DSH 但轻量化）：

- **Core 只产出事实，不向 UI 发命令**：UI 渲染源是 append-only 会话事件流，而不是 Core 内部状态。
- **UI 只通过缝请求交互**：权限询问、提问、通知、提示输入等一律走 `UiHost` 接口，由 Surface 提供实现。
- **注册优先于分支**：协议、工具、渲染器、交互能力都以注册表组织，load 顺序由声明表达，而非手工 if/else。
- **增量演进、可回滚**：每个阶段独立交付，兼容期保留旧路径，最终收敛到唯一正式实现（遵循「正式实现只能有一处」的既有规范）。

---

## 2. 现状盘点：资产与差距

### 2.1 已有的资产（本设计直接复用）

| 领域 | 现状 | 位置 |
|------|------|------|
| 中立 LLM 类型 | 标准消息/流/工具类型 + `LLMAdapter` 接口 + `ProviderExtras`，业务禁止直接 import SDK | `src/types/llm.ts` |
| 协议转换 | anthropic / openai-chat / openai-responses / google 四个 adapter + conversions「知识库」 | `src/services/api/{anthropicProviderAdapter,openAIProviderAdapter,openAIResponsesProviderAdapter,googleProviderAdapter}.ts`、`src/services/api/conversions/` |
| 协议枚举 | `ApiFormat` 常量（`'anthropic' \| 'openai-chat' \| 'openai-responses' \| 'google'`） | `src/services/model/apiFormat.ts` |
| 模型→协议路由 | provider 注册表按模型 pattern 分流（`modelApiFormats`）、`getEffectiveApiFormat()` 决议链 | `src/services/model/providerRegistry.ts`、`src/services/model/providers.ts` |
| 工具注册表 | 自注册 + condition 过滤 + special 标记 | `src/tools/registry.ts` |
| 外部工具 | `~/.zy/tools/`、`.zy/tools/` 目录扫描、同名覆盖内置（`hasExternalToolOverride`）、代际重载 | `src/tools/externalToolLoader.ts`、`src/tools/externalToolAdapter.ts` |
| 内置技能 | `src/skills/bundled/` 20+ 内置 + 目录加载（用户/项目/插件） | `src/skills/` |
| 运行时注入 | 服务与组件通过 `bootstrap/runtime/runtimeContext.ts` 获取可注入能力 | `src/bootstrap/runtime/runtimeContext.ts` |
| 共享状态 | `AppStateStore` 集中管理 | `src/state/AppStateStore.ts` |

### 2.2 差距（本设计要解决的点）

| 目标 | 差距 | 严重度 |
|------|------|--------|
| G2 | adapter 分派是硬编码 if/else（`getLLMAdapter()`），converter 与 transport 耦合在一个类里，用户无法注册新协议 | 高 |
| G4 | Tool 接口内嵌 ~10 个返回 `React.ReactNode` 的 render 方法；`ToolUseContext` 内嵌 UI 回调（`setToolJSX`/`requestPrompt`/`addNotification`/…）；Core 因此依赖 React/Ink | 高 |
| G3 | 外部工具定义能力有限：无进度事件、权限一律 passthrough 弹窗、渲染是 React 硬编码 | 中 |
| G4 | 无 headless 表面：`src/server/server.ts` 是 `startServer not implemented` 桩；渲染源（UI 消费的 `Message[]`）与 Core 内部状态未分层 | 中 |

结论：**LLM 层差「注册机制」，工具层差「能力补强」，UI 层差「拆解」**。三块都是增量、可回滚的改动。

---

## 3. 目标架构总览：三层 + 两缝

```
┌────────────────────────────────────────────────────────────┐
│ Surface 层（可替换、可多个并存）                                │
│   TUI(Ink) / Web(未来) / headless / SDK                       │
│   职责：渲染 + 输入 + 实现交互缝 UiHost                          │
├────────────────────────────────────────────────────────────┤
│ Core 层（zy-code 拥有，headless 可独立运行，零 React）           │
│   对话循环(QueryEngine) │ Session 事件日志                      │
│   LLM 外观 + ProtocolRegistry + Converter                      │
│   ToolRegistry（默认工具集 + 用户替换）│ SkillRegistry           │
│   Permission / MCP / Shell / FS 等能力                         │
├────────────────────────────────────────────────────────────┤
│ 基础设施：settings / auth.json / model-capabilities / storage  │
│ （zy-code 已有优势，保持不动）                                    │
└────────────────────────────────────────────────────────────┘

两条缝（Surface 与 Core 的唯一接口）：
 ① UiHost  —— UI 提供的能力（权限询问 / 提问 / 通知 / 提示输入）
 ② SessionEvent 流 —— Core 产出的渲染源（UI 只投影，不读内部状态）
```

依赖规则：

- **Core 不得 import React / Ink**（`src/ink/`、`src/components/`、`src/screens/` 都属于 Surface 侧）。当前违反点逐一迁移，见 §7。
- **Surface 不得 import Core 内部状态实现**（`src/bootstrap/state/` 的 `STATE` 只能同目录访问的既有规则继续生效），只能通过 `runtimeContext` 注入的能力、`UiHost`、`SessionEvent` 流交互。
- **UI 相关的翻译文案**（新 Surface 产生的可见文本）仍须走 `src/i18n/`（`t`/`tSync`），英文与中文同步添加（开发规范既有要求）。

---

## 4. LLM 层：协议作为一级扩展点

### 4.1 角色拆分

把现在的「一个 adapter 类」拆成三个角色：

```ts
// ① ProtocolConverter —— 纯函数，负责「标准类型 ↔ 某协议 wire 格式」
//    用户扩展新协议时，只需实现这一个接口（可无传输、用默认传输）
interface ProtocolConverter {
  /** 协议标识，与 ApiFormat 对齐：'anthropic' | 'openai-chat' | 'openai-responses' | 'google' | 用户自定义 */
  readonly apiFormat: string
  /** 标准 CreateParams → 协议请求体（含 thinking / betas / tool 的协议专属映射） */
  toWire(params: CreateParams): unknown
  /** 协议响应/流 → 标准 LLMStreamEvent 序列 */
  streamToEvents(stream: unknown): AsyncIterable<LLMStreamEvent>
  /** 非流式响应 → 标准 LLMResponse */
  responseToMessage(response: unknown): LLMResponse
  /** 协议专属请求参数 → wire（ProviderExtras 的唯一读取点） */
  applyProviderExtras(wire: unknown, extras: ProviderExtras): void
}

// ② ProtocolTransport —— 协议转换器 + SDK client + 网络层（重试 / 代理 / mTLS）
//    形状与现有 LLMAdapter 对齐；内置协议各带一个默认实现，用户可整体覆盖
interface ProtocolTransport {
  readonly apiFormat: string
  createStream(params: CreateParams, signal: AbortSignal, clientRequestId?: string): Promise<StreamResult>
  createMessage(params: CreateParams, signal: AbortSignal, timeout?: number): Promise<LLMResponse>
  countTokens?(messages: LLMMessage[], tools: ToolDefinition[]): Promise<number | null>
  listModels?(): Promise<Record<string, unknown>[] | null>
  verifyApiKey(apiKey: string): Promise<boolean>
}

// ③ LLM 外观 —— zy-code 拥有的运行时对象，对话循环只碰它
//    编排、withRetry、用量、prompt cache、thinking 映射、VCR 都在这里，与今天 llmOrchestrator 的职责一致
interface LLM {
  createStream(params: CreateParams, signal: AbortSignal): Promise<StreamResult>
  createMessage(params: CreateParams, signal: AbortSignal): Promise<LLMResponse>
}
```

说明：

- `ProtocolConverter` 是纯函数，无 IO、无 SDK 依赖 → 用户可以在任何环境（浏览器、deno、纯文本）里编写并测试；也便于单测覆盖（现有 `conversions/*` 测试可平移）。
- `ProtocolTransport` 基本是现有 `LLMAdapter` 的重命名 + 显式 `apiFormat` 声明，迁移成本低。
- `LLM` 外观保持 `llmOrchestrator` / `queryModel` 的既有调用形状，对话循环**零改动**。

### 4.2 ProtocolRegistry

```ts
interface ProtocolRegistry {
  register(entry: {
    apiFormat: string
    converter: ProtocolConverter
    /** 可选：传输工厂；缺省时使用内置通用传输（基于 fetch 的 openai-chat/anthropic wire） */
    transportFactory?: (opts: { baseUrl?: string; apiKey?: string; timeout?: number }) => ProtocolTransport
    /** 可选：同 apiFormat 下的模型级分流（如 opencode-go 按模型走 anthropic / openai） */
    match?: (providerId: string, model: string) => boolean
  }): void
  /** 按「provider + 生效 apiFormat」解析；provider 专属 match 优先，否则按 apiFormat 查表 */
  resolve(providerId: string, model: string): ProtocolTransport | undefined
  /** 列出所有已注册协议（供 /model、onboarding、诊断展示） */
  list(): ProtocolRegistryEntry[]
}
```

- **分派依据直接复用现有决议链**：`getEffectiveApiFormat(provider, model)`（`src/services/model/providers.ts`，已综合 model-capabilities 的 `apiFormat`、provider 注册表的 `modelApiFormats` pattern、OAuth provider 格式、`settings.apiFormat`）产出的 `ApiFormat` 就是 registry 的查表键。`client.ts` 里 `isOpenAIProvider` / `isAnthropicProvider` 等 if/else 全部收敛为注册项的 `match` 函数，行为零变化。
- **同名覆盖**：注册 `apiFormat` 相同的 entry 时，后注册者覆盖先注册者（与工具层「用户 > 内置」规则一致），实现「用户替换内置协议」。

### 4.3 内置注册（与现有代码的映射）

| 注册项 | apiFormat | 现有实现迁移为 |
|--------|-----------|----------------|
| anthropic | `'anthropic'` | `conversions/anthropic.ts` 包一层实现 `ProtocolConverter`；`anthropicProviderAdapter` 改造为 transport |
| openai-chat | `'openai-chat'` | `conversions/openai.ts` + `openAIProviderAdapter` |
| openai-responses | `'openai-responses'` | `conversions/openaiResponses.ts` + `openAIResponsesProviderAdapter` |
| google | `'google'` | `conversions/google.ts` + `googleProviderAdapter` |

- `conversions/*` 已经是各协议的转换「知识库」，**转换逻辑不动**，只补接口壳。
- SDK client 创建（`client.ts` 的 `getAnthropicClient` / `getOpenAIClient` 及代理 / mTLS 处理）下沉为各 transport 的私有细节；`getLLMAdapter(options.anthropicClient)` 签名中的 `anthropicClient` 参数移除，改为 transport 内部懒创建。

### 4.4 用户扩展协议

仿照 `externalToolLoader` 的目录扫描机制，新增 `~/.zy/llm/<apiFormat>/` 与项目级 `.zy/llm/`：

- 每个目录的入口文件 default export 满足 `ProtocolConverter`（必需）与可选 `transportFactory`。
- 加载失败不阻塞启动，仅记录警告（与外部工具一致）。
- 与内置同名 `apiFormat` 时覆盖内置（G2 的「替换」语义）。
- 协议标识即目录名，天然避免命名冲突；`ApiFormat` 类型在运行时保持开放（字符串），注册表 `list()` 负责发现。

### 4.5 改动清单（P1）

| 文件 | 改动 |
|------|------|
| `src/types/llm.ts` | 新增 `ProtocolConverter`、`ProtocolTransport`、`LLM` 接口（`LLMAdapter` 保留为兼容入口，迁移期后删除） |
| `src/services/api/protocolRegistry.ts`（新） | 注册表实现 + 内置四项注册 |
| `src/services/api/client.ts` | `getLLMAdapter()` 改为查表 + 解析 `getEffectiveApiFormat` |
| `src/services/api/conversions/*.ts` | 各包一层实现 `ProtocolConverter`（转换逻辑不动） |
| `src/services/api/*ProviderAdapter.ts` | 改造为 `ProtocolTransport` 实现，SDK client 下沉 |
| `src/services/api/llmOrchestrator.ts` | 消费 `LLM` 外观，签名不变 |
| `src/services/plugins/`（或 `src/services/llm/`） | 新增用户协议目录扫描加载（仿 `externalToolLoader`） |
| `docs/configuration.md` | 补「用户协议」配置说明 |

---

## 5. 工具层：注册表语义补强

现状（`toolRegistry` + `externalToolLoader`）已实现「用户新增/覆盖/禁用工具」，本设计只做三件事补强：

### 5.1 来源标记与优先级

`toolRegistry.register(tool, condition, options)` 增加 `source: 'builtin' | 'plugin' | 'user'`：

- 默认工具集 = 内置 55 个工具（`src/tools/`），`getTools()` / `assembleToolPool()` 语义不变。
- 同名冲突规则保持现有「用户 > 内置」（`hasExternalToolOverride()` 已实现）；`/tools` 命令展示每个工具的来源与是否被覆盖。

### 5.2 ExternalToolDefinition 能力补强

当前外部工具只有 `name / description / inputSchema / call`，`adaptExternalTool` 用 `buildTool` 填默认值但能力受限。补强为可选字段：

```ts
interface ExternalToolDefinition {
  // …既有字段不变…
  /** 可选：进度回调，触发 tool/progress 事件（UI 显示进度条） */
  progress?(args: Record<string, unknown>, onProgress: (data: ToolProgressData) => void): Promise<...>
  /** 可选：声明权限行为；缺省保持现有 passthrough 弹窗 */
  permissions?: { mode?: 'allow' | 'ask' | 'deny'; reason?: string }
  /** 可选：结构化输出 schema（SDK 透传 / 校验） */
  outputSchema?: ToolInputJSONSchema
  /** 可选：并发安全显式声明（现在 = isReadOnly，用户不可覆盖） */
  isConcurrencySafe?: boolean
}
```

- **渲染解耦收益**：`adaptExternalTool` 中硬编码的 `React.createElement` 渲染逻辑删除，改为通用渲染 + 用户可选的**纯字符串**展示函数（`userFacingInput` / `userFacingOutput` 保留，跨 UI 可复用，不依赖 React）。
- 外部工具因此可以完全脱离 UI 框架编写，TUI / Web / headless 三端一致。

### 5.3 卸载与回退

代际重载机制（`reloadExternalTools`）已支持「删除文件 → 内置恢复」；保持现状并补充：

- 覆盖检测（`hasExternalToolOverride`）已让内置工具在用户同名工具存在时自动禁用 —— 保留，作为「替换」的正式语义。
- 补 `enabled: false` 的文档化（已有实现，仅补文档与 `/tools` 展示）。

工具替换完整矩阵：

| 操作 | 结果 |
|------|------|
| 新增（新名字） | 直接生效，出现在工具池 |
| 覆盖（同名） | 用户实现生效，内置自动禁用（`hasExternalToolOverride`） |
| 禁用（`enabled: false`） | 跳过加载 |
| 回退（删除文件 + 重载） | 内置恢复 |

---

## 6. 技能层：维持现状

`src/skills/` 已满足「内置 skills + 用户/项目/插件目录加载」：

- 内置：`src/skills/bundled/`（20+ 技能，`bundledSkills.ts` 汇总）。
- 外部：`loadSkillsDir` 按用户级 / 项目级 / 插件级目录加载；插件通过 `LoadedPlugin.skillsPath` 贡献技能。

本设计**不改动**技能系统，仅在 P2 渲染解耦时确认 `SkillTool` 的 UI 部分走 `ToolView`（技能触发面板属于 Surface 渲染职责）。

---

## 7. TUI 解耦：三步走

这是最大的工程，分三个阶段，每阶段可独立交付。

### Step 1 — 渲染与工具逻辑分离（ToolView）

把 `src/tools/tool.ts` 的 `Tool` 类型中返回 `React.ReactNode` 的 ~10 个方法（`renderToolUseMessage` / `renderToolResultMessage` / `renderToolUseProgressMessage` / `renderToolUseRejectedMessage` / `renderToolUseErrorMessage` / `renderGroupedToolUse` / `renderToolUseTag` / `renderToolUseQueuedMessage` / `extractSearchText` 等）从核心类型拆出，放到 UI 侧的可选接口：

```ts
// core（零 React）：Tool 只保留 call / inputSchema / description / checkPermissions /
//   isReadOnly / isConcurrencySafe / validateInput / mapToolResultToToolResultBlock /
//   userFacingName / getToolUseSummary / getActivityDescription 等与渲染无关的方法

// Surface 侧（新模块，如 src/ui/toolViews/）：
interface ToolView {
  renderUse?(input, opts): ReactNode
  renderResult?(output, progressMessages, opts): ReactNode
  renderProgress?(progressMessages, opts): ReactNode
  renderGrouped?(toolUses, opts): ReactNode
  renderRejected?(input, opts): ReactNode
  renderError?(result, opts): ReactNode
}
interface ToolViewRegistry {
  register(name: string, view: ToolView): void
  /** 未注册 → 通用渲染兜底（fallback 组件，现状已有） */
  resolve(name: string): ToolView | undefined
}
```

- **内置工具迁移**：render 方法留在原工具目录（同目录 `UI.tsx` 导出 `view`），沿用既有「`ToolProfile` 决定是否需要 `UI.tsx`」的结构约定（`interactive` 带 UI.tsx，`headless` 不带）。
- **迁移方式**：`Tool` 类型删除 render 方法后，`renderToolUseMessage` 等调用点改为「查 `ToolViewRegistry`，未命中走通用兜底」。逐个工具迁移，TUI 视觉逐步收敛，测试守护。
- **收益**：core bundle 不再包含 React / Ink 依赖；外部工具零 React（见 §5.2）；未来 Web surface 的 keyed renderer 就是同一个 `ToolViewRegistry`（对位 DSH 的 ConversationNodeDefinition + keyed renderer）。

### Step 2 — 交互缝 UiHost

把 `ToolUseContext` 里的 UI 回调收敛为一个由 Surface 实现的接口，经现有 `bootstrap/runtime/runtimeContext.ts` 注入：

```ts
interface UiHost {
  requestPermission(req: PermissionRequest): Promise<PermissionDecision> // 权限询问
  askUser(q: UserQuestion): Promise<UserAnswer>                          // AskUserQuestionTool 的后端
  promptInput(req: PromptRequest): Promise<PromptResponse>               // 现有 requestPrompt 迁移
  notify(n: Notification): void
  appendSystemMessage?(m: SystemMessage): void
  setToolJSX?(jsx: ReactNode | null): void                                // 特殊工具面板（如 TodoWrite）
  sendOSNotification?(opts: { message: string; notificationType: string }): void
}
```

- TUI（Ink）实现一套：权限对话框、提问弹层、通知中心 —— **现状视觉不变**，只改接线方式。
- headless / SDK 提供结构化 IO 实现（JSON 输出权限请求、`askUser` 返回默认/拒绝）—— 这就是未来 Web 后端的雏形。
- `ToolUseContext` 继续存在（兼容期），UI 回调字段改为从 `UiHost` 读取；新代码一律走缝。
- 对位 DSH：`ctx.userQuestions` / `ctx.approval` seam —— UI front end 提供 human-answer provider，Core 只面对 provider-neutral 的 `ask()` promise。

### Step 3 — Session 事件流作为渲染源

借 DSH「模型可见即已记录」：Core 维护 append-only 会话事件日志，UI 只投影。事件类型草案（命名与 `src/types/message.ts` 的 `StreamEvent` 区分开，避免混淆）：

```ts
type SessionEvent =
  | { type: 'user/message'; seq: number; message: UserMessage }
  | { type: 'assistant/chunk'; seq: number; delta: ChunkDelta }        // 逐块，保留回放与 UI 保真
  | { type: 'assistant/message'; seq: number; message: AssistantMessage }
  | { type: 'tool/start'; seq: number; toolName: string; input: unknown }
  | { type: 'tool/progress'; seq: number; toolUseId: string; data: ToolProgressData }
  | { type: 'tool/result'; seq: number; toolUseId: string; result: ToolResultBlock }
  | { type: 'permission/request'; seq: number; request: PermissionRequest }
  | { type: 'permission/decision'; seq: number; decision: PermissionDecision }
  | { type: 'turn/start'; seq: number } | { type: 'turn/end'; seq: number; reason: unknown }
```

- **渐进接入，不推倒 AppStateStore**：先给 `QueryEngine` 加一个事件 emitter（在既有产出点一行接入），TUI 继续用现在的 `Message[]` 渲染（事件流只是旁路）；Web surface 落地时直接用事件流投影，TUI 再逐步切换。
- **「模型可见即已记录」不变式**：任何进入模型请求的输入都必须能从事件日志重建 —— 这保证 fork / resume / transcript / telemetry / 未来 Web 实时订阅共享同一数据源。
- 对位 DSH：session events（durable facts）+ agent events（live 拦截）二分；本设计先做 durable 侧，live 拦截（agent/pre-step 等）在需要时再补。

---

## 8. 与 DeepSeek Harness 的对照

| DSH 概念 | 本设计落位 | 状态 |
|----------|------------|------|
| `ctx.llm` seam + adapter 注册 | `ProtocolRegistry` + `LLM` 外观（§4） | 新设计 |
| `ctx.tools` registry | `toolRegistry` 补强（§5） | 已有，补强 |
| `ctx.skills` | `src/skills/` 目录体系（§6） | 已有 |
| `ctx.systemPrompt` 收集 | `constants/systemPromptSections.js`（已有雏形）+ 插件注册 prompt section | 已有，可选补强 |
| `session/event` 日志 = UI 唯一数据源 | `SessionEvent` 流（§7 Step 3） | 新设计 |
| `ctx.userQuestions` / `ctx.approval` seam | `UiHost`（§7 Step 2） | 新设计 |
| 客户端 keyed renderer（Chat node） | `ToolViewRegistry`（§7 Step 1） | 新设计 |
| profiles / bundles（base + 表面层） | entrypoints 拆分：cli(TUI) / headless / SDK / 未来 web 组合同一 Core | 部分已有（SDK entry 在） |
| 客户端插件图 `__DSH_BOOT__` | 未来 Web surface 直接照搬该形态 | 未来 |
| Cordis 插件树本身 | 不引入；只取「context + 注册表 + 事件 + 可逆 effect」四个 idea，落地为 `runtimeContext` + 各注册表 | 刻意不学 |

**刻意不学的部分**：

- 不把 settings / telemetry / storage 全部插件化 —— zy-code 的 5 层 settings 合并、`auth.json` 命名连接、模型多候选 failover、`model-capabilities.json` 外部声明已经比 DSH 的配置模型强，保持。
- 不引入 Cordis 全家桶依赖 —— 注册表 + 注入 + 事件用轻量自研，避免引入未评估依赖（开发规范约束）。

---

## 9. 迁移路径

每个阶段独立交付、不破坏现状；P0 为前置基线。

| 阶段 | 内容 | 交付物 | 风险 | 验收 |
|------|------|--------|------|------|
| P0 | 冻结基线：`bun run quality` 全绿 | 测试护栏 | 无 | `quality` 通过 |
| P1 | LLM ProtocolRegistry：内置 4 协议注册化，`getLLMAdapter` 改查表 | 行为零变化 + `~/.zy/llm/` 用户协议可用 | 低 | `bun tsc --noEmit` + `bun test`（LLM 相关）；手测各 provider 一条流式请求 |
| P2 | 工具渲染解耦：`ToolView` 拆分 + `UiHost` 缝，TUI 用适配器保持视觉不变 | core 不再 import React；外部工具零 React | 中 | 逐工具迁移清单走完；快照测试守护渲染；headless 构建不含 React |
| P3 | `SessionEvent` 流出 + headless entry：Core 零 UI 独立跑通（复用现有 bridge / SDK） | headless 运行 + 事件流 API | 中 | headless 端到端跑通；事件流回放与 `Message[]` 渲染一致性测试 |
| P4 | Web surface：客户端插件图 + 事件投影渲染（照搬 DSH `__DSH_BOOT__` 形态） | Web UI | 高（前几步已铺路） | Web 与 TUI 共用 Core 的冒烟测试 |

---

## 10. 非目标与边界

- 不重构 settings / auth / model-capabilities 配置体系（§8「刻意不学的部分」）。
- 不引入 Cordis 或任何插件框架依赖。
- 不重写对话循环语义（`QueryEngine` / `llmOrchestrator` 的编排、重试、用量行为保持）。
- P2 之前不新增任何 Surface；TUI 是唯一在产 Surface，headless 是 P3 的验收载体。
- 工具 render 方法迁移不追求一次到位：允许「通用兜底渲染」长期存在，迁移按工具逐个推进。

---

## 附录 A：接口签名草案（汇总）

见 §4.1（ProtocolConverter / ProtocolTransport / LLM）、§4.2（ProtocolRegistry）、§5.2（ExternalToolDefinition 补强）、§7 Step 1（ToolView / ToolViewRegistry）、§7 Step 2（UiHost）、§7 Step 3（SessionEvent）。最终以代码为准，本文为设计意图。

## 附录 B：逐文件改动清单

| 阶段 | 文件 | 改动 |
|------|------|------|
| P1 | `src/types/llm.ts` | 新增 Protocol 三接口；`LLMAdapter` 保留兼容入口 |
| P1 | `src/services/api/protocolRegistry.ts`（新） | 注册表 + 内置四项注册 |
| P1 | `src/services/api/client.ts` | `getLLMAdapter` 改查表 |
| P1 | `src/services/api/conversions/*.ts` | 包一层实现 `ProtocolConverter` |
| P1 | `src/services/api/*ProviderAdapter.ts` | 改造为 `ProtocolTransport` |
| P1 | `src/services/api/llmOrchestrator.ts` | 消费 `LLM` 外观 |
| P1 | 用户协议目录扫描（新模块） | 仿 `externalToolLoader` |
| P2 | `src/tools/tool.ts` | 拆分 render 方法出 core `Tool` |
| P2 | `src/ui/toolViews/`（新） | `ToolView` + `ToolViewRegistry` + 通用兜底 |
| P2 | 各内置工具 `UI.tsx` | 导出 `view` 并注册 |
| P2 | `src/tools/externalToolAdapter.ts` | 删 React 渲染，改通用渲染 + 字符串展示 |
| P2 | `src/bootstrap/runtime/runtimeContext.ts` | 注入 `UiHost` |
| P2 | TUI 权限 / 提问 / 通知实现 | 迁移到 `UiHost` 实现 |
| P3 | `src/services/session/events.ts`（新） | `SessionEvent` 类型 + emitter |
| P3 | `src/QueryEngine.ts` | 事件产出点接入 |
| P3 | `src/entrypoints/headless.ts`（新） | headless 表面 |
| P4 | Web surface（未来） | 客户端插件图 + 事件投影 |
| 各阶段 | `docs/configuration.md`、`docs/architecture.md` | 同步文档 |
