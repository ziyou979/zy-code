# Claude Code — Source Build

这是 Claude Code CLI 的源码构建版本，基于 [Bun](https://bun.sh) 运行时。

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

## 常见问题

**构建报错 `bun:bundle` 相关**
`bun:bundle` 是 Bun 的 bundler 内置模块，仅在打包后的产物中有效。直接 `bun src/entrypoints/cli.tsx` 运行时部分 `feature()` 标志会退化为默认值（false），属于预期行为。

**运行时找不到原生模块**
`@ant/computer-use-input`、`@ant/computer-use-swift` 等包需要平台对应的预编译二进制文件，仅限 macOS。
