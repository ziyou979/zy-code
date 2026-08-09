# P0 执行计划（启动 / 压缩 / 双投影 / Cache / 流式）

> **日期**: 2026-08-09  
> **依据**: [`cross-agent-improvement-plan.md`](./cross-agent-improvement-plan.md) §3–4、§11、§13–14；[`zy-code-compact-optimization-plan.md`](./zy-code-compact-optimization-plan.md) P1.4  
> **范围**: V · A · E · M · D · I（按 ROI 与风险排序落地）  
> **门禁**: 每切片 `bun test`（相关）+ `bun tsc --noEmit` + `bun run format`

---

## 0. 目标与成功标准

| ID | 项 | 完成定义 |
|----|-----|----------|
| **V** | UI/LLM 双投影 API | 统一 `getDisplayMessages` / `getHotContextMessages` / `getLiveApiUsageMessages`；query preprocess 与 API/token 统计只走 hot；UI 不裁冷历史 |
| **A** | Startup prewarm | auth + HTTP preconnect 已接线；`auth_ready` / `client_prewarm` 检查点可测；不阻塞 TTI |
| **E** | Rapid refill + overflow | breaker 从 `autoCompact` **贯通**到 `runCompaction` tracking；熔断时用户可见文案；单测覆盖 |
| **M** | Cache 前缀 golden | `splitSysPromptPrefix` 静态段 hash 测试；boundary 顺序不回归 |
| **D** | Precomputed compact MVP | 新建 `precomputedCompact.ts`；arm/consume/prefix 校验；feature 门控；接 `autoCompactIfNeeded` |
| **I** | 流式韧性 | idle stall vs 半开区分、malformed tool_use 清洗（本阶段可后置，不阻塞 D） |

**非目标（本轮不做）**: 换 TUI、删 collapse、整栈 epoch/SQLite、steer 双队列（P1 K′）。

---

## 1. 现状锚点（代码事实）

| 能力 | 现状 | 缺口 |
|------|------|------|
| Hot 切片 | `getMessagesAfterCompactBoundary`（predicates）+ `tokens.ts` 内部 `forHotContext` | 未导出统一 API 名；调用方散落 predicates |
| Display | `Messages.tsx` 已不裁 boundary | 无具名 `getDisplayMessages` |
| Live usage | `messagesForLiveApiUsage` 私有 | 需导出，供测试与 statusline |
| Prewarm auth | `prefetch.ts` → `auth_ready` | 与 first turn 无 consume 契约（可后补） |
| HTTP preconnect | `apiPreconnect.preconnectAnthropicApi` 在 `init.ts` 已调 | 无 `client_prewarm` checkpoint；deferred prefetch 未二次确保 |
| Rapid refill | `autoCompact.ts` 算 `nextRapidCount` 可 trip | **`runCompaction` 丢弃 `rapidRefillBreakerTripped` 与 `consecutiveRapidRefills`** |
| Precomputed | 不存在 | 唯一纯新建 |
| Cache break | `promptCacheBreakDetection` + 测试 | 无 static **内容 hash** golden |
| 流式 | stall watchdog + 529 retry | stale 半开 / malformed tool_use 清洗弱 |

---

## 2. 执行顺序与并行

```
Phase P0-a（本迭代，可同 PR 或 2–3 PR）
  ├─ V 双投影模块 + 接线 preprocess/tokens
  ├─ E rapid refill 贯通 + 文案 + 测
  ├─ M splitSysPromptPrefix golden
  └─ A client_prewarm checkpoint + prefetch 挂钩

Phase P0-b
  └─ D precomputedCompact MVP（主会话 / feature 门控）

Phase P0-c（可穿插）
  └─ I 流式半开 + malformed 清洗
```

**依赖**: D 依赖 V 的 hot 入口稳定；E/M/A 与 V 可并行。

---

## 3. 切片设计

### 3.1 V — 双投影 API

**新文件** `src/services/session-storage/messageProjections.ts`（或 `src/services/messages/projections.ts`，选 messages 以免 session-storage 循环）：

