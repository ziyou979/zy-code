# 代码卫生与规范治理

> 创建时间：2026-06-06
> 最后更新：2026-06-07
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

### 现状

项目中 `as any` 仍有 240+ 处（非测试文件）。密集分布在以下 15 个文件：

| # | 文件 | 次数 | 主要原因 |
|---|------|------|----------|
| 1 | `components/MessageRow.tsx` | 38 | Message 联合类型窄化不足 |
| 2 | `components/mcp/MCPSettings.tsx` | 27 | MCP config schema 动态性 |
| 3 | `services/mcp/auth.ts` | 21 | OAuth HTTP 响应体无类型 |
| 4 | `services/api/conversions/openai.ts` | 16 | OpenAI SDK 类型桥接 |
| 5 | `query.ts` | 15 | ToolUseContext 字段动态构造 |
| 6 | `components/messages/SystemTextMessage.tsx` | 15 | 消息渲染类型窄化 |
| 7 | `components/messageActions.tsx` | 15 | 消息操作类型窄化 |
| 8 | `cli/headless/controlLoop.ts` | 15 | SDK control message 缺联合类型 |
| 9 | `services/tools/toolExecution.ts` | 14 | 工具执行结果通用处理 |
| 10 | `cli/transports/ccrClient.ts` | 14 | CCR 协议消息类型 |
| 11 | `services/secureStorage/fallbackStorage.ts` | 13 | keytar native binding |
| 12 | `services/telemetry/instrumentation.ts` | 12 | OpenTelemetry SDK 动态 patch |
| 13 | `services/plugins/loadPluginCommands.ts` | 12 | 插件 manifest 动态加载 |
| 14 | `services/mcp/xaaIdpLogin.ts` | 12 | IDP OAuth flow |
| 15 | `commands/insights.ts` | 12 | 分析数据动态结构 |

### 方案

#### P0（高 ROI，改动集中，各半天）

| 文件 | 方案 |
|------|------|
| `services/mcp/auth.ts` (21) | 用 zod schema 校验 HTTP 响应体，infer 类型替代 `response.data as any` |
| `cli/headless/controlLoop.ts` (15) | 定义 `ControlMessage` 鉴别联合类型（`type` 字段作 discriminant） |
| `services/tools/toolExecution.ts` (14) | 复用 stopHooks.ts 已建立的 `Message` 联合窄化 + `isHookAttachment` 模式 |

#### P1（中 ROI，改动面较大，各 1-2 天）

| 文件 | 方案 |
|------|------|
| `components/MessageRow.tsx` (38) | 按 `msg.type` 分发到类型化子组件，提取 `renderMessage(msg: RenderableMessage)` 分发器 |
| `components/mcp/MCPSettings.tsx` (27) | 为 MCP server config 各变体定义联合类型 + 类型守卫 |
| `query.ts` (15) | 收窄 `ToolUseContext` 可选字段为 required；状态机 state 用鉴别联合 |
| `services/api/conversions/openai.ts` (16) | 定义 OpenAI ↔ 内部类型映射 adapter，用 `satisfies` 约束 |

#### P2（低 ROI 或无法消除）

| 文件 | 方案 |
|------|------|
| `services/secureStorage/fallbackStorage.ts` (13) | `as unknown as T` + 接口定义替代（native binding 限制） |
| `services/telemetry/instrumentation.ts` (12) | **保留不改** — OpenTelemetry 动态猴子补丁，第三方 SDK 限制 |
| `services/plugins/loadPluginCommands.ts` (12) | zod 校验插件 manifest + infer 类型 |
| `services/mcp/xaaIdpLogin.ts` (12) | 同 mcp/auth.ts 方案，zod 校验 IDP 响应 |
| `commands/insights.ts` (12) | 定义分析数据结构类型 |
| `components/messages/SystemTextMessage.tsx` (15) | 随 MessageRow.tsx 一并处理 |
| `components/messageActions.tsx` (15) | 随 MessageRow.tsx 一并处理 |
| `cli/transports/ccrClient.ts` (14) | 定义 CCR 协议消息联合类型 |

### 落地顺序

```
1. [P0] mcp/auth.ts — 半天，zod 校验 HTTP 响应
2. [P0] headless/controlLoop.ts — 半天，ControlMessage 联合类型
3. [P0] tools/toolExecution.ts — 半天，复用已有 Message 窄化模式
4. [P1] MessageRow.tsx — 1-2 天，渲染分发架构
5. [P1] MCPSettings.tsx — 1 天，config 联合类型
6. [P1] query.ts — 1 天，ToolUseContext 收窄
7. [P1] conversions/openai.ts — 1 天，类型映射 adapter
8. [P2] 其余文件 — 按需
```

### 注意事项

- `telemetry/instrumentation.ts` 的 12 处 `as any` 是 OpenTelemetry SDK 动态 patch 的固有限制，不应尝试消除
- `MessageRow.tsx`、`SystemTextMessage.tsx`、`messageActions.tsx` 三者共享相同的 Message 渲染类型问题，应作为一个整体处理
- P0 项与 P1 项之间无依赖，可并行推进
