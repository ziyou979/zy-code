# zy-code vs Claude Code v2.1.169 深度对比报告

> **分析日期**：2026-06-09
> **CC 二进制**：`/Users/zy979/.nvm/versions/node/v24.14.1/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` (212MB)
> **CC 构建时间**：2026-06-08 · git sha: eb44edf196
> **zy-code 源码**：`/Users/zy979/IdeaProjects/zy-code/src/`

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
21. [zy-code 独有优势](#二十一zy-code-独有优势)
22. [优先级建议](#二十二优先级建议)

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
| **`DreamTask`** | ❌ 缺失 | 后台 memory 整合任务事件 |

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

### CC 二进制偏移

| 关键词 | 偏移量 |
|--------|--------|
| `autoMode` | 多处 |
| `TWO_STAGE_CLASSIFIER` | 二进制中 |
| `soft_deny` / `hard_deny` | 二进制中 |
| `CLAUDE_CODE_CLASSIFIER_SUMMARY` | `78312064` |

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

### 缺失说明

1. **SYNCHRONIZED_UPDATE**：CC 使用终端同步更新协议（`\x1b[?2026h`/`\x1b[?2026l`）避免渲染闪烁
2. **SGR Mouse Protocol**：CC 支持 SGR 鼠标协议 + `CLAUDE_CODE_DISABLE_MOUSE` 开关

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
| `ENABLE_AWAY_SUMMARY` | 离开时生成摘要 | zy-code ✅ 有模块 `services/awaySummary.ts` |
| `ENABLE_BACKGROUND_PLUGIN_REFRESH` | 后台插件刷新 | — |
| `ENABLE_BETA_TRACING_DETAILED` | 详细 beta tracing | — |
| `ENABLE_BYTE_WATCHDOG` | 字节级看门狗 | — |
| `ENABLE_BYTE_WATCHDOG_BEDROCK` | Bedrock 字节看门狗 | — |
| `ENABLE_CFC` | CFC 功能 | — |
| `ENABLE_CRASH_REPORTING` | 崩溃报告 | ❌ 缺失 |
| `ENABLE_DATADOG` | Datadog 集成 | — |
| `ENABLE_DELEGATE_ACCESS_RIGHTS` | 委托访问权限 | — |
| `ENABLE_EXPERIMENTAL_ADVISOR_TOOL` | 实验性 Advisor 工具 | zy-code ✅ 有 Advisor |
| `ENABLE_EXPERIMENTAL_SHELL_BUILTINS` | 实验性 shell builtins | ❌ 缺失 |
| `ENABLE_FEEDBACK_SURVEY_FOR_OTEL` | OTEL 反馈调查 | — |
| `ENABLE_FINE_GRAINED_TOOL_STREAMING` | 细粒度工具流式 | — |
| `ENABLE_GATEWAY_MODEL_DISCOVERY` | 网关模型发现 | — |
| `ENABLE_LOCKLESS_UPDATES` | 无锁更新 | zy-code ✅ `installer.ts` L417-533 |
| `ENABLE_LSP_TOOL` | LSP 工具 | zy-code ✅ `tools/LSPTool/` |
| `ENABLE_MCP_LARGE_OUTPUT_FILES` | MCP 大输出文件 | — |
| `ENABLE_OUTLIER_DETECTION` | 异常检测 | — |
| `ENABLE_PID_BASED_VERSION_LOCKING` | PID 版本锁 | — |
| `ENABLE_PROMPT_SUGGESTION` | Prompt 建议 | — |
| `ENABLE_PUSH` | 推送能力 | — |
| `ENABLE_SDK_FILE_CHECKPOINTING` | SDK 文件检查点 | — |
| `ENABLE_SESSION_BACKGROUNDING` | 会话后台化 | — |
| `ENABLE_SESSION_PERSISTENCE` | 会话持久化 | — |
| `ENABLE_STREAM_WATCHDOG` | 流式看门狗 | zy-code ✅ 有 streaming watchdog |
| `ENABLE_STRICT` | 严格模式 | — |
| `ENABLE_TOKEN_USAGE_ATTACHMENT` | Token 用量附加 | — |

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
| `CLAUDE_CODE_BG_CLASSIFIER` | `78314956` | 后台分类器模型 |
| `CLAUDE_CODE_SLOW_OPERATION_THRESHOLD` | `78316540` | 慢操作阈值(ms) |
| `CLAUDE_CODE_REPOSITORY_CHECKOUTS` | `78309020` | 仓库 checkout 路径 |
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

---

## 十六、缺失命令

| CC 命令 | 类型 | 说明 |
|---------|------|------|
| `/ultrareview` | local-jsx | 深度代码审查 |
| `/schedule` | local-jsx | 定时任务调度 |
| `/remote-control` | local | 远程控制连接管理 |
| `/scroll-speed` | local | 滚动速度配置 |
| `/fast` | local | 快速模式切换 |
| `/stop` | local | 停止当前任务 |
| `/recap` | local | 会话摘要回顾 |
| `/team-onboarding` | prompt | 团队引导 |
| `/usage-credits` | local-jsx | 用量额度查看 |
| `/extra-usage` | local-jsx | 额外用量申请 |

---

## 十七、缺失工具

| CC 工具 | 说明 | CC 偏移 |
|---------|------|---------|
| `NotebookRead` | Jupyter Notebook 读取 | `200147971`, `204717129` |
| `Cd` | 切换工作目录 | `200148001` |
| `TodoRead` | 只读查看 Todo 列表 | 二进制中 |
| `Brief` | 简洁模式工具 | `203800538` |
| `PushNotification` | 推送通知 | `203780706`, `208925637` |
| `RemoteTrigger` | 远程触发器 | `208915582` |
| `SendUserFile` | 发送用户文件 | `203803406` |
| `REPL` | 交互式 REPL | `203812283`, `208830484` |
| `Monitor` | 系统监控 | `203782859`, `204713159` |
| `ToolSearch` | 工具搜索 | `203800281`, `209081881` |

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
| **Perforce VCS** | ✅ `CLAUDE_CODE_PERFORCE` | ❌ 缺失 |
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

## 二十一、zy-code 独有优势

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

## 二十二、优先级建议

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
| **Auto Mode 分类器** | 高 | `src/utils/permissions/` | 三级规则 + 两阶段分类器 |
| **Safe Mode** | 低 | `src/cli/` | 添加 `ZY_CODE_SAFE_MODE` + `--safe-mode` CLI flag，禁用部分功能 |

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
| `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK` | `78299344` | ❌ 缺失 |
| `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` | `78299616` | ❌ 缺失 |
| `CLAUDE_CODE_COLD_COMPACT` | `78300720` | ❌ 缺失 |
| `CLAUDE_CODE_RETRY_WATCHDOG` | `78316592` | ❌ 缺失 |
| `CLAUDE_CODE_DISABLE_MOUSE` | `78299744` | ❌ 缺失 |
| `CLAUDE_CODE_PERFORCE` | `78310112` | ❌ 缺失 |
| `CLAUDE_CODE_CLASSIFIER_SUMMARY` | `78312064` | ❌ 缺失 |
| `CLAUDE_CODE_CONTAINER_ID` | `78312016` | ❌ 缺失 |
| `CLAUDE_CODE_SAFE_MODE` | `79080012` | ❌ 缺失 |
| `CLAUDE_CODE_SUPERVISED` | `78307980` | ❌ 缺失 |
| `CLAUDE_CODE_DAEMON_COLD_START` | `78311980` | ❌ 缺失 |
| `CLAUDE_CODE_RESUME_FROM_SESSION` | `78308972` | ❌ 缺失 |
| `CLAUDE_CODE_RESUME_PROMPT` | `78308860` | ❌ 缺失 |
| `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES` | `78308796` | ❌ 缺失 |
| `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` | `78308732` | ❌ 缺失 |
| `CLAUDE_CODE_BG_CLASSIFIER` | `78314956` | ❌ 缺失 |
| `CLAUDE_CODE_SLOW_OPERATION_THRESHOLD` | `78316540` | ❌ 缺失 |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | `78312220` | ❌ 缺失 |
| `CLAUDE_CODE_BS_AS_CTRL_BACKSPACE` | `85689164` | ❌ 缺失 |
| `CLAUDE_CODE_RATE_LIMIT_TIER` | `78289004` | ❌ 缺失 |
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
