# 开发规范

本文件保存不需要在每次任务中完整加载的详细规范。根目录 `AGENTS.md` 仅保留高频硬约束。

## 注释与国际化

- 注释使用中文，标识符使用英文。编译器指令和 React、Ink、MCP 等专有名词可保留英文。
- 默认注释非显然逻辑、意图和取舍，并匹配周围代码的注释密度。
- 用户界面的固定文案（菜单、按钮、状态、通知、面向用户的错误提示等）禁止硬编码，通过 `tSync()` 或 `t()` 获取。
- 仅供模型消费的指令保持英文，不走 i18n，包括 system prompt、tool prompt、agent 调度指引和工具 schema 的参数说明（如 `.describe(...)`）。不能因为文件已有 `tSync()`，就将同文件中的模型指令也翻译。
- 按文本的实际消费方区分：指导模型填写 `description` 的 schema 说明属于模型指令；模型填写后展示给用户的任务描述属于动态内容，应由 prompt 要求使用用户的语言，不应作为翻译 key。模型输出和用户输入不纳入固定 UI 文案翻译。
- 同一内容若同时用于模型指令和用户界面，应分别提供英文模型说明和经过 i18n 的 UI 文案；调试视图中展示原始 prompt/schema 不改变其模型指令属性。
- 翻译 key 同时加入 `src/i18n/locales/en/` 与 `src/i18n/locales/zh-CN/`。
- 翻译文件按模块前缀归入对应文件；key 使用描述性模块分组并支持 `{count}` 插值。
- `KeyboardShortcutHint.action` 必须在 `actionKeyMap` 注册。

## 格式化与验证

- 使用 Biome：2 空格、100 行宽、单引号、`asNeeded` 分号、尾逗号。
- 修改代码后运行 `bun run format` 和 `bun tsc --noEmit`。
- 测试使用 `bun test`，放在镜像 `src/` 路径的 `tests/` 下。
- `describe` 写模块名，`test` 使用中文描述。
- 修改 LLM 类型或适配器后必须运行完整测试，并确认 lint 无新增问题。

## 架构检查基线

- `bun run lint:architecture` 按具体违规与基线比较；行号用于定位，不作为 AST 规则的身份。
- feature、用户文案、含 `any` 的类型断言使用文件、所属声明、节点内容和重复序号生成标识。新增重复项、跨文件或跨声明移动不能借用原位置的额度。
- TS 和 TSX 按扩展名解析；断言统计包含 `any[]`、`Promise<any>` 等容器类型，不统计注释或字符串。
- 不应为了消除告警直接执行 `--write-baseline`；该选项会接受当前全部债务，只能用于已审查的基线更新。
- 2026-09-21 标识迁移以基线提交 `8bb47522c8ddab985793376318359335ecff2260` 的源码为依据，仅转换旧基线中已登记的项，保留原审批日期。转换 911 条 AST 记录，删除 125 条 TSX 误解析记录和 64 条在该历史源码中已不存在的记录；其余类别保留。断言基线从 56 项转为 54 项，删除的两项均为注释误报。当前源码中新增发现的项未自动纳入基线。

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
- 检查器对非 utils 模块超过 1500 行输出独立审查提示，不计入违规基线；utils 仍执行 800 行硬限制。提示不代表已完成职责审查。
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

`feature('X')` 应位于 `if` 或三元表达式的条件中。允许条件内通过括号、`!`、`&&`、`||` 组合；Bun 能折叠这些表达式并裁剪不可达分支：

```ts
if (feature('X')) {
  // ...
}

const value = feature('X') ? enabled : disabled

const optional = feature('X') || feature('Y') ? require('./optional.js') : null
```

禁止缓存宏结果、传入其他函数或在条件之外用短路表达式承载业务逻辑，以便直接审查可选依赖边界：

```ts
const enabled = feature('X')
feature('X') && run()
if (isEnabled(feature('X'))) run()
```

`feature() ? require(...) : null` 可放在独立 lazy module 中，DCE 仍按 caller 模块生效。

复合条件以 `tests/scripts/featureDce.test.ts` 验证开关组合、依赖裁剪和短路副作用。运行时条件使整个表达式仍可能为真时，对应依赖必须保留；例如 `feature('X') || runtimeEnabled` 不能保证关闭 X 后裁剪模块。

## 禁止事项

- 禁止引入未评估的新外部依赖。
- 禁止在 `dist/` 中手动放置文件。
- 禁止修改 `build.ts` 的 `define` 宏值。
- 禁止通过扩大白名单绕过目录或命名检查；生成代码、第三方镜像、平台镜像和 BCP 47 locale 目录只能精确豁免。
- 禁止无行为转发函数——即仅为保持旧 API 而做的 `import → export` 模式。调用方应直接依赖正式实现。如需统一入口，该入口必须承担编排行为，而不是 re-export。
- 禁止兼容 re-export、空占位文件或两处正式实现并存。