```ts
/** UI / resume 滚动：完整 transcript，不按 compact_boundary 裁切 */
export function getDisplayMessages(messages: readonly Message[]): Message[]

/** API / compact / token 阈值：last compact_boundary 起（含 boundary） */
export function getHotContextMessages(messages: readonly Message[]): Message[]

/** statusline live usage：hot 内再去掉 summary+messagesToKeep 上的陈旧 usage 区 */
export function getLiveApiUsageMessages(messages: readonly Message[]): Message[]
```

实现：

- `getDisplayMessages` = `messages.slice()`（拷贝浅数组，保持不可变调用习惯）
- `getHotContextMessages` = 委托 `getMessagesAfterCompactBoundary`
- `getLiveApiUsageMessages` = 从 `tokens.ts` 抽出的 `messagesForLiveApiUsage` 逻辑（单处实现）

**改接线**:

| 文件 | 改动 |
|------|------|
| `tokens.ts` | 内部改用导出的 projection；对外 re-export hot/live 便于旧测试 |
| `query/preprocess.ts` | `getHotContextMessages` 替换直接 predicates |
| `Messages.tsx` | 注释指向 `getDisplayMessages`；可选调用以自文档化 |
| compact / context / btw 等 | **本迭代可选**：保留 predicates 导入（同语义），后续清理 |

**测试**: 扩展 `tests/utils/tokens.getDisplayContextUsage.test.ts` + 新建 `tests/services/messages/projections.test.ts`。

**验收**: API 路径消息必含 boundary 起；UI 全量；压缩后 `getDisplayContextUsage` 仍不回 900k。

---

### 3.2 E — Rapid refill 贯通

**问题**: `autoCompactIfNeeded` 返回 `rapidRefillBreakerTripped`，但 `runCompaction` 只解构 `compactionResult, consecutiveFailures`。

**改动**:

1. `query/compaction.ts`  
   - 解构 `rapidRefillBreakerTripped`  
   - 成功 compact 时写入 `consecutiveRapidRefills: next`（需 autoCompact 返回成功时的 rapid 计数，或在 tracking 上递增）  
   - trip 时：`updatedTracking.rapidRefillBreakerTripped`（可扩 `AutoCompactTrackingState`）+ yield 用户可见错误 assistant 消息  

2. `autoCompact.ts`  
   - 成功路径返回 `consecutiveRapidRefills: nextRapidCount`（非 trip 时累加，便于 tracking）  
   - 导出常量或错误码字符串供 i18n  

3. i18n `en`/`zh-CN`：`autoCompact.rapidRefillBreaker`  
   - 说明：上下文在压缩后反复快速撑满，可能因大文件/大 tool 输出；建议 /clear 或减少粘贴  

4. **测试** `tests/services/compact/rapidRefillBreaker.test.ts`：mock tracking 连续 rapid → wasCompacted false + flag。

**验收**: 连续 3 次「压后 ≤3 轮再满」不再无限 compact；UI 有文案。

---

### 3.3 M — Static prompt hash golden

**测试** `tests/services/api/systemPromptStaticHash.test.ts`:

- 用固定 `asSystemPrompt([...static blocks, BOUNDARY, ...dynamic])`  
- `splitSysPromptPrefix` → 静态 `text` 的 sha256  
- 断言：boundary 前内容进入 `shouldCache: true` 的 static 块；boundary 后进 dynamic  
- **不**对完整 `getSystemPrompt()` 跑集成（依赖 cwd/git/skills，不稳定）；锁 **切分语义 + 合成 fixture 的 hash 格式**

可选 helper：`hashStaticSystemPrompt(systemPrompt: SystemPrompt): string` 放 `cacheControl.ts` 或测试内。

**验收**: 误把 env/git 挪到 boundary 前 → 测试红。

---

### 3.4 A — Startup prewarm 收口

已有：`init.ts` 调 `preconnectAnthropicApi()`；`prefetch` 打 `auth_ready`。

**补**:

1. `apiPreconnect.ts`：preconnect 发起时/完成后 `profileCheckpoint('client_prewarm')`（profiler 未开则空操作）  
2. `prefetch.ts`：deferred 路径再 `void import('apiPreconnect').then(m => m.preconnectAnthropicApi())`（幂等 `fired`），确保「跳过完整 init 的路径」仍能暖连接  
3. `startupProfiler` 注释已含 `client_prewarm`，PHASE 可选加 `client_prewarm_time: [auth_ready, client_prewarm]`（无则仅本地 mark）

**验收**: `ZY_CODE_PROFILE_STARTUP=1` 日志出现 `client_prewarm`（在支持的启动路径）。

---

### 3.5 D — Precomputed compact MVP

**新** `src/services/compact/precomputedCompact.ts`：

状态机（§6.2）：

```
Idle → arm(token≥armThreshold) → Computing → Ready | Fail
Ready + prefix dirty → Discard
Ready + autoCompact trigger → Consume（零 LLM）→ Idle
```

字段：

```ts
type ReadyState = {
  status: 'ready'
  sessionKey: string
  prefixLeafUuid: string  // arm 时 messages 末条 uuid
  prefixHash: string      // 可选：leaf+length 简指纹
  result: CompactionResult
  model: string
  createdAt: number
}
```

规则：

- `skipCacheWrite` / querySource=`compact`  
- `consume`：`currentMessages` 在 prefixLeaf 之前与 arm 时一致（uuid 链），否则 discard  
- arm 后新消息：**不**并进预计算 summary（MVP 直接 discard 更安全；v2 再 messagesSince）  
- Gate：`isEnvTruthy(ZY_CODE_PRECOMPUTED_COMPACT)` 或 GrowthBook；无 cache 的 provider 默关  
- 遥测：`zy_precomputed_compact_arm|ready|consumed|discarded`

接线：`autoCompactIfNeeded` 在 `shouldCompact` 后先 `consumePrecomputed`；`shouldAutoCompact` 旁路里当 usage≥arm 且 Idle 时 `void arm...`（不阻塞）。

**测试**: 纯函数 messagesAlign + consume discard 路径，不真实打 LLM。

---

### 3.6 I — 流式（后置清单）

| 项 | 位置 | 说明 |
|----|------|------|
| 半开快重连 | `streamIdleWatchdog` / `queryModel` | 区别 idle stall |
| malformed tool_use | `withRetry` / normalize | 清洗 partial 再试 |
| 529 事件 | 已有重试 | 补聚合埋点即可 |

---

## 4. PR 拆分建议

| PR | 内容 | 风险 |
|----|------|------|
| **PR1** | 计划文档 + V + E + M + A | 中低 |
| **PR2** | D precomputed MVP + 测 | 中高 |
| **PR3** | I 流式 | 中 |

每 PR：相关 `bun test`、`bun tsc --noEmit`、`bun run format`。

---

## 5. 风险

1. **预计算错摘要**：必须 prefix 校验，宁 discard。  
2. **projection 循环依赖**：projections 只依赖 predicates + message 类型，不 import tokens。  
3. **rapid 计数重置**：成功 compact 后 `turnCounter=0`，并累加 `consecutiveRapidRefills`；非 rapid 成功清零 rapid 计数。  
4. **preconnect 与代理**：已有 skip 逻辑，勿强连。

---

## 6. 进度记录

| 日期 | 项 | 状态 |
|------|-----|------|
| 2026-08-09 | 本文档 | ✅ |
| 2026-08-09 | V 双投影 | ✅ `messages/projections.ts` + preprocess/tokens 接线 |
| 2026-08-09 | E rapid 贯通 | ✅ `runCompaction` 写入 tracking + i18n 文案 |
| 2026-08-09 | M golden | ✅ `systemPromptStaticHash.test.ts` |
| 2026-08-09 | A client_prewarm | ✅ preconnect checkpoint + deferred prefetch |
| 2026-08-09 | D precomputed | ✅ 骨架 + consume + **maybeArm 后台 fork**（门控默认关） |
| 2026-08-09 | I 流式 | ✅ stale keepalive 默认开 + malformed 有限重试 + idle 半开埋点 |
| 2026-08-09 | Y /tree | ✅ 最小切片：`rewind.aliases` 含 `tree`（完整树 UI 待做） |
| 2026-08-09 | hot 调用点清理 | ✅ context/compact/btw/rename/skillify/summarize/bridge/compact.ts |
| 2026-08-09 | tokens 去兼容层 | ✅ 删 `forHotContext`/`messagesForLiveApiUsage` 与 projections re-export |
| 2026-08-09 | 中间态清单 | ✅ 见本文 §7 |
| 2026-08-09 | 迁移收口 | ✅ auth→auth.json；usage camel；display/hot；compact 调度表；compat 删除日 |

