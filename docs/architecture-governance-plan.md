# ZY Code 规范统一与架构治理执行计划

## 当前执行状态（2026-07-15）

> 本文件保留 P0～P8 的历史治理记录。2026-07-15 的复审发现，部分“完成”状态只代表
> 当时门禁未新增债务，不代表现行规范已经完全满足。剩余债务、检查器缺口和后续执行顺序见
> [架构规范剩余债务清零方案](architecture-compliance-remediation-plan.md)。

本节记录实际落地状态，避免把“检查命令通过”误解为“历史债务已清零”。

| 阶段 | 状态 | 已落实 | 尚未清零的历史债务 |
|---|---|---|---|
| P0 | 完成 | 文档、Biome 版本、API snapshot、测试数据目录隔离 | 无 |
| P1 | 完成 | 架构/i18n/locale 门禁、精确债务基线、只读 quality scripts | 基线仅允许递减 |
| P2 | 完成 | 顶层 i18n、双语 key、快捷键 action 类型 | 硬编码文案仍应随业务修改持续审计 |
| P3 | 完成 | Tool profile 与结构检查；移除无实现的 phantom tools | 历史 Tool 主文件命名由 profile 规则豁免 |
| P4 | 部分完成 | hooks/permissions/plugins 旧入口删除；settings、session-state、file-search 等领域迁出 utils | `utils` 仍有 66 个 IO、117 个实现依赖基线项 |
| P5 | 部分完成 | 普通领域目录已改为 kebab-case；生成代码与 BCP 47 locale 使用精确豁免 | 文件命名检查错误放行 kebab-case 普通模块，仍需重新建立真实清单 |
| P6 | 部分完成 | Runtime Context 已进入既有服务/组件消费者调用链；服务/组件直连 bootstrap state 为 0；AppState 五 slice 已组合 | 独立 ReplStore 与“共享状态统一进入 AppStateStore”规则冲突；bootstrap 兼容实现仍是默认后端 |
| P7 | 完成 | services→components/screens/ink 与 types→实现层新增违规为 0 | 无新增反向依赖 |
| P8 | 完成 | 10 个热点均已切换到职责子模块；React 实现不超过 800 行，普通 service/command 实现不超过 1,200 行；原入口保持稳定公开 API | 无 |

最新复审门禁结果：架构检查共报告 324 条存量债务，相对 335 条基线已消除 11 条；
其中 `rootFile` 17、`utilsDep` 116、`utilsIO` 66、`utilsI18n` 8、`utilsOutput` 6、
`featureMacro` 111。`as any` 仍为 746 处，其中 714 处位于非适配层。P8 当时的完整测试、
构建与启动结果仍保留在本阶段执行记录中。

## 一、执行目标

完成后应满足：

1. `AGENTS.md`、架构文档、实际目录和 CI 检查保持一致。
2. 每个领域只有一个正式实现位置和一个公开导入路径。
3. `src/utils/` 只包含无 IO、无状态、无业务语义的纯函数。
4. 服务层不依赖 React、Ink 或组件实现。
5. 类型层不依赖服务、状态和 UI 实现。
6. UI 状态、运行时状态、持久化设置有明确边界。
7. i18n 双语 key 完全对称，不允许用户文案绕过翻译。
8. Tool 目录根据工具类型采用明确结构。
9. 新增架构债务会被自动检查阻止。
10. 以下命令全部通过：

```powershell
bun run format:check
bun run lint
bun run lint:i18n
bun run lint:architecture
bun tsc --noEmit
bun test
```

## 二、执行总则

### 2.1 开始前检查

执行模型首先运行：

```powershell
git -c safe.directory=E:/ProjectCollection/TSProjects/zy-code status --short
git -c safe.directory=E:/ProjectCollection/TSProjects/zy-code branch --show-current
```

当前审计时已知用户改动包括：

```text
M  .zy/settings.local.json
M  src/components/ScrollKeybindingHandler.tsx
?? .claude/settings.local.json
```

开始执行时必须重新检查，不能假设上述列表仍然完整。

要求：

- 不覆盖、不格式化、不暂存无关用户改动。
- 不使用 `git reset --hard`、`git checkout --`。
- 每次只处理一个明确批次。
- 不进行大范围搜索替换后直接提交。
- Windows 下仅大小写变化的目录重命名必须经过临时名称：

```powershell
git mv src/services/AgentSummary src/services/agent-summary-tmp
git mv src/services/agent-summary-tmp src/services/agent-summary
```

