# 开发规范

本文件保存不需要在每次任务中完整加载的详细规范。根目录 `AGENTS.md` 仅保留高频硬约束。

## 注释与国际化

- 注释使用中文，标识符使用英文。编译器指令和 React、Ink、MCP 等专有名词可保留英文。
- 默认注释非显然逻辑、意图和取舍，并匹配周围代码的注释密度。
- 用户可见文本禁止硬编码，通过 `tSync()` 或 `t()` 获取。
- 翻译 key 同时加入 `src/i18n/locales/en/` 与 `src/i18n/locales/zh-CN/`。
- 翻译文件按模块前缀归入对应文件；key 使用描述性模块分组并支持 `{count}` 插值。
- `KeyboardShortcutHint.action` 必须在 `actionKeyMap` 注册。

## 格式化与验证

- 使用 Biome：2 空格、100 行宽、单引号、`asNeeded` 分号、尾逗号。
- 修改代码后运行 `bun run format` 和 `bun tsc --noEmit`。
- 测试使用 `bun test`，放在镜像 `src/` 路径的 `tests/` 下。
- `describe` 写模块名，`test` 使用中文描述。
- 修改 LLM 类型或适配器后必须运行完整测试，并确认 lint 无新增问题。

## Tool 结构

Tool 必须显式声明 `interactive`、`headless` 或 `internal` 档案：

- `interactive`：`ToolName.ts(x)`、`UI.tsx`、`prompt.ts`。
- `headless`：`ToolName.ts`、`prompt.ts`，`UI.tsx` 可选。
- `internal`：只强制主文件。

禁止为了通过结构检查创建空 `UI.tsx` 或 `prompt.ts`。

## 状态与运行时能力

- 应用共享状态由 `src/state/AppStateStore.ts` 集中管理，组件内不得保存共享状态。
- 领域运行时状态位于 `src/bootstrap/state/`，其 `STATE` 只能由同目录模块访问。
- 外部消费者通过 `src/bootstrap/runtime/runtimeContext.ts` 获取可注入能力，禁止直接导入状态实现。
- 正式业务实现只能有一个位置；兼容文件只能是有删除计划的无状态转发，不得包含缓存、IO 或业务分支。

## 导入与 LLM 类型

- 相对路径必须带 `.js` 后缀。
- 业务 LLM 字段使用驼峰平铺形式，如 `inputTokens`、`outputTokens`、`stopReason`。
- LLM 类型从 `src/types/llm.ts` 导入，禁止从 SDK 包直接导入。
- snake_case 仅限 `conversions/*`、`bridge/inboundMessages.ts` 等适配边界。
- 消息保持四角色分离；错误使用 `LLMError` 系列及 `isAPIError`、`isAbortError` 判断。

## 类型安全

- 优先使用运行时守卫缩窄类型；确需断言时使用具体类型。
- `as any` 仅限 SDK 扩展字段、构造适配层中间对象或第三方类型缺陷。
- 联合类型调用数组方法前使用 `Array.isArray()`。
- switch 保留 `default` 时，可先将鉴别字段提取为 `string`，避免 unreachable。
- `AssistantMessage.message` 引用 `LLMAssistantMessage`，不得改为 `LLMMessage` 联合。
- 旧格式断言为标准事件类型时使用 `as unknown as TargetType` 双步断言。

## 目录边界

- `src/utils/` 只放无业务语义的纯函数 helper。
- 网络、文件系统、spawn 等 IO，auth、billing、MCP、shell 等领域逻辑，以及用户可见行为放入 `src/services/<domain>/` 或对应领域目录。
- `src/utils/` 单文件最多 800 行，超过时按子领域拆分。
- `src/` 根目录禁止新增 `.ts` 或 `.tsx`；新模块必须进入职责明确的子目录。
- 已删除的 `src/utils/hooks/`、`src/utils/permissions/`、`src/utils/plugins/` 不得重建；使用对应 `src/services/` 路径。
- `src/` 中禁止新增 `*Support.ts`/`*Support.tsx` 文件。确有必要时必须经过架构评审，在评审记录中写明领域含义、不能使用更具体名称的原因、负责人和复审/删除条件。

## 模块拆分规则

文件长度仅作为审查信号，不是拆分目标：

- 小文件也可能低内聚（例如 48 行的纯转发壳）；
- 大文件也可能高内聚（例如描述完整异步 generator 状态机的中心编排器，800～1500 行可以接受）；
- 超过约 1500 行时需要记录职责审查结论，但不自动要求拆分；
- 不把"超长文件数量下降"作为架构治理的完成度指标。

候选独立模块必须满足以下五项中的**至少三项**，否则不应拆分：

1. 可以使用业务名称命名，而不是 `Support`、`Helper`、`Common` 或 `Misc`；
2. 公开 API 少量且稳定，调用方不需要了解内部步骤；
3. 可以独立编写行为测试；
4. 依赖集合明显小于原模块；
5. 拥有完整的数据或状态生命周期。

## 命名

- 普通目录全小写，多词目录使用 kebab-case。
- React 组件目录和文件使用 PascalCase，并与主导出名称一致。
- Tool 目录使用 `PascalCaseTool`，主文件与目录同名；配套文件固定为 `UI.tsx`、`prompt.ts`。
- Hook 文件使用 `useXxx.ts(x)`。
- 普通 TypeScript 模块使用 camelCase；缩写按普通单词处理。
- 测试文件使用 `<模块>.test.ts` 或 `<组件>.test.tsx`。
- `index.ts(x)` 仅用于明确包入口，不得隐藏无法说明职责的实现。
- Windows 下仅修改大小写时，先改为临时名称再改为目标名称。
- 重命名同步更新导入、测试、文档和 API snapshot。

## feature 宏

`feature('X')` 必须直接位于 `if` 或三元表达式的条件位置，才能被构建期 DCE：

```ts
if (feature('X')) {
  // ...
}

const value = feature('X') ? enabled : disabled
```

禁止缓存宏结果或把它嵌入复合逻辑：

```ts
const enabled = feature('X')
feature('X') && run()
```

`feature() ? require(...) : null` 可放在独立 lazy module 中，DCE 仍按 caller 模块生效。

## 禁止事项

- 禁止引入未评估的新外部依赖。
- 禁止在 `dist/` 中手动放置文件。
- 禁止修改 `build.ts` 的 `define` 宏值。
- 禁止通过扩大白名单绕过目录或命名检查；生成代码、第三方镜像、平台镜像和 BCP 47 locale 目录只能精确豁免。
- 禁止无行为转发函数——即仅为保持旧 API 而做的 `import → export` 模式。调用方应直接依赖正式实现。如需统一入口，该入口必须承担编排行为，而不是 re-export。
- 禁止兼容 re-export、空占位文件或两处正式实现并存。
