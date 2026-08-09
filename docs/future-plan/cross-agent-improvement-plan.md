# zy-code 跨 Agent 对标改进方案

> **日期**: 2026-08-08  
> **范围**: 启动时间、内存、运行时性能、Prompt 体系、功能能力  
> **对标对象**:
>
> | 项目 | 路径 | 栈 |
> |------|------|----|
> | grok-build | `E:\ProjectCollection\RustProjects\grok-build` | Rust workspace，TUI + leader 进程 |
> | codex | `E:\ProjectCollection\RustProjects\codex` | Rust（codex-rs）+ npm 包装 |
> | kimi-code | `E:\ProjectCollection\TSProjects\kimi-code` | TypeScript monorepo（agent-core） |
> | opencode | `E:\ProjectCollection\TSProjects\opencode` | TypeScript + effect + SQLite 事件溯源 |
> | pi | `E:\ProjectCollection\TSProjects\pi` | TS monorepo：pi-tui + agent-core + coding-agent + session SQLite 可选 |
> | Claude Code | `@anthropic-ai/claude-code@2.1.222` `claude.exe`（~267MB） | 闭源 bundle（extract-claude-internal） |
> | zy-code（现状） | 本仓库 | TypeScript + React/Ink + Bun |
>
> **相关已有文档**（避免重复实施）:
>
> - [`zy-code-compact-optimization-plan.md`](./zy-code-compact-optimization-plan.md) — 压缩栈专项
> - [`docs/architecture.md`](../architecture.md) — 当前架构地图
> - `src/services/api/promptCacheBreakDetection.ts` — 已有 prompt cache break 诊断
> - `src/services/mcp/toolResultStorage.ts` — 已有工具结果落盘

---

## 0. 执行摘要

zy-code 在 **功能广度** 上已接近 Claude Code：压缩多层级联（microcompact / snip / collapse / autocompact）、prompt cache 分层、tool schema 缓存、startupProfiler、MCP/Skills/Hooks/Agent 均已落地。真正的差距不在「有没有」，而在：

1. **启动路径仍偏串行**，关键资源（auth / model client / MCP / memory index）未做有超时回退的 prewarm。
2. **长会话成本与延迟** 尚未形成「后台预摘要 → 零等待 swap」闭环（CC 的 precomputed compact / grok 的 Prefire+two-pass）。
3. **上下文注入偏全量**：缺少 Codex 的 WorldState 增量 diff 与稳定 section 指纹。
4. **Prompt 工程化不足**：模板条件渲染与回归测试弱于 grok；动态区块抖动易打破 cache。
5. **会话持久化与可回溯** 停留在 JSONL + sidecar，未形成 opencode 级 epoch/事件投影。
6. **内存观感（Windows）**：任务管理器 RSS 虚高主因 Working Set 不归还，不应用周期 `Bun.gc` 治理；已改为空闲 trim。
7. **pi 补强（§13）**：UI/LLM 投影分离、steer/follow-up 双队列、compact cut 纪律与会话树导航是最高 ROI 交互/架构增量；**不**照搬「默认四工具 / 无沙箱 / 换 TUI」。

本方案按 **P0（可靠性/成本）→ P1（首感/时延）→ P2（体验/功能）→ P3（架构债）** 排序，给出可落地的模块、验收指标与阶段计划。  
压缩细节以既有 compact 专项文档为准，本文只钉跨系统优先级与集成点。

---

## 1. 对标矩阵（能力深度，非功能清单）

| 维度 | zy-code | Claude Code | grok-build | codex | kimi-code | opencode | 判断 |
|------|---------|-------------|------------|-------|-----------|----------|------|
| 快路径入口 / bare | ✅ `cli.tsx` version + feature DCE | ✅ SIMPLE/SAFE/bare | ✅ multi-entry + leader | ✅ multitool + arg0 | ✅ headless/shell 分叉 | 部分 | 持平 |
| 启动并行 + 超时降级 | 部分（prefetch 分散） | ✅ daemon cold start + bg prewarm | ✅ EarlyPrefetch 2s + bounded_connect | ✅ session/MCP/ws prewarm | ✅ worker + microtask 清理 | 弱 | **落后** |
| 启动观测 | ✅ startupProfiler | ✅ tengu_* phases | doctor / metrics | OTEL phase | startupTrace | 弱 | 领先–持平 |
| 强制 GC | ✅ 运行时无主动 GC；仅 heap dump 诊断 | 未见同等激进策略 | jemalloc | — | — | — | **已收敛** |
| 工具结果落盘 | ✅ toolResultStorage | 部分（skill 截断） | 有 | 有 | ✅ 50K + Read 引导 | 截断 2K | 持平–领先 |
| Microcompact | ✅ | ✅ time-based MC | intra/inter | — | 工具预算 | tool output max | 持平 |
| Context collapse | ✅ feature 门控在线（**保留，不对齐 CC 删除**） | ❌ 运行路径为死代码 | full-replace 为主 | 多策略 compact | full + media 降级 | anchored summary | **差异化** |
| Snip compact | ❌ **源码中已不存在**（旧文档过时） | 不存在 | — | — | — | — | 勿按旧方案恢复除非重开需求 |
| Precomputed / Prefire compact | ❌ | ✅ 完整生命周期遥测 | ✅ Prefire + two-pass + fingerprint | 双路径 compact | overflow 重试 | epoch reset | **关键缺口** |
| Rapid refill breaker | 部分（见 compact 文档） | ✅ ≤3 轮×3 次 | wall-clock budget | budget reminder | maxOverflow attempts | — | 应对齐 |
| Prompt static/dynamic 切分 | ✅ SYSTEM_PROMPT_DYNAMIC_BOUNDARY | ✅ 同构 | 模板+audience | base_instructions + fragments | system.md 模板 | 多 txt 组合 | 持平 |
| Prompt cache 诊断 | ✅ break detection | ✅ 1h / sharing / diagnostics | — | prefix 友好裁剪 | — | usage cache 字段 | 领先–持平 |
| 上下文增量注入 | ❌ 多为全量/memo | 部分 sticky betas | tool-guard 条件渲染 | ✅ **WorldState diff** | 动态 strip tool ctx | system-context reconcile | **关键缺口** |
| 媒体/413 恢复 | 弱 | media strip retry | — | — | ✅ 三态投影 | — | **落后** |
| 会话模型 | JSONL + sidecar | transcript + memory | JSONL + FTS + checkpoint | thread + agent graph | minidb | ✅ 事件溯源 + revert | 中期架构债 |
| Skills 路由 | skill-search | bundled + marketplace | Skill tool 信封 | BM25/RRF 多算法 | SKILLS 注入 | agent 配置 | 中 |
| Hooks 生命周期 | 较全 | 极全 | hooks crate | session/tool/compact/permission | Pre/PostCompact | 弱于 CC | 持平–略弱 |
| Sandbox / apply_patch | sandbox 服务 | bubblewrap 等 | sandbox crate | 极细粒度 + safety | — | permission 规则 | 按安全目标选学 |
| Daemon / 常驻 | daemon 目录存在 | cold start + bg prewarm burst | leader 进程 | — | — | control-plane | P2 |
| 输入队列 / steer | 部分 mailbox | — | prompt-queue merge | — | — | ✅ steer/queue/promote；**pi 双队列更完整** | **落后→P1** |
| UI/LLM 消息投影 | 弱（同构 Message + boundary） | 部分 | — | — | — | 事件投影；**pi convertToLlm** | **关键缺口** |
| 会话树 / 分支 | parent 链 + resume 修复 | transcript | checkpoint | thread | minidb | epoch/revert；**pi /tree** | **可加强** |
| Compact cut 纪律 | boundary + messagesToKeep | precomputed | two-pass | multi | — | anchored；**pi 禁切 tool_result** | 可学 cut |
| TUI 差分渲染 | Ink + VirtualMessageList | — | 自研 TUI | — | — | **pi line-diff+CSI2026** | P2 可选 |
| 工具并行执行 | 有限 | 有 | — | — | — | **pi parallel+sequential** | P2 |
| Subagent prompt 瘦身 | 部分 | coordinator extras | ✅ PromptAudience | collaboration mode | swarm reminder | agent 分型；pi 靠扩展 | 可加强 |