### 2.2 每个批次的验证顺序

每次修改后至少执行：

```powershell
bun run format
bun tsc --noEmit
bun test <本批次相关测试>
```

每个阶段结束执行：

```powershell
bun run format:check
bun run lint
bun run lint:i18n
bun run lint:architecture
bun tsc --noEmit
bun test
```

如果某个命令在当前阶段尚未创建，应在阶段总结中明确标记“尚不可用”，不能伪报通过。

### 2.3 重构原则

- 结构重构和行为修改分开提交。
- 移动文件时先保持内容不变。
- 兼容转发文件只允许临时存在，并应在同一阶段删除。
- 不为了满足规范创建空 `UI.tsx`、空 `prompt.ts`。
- 不引入新的外部依赖。
- 新注释使用中文，标识符保持英文。
- 用户可见文本必须走 i18n。
- 相对导入必须带 `.js`。
- 修改 LLM 类型或适配器后必须运行全量测试。
- 每个阶段结束都要记录债务数量的变化，确保只减不增。

## 三、阶段 0：建立真实基线

目标：先让检查结果可信，避免后续重构在失效门禁上进行。

预计 2～4 天。

### P0-01 修正规范文档矛盾

修改：

- `AGENTS.md`
- `docs/architecture.md`

具体操作：

1. 删除“本项目未配置测试运行器”。
2. 明确测试命令是 `bun test`。
3. 更新 `utils/sessionStorage.ts` 描述：它目前是兼容入口，不再是 5,000 行实现。
4. 更新 `utils/hooks` 描述，明确其中大部分是迁移期转发。
5. 增加“正式路径与兼容路径”章节。
6. 增加目录和文件命名规则。
7. 明确 Tool 不再统一强制三文件，而是按工具档案分类。
8. 明确 `bootstrap/state` 是迁移中的运行时状态入口，不应继续新增消费者。

验收：

- 文档不存在测试规范冲突。
- 文档中的路径全部真实存在。
- 文档不再把兼容转发目录描述为正式实现。

### P0-02 固定 Biome 版本和脚本语义

修改：

- `package.json`
- `biome.json`
- `bun.lock`

具体操作：

1. 将 `@biomejs/biome` 从范围版本改为精确版本。
2. 精确版本应与实际运行版本一致。
3. 更新 `biome.json` 的 `$schema`。
4. 将检查和修复命令分开：

```json
{
  "scripts": {
    "format": "biome format --write .",
    "format:check": "biome format .",
    "lint": "biome check .",
    "lint:fix": "biome check --write ."
  }
}
```

5. 不允许 `lint` 或 CI 命令隐式修改文件。
6. 修复当前格式检查报告的文件。
7. 分批处理当前 Biome 错误，不要一次自动应用所有 unsafe fix。

验收：

```powershell
bun run format:check
bun run lint
```

两者必须只读且退出码为 0。

### P0-03 修复真实测试回归

优先处理以下真实失败：

1. API snapshot 中 `stripAdvisorBlocks` 基线不一致。
2. `server_tool_use_input_tokens` 未映射到 `extras.serverToolUseInputTokens`。
3. `content_block_start.server_tool_use` 被错误降级为 text。
4. `EMPTY_USAGE.server_tool_use.web_search_requests` 缺失。

重点文件：

- `src/services/api/conversions/anthropic.ts`
- `src/types/llm.ts`
- `tests/services/api/anthropicConversion.test.ts`
- `tests/services/api/emptyUsage.test.ts`
- `tests/api-snapshot/`

执行要求：

1. 先确认实现还是测试代表正确契约。
2. 以 `src/types/llm.ts` 标准类型为准。
3. SDK snake_case 只能停留在转换层。
4. 不得简单删除失败断言。
5. API snapshot 仅在确认公开 API 变更合理后更新。

验收：

```powershell
bun test tests/services/api/anthropicConversion.test.ts
bun test tests/services/api/emptyUsage.test.ts
bun test tests/api-snapshot/check.test.ts
bun tsc --noEmit
```

### P0-04 隔离测试文件系统

当前部分测试直接写入真实用户目录下的 `.zy`，涉及：

- task CAS
- orphan recovery
- hibernate snapshot
- external tool result

执行步骤：

