# 项目架构待改进点

> 最后更新：2026-06-02
> 基于当前仓库代码结构整理，列出仍值得处理的结构性问题。

## 已完成的改进（归档记录）

以下改进项已在 2026-05 ~ 06 完成：

- ~~顶层启动 root.ts 拆分~~ → `cli/assembly/` 已抽出 5 个模式模块
- ~~REPL.tsx 过重~~ → 6200 行已拆到 1338 行 + `screens/repl/` 26 个子模块
- ~~全局状态 state.ts 单体~~ → 已按域拆为 `bootstrap/state/{_core,session,cost,duration,model,scroll,tokens,apiTracking}.ts`
- ~~缺少架构导航图~~ → `docs/architecture-map.md` 已建立
- ~~文档与代码漂移~~ → AGENTS.md / architecture.md 已同步更新

---

## 1. QueryEngine 与 query loop 的职责边界可继续收敛

### 现状

- `QueryEngine.ts`（1215 行）负责会话级状态
- `query.ts`（1711 行）单轮 query loop，仍然中心化
- `query/` 目录已有 `config.ts` / `tokenBudget.ts` / `transitions.ts` / `stopHooks.ts` / `deps.ts`

### 问题

- `query.ts` 仍承载 prompt assembly、stream handling、tool execution、recovery 等多阶段逻辑
- 继续增长会让单轮执行链难以维护

### 改进方向

- 按 stage 拆为 `query/stages/{promptAssembly,modelRequest,streamHandling,toolExecution,recovery,continuation}.ts`
- 把 compact、预算控制、恢复逻辑改为更独立的 pipeline/stage

### 优先级

高

---

## 2. root.ts 继续瘦身

### 现状

- `cli/commands/root.ts` 仍有 ~3400 行
- `cli/assembly/` 已抽出 5 个模式，但 root.ts 中的 feature() 门控逻辑、MCP/插件/技能装载、参数解析仍然集中

### 改进方向

- 继续按 feature 门控抽取更多 assembly 模块
- 把 MCP/plugin/skill 装载抽到独立的 assembly 模块

### 优先级

中

---

## 3. Feature flag 过多，增加静态理解成本

### 现状

- root.ts 中有 14 个活跃的 `feature()` 门控
- 许多模块通过条件 `require()` 加载不同能力

### 问题

- 阅读代码时必须同时考虑"当前构建是否启用该能力"
- 调试和重构时容易遗漏某个变体路径

### 改进方向

- 将 feature flag 的入口尽量收敛到少数装配模块
- 为关键能力建立变体矩阵文档
- 对高频 feature 组合建立 smoke test

### 优先级

中

---

## 4. 扩展点统一治理

### 现状

- 同时存在 `commands/`、`tools/`、`plugins/`、`skills/`、`services/mcp/` 多套扩展机制
- `docs/architecture-map.md` §5 已建立选择速查表

### 问题

- 横切关注点（权限、可观测性、错误处理）在不同扩展面重复实现
- 运行期扩展能力强但认知模型分散

### 改进方向

- 抽象统一的 capability descriptor 或 registry 视图
- 统一扩展点的生命周期钩子、日志、权限、诊断模型

### 优先级

中

---

## 5. 服务层目录体量大，领域划分可再压实

### 现状

- `src/services/` 已有 60+ 子目录/文件
- 同属一个业务域的代码可能分散在 service、utils、hooks、tool 内

### 改进方向

- 对高复杂领域做 domain packing（如 memory/task/mcp/sandbox 内部再按子域收拢）
- 为每个核心域定义公开入口，减少横向直接穿透

### 优先级

低

---

## 6. utils/messages/api.ts 过重

### 现状

- `utils/messages/api.ts` 有 2715 行，是 messages/ 子模块中最大的

### 改进方向

- 按功能域再拆（plan 模板 / API 后处理 / 格式化）

### 优先级

低

---

## 建议落地顺序

1. 拆 `query.ts` 为 stages（最高 ROI，当前最影响日常开发的大文件）
2. 继续瘦身 `root.ts`（按 feature 抽 assembly）
3. 扩展点统一治理（需先稳定扩展面再做抽象）
4. 服务层 domain packing
