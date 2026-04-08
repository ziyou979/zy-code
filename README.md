# ZY Code — Source Build

这是 ZY Code CLI 的源码构建版本，基于 [Bun](https://bun.sh) 运行时。

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
# 完整构建（CLI + SDK）
bun run build

# 只构建 CLI
bun run build:cli

# 只构建 SDK
bun run build:sdk
```

构建产物输出到 `dist/`。

### 直接运行源码（开发模式）

开发时可以跳过构建，直接运行源码：

```bash
bun run dev
# 基本等价于：bun src/entrypoints/cli.tsx
```

### 类型检查

```bash
bun tsc --noEmit
```

TypeScript 配置见 `tsconfig.json`，使用 `bundler` 模块解析模式，目标运行时为 `bun-types`。

## 项目结构

```
.
├── src/
│   ├── entrypoints/       # 构建入口（cli.tsx, sdk/, mcp.ts …）
│   ├── cli/               # CLI 命令解析与主循环
│   ├── tools/             # 工具实现（Bash、文件读写、搜索等）
│   ├── components/        # Ink（React）UI 组件
│   ├── services/          # 外部服务集成（API、MCP、LSP …）
│   ├── hooks/             # React hooks
│   ├── utils/             # 通用工具函数
│   └── types/             # 共享类型定义
├── packages/              # Monorepo 子包
│   ├── claude-for-chrome-mcp/
│   ├── computer-use-mcp/
│   └── computer-use-input/
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

以下包在运行时动态加载，不打包进产物：

- `@anthropic-ai/bedrock-sdk` / `vertex-sdk` / `foundry-sdk` — 云厂商 SDK
- `@ant/computer-use-*` — 原生二进制模块
- `@aws-sdk/*`、`sharp`、`yaml` 等懒加载包

如需使用这些功能，确保对应包已安装。

## 配置

ZY Code 通过 `~/.zy/settings.json` 进行配置。配置支持多层级来源（用户、项目、本地、策略），按优先级合并。

### 配置示例

```json
{
  // API 提供商（可选值：anthropic, dashscope, openrouter, generic, ollama, zhipu, kimi）
  "provider": "anthropic",

  // API 密钥（优先级高于环境变量）
  // "apiKey": "sk-xxx",

  // 主对话模型
  "mainLoopModel": "claude-sonnet-4-20250514",

  // 默认模型（作为 fallback）
  "defaultModel": "claude-sonnet-4-20250514",

  // 按能力层级配置模型（best > advanced > standard > compact）
  "models": {
    "best": "claude-opus-4-20250514",
    "advanced": "claude-sonnet-4-20250514",
    "standard": "claude-sonnet-4-20250514",
    "compact": "claude-haiku-4-5-20250514"
  },

  // 快速模式使用的模型
  "fastModel": "claude-haiku-4-5-20250514",

  // 环境变量
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your-api-key-here",
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "DISABLE_TELEMETRY": "1"
  },

  // 语言设置
  "language": "Chinese",

  // 输出风格
  "outputStyle": "concise",

  // 权限配置
  "permissions": {
    "defaultMode": "acceptEdits"
  },

  // Hooks（执行前后钩子）
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "echo 'Session started'"
      }
    ]
  },

  // MCP 服务器配置
  "mcp": {
    "servers": {}
  },

  // 自定义模型（用于模型选择器）
  "customModels": [
    {
      "alias": "qwen-max",
      "model": "qwen-max-latest",
      "label": "Qwen Max",
      "description": "通义千问最大模型"
    }
  ],

  // 会话保留天数（0 表示禁用持久化）
  "cleanupPeriodDays": 30,

  // 快速模式
  "fastMode": false,

  // 思考模式
  "alwaysThinkingEnabled": true,

  // 努力程度（low / medium / high）
  "effortLevel": "medium"
}
```

### 常用配置项

| 配置项 | 类型 | 说明 |
|---|---|---|
| `provider` | string | API 提供商 |
| `apiKey` | string | API 密钥 |
| `mainLoopModel` | string | 主对话模型 |
| `defaultModel` | string | 默认模型 |
| `models` | object | 按能力层级配置模型 |
| `fastModel` | string | 快速模式模型 |
| `language` | string | 语言偏好 |
| `outputStyle` | string | 输出风格 |
| `permissions` | object | 权限配置 |
| `env` | object | 环境变量 |
| `hooks` | object | 钩子配置 |
| `fastMode` | boolean | 是否启用快速模式 |
| `alwaysThinkingEnabled` | boolean | 是否启用思考模式 |
| `cleanupPeriodDays` | number | 会话保留天数 |

### 配置来源优先级

从低到高：
1. **userSettings** — `~/.zy/settings.json`
2. **projectSettings** — `.zy/settings.json`（项目根目录）
3. **localSettings** — `.zy/settings.local.json`（本地，自动加入 .gitignore）
4. **policySettings** — 企业策略配置（最高优先级）

> **注意**: 请勿将包含真实 API Key 的配置文件提交到版本控制。