1. 找到所有用户目录计算入口。
2. 抽象一个可注入的数据根目录。
3. 正式环境默认仍使用真实 ZY 数据目录。
4. 测试环境使用 `tests/_helpers/` 下的临时目录 helper。
5. 每个测试使用唯一目录。
6. `afterEach` 清理测试目录。
7. 测试不得修改真实 HOME、`.zy`、项目 `.zy/settings.local.json`。
8. 优先通过依赖注入或项目已有环境变量完成，不新增第三方库。

建议新增：

```text
tests/_helpers/testDataDirectory.ts
```

测试名必须使用中文。

验收：

```powershell
bun test tests/utils/tasks.cas.test.ts
bun test tests/services/task/orphanRecovery.test.ts
bun test tests/services/swarm/hibernateSnapshot.test.ts
bun test tests/services/swarm/externalToolResult.test.ts
bun test
```

## 四、阶段 1：把规范变成自动检查

目标：先阻止新增债务，再逐步减少存量。

预计 3～6 天。

### P1-01 新增架构检查脚本

建议新增：

```text
scripts/lint-architecture.ts
scripts/architecture-debt-baseline.json
```

使用现有 TypeScript API 或文本扫描，不引入依赖。

脚本至少检查以下内容。

#### A. `src/` 根文件

建立当前允许列表，例如：

```text
main.tsx
macro.d.ts
```

历史根文件暂时进入 debt baseline，但禁止新增。

#### B. `utils` 边界

正式规则：

- 禁止导入 `node:fs`、`node:child_process`、网络库、进程库。
- 禁止依赖 `services`、`components`、`screens`、`tools`、`state`。
- 禁止调用 i18n。
- 禁止终端输出和用户可见行为。

存量违规先记录 baseline；CI 要求：

```text
当前违规数量 <= baseline
```

任何新增违规直接失败。

#### C. 层间依赖

禁止：

```text
services -> components
services -> screens
services -> ink
types -> services
types -> components
types -> state
```

需要暂时保留的路径进入精确到文件的白名单，不能使用整个目录白名单。

#### D. 导入后缀

相对导入必须以以下后缀之一结束：

```text
.js
.json
.node
.wasm
```

#### E. `feature()` 宏

禁止：

```ts
const enabled = feature('X')
feature('X') && run()
if (feature('X') && condition) {}
```

允许：

```ts
if (feature('X')) {
  if (condition) {
    run()
  }
}

const value = feature('X') ? enabledValue : disabledValue
```

#### F. `as any`

- 统计每个文件的 `as any` 数量。
- 适配层之外新增 `as any` 直接失败。
- 存量使用精确 baseline。
- 每次修改相关文件时应减少或保持数量，不能增加。

### P1-02 增加命名检查

统一规则：

- 普通多词目录：`kebab-case`
- React 组件目录：`PascalCase`
- Tool 目录：`PascalCaseTool`
- React 组件文件：`PascalCase.tsx`
- Hook：`useXxx.ts` 或 `useXxx.tsx`
- 普通模块：`camelCase.ts`
- 测试文件：`*.test.ts` 或 `*.test.tsx`

暂时豁免：

- 生成代码。
- 平台原生镜像代码。
- 第三方兼容代码。
- 已进入明确 baseline 的历史文件。

### P1-03 将架构检查接入 package scripts

建议：

```json
{
  "scripts": {
    "lint:architecture": "bun scripts/lint-architecture.ts",
    "quality": "bun run format:check && bun run lint && bun run lint:i18n && bun run lint:architecture && bun tsc --noEmit && bun test"
  }
}
```

Windows 环境下如果组合命令不稳定，应创建 Bun 编排脚本，不要依赖平台专属 shell 行为。

验收：

```powershell
bun run lint:architecture
```

必须输出：

- 当前债务数量。
- 新增债务数量。
- 每条违规的文件和行号。
- 退出码是否通过。

## 五、阶段 2：修复 i18n

目标：双语资源完全对称，用户可见文本无法绕过翻译。

预计 3～7 天。

### P2-01 修复顶层翻译调用

审计时已知文件：

```text
src/commands/resume/index.ts
src/commands/tui/index.ts
src/commands/workflows/index.ts
src/components/AutoModeOptInDialog.tsx
```

处理方式：

- 命令描述改为调用期 getter。
- 静态配置存 `messageKey`，使用时执行 `tSync()`。
- 组件常量移入组件或函数。
- 不在模块初始化阶段调用 `t()`/`tSync()`。

验收：