---

## 2. 现状锚点（zy-code 代码事实）

### 2.1 启动链

```
cli.tsx (version 零导入 / feature 快路径)
  → startupProfiler.cli_entry
  → main.tsx（模块顶层：MDM raw read、keychain prefetch）
  → Commander preAction：ensure MDM/keychain → init()
  → bootstrap/setup.ts：
       UDS messaging → worktree/tmux → hooks snapshot
       → initSessionMemory / initContextCollapse
       → MemoryMonitor + Win Working Set trim（无周期 Bun.gc）
       → 并行 prefetch: getCommands / loadPluginHooks / release notes
  → REPL / headless query
```

证据：

- `src/entrypoints/cli.tsx` — 动态导入与 `--version` 快路径
- `src/bootstrap/setup.ts` — MemoryMonitor + `initWinWorkingSetTrim`（无周期 GC）
- `src/services/telemetry/startupProfiler.ts` — `import_time` / `init_time` / `settings_time` / `total_time`

### 2.2 查询与压缩管线

```
queryLoop
  → preprocessMessages(toolResultBudget → microcompact → context-collapse)
  → runCompaction(autocompact)
  → queryModel (stream + stall watchdog + non-stream fallback)
  → withRetry / model chain failover
```

证据：`src/query/index.ts`、`src/query/preprocess.ts`、`src/services/compact/*`、`src/services/api/llm-orchestrator/queryModel.ts`。

### 2.3 Prompt

- 静态/动态边界：`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`（`constants/prompts.ts`）
- section memo：`systemPromptSection` / `DANGEROUS_uncachedSystemPromptSection`
- tool schema 会话缓存：`getToolSchemaCache()`
- cache break：`promptCacheBreakDetection.ts`（system/tools/betas/effort/extraBody 哈希）

### 2.4 已有护城河（不要回退）

1. Context Collapse 在线路径（CC 已停用运行路径；**zy 明确保留，不做对齐删除**）  
2. ~~Snip 确定性兜底~~（已不在树中，旧 compact 文档表述过时）  
3. Tool result 落盘 + GrowthBook 阈值覆盖  
4. Prompt cache break 可诊断 diff  
5. Rapid refill breaker（`autoCompact.ts` 已对齐 ≤3 轮×3 次）  
6. 多 provider 统一 `LLMAdapter` + model chain failover  
7. **内存治理**（2026-08）：去掉所有运行时主动 `Bun.gc`（含每秒/阈值策略）；Windows RSS 虚高只靠 Working Set trim；`Bun.gc` 仅保留 heap dump 诊断

---

## 3. 分域改进方案

### 3.1 启动时间与冷启动

#### 问题

- `setup()` 中 UDS / worktree 等仍可能挡住「可交互」时刻。
- 无「首 token 相关」的统一 prewarm 契约：auth、HTTP/2 连接、MCP 列表、memory 索引、tool schema 构建各自为战。
- bare/simple 路径已有，但默认交互路径模块图仍然偏重。
- Claude：`CLAUDE_CODE_DAEMON_COLD_START`、`tengu_bg_prewarm_burst*`、`prewarmMemoryIndex`。  
  Codex：`session_startup_prewarm`（tools + prompt + websocket，带 timeout 消费）。  
  grok：EarlyPrefetch 2s + bounded_connect。  
  kimi：worker 装索引、失败降级 inline、`unref` 防退出挂起。

#### 方案 A — Startup Critical Path 契约（P0）

定义两阶段：

| 阶段 | 必须完成 | 可后台 | 超时策略 |
|------|----------|--------|----------|
| TTI（可输入） | settings、cwd、基础 i18n、最小 command 表、Ink 首帧 | — | 同步尽量只做同步磁盘读 |
| TTFT（首 token） | auth 解析、主 model client 就绪、static system prompt 缓存键稳定 | MCP connect、plugin hooks、memory FTS、release notes、logo activity | 单项 1–3s，失败降级并在下一次 turn 补齐 |

落地：

1. 扩展 `startupProfiler` 阶段：`tti`、`auth_ready`、`client_prewarm`、`mcp_prewarm`、`memory_prewarm`、`first_query_start`、`first_token`。
2. 新增 `services/startup/prewarm.ts`（名称可调整）：
   - `scheduleStartupPrewarm(sessionCtx)`
   - `consumePrewarmForFirstTurn({ timeoutMs })`（codex 模式：`select` + timeout + cancel）
3. bare/headless：默认跳过 UDS、logo、release notes、交互 GC；明确 `unref` 所有定时器（学 kimi `finalizeHeadlessRun`）。
4. 将 `setup()` 内非 TTI 工作挪到 prewarm worker，禁止在 TTI 路径 `await` 网络。

**验收**

- 本机 warm FS：交互 TTI p50 < 400ms，p95 < 900ms（以 `ZY_CODE_PROFILE_STARTUP=1` 为准）。
- 首 query 在 prewarm 命中时，auth+client 准备 p50 < 50ms 额外开销。
- bare `-p` 退出无悬挂 handle（CI 60s 内必退出）。

#### 方案 B — 去掉运行时主动 GC，只留 Working Set trim（P0 ✅）

**结论（2026-08 实测）**：任务管理器里 RSS 虚高主要是 Windows Working Set 不主动归还可重载页；`Bun.gc` 对 RSS 几乎无效，周期/阈值主动 GC 只会增加抖动。

已落地：

1. 删除 `setup.ts` / `print.ts` 的每秒 `Bun.gc`，也不再引入阈值 smart GC。
2. Windows 仅保留 `winWorkingSetTrim`：持续空闲 + RSS 超阈值时 `EmptyWorkingSet`。
3. `Bun.gc(true)` **仅**保留在 `heapDumpService` 诊断前后对比路径。
4. 关闭：`ZY_CODE_DISABLE_WORKING_SET_TRIM=1`。

**验收**：默认路径无周期/阈值 GC；Windows 长会话空闲后任务管理器 RSS 可回落；非 Windows 不受 trim 影响。

#### 方案 C — Daemon / Leader 可选常驻（P2）

对标 grok leader、CC daemon cold start：

- 二次启动只 attach UDS/socket，复用已加载 plugin/command 索引与 TLS session。
- 必须：版本不匹配自动冷启；崩溃自愈；明确安全边界（不跨用户复用凭据内存）。

---

### 3.2 内存与长会话上下文

#### 问题

- 多层压缩已有，但 **触发时阻塞 turn**；CC/grok 用后台预计算消灭等待。
- 大 tool 输出虽可落盘，但 media/base64、413/overflow 恢复路径不如 kimi 三态投影完整。
- 压缩后 cost/usage 依赖 sidecar 重建（已知脆弱点）。
- 会话恢复缺少 epoch 概念，collapse/compact 交错时易产生「幽灵上下文」。

#### 方案 D — Precomputed / Prefire Compact（P0）

对标：

- CC：`tengu_precomputed_compact_*` 全生命周期（arm/ready/consumed/discarded/rehydrated…）
- grok：threshold 前 lead% 后台 pass-1；`fingerprint_prefix`；pass-2 只摘要 NOTE₁+tail

集成到现有栈（不重写 compact）：

