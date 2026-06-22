# Oh My Pi (omp) — 可配置化架构全解

> 本文分析 Oh My Pi 如何实现"几乎所有功能都可由用户配置和自定义"的架构设计，涵盖配置层级体系、模型/工具/规则/扩展/MCP/搜索/记忆等全维度的可配置机制。

---

## 目录

1. [设计理念：Everything is Configurable](#1-设计理念everything-is-configurable)
2. [配置层级与优先级体系](#2-配置层级与优先级体系)
3. [Settings Schema：类型安全的配置系统](#3-settings-schema类型安全的配置系统)
4. [模型与 Provider 配置](#4-模型与-provider-配置)
5. [工具系统配置](#5-工具系统配置)
6. [规则与上下文配置](#6-规则与上下文配置)
7. [扩展系统（Extension System）](#7-扩展系统extension-system)
8. [Hook 系统](#8-hook-系统)
9. [自定义工具与命令](#9-自定义工具与命令)
10. [MCP 集成配置](#10-mcp-集成配置)
11. [Web 搜索配置](#11-web-搜索配置)
12. [编辑模式配置](#12-编辑模式配置)
13. [记忆系统（Hindsight）配置](#13-记忆系统hindsight配置)
14. [UI 与外观配置](#14-ui-与外观配置)
15. [权限与审批系统](#15-权限与审批系统)
16. [运行模式配置](#16-运行模式配置)
17. [总结：可配置化架构的设计模式](#17-总结可配置化架构的设计模式)

---

## 1. 设计理念：Everything is Configurable

Oh My Pi 的核心设计哲学是**"模型只是参数"**（the model is but a parameter）。推而广之，omp 将几乎所有行为都参数化——模型选择、工具集、编辑方式、规则注入、搜索后端、审批策略、UI 主题，全部可通过统一的配置体系由用户控制。

这种设计源自 **Harness Problem** 的核心洞见：影响 Agent 能力的不是模型本身，而是模型外部的工具层（harness）。因此 omp 选择将这个工具层做到极致的可配置，让用户（而非框架作者）决定最佳组合。

**可配置化的设计原则：**

| 原则 | 实现方式 |
|------|---------|
| 分层覆盖 | 默认值 → 全局配置 → 项目配置 → 运行时覆盖 |
| 类型安全 | Settings Schema 提供编译时和运行时的类型校验 |
| 多格式兼容 | 自动发现和继承 8 种竞品格式（Cursor/Cline/Copilot 等） |
| 渐进式暴露 | 开箱即用的默认值 + 按需深度自定义 |
| 热重载 | 配置变更后无需重启，`/reload-plugins` 即时生效 |

---

## 2. 配置层级与优先级体系

### 2.1 四层配置文件

```
┌─────────────────────────────────────────────────┐
│  优先级最高                                       │
│                                                 │
│  Layer 4: 运行时覆盖 (Runtime Overrides)          │
│  ├─ CLI 参数: --tools, --smol, --slow            │
│  ├─ 会话内命令: /model, Ctrl+P                    │
│  └─ Settings 构造器的 overrides 参数              │
│                                                 │
│  Layer 3: 环境变量                                │
│  ├─ PI_EDIT_VARIANT=hashline                     │
│  ├─ ANTHROPIC_API_KEY=sk-...                     │
│  └─ PI_PACKAGE_DIR=/path/to/assets               │
│                                                 │
│  Layer 2: 项目配置                                │
│  ├─ .omp/settings.yml      ← omp 原生            │
│  └─ .claude/settings.yml   ← 兼容 Claude Code    │
│                                                 │
│  Layer 1: 全局用户配置                             │
│  └─ ~/.omp/agent/config.yml                      │
│                                                 │
│  Layer 0: 内置默认值                               │
│  └─ SETTINGS_SCHEMA (settings-schema.ts)         │
│                                                 │
│  优先级最低                                       │
└─────────────────────────────────────────────────┘
```

### 2.2 配置合并规则

- **高优先级覆盖低优先级**：项目配置的同名 key 覆盖全局配置
- **path-scoped 配置**：`enabledModels`、`disabledProviders` 等支持 `pathPrefixes` 字段，按工作目录自动切换
- **外部编辑安全**：用户手动编辑配置文件后，`Settings` 类在保存时执行 merge-on-save，不覆盖外部修改
- **持久化**：通过 `set()` 修改的值经 `#queueSave()` 防抖后台保存

### 2.3 配置文件格式

| 文件 | 格式 | 位置 | 用途 |
|------|------|------|------|
| `config.yml` | YAML | `~/.omp/agent/` | 全局用户设置 |
| `settings.yml` | YAML | `.omp/` | 项目级设置 |
| `models.yml` | YAML | `~/.omp/agent/` | Provider 和模型配置 |
| `mcp.json` | JSON | `~/.omp/` 或 `.omp/` | MCP 服务器配置 |
| `AGENTS.md` | Markdown | 项目根目录及子目录 | 项目上下文规则 |
| `SYSTEM.md` | Markdown | 项目根目录 | 完全替换默认系统提示词 |

### 2.4 竞品格式自动发现

omp 首次运行时自动扫描并继承以下工具的配置：

```
.claude/          ← Claude Code
.cursor/          ← Cursor
.windsurf/        ← Windsurf
.gemini/          ← Gemini
.codex/           ← Codex
.cline/           ← Cline
.github/copilot/  ← GitHub Copilot
.vscode/          ← VS Code
```

继承内容包括：rules、skills、MCP server 配置。无需手动迁移。

---

## 3. Settings Schema：类型安全的配置系统

### 3.1 Schema 类型系统

每个配置项在 `SETTINGS_SCHEMA`（`settings-schema.ts`，约 1235 行）中定义：

```typescript
{
  type: "boolean" | "string" | "number" | "enum" | "array" | "record",
  default: <默认值>,
  ui: {
    tab: "<UI 分组标签>",
    label: "<显示名称>",
    description: "<说明文字>"
  },
  values: ["opt1", "opt2"]  // enum 类型专用
}
```

### 3.2 类型安全访问

```typescript
settings.get("compaction.enabled")     // → boolean
settings.get("edit.mode")              // → "hashline" | "replace" | "patch"
settings.get("task.concurrency")       // → number
```

路径式访问，编译时类型推断，运行时校验。

### 3.3 九大配置分组（UI Tabs）

Settings 按 `SETTING_TABS` 分为 9 个 UI 标签页，覆盖所有可配置维度：

| Tab | 覆盖范围 |
|-----|---------|
| Appearance | 主题、符号集、色盲模式 |
| Models | 模型角色、Provider 启用/禁用 |
| Editing | 编辑模式、模糊匹配、LSP |
| Tools | 工具启用/禁用、发现模式 |
| Context | 压缩策略、TTSR 规则 |
| Tasks | 子 Agent 并发数、简化模式 |
| Search | 搜索后端、内容处理 |
| Memory | Hindsight 配置 |
| Permissions | 审批模式、工具权限 |

---

## 4. 模型与 Provider 配置

### 4.1 Model Roles（角色路由）

```yaml
# ~/.omp/agent/config.yml
modelRoles:
  default:
    - provider: anthropic
      model: claude-opus-4-7
  smol:
    - provider: openai
      model: gpt-5.4-mini
  slow:
    - provider: anthropic
      model: claude-opus-4-8
  plan:
    - provider: anthropic
      model: claude-opus-4-7
  commit:
    - provider: openai
      model: gpt-5.4-mini
```

| 角色 | TUI 标签 | 颜色 | 用途 | 快捷操作 |
|------|---------|------|------|---------|
| `default` | DEFAULT | 绿色 | 常规编码任务 | 默认 |
| `smol` | SMOL | 黄色 | 廉价子 Agent 扇出（标题、commit msg） | `--smol` |
| `slow` | SLOW | 强调色 | 深度推理（thinking 模型） | `--slow` |
| `plan` | PLAN | 灰色 | 架构和规划 | `--plan` |
| `commit` | — | — | Changelog 生成 | 自动 |

### 4.2 路径级角色覆盖

```yaml
modelRoles:
  default:
    - provider: anthropic
      model: claude-sonnet-4-6
  paths:
    /work/critical-project:
      default:
        - provider: anthropic
          model: claude-opus-4-8
    /work/experiments:
      default:
        - provider: ollama
          model: qwen3.5:27b
```

**"Closest path wins"** ——进入特定目录时自动切换到更强（或更便宜）的模型。

### 4.3 Fallback 链

```yaml
modelRoles:
  default:
    - provider: anthropic
      model: claude-opus-4-7       # 首选
    - provider: openai
      model: gpt-5.5               # 首选限流时切换
    - provider: xai
      model: grok-4                # 二次回退

retry:
  fallbackChains:
    enabled: true
```

触发条件：429 限流、配额耗尽、"resource exhausted"。非限流错误不触发。

### 4.4 自定义 Provider（models.yml）

```yaml
# ~/.omp/agent/models.yml
providers:
  my-local-proxy:
    api: openai-completions
    baseUrl: https://my-proxy.example.com/v1
    apiKey: ${MY_PROXY_KEY}   # 环境变量自动展开

    models:
      my-custom-model:
        id: custom-model-v2
        reasoning: true
        thinking:
          mode: effort
          effort: [low, medium, high]
        input: [text, image]
        cost:
          input: 3.0
          output: 15.0
          cacheRead: 0.3
          cacheWrite: 3.75
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_completion_tokens
          thinkingFormat: anthropic-style
```

支持 6 种协议：

| 协议 | 对应平台 |
|------|---------|
| `openai-completions` | 标准 OpenAI / 兼容 API |
| `openai-responses` | OpenAI Responses API |
| `openai-codex-responses` | Codex WebSocket 协议 |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Gemini API |
| `bedrock-converse-stream` | AWS Bedrock |

### 4.5 凭据轮换

```bash
# 同一 Provider 多 Key
ANTHROPIC_API_KEY_1=sk-ant-...first
ANTHROPIC_API_KEY_2=sk-ant-...second
ANTHROPIC_API_KEY_3=sk-ant-...third
```

运行时以 **session affinity + per-credential backoff** 策略自动轮换。

### 4.6 本地模型自动发现

- **Ollama**：查询 `GET /api/tags` 和 `POST /api/show`，自动获取上下文窗口等元数据
- **LM Studio / vLLM**：通过 OpenAI 兼容的 `GET /v1/models` 发现，本地流量（`lm-studio-local` sentinel token）跳过认证

### 4.7 模型等价映射

`model-equivalence.ts` 将同一模型在不同 Provider 下的引用（如 Anthropic 的 Claude vs Bedrock 的 Claude）归到**同一个 canonical ID**，使用户切换 Provider 时默认模型设置不变。

### 4.8 会话内动态切换

| 操作 | 方式 |
|------|------|
| 切换当前角色的模型 | `Ctrl+P` 循环 |
| 指定模型 | `/model <provider>/<model>` |
| 临时使用其他角色 | `--smol`、`--slow`、`--plan` |

---

## 5. 工具系统配置

### 5.1 内置工具

| 工具 | 类别 | 功能 |
|------|------|------|
| `read` | 文件操作 | 文件读取（支持 hashline） |
| `write` | 文件操作 | 文件创建/修改 |
| `edit` | 文件操作 | 精确编辑（hashline/patch/replace） |
| `bash` | 代码执行 | Shell 命令 |
| `python` | 代码执行 | Python (Jupyter) |
| `task` | 任务委派 | 并行子 Agent |
| `search` | 搜索 | 高性能文本搜索（Rust grep） |
| `find` | 搜索 | glob 文件发现 |
| `ask` | 交互 | 向用户提问 |
| `lsp` | 代码智能 | LSP 操作 |
| `web_search` | 网络 | 多后端 Web 搜索 |
| `ssh` | 远程 | SSH 连接 |

### 5.2 Setting-Gated 工具（默认关闭）

以下工具必须在配置中显式启用：

| 工具 | 启用方式 | 用途 |
|------|---------|------|
| `github` | `github.enabled: true` | GitHub API 交互 |
| `inspect_image` | `inspect_image.enabled: true` | 图像检查 |
| `render_mermaid` | `render_mermaid.enabled: true` | Mermaid 图表渲染 |
| `checkpoint` | `checkpoint.enabled: true` | 工作检查点 |
| `rewind` | `rewind.enabled: true` | 回退到检查点 |
| `search_tool_bm25` | `search_tool_bm25.enabled: true` | BM25 工具发现 |
| `retain` | `retain.enabled: true` | 记忆写入 |
| `recall` | `recall.enabled: true` | 记忆检索 |
| `reflect` | `reflect.enabled: true` | 记忆综合 |

配置示例：

```yaml
# .omp/settings.yml
github:
  enabled: true
checkpoint:
  enabled: true
rewind:
  enabled: true
```

### 5.3 工具集锁定

```bash
# 只激活指定工具，其余隐藏但保留索引
omp --tools read,edit,bash,search,find
```

未列出的工具仍被 BM25 索引，可通过 `search_tool_bm25` 按需激活。

### 5.4 工具发现模式

```yaml
tools:
  discoveryMode: dynamic   # 或 static
```

- `dynamic`：代理可通过 BM25 搜索发现并激活隐藏工具
- `static`：仅使用显式启用的工具

### 5.5 子 Agent 并发

```yaml
task:
  concurrency: 4        # 最大并行子 Agent 数
  simple: schema-free   # 或 default
```

---

## 6. 规则与上下文配置

### 6.1 规则来源（多格式自动发现）

| 来源 | 文件 | 说明 |
|------|------|------|
| omp 原生 | `.omp/rules/` | 目录下所有规则文件 |
| Cline | `.clinerules` | Cline 规则格式 |
| Cursor | `.cursorrules` | Cursor 规则格式 |
| Windsurf | `.windsurfrules` | Windsurf 规则格式 |

`dedupeAlwaysApplyRules` 自动去重，通过标准化比较防止同一规则从多个来源重复注入。

### 6.2 AGENTS.md 发现

omp 使用 Rust 原生文件系统 walker 搜索项目上下文文件：

| 参数 | 值 | 说明 |
|------|-----|------|
| 搜索深度 | `maxDepth: 3` | 最多扫描 3 层子目录 |
| 文件上限 | `AGENTS_MD_LIMIT: 200` | 防止上下文窗口溢出 |
| Walker | `listWorkspace({collectAgentsMd: true})` | 与 gitignore 联合一次扫描 |

同时兼容：
- Claude Code 的 `CLAUDE.md`（用户级和项目级）
- Codex 的 `~/.codex/AGENTS.md`

### 6.3 TTSR — Time-Traveling Stream Rules

TTSR 是 omp 独创的规则系统——**规则在模型输出流中实时匹配，匹配到时中断生成并重试**：

```yaml
ttsr:
  enabled: true
  interruptMode: always   # never | prose-only | tool-only | always
```

| 模式 | 行为 |
|------|------|
| `never` | 完全禁用 |
| `prose-only` | 仅在文本输出中匹配 |
| `tool-only` | 仅在工具调用中匹配 |
| `always` | 文本和工具调用都匹配 |

工作原理：

```
模型开始输出 → 逐 token 流式传输
    → TTSR 规则的正则匹配命中
    → 流立即中断（mid-token）
    → 规则内容作为 system reminder 注入
    → 从中断点重试生成
    → 注入内容在 compaction 后仍保留
```

### 6.4 系统提示词自定义

三种覆盖方式，由浅到深：

| 方式 | 文件/配置 | 效果 |
|------|----------|------|
| 追加自定义指令 | `systemPromptCustomization` setting | 在默认提示词后追加 |
| 完全替换默认提示词 | 项目根目录 `SYSTEM.md` | 替换整个默认提示词 |
| CLI 参数指定 | `--system-prompt <path>` | 运行时覆盖 |

即使完全替换，系统仍通过 `custom-system-prompt.md` 包装，确保项目上下文（AGENTS.md 等）仍被注入。

### 6.5 内部 URI 方案

提示词中可通过以下 URI 引用资源：

| URI | 用途 |
|-----|------|
| `skill://skill-name` | 引用技能包 |
| `rule://rule-name` | 引用规则 |
| `memory://key` | 引用记忆 |

### 6.6 提示词标准化

`format` 函数在提交前自动优化提示词：
- RFC 2119 关键字标准化（MUST、SHOULD 等）
- 表格压缩
- ASCII 符号替换（`->` → `→`）
- 减少 token 消耗

---

## 7. 扩展系统（Extension System）

### 7.1 扩展能力

扩展是 TypeScript 模块，可贡献：

| 贡献类型 | 注册方法 | 用途 |
|---------|---------|------|
| Slash 命令 | `pi.registerCommand()` | 添加自定义 `/commands` |
| 工具 | `pi.registerTool()` | 注册新工具 |
| 钩子 | `pi.on()` | 订阅生命周期事件 |
| 工具拦截 | `ExtensionToolWrapper` | 拦截/修改已有工具的行为 |
| 模型 Provider | `registerProvider()` | 添加自定义模型供应商 |

### 7.2 扩展发现来源

```
1. 本地目录扫描（.omp/extensions/）
2. CLI 指定路径（--extension <path>）
3. Claude Code Marketplace（~/.claude/plugins/cache/）
4. SOURCE_PATHS 定义的标准位置（native/claude/cursor/windsurf）
5. npm 包
```

### 7.3 Marketplace 集成

`MarketplaceManager` 管理外部扩展的完整生命周期：

```
Discovery → Registry → Installation → Live Reload
```

- 插件被克隆到本地缓存目录
- 维护 `installed_plugins.json` 注册表
- `/reload-plugins` 即时加载变更

### 7.4 LSP 扩展（预配置）

| LSP Server | 语言 | 触发标记 |
|------------|------|---------|
| rust-analyzer | Rust | `Cargo.toml` |
| typescript-language-server | TS/JS | `package.json` / `tsconfig.json` |
| pyright / basedpyright | Python | `pyproject.toml` / `requirements.txt` |
| clangd | C/C++ | `CMakeLists.txt` / `compile_commands.json` |

```yaml
lsp:
  enabled: true   # 全局开关
```

通过 `hasRootMarkers` 检测项目文件，自动决定激活哪个 LSP。

---

## 8. Hook 系统

### 8.1 所有可用 Hook 事件

#### 会话生命周期

| Hook | 触发时机 | 可覆盖 | 典型用途 |
|------|---------|--------|---------|
| `session_start` | 会话初始化完成后 | 否 | 初始化扩展状态、设置监视器 |
| `session_before_compact` | 上下文压缩之前 | **是** | 自定义压缩策略、选择性保留内容 |
| `session_compact` | 压缩完成后 | 否 | 记录压缩统计、通知用户 |
| `session_shutdown` | 会话终止之前 | 否 | 清理、最终导出、状态持久化 |

#### 工具执行

| Hook | 触发时机 | 可覆盖 | 典型用途 |
|------|---------|--------|---------|
| `tool_call` | 工具执行**之前** | **是** | 阻止执行、请求额外批准 |
| `tool_result` | 工具执行**之后** | **是** | 修改输出、更改错误状态 |

#### 自动化/通知

| Hook | 触发时机 | 可覆盖 | 典型用途 |
|------|---------|--------|---------|
| `auto_compaction_start` | 自动压缩开始 | 否 | 通知用户触发原因 |
| `auto_compaction_end` | 自动压缩结束 | 否 | 清理或恢复 Agent 循环 |
| `todo_reminder` | Agent 发出 TODO 提醒 | 否 | 自定义通知或 UI 更新 |
| `ttsr_triggered` | 流规则触发 | 否 | 模式匹配时的自定义逻辑 |

### 8.2 Hook 阻止机制

```typescript
// tool_call hook 示例：阻止危险命令
pi.on('tool_call', async (event) => {
  if (event.tool === 'bash' && event.args.command.includes('rm -rf')) {
    return { block: true, reason: 'Dangerous command blocked' };
  }
});
```

任何 hook 返回 `{ block: true }` 即可阻止工具执行。

### 8.3 Hook UI 能力

Hook 拥有受限的 UI 接口（防止阻塞 Agent 循环）：

| UI 方法 | 底层组件 | 功能 |
|---------|---------|------|
| `ui.select()` | `HookSelectorComponent` | 可导航列表（支持超时倒计时） |
| `ui.input()` | `HookInputComponent` | 单行文本输入 |
| `ui.editor()` | `HookEditorComponent` | 多行编辑器（Ctrl+G 调外部编辑器） |
| `ui.setStatus()` | statusLine | 页脚状态文本 |

---

## 9. 自定义工具与命令

### 9.1 自定义工具定义

```typescript
// .omp/tools/my-tool/index.ts
export default function(api: CustomToolAPI) {
  return {
    name: 'my_tool',
    parameters: z.object({          // Zod schema
      query: z.string(),
      limit: z.number().optional(),
    }),
    deferrable: true,               // 需要用户审批
    async execute({ query, limit }) {
      const result = await api.exec(`my-command --query "${query}"`);
      if (this.deferrable) {
        api.pushPendingAction({     // 推入待审批队列
          preview: result,
          action: () => applyChanges(),
        });
      }
      return result;
    }
  };
}
```

| 属性 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | LLM 调用工具时使用的唯一标识 |
| `parameters` | Zod/TypeBox schema | 输入参数定义（LLM 可见） |
| `execute` | `async Function` | 执行逻辑 |
| `deferrable` | `boolean` | 为 true 时变更需通过 `resolve` 工具审批 |

### 9.2 Resolve 协议（延迟审批）

`deferrable: true` 的工具不直接执行变更，而是将预览推入待审批队列，强制 LLM 下一轮调用 `resolve` 工具来确认或放弃：

```
自定义工具调用 → pushPendingAction({preview, action})
    → LLM 看到预览结果
    → LLM 调用 resolve({accept: true})
    → action() 执行实际变更
```

这是一个内置的权限门控——延迟工具无法绕过审批直接修改。

### 9.3 自定义 Slash 命令

三层优先级：

```
项目级（最高）:  .omp/commands/<name>/index.ts
用户级（中）:    ~/.omp/commands/<name>/index.ts
内置级（最低）:  核心包中的 commands/
```

同名命令高优先级覆盖低优先级。

命令上下文提供会话级控制：

| Action | 功能 |
|--------|------|
| `reload` | 重置会话并重新渲染 |
| `newSession` | 销毁当前会话并启动新会话 |

### 9.4 工具拦截

`ExtensionToolWrapper` 允许拦截已有工具的行为：

```typescript
// 拦截所有 edit 工具调用，记录日志
pi.wrapTool('edit', {
  async onToolCall(call) {
    console.log(`Editing: ${call.args.file_path}`);
    return call;  // 继续执行；返回 { block: true } 则阻止
  },
  async onToolResult(result) {
    console.log(`Edit result: ${result.status}`);
    return result;  // 可修改返回值
  }
});
```

---

## 10. MCP 集成配置

### 10.1 MCP Server 发现

| 位置 | 范围 | 文件 |
|------|------|------|
| `~/.omp/mcp.json` | 全局用户级 | 用户所有项目共享 |
| `.omp/mcp.json` | 项目级 | 仅当前项目 |
| `.claude/`、`.cursor/` 等 | 继承其他工具 | 自动发现 |
| Smithery 搜索 | 在线 | `/mcp smithery-search` |

### 10.2 MCP Server 配置

```json
{
  "servers": {
    "my-mcp": {
      "type": "stdio",
      "command": "npx @my-org/mcp-server",
      "enabled": true,
      "auth": {
        "type": "api-key",
        "key": "${MY_MCP_API_KEY}"
      }
    },
    "remote-mcp": {
      "type": "http",
      "url": "https://mcp.example.com/v1",
      "auth": {
        "type": "oauth",
        "clientId": "...",
        "scopes": ["read", "write"]
      }
    }
  }
}
```

| 传输类型 | 通信方式 |
|---------|---------|
| `stdio` | 启动子进程，stdin/stdout JSON-RPC 2.0 |
| `http` | POST 请求 JSON-RPC，`Mcp-Session-Id` 管理会话 |
| `sse` | 持久 GET 连接接收推送 |

环境变量通过 `expandEnvVarsDeep` 自动展开（如 `${MY_API_KEY}`）。

### 10.3 工具命名与排序

- **命名**：`mcp__<server_name>_<tool_name>`，自动去除冗余前缀
- **排序**：`sortMCPToolsByName` 维护全局稳定排序，防止连接顺序变化导致 Anthropic prompt cache 失效

### 10.4 交互式管理

| 命令 | 功能 |
|------|------|
| `/mcp list` | 显示所有服务器及状态 |
| `/mcp add` | 多步骤 TUI 向导添加服务器 |
| `/mcp test <name>` | 测试连接并列出工具 |
| `/mcp reload` | 强制重新发现和重连 |
| `/mcp smithery-search` | 搜索 Smithery 社区服务器 |

`MCPAddWizard` 通过 `analyzeAuthError` 自动检测服务器是否需要 OAuth 或 API Key。

---

## 11. Web 搜索配置

### 11.1 14 个搜索后端

omp 的 `web_search` 工具支持 14 个搜索后端，通过环境变量配置：

| 后端 | 环境变量 | 说明 |
|------|---------|------|
| Exa | `EXA_API_KEY` 或 MCP | 高质量搜索 |
| Brave | `BRAVE_API_KEY` | 隐私搜索 |
| Jina | `JINA_API_KEY` | AI 搜索 |
| Kimi | — | 集成搜索 |
| Anthropic | — | 内置搜索 |
| Perplexity | — | AI 搜索引擎 |
| Gemini | — | Google 搜索集成 |
| Tavily | — | 结构化搜索 |
| ... | ... | 共 14 个 |

### 11.2 搜索模式

```yaml
web_search:
  enabled: true
  provider: auto      # 按链式顺序尝试所有可用后端
  # 或指定单一后端
  # provider: exa
```

`auto` 模式按预定义顺序逐一尝试已配置的后端。

### 11.3 专用内容处理器

系统为特定域名提供专用解析器，将 HTML 转化为结构化 Markdown：

| 域名 | 处理方式 |
|------|---------|
| GitHub | 代码/Issue/PR 结构化 |
| npm / PyPI / crates.io | 包信息提取 |
| arXiv | 论文摘要提取 |
| Stack Overflow | 问答结构化 |
| MDN | 文档格式化 |
| NVD / OSV / CISA KEV | 漏洞信息结构化 |

---

## 12. 编辑模式配置

### 12.1 三种编辑模式

```yaml
edit:
  mode: hashline      # hashline | replace | patch
  fuzzyMatch: true     # 模糊文本匹配
  fuzzyThreshold: 0.8  # 匹配阈值
```

| 模式 | 原理 | 优势 | 劣势 |
|------|------|------|------|
| `hashline` | 每行标记内容哈希，编辑引用哈希而非行号 | 多 Agent 安全、防并发冲突、成功率最高 | Token 开销略高 |
| `replace` | 精确文本匹配替换（类似 str_replace） | 简单直接 | 空白敏感、易失败 |
| `patch` | 统一 diff 补丁格式 | 与 git 生态兼容 | 模型不熟悉此格式时失败率高 |

可通过环境变量覆盖：`PI_EDIT_VARIANT=replace`

### 12.2 LSP 集成

```yaml
lsp:
  enabled: true
```

编辑工具自动集成 LSP 诊断信息，在修改文件后通过 `DiagnosticMeta` 反馈编译错误/警告。

---

## 13. 记忆系统（Hindsight）配置

### 13.1 三个记忆工具

| 工具 | 功能 | 默认状态 |
|------|------|---------|
| `retain` | 写入持久化事实 | 需启用 |
| `recall` | 搜索记忆库 | 需启用 |
| `reflect` | 综合分析记忆 | 需启用 |

```yaml
# 启用记忆系统
retain:
  enabled: true
recall:
  enabled: true
reflect:
  enabled: true
```

### 13.2 作用域

- **项目级**：默认隔离，某项目的记忆不会泄漏到其他项目
- **会话压缩**：每个会话结束时压缩为 "mental model"，在下次会话首轮加载

---

## 14. UI 与外观配置

```yaml
theme:
  dark: titanium       # 深色终端主题
  light: light         # 浅色终端主题

symbolPreset: unicode  # unicode | nerd | ascii
colorBlindMode: false  # true 时用蓝色替代绿色表示"添加"
```

### 14.1 自动主题映射

`setAutoThemeMapping` 可根据终端背景自动切换深色/浅色主题。

### 14.2 Nerd Font 支持

`symbolPreset: nerd` 启用 Nerd Font 图标，需终端安装 Nerd Font。

---

## 15. 权限与审批系统

### 15.1 三层审批等级（Tiers）

| Tier | 范围 | 示例工具 |
|------|------|---------|
| `read` | 数据访问 | `ls`、`cat`、`read` |
| `write` | 文件修改 | `edit`、`write` |
| `exec` | 代码执行 | `bash`、`python` |

### 15.2 四种审批模式

```yaml
tools:
  approvalMode: yolo   # always-ask | write | yolo | auto
```

| 模式 | read | write | exec |
|------|------|-------|------|
| `always-ask` | 自动 | 提示 | 提示 |
| `write` | 自动 | 自动 | 提示 |
| `yolo` | 自动 | 自动 | 自动 |

### 15.3 危险操作强制提示

工具可设置 `override` 标志（如 `rm -rf /` 模式匹配），即使在宽松模式下也强制提示——**但 `yolo` 模式仍会绕过**，除非用户策略显式设为 `prompt` 或 `deny`。

### 15.4 ACP 模式权限

Agent Control Protocol 模式下，破坏性工具通过 `session/request_permission` 请求权限，由编辑器（如 Zed）的 UI 代理审批。

---

## 16. 运行模式配置

### 16.1 四种运行模式

| 模式 | CLI 参数 | 用途 |
|------|---------|------|
| Interactive (TUI) | 默认 | 完整终端 UI |
| RPC | `--mode rpc` | NDJSON over stdio，编程控制 |
| Print | `--mode text\|json` | 单次执行，输出文本或 JSONL |
| ACP | `--mode acp` | Agent Control Protocol，编辑器集成 |

### 16.2 压缩策略

```yaml
compaction:
  enabled: true
  strategy: context-full   # context-full | handoff | off
  thresholdPercent: -1     # -1 = legacy reserve mode
```

| 策略 | 行为 |
|------|------|
| `context-full` | 压缩旧内容，保留完整上下文 |
| `handoff` | 压缩后切换到更大上下文的模型 |
| `off` | 禁用自动压缩 |

---

## 17. 总结：可配置化架构的设计模式

### 17.1 核心设计模式

| 模式 | 实现 | 效果 |
|------|------|------|
| **分层覆盖** | 默认→全局→项目→运行时 | 不同粒度的定制需求 |
| **Schema 驱动** | `SETTINGS_SCHEMA` 定义所有配置项的类型和默认值 | 类型安全 + 自动生成 UI |
| **多来源发现** | 扫描 8 种竞品格式的配置目录 | 零迁移成本 |
| **Setting-Gating** | 高级工具默认关闭，`*.enabled: true` 显式启用 | 渐进式暴露复杂度 |
| **角色路由** | 按任务类型（default/smol/slow/plan）选择模型 | 语义解耦 |
| **路径绑定** | `pathPrefixes` 按目录覆盖配置 | 按项目差异化 |
| **Hook 拦截** | `tool_call`/`tool_result` 可覆盖 | 行为可编程 |
| **Resolve 协议** | `deferrable` 工具强制审批 | 安全门控 |
| **URI 资源引用** | `skill://`、`rule://`、`memory://` | 松耦合组合 |
| **TTSR 流规则** | 正则匹配模型输出并中断重试 | 实时行为修正 |

### 17.2 可配置维度全景图

```
Oh My Pi 可配置维度
├── 模型层
│   ├── Provider 配置（models.yml）
│   ├── 角色路由（default/smol/slow/plan/commit）
│   ├── Fallback 链
│   ├── 路径级覆盖
│   ├── 凭据轮换
│   └── 本地模型自动发现
├── 工具层
│   ├── 工具启用/禁用（setting-gated）
│   ├── 工具集锁定（--tools）
│   ├── 工具发现模式（dynamic/static）
│   ├── 自定义工具（CustomToolAdapter）
│   ├── 工具拦截（ExtensionToolWrapper）
│   └── MCP 工具（自动桥接）
├── 规则层
│   ├── AGENTS.md 发现（3 层深度，200 文件上限）
│   ├── 多格式规则继承（Cline/Cursor/Windsurf）
│   ├── TTSR 流规则（正则匹配 → 中断 → 注入 → 重试）
│   ├── SYSTEM.md 完全替换
│   └── URI 资源引用
├── 扩展层
│   ├── 自定义 Slash 命令（3 层优先级）
│   ├── 自定义工具（Zod/TypeBox schema）
│   ├── Hook 系统（10 个事件，2 个可覆盖）
│   ├── Marketplace 安装
│   └── 热重载（/reload-plugins）
├── 搜索层
│   ├── 14 个搜索后端
│   ├── auto 链式路由
│   └── 专用内容处理器
├── 编辑层
│   ├── 编辑模式（hashline/replace/patch）
│   ├── 模糊匹配
│   └── LSP 集成
├── 记忆层
│   ├── retain/recall/reflect 工具
│   ├── 项目级隔离
│   └── 会话压缩与加载
├── UI 层
│   ├── 主题（深色/浅色）
│   ├── 符号集（unicode/nerd/ascii）
│   └── 色盲模式
├── 权限层
│   ├── 审批模式（always-ask/write/yolo）
│   ├── 三层审批等级（read/write/exec）
│   ├── 危险操作强制提示
│   └── ACP 编辑器代理审批
└── 运行层
    ├── 四种运行模式（TUI/RPC/Print/ACP）
    ├── 压缩策略（context-full/handoff/off）
    └── 子 Agent 并发数
```

---

> **总结：Oh My Pi 的可配置化架构建立在三个核心机制之上——(1) Schema 驱动的分层配置系统提供类型安全的配置访问和合并；(2) 多来源发现机制实现零迁移成本的竞品配置继承；(3) 扩展系统通过 Hook/工具注册/命令注册提供运行时可编程性。这三者共同构成了一个"渐进式暴露"的体验——默认值覆盖 90% 的场景，但每个维度都留有深度自定义的口子，从简单的 YAML 键值对到完整的 TypeScript 扩展模块。**