```powershell
bun run lint:i18n
```

### P2-02 修复双语 key 不对称

审计时状态：

- 英文 2,737 keys。
- 中文 2,750 keys。
- 英文侧缺中文 33 个。
- 中文侧缺英文 46 个。

操作：

1. 为所有缺失 key 补齐翻译。
2. 不允许用 key 自身作为占位翻译。
3. 检查插值变量完全一致。
4. 将 `powerupFrames.ts` 纳入两个语言聚合入口，或确认无用后删除两侧文件。
5. 删除重复的 `statusLine.disabled` 和 `statusLine.enabled`。

### P2-03 新增翻译资源一致性检查

新增脚本或扩展现有 i18n lint，检查：

- 双语 key 集合一致。
- 相同 key 不重复声明。
- 插值变量集合一致。
- locale 子目录文件必须被聚合。
- 禁止未使用的 locale 分组文件。

### P2-04 清理硬编码用户文案

按目录分批：

1. `src/assistant`
2. `src/commands`
3. `src/components`
4. `src/tools`
5. `src/services` 中产生用户输出的模块

每批步骤：

1. 找到明确用户可见字符串。
2. 按前缀放入正确 locale 文件。
3. 同时添加英文和中文。
4. 替换为 `tSync()` 或 `t()`。
5. 运行相关测试。

不要翻译：

- 日志内部字段名。
- API 协议值。
- 命令行参数。
- 文件路径。
- 专有名词。
- 测试 fixture 中明确模拟的原始协议文本。

### P2-05 收紧快捷键 action 类型

修改 `src/components/design-system/KeyboardShortcutHint.tsx`。

目标形式：

```ts
const actionKeyMap = {
  // ...
} as const

export type KeyboardShortcutAction = keyof typeof actionKeyMap

type Props = {
  shortcut: string
  action: KeyboardShortcutAction
}
```

删除未注册 action 直接显示原字符串的 fallback，或仅在开发模式抛出清晰错误。

验收：

```powershell
bun tsc --noEmit
bun run lint:i18n
```

## 六、阶段 3：统一 Tool 结构

目标：规范反映真实工具类型，不制造空文件。

预计 3～5 天。

### P3-01 定义工具档案

在 Tool 公共类型中增加：

```ts
type ToolProfile = 'interactive' | 'headless' | 'internal'
```

规则如下。

#### interactive

必须具有：

```text
ToolName.ts(x)
UI.tsx
prompt.ts
```

#### headless

必须具有：

```text
ToolName.ts
prompt.ts
```

`UI.tsx` 可选。

#### internal

必须具有：

```text
ToolName.ts
```

允许无 prompt、无 UI，但必须显式声明为 internal。

### P3-02 修复非标准目录

逐个处理当前不符合目录。

优先确认：

- 主文件是否在其他文件中。
- 是否只是注册器引用不同文件名。
- 是否确实需要 UI。
- 是否确实面向 LLM prompt。
- 是否是测试或共享目录，不应被识别为 Tool。

典型目录：

```text
DiscoverSkillsTool
ScheduleCronTool
TerminalCaptureTool
WebBrowserTool
WorkflowTool
TaskCreateTool
TaskGetTool
TaskListTool
TaskUpdateTool
```

要求：

- 不添加空文件。
- 文件名必须与 Tool 注册名一致。
- Tool 用户文案走 i18n。
- Tool 常量可放 `constants.ts`。
- Tool 共享实现不能放在某个无关 Tool 目录。

### P3-03 将 Tool 结构加入架构检查

`lint:architecture` 根据 profile 检查文件结构。

验收：

- 所有 Tool 目录均有明确 profile。
- 无结构未知的 Tool。
- 无空 UI/prompt 文件。

## 七、阶段 4：收敛重复领域和兼容入口

目标：每个实现只有一个正式位置。

预计 2～4 周，按领域分别提交。

### P4-01 迁移 `utils/hooks`

正式目标：

```text
src/hooks/                  React hooks
src/services/hooks/         业务 hook 执行系统
```

步骤：

1. 统计所有 `src/utils/hooks/*` 的消费者。
2. 将正式实现统一到 `services/hooks`。
3. 更新生产代码导入。
4. 更新测试路径，使测试镜像正式路径。
5. 删除 `utils/hooks` 转发文件。
6. 更新 API snapshot。
7. 更新架构文档。

验收：`src/utils/hooks` 应不存在，或只保留明确的纯函数且不依赖服务。