```
token 使用率 ≥ armThreshold（如 compactThreshold - 20% window）
  → 后台 fork 摘要（skipCacheWrite / querySource=compact）
  → 缓存 { prefixHash, summary, createdAt, model }
turn 真正触发 compact
  → prefixHash 未变则 swap（零 LLM）
  → 变了则 discard 并走 reactive 路径
```

模块建议：

- `src/services/compact/precomputedCompact.ts`
- 与 `autoCompact.ts`、`reactiveCompact.ts`、`query/compaction.ts` 挂钩
- 遥测对齐 CC 事件名语义（可映射为 `zy_precomputed_compact_*`）

**验收**

- 长会话触达阈值时，≥70% compact 走预计算结果。
- 用户可感知 compact 阻塞 p50 < 300ms（命中预计算时）。
- prefix 在 precompute 后有新 user/tool 写入时 100% discard，无错摘要。

> 与 [`zy-code-compact-optimization-plan.md`](./zy-code-compact-optimization-plan.md) 合并实施；该文档含 CC prompt 与阈值常量，本文不重复粘贴。

#### 方案 E — Rapid Refill + Overflow 级联（P0）

1. 对齐 CC：压缩后 ≤3 轮再次触顶，连续 3 次 → breaker + 明确用户文案（大文件/大 tool 输出归因）。
2. 学 kimi：`maxOverflowCompactionAttempts`、媒体降级后再摘要、必要时按比例丢最旧组（0.7/0.5/0.35）。
3. 学 codex：ContextWindowExceeded 时 **从头裁剪保 prefix cache**，而非破坏 cache 的中段删除。

#### 方案 F — 工具/媒体三态投影（P1）

状态机（per message / per turn 投影，不改落盘真相）：

| 状态 | 发给模型的内容 | 触发 |
|------|----------------|------|
| normal | 原文或已落盘预览 | 默认 |
| degraded | 图片/二进制 → `[image]` / 路径标记 | prompt_too_long、media_too_large、413 |
| stripped | 仅保留 tool_use id + 文件路径指引 | degraded 仍溢出 |

恢复：下轮在预算允许时，可按需 Read 回填（不自动 bulk inflate）。

复用：`toolResultStorage.ts`、`microCompact.ts`；补 `mediaProjection.ts`。

#### 方案 G — 会话 Epoch / Compact 边界（P2）

学 opencode `context-epoch`：

- 每次成功 compact/collapse commit 递增 `contextEpoch`
- history 加载只取 epoch 基线之后 + 显式 baseline summary
- cost 计数器与 epoch 一起写入 transcript，减少 sidecar 单点

JSONL 可继续作为 WAL；中期可加 SQLite 投影（不必一上来 effect 全家桶）。

#### 方案 H — 内存产品能力（P2）

学 grok memory：

- session-end **零 LLM** 元数据保存（主题、文件触达、消息数），门槛如 `MIN_USER_MESSAGES>=3`
- `/flush` 或 auto-dream 走 LLM 深摘要
- memory index **启动 prewarm**（对标 `prewarmMemoryIndex`），查询路径禁止同步建索引

zy-code 已有 `session-memory` / `extract-memories` / `auto-dream`：重点是 **与 compact 编排联动**（pre-compact memory flush 作为护城河，见 compact 专项 §三）。

---

### 3.3 运行时性能（流式、重试、渲染、并发）

#### 方案 I — 流式韧性对齐 CC（P0/P1）

zy-code 已有 stall watchdog 与 non-stream fallback。补齐：

| 能力 | CC 遥测线索 | 动作 |
|------|-------------|------|
| stale connection retry | `tengu_streaming_stale_connection_retry` | 区分 idle stall vs TCP half-open，半开直接重连而非等满 idle |
| watchdog 后 summary | `tengu_streaming_stall_summary` | 聚合一次 turn 内 stall 次数/时长，避免日志噪音 |
| 529 streaming retry | `tengu_streaming_529_retry` | 与 `withRetry` / modelChainFailover 统一策略表 |
| malformed tool_use clean retry | `tengu_malformed_tool_use_*` | 校验失败时清洗 partial tool_use 再试，避免脏 transcript |
| media strip retry | `tengu_media_block_strip_retry` | 与方案 F 联动 |

**重试增量**：当前失败后全量重放。P1 评估对「仅连接层失败且已收齐 assistant 文本」跳过重放；工具已执行的 side effect 必须幂等或禁止静默重试。

#### 方案 J — Prompt / 连接 Prewarm 与 HTTP 复用（P1）

- 启动后后台建立主 provider HTTP 连接与 TLS（学 codex websocket prewarm、grok shared_http）。
- 首次 turn 前预构建：static system blocks、enabled tool schemas、默认 model 的 cache key。
- MCP：策略性预连「上次会话用过的 server」，其余 lazy（CC `tengu_mcp_stateless_skip_init` / discovery cache）。

#### 方案 K — 输入合并队列（P2）

学 grok `xai-prompt-queue` + opencode steer/queue：

- 用户连发短消息在模型未开始 tool 前可 merge 为单次 user turn
- agent 运行中：steer（插队提醒）vs queue（排到下一 turn）语义显式化
- UI 展示队列长度，避免「消息丢了」感

#### 方案 L — 渲染与 Ink（P2）

- 大 transcript：虚拟化窗口 / 消息分页已有基础则做 profiling；避免每 token 全树 reconcile。
- 工具折叠与 silent collapse（已有 future-plan）继续推进，降低长 agent 跑批时的终端写放大。
- 可选：CC 的 SYNCHRONIZED_UPDATE / 鼠标协议仅在 fullscreen 路径启用，默认安全关闭。

---

### 3.4 Prompt 体系

#### 方案 M — 稳定 Cache 前缀纪律（P0）

目标：提高 `prompt_cache_read` 命中率，降低 break 频率。

规则：

1. **Boundary 以左**只允许：角色、稳定工具使用约定、安全红线、稳定产品行为。  
2. **Boundary 以右 / user reminder**：时间、git status、AGENTS.md 可变段、session 专属、memory 挑选结果。  
3. Tool 列表排序稳定；MCP 工具增删用 sticky 策略或双段 cache（已有 globalCacheStrategy 线索）。  
4. 任何「看似无害」的 settings 改动若进入 static 前缀，必须先过 `promptCacheBreakDetection` 测试夹具。

工程：

- 固定 golden 测试：`bun test` 锁 static prompt hash（可按 model/feature flag 分快照）。
- CI 任务：diff PR 时报告 static 段 hash 是否变化。
- 扩展 break detection：采样写入 `zy_prompt_cache_break` 原因分布。

#### 方案 N — 条件模板与 Audience（P1）

学 grok：

- 工具段落必须 `if tools.by_kind.X` 包裹；单测组合渲染防漏变量。
- `PromptAudience: Primary | Subagent | Compact`：
  - Subagent：去掉 persona/catalog/大型技能目录
  - Compact 摘要器：空 memory、禁工具、专用 system（CC 已验证模式）

学 kimi compact-instruction：摘要可用 **第一人称交接便笺** 变体做 A/B（与现有 9 段 summary 并存，feature flag）。

学 opencode：anchored template 分段（Objective / Work State / Next Move / Relevant Files）可作为 SessionMemory 与 compact 的中间表示，便于增量更新 previous-summary。

#### 方案 O — WorldState 增量上下文（P1）

学 codex `WorldStateSection`：

```
Section { id, snapshot(), fingerprint(), render_diff(prev) }
每 turn：只把 fingerprint 变化的 section 注入为 <system-reminder> 或 contextual fragment
```

候选 section：

- git status（已有 memo，可改 diff）
- permissions mode
- plan mode / goal 状态
- MCP 连接集
- 当前 worktree / cwd
- date（低频）

**收益**：降 token、减 cache 抖动、降「模型被过期 git status 误导」。

#### 方案 P — Prompt 资产外置与校验（P2）

