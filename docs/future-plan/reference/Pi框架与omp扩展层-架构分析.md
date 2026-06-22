# Pi 框架与 omp 扩展层 — 架构关系与可扩展性分析

> Pi 是底层 Agent 框架（核心引擎），omp (Oh My Pi) 是构建在 Pi 扩展 API 之上的增强层。本文重点分析 Pi 提供了哪些扩展接口，omp 如何利用这些接口实现功能，以及这种分层架构的设计思想。

---

## 目录

1. [Pi vs omp：一句话区分](#1-pi-vs-omp一句话区分)
2. [Pi 框架的包结构与职责边界](#2-pi-框架的包结构与职责边界)
3. [Pi 框架内置的核心能力](#3-pi-框架内置的核心能力)
4. [Pi 的扩展 API 设计](#4-pi-的扩展-api-设计)
5. [扩展发现与加载机制](#5-扩展发现与加载机制)
6. [ExtensionRunner：扩展运行时](#6-extensionrunner扩展运行时)
7. [Hook 系统：行为拦截与修改](#7-hook-系统行为拦截与修改)
8. [自定义工具 API](#8-自定义工具-api)
9. [自定义命令 API](#9-自定义命令-api)
10. [工具拦截（Tool Wrapping）](#10-工具拦截tool-wrapping)
11. [权限与审批系统](#11-权限与审批系统)
12. [omp 如何利用 Pi 的扩展 API](#12-omp-如何利用-pi-的扩展-api)
13. [Swarm Extension：多 Agent 协作的扩展范例](#13-swarm-extension多-agent-协作的扩展范例)
14. [Pi 内置 vs omp 扩展：完整对照表](#14-pi-内置-vs-omp-扩展完整对照表)
15. [设计启示：框架与扩展的分层哲学](#15-设计启示框架与扩展的分层哲学)

---

## 1. Pi vs omp：一句话区分

- **Pi**（`@oh-my-pi/pi-coding-agent`）是**底层 Agent 框架**——提供模型调用、工具系统、会话管理、编辑引擎、TUI 渲染等核心能力，以及一套完整的 Extension API
- **omp**（Oh My Pi）是**构建在 Pi 之上的扩展/配置集合**——通过 Pi 的 Extension API 注册自定义工具、命令、Hook、MCP 桥接等，实现 Swarm 多 Agent 编排、额外工具集、用户配置等增强功能

类比关系：

```
Pi ≈ Chrome 浏览器引擎
omp ≈ Chrome 扩展商店中的一组扩展
```

或者：

```
Pi ≈ VS Code 编辑器核心
omp ≈ VS Code Extension Pack（一组精选扩展的集合）
```

用户安装的是 omp（因为它包含了 Pi + 扩展），但底层运行的是 Pi 框架。

---

## 2. Pi 框架的包结构与职责边界

### 2.1 核心包

```
packages/
├── coding-agent/          ← @oh-my-pi/pi-coding-agent（主入口）
│   ├── src/cli/           ← CLI 参数解析、入口
│   ├── src/session/       ← AgentSession 会话管理
│   ├── src/tools/         ← 内置工具（read/write/edit/bash...）
│   ├── src/task/          ← Task Delegation 内置功能
│   ├── src/plan-mode/     ← Plan Mode 内置功能
│   ├── src/config/        ← Settings Schema、ModelRegistry
│   ├── src/prompts/       ← 系统提示词模板
│   ├── src/extensibility/ ← ★ Extension API（扩展系统）
│   │   ├── extensions/    ← ExtensionRunner、ExtensionToolWrapper
│   │   ├── custom-tools/  ← CustomToolAdapter、CustomToolLoader
│   │   ├── hooks/         ← Hook 类型定义
│   │   └── plugins/       ← MarketplaceManager
│   └── src/modes/         ← Interactive/RPC/Print/ACP 模式
│
├── ai/                    ← @oh-my-pi/pi-ai（AI 模型层）
│   ├── 模型注册与发现
│   ├── OAuth 认证
│   ├── 流式事件处理
│   └── Schema 归一化
│
├── agent-core/            ← @oh-my-pi/pi-agent-core（Agent 运行时）
│   ├── Agent Loop
│   └── Transport 抽象
│
├── tui/                   ← @oh-my-pi/pi-tui（终端 UI）
│
├── natives/               ← @oh-my-pi/pi-natives（Rust N-API 绑定）
│   ├── shell（嵌入式 bash）
│   ├── grep（并行正则搜索）
│   ├── ast（tree-sitter）
│   └── fs_cache（文件缓存）
│
├── utils/                 ← @oh-my-pi/pi-utils（共享工具）
│
└── swarm-extension/       ← ★ @oh-my-pi/swarm-extension（omp 扩展）
    └── 多 Agent 协作编排
```

### 2.2 依赖关系

```
                   omp 扩展层
                ┌─────────────┐
                │   swarm-    │
                │  extension  │
                └──────┬──────┘
                       │ 使用 Extension API
        ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ─ 扩展边界
                       │
                ┌──────▼──────┐
                │  coding-    │  ← Pi 框架主入口
                │   agent     │
                └──┬───┬───┬──┘
                   │   │   │
          ┌────────┘   │   └────────┐
          ▼            ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │   pi-ai  │ │  agent-  │ │ pi-      │
    │ (模型层)  │ │  core    │ │ natives  │
    └──────────┘ └──────────┘ └──────────┘
          │                         │
          ▼                         ▼
    ┌──────────┐              ┌──────────┐
    │ pi-utils │              │ pi-tui   │
    └──────────┘              └──────────┘
```

---

## 3. Pi 框架内置的核心能力

以下功能**直接内置于 Pi 框架**，不依赖任何扩展：

### 3.1 内置工具（Built-in Tools）

| 工具 | 实现位置 | 功能 |
|------|---------|------|
| `read` | `tools/` | 文件读取（hashline 标记） |
| `write` | `tools/` | 文件创建/修改 |
| `edit` | `tools/` | 精确编辑（hashline/patch/replace 三模式） |
| `bash` | `tools/` | Shell 执行（嵌入式 brush-shell） |
| `python` | `tools/` | Python 执行（Jupyter） |
| `search` | `tools/` | 高性能 grep（Rust） |
| `find` | `tools/` | glob 文件发现 |
| `task` | `task/` | 子 Agent 委派（内置并发控制） |
| `ask` | `tools/` | 向用户提问 |
| `lsp` | `tools/` | LSP 操作 |
| `web_search` | `tools/` | 多后端 Web 搜索（14 个后端） |
| `resolve` | `tools/` | 隐藏系统工具，审批延迟操作 |

### 3.2 Plan Mode（内置）

```
packages/coding-agent/src/plan-mode/         ← 核心代码
packages/coding-agent/src/tools/plan-mode-guard.ts  ← 工具守卫
packages/coding-agent/src/prompts/system/plan-mode-*.md  ← 提示模板
```

两阶段工作流：
1. **规划阶段**（只读）：Agent 以 Architect 角色运作，`enforcePlanModeWrite` 中间件阻止修改非计划文件
2. **执行阶段**：用户通过 `resolve` 审批后执行，支持四种审批选项（执行/压缩/保留/改进）

### 3.3 Task Delegation（内置）

```
packages/coding-agent/src/task/
├── index.ts       ← TaskTool 类
├── executor.ts    ← 子 Agent 执行器
├── types.ts       ← 类型定义
├── worktree.ts    ← Git worktree 隔离
└── render.ts      ← TUI 渲染
```

- 子 Agent 通过 Markdown + YAML frontmatter 定义（`.omp/agents/*.md`）
- `createAgentSession` 在主进程线程内创建子 Agent
- `Semaphore` + `mapWithConcurrencyLimit()` 控制并发
- 子 Agent 继承父 Agent 的 MCP 连接和 ModelRegistry，但无法访问父对话历史
- 通过 `ensureIsolation()` 获取 Git worktree 或 FUSE overlay 隔离

### 3.4 其他内置能力

| 能力 | 实现位置 | 说明 |
|------|---------|------|
| Hashline 编辑引擎 | `tools/edit/` | 内容哈希锚定编辑 |
| 会话持久化 | `session/` | `.omp/sessions/*.jsonl` 追加式存储 |
| 上下文压缩 | `session/` | token 阈值监控 + 自动压缩 |
| Settings Schema | `config/` | 1235 行类型安全配置系统 |
| Model Registry | `config/` | 模型注册/发现/等价映射 |
| TUI 渲染 | `pi-tui` | 差异渲染 + 工具卡片 |
| 嵌入式 Shell | `pi-natives` | Rust brush-shell，跨平台 bash |
| LSP 集成 | `lsp/` | 预配置 4 种语言服务器 |

---

## 4. Pi 的扩展 API 设计

Pi 框架通过 `packages/coding-agent/src/extensibility/` 目录提供完整的扩展 API。

### 4.1 扩展工厂模式

每个扩展是一个 TypeScript 模块，导出一个**工厂函数**：

```typescript
// my-extension/index.ts
export default function(pi: ExtensionAPI) {
  // pi 对象是扩展与框架交互的唯一桥梁

  // 注册工具
  pi.registerTool({ ... });

  // 注册命令
  pi.registerCommand({ ... });

  // 注册快捷键
  pi.registerShortcut({ ... });

  // 订阅生命周期事件
  pi.on('session_start', async (event) => { ... });
  pi.on('tool_call', async (event) => { ... });
}
```

工厂函数接收 `ExtensionAPI`（别名 `pi`），这是扩展能做的**一切**的入口。

### 4.2 ExtensionAPI 提供的完整能力

#### 注册方法

| 方法 | 用途 |
|------|------|
| `pi.registerTool(def)` | 注册自定义工具，模型可调用 |
| `pi.registerCommand(def)` | 注册斜杠命令，用户可调用 |
| `pi.registerShortcut(keyId, handler)` | 绑定键盘快捷键 |
| `pi.on(event, handler)` | 订阅生命周期事件 |

#### 运行时动作（IExtensionRuntime）

| 方法 | 用途 |
|------|------|
| `pi.sendMessage(msg)` | 向当前会话注入自定义消息 |
| `pi.exec(cmd)` | 在项目目录执行 shell 命令 |
| `pi.setActiveTools(tools)` | 动态启用/禁用当前会话的工具 |

#### Schema 工具

| 能力 | 说明 |
|------|------|
| TypeBox | 内置 TypeBox 库，用于定义工具参数 schema |
| Zod | 同时支持 Zod schema |

### 4.3 安全机制：加载阶段 Stub

在扩展发现和加载阶段，`sendMessage`、`exec` 等运行时动作被 **stub 化**：

```
扩展加载 → 工厂函数执行（注册 tools/commands/hooks）
              ↓
        此时 pi.sendMessage() 会抛出
        ExtensionRuntimeNotInitializedError
              ↓
会话初始化完成 → stub 切换为活跃状态
              ↓
        此时 pi.sendMessage() 正常工作
```

**设计目的**：防止扩展在发现/加载阶段产生副作用（如发送消息、执行命令），确保注册行为与执行行为隔离。

---

## 5. 扩展发现与加载机制

### 5.1 五层发现优先级

```
优先级最高
    │
    ▼
1. 项目级:     <cwd>/.omp/extensions/
2. 用户级:     ~/.omp/agent/extensions/
3. 市场插件:   ~/.omp/plugins/node_modules/
4. CLI 标志:   omp --extension ./path.ts
5. 配置文件:   settings.json 中列出的路径
    │
    ▼
优先级最低
```

**去重规则**：同名扩展，"the first absolute path resolved for a given name wins"——高优先级来源覆盖低优先级。

### 5.2 入口点解析顺序

对于目录类型的扩展：

```
1. package.json → omp.extensions 字段（兼容旧版 pi.extensions）
2. index.ts 或 index.js
3. 市场专用清单（installed_plugins.json）
```

### 5.3 模块加载

`ExtensionLoader` 使用 **Bun 原生 import** 导入模块，然后执行默认导出的工厂函数。

包含 **legacy-pi-compat 兼容层**：

```
@mariozechner/pi-*  →  重映射到  →  @oh-my-pi/pi-*
```

确保旧版 Pi（Mario Zechner 的原始项目）的扩展也能在 omp 版本中运行。

### 5.4 Marketplace 安装流程

```
/mcp smithery-search  →  发现远程扩展
         ↓
   MarketplaceManager
         ↓
   fetcher.ts  →  从 URL / Git / 本地路径获取
         ↓
   source-resolver.ts  →  解析来源
         ↓
   clone 到本地缓存目录
         ↓
   注册到 installed_plugins.json
         ↓
   /reload-plugins  →  热加载
```

---

## 6. ExtensionRunner：扩展运行时

`ExtensionRunner` 是扩展系统的核心协调器，位于 `extensibility/extensions/runner.ts`。

### 6.1 职责

```
┌───────────────────────────────────────────────┐
│              ExtensionRunner                  │
│                                               │
│  ┌─────────────────┐  ┌──────────────────┐   │
│  │ 扩展加载与注册    │  │ 生命周期事件分发  │   │
│  │                 │  │                  │   │
│  │ • 调用工厂函数   │  │ • session_start  │   │
│  │ • 收集 tools    │  │ • tool_call      │   │
│  │ • 收集 commands │  │ • tool_result    │   │
│  │ • 收集 hooks    │  │ • ...            │   │
│  └─────────────────┘  └──────────────────┘   │
│                                               │
│  ┌─────────────────┐  ┌──────────────────┐   │
│  │ 冲突检测         │  │ 运行时状态切换    │   │
│  │                 │  │                  │   │
│  │ • 命令重名       │  │ • stub → active  │   │
│  │ • 快捷键冲突     │  │ • 连接 agent     │   │
│  │ • 后加载优先     │  │   session        │   │
│  └─────────────────┘  └──────────────────┘   │
└───────────────────────────────────────────────┘
```

### 6.2 完整生命周期

```
Agent 启动
  ↓
1. 配置加载 (config.yml / settings.yml)
  ↓
2. 模型注册 (ModelRegistry)
  ↓
3. 内置工具注册 (createTools)
  ↓
4. ★ 扩展发现 (五层扫描)
  ↓
5. ★ ExtensionLoader 加载模块
     → 执行工厂函数（stub 模式）
     → 收集注册的 tools/commands/hooks
  ↓
6. ★ 冲突检测 (命令重名 → 后加载优先；快捷键冲突 → 警告)
  ↓
7. ★ 运行时激活 (stub → active，连接 AgentSession)
  ↓
8. 会话开始
     → 分发 session_start 事件
     → 扩展的 hooks 开始响应
  ↓
9. Agent Loop 运行
     → tool_call 事件 → 扩展可拦截/阻止
     → tool_result 事件 → 扩展可修改结果
  ↓
10. 会话结束
     → 分发 session_shutdown 事件
     → 扩展清理
```

---

## 7. Hook 系统：行为拦截与修改

### 7.1 所有可用事件

| Hook 事件 | 触发时机 | 可覆盖 | 扩展可做什么 |
|-----------|---------|--------|------------|
| `session_start` | 会话初始化后 | 否 | 初始化状态、设置监视器 |
| `session_before_compact` | 压缩前 | **是** | 自定义压缩策略、保留特定内容 |
| `session_compact` | 压缩后 | 否 | 记录统计、通知用户 |
| `session_shutdown` | 会话终止前 | 否 | 清理、导出、持久化 |
| `tool_call` | 工具执行**前** | **是** | **阻止执行**、请求额外审批 |
| `tool_result` | 工具执行**后** | **是** | **修改输出**、更改错误状态 |
| `auto_compaction_start` | 自动压缩开始 | 否 | 通知用户 |
| `auto_compaction_end` | 自动压缩结束 | 否 | 清理或恢复 |
| `todo_reminder` | TODO 提醒 | 否 | 自定义通知 |
| `ttsr_triggered` | 流规则匹配 | 否 | 模式匹配后的自定义逻辑 |

### 7.2 关键：tool_call 的阻止能力

```typescript
pi.on('tool_call', async (event) => {
  // 检查是否是危险操作
  if (event.tool === 'bash' && isDangerous(event.args.command)) {
    return { block: true, reason: '该命令被安全策略阻止' };
  }
  // 返回 undefined 表示允许继续
});
```

**任何 hook 返回 `{ block: true }` 即可阻止工具执行。** 这是 Pi 框架提供的最强大的扩展点——omp 可以通过它实现自定义安全策略、操作审计、行为修正等。

### 7.3 关键：tool_result 的修改能力

```typescript
pi.on('tool_result', async (event) => {
  // 在搜索结果中追加额外信息
  if (event.tool === 'search') {
    event.content += '\n[注意：以上结果已通过安全审查]';
    return event;
  }
});
```

---

## 8. 自定义工具 API

### 8.1 工具注册

```typescript
pi.registerTool({
  name: 'my_tool',
  parameters: Type.Object({           // TypeBox schema
    query: Type.String(),
    limit: Type.Optional(Type.Number()),
  }),
  deferrable: false,                   // true = 需要 resolve 审批
  async execute(args, api: CustomToolAPI) {
    const result = await api.exec(`my-command --query "${args.query}"`);
    return { content: result };
  }
});
```

### 8.2 CustomToolAPI 提供的能力

| 方法 | 用途 |
|------|------|
| `api.exec(cmd)` | 执行 shell 命令 |
| `api.pushPendingAction({ preview, action })` | 推入待审批队列（配合 `deferrable: true`） |

### 8.3 Deferrable 工具的 Resolve 协议

```
扩展工具 (deferrable: true)
    ↓ pushPendingAction({ preview, action })
Pi 框架的隐藏 resolve 工具
    ↓ 显示预览给 LLM
LLM 决定是否执行
    ↓ 调用 resolve({ accept: true/false })
action() 执行 或 丢弃
```

**这是 Pi 框架内置的安全门控**——deferrable 工具的变更必须经过 resolve 审批，不能绕过。

### 8.4 CustomToolAdapter（适配层）

Pi 框架通过 `CustomToolAdapter` 将各来源的工具定义统一转换为内部的 `AgentTool` 接口：

```
扩展注册的工具定义    ──→ RegisteredToolAdapter ──→ AgentTool
外部脚本/二进制      ──→ CustomToolAdapter     ──→ AgentTool
MCP 服务器工具       ──→ MCPToolBridge         ──→ AgentTool
```

所有来源的工具最终统一为相同的 `AgentTool` 格式，对 Agent 循环透明。

---

## 9. 自定义命令 API

### 9.1 命令注册

```typescript
pi.registerCommand({
  name: 'my-command',
  description: '自定义斜杠命令',
  async execute(args, context: ExtensionCommandContextActions) {
    // context 提供会话级控制
    // context.reload()      — 重置会话
    // context.newSession()  — 启动新会话
  }
});
```

### 9.2 文件系统发现（备选方式）

命令也可以通过目录结构注册（无需显式调用 `registerCommand`）：

```
.omp/commands/my-command/index.ts    ← 项目级（最高优先级）
~/.omp/commands/my-command/index.ts  ← 用户级
packages/.../commands/my-command/    ← 内置（最低优先级）
```

`CustomCommandLoader` 自动扫描，高优先级覆盖低优先级同名命令。

---

## 10. 工具拦截（Tool Wrapping）

### 10.1 ExtensionToolWrapper

Pi 框架允许扩展**拦截已有工具的调用和结果**：

```typescript
// 拦截 edit 工具，添加日志
pi.wrapTool('edit', {
  async onToolCall(call) {
    console.log(`即将编辑: ${call.args.file_path}`);
    // 返回 call 继续执行
    // 返回 { block: true } 阻止执行
    return call;
  },
  async onToolResult(result) {
    console.log(`编辑结果: ${result.status}`);
    // 可修改 result 后返回
    return result;
  }
});
```

### 10.2 拦截点位于何处

```
LLM 决定调用工具
    ↓
Pi 框架检查 approvalMode (read/write/exec)
    ↓
ExtensionToolWrapper.onToolCall()      ← ★ 扩展拦截点
    ↓ (block=true 则中止)
实际工具执行
    ↓
ExtensionToolWrapper.onToolResult()    ← ★ 扩展拦截点
    ↓ (可修改结果)
结果返回给 LLM
```

---

## 11. 权限与审批系统

Pi 框架内置权限系统，扩展注册的工具必须遵守：

### 11.1 审批层级

| Tier | 范围 | 示例 |
|------|------|------|
| `read` | 数据访问 | ls、cat、read |
| `write` | 文件修改 | edit、write |
| `exec` | 代码执行 | bash、python |

### 11.2 审批模式

```yaml
tools:
  approvalMode: yolo   # always-ask | write | yolo
```

| 模式 | read | write | exec |
|------|------|-------|------|
| `always-ask` | 自动 | 提示 | 提示 |
| `write` | 自动 | 自动 | 提示 |
| `yolo` | 自动 | 自动 | 自动 |

### 11.3 override 标志

工具可设置 `override` 标志标记危险模式（如 `rm -rf`），即使在宽松模式下也强制提示。但 `yolo` 模式仍绕过，除非用户策略显式设为 `prompt` 或 `deny`。

---

## 12. omp 如何利用 Pi 的扩展 API

这是本文的核心——omp 不修改 Pi 框架的任何核心代码，而是通过上述扩展 API 实现所有增强功能。

### 12.1 omp 利用的扩展接口一览

| Pi 接口 | omp 如何使用 |
|---------|-------------|
| `pi.registerTool()` | 注册 Swarm 编排工具、MCP 桥接工具、记忆工具等 |
| `pi.registerCommand()` | 注册 `/swarm`、`/mcp add` 等自定义命令 |
| `pi.on('tool_call')` | 实现自定义安全策略、操作审计 |
| `pi.on('tool_result')` | 丰富工具输出、注入额外上下文 |
| `pi.on('session_start')` | 初始化 Swarm 控制器、加载 MCP 连接 |
| `pi.on('session_shutdown')` | 清理 Swarm 子 Agent、关闭 MCP 连接 |
| `pi.on('session_before_compact')` | 自定义压缩策略（保留 Swarm 上下文） |
| `pi.sendMessage()` | 向会话注入 Swarm 进度更新 |
| `pi.setActiveTools()` | 动态启用/禁用工具（如 Swarm 模式下限制工具集） |
| `pi.exec()` | 执行 Swarm 子 Agent 的 shell 操作 |
| Tool Wrapping | 拦截内置工具行为，添加 MCP 层、审计层 |
| Marketplace | 作为可安装的扩展包分发 |

### 12.2 omp 的 MCP 集成是如何实现的

```
Pi 框架                           omp 扩展
┌──────────────────┐            ┌──────────────────┐
│ registerTool()   │ ←───────── │ MCPToolBridge     │
│                  │            │                  │
│ 注册桥接工具      │            │ 将远程 MCP 工具   │
│ mcp__server_tool │            │ 转换为            │
│                  │            │ CustomTool 格式   │
└──────────────────┘            └──────────────────┘

Pi 框架                           omp 扩展
┌──────────────────┐            ┌──────────────────┐
│ registerCommand()│ ←───────── │ /mcp list        │
│                  │            │ /mcp add         │
│                  │            │ /mcp test        │
│                  │            │ /mcp reload      │
│                  │            │ /mcp smithery-   │
│                  │            │      search      │
└──────────────────┘            └──────────────────┘
```

MCP 工具命名规范化（`mcp__<server>_<tool>`）和排序（`sortMCPToolsByName`）都在 omp 的 `MCPManager` 中实现，但最终通过 Pi 的 `registerTool()` 注册到 Agent 工具系统中。

### 12.3 omp 的配置增强

omp 在 Pi 框架的 `SETTINGS_SCHEMA` 基础上增加了额外配置项：

```
Pi 框架内置的 settings-schema.ts (~1235 行)
    ↑
omp 通过扩展添加的配置
    ├── swarm 相关配置
    ├── MCP 服务器配置
    ├── 记忆系统配置
    └── 额外工具的 enabled 开关
```

Pi 的 Settings 系统支持扩展添加新 key——因为 YAML 是开放格式，未定义的 key 不会报错，扩展在 `session_start` hook 中读取自己需要的配置值。

### 12.4 omp 的竞品配置继承

Pi 框架通过 `SOURCE_PATHS` 定义了扫描路径，但具体扫描 `.claude/`、`.cursor/`、`.windsurf/` 等目录的逻辑是 omp 扩展层实现的——通过 `discovery/` 模块中的专用发现器。

```
Pi 框架: "我支持从多路径发现扩展"
                 ↓
omp 扩展: "我实现了具体的发现逻辑：
          扫描 .claude/ → 提取 rules、skills、MCP configs
          扫描 .cursor/ → 提取 cursorrules
          扫描 .windsurf/ → 提取 windsurfrules
          ..."
```

---

## 13. Swarm Extension：多 Agent 协作的扩展范例

Swarm 是 omp 中最复杂的扩展，也是理解 Pi 扩展 API 威力的最佳案例。

### 13.1 Swarm 的双重身份

```
身份一：独立 CLI 工具
         omp-swarm <pipeline.yaml>

身份二：Pi 框架扩展
         注册到 ExtensionRunner，提供并行任务委派
```

### 13.2 Swarm 如何利用 Pi 的扩展 API

```
┌─────────────────────────────────────────────────────┐
│  Swarm Extension                                    │
│                                                     │
│  使用 pi.registerTool()                              │
│  └─ 注册 swarm task 工具                             │
│     → 模型可调用此工具委派并行任务                      │
│                                                     │
│  使用 pi.on('session_start')                         │
│  └─ 初始化 PipelineController                        │
│     → 解析 YAML 流水线定义                            │
│     → 构建 DAG 依赖图                                │
│                                                     │
│  使用 pi.sendMessage()                               │
│  └─ 注入 Swarm 进度更新到会话                          │
│     → "Agent A: 50% 完成"                            │
│     → "Agent B: 等待 Agent A..."                      │
│                                                     │
│  使用 pi.setActiveTools()                             │
│  └─ 限制子 Agent 的工具集                              │
│     → 规划型 Agent 只有 read/search                   │
│     → 执行型 Agent 拥有 edit/bash                     │
│                                                     │
│  使用 pi.exec()                                      │
│  └─ 在隔离环境中执行子 Agent 操作                      │
│     → Git worktree 隔离                              │
│     → FUSE overlay 隔离                              │
│                                                     │
│  内部管理                                             │
│  └─ PipelineController                               │
│     → 解析 waits_for 依赖                            │
│     → 按波次触发 Agent                                │
│     → Semaphore 控制并发                              │
│     → scheduleBackgroundExchangeFlush 同步上下文      │
└─────────────────────────────────────────────────────┘
```

### 13.3 YAML 流水线定义

```yaml
# pipeline.yaml
mode: pipeline         # pipeline | parallel | sequential
agents:
  architect:
    role: "分析代码库架构"
    tools: [read, search, find]
    model: claude-opus-4-7

  implementer:
    role: "实现功能"
    tools: [read, edit, write, bash]
    model: gpt-5.5
    waits_for: [architect]     # 依赖 architect 完成

  reviewer:
    role: "代码审查"
    tools: [read, search]
    model: claude-opus-4-7
    waits_for: [implementer]   # 依赖 implementer 完成
```

### 13.4 与 Pi 内置 Task Delegation 的区别

| 维度 | Task Delegation（Pi 内置） | Swarm Extension（omp 扩展） |
|------|--------------------------|---------------------------|
| 实现位置 | `packages/coding-agent/src/task/` | `packages/swarm-extension/` |
| 性质 | 框架核心功能 | 扩展系统插件 |
| 编排模式 | 单层父子委派 | DAG 流水线 + 并发池 |
| 定义方式 | Markdown frontmatter 声明式 | YAML 流水线声明式 + 编程式 |
| 依赖管理 | 无显式依赖（并行执行） | `waits_for` 显式依赖图 |
| 隔离方式 | Git worktree / FUSE | Git worktree / FUSE |
| 适用场景 | 单次任务分解 | 多阶段复杂流水线 |

**关键理解**：Task Delegation 是 Pi 提供的**基础并行能力**，Swarm 是在此基础上通过扩展 API 构建的**高级编排层**。Swarm 的 `task` 工具在底层仍然调用 Pi 的 `createAgentSession`。

---

## 14. Pi 内置 vs omp 扩展：完整对照表

```
┌────────────────────────────────────────────────────────────┐
│                  Pi 框架内置                                │
│                                                            │
│  核心工具: read, write, edit, bash, python, search, find   │
│  任务委派: task tool + createAgentSession                  │
│  Plan Mode: 两阶段规划/执行工作流                           │
│  编辑引擎: hashline / patch / replace                      │
│  会话管理: 持久化、压缩、恢复                                │
│  模型系统: ModelRegistry、多 Provider、Fallback             │
│  Settings: 类型安全的分层配置系统                            │
│  TUI: 差异渲染、工具卡片                                    │
│  原生性能: Rust grep、shell、AST、fs_cache                 │
│  LSP: 预配置 4 种语言服务器                                 │
│  审批系统: read/write/exec tier + approvalMode             │
│  Web 搜索: 14 后端 + auto 链式路由                         │
│                                                            │
│  ★ Extension API:                                         │
│    registerTool / registerCommand / registerShortcut       │
│    on() hooks / sendMessage / exec / setActiveTools        │
│    ExtensionToolWrapper / Resolve 协议                     │
│    ExtensionRunner / MarketplaceManager                    │
│                                                            │
├────────────────────── 扩展边界 ─────────────────────────────┤
│                                                            │
│                  omp 扩展层                                 │
│                                                            │
│  Swarm Extension: DAG 流水线 + 多 Agent 协作               │
│  MCP 集成: MCPManager + MCPToolBridge + /mcp 命令          │
│  竞品配置继承: .claude/.cursor/.windsurf 等发现             │
│  额外工具: github, checkpoint, rewind, retain/recall/reflect│
│  TTSR 流规则: 正则匹配输出流 → 中断 → 注入 → 重试          │
│  自定义命令: /swarm, /mcp, /reload-plugins 等              │
│  工具拦截: 通过 ExtensionToolWrapper 实现安全策略           │
│  用户扩展: .omp/extensions/ 目录下的自定义扩展              │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

## 15. 设计启示：框架与扩展的分层哲学

### 15.1 Pi 的扩展 API 设计原则

| 原则 | 实现 | 效果 |
|------|------|------|
| **单一入口** | 所有能力通过 `ExtensionAPI (pi)` 对象暴露 | 扩展只需理解一个 API surface |
| **工厂隔离** | 每个扩展通过独立工厂函数调用获得自己的 API 实例 | 扩展间无直接通信，避免耦合 |
| **阶段分离** | 加载阶段 stub → 运行时激活 | 注册行为与执行行为隔离，防副作用 |
| **拦截优于替换** | `tool_call`/`tool_result` hook 可修改但不替换 | 扩展增强而非覆盖核心行为 |
| **Resolve 门控** | deferrable 工具必须经过 resolve 审批 | 即使恶意扩展也无法绕过审批 |
| **统一适配** | CustomToolAdapter 将所有来源统一为 AgentTool | 对 Agent 循环透明 |

### 15.2 omp 选择扩展而非 Fork 的好处

| 维度 | Fork Pi 框架 | 通过扩展 API |
|------|-------------|-------------|
| 升级 Pi 版本 | 每次都要 merge 冲突 | Pi 升级对 omp 透明 |
| 代码维护 | 必须理解 Pi 全部内部实现 | 只需理解公开的 API surface |
| 社区协作 | 难以合并社区贡献 | 扩展互相独立，可独立贡献 |
| 灵活组合 | 全有或全无 | 用户可选择性安装部分扩展 |
| 分发 | 必须发布整个框架 | 通过 Marketplace 独立分发 |

### 15.3 可借鉴的设计模式

**对于想构建类似可扩展 Agent 框架的开发者：**

1. **核心精简**：Pi 内置的只有基础工具、会话管理、模型系统。一切增强功能（MCP、Swarm、竞品继承）都通过扩展实现。
2. **Hook 是关键**：两个可覆盖的 hook（`tool_call` 和 `tool_result`）足以支撑大部分扩展需求——阻止、修改、审计。
3. **工具注册 > 工具内置**：Pi 提供 `registerTool` 让扩展可以注册任意数量的自定义工具，而非试图内置所有功能。
4. **统一适配层**：无论工具来自内置、扩展、MCP 还是外部脚本，都经过 Adapter 转换为统一的 `AgentTool` 格式。
5. **安全内置于框架**：审批系统（read/write/exec tier）和 Resolve 协议是框架级别的，扩展无法绕过。

---

> **总结：Pi 框架的可扩展性设计遵循"核心精简 + API 丰富"的哲学——框架只负责 Agent 循环、模型调用、工具执行、会话管理和安全审批这五件事，其余一切通过 Extension API（registerTool / registerCommand / on() hooks / Tool Wrapping）暴露给扩展层。omp 不修改 Pi 的任何一行核心代码，完全通过这些 API 实现了 MCP 集成、Swarm 多 Agent 编排、竞品配置继承、TTSR 流规则等全部增强功能。这种分层设计使得 Pi 可以独立升级、omp 可以独立演进、用户可以选择性安装扩展——三方解耦。**