### P4-02 迁移 `utils/permissions`

正式目标：

```text
src/services/permissions/
```

特别注意：

- 权限规则是业务语义，不能留在 `utils`。
- shell 解析逻辑应与 `shell-eval` 明确分工。
- 不改变权限默认行为。
- 先补充权限回归测试，再移动实现。

### P4-03 迁移 `utils/plugins`

正式目标：

```text
src/services/plugins/
```

处理：

- marketplace
- plugin loader
- dependency resolver
- install state
- MCP/plugin integration

删除 `utils/plugins` 的兼容转发。

### P4-04 处理同名领域

逐一处理：

```text
src/jobs                    vs src/services/jobs
src/plugins                 vs src/services/plugins
src/sessionTranscript       vs src/services/sessionTranscript
src/skillSearch             vs src/services/skillSearch
src/skills                  vs src/services/skills
src/tools                   vs src/services/tools
src/tasks                   vs src/services/task
src/commands                vs src/cli/commands
```

目标命名：

```text
src/commands/                 斜杠命令
src/cli/subcommands/          CLI 子命令
src/tools/                    Tool 定义
src/services/tool-runtime/    Tool 调度和执行
src/tasks/                    Task 类型和领域模型
src/services/task-runtime/    Task 持久化和运行时
src/skills/                   Skill 定义和内置资源
src/services/skill-runtime/   Skill 加载、搜索和执行
```

其他领域采用同样原则：定义/领域模型与运行时/IO 使用不同且明确的名称。

每个领域迁移步骤：

1. 生成消费者清单。
2. 确认正式公开 API。
3. 移动实现。
4. 更新导入。
5. 运行目标测试。
6. 删除旧入口。
7. 全局确认旧路径引用为 0。

验收示例：

```powershell
Get-ChildItem src -Recurse -File |
  Select-String "utils/hooks|utils/plugins|utils/permissions"
```

结果应为 0，文档和迁移说明除外。

## 八、阶段 5：统一目录命名

目标：普通多词目录统一为 `kebab-case`。

预计 1～2 周。

### P5-01 优先重命名 services 目录

建议映射：

```text
AgentSummary          -> agent-summary
MagicDocs             -> magic-docs
PromptSuggestion      -> prompt-suggestion
SessionMemory         -> session-memory
autoDream             -> auto-dream
claudeInChrome        -> claude-in-chrome
computerUse           -> computer-use
contextCollapse       -> context-collapse
deepLink              -> deep-link
extractMemories       -> extract-memories
filePersistence       -> file-persistence
modeInstructions      -> mode-instructions
nativeInstaller       -> native-installer
policyLimits          -> policy-limits
processUserInput      -> process-user-input
remoteManagedSettings -> remote-managed-settings
secureStorage         -> secure-storage
sessionStorage        -> session-storage
sessionTranscript     -> session-transcript
settingsSync          -> settings-sync
skillSearch           -> skill-search
teamMemorySync        -> team-memory-sync
toolUseSummary        -> tool-use-summary
```

执行要求：

- 每次最多重命名 3～5 个目录。
- 使用 `git mv`。
- 同批更新所有导入和测试路径。
- 不同时修改业务逻辑。
- 每批运行全量类型检查。

### P5-02 重命名顶层普通领域目录

候选：

```text
environment-runner
outputStyles
self-hosted-runner
sessionTranscript
skillSearch
```

统一为 kebab-case：

```text
environment-runner
output-styles
self-hosted-runner
session-transcript
skill-search
```

React 组件目录和 Tool 目录不参与此规则。

## 九、阶段 6：治理状态管理

目标：消除服务对巨大全局单例的隐式依赖。

预计 2～4 周。

### P6-01 建立状态分类

将状态分为以下三类。

#### UI State

位置：

```text
src/state/AppStateStore.ts
```

包含：

- 当前界面状态
- 选择状态
- 面板展开状态
- 通知显示状态
- 与 React 渲染直接相关的会话状态

#### Runtime Context

建议位置：

```text
src/bootstrap/runtime/runtimeContext.ts
```

包含接口：

- session identity
- cwd/project root
- model runtime
- telemetry
- cost/token counters
- clock
- filesystem paths
- feature access

#### Persistent Settings

保留在配置/设置服务，不进入 UI store 或 bootstrap 全局变量。

### P6-02 收敛 `bootstrap/state`

步骤：