- 大段 prompt 继续 markdown/txt + 构建期纳入（grok `include_str` / kimi system.md）。
- 增加 size budget（grok ~16KB soft）与禁止裸 `${{` 泄漏测试。
- 不强制加密嵌入；开源仓库以清晰可审为主。

---

### 3.5 功能能力

#### 方案 Q — Skills 检索质量（P1）

zy-code 已有 skill-search。对标 codex multi-signal（BM25 + char-ngram + RRF）：

1. 描述字段与正文分字段计分  
2. 最近使用 boost  
3. 与当前 git 触达路径的轻量关联  
4. 遥测：展示/选用/后悔率（用户立即换 skill）

#### 方案 R — Hooks 覆盖空洞（P1）

对照 CC / codex 事件集，查缺：

- PreCompact / PostCompact 自定义 instructions（若未完全打通 user 配置）
- PermissionRequest 可脚本化决策
- SessionStart 与 env 快照时序（setup 里 UDS 已注意 hook 快照顺序，需回归测试）
- CwdChanged / FileChanged 防抖批量

#### 方案 S — 权限与安全工具链（P2）

若产品强调「可自动改代码」：

- 学 codex `apply_patch` + `assess_patch_safety` + sandbox policy 字符串（路径级 write/none）
- 学 opencode permission 三段：`allow | ask | deny`，`.env` 默认拒绝写
- 与现有 auto mode / yoloClassifier 统一决策表，避免多套话术

#### 方案 T — 多 Agent 图与协作模式（P2）

- codex：agent-graph-store + collaboration_mode 模板  
- grok：goal planner/tracker/evaluator、workflow  
- zy-code：已有 coordinator / swarm / goal  

改进点：子 agent 状态可恢复、permission 继承矩阵可配置、Explore/Plan 禁用工具集与 prompt audience 绑定（方案 N）。

#### 方案 U — 移植成熟工具实现（P3）

grok 明确 port 了 codex/opencode 工具并标注许可。zy-code 可对「稳定、协议清晰」的工具做受控移植（apply_patch 语义、monitor 流式 stdout），但必须：

- 许可证审计  
- 统一走 `tools/*` + `tool-runtime`  
- 禁止再增加兼容 re-export 垃圾路径（遵循 AGENTS.md）

---

## 4. 优先级总表

| ID | 项 | 来源启发 | 优先级 | 复杂度 | 预期收益 |
|----|----|----------|--------|--------|----------|
| A | Startup prewarm 契约 + profiler 阶段 | codex/grok/CC/kimi | **P0** | 中 | TTI/TTFT ↓ |
| B | 去掉运行时主动 Bun.gc，只留 Win Working Set trim | 实测债务 | **P0 ✅ 已落地** | 低 | setup/print/trim 无周期 GC；heap dump 可显式 GC |
| D | Precomputed compact | CC/grok | **P0** | 高 | 长会话卡顿 ↓、API 费 ↓ |
| E | Rapid refill + overflow 级联 | CC/kimi/codex | **P0** | 中 | 死循环压缩消失 |
| M | Cache 前缀纪律 + golden hash | CC/zy break detect | **P0** | 中 | cache 命中率 ↑ |
| I | 流式 stale/malformed/529 统一 | CC | **P0–P1** | 中 | 成功率 ↑ |
| F | 媒体/工具三态投影 | kimi/CC | **P1** | 中 | 413/过长恢复 |
| J | 连接与 schema prewarm | codex/grok | **P1** | 中 | TTFT ↓ |
| N | Audience + 条件模板 | grok/kimi | **P1** | 中 | subagent 成本 ↓ |
| O | WorldState 增量 section | codex | **P1** | 高 | token/cache 双赢 |
| Q | Skills 多信号检索 | codex | **P1** | 中 | 技能命中 |
| R | Hooks 空洞补齐 | CC/codex | **P1** | 中 | 可扩展性 |
| G | context epoch | opencode | **P2** | 高 | resume 正确性 |
| H | memory prewarm + 零 LLM session-end | grok/CC | **P2** | 中 | 跨会话质量 |
| K | prompt queue / steer | grok/opencode | **P2** | 中 | 输入体验 |
| L | 渲染虚拟化与写放大 | CC/现状 | **P2** | 中 | 长任务 UI |
| C | Daemon/leader 常驻 | grok/CC | **P2** | 高 | 二次启动 |
| S | patch safety + 权限矩阵 | codex/opencode | **P2** | 高 | 安全自动化 |
| T | agent 图恢复 | codex/grok | **P2** | 高 | 多代理可靠 |
| U | 工具移植审计 | grok | **P3** | 视项 | 功能补齐 |
| P | prompt 资产预算测试 | grok | **P3** | 低 | 可维护性 |
| V | UI/LLM 双投影 API（display vs hot） | **pi** + 冷热分离 | **P0–P1** | 中 | 正确性/省 token |
| K′ | Steer / Follow-up 双队列 | **pi** / grok/opencode | **P1** | 中 | 长任务输入体验 |
| W | Compact cut 纪律 + 文件 ops details | **pi** | **P1** | 中 | 摘要质量/不拆 tool |
| Z | 工具输出双 cap 截断统一 | **pi** truncate | **P1** | 低 | 内存/token |
| X | Project trust 门闩 | **pi** | **P2** | 中 | 安全启动 IO↓ |
| Y | 会话树导航 /tree | **pi** | **P2** | 高 | 可回溯 UX |
| L′ | fullscreen 同步输出/差分写 | **pi-tui** | **P2** | 中 | 闪烁/写放大 |

---

## 5. 分阶段路线图

### Phase 0 — 度量基线（1 周内）

1. 固定三台场景脚本：`zy --version`、`zy -p "ping"`、交互启动到可输入、长会话 200 轮 mock。  
2. 打开 `ZY_CODE_PROFILE_STARTUP=1` 采集；补充 first_token 埋点。  
3. 统计一周（或回放日志）`promptCacheBreakDetection` 原因 Top N、compact 耗时分布、RSS。  
4. **产出**：`docs/future-plan/metrics-baseline-2026-08.md`（数字，不作感觉）。

### Phase 1 — 可靠性与成本 P0（2–4 周）

顺序建议：

1. **B** GC 实验结论并改默认  
2. **M** static prompt golden + CI  
3. **E** rapid refill breaker + 裁剪保 cache  
4. **D** precomputed compact MVP（仅主会话、单 model）  
5. **A** prewarm 最小集：auth + HTTP client + static prompt  
6. **I** stale/malformed 与 failover 表对齐  

门禁：compact 专项测试 + `bun test` 相关套件全绿；`bun run format` && `bun tsc --noEmit`。

### Phase 2 — 体感与 token P1（3–5 周）

1. **F** 三态投影  
2. **J** MCP/memory 选择性 prewarm  
3. **O** WorldState 2–3 个高频 section 试点（git + permission + cwd）  
4. **N** Subagent/Compact audience  
5. **Q/R** skills 与 hooks  

### Phase 3 — 架构升级 P2（按产品节奏）

1. **G** epoch + cost 入 transcript  
2. 可选 SQLite 投影（读路径加速 / revert）  
3. **C** daemon attach  
4. **K/L/S/T** 按用户反馈排序  

---

## 6. 关键设计草图

### 6.1 Prewarm 消费（伪代码）

```ts
// services/startup/prewarm.ts
type PrewarmHandle = {
  auth: Promise<AuthMaterial>
  client: Promise<void>
  staticPrompt: Promise<SystemPromptBlocks>
  cancel: () => void
}

export function scheduleStartupPrewarm(ctx: SessionCtx): PrewarmHandle { /* spawn */ }

export async function consumePrewarmForFirstTurn(
  h: PrewarmHandle,
  timeoutMs = 1500,
): Promise<PrewarmResult> {
  // Promise.race + 超时后走同步兜底；超时不抛，只打点 zy_prewarm_timeout
}
```

