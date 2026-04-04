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

## IdeaLab 网关（内网用户）

由于 ZY Code 本身对 SSE 支持比较严格，而 IdeaLab 的 API 是非标准的，所以需要一个网关来转换 API 格式。我们推荐使用 [idea-cc-fix](https://code.alibaba-inc.com/cc-idealab-tools/idea-cc-fix) 将 IdeaLab 非标准 API 转换为 ZY Code 标准 Anthropic API 格式。

**1. 启动网关**

```bash
# macOS Apple Silicon（后台 daemon 模式）
~/idea-cc-fix/dist/idea-cc-fix-darwin-arm64 start

# macOS Intel
~/idea-cc-fix/dist/idea-cc-fix-darwin-x64 start

# Linux x64
~/idea-cc-fix/dist/idea-cc-fix-linux-x64 start
```

网关默认监听 `127.0.0.1:9090`。

**2. 配置 `~/.claude/settings.json`**

```json
{
  "env": {
    "ANTHROPIC_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4_5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4_5",
    "ANTHROPIC_AUTH_TOKEN": "your-api-key",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:9090",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0"
  }
}
```

**3. 运行 / 调试即可。**