1. 列出全部 accessor。
2. 按 session/model/cost/token/telemetry/flags 分类。
3. 为每类定义最小接口。
4. 服务构造函数或执行函数显式接收所需接口。
5. 禁止服务直接导入大 barrel。
6. 保留短期兼容 getter，但消费者数量必须持续下降。
7. 最后删除未使用 getter。

优先处理依赖数量最高的服务：

```text
services/api
services/analytics
services/compact
services/hooks
services/attachments
services/config
```

验收指标：

- 服务直接导入旧状态 barrel 的文件数降到 0。
- 组件通过 selector/context 获取状态，不直接读取运行时大 barrel。

### P6-03 拆分 AppStateStore

不要创建多个互不协调的全局 store。

建议按 slice 组织类型和更新器：

```text
src/state/slices/uiSlice.ts
src/state/slices/permissionSlice.ts
src/state/slices/taskSlice.ts
src/state/slices/pluginSlice.ts
src/state/slices/notificationSlice.ts
```

仍由一个 AppStateStore 组合。

要求：

- selector 与更新器放对应 slice。
- 组件不能直接修改嵌套状态。
- 跨组件共享状态禁止回退到组件 `useState`。
- 不把 IO 放进 store。

## 十、阶段 7：修复反向依赖

目标：恢复稳定依赖方向。

预计 1～2 周。

### P7-01 服务层移除 UI 依赖

审计时的典型模块：

```text
services/claudeInChrome/toolRendering.tsx
services/computerUse/toolRendering.tsx
services/processUserInput/processBashCommand.tsx
services/remoteManagedSettings/securityCheck.tsx
services/swarm/It2SetupPrompt.tsx
services/teleport/teleport.tsx
services/tips/tipRegistry.ts
```

处理方式：

- 服务返回结构化结果或 view model。
- React/Ink 渲染移动到 `components` 或对应 Tool 的 `UI.tsx`。
- UI 通过服务接口调用业务逻辑。
- 服务不得返回 `ReactNode`。

### P7-02 类型层移除实现依赖

重点：

```text
src/types/command.ts
src/types/hooks/runtime.ts
src/types/llm.ts
```

处理方式：

- 稳定契约放入 `src/types`。
- 服务实现导入契约。
- 类型层不能从服务实现反向提取类型。
- 必要类型从服务文件移动到 `types` 或领域 `types.ts`。
- schema helper 若为纯函数可以保留在纯 schema 层。

验收：

```text
types -> services/components/state/tools
```

依赖数量为 0。

## 十一、阶段 8：拆分大文件

目标：降低修改冲突和单文件认知负担。

应在目录和依赖边界稳定后执行。

### P8-01 优先级

第一批：

```text
src/components/PromptInput/PromptInput.tsx
src/bridge/bridgeMain.ts
src/services/plugins/pluginLoader.ts
src/services/plugins/marketplaceManager.ts
src/services/attachments/attachments.ts
```

第二批：

```text
src/services/api/llmOrchestrator.ts
src/commands/insights.ts
src/cli/commands/root.ts
src/services/mcp/auth.ts
src/services/mcp/client.ts
```

Parser 类文件单独评估，不按普通业务文件机械拆分：

```text
src/shell-eval/bash/bashParser.ts
src/shell-eval/bash/ast.ts
src/shell-eval/powershell/parser.ts
```

### P8-02 拆分方法

每个文件执行：

1. 先补关键行为测试。
2. 绘制文件内职责清单。
3. 区分 types、constants、pure helpers、IO、orchestration、UI rendering。
4. 每次只提取一个职责。
5. 提取后保持原公开 API。
6. 最后再删除兼容 export。

建议上限：

- React 组件：1,200 行。
- 普通 service/command：1,200 行。
- 纯 utils：800 行。
- Parser、生成代码需显式豁免。

### P8 执行记录（已完成）

- 修改范围：拆分 `PromptInput`、Bridge 主循环、插件加载、市场源管理、附件管线、
  LLM 编排、Insights、根命令启动管线、MCP 认证和 MCP 客户端共 10 个热点。
- 正式路径：实现分别下沉到 `components/PromptInput/`、`bridge/bridge-main/`、
  `services/plugins/plugin-loader/`、`services/plugins/marketplace-manager/`、
  `services/attachments/attachment-pipeline/`、`services/api/llm-orchestrator/`、
  `commands/insights/`、`cli/commands/`、`services/mcp/auth/` 和 `services/mcp/client/`。