### 6.2 Precomputed compact 状态机

```
Idle
  --(usage >= arm)--> Computing
Computing
  --(ok)--> Ready(prefixHash, summary)
  --(fail)--> Idle (backoff)
Ready
  --(prefix dirty)--> Discarded --> Idle
  --(compact trigger)--> Consumed --> Idle
  --(ttl exceed)--> Discarded
```

### 6.3 WorldState section

```ts
interface WorldStateSection<S> {
  readonly id: string
  snapshot(): S
  fingerprint(s: S): string
  renderDiff(prev: S | undefined, next: S): string | null // null = 不注入
}
```

---

## 7. 明确不做或缓做

| 项 | 原因 |
|----|------|
| 整栈迁 Rust / 重写为 effect | 成本与现有 Ink 生态不匹配；学模式即可 |
| 删除 Context Collapse 以「对齐 CC」 | CC 为死代码不代表 zy 方案错；改为健康度审计 |
| Prompt 加密嵌入 | 开源可审优先 |
| 启动阶段加载全部 MCP/插件 | 拖垮 TTI；改为 last-used / lazy |
| 无超时的无限 prewarm await | 首次失败会变成必现卡死 |

---

## 8. 风险与治理

1. **预计算摘要与线上 transcript 竞态**：必须以 prefixHash（或消息 seq 区间）校验；宁 discard 勿错用。  
2. **Cache 优化误伤正确性**：动态安全策略不得进入「过度 static」导致用户改权限不生效。  
3. **GC/内存实验平台差**：Win 的 working set 与 JSC heap 分离，结论要分平台。  
4. **AGENTS.md 约束**：无业务 IO 进 `utils/`；新模块进 `services/`；双语文案；相对导入 `.js`；改完 format + tsc + 相关 test。  
5. **闭源对标边界**：Claude 提取物仅作行为与协议参考，不复制商标/条文到用户可见品牌；prompt 大段引入需法律与归因评估。

---

## 9. 成功指标（建议写进发布门禁）

| 指标 | 基线 | Phase1 目标 | Phase2 目标 |
|------|------|-------------|-------------|
| 交互 TTI p50 | 待测 | -30% | -40% |
| 首 token 额外本地准备 p50 | 待测 | <50ms（命中 prewarm） | <30ms |
| Compact 用户等待 p50（触顶时） | 待测 | -60%（precompute） | -80% |
| Prompt cache break / 1k req | 待测 | -25% | -40% |
| Autocompact thrash 事件 | 待测 | ≈0（breaker） | 0 |
| 长会话 1h RSS 增长 | 待测 | 无异常 spiky GC | 平稳 + 可告警 |
| bare `-p` 挂起退出 | 偶发风险 | 0 | 0 |

---

## 10. 附录

### 10.1 Claude Code 与本方案强相关的信号（2.1.222）

**环境变量（节选）**  
`CLAUDE_CODE_DAEMON_COLD_START`、`CLAUDE_CODE_COLD_COMPACT`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`CLAUDE_CODE_SIMPLE`、`CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT`、`CLAUDE_CODE_SAFE_MODE`

**遥测（节选）**  
`tengu_precomputed_compact_*`、`tengu_auto_compact_rapid_refill_breaker`、`tengu_compact_cache_prefix`、`tengu_prompt_cache_break`、`tengu_streaming_watchdog_retry`、`tengu_streaming_stale_connection_retry`、`tengu_bg_prewarm_burst*`、`prewarmMemoryIndex`、`tengu_sysprompt_using_tool_based_cache`

**字面量锚点**  
`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`、`STREAM_IDLE_TIMEOUT`、`microcompact`

### 10.2 参考源码入口（本地）

| 项目 | 入口 / 关键文件 |
|------|----------------|
| grok-build | `crates/codegen/xai-grok-pager-bin`、`xai-grok-shell/.../compaction.rs`、`xai-grok-compaction`、`xai-prompt-queue`、`xai-grok-agent/src/prompt/` |
| codex | `codex-rs/cli`、`core/src/session/session.rs`、`session_startup_prewarm.rs`、`compact.rs`、`context/world_state/` |
| kimi-code | `apps/kimi-code/src/main.ts`、`packages/agent-core/src/agent/compaction/`、`tool-result-budget.ts` |
| opencode | `packages/opencode/src/index.ts`、`packages/core/src/session/compaction.ts`、`context-epoch.ts`、`session/input.ts` |
| pi | 见 **§13.7**（`coding-agent` compact/session/messages、`agent` loop、`tui` 差分渲染） |
| zy-code | `src/entrypoints/cli.tsx`、`src/bootstrap/setup.ts`、`src/query/*`、`src/services/compact/*`、`src/services/api/*` |

### 10.3 与既有 compact 专项的分工

| 主题 | 主文档 |
|------|--------|
| CC 压缩 prompt 全文、阈值常量、分组循环 | `zy-code-compact-optimization-plan.md` |
| 跨系统优先级、启动/内存/prompt/功能、路线图 | **本文** |
| 架构分层与目录法 | `docs/architecture.md`、`docs/development-guidelines.md` |

---

## 11. 建议的立即下一步

详细执行与进度见 **[`p0-execution-plan.md`](./p0-execution-plan.md)**（2026-08-09 起落地）。

1. ~~跑 Phase 0 基线~~ → 并行落地中  
2. **B** 无周期 GC ✅；**V/E/M/A** 与 **D 骨架**见 p0 计划进度表  
3. **D** 真实后台 fork arm 仍待接（consume 路径已接线，门控默认关）  
4. **I** 流式韧性后置  
5. **K′** steer/follow-up 属 P1，不阻塞 P0  

完成本文后，具体编码应拆 PR，避免「大爆炸」改动；每 PR 必须带前后 profiler 数字或失败对比。

---

## 12. 交互性能落地记录（2026-08）

聚焦**输入流畅 / 渲染 / 启动**，与 Working Set 虚高分开。

### 已落地

| 项 | 改动 | 预期 |
|----|------|------|
| 启动 TTI | `setup.ts` 不再 `await` `checkForReleaseNotes` / `getRecentActivity`（最多读 10 个 JSONL）；改为 fire-and-forget | 可输入时刻不再被 logo 附属 IO 挡住 |
| Logo 刷新 | `logoUtils.subscribeRecentActivity` + `Logo` `useSyncExternalStore` | 数据到位后补一次重渲，首帧允许空活动 |
| Bash ghost | 热缓存同步 `getShellHistoryCompletionSync`；冷缓存 50ms 防抖；`warmShellHistoryCache` 在 deferred prefetch | 连打 `!` 命令不再每键 await 扫 history |
| 启动观测 | `tti_ready` / `first_query_start` / `first_token` / `auth_ready` 检查点 | `ZY_CODE_PROFILE_STARTUP=1` 可量 |

### 现状已较强（本轮未重做）

- Ink：`FRAME_INTERVAL_MS=16` + throttle + fullscreen 滚动 drain
- 输入：PromptInput 多 stage 拆分、`React.memo`；命令 Fuse 按 commands 数组缓存
- 文件 `@` 建议：50ms debounce + 后台索引预热
- 消息：`VirtualMessageList` + `Messages` 自定义 memo（streaming 期间防抖重渲）
- 启动：commands 与 setup 可并行（无 worktree 时）

### 后续可选（未做）

- 长会话：逻辑层 collapse 仍 O(n)，与虚拟化无关的 JS 热成本
- 输入：超长 `displayedValue` 上多组 `find*Triggers` 仍每键 useMemo（通常短串可忽略）
- REPL 顶层 state：`inputValue` 在 ReplMainView；靠 Messages memo 挡消息区（可再 profiling 验证漏网 prop）

