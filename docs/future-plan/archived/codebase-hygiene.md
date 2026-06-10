# 代码卫生与规范治理

> 创建时间：2026-06-06
> 最后更新：2026-06-10
> 基于全项目系统性审计，覆盖跨文件重复、AGENTS.md 规范违规、类型安全。

---

## 已完成

### ~~1. `stopHooks.ts` 消除 as any~~ ✅

2026-06 完成。消除全部 13 行（18 处）`as any`。根因修复：`AggregatedHookResult.message` 从 `HookResultMessage` 拓宽为 `Message`，8 个文件级联修复。新增 `isHookAttachment()` 类型守卫。`StopHookInfo` 构造补全必填字段，移除死数据 `promptText`。

### ~~2. `query/` 英文注释翻译 + i18n~~ ✅

2026-06 完成。4 个文件共 36 处英文注释翻译为中文。用户可见通知文案 `Stop hook error occurred` 迁移到 i18n（`notification.stopHookError`）。`prevented continuation` 默认值因同时用于结构化数据和模型上下文，暂保持英文。

### ~~3. `utils/` 目录边界迁移~~ ✅

2026-06-07 完成。全部 10 个业务领域模块从 `utils/` 迁移到 `services/`，共 55,829 行，681 处外部引用通过 barrel re-export 零破坏。

| 模块 | 行数 | 外部引用 | 目标 |
|------|------|---------|------|
| `teleport.tsx` | 1,450 | 9 | `services/teleport/teleport.tsx` |
| `worktree.ts` | 1,432 | 18 | `services/worktree/worktree.ts` |
| `auth.ts` | 1,499 | 47 | `services/auth/auth.ts` |
| `ide.ts` | 1,429 | 25 | `services/ide/ide.ts` |
| `sessionStorage/` | 5,194 | 52 | `services/sessionStorage/` |
| `attachments.ts` | 3,638 | 16 | `services/attachments/attachments.ts` |
| `config.ts` | 1,678 | 125 | `services/config/config.ts` |
| `hooks/` | 9,108 | 54 | `services/hooks/` |
| `permissions/` | 8,754 | 202 | `services/permissions/` |
| `plugins/` | 19,647 | 133 | `services/plugins/`（合并入已有 3 文件） |

### ~~4. 循环依赖与 barrel 绕行修复~~ ✅

2026-06-07 完成。修复 `services/sessionStorage/project.ts` 循环依赖（通过 utils barrel 回环到自身）。28 个 services/ 文件从绕 utils barrel 改为直接引用 services/ 同级模块。删除 12 个无外部消费者的 `utils/hooks/` barrel 文件。

---

## 5. `utils/` 网络请求集中化

**不做** — `axios` 是项目标准 HTTP 库，各文件直接 import 合理。真正问题在目录边界（已解决）。

---

## 6. 全项目 `as any` 类型安全治理

### ~~P0 已完成（2026-06-10）~~ ✅

| 文件 | 原 | 现 | 方案 |
|------|----|----|------|
| `services/mcp/auth.ts` | 21 | 0 | 重定义 `SecureStorage` 接口（`read()/readAsync()/update()/delete()`），消除 `getSecureStorage() as any` |
| `cli/headless/controlLoop.ts` | 15 | 1 | 补全 `WireControlRequestInner` 缺失的 5 个 union members，`message.uuid` 用 `as UUID` 窄化；保留 1 处 MCP SDK transport 类型限制 |
| `services/tools/toolExecution.ts` | 14 | 0 | `assistantMessage.uuid` 用 `as UUID` 窄化，hook info 补全 `StopHookInfo` 必填字段，`toolResultEntry.message` 用结构化类型断言 |

附带修复：
- `services/secureStorage/types.ts` — `SecureStorage` 接口从 `get/set/delete(key)` 改为 `read/readAsync/update/delete()` 匹配实际实现
- `services/secureStorage/index.ts` — 移除 3 处 `as any`
- `services/secureStorage/fallbackStorage.ts` — 移除 8 处 `as any`（`read()/update()` 调用）
- `commands/logout/logout.tsx` — 移除过时的 `@ts-expect-error`
- `types/wire/control.ts` — 新增 `WireControlMcpAuthenticateRequest`、`WireControlMcpOAuthCallbackUrlRequest`、`WireControlMcpClearAuthRequest`、`WireControlGenerateSessionTitleRequest`、`WireControlAskSideQuestionRequest` 5 个接口