- 公开入口：原入口保留为稳定 facade，调用链已转入职责模块，不是只新增未接线的并行实现。
- 行为变化：无对外行为变化；保留原公开 API、启动顺序、提前返回语义和清理生命周期。
- 文件上限：PromptInput 新实现均不超过 800 行；普通 service/command 新实现均不超过
  1,200 行。
- API 快照：快照源切换到正式实现路径，4 项 API snapshot 测试通过。
- 债务数量变化：架构存量债务 335 -> 325；`featureMacro` 121 -> 111；
  `as any` 746 -> 746。
- `bun run format:check`：通过，2,478 个文件无需修复。
- `bun run lint`：通过；仍报告 2,284 条既有 warning 和 2 条 info，不阻断门禁。
- `bun run lint:i18n`：通过，无模块顶层 `t()` / `tSync()` 调用。
- `bun run lint:architecture`：通过，无新增违规，消除 10 条违规。
- `bun tsc --noEmit`：通过。
- `bun test`：1,247 通过、1 跳过、0 失败。
- `bun run build`：通过，生成 `dist/cli.js`。
- `bun dist/cli.js --help`：通过，CLI 入口与命令注册可正常加载。
- 剩余风险：本阶段验证覆盖静态门禁、全量测试、构建和非交互启动；需要真实凭据、远端
  MCP 或交互终端环境的外部集成行为不在本阶段验收范围内。

## 十二、建议提交顺序

每个编号建议单独提交：

```text
1. chore: align governance docs and quality scripts
2. fix: restore anthropic usage conversion tests
3. test: isolate zy data directories
4. feat: add architecture debt ratchet
5. fix: make locale resources symmetric
6. refactor: classify tool directory profiles
7. refactor: move hook runtime out of utils
8. refactor: move permissions out of utils
9. refactor: move plugin runtime out of utils
10. refactor: disambiguate command and tool runtime directories
11. refactor: normalize service directory names
12. refactor: introduce runtime context
13. refactor: remove service-to-ui dependencies
14. refactor: split architecture hotspots
```

不得把“全仓格式化、目录重命名、业务修复”混在同一个提交中。

## 十三、执行记录模板

每完成一个任务，在阶段总结或 PR 描述中使用以下模板：

```markdown
### 任务：P?-??

- 修改范围：
- 正式路径：
- 删除的兼容路径：
- 行为变化：无 / 有，具体说明
- 新增测试：
- 债务数量变化：修改前 -> 修改后
- `bun run format:check`：通过 / 未通过，原因
- `bun run lint`：通过 / 未通过，原因
- `bun run lint:i18n`：通过 / 未通过，原因
- `bun run lint:architecture`：通过 / 未通过，原因
- `bun tsc --noEmit`：通过 / 未通过，原因
- `bun test`：通过 / 未通过，原因
- 剩余风险：
```

## 十四、最终验收清单

- [ ] `AGENTS.md` 无内部矛盾。
- [ ] `docs/architecture.md` 与实际目录一致。
- [ ] Biome 使用精确版本。
- [ ] lint 命令不修改文件。
- [ ] `bun run format:check` 通过。
- [ ] `bun run lint` 通过。
- [ ] `bun run lint:i18n` 通过。
- [ ] `bun run lint:architecture` 通过。
- [ ] `bun tsc --noEmit` 通过。
- [ ] `bun test` 全绿。
- [ ] 测试不写真实 `~/.zy`。
- [ ] 双语 key 完全一致。
- [ ] 无重复翻译 key。
- [ ] 无未聚合 locale 文件。
- [ ] `KeyboardShortcutHint.action` 是受限联合类型。
- [ ] `utils` 无 IO。
- [ ] `utils` 无服务、UI、Tool、状态依赖。
- [ ] 服务不依赖 React、Ink、组件。
- [ ] 类型层不依赖实现层。
- [ ] 相对导入全部带 `.js`。
- [ ] 新增 `as any` 会被拒绝。
- [ ] 非法 `feature()` 写法会被拒绝。
- [ ] 所有 Tool 都有明确 profile。
- [ ] 重复领域入口已经合并或明确区分。
- [x] 服务不再直接依赖已删除的旧状态大 barrel。
- [ ] 没有新增 `src/` 根 `.ts/.tsx` 文件。
- [ ] 用户原有未提交修改未被覆盖或误提交。
