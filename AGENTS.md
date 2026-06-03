# AGENTS.md

本文件为 ZY Code 在本仓库中工作时提供指导与规范约束。

## 规范约束（Spec）

以下规则**必须**严格遵守：

### 1. 语言与注释
- 注释用**中文**，标识符用英文
- 编译器指令（`@ts-ignore` 等）、专有名词（React/Ink/MCP 等）允许英文
- 用户可见文本**禁止硬编码**，必须走 i18n

### 2. 国际化（i18n）
- 通过 `tSync()`/`t()` 读取翻译，翻译 key 同时写入 `en/` 和 `zh-CN/` 对应文件
- 翻译文件按前缀分组到子目录：`src/i18n/locales/en/` 和 `src/i18n/locales/zh-CN/`（如 `commands.ts`、`permissions.ts`、`settings.ts`、`stats.ts`、`mcp.ts`、`summary.ts`、`chat.ts`、`agents.ts`、`session.ts`、`shell.ts` 等）
- key 按模块分组（`shellProgress.xxx`），使用描述性名称，支持 `{count}` 插值
- `KeyboardShortcutHint.action` 必须在 `actionKeyMap` 中注册

### 3. 代码格式化
- 使用 Biome 格式化代码（`bun run format`），配置见 `biome.json`
- 缩进 2 空格，行宽 100，单引号，`asNeeded` 分号，尾逗号

### 4. 构建验证
- 改代码后必须 `bun tsc --noEmit` 通过，禁止提交类型错误的代码

### 5. 工具目录结构
- 三文件模式：`ToolName.ts(x)` + `UI.tsx` + `prompt.ts`

### 6. 状态管理
- 通过 `src/state/AppStateStore.ts` 集中管理，禁止组件内管理共享状态

### 7. 导入规范
- 相对路径必须带 `.js` 后缀

### 8. LLM 标准类型（`src/types/llm.ts`）
- 业务代码一律驼峰平铺（`inputTokens`/`outputTokens`/`stopReason`），**禁止** snake_case
- 类型必须从 `src/types/llm.ts` 导入，**禁止**从 SDK 包直接导入
- snake_case 仅限适配层（`conversions/*`、`bridge/inboundMessages.ts`）
- 消息 4 角色分离，错误用 `LLMError` 系列 + `isAPIError`/`isAbortError` 判断

### 9. 类型安全
- **禁止滥用 `as any`**：优先运行时守卫窄化，必须断言时用具体类型；`as any` 仅限适配层处理 SDK 扩展字段、构造中间对象、第三方类型不完善
- 联合类型调数组方法前必须 `Array.isArray()` 守卫
- switch 需保留 `default` 时，提取鉴别字段为 `const x: string` 避免 unreachable
- `message.ts` 中 `AssistantMessage.message` 必须引用 `LLMAssistantMessage`，禁止用 `LLMMessage` 联合
- 旧格式断言为标准事件类型时，必须 `as unknown as TargetType` 双步断言

### 10. 测试规范
- `bun test`，测试放 `tests/`（路径镜像 `src/`），`describe` 写模块名，`test` 用中文描述
- 改 llm 类型/适配器后必须全绿 + `read_lints` 无新错

### 11. 禁止事项
- 禁止引入未评估的新外部依赖
- 禁止在 `dist/` 中手动放文件
- 禁止修改 `build.ts` 的 `define` 宏值

### 12. 目录边界
- **`src/utils/` 仅放无业务语义的纯函数 helper**：任何牵涉外部 IO（网络 / 文件系统 / spawn）、特定领域知识（auth / billing / mcp / shell 解析等）、用户可见行为（i18n 文案 / 终端输出）的代码必须放 `src/services/<domain>/` 或 `src/<domain>/`，不允许新增到 `utils/`
- **`src/utils/` 单文件行数上限 800**：超出必须按子领域拆分。已有的 `utils/sessionStorage.ts`（5000 行）是历史包袱，新代码不应跟随。`messages/` 和 `hooks/` 已拆分为子目录模块化
- **`src/` 根目录禁止新增 `.ts`/`.tsx` 文件**：现有的 `Tool.ts` / `Task.ts` / `tools.ts` / `query.ts` 等是历史结构，所有新模块必须放在子目录里。入口（`main.tsx` / `commands.ts` 等）已存在，不需要新增

### 13. feature() 宏使用
- bun `feature('X')` 必须直接出现在 `if` / 三元的条件位置才能被构建期 DCE 处理
- ❌ 禁止：`feature('X') && something`、`(feature('X') ? a : b) ?? c`、`const flag = feature('X'); if (flag)`
- ✅ 允许：`if (feature('X')) { ... }`、`feature('X') ? a : b`
- 把 `feature() ? require(...) : null` 模式抽到独立模块（如 `cli/lazyModules.ts`）时，DCE 仍按 caller 模块独立生效，可放心跨模块迁移

## 启动/构建命令

```bash
# 构建
bun run build           # 构建 CLI → dist/cli.js

# 启动
bun run start           # 运行已构建的 CLI（dist/cli.js）
bun run dev             # 开发模式（需 --preload 注入 MACRO 等构建时宏）

# 类型校验（更改代码后必须执行）
bun tsc --noEmit
```

本项目未配置测试运行器，测试通过直接运行 CLI 进行。

## 参考文档

- [架构](docs/architecture.md) — 入口、核心模块、服务层、UI 层、构建流程
- [Feature Flags](FEATURE_FLAGS.md) — 所有 `zy_` 前缀的功能开关与遥测事件
- [配置参考](docs/configuration.md) — settings.json / model-capabilities / 环境变量 / beta header