### 现状

项目中 `as any` 仍有 ~200 处（非测试文件）。P0 已完成，剩余密集分布在以下文件：

| # | 文件 | 次数 | 主要原因 |
|---|------|------|----------|
| 1 | `components/MessageRow.tsx` | 38 | Message 联合类型窄化不足 |
| 2 | `components/mcp/MCPSettings.tsx` | 27 | MCP config schema 动态性 |
| 3 | ~~`services/mcp/auth.ts`~~ | ~~21→0~~ | ~~✅ P0 已完成~~ |
| 4 | `services/api/conversions/openai.ts` | 16 | OpenAI SDK 类型桥接 |
| 5 | `query.ts` | 15 | ToolUseContext 字段动态构造 |
| 6 | `components/messages/SystemTextMessage.tsx` | 15 | 消息渲染类型窄化 |
| 7 | `components/messageActions.tsx` | 15 | 消息操作类型窄化 |
| 8 | ~~`cli/headless/controlLoop.ts`~~ | ~~15→1~~ | ~~✅ P0 已完成~~ |
| 9 | ~~`services/tools/toolExecution.ts`~~ | ~~14→0~~ | ~~✅ P0 已完成~~ |
| 10 | `cli/transports/ccrClient.ts` | 14 | CCR 协议消息类型 |
| 11 | ~~`services/secureStorage/fallbackStorage.ts`~~ | ~~13→6~~ | ~~✅ 附带修复（readAsync/name 保留）~~ |
| 12 | `services/telemetry/instrumentation.ts` | 12 | OpenTelemetry SDK 动态 patch |
| 13 | `services/plugins/loadPluginCommands.ts` | 12 | 插件 manifest 动态加载 |
| 14 | `services/mcp/xaaIdpLogin.ts` | 12 | IDP OAuth flow |
| 15 | `commands/insights.ts` | 12 | 分析数据动态结构 |

### 方案

#### ~~P0（高 ROI，改动集中，各半天）~~ ✅ 2026-06-10 完成

详见上方"P0 已完成"段落。

#### ~~P1 已完成 / 评估完毕（2026-06-10）~~

| 文件 | 原 | 现 | 结论 |
|------|----|----|------|
| `components/MessageRow.tsx` | 38 | 0 | ✅ 用 `RenderableMessage` 类型守卫和具体类型断言替代 `as any` |
| `components/messages/SystemTextMessage.tsx` | 15 | 15 | ⚠️ 全部是 Ink 框架 `BackgroundColor`/`Color` 类型不含 theme 颜色，SDK 限制保留 |
| `components/messageActions.tsx` | 15 | 1 | ✅ 1 处 Attachment 联合窄化限制保留 |
| `components/mcp/MCPSettings.tsx` | 27 | 27 | ⚠️ server 对象类型体系不统一（构造对象 vs ServerInfo 子类型），需重构 server 类型才能消除，超出 as any 治理范围 |
| `query.ts` | 15 | 15 | ⚠️ 全部来自 `feature()` 条件 `require()` 模式（`typeof import` 给出 Promise 类型而 require 同步），需项目级解决 |
| `services/api/conversions/openai.ts` | 16 | 16 | ✅ AGENTS.md §9 明确允许适配层 SDK 扩展字段 `as any`，不改 |

#### ~~P2 已完成 / 评估完毕（2026-06-10）~~

| 文件 | 原 | 现 | 结论 |
|------|----|----|------|
| `services/mcp/xaaIdpLogin.ts` | 12 | 0 | ✅ 受益于 SecureStorage 接口修复 |
| `services/secureStorage/fallbackStorage.ts` | 13 | 4 | ✅ readAsync 已移除；`name`/`delete` 返回值类型差异保留 |
| `services/telemetry/instrumentation.ts` | 12 | 12 | **保留不改** — OpenTelemetry SDK 动态猴子补丁 |
| `services/plugins/loadPluginCommands.ts` | 12 | 12 | 需 zod 校验插件 manifest，待做 |
| `commands/insights.ts` | 12 | 12 | 需定义分析数据结构类型，待做 |
| `cli/transports/ccrClient.ts` | 14 | 14 | 需定义 CCR 协议消息联合类型，待做 |