---

## 13. pi harness 对标补强（2026-08-09）

> 路径：`E:\ProjectCollection\TSProjects\pi`  
> 核心包：`packages/tui`（差分 TUI）、`packages/agent`（loop/session）、`packages/coding-agent`（CLI + compact + extensions）、可选 `packages/session-backends/sqlite-node`。  
> 哲学：**核心极简 + 扩展自生长**（默认四工具 read/write/edit/bash；子 agent/plan/MCP 多由 extension 提供）。zy 已偏「功能全家桶」，对标时**只学机制，不学砍功能**。

### 13.1 架构可学点

| 机制 | pi 做法 | zy 现状 | 建议落地 |
|------|---------|---------|----------|
| **UI vs LLM 投影** | `AgentMessage[]` →（可选 `transformContext`）→ `convertToLlm` → 仅 user/assistant/toolResult | 运行时多为同一 `Message` 数组；靠 `getMessagesAfterCompactBoundary` / sidechain 过滤 | **P0/P1**：固化「展示 transcript / 热 API 上下文」双视图 API（冷热分离已起步）；custom/bash/branch 类条目不得静默进 prompt |
| **会话树** | JSONL v2 `id`/`parentId`；`/tree` 就地换支、`/fork`/`/clone`；分支切换可 branch-summary | parentUuid 链 + compact_boundary；resume 断链已修；无一等公民 branch UI | **P2**：在现有 parent 链上暴露 tree 导航；切支可选摘要（学 `branch-summarization`） |
| **Compact cut** | `keepRecentTokens`（默认 20k）+ `reserveTokens`（16k）；**禁止切在 tool_result**；超长 turn **split-turn 双摘要**；累计 `readFiles`/`modifiedFiles` 写入 CompactionEntry | micro/auto/collapse 多层；messagesToKeep；file 追踪弱于 pi 结构化 details | **P1**：auto/partial cut 显式对齐「不拆 tool_use/result」；摘要 details 落盘文件列表供下一轮 iterative summary |
| **消息队列** | Enter=steering（本 turn 工具完交付）、Alt+Enter=follow-up（agent 全完）；`one-at-a-time` / `all` | `useCommandQueue` / mailbox 部分存在，语义对用户不够显式 | **P1**：统一 steer vs follow-up，状态栏显示队列长度；abort 回填编辑器 |
| **工具执行** | 默认 parallel；preflight 串行权限；`executionMode: sequential` 可抬升整批 | 工具循环偏顺序 | **P2**：只读类（Read/Grep/Glob）可并行批次，写工具仍串行+mutation queue |
| **扩展面** | `registerTool/Command` + 生命周期事件 + 可换 compact | Hooks/MCP/Skills 已全，但 UI shell 耦合 Ink | **P3**：保持现有能力；不必引入 pi 扩展运行时 |
| **权限** | 核心无沙箱；靠 container/trust 项目门 | sandbox + permission + auto mode | **不学削弱**；可学 **project trust 门闩**（未信任不加载项目级 settings/hooks） |

### 13.2 交互可学点

1. **双交付队列（steer/follow-up）** — 长 agent 跑批时用户最痛；直接提升「消息丢了吗」体感（补强方案 K）。  
2. **`/tree` + 标签书签** — 比单纯 MessageSelector 更适合「回到 compact 前某节点再开岔」。  
3. **工具/思考折叠快捷键**（pi：Ctrl+O / Ctrl+T）— zy 已有折叠基础，统一全局快捷键与 footer 提示。  
4. **`!!cmd` 排除 LLM 上下文** — 本地 shell 噪音默认不进 prompt；zy `!` bash 可对标。  
5. **Footer 指标**：cache read/write + 最近 cache hit + context % + cost — zy token/cost 条可合并为「一眼可扫」单行（降次要重渲）。  
6. **Compaction 后完整 JSONL 仍可 tree 回看** — 与 zy 冷热分离一致：**磁盘全量真相，LLM 只看热投影**；UI 永不单写 hot-only（本周已对齐）。

### 13.3 启动速度

pi：`main.ts` 参数解析 → settings/trust → `createAgentSessionServices` → mode；`PI_TIMING=1` 简易相位；`--offline` 关版本检查/telemetry；扩展可 `-ne` 跳过。

对 zy（叠加方案 A）：

| 学 pi | 动作 |
|-------|------|
| 失败可跳过的外围 | 版本检查、release notes、logo activity **永不挡 TTI**（部分已做） |
| trust 门闩 | 项目级 hooks/settings **先信任再执行**（安全+少 IO） |
| 精简默认路径 | bare/`-p` 跳过 Ink、UDS、扩展非必要装载（已有 headless；查漏 unref） |
| 观测 | 保持 `startupProfiler` 细阶段（已强于 pi timings）；补 `extension_load`/`session_open` |

**不建议**：为对齐 pi 而砍 MCP/Skills 默认集——产品定位不同；用 **last-used lazy** 代替「无扩展默认」。

### 13.4 运行时性能与内存

| 点 | pi | zy 建议 |
|----|-----|---------|
| TUI 写放大 | `previousLines` 行级差分 + CSI 2026 同步输出；alt-screen `ScrollView` 自管视口 | **P2**：Ink 路径继续 VirtualMessageList + memo；评估 fullscreen 是否启用 synchronized update；**不**重写为 pi-tui |
| 工具输出 | `truncate.ts`：行数 + 字节双 cap（默认 2000 行 / 50KB），不半行；大输出落路径 | 与 toolResultStorage 对齐双 cap 文案与「完整路径可 Read」 |
| Compact 摘要 LLM | 一次性摘要，**禁用 cache write**（一次性 prompt） | compact fork 统一 `skipCacheWrite` |
| 并行 tool | parallel + mutation 文件队列 | 读并行/写串行降低 wall time，不增加 RSS 峰值策略 |
| 会话后端 | JSONL 默认；SQLite 可选包 | 中期与方案 G 一致：JSONL WAL + 可选 SQLite 投影；resume 大文件继续 walkChain/cold-hot |
| 图片 | worker 缩放（image-resize-worker） | 大图/粘贴走 worker，避免卡 TTI/输入线程 |
| 内存 | 无激进 GC；依赖截断与紧凑 core | 维持 **无周期 Bun.gc + Win Working Set trim** |

### 13.5 与原优先级表合并的新增/升级项

| ID | 项 | 来源 | 优先级 | 说明 |
|----|----|------|--------|------|
| V | **UI/LLM 双投影 API**（display vs hot） | pi convertToLlm + 冷热分离 | **P0–P1** | 所有 query/compact/fork 只吃 hot；Messages/resume 吃 display |
| K′ | **Steer / Follow-up 双队列** | pi message queue | **P1**（原 K 升） | 显式快捷键 + 配置 delivery mode |
| W | **Compact cut 纪律 + 文件 ops details** | pi compaction | **P1** | 禁切 tool_result；split-turn；details 累加 |
| X | **Project trust 门闩** | pi trust.json | **P2** | 未信任不加载项目 hooks/settings |
| Y | **会话树导航 /tree** | pi session tree | **P2** | 基于 parentUuid；可选 branch summary |
| Z | **工具双 cap 截断统一** | pi truncate | **P1** | 与 storage 阈值单一配置源 |
| L′ | Ink 同步输出 / 差分写 | pi-tui CSI 2026 | **P2** | 仅 fullscreen；默认保守 |

### 13.6 明确不从 pi 照搬

| 项 | 原因 |
|----|------|
| 默认仅 4 tool、无内置 subagent/plan | zy 产品承诺更广；应 lazy 而非删除 |
| 无内置 permission/sandbox | 与 zy 安全目标冲突 |
| 换掉 React/Ink 上 pi-tui | 重写成本极高；学差分/视口语义即可 |
| 扩展二次实现 MCP/skills | zy 已有一等公民实现 |

