# ZY Code — Source Build

ZY Code CLI 的源码构建版本，基于 [Bun](https://bun.sh) 运行时与 [Ink](https://github.com/vadimdemedes/ink)（React 终端 UI）构建。

## 环境要求

- [Bun](https://bun.sh) >= 1.0
- Node.js >= 18（部分工具链依赖）
- macOS / Linux

## 快速开始

```bash
# 安装依赖
bun install

# 构建 CLI
bun run build

# 运行
bun dist/cli.js
```

## 开发工作流

### 构建

```bash
bun run build           # 构建 CLI → dist/cli.js
```

构建产物输出到 `dist/`。

### 开发模式

```bash
bun run dev             # 开发模式（需 --preload 注入 MACRO 等构建时宏）
```

### 类型检查

```bash
bun tsc --noEmit        # 更改代码后必须执行，禁止提交类型错误的代码
```

TypeScript 配置见 `tsconfig.json`，使用 `bundler` 模块解析模式，目标运行时为 `bun-types`。

### 代码格式化

```bash
bun run format          # 使用 Biome 格式化代码
```

配置见 `biome.json`：缩进 2 空格，行宽 100，单引号，`asNeeded` 分号，尾逗号。

## 项目结构

```
.
├── src/
│   ├── entrypoints/       # 构建入口（cli.tsx, sdk/, mcp.ts …）
│   ├── cli/               # CLI 框架：bootstrap、commands、handlers、options、transports
│   ├── commands/          # 斜杠命令（/compact、/goal、/plan、/review 等）
│   ├── tools/             # 工具实现（三文件模式：ToolName.ts + UI.tsx + prompt.ts）
│   ├── components/        # Ink（React）UI 组件
│   ├── screens/           # 顶层页面（REPL.tsx、Doctor.tsx）
│   ├── hooks/             # React hooks
│   ├── services/          # 外部服务集成（API、MCP、LSP、OAuth、沙箱等）
│   ├── shell-eval/        # Shell 解析与执行（bash / powershell）
│   ├── bridge/            # 远程会话桥接（REPL bridge、transport、JWT）
│   ├── coordinator/       # 协调器模式（多 worker 编排）
│   ├── skills/            # 技能系统（内置 + 插件）
│   ├── utils/             # 无业务语义的纯函数 helper（messages/、hooks/ 等子模块）
│   ├── state/             # 全局状态管理（AppStateStore）
│   ├── types/             # 共享类型定义（llm.ts 等）
│   └── i18n/              # 国际化（locales/en/、locales/zh-CN/）
├── packages/              # Monorepo 子包
│   ├── claude-for-chrome-mcp/
│   ├── computer-use-mcp/
│   └── computer-use-input/
├── tests/                 # 测试（路径镜像 src/）
├── build.ts               # Bun bundler 构建脚本
├── dist/                  # 构建产物（不提交）
└── tsconfig.json
```

## 构建宏（MACRO.*）

`build.ts` 在打包时将以下占位符替换为实际值：

| 宏 | 说明 |
|---|---|
| `MACRO.VERSION` | 版本号 |
| `MACRO.BUILD_TIME` | 构建时间戳 |
| `MACRO.PACKAGE_URL` | npm 包名 |
| `MACRO.FEEDBACK_CHANNEL` | 反馈链接 |

## External 依赖

以下包在运行时动态加载，不打包进产物（完整列表以 `build.ts` 中 `external` 数组为准）：

- 原生二进制模块（`@ant/computer-use-*`、`modifiers-napi` 等）
- 懒加载包（`sharp`、`yaml`、`turndown`、`fflate` 等）
- OpenTelemetry 导出器（按用户配置动态加载）

如需使用这些功能，确保对应包已安装。

## 配置

ZY Code 通过 `~/.zy/settings.json` 进行配置。配置支持多层级来源（用户、项目、本地、策略），按优先级合并。

### 配置示例（百炼 DashScope）

```json
{
  "provider": "dashscope",
  "apiKey": "sk-xxxxxxxxxxxxxxxxxxxxxxxx",
  "mainLoopModel": "standard",
  "models": {
    "advanced": "qwen3.6-plus",
    "standard": "qwen3.5-plus",
    "compact": "qwen3.5-flash"
  },
  "language": "Chinese",
  "outputStyle": "concise",
  "permissions": {
    "defaultMode": "acceptEdits"
  },
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "echo 'Session started'"
      }
    ]
  },
  "mcp": {
    "server": {}
  },
  "customModels": [
    {
      "alias": "qwen-max",
      "model": "qwen-max-latest",
      "label": "Qwen Max",
      "description": "通义千问最大模型"
    }
  ],
  "cleanupPeriodDays": 30,
  "fastMode": false,
  "alwaysThinkingEnabled": true,
  "effortLevel": "medium"
}
```

> **百炼配置说明**：
> - `provider: "dashscope"` 自动使用百炼默认 base URL：
>   - OpenAI 格式：`https://dashscope.aliyuncs.com/compatible-mode/v1`
>   - Anthropic 格式：`https://dashscope.aliyuncs.com/apps/anthropic/`
> - 如需自定义 base URL，设置环境变量 `DASHSCOPE_BASE_URL`
> - 百炼支持的模型：`qwen3.6-plus`（推荐）、`qwen3.5-plus`（深度思考）、`qwen3.5-flash`（快速）
> - 百炼深度思考模型的 `reasoning_content` 会自动映射为标准 `thinking` 块

### 常用配置项

| 配置项 | 类型 | 说明 |
|---|---|---|
| `provider` | string | API 提供商（anthropic / dashscope / openrouter / zhipu / kimi / generic / local 等） |
| `apiKey` | string | API 密钥 |
| `mainLoopModel` | string | 主对话 tier（advanced / standard / compact） |
| `models` | object | 按能力层级配置模型 |
| `modelOverrides` | object | 模型 ID 映射（如 Bedrock ARN） |
| `customModels` | array | 自定义模型列表 |
| `language` | string | 语言偏好 |
| `outputStyle` | string | 输出风格 |
| `permissions` | object | 权限配置（allow / deny / ask / defaultMode） |
| `hooks` | object | 钩子配置（PreToolUse / PostToolUse / SessionStart 等） |
| `mcp` | object | MCP 服务器配置 |
| `sandbox` | object | 沙箱配置 |
| `fastMode` | boolean | 是否启用快速模式 |
| `alwaysThinkingEnabled` | boolean | 是否启用思考模式 |
| `effortLevel` | string | 努力程度（low / medium / high） |
| `cleanupPeriodDays` | number | 会话保留天数 |
| `builtInStatusBar` | object | 底部状态栏配置 |
| `autoMemoryEnabled` / `autoDreamEnabled` | boolean | 自动记忆 / 自动 Dream |

### 配置来源优先级

从低到高：
1. **userSettings** — `~/.zy/settings.json`
2. **projectSettings** — `.zy/settings.json`（项目根目录）
3. **localSettings** — `.zy/settings.local.json`（本地，自动加入 .gitignore）
4. **policySettings** — 企业策略配置（最高优先级）

> **注意**: 请勿将包含真实 API Key 的配置文件提交到版本控制。

### model-capabilities.json

路径 `~/.zy/model-capabilities.json`（示例见仓库根 `model-capabilities.example.json`）。按 `pattern` 子串匹配 model id，声明模型的能力、token 上限、定价及附加 beta header。

```json
{
  "models": [
    {
      "pattern": "claude-sonnet-4",
      "capabilities": [
        "thinking", "adaptive_thinking", "structured_outputs",
        "context_management", "prompt_caching", "web_search"
      ],
      "effortLevels": ["low", "medium", "high"],
      "betaHeaders": ["context-management-2025-06-27"],
      "contextWindow": "1m",
      "maxOutputTokens": "64k",
      "costs": {
        "inputTokens": 9,
        "outputTokens": 54
      }
    }
  ]
}
```

