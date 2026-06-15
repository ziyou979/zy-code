# zy-code vs Claude Code v2.1.177 深度对比报告

> **分析日期**：2026-06-15
> **CC 二进制**：`/Users/zy979/.nvm/versions/node/v24.14.1/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` (215MB)
> **CC 版本**：2.1.177 · 构建日期 2026-06-13
> **CC 上次分析版本**：2.1.169（2026-06-09）
> **zy-code 源码**：`/Users/zy979/IdeaProjects/zy-code/src/`
> **变更范围**：v2.1.170 ~ v2.1.177（含 changelog + 二进制提取）

---

## 目录

1. [Hooks 系统](#一hooks-系统)
2. [Auto Mode 分类器](#二auto-mode-分类器)
3. [Refusal Fallback（模型拒绝降级）](#三refusal-fallback模型拒绝降级)
4. [Streaming Watchdog（流式看门狗）](#四streaming-watchdog流式看门狗)
5. [Compact 压缩策略](#五compact-压缩策略)
6. [Prompt Cache 管理](#六prompt-cache-管理)
7. [工具执行并发](#七工具执行并发)
8. [终端渲染与滚动](#八终端渲染与滚动)
9. [错误处理与重试策略](#九错误处理与重试策略)
10. [Auto-Copy 配置提示](#十auto-copy-配置提示)
11. [Safe Mode 与 Supervised 模式](#十一safe-mode-与-supervised-模式)
12. [Daemon 进程](#十二daemon-进程)
13. [Session Resume 高级参数](#十三session-resume-高级参数)
14. [Feature Flags (ENABLE_*) 差异](#十四feature-flags-enable-差异)
15. [更多环境变量差异](#十五更多环境变量差异)
16. [缺失命令](#十六缺失命令)
17. [缺失工具](#十七缺失工具)
18. [设置系统差异](#十八设置系统差异)
19. [企业/基础设施差异](#十九企业基础设施差异)
20. [安全与环境隔离](#二十安全与环境隔离)
21. [Fable 5 模型支持 🆕](#二十一fable-5-模型支持)
22. [Sub-agent 嵌套深度 🆕](#二十二sub-agent-嵌套深度)
23. [Artifact 系统 🆕](#二十三artifact-系统)
23B. [Agent-Team / Swarm 系统](#二十三bagent-team--swarm-系统对比)
23C. [多终端会话同步 🆕](#二十三c多终端会话同步daemon--pty-proxy)
24. [zy-code 独有优势](#二十四zy-code-独有优势)
25. [优先级建议](#二十五优先级建议)

---

## 一、Hooks 系统

CC 支持 **20+ 种 hook 事件**，zy-code 仅支持其中 7 种。

### 对比表

| CC Hook 事件 | zy-code | 说明 |
|---|---|---|
| `PreToolUse` | ✅ | 工具调用前 |
| `PostToolUse` | ✅ | 工具调用后 |
| `UserPromptSubmit` | ✅ | 用户提交 prompt |
| `Notification` | ✅ | 通知 |
| `Stop` | ✅ | 会话停止 |
| `SessionStart` | ✅ | 会话开始 |
| `SessionEnd` | ✅ | 会话结束 |
| **`MessageDisplay`** | ❌ 缺失 | 流式输出时拦截/修改显示内容（display-only） |
| **`SubagentStart`** | ❌ 缺失 | 子 Agent 启动时注入上下文 |
| **`SubagentStop`** | ❌ 缺失 | 子 Agent 停止时注入反馈 |
| **`PermissionRequest`** | ❌ 缺失 | 权限请求时程序化决策（allow/deny） |
| **`PermissionDenied`** | ❌ 缺失 | 权限被拒绝时重试控制 |
| **`PostToolBatch`** | ❌ 缺失 | 批量工具调用完成后统一处理 |
| **`PostToolUseFailure`** | ❌ 缺失 | 工具调用失败后注入上下文 |
| **`UserPromptExpansion`** | ❌ 缺失 | prompt 展开前注入上下文 |
| **`Setup`** | ❌ 缺失 | 初始化阶段注入上下文 |
| **`CwdChanged`** | ❌ 缺失 | 工作目录变更通知 + watchPaths |
| **`FileChanged`** | ❌ 缺失 | 文件变更通知 + watchPaths |
| **`Elicitation`** | ❌ 缺失 | MCP Elicitation 请求程序化处理 |
| **`ElicitationResult`** | ❌ 缺失 | MCP Elicitation 结果覆写 |
| **`WorktreeCreate`** | ❌ 缺失 | Worktree 创建事件 |
| **`ConfigChange`** | ❌ 缺失 | 配置变更事件 |
| **`DreamTask`** | ❌ 缺失 | 后台 memory 整合任务事件（偏移 `191555680`） |

### CC 二进制偏移

| 事件 | 偏移量 |
|------|--------|
| `ConfigChange` | `122397824` |
| `PostToolBatch` | `78429783`, `90327600` |

### zy-code 实现位置

- Hook 事件类型定义：`src/types/hooks/payloads.ts`, `src/types/hooks/schemas.ts`
- Hook 执行器：`src/services/hooks/executors/tool.ts`, `src/services/hooks/commandRunner.ts`
- Hook 配置管理：`src/services/hooks/hooksConfigManager.ts`
- Plugin hook 加载：`src/services/plugins/loadPluginHooks.ts`

---

## 二、Auto Mode 分类器

### CC 实现

三级规则分类器系统：

```
autoMode:
  allow: [...]       # 允许列表
  soft_deny: [...]   # 软拒绝列表（需确认）
  hard_deny: [...]   # 硬拒绝列表（始终拒绝）
  environment: [...]  # 环境规则
  $defaults: true     # 继承默认值
```

- **两阶段分类器**：`TWO_STAGE_CLASSIFIER`
- `CLAUDE_CODE_CLASSIFIER_SUMMARY`：分类器摘要环境变量
- Auto Mode 与 `PermissionRequest` hook 联动
- 🆕 **`CLAUDE_CODE_AUTO_MODE_SIBLING_CONTEXT`**（偏移 `110387776`）：同级 turn 上下文注入
- 🆕 **`CLAUDE_CODE_AUTO_MODE_TEMPERATURE`**（偏移 `96167968`）：Auto Mode 温度控制

### CC 二进制偏移

| 关键词 | 偏移量 |
|--------|--------|
| `autoMode` | 多处 |
| `TWO_STAGE_CLASSIFIER` | 二进制中 |
| `soft_deny` / `hard_deny` | 二进制中 |
| `CLAUDE_CODE_CLASSIFIER_SUMMARY` | `78312064` |
| 🆕 `AUTO_MODE_SIBLING_CONTEXT` | `110387776` |
| 🆕 `AUTO_MODE_TEMPERATURE` | `96167968` |

### zy-code 现状

- **缺失**：无三级规则分类器（allow/soft_deny/hard_deny）
- **缺失**：无 `TWO_STAGE_CLASSIFIER` 两阶段分类器
- Auto Mode 仅基于简单的权限模式切换

### zy-code 相关文件

- `src/utils/permissions/autoModeState.ts`（状态管理）
- `src/services/api/llmOrchestrator.ts` L74-76（auto mode state 导入）

---

## 三、Refusal Fallback（模型拒绝降级）

### CC 实现

完整的模型拒绝 → 自动切换备用模型机制：

- 当模型返回 `stop_reason: refusal` 时，自动切换到 fallback model 重试
- 遥测事件 `model_refusal_fallback`（含 `original_model` / `fallback_model`）
- `tengu_refusal_fallback_latch_reset`：锁存重置机制
- `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK` 环境变量可禁用

### CC 二进制偏移

| 关键词 | 偏移量 |
|--------|--------|
| `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK` | `78299344` |
| `model_refusal_fallback` | `98778592`, `101415408` |
| `refusal-fallback` | `75179509`, `106108064` |
| `refusal_fallback` | `82743120`, `95863046` |

### zy-code 现状

**文件**：`src/services/api/errors.ts` L1046-L1066

```typescript
export function getErrorMessageIfRefusal(
  stopReason: StopReason | null,
  _model: string,
): AssistantMessage | undefined {
  if (stopReason !== 'refusal') {
    return
  }
  logEvent('zy_refusal_api_response', {})
  // ...
  const modelSuggestion = ''  // 硬编码为空，不做模型建议
  return createAssistantAPIErrorMessage({ ... })
}
```

**差距**：仅检测 `stop_reason === 'refusal'` 并显示错误消息，**不切换模型、不重试**。`modelSuggestion` 硬编码为空字符串。

---

## 四、Streaming Watchdog（流式看门狗）

### CC 实现

多层看门狗 + 自动降级机制：

| 机制 | CC 环境变量/遥测 | 说明 |
|------|----------------|------|
| **Retry Watchdog** | `CLAUDE_CODE_RETRY_WATCHDOG` | 重试看门狗超时配置 |
| **Stale Connection Retry** | `tengu_streaming_stale_connection_retry` | stale 连接自动重连 |
| **Watchdog Retry** | `tengu_streaming_watchdog_retry` | 看门狗触发后自动重试 |
| **Non-streaming Fallback** | `cli_nonstreaming_fallback_started` / `tengu_nonstreaming_fallback_started` | 流式彻底失败 → 非流式 |
| **Disable 开关** | `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` | 可禁用非流式降级 |

### CC 二进制偏移

| 关键词 | 偏移量 |
|--------|--------|
| `CLAUDE_CODE_RETRY_WATCHDOG` | `78316592` |
| `tengu_streaming_watchdog_retry` | `123508352` |
| `tengu_streaming_stale_connection_retry` | `123508080` |
| `tengu_nonstreaming_fallback_started` | `123508656` |
| `cli_nonstreaming_fallback_started` | `123508592` |
| `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` | `78299616` |

### zy-code 现状

**文件**：`src/services/api/llmOrchestrator.ts` L1200-L1230

```typescript
// 双层定时器
streamIdleWarningTimer = setTimeout(..., STREAM_IDLE_WARNING_MS)
streamIdleTimer = setTimeout(() => {
  streamIdleAborted = true
  streamWatchdogFiredAt = performance.now()
  // ...
  releaseStreamResources()  // 直接释放资源，不重试
}, STREAM_IDLE_TIMEOUT_MS)
```

- ✅ 有 `STREAM_IDLE_TIMEOUT_MS` + `STREAM_IDLE_WARNING_MS` 双层定时器
- ✅ 有 stall 检测（`STALL_THRESHOLD_MS = 30_000`）
- ✅ `zy_streaming_idle_timeout` 遥测
- ✅ `zy_stream_loop_exited_after_watchdog` 遥测
- ❌ **看门狗触发后不自动重连重试**，直接 abort
- ❌ **无非流式降级回退路径**

---

## 五、Compact 压缩策略

### 对比表

| 特性 | CC | zy-code | zy-code 文件 |
|------|----|---------|-------------|
| **AUTO_COMPACT_WINDOW** | ✅ env | ✅ `ZY_CODE_AUTO_COMPACT_WINDOW` | `services/compact/autoCompact.ts` L40-46 |
| **Partial Compact** | ✅ | ✅ `from`/`up_to` 方向 | `services/compact/compact.ts` L757-1078 |
| **PTL Retry** | ✅ | ✅ `MAX_PTL_RETRIES = 3` | `services/compact/compact.ts` L216-276 |
| **PRECOMPACT_SKIP** | ✅ env | ✅ `ZY_CODE_DISABLE_PRECOMPACT_SKIP` | `services/sessionStorage/logLoading.ts` L944 |
| **Reactive Compact** | ✅ | ✅ 480 行 | `services/compact/reactiveCompact.ts` |
| **MicroCompact** | 未确认 | ✅ 508 行 | `services/compact/microCompact.ts` |
| **Cached MicroCompact** | 未确认 | ✅ | `services/compact/cachedMicrocompact.ts` |
| **API Microcompact** | 未确认 | ✅ 147 行 | `services/compact/apiMicrocompact.ts` |
| **Context Collapse** | 未确认 | ✅ | `services/compact/contextCollapse/` |
| **Cache Sharing (Fork)** | 未确认 | ✅ `runForkedAgent()` | `services/compact/compact.ts` L1149-1211 |
| **Image/Doc Strip** | 未确认 | ✅ | `services/compact/compact.ts` L123-178 |
| **Circuit Breaker** | 未确认 | ✅ `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` | `services/compact/autoCompact.ts` L70 |
| **COLD_COMPACT** | ✅ | ❌ 缺失 | — |

### CC 二进制偏移

| 关键词 | 偏移量 |
|--------|--------|
| `CLAUDE_CODE_COLD_COMPACT` | `78300720` |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `78312432` |
| `AUTO_COMPACT_WINDOW` (use site) | `106517200` |
| `messagesToKeep` | `101770848`, `176416256` |
| `partial_compact_failed` | `106217894` |
| `compact_partial_api_error` | `106218184` |
| `compactionControl` | `137770240` |
| `contextTokenThreshold` | `137770288` |
| `CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP` | `78290800` 附近 |

### zy-code 关键常量

```typescript
// src/services/compact/autoCompact.ts
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
const AUTOCOMPACT_BUFFER_TOKENS = 13_000
const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
const MAX_INPUT_AUTOCOMPACT_RATIO = 0.9

// src/services/compact/compact.ts
const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
const POST_COMPACT_TOKEN_BUDGET = 50_000
const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000
const MAX_COMPACT_STREAMING_RETRIES = 2
const MAX_PTL_RETRIES = 3
```

**结论**：zy-code 在 compact 子系统上**实际上领先 CC**，有多层压缩策略。唯一缺失项为 `COLD_COMPACT`（冷启动压缩）。

---

## 六、Prompt Cache 管理

### CC 实现

| 特性 | 说明 |
|------|------|
| `PROMPT_CACHING` feature | 全局开关，6 个变体 |
| `DISABLE_PROMPT_CACHING` | 全局禁用 |
| `DISABLE_PROMPT_CACHING_HAIKU` | Haiku 专用禁用 |
| `DISABLE_PROMPT_CACHING_OPUS` | Opus 专用禁用 |
| `DISABLE_PROMPT_CACHING_SONNET` | Sonnet 专用禁用 |
| `promptCache` | 每响应 cache 状态追踪 |
| `cache_hit` / `cache_miss` | 精确遥测 |
| `cache_control` | `ephemeral` 断点标记 |
| Cache Break Detection | 前后两阶段检测 + 自动 diff |

### CC 二进制偏移

| 关键词 | 偏移量 |
|--------|--------|
| `PROMPT_CACHING` | `78294694`, `78294983` |
| `DISABLE_PROMPT_CACHING` | `78286198` 附近 |
| `promptCache` | `78755536`, `82436736` |
| `cache_hit` | `84823776` |
| `cache_miss` | `84823808` |
| `cache_control` | `89930192`, `90169120` |

### zy-code 实现

**文件**：`src/services/api/promptCacheBreakDetection.ts`（688 行）

**领先 CC 的特性**：
- 11 维状态追踪（systemHash, toolsHash, cacheControlHash, betas, autoMode, overage, effort, extraBody 等）
- 每工具 schema hash（精确到哪个工具的 description 变了）
- `buildDiffableContent()` 生成可 diff 文本
- `notifyCompaction()` / `notifyCacheDeletion()` 防误报
- `MAX_TRACKED_SOURCES = 10` 防止内存泄漏
- MCP 工具名 sanitize（防路径泄漏）

**缺失**：
- ❌ `DISABLE_PROMPT_CACHING_<model>` 按模型精细控制开关

### zy-code 关键结构

```typescript
// src/services/api/promptCacheBreakDetection.ts
type PreviousState = {
  systemHash: number
  toolsHash: number
  cacheControlHash: number      // scope/TTL 变化检测
  toolNames: string[]
  perToolHashes: Record<string, number>  // 单工具级别变化检测
  systemCharCount: number
  model: string
  globalCacheStrategy: string
  betas: string[]
  autoModeActive: boolean
  isUsingOverage: boolean
  cachedMCEnabled: boolean
  effortValue: string
  extraBodyHash: number
  // ...
}

const MAX_TRACKED_SOURCES = 10
const MIN_CACHE_MISS_TOKENS = 2_000
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000
const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000
```

---

## 七、工具执行并发

### CC 实现

- `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 环境变量
- `PostToolBatch` 事件（批量工具执行后统一触发 hook）

### CC 二进制偏移

| 关键词 | 偏移量 |
|--------|--------|
| `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` | `78316688` |
| `MAX_TOOL_USE_CONCURRENCY` | `78316700` |
| `PostToolBatch` | `78429783`, `90327600` |

### zy-code 实现

**文件**：`src/services/tools/toolOrchestration.ts`（177 行）

```typescript
function getMaxToolUseConcurrency(): number {
  return parseInt(process.env.ZY_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
}

// 分区执行：只读工具并发，写工具串行
for (const { isConcurrencySafe, blocks } of partitionToolCalls(...)) {
  if (isConcurrencySafe) {
    // 并发执行 + contextModifier 延迟应用
  } else {
    // 串行执行
  }
}
```

**结论**：两者**基本对等**。

---

## 八、终端渲染与滚动

### 对比表

| 特性 | CC | zy-code | zy-code 文件 |
|------|----|---------|-------------|
| **VIRTUAL_SCROLL** | ✅ | ✅ | `screens/repl/ReplTranscriptView.tsx` L247 |
| **SCROLL_SPEED** | ✅ env | ✅ `ZY_CODE_SCROLL_SPEED` | `components/ScrollKeybindingHandler.tsx` L327-334 |
| **Output Style** | ✅ 配置+文件夹 | ✅ `outputStyles` 目录 | `utils/plugins/loadPluginOutputStyles.ts` |
| **EAGER_FLUSH** | ✅ env | ✅ `ZY_CODE_EAGER_FLUSH` | `QueryEngine.ts` 6 处使用 |
| **INCLUDE_PARTIAL_MESSAGES** | ✅ env | ✅ `ZY_CODE_INCLUDE_PARTIAL_MESSAGES` | `cli/commands/root.ts` L487 |
| **EMIT_TOOL_USE_SUMMARIES** | ✅ env | ✅ `ZY_CODE_EMIT_TOOL_USE_SUMMARIES` | `query/config.ts` L28 |
| **SYNCHRONIZED_UPDATE** | ✅ | ❌ 缺失 | — |
| **SGR Mouse** | ✅ | ❌ 缺失 | — |
| **DISABLE_MOUSE** | ✅ env | ❌ 缺失 | — |
| **ALT_SCREEN_FULL_REPAINT** | ✅ env | ✅ (无独立 env flag) | `ink/ink.tsx` L485-487 |
| 🆕 **wheelScrollAcceleration** | ✅ 设置项 | ❌ 缺失 | — |

### CC 二进制偏移

| 关键词 | 偏移量 |
|--------|--------|
| `VIRTUAL_SCROLL` | `78299188` |
| `CLAUDE_CODE_SCROLL_SPEED` | `78308576` |
| `SYNCHRONIZED_UPDATE` | `86027264` |
| `outputStyle` | `81689376`, `94908145` |
| `CLAUDE_CODE_EAGER_FLUSH` | `78317104` |
| `INCLUDE_PARTIAL_MESSAGES` | `78297932` |
| `EMIT_TOOL_USE_SUMMARIES` | `78311692` |
| `CLAUDE_CODE_DISABLE_MOUSE` | `78299744` |
| 🆕 `wheelScrollAcceleration` | `82080464` |

### 缺失说明

1. **SYNCHRONIZED_UPDATE**：CC 使用终端同步更新协议（`\x1b[?2026h`/`\x1b[?2026l`）避免渲染闪烁
2. **SGR Mouse Protocol**：CC 支持 SGR 鼠标协议 + `CLAUDE_CODE_DISABLE_MOUSE` 开关
3. 🆕 **wheelScrollAcceleration**：CC 2.1.174 新增 `wheelScrollAccelerationEnabled` 设置项，可禁用全屏模式下的鼠标滚轮加速

---

## 九、错误处理与重试策略

### CC 容错降级机制

| 机制 | 环境变量/遥测 | 说明 |
|------|-------------|------|
| **Refusal Fallback** | `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK` / `model_refusal_fallback` | 模型拒绝 → 切换备用模型 |
| **Non-streaming Fallback** | `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` / `cli_nonstreaming_fallback_started` | 流式失败 → 非流式 |
| **Model Fallback (529)** | `api_request_fallback_triggered` | 过载 → 备用模型 |
| **Stale Connection Retry** | `tengu_streaming_stale_connection_retry` | ECONNRESET → 重连 |
| **Retry Watchdog** | `CLAUDE_CODE_RETRY_WATCHDOG` | 重试看门狗 |

### zy-code 实现

**文件**：`src/services/api/withRetry.ts`（615 行）

**已有**：
- ✅ `withRetry()` 完整重试循环（max 10 次）
- ✅ `FallbackTriggeredError`：529 过载 → 备用模型
- ✅ `isStaleConnectionError()`：ECONNRESET/EPIPE 检测
- ✅ `disableKeepAlive()`：stale 连接后禁用连接池
- ✅ Persistent retry：`ZY_CODE_UNATTENDED_RETRY`，429/529 无限重试 + 30s 心跳
- ✅ `parseMaxTokensContextOverflowError()`：上下文溢出自动缩减 max_tokens
- ✅ `getRateLimitResetDelayMs()`：读取 `anthropic-ratelimit-unified-reset` header
- ✅ 前台/后台 529 区分（`FOREGROUND_529_RETRY_SOURCES`）

**缺失**：
- ❌ Refusal Fallback（模型拒绝不触发模型切换）
- ❌ Non-streaming Fallback（流式失败不自动回退非流式请求）

### zy-code 关键常量

```typescript
// src/services/api/withRetry.ts
const DEFAULT_MAX_RETRIES = 10
const FLOOR_OUTPUT_TOKENS = 3000
const MAX_529_RETRIES = 3
const BASE_DELAY_MS = 500
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 30_000
```

---

## 十、Auto-Copy 配置提示

### CC 实现

CC 在 daemon 和配置界面中有 `auto-copy-config-hint` 机制：

- 二进制偏移 `75622416`：`auto-copy` 字符串
- 偏移 `111513691`：`auto-copy` 出现在 UI 配置上下文中
- 偏移 `75622350`：`auto-copy-config-hint` 与 `daemon.lock`、`com.anthropic.claude-daemon` 相邻
- 用户可通过 `/config` 中 "disable auto-copy" 开关控制
- "always copy full response" 是设置选项之一（偏移 `110784033`）

### zy-code 现状

- ✅ **已有** `copyFullResponse` 设置项：`src/components/Settings/Config.tsx` L657-673
- ✅ **已有** `/copy` 命令中读取 `copyFullResponse` 偏好：`src/commands/copy/copy.tsx` L182-296
- ❌ **缺失** `auto-copy-config-hint`：CC daemon 模式下自动提示 copy 配置的能力
- ❌ **缺失** `ZY_CODE_DAEMON_COLD_START`：CC 偏移 `78311980`，daemon 冷启动优化

---

## 十一、Safe Mode 与 Supervised 模式

### CC 实现

```
CLAUDE_CODE_SAFE_MODE → 安全模式（`--safe-mode` CLI flag）
CLAUDE_CODE_SUPERVISED → 监管模式（限制更多操作）
```

**Safe Mode 上下文**（偏移 `198996250`）：

```javascript
function x4(){return __(process.env.CLAUDE_CODE_SAFE_MODE)||jg_("--safe-mode")}
function QD(){return jg_("--safe-mode")?"restart without --safe-mode":"unset CLAUDE_CODE_SAFE_MODE"}
```

- `--safe-mode`：CLI flag 启动安全模式，禁用部分功能
- Safe mode 提供 "restart without --safe-mode" 恢复提示
- `SUPERVISED` 模式用于受监管执行环境

### CC 二进制偏移

| 关键词 | 偏移量 |
|--------|--------|
| `CLAUDE_CODE_SAFE_MODE` | `79080012`, `79080914`, `198996362` |
| `safeMode` (JS) | `172705584` |
| `CLAUDE_CODE_SUPERVISED` | `78307980`, `199781744` |
| `supervised` (JS) | `177271257`, `199797743` |

### zy-code 现状

- ❌ **完全缺失**：无 `ZY_CODE_SAFE_MODE`、无 `--safe-mode` CLI flag
- ❌ **完全缺失**：无 `ZY_CODE_SUPERVISED` 监管模式

---

## 十二、Daemon 进程

### CC 实现

CC 有完整的 daemon 后台进程系统：

- `daemon.lock`：daemon 锁文件（偏移 `75622432` 附近）
- `com.anthropic.claude-daemon`：daemon 标识（偏移 `75622448` 附近）
- `CLAUDE_CODE_DAEMON_COLD_START`：daemon 冷启动优化（偏移 `78311980`）
- daemon 与 auto-copy 配置联动

### CC 二进制偏移

| 关键词 | 偏移量 |
|--------|--------|
| `daemon.lock` | `75622432` |
| `com.anthropic.claude-daemon` | `75622448` |
| `CLAUDE_CODE_DAEMON_COLD_START` | `78311980` |

### zy-code 现状

- **文件**：`src/daemon/main.ts`（5 行）+ `src/daemon/workerRegistry.ts`

```typescript
// src/daemon/main.ts
export async function daemonMain(_args: string[]): Promise<void> {
  throw new Error('daemonMain not implemented')
}
```

- ❌ **未实现**：daemon 入口函数抛出 "not implemented"
- ❌ 无 `daemon.lock` 机制
- ❌ 无 `ZY_CODE_DAEMON_COLD_START`

---

## 十三、Session Resume 高级参数

### CC 实现

CC 有 4 个 session resume 相关环境变量，zy-code 仅有 1 个：

| CC 环境变量 | 偏移量 | 说明 | zy-code |
|------------|--------|------|---------|
| `CLAUDE_CODE_RESUME_FROM_SESSION` | `78308972` | 从指定 session ID 恢复 | ❌ 缺失 |
| `CLAUDE_CODE_RESUME_PROMPT` | `78308860` | 恢复时注入的 prompt | ❌ 缺失 |
| `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES` | `78308796` | 恢复时间阈值（分钟） | ❌ 缺失 |
| `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` | `78308732` | 恢复 token 阈值 | ❌ 缺失 |
| `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` | `78308908` | 恢复中断的 turn | ✅ `ZY_CODE_RESUME_INTERRUPTED_TURN` |

### zy-code 现状

- ✅ `ZY_CODE_RESUME_INTERRUPTED_TURN`：`src/cli/print.ts` L986
- ❌ 其他 4 个 resume 参数均缺失

---

## 十四、Feature Flags (ENABLE_*) 差异

CC 二进制中提取到 **30+ 个** `ENABLE_*` 内部 feature flag，以下列出 zy-code 缺失的关键 flag：

### 缺失的 Feature Flags

| CC Feature Flag | 说明 | CC 偏移 |
|-----------------|------|---------|
| `ENABLE_APPEND_SUBAGENT_PROMPT` | 子 Agent prompt 追加 | — |
| `ENABLE_AUTO_MODE` | Auto Mode 开关 | — |
| 🆕 `ENABLE_AUTO_PIN` | 自动 Pin 功能 | — |
| `ENABLE_AWAY_SUMMARY` | 离开时生成摘要 | zy-code ✅ 有模块 `services/awaySummary.ts` |
| `ENABLE_BACKGROUND_PLUGIN_REFRESH` | 后台插件刷新 | — |
| `ENABLE_BETA_TRACING_DETAILED` | 详细 beta tracing | — |
| `ENABLE_BYTE_WATCHDOG` | 字节级看门狗 | — |
| `ENABLE_BYTE_WATCHDOG_BEDROCK` | Bedrock 字节看门狗 | — |
| `ENABLE_CFC` | CFC 功能 | — |
| 🆕 `ENABLE_CLAUDEAI_MCP_SERVERS` | Claude.ai MCP 服务器 | — |
| 🆕 `ENABLE_CONNECT_PROTOCOL` | Connect 协议 | — |
| `ENABLE_CRASH_REPORTING` | 崩溃报告 | ❌ 缺失 |
| `ENABLE_DATADOG` | Datadog 集成 | — |
| `ENABLE_DELEGATE_ACCESS_RIGHTS` | 委托访问权限 | — |
| 🆕 `ENABLE_DESIGN_SYNC` | 设计同步 | — |
| 🆕 `ENABLE_ENHANCED_TELEMETRY_BETA` | 增强遥测 Beta | — |
| `ENABLE_EXPERIMENTAL_ADVISOR_TOOL` | 实验性 Advisor 工具 | zy-code ✅ 有 Advisor |
| `ENABLE_EXPERIMENTAL_SHELL_BUILTINS` | 实验性 shell builtins | ❌ 缺失 |
| `ENABLE_FEEDBACK_SURVEY_FOR_OTEL` | OTEL 反馈调查 | — |
| `ENABLE_FINE_GRAINED_TOOL_STREAMING` | 细粒度工具流式 | — |
| `ENABLE_GATEWAY_MODEL_DISCOVERY` | 网关模型发现 | — |
| `ENABLE_LOCKLESS_UPDATES` | 无锁更新 | zy-code ✅ `installer.ts` L417-533 |
| `ENABLE_LSP_TOOL` | LSP 工具 | zy-code ✅ `tools/LSPTool/` |
| `ENABLE_MCP_LARGE_OUTPUT_FILES` | MCP 大输出文件 | — |
| 🆕 `ENABLE_MENU_KIND_LANES` | 菜单类型通道 | — |
| 🆕 `ENABLE_OPUS_` | Opus 模型特定开关（后缀动态） | — |
| `ENABLE_OUTLIER_DETECTION` | 异常检测 | — |
| `ENABLE_PID_BASED_VERSION_LOCKING` | PID 版本锁 | — |
| 🆕 `ENABLE_PROMPT_CACHING_` | Prompt Caching 按模型后缀开关 | — |
| `ENABLE_PROMPT_SUGGESTION` | Prompt 建议 | — |
| 🆕 `ENABLE_PROXY_AUTH_HELPER` | 代理认证助手 | — |
| `ENABLE_PUSH` | 推送能力 | — |
| 🆕 `ENABLE_REMOTE_RECAP` | 远程回顾 | — |
| `ENABLE_SDK_FILE_CHECKPOINTING` | SDK 文件检查点 | — |
| `ENABLE_SESSION_BACKGROUNDING` | 会话后台化 | — |
| `ENABLE_SESSION_PERSISTENCE` | 会话持久化 | — |
| `ENABLE_STREAM_WATCHDOG` | 流式看门狗 | zy-code ✅ 有 streaming watchdog |
| `ENABLE_STRICT` | 严格模式 | — |
| 🆕 `ENABLE_TASKS` | 后台任务管理 | — |
| `ENABLE_TOKEN_USAGE_ATTACHMENT` | Token 用量附加 | — |
| 🆕 `ENABLE_TOOL_SEARCH` | 工具搜索 | zy-code ✅ `tools/ToolSearchTool/` |

### 已确认 zy-code 对齐的

- ✅ `ENABLE_LOCKLESS_UPDATES` → `installer.ts`
- ✅ `ENABLE_LSP_TOOL` → `tools/LSPTool/`
- ✅ `ENABLE_AWAY_SUMMARY` → `services/awaySummary.ts`
- ✅ `ENABLE_EFFORT` → `ZY_CODE_ALWAYS_ENABLE_EFFORT`
- ✅ `ENABLE_STREAM_WATCHDOG` → streaming watchdog 定时器

---

## 十五、更多环境变量差异

以下 CC 环境变量在 zy-code 中**完全缺失**：

| CC 环境变量 | 偏移量 | 说明 |
|------------|--------|------|
| `CLAUDE_CODE_BG_CLASSIFIER_MODEL` | `78314956` | 后台分类器模型（🆕 名称含 `_MODEL`） |
| `CLAUDE_CODE_SLOW_OPERATION_THRESHOLD_MS` | `78316540` | 慢操作阈值(ms)（🆕 名称含 `_MS`） |
| `CLAUDE_CODE_REPO_CHECKOUTS` | `78309020` | 仓库 checkout 路径 |
| `CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE` | `78297628` | 包管理器自动更新 |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | `78312220` | 阻塞限制覆写 |
| `CLAUDE_CODE_PEWTer_OWL` | `78297532` | 内部实验 flag |
| `CLAUDE_CODE_BYOC_ENABLE_DATADOG` | `78292748` | BYOC Datadog 集成 |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | `78317372` | 自定义归因 header |
| `CLAUDE_CODE_ACT_DONT_REDERIVE` | `78301068` | ACT 不重新推导 |
| `CLAUDE_CODE_VERIFY_PROMPT` | `78296700` | Prompt 验证 |
| `CLAUDE_CODE_VOICE_FORWARD_INTERIMS_TYPED` | `120308556` | 语音转发中间结果 |
| `CLAUDE_CODE_BS_AS_CTRL_BACKSPACE` | `85689164` | BS 键映射为 Ctrl+Backspace |
| `CLAUDE_CODE_RATE_LIMIT_TIER` | `78289004` | 速率限制等级 |
| `CLAUDE_CODE_OWNERSHIP_FRAME` | `78297692` | 所有权框架 |
| `CLAUDE_CODE_AUTO_MODE_EXTERNAL_PERMISSIONS` | `78312300` 附近 | Auto Mode 外部权限 |
| `CLAUDE_CODE_PEWTER_OWL_TOOL` | `78297580` | Pewter Owl 工具 |
| `CLAUDE_CODE_ADDITIONAL_PROTECTION` | `78312588` | 额外安全保护层 |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | — | 子进程环境变量清洗 |
| `CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY` | — | PS 执行策略尊重 |
| `CLAUDE_CODE_PWSH_PARSE_TIMEOUT_MS` | `78309660` | PowerShell 解析超时 |
| `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS` | — | 用户对话框超时 |
| `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` | — | Stop hook 块上限 |
| `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` | — | SessionEnd hooks 超时 |
| 🆕 `CLAUDE_CODE_PERFORCE_MODE` | `78632160` | Perforce 模式（原 `PERFORCE` 升级） |
| 🆕 `CLAUDE_CODE_PLAN_MODE_REQUIRED` | `78619120` | Plan Mode 必需 |
| 🆕 `CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE` | `78632096` | Plan Mode 访谈阶段 |
| 🆕 `CLAUDE_CODE_ARTIFACT` | `78622784` | Artifact 功能 |
| 🆕 `CLAUDE_CODE_ARTIFACT_AUTO_OPEN` | `78634432` | Artifact 自动打开 |
| 🆕 `CLAUDE_CODE_PROACTIVE` | `78618960` | 主动模式 |
| 🆕 `CLAUDE_CODE_WORKFLOWS` | `83549856` | 工作流系统 |
| 🆕 `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` | `78622032` | 禁用内置 skill |
| 🆕 `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` | `78621040` | 禁用终端标题 |

---

## 十六、缺失命令

> **v2.1.177 更新**：经核实，多个此前标记为缺失的命令 zy-code 已有对应实现。

### CC 命令清单（v2.1.177 完整提取）

**prompt 类型**：`init`, `init-verifiers`, `team-onboarding`, `review`, `statusline`, `insights`×2

**local-jsx 类型**：`usage-credits`, `extra-usage`, `add-dir`, `autofix-pr`, `btw`, `feedback`, `cd`, `color`, `copy`, `desktop`, `autocompact`, `config`, `diff`, `memory`, `help`, `ide`, `login`, `logout`, `install-github-app`, `mcp`, `mobile`, `powerup`, `rename`, `resume`, `setup-bedrock`, `setup-vertex`, `ultraplan`, `ultrareview`, `session`, `scroll-speed`, `skills`, `status`, `tasks`, `teleport`, `terminal-setup`, `usage`, `theme`, `tui`, `permissions`, `plan`, `release-notes`, `security-review`

**local 类型**：`usage-credits`, `extra-usage`, `clear`, `color`, `compact`, `autocompact`, `context`, `toggle-memory`, `install-slack-app`, `mcp`, `rename`, `usage`, `fast`, `reload-plugins`, `reload-skills`, `heapdump`, `bridge-kick`, `version`, `stickers`, `radio`, `exit`, `update`, `model`, `effort`, `voice`, `recap`, `goal`, `stop`

### 对齐状态更新

| CC 命令 | CC 类型 | zy-code | 说明 |
|---------|---------|---------|------|
| `/ultrareview` | local-jsx | ✅ 已有 | — |
| `/schedule` | — | ❌ 未确认 | 未在二进制中找到独立注册 |
| `/remote-control` | — | ❌ 未确认 | — |
| `/scroll-speed` | local-jsx | ❌ 缺失 | — |
| `/fast` | local | ❌ 缺失 | — |
| `/stop` | local | ❌ 缺失 | 停止后台会话 |
| `/recap` | local | ❌ 缺失 | 会话摘要回顾（`tengu_sedge_lantern` feature gate） |
| `/team-onboarding` | prompt | ❌ 缺失 | 团队引导 |
| `/usage-credits` | local-jsx | ❌ 缺失 | 用量额度查看 |
| `/extra-usage` | local-jsx | ❌ 缺失 | 额外用量申请 |
| 🆕 `/security-review` | prompt | ✅ **已有** | `src/skills/bundled/securityReview.ts` |
| 🆕 `/release-notes` | local-jsx | ✅ **已有** | `src/commands/release-notes/` |
| 🆕 `/insights` | prompt | ✅ **已有** | `src/commands/insights.ts` |
| 🆕 `/tasks` (别名 `bashes`) | local-jsx | ✅ **已有** | `src/commands/tasks/` |
| 🆕 `/powerup` | local-jsx | ✅ **已有** | — |
| 🆕 `/voice` | local | ✅ **已有** | `src/commands/voice/` |
| 🆕 `/stickers` | local | ✅ **已有** | — |
| 🆕 `/radio` | local | ✅ **已有** | — |
| 🆕 `/plan` | local-jsx | ✅ **已有** | — |
| 🆕 `/cd` | local-jsx | ✅ **对应 `add-dir`** | `src/commands/add-dir/` |

---

## 十七、缺失工具

| CC 工具 | 说明 | CC 偏移 | zy-code 状态 |
|---------|------|---------|-------------|
| `NotebookRead` | Jupyter Notebook 读取 | `148196592` | ❌ 缺失 |
| `Cd` | 切换工作目录 | — | ❌ 缺失（`/cd` 命令存在但非工具） |
| `TodoRead` | 只读查看 Todo 列表 | — | ❌ 未找到（可能已移除） |
| `Brief` | 简洁模式工具 | `206410543` | ❌ 缺失 |
| `PushNotification` | 推送通知 | `75304416` | ❌ 缺失 |
| `RemoteTrigger` | 远程触发器 | `75425872` | ❌ 缺失 |
| `SendUserFile` | 发送用户文件 | `75321344` | ❌ 缺失 |
| `REPL` | 交互式 REPL | `206422288` | ❌ 缺失 |
| `Monitor` | 系统监控 | `206390807` | ❌ 缺失 |
| `ToolSearch` | 工具搜索 | `75318336` | ✅ **已有** `src/tools/ToolSearchTool/` |

### zy-code 已有的对应工具

zy-code 有 57 个工具目录，其中**已对齐**的包括：
- `ToolSearch` → ✅ `src/tools/ToolSearchTool/`
- `NotebookEdit` → ✅ `src/tools/NotebookEditTool/`
- `TodoWrite` → ✅ `src/tools/TodoWriteTool/`

---

## 十八、设置系统差异

### CC 独有能力

| CC 设置 | 说明 |
|---------|------|
| `autoMode` (三级规则) | allow/soft_deny/hard_deny 规则 |
| `ssh.connections` | SSH host/port/identity 配置 |
| `sessionRecap` | 会话回顾配置 |
| `pluginMarketplace` | 插件市场管理 |
| `promptCacheTTL` | Prompt Cache TTL 配置 |
| 5 级设置源 | user < project < local < flag < policy |
| MCP server allowlist/denylist | 企业级 MCP 管控 |
| 🆕 `enforceAvailableModels` | 管理设置：强制模型白名单，阻止 Default 解析到非白名单模型（2.1.175） |
| 🆕 `disableBundledSkills` | 隐藏内置 skill/workflow/命令（2.1.169，偏移 `82076144`） |
| 🆕 `footerLinksRegexes` | 正则匹配 footer 链接徽章（2.1.176，偏移 `82077328`） |
| 🆕 `wheelScrollAccelerationEnabled` | 鼠标滚轮加速开关（2.1.174，偏移 `82080464`） |
| 🆕 `availableModels` | 模型白名单，配合 `enforceAvailableModels` 使用（66 处引用） |
| 🆕 `opusplan` | Opus Plan 模式模型设置，支持 `[1m]` 上下文（偏移 `82916864`） |

### CC 二进制偏移

| 关键词 | 偏移量 |
|--------|--------|
| `cachePlugin` | `78408048`, `83374976` |
| `bundled plugin` | `88082704`, `101745888` |
| `outputStyles` folder | `108013680` |

### zy-code 已有设置

**文件**：`src/tools/ConfigTool/supportedSettings.ts`（239 行）

约 20 个设置项：theme, provider, editorMode, verbose, preferredNotifChannel, autoCompactEnabled, autoMemoryEnabled, autoDreamEnabled, fileCheckpointingEnabled, showTurnDuration, terminalProgressBarEnabled, todoFeatureEnabled, model, mainLoopModel, models.advanced/standard/compact, alwaysThinkingEnabled, permissions.defaultMode, language, teammateMode

**zy-code 独有**：
- 多 provider 支持（anthropic/dashscope/openrouter/generic）
- 分层模型系统（advanced/standard/compact）

---

## 十九、企业/基础设施差异

| 特性 | CC | zy-code |
|------|----|---------|
| **Perforce VCS** | ✅ `CLAUDE_CODE_PERFORCE_MODE` 🆕（原 `PERFORCE` 升级为 `_MODE`） | ❌ 缺失 |
| **Plugin ZIP Cache** | ✅ `cachePlugin` | ❌ 缺失 |
| **5 级设置源** | ✅ user < project < local < flag < policy | ❌ 3 级 |
| **OTEL Metrics** | ✅ 完整 OpenTelemetry | 部分 |
| **Bundled Plugin** | ✅ `anthropic-skills` + `claude-code` | 有 plugin 系统但结构不同 |
| **Marketplace (18 分类)** | ✅ 官方市场 + known marketplaces | 有 plugin marketplace 但分类较少 |

### CC 二进制偏移

| 关键词 | 偏移量 |
|--------|--------|
| `CLAUDE_CODE_PERFORCE` | `78310112` |
| `CLAUDE_CODE_CONTAINER_ID` | `78312016` |
| `CLAUDE_CODE_CLASSIFIER_SUMMARY` | `78312064` |
| `CLAUDE_CODE_AGENT_LIST_IN_MESSAGES` | `199910647` |

---

## 二十、安全与环境隔离

| 特性 | CC | zy-code | CC 偏移 |
|------|----|---------|---------|
| **BUBBLEWRAP** | ✅ | ✅ `ZY_CODE_BUBBLEWRAP` | `78300768` |
| **Sandbox Indicator** | ✅ `BASH_SANDBOX_SHOW_INDICATOR` | ✅ `SandboxDependenciesTab` | — |
| **Additional Protection** | ✅ `ADDITIONAL_PROTECTION` | ❌ 缺失 | — |
| **Container ID** | ✅ `CONTAINER_ID` | ❌ 缺失 | `78312016` |
| **Script Caps** | ✅ `SCRIPT_CAPS` | ❌ 缺失 | — |
| **Bubblewrap** | ✅ Linux sandbox | ✅ `services/sandbox/` | `78300768` |

---

## 二十一、Fable 5 模型支持

> **v2.1.177 新增**（来自 changelog 2.1.170 + 二进制提取）

### CC 实现

CC 2.1.170 引入 **Claude Fable 5**，Mythos-class 模型，能力超过此前所有公开发布的模型：

- **模型定位**：Fable 5 > Opus 4.7+ > Opus 4.6+ / Sonnet 4.6
- **策略限制**：Fable 5 和 Opus 4.7+ 被列为 "may use excessive tokens"，建议仅用于最难任务
- **用量积分**：Fable 5 消耗 usage credits（2.1.172 修复了错误显示）
- **1M 上下文**：Fable 5 默认包含 1M 上下文，`[1m]` 后缀自动剥离（2.1.173）
- **`/fast` 模式**：2.1.176 修复了 `/fast` 切换到非白名单模型的问题

### CC 二进制偏移

| 关键词 | 偏移量 |
|--------|--------|
| `Fable` | `75235728` |
| `fable` | `75232928` |
| `opusplan` | `82916864` |
| `ENABLE_OPUS_4_7_FAST_MODE` | `78636672` |
| `DISABLE_FAST_MODE` | `78636848` |
| `DISABLE_1M_CONTEXT` | `78636896` |
| `DISABLE_LEGACY_MODEL_REMAP` | `78636784` |

### zy-code 现状

- ❌ **缺失**：Fable 5 模型尚未在 zy-code 中配置
- zy-code 的多 provider 架构理论上支持 Fable 5（通过 Anthropic API），但缺少模型配置和能力声明

---

## 二十二、Sub-agent 嵌套深度

> **v2.1.177 新增**（来自 changelog 2.1.172）

### CC 实现

CC 2.1.172 引入 **sub-agent 自嵌套**能力：

- Sub-agents 可以 spawn 自己的 sub-agents，最多 **5 层深**
- 二进制中 `5 levels` 字符串出现在偏移 `62547096` 和 `62570196`
- `maxDepth` 字段控制嵌套深度（偏移 `80938080`、`164799105`、`168809056`）
- Workflow tool `agent()` 子 Agent 支持 per-agent attribution headers

### CC 二进制偏移

| 关键词 | 偏移量 |
|--------|--------|
| `5 levels` | `62547096`, `62570196` |
| `maxDepth` | `80938080`, `164799105`, `168809056` |

### zy-code 现状

- ✅ zy-code 有 sub-agent 系统（`src/coordinator/`）
- ❌ **缺失**：5 层嵌套深度限制机制
- 需要确认 zy-code 当前 sub-agent 是否支持嵌套 spawn

---

## 二十三、Artifact 系统

> **v2.1.177 新增**（二进制提取发现）

### CC 实现

CC 有完整的 Artifact 系统，支持生成和管理代码产物：

- **`CLAUDE_CODE_ARTIFACT`**：Artifact 功能开关（偏移 `78622784`）
- **`CLAUDE_CODE_ARTIFACT_AUTO_OPEN`**：自动打开 Artifact（偏移 `78634432`）
- **`CLAUDE_CODE_ARTIFACT_DIRECT_UPLOAD`**：直接上传 Artifact（偏移 `78622784`）

### zy-code 现状

- ✅ zy-code 有 Canvas 系统（`.canvas.tsx`）
- ❌ **缺失**：CC 风格的 Artifact 系统（auto-open、direct-upload）

---

## 二十三B、Agent-Team / Swarm 系统对比

> **v2.1.177 补充**（二进制提取 + zy-code 源码交叉对比）

### 整体评估

Agent-Team 是两者都在积极发展的方向。**zy-code 在此领域实际上较为成熟**，有完整的 `services/swarm/` 服务层（14 个文件），CC 也有对应体系。

### 对比表

| 特性 | CC | zy-code | 说明 |
|------|----|---------|------|
| **teammateMode 设置** | ✅ | ✅ `settings.ts` | 队友模式配置 |
| **TeammateIdle Hook** | ✅ | ✅ `types/hooks/payloads.ts` | 队友空闲 hook |
| **TEAMMATE_COMMAND 环境变量** | ✅ | ✅ `TEAMMATE_COMMAND_ENV_VAR` | 队友启动命令 |
| **spawnTeammate 函数** | ✅ | ✅ `tools/shared/spawnMultiAgent.ts` | 队友 spawn 核心逻辑 |
| **Sub-agent 嵌套** | ✅ 5 层 | ✅ `spawnMultiAgent.ts` | 递归 spawn |
| **tmux 后端** | ✅ | ✅ `services/swarm/backends/` | tmux/iTerm2/in-process 多后端 |
| **In-process 后端** | 未确认 | ✅ `inProcessRunner.ts` | 进程内队友（无 tmux 时降级） |
| **TeamCreateTool** | 未确认 | ✅ `tools/TeamCreateTool/` | 团队创建工具 |
| **WorkflowTool** | ✅ `agent()` | ✅ `tools/WorkflowTool/` | 工作流编排（含 `agent()` API） |
| **SendMessageTool** | 未确认 | ✅ `tools/SendMessageTool/` | 队友间消息发送 |
| **agent swarm 开关** | `ENABLE_AGENT_TEAM` | ✅ `--agent-teams` + `ZY_CODE_EXPERIMENTAL_AGENT_TEAMS` + GrowthBook `zy_amber_flint` | 三层门控 |
| **teammate 颜色分配** | 未确认 | ✅ `assignTeammateColor()` | 队友 UI 颜色区分 |
| **teammate 布局管理** | 未确认 | ✅ `teammateLayoutManager.ts` | tmux pane 布局 |
| **teammate 重连** | 未确认 | ✅ `reconnection.ts` | 断线自动重连 |
| **权限同步** | 未确认 | ✅ `permissionSync.ts` + `leaderPermissionBridge.ts` | leader↔teammate 权限同步 |
| **Cowork Plugin 系统** | ✅ Cowork Plugin Authoring skill | ✅ 部分（`USE_COWORK_PLUGINS`） | CC 有完整的 plugin authoring 指导 |
| **remoteControlAtStartup** | ✅ | ✅ `ConfigTool/supportedSettings.ts` | 启动时远程控制 |
| **inputNeededNotifEnabled** | ✅ | ✅ `ConfigTool/supportedSettings.ts` | 需要输入时通知 |
| 🆕 **isolatePeerMachines** | ✅ 设置项 | ❌ 缺失 | 对端机器隔离 |
| 🆕 **autoUploadSessions** | ✅ 设置项 | ❌ 缺失 | 自动上传会话 |
| 🆕 **Cowork Plugin Authoring** | ✅ 内置 skill | ❌ 缺失 | Cowork 插件创作指导 |
| 🆕 **multi-agent workflow 使用警告** | ✅ 首次使用确认 | ❌ 缺失 | auto mode 下运行 workflow 前的确认 |

### CC 二进制偏移

| 关键词 | 偏移量 |
|--------|--------|
| `agent-team` | `95136402` |
| `AGENT_TEAM` | `78620025` |
| `teammate` | `75224736` |
| `teammateMode` | `82080736` |
| `TeammateIdle` | `78757011` |
| `TEAMMATE_COMMAND` | `75365772` |
| `USE_COWORK_PLUGINS` | `78618428` |
| `spawnTeammate` | 偏移 `103005232` 附近 |
| `subagent_teammate_tmux` | `102994864` |
| `subagent_launch` | `102994832` |
| `multi-agent` | `82058156` |
| `isolatePeerMachines` | `82080816` |
| `remoteControlAtStartup` | `82080768` |
| `autoUploadSessions` | `82080896` |
| `inputNeededNotifEnabled` | `82080944` |

### zy-code 关键文件

```
src/services/swarm/
├── backends/              # 后端检测与注册
│   ├── detection.ts       # tmux/iTerm2 可用性检测
│   ├── registry.ts        # 后端注册与降级
│   ├── inProcess.ts       # 进程内后端
│   └── types.ts           # BackendType 定义
├── constants.ts           # SWARM_SESSION_NAME, TEAM_LEAD_NAME 等
├── inProcessRunner.ts     # 进程内队友运行器
├── It2SetupPrompt.tsx     # iTerm2 配置引导
├── leaderPermissionBridge.ts  # leader 权限桥接
├── permissionSync.ts      # leader↔teammate 权限同步
├── reconnection.ts        # 断线重连
├── spawnInProcess.ts      # 进程内 spawn
├── spawnUtils.ts          # spawn 工具函数
├── teamHelpers.ts         # team file 读写
├── teammateInit.ts        # 队友初始化
├── teammateLayoutManager.ts  # tmux pane 布局
├── teammateModel.ts       # 队友模型配置
└── teammatePromptAddendum.ts  # 队友 prompt 补充
```

**结论**：zy-code 在 Agent-Team/Swarm 领域**基础设施完备**，甚至在某些方面（in-process 后端、颜色分配、布局管理、重连机制）领先 CC。主要缺失项为 `isolatePeerMachines`、`autoUploadSessions` 设置和 Cowork Plugin Authoring 内置 skill。

---

## 二十三C、多终端会话同步（Daemon + PTY Proxy）

CC 支持多个终端打开同一个对话（通过 `claude agents` 面板或 `claude attach`），实现"同一个对话在多个窗口同步显示"。zy-code 目前**不具备**此能力。

### 核心架构：Hub-and-Spoke PTY 镜像

```
                     ┌─── Worker (PTY) ────┐
                     │  实际 CLI 进程        │
                     │  stdout → PTY master │
                     └──────┬───────────────┘
                            │ 原始终端字节流
                    ┌───────▼───────────────┐
                    │    Daemon / Supervisor │
                    │  (常驻后台进程)          │
                    │  roster.json           │
                    │  control socket (UDS)  │
                    └───┬──────┬──────┬─────┘
                        │      │      │
                   ┌────▼┐ ┌──▼──┐ ┌─▼────┐
                   │ T1  │ │ T2  │ │ T3   │
                   │终端1 │ │终端2 │ │终端3  │
                   └─────┘ └─────┘ └──────┘
```

**本质**：不是"同步滚动位置"，而是 **PTY 终端代理**。Worker 进程运行在 daemon 管理的伪终端中，daemon 捕获原始终端字节流，分发给所有已连接的客户端。所有客户端看到完全相同的终端内容。

### CC Daemon 控制协议（Unix Domain Socket）

| 操作 | 说明 |
|---|---|
| `ping` | 心跳检测 daemon 存活 |
| `lease` | 客户端注册保活（label, cwd, pid） |
| `leases` | 列出活跃客户端 |
| `list` | 列出所有后台任务（jobs） |
| `has` | 检查会话是否存在 |
| `subscribe` | 订阅会话输出流（含 `tail` 选项） |
| `attach` | 附加到运行中的会话 |
| `resize` | 同步终端尺寸变更 |
| `reply` | 回复 peek 请求（peek-reply 机制） |
| `kill` | 终止后台任务 |
| `yield` | 让出控制权 |
| `nudge` | 唤醒空闲会话 |
| `shutdown` | 关闭 daemon |

### Attach / Kick 机制（关键）

当客户端通过 `op: "attach"` 连接到已有会话时：

1. **发送初始状态**：daemon 向新客户端发送 `decModeSnapshot()`（DEC 终端模式）和当前 `tempo`/`state`
2. **流式转发**：订阅 worker 的 `onStream`，将原始字节流写入客户端 socket
3. **重绘等待**：缓冲输出直到检测到完整帧（`VT_RESET` + `SET_TITLE_AND_ICON`），然后刷新缓冲区
4. **终端尺寸同步**：通过 `P.resizeForRepaint(cols, rows)` 按客户端尺寸重绘

**Kick 机制**：
- **Unix**：同一 `attachId` 只能有一个活跃连接，新客户端 attach 时旧连接收到 `EKICKED: Session opened in another window` 后被断开
- **Windows**：**所有**已连接客户端同时被 kick（`for(let t of P.attachers.values()) t.kick()`）
- 被 kick 的客户端可通过 FleetView 重新选择会话

### 关键数据结构

```js
// roster.json — daemon 的 worker 注册表
{
  proto: 2,
  supervisorPid: process.pid,
  updatedAt: Date.now(),
  workers: {
    [shortId]: {
      pid, procStart, sessionId,
      rendezvousSock, ptySock, messagingSock,  // 三个 UDS socket
      cliVersion, startedAt, cols, rows,
      dispatch, short, nonce, mode, ...
    }
  }
}
```

**三 Socket 架构**（每个 worker）：
- `rendezvousSock` — 会话握手/交接
- `ptySock` — PTY 字节流（终端 I/O）
- `messagingSock` — 结构化消息（权限请求、状态更新）

### FleetView TUI

`claude agents` 命令打开 FleetView 面板：
- 列出所有后台/活跃会话，按状态分组（working / review / blocked / done）
- 选择会话 → 全屏 attach → 实时查看对话内容
- `Ctrl+Z` 可 detach 回到 FleetView 列表
- `←`（左箭头）可在当前会话中打开 FleetView 并后台化当前会话
- 支持 `@mention`、`ctrl+t` 置顶、`ctrl+r` 重命名、`ctrl+s` 切换视图

### zy-code 现状

| 模块 | zy-code | 说明 |
|---|---|---|
| `src/daemon/main.ts` | ❌ 空桩 | `throw new Error('daemonMain not implemented')` |
| `src/daemon/workerRegistry.ts` | ❌ 空桩 | `throw new Error('runDaemonWorker not implemented')` |
| `src/cli/bg.ts` | ❌ 空文件 | `export {}` |
| Roster / 共享状态 | ❌ 无 | 无 roster.json 机制 |
| Control Socket (UDS) | ❌ 无 | 无 daemon ↔ client IPC |
| Rendezvous Server | ❌ 无 | 无会话交接服务器 |
| PTY 代理 | ❌ 无 | 无伪终端管理 |
| FleetView TUI | ❌ 无 | 无多会话管理面板 |
| Subscribe/Tail | 部分 | `SessionsWebSocket.ts`（远端 WebSocket 订阅），非本地 daemon |
| Worker Epoch | ✅ 已有 | `bridge/types.ts` 中 `workerEpoch` 字段（但用于 CCR 远端，非本地 daemon） |
| Scroll 位置 | ✅ Ink 层 | `src/ink/ink.tsx` 中有 `scrollPosition`（但仅为单终端内部滚动） |

### 实现此功能所需工作量

| 组件 | 估计工作量 | 优先级 |
|---|---|---|
| Daemon 进程（常驻后台，UDS 控制协议） | 高（2-3 周） | P1 |
| Roster（worker 注册表 + JSON 持久化） | 中（3-5 天） | P1 |
| PTY 管理（spawn worker in PTY，捕获字节流） | 高（1-2 周） | P1 |
| Attach/Kick 机制（多客户端连接 + 踢出） | 中（1 周） | P2 |
| Subscribe/Tail 流式转发 | 中（1 周） | P2 |
| FleetView TUI（会话列表面板） | 高（2-3 周） | P2 |
| Resize 同步 | 低（2-3 天） | P2 |
| Alt-screen handoff | 中（3-5 天） | P3 |

**总计**：约 6-10 周工作量，是一个完整的子系统。

---

## 二十四、zy-code 独有优势

以下能力为 zy-code 独有，CC 不具备或不如 zy-code：

### 1. 多 Provider 适配
- **文件**：`src/services/api/llmOrchestrator.ts`（2169 行）
- 支持 Anthropic / DashScope / OpenRouter / Generic 多 provider
- CC 仅支持 Anthropic（含 Bedrock/Vertex）

### 2. 分层模型系统
- advanced / standard / compact 三级模型配置
- CC 使用单一 model + fallback model

### 3. 多层压缩策略
- reactive compact + microcompact + cached microcompact + context collapse + API native context management
- 比 CC 更丰富的压缩层次

### 4. Prompt Cache Break Detection（688 行）
- 11 维状态追踪
- per-tool schema hash
- 自动 diff 生成
- 防误报机制（compaction/cacheDeletion）

### 5. Persistent Retry + Heartbeat
- `ZY_CODE_UNATTENDED_RETRY`：无人值守模式 429/529 无限重试
- 30 秒心跳保活（防止主机标记为空闲）
- 基于 `anthropic-ratelimit-unified-reset` header 精确等待

### 6. Tool Use Summary Generator
- **文件**：`src/services/toolUseSummary/toolUseSummaryGenerator.ts`
- 自动生成工具执行摘要标签（约 30 字符的单行描述）

### 7. Circuit Breaker
- `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`
- 防止不可恢复的上下文无限重试压缩

### 8. Context Collapse
- **目录**：`src/services/compact/contextCollapse/`
- 独立上下文折叠系统，90% 提交 / 95% 阻塞时激活
- `index.ts` + `operations.ts` + `persist.ts`

### 9. Cache-safe Forked Agent
- 压缩时复用主对话 prompt cache 前缀
- `runForkedAgent()` + `skipCacheWrite: true`

### 10. 其他独有特性
- Thinkback（回溯思考）
- Bughunter（自动 bug 检测）
- UltraPlan（高级计划模式）
- Insights（洞察分析）
- Advisor（顾问模式）
- Workflow（工作流）
- Schedule/Cron（定时任务）
- Teleport（瞬间迁移）
- AutoDream（自动记忆整合）

---

## 二十五、优先级建议

> **v2.1.177 更新**：根据 2.1.170-2.1.177 变更调整优先级

### P0（最高优先级）

| 缺失能力 | 实现复杂度 | 涉及文件 | 说明 |
|----------|-----------|---------|------|
| **Refusal Fallback** | 中 | `src/services/api/errors.ts` L1046 | 在 `getErrorMessageIfRefusal` 中添加 fallback model 切换逻辑，复用 `withRetry.ts` 中已有的 `FallbackTriggeredError` |
| **Streaming Watchdog Auto-retry** | 低 | `src/services/api/llmOrchestrator.ts` L1215 | watchdog abort 后自动重新建立流式连接重试 |
| **Non-streaming Fallback** | 中 | `src/services/api/llmOrchestrator.ts` | 流式 watchdog 触发后，回退到非流式请求 |

### P1

| 缺失能力 | 实现复杂度 | 涉及文件 | 说明 |
|----------|-----------|---------|------|
| **SGR Mouse Protocol** | 中 | `src/ink/` | 在 ink 层添加 SGR 鼠标事件支持 |
| **SYNCHRONIZED_UPDATE** | 低 | `src/ink/ink.tsx` | 添加 `\x1b[?2026h`/`\x1b[?2026l` 序列 |
| **DISABLE_MOUSE** | 低 | `src/ink/` | 添加 `ZY_CODE_DISABLE_MOUSE` 开关 |
| **Hooks 补齐** | 高 | `src/types/hooks/` | 补齐 13 种缺失 hook 事件 |
| **Auto Mode 分类器** | 高 | `src/utils/permissions/` | 三级规则 + 两阶段分类器 + sibling context + temperature |
| **Safe Mode** | 低 | `src/cli/` | 添加 `ZY_CODE_SAFE_MODE` + `--safe-mode` CLI flag，禁用部分功能 |
| 🆕 **Fable 5 模型配置** | 低 | `src/constants/` | 添加 Fable 5 模型能力声明和 model-capabilities 配置 |
| 🆕 **Sub-agent 嵌套** | 中 | `src/coordinator/` | 支持 sub-agent 自嵌套 spawn（maxDepth=5）— 注：zy-code 已有 `spawnMultiAgent.ts`，需确认是否已有深度限制 |
| 🆕 **enforceAvailableModels** | 中 | `src/tools/ConfigTool/` | 管理设置强制模型白名单 |
| 🆕 **disableBundledSkills** | 低 | `src/skills/` | 隐藏内置 skill/workflow/命令的环境变量和设置 |

### P2

| 缺失能力 | 实现复杂度 | 说明 |
|----------|-----------|------|
| **COLD_COMPACT** | 中 | 冷启动时自动压缩（session resume） |
| **DISABLE_PROMPT_CACHING_\<model\>** | 低 | 按模型维度 cache 开关 |
| **RETRY_WATCHDOG env** | 低 | `ZY_CODE_RETRY_WATCHDOG` 环境变量 |
| **缺失命令补齐** | 中 | `/scroll-speed`、`/stop`、`/recap`、`/fast` |
| **缺失工具补齐** | 中 | `NotebookRead`、`Cd` |
| **Daemon 进程** | 高 | 实现 `src/daemon/main.ts`，支持 daemon.lock + 冷启动优化 |
| **Session Resume 高级参数** | 中 | 补齐 `RESUME_FROM_SESSION`、`RESUME_PROMPT`、`RESUME_THRESHOLD_MINUTES`、`RESUME_TOKEN_THRESHOLD` |
| **ENABLE_BYTE_WATCHDOG** | 中 | 字节级流式看门狗（区别于时间级 watchdog） |
| **ENABLE_CRASH_REPORTING** | 中 | 崩溃自动报告机制 |
| 🆕 **Artifact 系统** | 中 | `ARTIFACT`/`ARTIFACT_AUTO_OPEN`/`ARTIFACT_DIRECT_UPLOAD` |
| 🆕 **wheelScrollAcceleration** | 低 | 鼠标滚轮加速开关设置项 |
| 🆕 **footerLinksRegexes** | 低 | 正则匹配 footer 链接徽章 |
| 🆕 **Plan Mode 增强** | 中 | `PLAN_MODE_REQUIRED`、`PLAN_MODE_INTERVIEW_PHASE`、`opusplan` 模型 |
| 🆕 **Agent-Team 设置补齐** | 低 | `isolatePeerMachines`、`autoUploadSessions` 设置项 |
| 🆕 **Cowork Plugin Authoring** | 中 | CC 有内置 skill 指导 Cowork 插件创作，zy-code 需补充 |
| 🆕 **多终端会话同步** | 极高 | Daemon + PTY Proxy + FleetView TUI（详见二十三C），约 6-10 周工作量 |

### P3

| 缺失能力 | 实现复杂度 | 说明 |
|----------|-----------|------|
| **Perforce VCS** | 中 | 企业级 VCS 支持 |
| **Plugin ZIP Cache** | 中 | 插件 ZIP 缓存机制 |
| **OTEL Metrics** | 中 | 完整 OpenTelemetry 集成 |
| **Container ID** | 低 | 远程环境标识 |
| **Script Caps** | 低 | 脚本能力限制 |

---

## 附录：CC 关键环境变量完整清单

> **v2.1.177 更新**：新增 20+ 个环境变量

| 环境变量 | 偏移量 | zy-code 对应 |
|----------|--------|-------------|
| `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` | `78316688` | `ZY_CODE_MAX_TOOL_USE_CONCURRENCY` ✅ |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `78312432` | `ZY_CODE_AUTO_COMPACT_WINDOW` ✅ |
| `CLAUDE_CODE_MAX_RETRIES` | `78316752` | `ZY_CODE_MAX_RETRIES` ✅ |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | `78316800` | `ZY_CODE_MAX_OUTPUT_TOKENS` ✅ |
| `CLAUDE_CODE_SCROLL_SPEED` | `78308576` | `ZY_CODE_SCROLL_SPEED` ✅ |
| `CLAUDE_CODE_EAGER_FLUSH` | `78317104` | `ZY_CODE_EAGER_FLUSH` ✅ |
| `CLAUDE_CODE_BUBBLEWRAP` | `78300768` | `ZY_CODE_BUBBLEWRAP` ✅ |
| `CLAUDE_CODE_AGENT_LIST_IN_MESSAGES` | `199910647` | `ZY_CODE_AGENT_LIST_IN_MESSAGES` ✅ |
| `CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP` | `78290800` 附近 | `ZY_CODE_DISABLE_PRECOMPACT_SKIP` ✅ |
| `CLAUDE_CODE_NO_FLICKER` | `78297740` | `ZY_CODE_NO_FLICKER` ✅ |
| `CLAUDE_CODE_COMMIT_LOG` | `78292700` | `ZY_CODE_COMMIT_LOG` ✅ |
| `CLAUDE_CODE_BRIEF` | `78312172` | `ZY_CODE_BRIEF` ✅ |
| `CLAUDE_CODE_BRIEF_UPLOAD` | `78312124` | `ZY_CODE_BRIEF_UPLOAD` ✅ |
| `CLAUDE_CODE_SYNTAX_HIGHLIGHT` | `78307740` | `ZY_CODE_SYNTAX_HIGHLIGHT` ✅ |
| `CLAUDE_CODE_TERMINAL_RECORDING` | `78291628` | `ZY_CODE_TERMINAL_RECORDING` ✅ |
| `CLAUDE_CODE_PERFETTO_TRACE` | `78291868` | `ZY_CODE_PERFETTO_TRACE` ✅ |
| `CLAUDE_CODE_SSE_PORT` | `78308140` | `ZY_CODE_SSE_PORT` ✅ |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `78314444` | `ZY_CODE_SUBAGENT_MODEL` ✅ |
| `CLAUDE_CODE_OVERRIDE_DATE` | `78310172` | `ZY_CODE_OVERRIDE_DATE` ✅ |
| `CLAUDE_CODE_STALL_TIMEOUT_MS_FOR_TESTING` | `78307866` | `ZY_CODE_STALL_TIMEOUT_MS_FOR_TESTING` ✅ |
| `CLAUDE_CODE_AUTO_MODE_MODEL` | `—` | `ZY_CODE_AUTO_MODE_MODEL` ✅ |
| `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK` | `78299344` | ❌ 缺失 |
| `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` | `78299616` | ❌ 缺失 |
| `CLAUDE_CODE_COLD_COMPACT` | `78300720` | ❌ 缺失 |
| `CLAUDE_CODE_RETRY_WATCHDOG` | `78316592` | ❌ 缺失 |
| `CLAUDE_CODE_DISABLE_MOUSE` | `78299744` | ❌ 缺失 |
| `CLAUDE_CODE_PERFORCE_MODE` | `78632160` | ❌ 缺失 |
| `CLAUDE_CODE_CLASSIFIER_SUMMARY` | `78312064` | ❌ 缺失 |
| `CLAUDE_CODE_CONTAINER_ID` | `78312016` | ❌ 缺失 |
| `CLAUDE_CODE_SAFE_MODE` | `79080012` | ❌ 缺失 |
| `CLAUDE_CODE_SUPERVISED` | `78307980` | ❌ 缺失 |
| `CLAUDE_CODE_DAEMON_COLD_START` | `78311980` | ❌ 缺失 |
| `CLAUDE_CODE_RESUME_FROM_SESSION` | `78308972` | ❌ 缺失 |
| `CLAUDE_CODE_RESUME_PROMPT` | `78308860` | ❌ 缺失 |
| `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES` | `78308796` | ❌ 缺失 |
| `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` | `78308732` | ❌ 缺失 |
| `CLAUDE_CODE_BG_CLASSIFIER_MODEL` | `78314956` | ❌ 缺失 |
| `CLAUDE_CODE_SLOW_OPERATION_THRESHOLD_MS` | `78316540` | ❌ 缺失 |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | `78312220` | ❌ 缺失 |
| `CLAUDE_CODE_BS_AS_CTRL_BACKSPACE` | `85689164` | ❌ 缺失 |
| `CLAUDE_CODE_RATE_LIMIT_TIER` | `78289004` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_AUTO_MODE_SIBLING_CONTEXT` | `110387776` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_AUTO_MODE_TEMPERATURE` | `96167968` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_ARTIFACT` | `78622784` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_ARTIFACT_AUTO_OPEN` | `78634432` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_ARTIFACT_DIRECT_UPLOAD` | `78622784` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_PLAN_MODE_REQUIRED` | `78619120` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE` | `78632096` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_PLAN_V` | `78631984` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_PROACTIVE` | `78618960` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_WORKFLOWS` | `83549856` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_ENABLE_TASKS` | `78620176` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_ENABLE_REMOTE_RECAP` | `78620288` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_ENABLE_DESIGN_SYNC` | `78620656` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_ENABLE_MENU_KIND_LANES` | `78620400` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_ENABLE_OPUS_4_7_FAST_MODE` | `78636672` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` | `78622032` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` | `78621040` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP` | `78636784` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_DISABLE_FAST_MODE` | `78636848` | ❌ 缺失 |
| 🆕 `CLAUDE_CODE_DISABLE_1M_CONTEXT` | `78636896` | ❌ 缺失 |

## 附录：CC 关键遥测事件偏移

| 遥测事件 | 偏移量 |
|----------|--------|
| `model_refusal_fallback` | `98778592`, `101415408` |
| `tengu_streaming_watchdog_retry` | `123508352` |
| `tengu_streaming_stale_connection_retry` | `123508080` |
| `tengu_nonstreaming_fallback_started` | `123508656` |
| `cli_nonstreaming_fallback_started` | `123508592` |
| `refusal-fallback` | `75179509`, `106108064` |
| `cache_hit` | `84823776` |
| `cache_miss` | `84823808` |
| `promptCache` | `78755536`, `82436736` |
| `PostToolBatch` | `78429783`, `90327600` |
| `PROMPT_CACHING` | `78294694`, `78294983` |

## 附录：v2.1.170 → v2.1.177 Changelog 摘要

以下变更来自 GitHub CHANGELOG.md（v2.1.177 的 CLI changelog 尚未发布）：

### 2.1.170 — Fable 5 发布
- 引入 **Claude Fable 5**：Mythos-class 模型，能力超过所有此前公开可用模型

### 2.1.172 — Sub-agent 嵌套 + Bedrock 改进
- **Sub-agents 可以 spawn 自己的 sub-agents**（最多 5 层深）
- Amazon Bedrock 从 `~/.aws` 配置文件读取 AWS region
- `/plugin` 浏览增加搜索栏
- OTEL metric 增加 `model` 属性
- 修复 1M 上下文无 usage credits 时永久卡住的问题
- 多项 `/model` picker 修复
- 减少空闲 CPU 占用（`/goal` status chip 不再 5Hz 刷新）

### 2.1.173 — Fable 5 模型名修复
- Fable 5 模型名 `[1m]` 后缀自动剥离（Fable 5 默认 1M 上下文）

### 2.1.174 — 滚动加速设置 + 多项修复
- **`wheelScrollAccelerationEnabled`** 设置项：禁用全屏模式鼠标滚轮加速
- `/model` picker 修复（Opus/Sonnet 行显示）
- Skill hot-reload 优化（仅重新发送变更的 skill）
- `/usage` 对话框增加用量归因（cache miss、sub-agent、per-skill 分解）

### 2.1.175 — 企业模型管控
- **`enforceAvailableModels`** 管理设置：`availableModels` 白名单约束 Default 模型
- 用户/项目设置不能再放宽管理级 `availableModels`

### 2.1.176 — 本地化 + Footer 链接 + 大量修复
- **Session titles 按对话语言生成**（设置 `language` 可固定语言）
- **`footerLinksRegexes`** 设置：正则匹配 footer 链接徽章
- Bedrock credential 缓存改进（使用 `Expiration` 而非固定 1 小时）
- `/fast` 拒绝切换到非白名单模型
- Hook `if` 条件修复（`Edit(src/**)`, `Read(~/.ssh/**)`, `Read(.env)` 正确匹配）
- `/copy` 和鼠标选择 copy 在 tmux over SSH 修复
- Remote Control 多项修复
- Background session 多项修复