### 13.7 参考入口（pi 本地）

| 主题 | 路径 |
|------|------|
| 启动 | `packages/coding-agent/src/main.ts`、`core/timings.ts` |
| 会话树/格式 | `docs/session-format.md`、`core/session-manager.ts` |
| Compact | `docs/compaction.md`、`core/compaction/compaction.ts` |
| LLM 投影 | `core/messages.ts` → `convertToLlm` |
| Agent loop / 队列 | `packages/agent/src/agent.ts`、`agent-loop.ts`；coding-agent README Message Queue |
| TUI 差分 | `packages/tui/README.md`、`tui-main-screen.ts` |
| 工具截断 | `core/tools/truncate.ts` |

---

## 14. 跨 Harness 特色功能总清单（产品/交互/机制，含非性能）

> 目标：把 **CC / grok / codex / kimi / opencode / pi** 的**优点与特有功能**一次性摊开，并标注 zy 已有 / 部分 / 缺失与建议优先级。  
> 性能向条目仍以 §3–§4、§13 为准；本节偏 **产品能力与可感知交互**。  
> 日期补记：2026-08-09。

### 14.1 Claude Code（行业基准；zy 大量已镜像）

| 功能 | 机制（一句话） | zy 状态 | 建议 |
|------|----------------|---------|------|
| **多 session 对话** | 独立 transcript/记忆；可并行多会话 | 会话文件 + resume/继续；产品层「多会话并排」弱于 CC 工作流 | P2 体验 |
| **SendMessage 主动互联** | agent/队友/远端 peer 主动推消息；可唤醒后台 task | ✅ `SendMessageTool` + mailbox + bridge 地址（`uds:`/`bridge:`） | 巩固 UX/发现性 |
| **Teammate / Swarm** | 队内角色、mailbox、权限同步、进程内/分 pane 后端 | ✅ `services/swarm/*`、Team*Tool、InProcessRunner、tmux/iTerm backend | 巩固 + 可测性 |
| **Bridge / Remote Control** | REPL 与远端会话桥接、peer 列表、capacity wake | ✅ `bridge/*`、`commands/bridge`、RemoteTrigger | 产品包装 |
| **Proactive / 后台主动** | 空闲或调度触发主动 turn（KAIROS 等） | ✅ `proactive/*` + feature 门控 | 体验打磨 |
| **Ultraplan** | 超长计划模式/关键词路由 | ✅ `services/ultraplan` + command | 体验 |
| **Coordinator 模式** | 主会话协调多 agent | ✅ `coordinator/*` | 巩固 |
| **Hooks 全生命周期** | Session/Tool/Compact/Permission 等 | ✅ 较全；Pre/PostCompact 用户扩展可再对齐 | P1 查缺 |
| **Daemon cold start + bg prewarm** | 常驻/冷启 + 后台 burst prewarm | 部分：`daemon/` 存在；默认交互路径未 attach | P2 |
| **Precomputed compact** | 阈值前预摘要，触顶零等待 swap | ❌ | **P0** |
| **Rapid refill breaker** | 压后连续触顶熔断 | ✅ 已对齐 autoCompact | 维持 |
| **流式韧性**（stale/529/malformed tool_use） | 专用重试与清洗 | 部分（stall watchdog 等） | P0–P1 |
| **Memory index prewarm** | 启动后台建索引 | 部分 session-memory | P2 |
| **SIMPLE/SAFE/bare 路径** | 轻量入口 | 部分 feature DCE / headless | 维持 |

**CC 独特性（相对其他开源 harness）**：多 session 协作 + SendMessage/Bridge 的「会话图」、Swarm 队友权限协议、Proactive 后台 agent 感——zy **代码面多已移植**，差距更在 **默认开启、引导、稳定性与可观测**，而非从零实现。

### 14.2 grok-build（Rust；规划/记忆/预压缩极强）

| 功能 | 机制 | 锚点（本地） | zy 状态 | 建议 |
|------|------|--------------|---------|------|
| **`/recap`（where was I）** | **只读**一句话回顾；复用 conversation prefix **保 prompt cache**；**不写入**对话；可 idle 自动 | `session/helpers/session_recap.rs`、`pager/.../recap.rs` | ❌ 无对等 slash | **P1 体验** |
| **Prefire + two-pass compact** | 阈值前 pass-1；fingerprint；pass-2 只压增量 | `xai-grok-compaction`、session compact | ❌（= precomputed） | **P0** |
| **Leader / workspace 常驻** | hub + session 协调、二次启动 attach | `xai-grok-workspace` | 部分 daemon | P2 |
| **Goal 子系统** | planner（fail-closed）/tracker/classifier/strategist/summarizer/stop | `session/goal_*.rs` | 部分 `goal/` + coordinator | P2 结构化 |
| **Checkpoint** | 会话/工作区快照恢复 | `session/checkpoint.rs` | 弱 | P2 |
| **Memory + session-end 元数据** | 零 LLM 门槛保存 + 深摘要 dream | memory tools / hooks | 部分 memdir/dream | P2 联动 compact |
| **Prompt queue merge** | 连发短消息合并 | `xai-prompt-queue` | 部分 mailbox | P1（并 K′） |
| **Hunk tracker** | 代码改动 hunk 精确追踪 actor | `xai-hunk-tracker` | ❌ | P3/体验 |
| **PromptAudience** | Primary / Subagent / Compact 裁剪 system | prompt 模板 | 部分 | **P1** |
| **子代理能力掩码** | ReadOnly/RW/Execute/All | task types | 部分 Agent 工具集 | P2 |
| **Monitor 流式 stdout** | 长命令监视 | monitor tool | 部分 MonitorTool | 体验 |
| **FTS 会话搜索** | JSONL + FTS | session storage | 弱 | P2 |

**grok 独特性**：**recap 保 cache 的展示摘要**、**Prefire 压缩**、**goal 失败封闭规划**、**hunk 级变更账本**。

### 14.3 codex（安全与上下文工程）

| 功能 | 机制 | zy 状态 | 建议 |
|------|------|---------|------|
| **WorldState 增量 section** | fingerprint + `render_diff`，只注入变化 | ❌ | **P1** |
| **session_startup_prewarm** | tools+prompt+ws，首轮 timeout 消费 | 部分分散 prefetch | **P0**（方案 A） |
| **apply_patch + assess_patch_safety** | 路径级 policy 字符串 | sandbox 有，细分弱 | P2 |
| **Collaboration mode 掩码** | default/plan/可见性等 mode 循环 | plan mode 有 | P2 |
| **Review mode** | 评审队列/提交预警 | `/review` 类有 | 体验对齐 |
| **Agent graph store** | 线程+图持久化 | Agent resume 部分 | P2 |
| **Skills BM25+RRF** | 多信号检索 | skill-search 部分 | P1 |
| **ContextWindow 从头裁保 cache** | overflow 时保 prefix | 部分 | P0 与 E 合并 |

**codex 独特性**：**WorldState**、**补丁安全评估粒度**、**启动 prewarm 契约**。

### 14.4 kimi-code（transcript 状态机 + 溢出韧性）

| 功能 | 机制 | zy 状态 | 建议 |
|------|------|---------|------|
| **独立 Transcript 包** | store/ops/view/pagination；会话可查询投影 | JSONL+map | P2 形态学 |
| **媒体/附件三态** | normal → degraded → stripped；字节不进主 transcript API | 弱 | **P1** |
| **Overflow compaction 级联** | maxAttempts + 比例丢组 0.7/0.5/0.35 | 部分 | **P0** E |
| **工具结果预算** | 50K + Read 引导 | toolResultStorage ✅ | 统一阈值 Z |
| **compact 第一人称便笺** | 交接摘要变体 A/B | 9 段 summary | P1 可选 |
| **Webbridge** | 浏览器/页面桥 skill | 无对等 | P3 |
| **Worker 索引 + unref** | 防 headless 挂起 | 部分 | P0 bare 退出 |
| **history foldFacts / groupTurns** | UI/历史折叠语义 | VirtualList 部分 | 体验 |