---

## 7. 中间态 / 双轨清单（2026-08-09 扫描 → 迁移后）

> 准则：AGENTS「禁止未登记删除计划的兼容入口」。门控/协议边界的有意双轨不算债。

### 7.1 已收口（本轮彻底迁移）

| 项 | 结果 |
|----|------|
| **auth** | `saveApiKey` / `removeApiKey` 只写/清 **auth.json**；`getApiKeyFromConfigOrMacOSKeychain` 变为 **一次性迁移**（keychain/primary → auth.json 后清除 legacy）；`primaryApiKey` 类型 `@deprecated` + 删除日 2026-09-01；`clearAllAuthConfigApiKeys` |
| **usage camel** | `NonNullableUsage` / `EMPTY_USAGE` / `usageTracker` 子结构全 camel；`TokenUsage` 扩展 cacheCreation/cacheDeleted…；`anthropicUsageToStandard` wire→camel；消费方 forkedAgent/logging/query/microCompact 对齐 |
| **projections** | hot 实现权威在 `projections.ts`（`findLastCompactBoundaryIndex`）；`getMessagesAfterCompactBoundary` deprecated + 删除日；`Messages.tsx` 真调 `getDisplayMessages` |
| **compact 调度** | `autoCompact.ts` 顶注释唯一优先级表（precomputed → SM → sync；旁路 micro/reactive/collapse） |
| **controlMessageCompat** | 删除计划登记：不早于 2026-09-01，确认 iOS 无 requestId-only |
| **/tree** | `rewind.aliases` 含 `tree` |

### 7.2 仍为债（本轮未改行为面大项）

| 严重度 | 位置 | 说明 | 建议 |
|--------|------|------|------|
| **低** | model 解析旁路 | `resolvedModel` 半 VO | 热路径只传 ResolvedModel |
| **低** | sessionStorage 导入形状 | barrel vs 直引 | 定一种约定 |
| **低** | vtplus 文档 | 阶段标记弱 | 文档补已落地 API |
| **低** | predicates hot 壳 | 同语义 deprecated 函数仍在 | 2026-09-01 后删除 |
| **低** | primaryApiKey 磁盘字段 | 类型仍可解析旧 json | 2026-09-01 后从类型移除 |

### 7.3 有意双轨（不算债）

| 点 | 说明 |
|----|------|
| display / hot / liveApiUsage | 一份 transcript、三投影 |
| precomputed compact | `ZY_CODE_PRECOMPUTED_COMPACT` 默认关 |
| REACTIVE_COMPACT / CONTEXT_COLLAPSE | feature 宏 DCE |
| TokenUsage camel vs 历史 JSONL | 运行时不兼容；`scripts/migrate-token-usage-camel.ts` 离线迁 |
| API conversion snake wire | 仅 conversions/* |
| provider adapters | anthropic/openai/xai |
| `configured*` / `primaryApiKey` 类型保留 | 磁盘旧字段；primary 仅迁移读 |

### 7.4 建议后续

1. 2026-09-01：删 `getMessagesAfterCompactBoundary`、`primaryApiKey` 类型、评估 `controlMessageCompat`
2. 真树 UI（parentUuid）
3. ResolvedModel 热路径收口
4. 拆 `autoCompactIfNeeded` 为判定 / consume / SM / sync 函数（行为不变）