**kimi 独特性**：**附件与正文分离的 transcript 模型**、**溢出阶梯压缩**。

### 14.5 opencode（事件溯源 + 可控权限）

| 功能 | 机制 | zy 状态 | 建议 |
|------|------|---------|------|
| **Event sourcing + SQLite** | 事件表投影会话 | JSONL WAL | P2 G |
| **context-epoch** | compact 后 epoch++，加载基线化 | ❌ | **P2** |
| **snapshot / revert** | git 快照 + 快速回滚/diff | 弱 | P2 |
| **steer vs queue** | 插队 vs 排到下一 turn | 部分 | **P1** K′ |
| **permission 三段** | allow/ask/deny + ruleset；`.env` 默认拒写 | 部分 auto/permission | P2 |
| **apply_patch 工具** | 结构化补丁 | 无/弱 | P3 U |
| **anchored summary 模板** | Objective/Work State/Next/Files | 可学 | P1 N |

**opencode 独特性**：**epoch+revert 可回溯**、**权限规则矩阵产品化**。

### 14.6 pi（极简核 + 会话树 + 投影）

见 **§13**；摘要：

| 功能 | zy 状态 | 建议 |
|------|---------|------|
| convertToLlm 双投影 | 部分冷热 | **P0–P1 V** |
| steer/follow-up 双键 | 部分 | **P1 K′** |
| `/tree` `/fork` `/clone` | 链有、UI 弱 | P2 Y |
| compact cut + 文件 ops details | 部分 | **P1 W** |
| 工具双 cap 截断 | 部分 | P1 Z |
| project trust | ❌ | P2 X |
| 行差分 TUI + CSI 2026 | Ink | P2 L′ |
| extensions 换皮 | MCP/Skills 已有 | 不照搬 |

**pi 独特性**：**会话树一等公民**、**交付队列语义清晰**、**UI/LLM 类型层分离**。

### 14.7 zy-code 已具备的护城河（勿回退、少重复造）

- 压缩栈：microcompact / context-collapse（保留）/ autocompact / sessionMemoryCompact  
- Prompt cache break 诊断、tool schema 缓存、toolResultStorage  
- 冷热分离（UI display vs hot API）+ resume walk/repair（本分支）  
- TokenUsage camel 统一 + 磁盘迁移脚本  
- Swarm / SendMessage / Bridge / Proactive / Ultraplan / Goal / Coordinator / Daemon 目录  
- Ink VirtualMessageList、startupProfiler、Win Working Set trim（无周期 GC）  
- 多 provider LLMAdapter + model chain failover  

### 14.8 跨 harness「特色功能」总表（合并去重）

| ID | 功能 | 主要来源 | zy | 优先级 | 类型 |
|----|------|----------|-----|--------|------|
| D | Precomputed / Prefire compact | CC / grok | ❌ | **P0** | 成本/时延 |
| A | Startup prewarm 契约 | codex / grok / CC | 部分 | **P0** | 启动 |
| E | Overflow 级联 + rapid refill | kimi / CC / codex | 部分 | **P0** | 可靠性 |
| M | Cache 前缀纪律 + golden | CC / zy | 部分 | **P0** | 成本 |
| I | 流式 stale/529/malformed | CC | 部分 | **P0–P1** | 可靠性 |
| V | UI/LLM 双投影 API | pi + 冷热 | 部分 | **P0–P1** | 正确性 |
| REC | **`/recap` 只读回顾（保 cache）** | **grok** | ❌ | **P1** | **体验** |
| K′ | Steer / Follow-up 双队列 | pi / opencode / grok | 部分 | **P1** | 交互 |
| W | Compact cut 纪律 + 文件 details | pi | 部分 | **P1** | 压缩质量 |
| F | 媒体/工具三态投影 | kimi / CC | ❌ | **P1** | 可靠性 |
| O | WorldState 增量 | codex | ❌ | **P1** | token/cache |
| N | PromptAudience + 条件模板 | grok / kimi | 部分 | **P1** | 成本 |
| Z | 工具双 cap 截断统一 | pi / kimi | 部分 | **P1** | 内存 |
| Q | Skills 多信号检索 | codex | 部分 | **P1** | 功能 |
| R | Hooks 空洞补齐 | CC / codex | 较全 | **P1** | 扩展 |
| SM | SendMessage/Swarm/Bridge UX 打磨 | CC（zy 已有实现） | ✅ 代码 | **P1 产品** | 多会话 |
| PR | Proactive 默认可感知节奏 | CC（zy 已有） | ✅ 代码 | P2 产品 | 主动 |
| G | context epoch + 可选 SQLite | opencode | ❌ | **P2** | 架构 |
| Y | `/tree` 会话树导航 | pi | 部分 | **P2** | 交互 |
| X | Project trust 门闩 | pi | ❌ | **P2** | 安全/启动 |
| C | Daemon/leader attach | grok / CC | 部分 | **P2** | 启动 |
| H | session-end 零 LLM + memory prewarm | grok / CC | 部分 | **P2** | 记忆 |
| S | permission 矩阵 + patch safety | opencode / codex | 部分 | **P2** | 安全 |
| T | agent 图恢复 | codex / grok | 部分 | **P2** | 多代理 |
| CK | Checkpoint / git snapshot revert | grok / opencode | 弱 | **P2** | 可回溯 |
| HT | Hunk tracker | grok | ❌ | **P3** | 体验 |
| L′ | TUI 同步差分输出 | pi | 可选 | **P2–P3** | 渲染 |
| WB | Webbridge | kimi | ❌ | **P3** | 功能 |
| U | 工具移植（apply_patch 等） | grok / opencode | 视项 | **P3** | 功能 |

### 14.9 产品向「CC 多会话 / SendMessage」说明（避免重复造轮子）

zy **已有**：

- `SendMessageTool`：to = teammate / `*` / `uds:` / `bridge:`；结构化 shutdown/plan_approval  
- `services/swarm`：mailbox、权限协议、in-process 与 tmux/iTerm pane、team 文件  
- `bridge/*`：REPL bridge、remote、peerSessions、capacityWake  
- `proactive/*`、`ultraplan`、`coordinator`、`goal`  

**仍值得做的不是再写一套协议**，而是：

1. **可发现性**：slash/帮助/状态栏暴露「队友 / 远端 peer / 收件箱」。  
2. **多会话工作流**：同项目快速切换、并排关注（不等同再实现 bridge）。  
3. **idle `/recap` 或自动 recap 行**（学 grok）：**展示 only、不进 transcript**，prefix 保 cache——与 SendMessage **正交**。  
4. **队列语义**：主会话上 steer/follow-up（pi）与 swarm mailbox **分层**，避免两套「消息在路上」互相踩。

### 14.10 建议的「功能」落地切片（与性能 P0 并行可拆 PR）

| 切片 | 内容 | 依赖 |
|------|------|------|
| F1 | `/recap` + 可选 idle auto-recap（display-only，skipCacheWrite 可关） | 模型调用、i18n |
| F2 | Steer/Follow-up 双队列 + footer 队列长度 | PromptInput、query loop |
| F3 | SendMessage/Swarm 状态面板与 ListPeers 引导 | 现有 swarm/bridge |
| F4 | WorldState：git + permission + cwd 三个 section | prompt 组装 |
| F5 | `/tree` 最小：按 parentUuid 跳转 + fork 当前 leaf | session-storage chain |
| F6 | Precomputed compact MVP | compact 栈 |

---
