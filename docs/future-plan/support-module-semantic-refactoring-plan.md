# Support 模块语义化重构方案

> 状态：待实施  
> 编写日期：2026-07-21  
> 最近修订：2026-07-22（补充批次准入测试、循环依赖基线、测试工作量与 Support 新增门禁）  
> 适用范围：`src/**/*Support.ts`、`src/**/*Support.tsx` 及其直接调用方  
> 核心目标：以职责、状态所有权和依赖方向为边界，替换机械式 `Support` 拆分；在保持高内聚的前提下控制文件复杂度，而不是追求统一行数上限。

---

## 1. 背景与结论

近期架构治理完成了大量正确的目录迁移：业务逻辑从 `src/utils/` 和 `src/` 根目录进入 `services/<domain>/`、`tools/`、`commands/` 等领域目录，状态和运行时能力也逐步收敛到 `AppStateStore` 与 `runtimeContext`。这些方向应当保留。

问题主要出现在迁移后的第二步：为了降低原文件行数，将连续代码块抽到 `xxxSupport.ts`，原文件再通过导入、别名和转发函数继续暴露旧 API。这样虽然单文件变短，但没有真正降低复杂度，反而增加了以下成本：

- 阅读一条控制流需要在主文件和 Support 文件之间跳转；
- 主文件和 Support 文件共享大量类型、状态与依赖，仍然必须一起修改；
- `Support` 只描述“辅助原文件”，没有表达业务职责；
- 单调用方函数和类型被搬走后失去局部性；
- 为保持旧 API 增加无行为的转发层，形成重复入口；
- 文件长度成为目标，职责清晰度反而成为次要指标。

本方案不主张把所有 Support 文件直接合并回原文件，而是把它们分为三类：

1. **合并或内联**：没有独立职责，仅服务于一个调用点的小片段；
2. **正名并保留**：已经形成稳定能力，只是名称仍带有机械拆分痕迹；
3. **重新设计边界**：Support 和主文件共同组成一个混杂模块，需要按状态机、策略、存储或适配器重新组织。

最终目标不是“所有文件都短”，而是：

- 一个模块只有一个主要变化原因；
- 状态机的控制流集中，策略和 IO 可以替换；
- 文件名能够独立表达领域职责；
- 调用方依赖能力接口，而不是依赖“主文件的辅助实现”；
- 典型改动集中在一个模块或一个领域子目录内；
- 没有永久兼容 re-export、空壳 facade 和重复正式实现。

---

## 2. 当前清单与建议处置

当前共盘点到 21 个 `*Support` 文件。

| 当前文件 | 行数 | 主要调用方 | 结论 | 建议目标 |
|---|---:|---|---|---|
| `bridge/bridge-main/wireLoopSupport.ts` | 87 | wire loop 多入口 | 重新归类 | polling policy 与 session spawner |
| `cli/handlers/pluginListSupport.ts` | 266 | `plugins.ts` | 按展示边界拆分 | list model + presenter |
| `api/llm-orchestrator/streamingSupport.ts` | 1196 | `nonStreaming.ts` | 核心重构 | query state machine |
| `hooks/hookOutputSupport.ts` | 362 | 4 个 hook executor | 正名保留 | `hookOutputParser.ts` |
| `ide/ideExtensionSupport.ts` | 298 | `ide.ts` | 适配器重构 | editor discovery + extension installer |
| `mcp/mcpConfigPolicySupport.ts` | 265 | `config.ts` | 正名并去转发 | `configPolicy.ts` + `configMerge.ts` |
| `mcp/mcpConfigStorageSupport.ts` | 470 | `config.ts` | 存储边界重构 | config sources + parser + repository |
| `mcp/mcpConnectionStateSupport.ts` | 113 | `useManageMCPConnections.ts` | reducer 正名 | `mcpConnectionReducer.ts` |
| `permissions/filesystemPathSupport.ts` | 545 | `filesystem.ts` | 混合职责重构 | internal paths + path policy + scratchpad storage |
| `permissions/permissionContextSyncSupport.ts` | 89 | `permissions.ts` | 正名保留 | `permissionRuleSync.ts` |
| `permissions/permissionDangerousRuleSupport.ts` | 401 | `permissionSetup.ts` | 正名保留 | `dangerousPermissionRules.ts` |
| `permissions/permissionEditingSupport.ts` | 48 | `permissions.ts` | 合并 | `permissionRuleRepository.ts` |
| `permissions/permissionRuleSupport.ts` | 205 | `permissions.ts` | 按查询职责正名 | `permissionRuleQueries.ts` |
| `permissions/yoloClassifierPromptSupport.ts` | 183 | `yoloClassifier.ts` | 正名保留 | `classifierPrompt.ts` |
| `permissions/yoloClassifierTranscriptSupport.ts` | 277 | `yoloClassifier.ts` | 正名保留 | `classifierTranscript.ts` |
| `plugins/validatePluginSupport.ts` | 388 | `validatePlugin.ts` | 按验证对象重构 | manifest validator + content validator |
| `settings/settingsSchemaSupport.ts` | 131 | `types.ts` | 合并到 schema 所有者 | settings policy/MCP schema |
| `swarm/permissionSyncSupport.ts` | 321 | `permissionSync.ts` | 存储边界重构 | protocol + repository |
| `tool-runtime/toolExecutionResultSupport.ts` | 723 | `toolExecution.ts` | 核心重构 | invocation + result lifecycle |
| `BashTool/bashSecurityStringSupport.ts` | 357 | `bashSecurity.ts` | 解析器正名 | shell text scanner |
| `BashTool/bashSecuritySyntaxValidatorSupport.ts` | 736 | `bashSecurity.ts` | 规则模块重构 | syntax/obfuscation rule set |

上述结论是目标方向，不要求一次提交完成全部改造。每个领域必须先补行为测试，再在同一批次中切换消费者并删除旧 Support 文件。

---

## 3. 参考架构：Pi 与 OpenCode 的可借鉴方式

### 3.1 Pi：保留中心对象，只提取稳定能力

Pi 的 coding-agent core 以 `agent-session` 等中心对象承载完整会话生命周期，compaction 则按独立业务能力组织为自己的子目录。它没有把中心对象机械拆成 `agentSessionSupport`、`agentSessionHelpers`，而是保留可连续阅读的控制流，仅将具有稳定输入输出和独立测试价值的能力提取出去。

参考：

- [Pi coding-agent core](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core)
- [Pi compaction 模块](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/compaction)
- [Pi 仓库开发约定](https://github.com/earendil-works/pi/blob/main/AGENTS.md)

适用于 zy-code 的原则：

- query、tool execution、wire loop 等控制流保留一个中心协调器；
- retry、compaction、watchdog、policy 等稳定策略才成为模块；
- 只被调用一次、不能独立命名的 helper 留在使用处；
- 子模块应通过显式参数获得依赖，不反向读取中心对象内部状态。

### 3.2 OpenCode：状态机集中，阶段能力分离

OpenCode 的 session 领域使用 processor 承载中心处理循环，而 retry、revert、status、summary、compaction 等按行为阶段组织。permission 和 tool 也分别作为领域存在，而不是作为 processor 的 Support 文件。

参考：

- [OpenCode session](https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src/session)
- [OpenCode session processor](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/processor.ts)
- [OpenCode permission](https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src/permission)
- [OpenCode tool](https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src/tool)

适用于 zy-code 的原则：

- 状态迁移由 processor/orchestrator 统一决定；
- policy 返回决策，不直接修改 processor 状态；
- repository 负责持久化，不负责业务判定；
- presenter 负责 CLI/UI 输出，不负责加载数据；
- adapter 隔离外部 SDK、编辑器和平台命令。

### 3.3 不照搬目录，只复用边界方法

Pi 和 OpenCode 的技术栈、功能范围与 zy-code 不完全相同。本方案只吸收以下方法：

```text
中心控制流：描述阶段顺序和状态迁移
    ├── policy：纯决策，可单测
    ├── parser/normalizer：纯数据转换，可单测
    ├── repository：IO 与持久化
    ├── adapter：外部运行时或第三方能力
    └── presenter：用户可见输出，统一走 i18n
```

不应该因为参考仓库存在某个目录，就在 zy-code 中创建同名抽象；只有当本项目也存在对应变化原因时才建立模块。

---

## 4. 新的模块判定规则

### 4.1 拆分判定表

候选模块满足以下五项中的至少三项，才建议独立成文件：

1. 可以使用业务名称命名，而不是 `Support`、`Helper`、`Common` 或 `Misc`；
2. 公开 API 少量且稳定，调用方不需要了解内部步骤；
3. 可以独立编写行为测试；
4. 依赖集合明显小于原模块；
5. 拥有完整的数据或状态生命周期。

如果只满足“代码很多”或“能抽成函数”，不应拆分。

### 4.2 文件长度的使用方式

文件长度仅作为审查触发器：

- 小文件也可能低内聚，例如 48 行的 `permissionEditingSupport.ts`；
- 大文件也可能高内聚，例如完整描述异步 generator 状态机的 query processor；
- 800～1500 行的中心编排器可以接受，但必须保证阶段清晰、局部 helper 紧邻使用点；
- 超过约 1500 行时需要记录职责审查结论，但不自动要求拆分；
- 不把“超长文件数量下降”作为完成度指标。

### 4.3 禁止的拆分形态

```ts
// 禁止：主文件只为保持旧 API 而转发。
import { parseConfig as parseConfigSupport } from './configSupport.js'

export function parseConfig(input: ConfigInput): ParsedConfig {
  return parseConfigSupport(input)
}
```

应该让调用方依赖正式实现：

```ts
import { parseMcpConfig } from './config/configParsing.js'

const config = parseMcpConfig({ source, rawConfig })
```

如果确实需要统一入口，该入口必须承担编排行为，而不是 re-export：

```ts
export async function loadMcpConfig(
  request: LoadMcpConfigRequest,
  dependencies: McpConfigDependencies,
): Promise<ResolvedMcpConfig> {
  const sources = await dependencies.repository.readSources(request.cwd)
  const parsed = sources.map((source) => parseMcpConfigSource(source))
  const merged = mergeMcpConfigs(parsed)
  return filterMcpConfigByPolicy(merged, dependencies.policy)
}
```

---

## 5. 核心改造一：LLM Query Pipeline

### 5.1 当前问题

`streamingSupport.ts` 约 1196 行，却只导出 `queryModel`；`nonStreaming.ts` 反向导入它。该文件不是辅助模块，而是实际的流式查询核心。当前名称掩盖了它对状态机的所有权，也让 `nonStreaming` 与 `streaming` 的关系倒置。

常见耦合包括：

- 请求准备、模型调用和流事件处理混在一个 generator 中；
- retry、fallback、usage、tool block、错误映射共同修改局部状态；
- helper 依赖 generator 的大量闭包变量，无法真正独立；
- 非流式查询通过消费流式核心实现，但文件命名表达为相反依赖。

### 5.2 目标结构

```text
services/api/llm-orchestrator/
├── queryModel.ts                # 唯一流式状态机和公开入口
├── nonStreamingQuery.ts         # 将事件流归并为单个结果
├── prepareStreamingQuery.ts     # 现有请求准备能力
├── responseAccumulator.ts       # 纯事件归并
├── retryPolicy.ts               # 是否重试、退避、模型回退
├── usageAccounting.ts           # usage/cost 聚合
└── streamIdleWatchdog.ts        # 现有超时能力
```

中心状态机允许保持相对较长。只有 retry policy、accumulator、usage 等不需要读取整个闭包状态的能力才提取。

### 5.3 推荐接口示例

```ts
export type QueryPhase =
  | 'preparing'
  | 'requesting'
  | 'streaming'
  | 'retrying'
  | 'completed'

type QueryRuntime = {
  phase: QueryPhase
  attempt: number
  usage: QueryUsage
  response: ResponseAccumulator
}

export async function* queryModel(
  request: QueryRequest,
  dependencies: QueryDependencies,
): AsyncGenerator<QueryEvent, QueryResult> {
  const runtime = createQueryRuntime()

  while (true) {
    runtime.phase = 'requesting'

    try {
      const stream = await dependencies.provider.stream(request)
      runtime.phase = 'streaming'

      for await (const event of stream) {
        runtime.response.apply(event)
        runtime.usage = accumulateUsage(runtime.usage, event)
        yield event
      }

      runtime.phase = 'completed'
      return runtime.response.finish(runtime.usage)
    } catch (error) {
      const decision = decideQueryRetry({ request, runtime, error })
      if (decision.type === 'fail') throw decision.error

      runtime.phase = 'retrying'
      runtime.attempt += 1
      await dependencies.clock.sleep(decision.delayMs)
    }
  }
}
```

retry policy 只返回决策，不直接修改 runtime：

```ts
export type RetryDecision =
  | { type: 'retry'; delayMs: number }
  | { type: 'fail'; error: Error }

export function decideQueryRetry(input: RetryInput): RetryDecision {
  if (!isRetryableProviderError(input.error)) {
    return { type: 'fail', error: normalizeProviderError(input.error) }
  }

  return {
    type: 'retry',
    delayMs: calculateRetryDelay(input.runtime.attempt),
  }
}
```

### 5.4 迁移步骤

1. 为 query event 顺序、retry、取消、usage 聚合补 characterization tests；
2. 将 `streamingSupport.ts` 直接正名为 `queryModel.ts`，先不拆逻辑；
3. 将 `nonStreaming.ts` 正名为 `nonStreamingQuery.ts`，明确它消费 `queryModel`；
4. 提取纯 `responseAccumulator` 和 `retryPolicy`；
5. 只有当 usage 逻辑不再依赖 generator 闭包时再提取；
6. 删除旧文件，不保留兼容 re-export；
7. 验证 provider fallback、abort signal、idle timeout 和 tool-use delta 顺序。

### 5.5 风险与测试

- generator 的 `return`、`throw`、取消时机可能变化；
- retry 后是否保留 partial usage 必须保持现有契约；
- stream event 的顺序不能因为 accumulator 重构而变化；
- 建议新增 `queryModel.retry.test.ts`、`queryModel.abort.test.ts`、`responseAccumulator.test.ts`。

---

## 6. 核心改造二：Tool Execution Lifecycle

### 6.1 当前问题

`toolExecution.ts` 约 1120 行，`toolExecutionResultSupport.ts` 约 723 行。Support 中的 `executeToolCallWithResultHandling` 实际拥有工具执行后的主要生命周期，包括：

- 错误分类；
- hook stop 信息；
- MCP auth 错误；
- tool output override；
- git commit id 补充；
- 图片编号；
- 消息更新和 telemetry。

这不是“结果辅助函数”，而是半个执行状态机。主文件和 Support 必须共享大量上下文，说明拆分边界位于错误位置。

### 6.2 目标结构

```text
services/tool-runtime/
├── toolExecution.ts          # 阶段控制和消息流
├── toolInvocation.ts         # 调用 Tool/MCP/Agent 的统一适配
├── toolPermissionFlow.ts     # 权限请求与拒绝
├── toolResult.ts             # 结果规范化、错误分类、展示模型
├── toolHooks.ts              # 现有 hook 生命周期
├── toolTelemetry.ts          # 耗时与事件
└── toolErrors.ts             # 现有错误模型
```

`toolExecution.ts` 负责回答“下一阶段是什么”；`toolResult.ts` 只回答“原始结果如何规范化”；`toolHooks.ts` 负责 hook 生命周期，但不决定工具状态机的最终迁移。

### 6.3 推荐接口示例

```ts
type ToolExecutionPhase =
  | 'authorizing'
  | 'running-pre-hooks'
  | 'invoking'
  | 'running-post-hooks'
  | 'publishing-result'
  | 'completed'

export async function* executeToolCall(
  call: ToolCall,
  context: ToolExecutionContext,
): AsyncGenerator<ToolExecutionEvent, ToolExecutionResult> {
  const permission = await context.permissionFlow.authorize(call)
  if (permission.type === 'denied') {
    return createDeniedToolResult(call, permission)
  }

  yield { type: 'tool_started', call }
  const preHook = await context.hooks.runPreToolUse(call)
  if (preHook.type === 'stop') return createStoppedToolResult(call, preHook)

  const invocation = await context.invoker.invoke(call)
  const normalized = normalizeToolResult({ call, invocation })
  const postHook = await context.hooks.runPostToolUse(call, normalized)
  const finalResult = applyPostToolHook(normalized, postHook)

  yield { type: 'tool_completed', result: finalResult }
  return finalResult
}
```

结果归一化保持纯净：

```ts
export function normalizeToolResult(input: NormalizeToolResultInput): ToolExecutionResult {
  if (input.invocation.type === 'error') {
    return {
      type: 'error',
      callId: input.call.id,
      category: classifyToolError(input.invocation.error),
      message: input.invocation.message,
    }
  }

  return {
    type: 'success',
    callId: input.call.id,
    content: input.invocation.content,
  }
}
```

### 6.4 迁移步骤

1. 建立阶段枚举和现有行为时序测试；
2. 先把 Support 正名为 `toolResult.ts`，但只迁入真正的结果归一化逻辑；
3. 将 permission、pre-hook、invoke、post-hook、publish 顺序收回 `toolExecution.ts`；
4. 将 MCP/Agent/内置工具差异放入 `toolInvocation.ts`；
5. telemetry 通过事件订阅或显式依赖记录，避免结果模块读取全局状态；
6. `getNextImagePasteId` 等仅用于消息展示的函数迁入消息构建模块或内联；
7. 删除 `executeToolCallWithResultHandling` 这个混合入口。

### 6.5 风险与测试

- pre/post hook 的执行顺序、stop 行为和 output override 必须完全一致；
- MCP auth 错误仍需触发连接状态处理，但不应让纯结果模块直接修改 AppState；
- tool result 发布次数必须保持一次，避免重复消息；
- 建议新增 tool lifecycle golden test，覆盖 success、deny、hook stop、abort、MCP auth、tool throw。

---

## 7. 核心改造三：Bash Security

### 7.1 当前问题

现有结构总计超过 2200 行：

- `bashSecurity.ts`：规则注册、字符串扫描、命令判定；
- `bashSecurityStringSupport.ts`：引号、重定向、heredoc；
- `bashSecuritySyntaxValidatorSupport.ts`：混淆、转义、brace、Unicode、zsh 等规则。

Support 文件中的逻辑本身有独立价值，但当前名称没有表达安全语义，`ValidationContext` 又容易成为所有规则共享的“大参数袋”。

### 7.2 目标结构

```text
tools/BashTool/security/
├── bashSecurity.ts          # 统一入口与规则注册顺序
├── shellTextScanner.ts      # 引号、转义、heredoc 的词法扫描
├── commandStructure.ts      # operator、substitution、redirection
├── obfuscationRules.ts      # Unicode、反斜杠、mid-word hash
├── expansionRules.ts        # brace、zsh、substitution
├── destructiveRules.ts      # 高风险命令组合
└── types.ts                 # 多个规则共同使用的最小契约
```

不要按“字符串函数”和“validator support”分组，而应按安全规则的变化原因分组。词法扫描器可以是共享基础能力，但规则不能通过可变 context 相互影响。

### 7.3 推荐接口示例

```ts
export type BashSecurityFinding = {
  ruleId: BashSecurityRuleId
  severity: 'deny' | 'ask'
  span?: { start: number; end: number }
  metadata?: Readonly<Record<string, string>>
}

export type BashSecurityRule = {
  id: BashSecurityRuleId
  inspect(command: ParsedShellCommand): BashSecurityFinding | null
}

const RULES: readonly BashSecurityRule[] = [
  unicodeWhitespaceRule,
  escapedOperatorRule,
  braceExpansionRule,
  destructiveSubstitutionRule,
]

export function inspectBashCommand(command: string): BashSecurityFinding[] {
  const parsed = scanShellCommand(command)
  return RULES.flatMap((rule) => {
    const finding = rule.inspect(parsed)
    return finding ? [finding] : []
  })
}
```

词法扫描结果应不可变并被多个规则复用：

```ts
export type ParsedShellCommand = {
  source: string
  quotes: readonly QuoteSpan[]
  substitutions: readonly SubstitutionSpan[]
  redirections: readonly RedirectionSpan[]
  operators: readonly OperatorSpan[]
}

export function scanShellCommand(source: string): ParsedShellCommand {
  // 单次扫描生成稳定结构，避免每条规则各自用正则重复解析。
  return createShellScanner(source).scan()
}
```

### 7.4 迁移步骤

1. 将现有 Bash 安全案例整理为 rule-id 驱动的参数化测试；
2. 先把 `bashSecurityStringSupport.ts` 正名为 `shellTextScanner.ts`；
3. 明确哪些函数是真正词法能力，哪些其实是安全判定；
4. 将 syntax validator 按 obfuscation/expansion/destructive 规则移动；
5. `bashSecurity.ts` 只保留公开入口、规则顺序和结果组合；
6. 确认 catastrophic substitution、heredoc、jq、quoted newline、Unicode 空白行为；
7. 删除两个 Support 文件。

### 7.5 风险与测试

- 规则执行顺序可能影响最终 deny/ask 结果；
- 不能简单用 AST parser 替换现有保守规则，否则可能改变安全边界；
- heredoc 和 command substitution 的嵌套必须保留原行为；
- 每个 rule-id 至少包含允许、拒绝、边界和混淆四类样例。

---

## 8. MCP 配置与连接状态

### 8.1 当前问题

`config.ts` 同时承担配置发现、解析、合并、策略过滤、启停修改和公开 API。两个 Config Support 已抽走 735 行，但 `config.ts` 仍通过别名重新包装多项函数。这是“实现被搬走，所有权仍留在原文件”的典型情况。

`mcpConnectionStateSupport.ts` 中的状态合并是纯 reducer，但 transport 展示名称属于 UI/i18n 语义，不应与状态 reducer 放在一起。

### 8.2 目标结构

```text
services/mcp/config/
├── configSources.ts       # 发现 enterprise/user/project/local 来源
├── configParsing.ts       # schema、环境变量展开、规范化
├── configRepository.ts    # 读取与原子写入
├── configMerge.ts         # precedence、signature、dedup
├── configPolicy.ts        # allowlist、denylist、managed-only
├── configMutations.ts     # add/remove/enable/disable
└── loadMcpConfig.ts       # 唯一组合入口

services/mcp/connections/
├── mcpConnectionReducer.ts
└── transportPresentation.ts
```

### 8.3 推荐接口示例

```ts
export interface McpConfigRepository {
  readSources(cwd: string): Promise<readonly McpConfigSource[]>
  writeProjectConfig(cwd: string, config: McpJsonConfig): Promise<void>
}

export function mergeMcpConfigs(
  sources: readonly ParsedMcpConfigSource[],
): ResolvedMcpConfig {
  return sources
    .toSorted(compareMcpSourcePriority)
    .reduce(applyMcpConfigSource, createEmptyMcpConfig())
}

export function applyMcpPolicy(
  config: ResolvedMcpConfig,
  policy: McpPolicy,
): ResolvedMcpConfig {
  return filterMcpServersByPolicy(config, (server) => policy.allows(server))
}
```

连接 reducer 不执行副作用：

```ts
export function reduceMcpConnectionState(
  state: McpConnectionState,
  event: McpConnectionEvent,
): McpConnectionState {
  switch (event.type) {
    case 'server_updated':
      return applyServerUpdate(state, event.connection)
    case 'server_failed':
      return applyServerFailure(state, event.serverName, event.error)
  }
}
```

### 8.4 迁移步骤

1. 为 source precedence、环境变量、dedup、policy、enable/disable 建立矩阵测试；
2. 消费者直接迁往新正式实现，删除 `xxxSupport` 别名和转发；
3. IO 只存在于 repository，policy/merge 保持纯函数；
4. `unwrapCcrProxyUrl`、signature、dedup 进入 `configMerge.ts`；
5. allow/deny/managed-only 进入 `configPolicy.ts`；
6. transport 展示文本迁入 presentation，并通过 i18n key 返回用户可见文本；
7. 不创建 `config/index.ts` 兼容导出层。

### 8.5 风险与测试

- enterprise、policy、local、project 的优先级不能改变；
- Windows 路径和环境变量展开需要平台测试；
- 配置写入必须保留原子写和权限语义；
- CCR proxy URL 去重与手工 URL 去重需要分别覆盖。

---

## 9. Permissions 与 Auto Mode

### 9.1 当前问题

permissions 领域包含 8 个 Support 文件，实际混合了四种不同能力：

1. rule 查询和编辑；
2. dangerous rule 分析；
3. filesystem/internal path policy；
4. classifier prompt 与 transcript 构建。

它们不应被统一处理。classifier prompt/transcript 已经是清晰边界，应正名；editing 只有一个删除操作，应与 rule repository 合并；filesystem path Support 同时包含纯路径、环境配置、目录创建和权限判定，需要重新拆分。

### 9.2 目标结构

```text
services/permissions/
├── permissions.ts                 # 权限决策编排
├── permissionRuleQueries.ts       # allow/ask/deny 查询
├── permissionRuleRepository.ts    # 规则读写和删除
├── permissionRuleSync.ts          # 磁盘规则同步到 context/store
├── dangerousPermissionRules.ts    # 危险及过宽规则识别
├── filesystemPolicy.ts            # 可读/可写判定
├── internalPaths.ts               # 纯路径识别和规范化
├── scratchpadStorage.ts           # scratchpad/temp IO
├── classifierPrompt.ts            # auto-mode system prompt
├── classifierTranscript.ts        # transcript 压缩与序列化
└── yoloClassifier.ts              # 分类状态机
```

### 9.3 Rule repository 与查询示例

```ts
export interface PermissionRuleRepository {
  load(): Promise<readonly PermissionRule[]>
  save(rules: readonly PermissionRule[]): Promise<void>
}

export async function deletePermissionRule(
  repository: PermissionRuleRepository,
  target: PermissionRuleIdentity,
): Promise<readonly PermissionRule[]> {
  const rules = await repository.load()
  const nextRules = rules.filter((rule) => !isSamePermissionRule(rule, target))
  await repository.save(nextRules)
  return nextRules
}
```

查询模块只读取 context：

```ts
export function findToolPermissionDecision(
  context: ToolPermissionContext,
  request: ToolPermissionRequest,
): PermissionDecision | null {
  return (
    findMatchingRule(context.denyRules, request) ??
    findMatchingRule(context.askRules, request) ??
    findMatchingRule(context.allowRules, request)
  )
}
```

### 9.4 Filesystem policy 示例

```ts
export type InternalPathPolicy = {
  workingDirectory: string
  sessionMemoryDirectory: string
  scratchpadDirectory?: string
}

export function evaluateInternalPathAccess(
  request: PathAccessRequest,
  policy: InternalPathPolicy,
): PathAccessDecision {
  const normalized = normalizePathForPolicy(request.path)

  if (isWithinPath(normalized, policy.sessionMemoryDirectory)) {
    return evaluateSessionMemoryAccess(request.operation)
  }

  return evaluateWorkingDirectoryAccess(normalized, request.operation, policy)
}
```

`ensureScratchpadDir()` 是 IO，应进入 storage；`toPosixPath()`、`relativePath()` 是纯路径能力；`checkEditableInternalPath()` 是 policy。三者不能继续放在同一 Support 文件中。

### 9.5 Classifier 示例

```ts
export function buildClassifierInput(input: ClassifierInput): ClassifierRequest {
  return {
    systemPrompt: buildClassifierPrompt(input.rules, input.environment),
    transcript: serializeClassifierTranscript(
      buildClassifierTranscript(input.messages, input.tools),
    ),
  }
}
```

prompt 和 transcript 可以独立存在，因为二者分别随“分类策略”和“上下文压缩格式”变化。`yoloClassifier.ts` 继续拥有两阶段模型调用、fallback 和最终 decision。

### 9.6 迁移步骤

1. `permissionEditingSupport.ts` 与现有规则更新逻辑合并为 repository；
2. `permissionRuleSupport.ts` 正名为 queries，移除与展示相关的 source string；
3. `permissionContextSyncSupport.ts` 正名为 rule sync，并通过 runtime context 注入状态更新；
4. `permissionDangerousRuleSupport.ts` 正名，保持纯规则识别；
5. `filesystemPathSupport.ts` 按 pure path/policy/storage 拆分；
6. 两个 yolo Support 直接正名，不为减少行数继续细拆；
7. 用户可见的权限来源和危险提示全部通过 i18n。

### 9.7 风险与测试

- deny/ask/allow 的优先级不能改变；
- auto mode 中危险规则的剥离和恢复必须可逆；
- filesystem case sensitivity、符号链接和 Windows drive path 需要单独覆盖；
- AppState 更新只能经 `AppStateStore`/runtime context，不允许新模块直接持有共享可变状态。

---

## 10. Hooks、Plugins 与 Settings

### 10.1 Hook output：正名而非继续拆分

`hookOutputSupport.ts` 被 command、function、HTTP、outside-REPL 等多个执行器使用，已经形成稳定的协议解析能力。建议正名为：

```text
services/hooks/hookOutputParser.ts
```

目标模型使用判别联合，避免调用方依赖松散字段：

```ts
export type ParsedHookOutput =
  | { type: 'continue'; output?: string }
  | { type: 'prompt'; prompt: string }
  | { type: 'stop'; reason: string }
  | { type: 'invalid'; diagnostic: HookOutputDiagnostic }

export function parseHookOutput(source: HookOutputSource): ParsedHookOutput {
  if (source.type === 'http') return parseHttpHookOutput(source.body)
  return parseCommandHookOutput(source.stdout)
}
```

`processHookJSONOutput` 如果会修改执行状态，应由 executor 根据解析结果处理；parser 本身不应修改 AppState 或触发 UI。

### 10.2 Plugin validation：按验证对象组织

当前 `validatePlugin.ts` 和 `validatePluginSupport.ts` 的边界是主流程/被抽走实现，不是领域边界。建议：

```text
services/plugins/validation/
├── validatePlugin.ts
├── validatePluginManifest.ts
├── validatePluginContents.ts
├── validationRules.ts
└── validationTypes.ts
```

示例：

```ts
export async function validatePlugin(
  pluginDirectory: string,
  dependencies: PluginValidationDependencies,
): Promise<PluginValidationReport> {
  const manifest = await validatePluginManifest(pluginDirectory, dependencies.files)
  const contents = await validatePluginContents(pluginDirectory, dependencies.files)
  return combinePluginValidationResults(manifest, contents)
}
```

manifest validator 不应扫描全部插件内容；content validator 不应重新解析 manifest。`ValidationResult` 统一带 rule id、severity 和可 i18n 的 message key。

### 10.3 Settings schema：合并到所有者

`settingsSchemaSupport.ts` 包含 environment variables、permissions、marketplace、MCP policy 和 customization surfaces，多项 schema 不属于同一个变化原因。建议分别迁入：

- environment schema → `settingsRuntimeTypes.ts` 或新的 `environmentVariableSchema.ts`；
- permission schema → `permissionValidation.ts`；
- marketplace schema → plugin/marketplace settings schema；
- allowed/denied MCP server schema → `settingsMcpServerEntrySchemas.ts`；
- customization surfaces → 对应 customization policy 模块。

不要创建新的 `settingsSchemaUtils.ts`。`types.ts` 只组合并导出真正的 Settings 类型，不重新包装 schema 实现。

---

## 11. Bridge、CLI、IDE 与 Swarm

### 11.1 Wire loop

`wireLoopSupport.ts` 同时包含 polling/backoff 常量、多 session feature 判断和 process spawn。虽然文件很小且有多个消费者，但 pure policy 与 process IO 不应混合。

建议：

```text
bridge/bridge-main/
├── wireLoop.ts
├── wireLoopLifecycle.ts
├── wirePollingPolicy.ts
└── sessionSpawner.ts
```

```ts
export function calculatePollDelay(
  failureCount: number,
  policy: PollingPolicy,
): number {
  return Math.min(policy.initialDelayMs * 2 ** failureCount, policy.maxDelayMs)
}

export interface SessionSpawner {
  spawn(request: SpawnSessionRequest): Promise<SpawnedSession>
}
```

`safeSpawn` 进入 spawner；sleep detection 和 backoff 进入 polling policy；是否启用多 session 由 bootstrap/runtime 能力注入，不能在纯 policy 中读取全局配置。

### 11.2 Plugin list CLI

`pluginListSupport.ts` 同时构建 JSON 数据和直接打印文本报告，存在 model/presenter 两个变化原因。

建议：

```text
cli/handlers/plugins/
├── plugins.ts
├── pluginListModel.ts
└── pluginListPresenter.ts
```

```ts
export async function buildPluginListModel(
  repository: PluginRepository,
): Promise<PluginListModel> {
  const installed = await repository.listInstalled()
  const available = await repository.listAvailable()
  return { installed, available }
}

export function renderPluginList(
  model: PluginListModel,
  output: CliOutput,
): void {
  output.write(renderPluginListText(model))
}
```

JSON 输出直接序列化 model；文本 presenter 的所有用户可见文本必须走 i18n。`plugins.ts` 只负责解析命令参数和选择输出格式。

### 11.3 IDE extension adapter

`ideExtensionSupport.ts` 负责 Cursor、Windsurf、VS Code 的检测和扩展安装，应从 `ide.ts` 的综合逻辑中提升为正式 adapter。

建议：

```text
services/ide/
├── ide.ts
├── editorDiscovery.ts
├── extensionInstaller.ts
└── editorAdapters/
    ├── vscode.ts
    ├── cursor.ts
    └── windsurf.ts
```

```ts
export interface EditorAdapter {
  type: IDEType
  detect(): Promise<EditorInstallation | null>
  isExtensionInstalled(installation: EditorInstallation): Promise<boolean>
  installExtension(installation: EditorInstallation): Promise<InstallResult>
}
```

只有确实存在不同命令、路径或平台行为时才建立单独 adapter 文件；否则用一个数据驱动 registry，避免产生三个几乎相同的小文件。

### 11.4 Swarm permission sync

`permissionSyncSupport.ts` 包含 schema、目录计算、request/resolution 文件读写和清理，已经是文件协议 repository，而不是 Support。

建议：

```text
services/swarm/permissions/
├── swarmPermissionProtocol.ts
├── swarmPermissionRepository.ts
└── permissionSync.ts
```

```ts
export interface SwarmPermissionRepository {
  writeRequest(request: SwarmPermissionRequest): Promise<void>
  readPending(teamName: string): Promise<readonly SwarmPermissionRequest[]>
  resolve(teamName: string, resolution: SwarmPermissionResolution): Promise<void>
  readResolution(requestId: string): Promise<SwarmPermissionResolution | null>
  cleanup(teamName: string, cutoff: Date): Promise<void>
}
```

protocol 放 schema 和序列化契约；repository 负责文件 IO；`permissionSync.ts` 负责轮询、超时和业务状态迁移。

---

## 12. 分批实施计划

### 批次 0：纠正治理规则

目标：停止继续产生机械拆分。

- 更新 `docs/development-guidelines.md`：文件长度改为审查信号；
- 更新 `docs/architecture-compliance-remediation-plan.md`：删除“先抽 support 逻辑”和以 fileLength 数量衡量进度的表述；
- 架构检查增加泛化 `Support` 文件报告，但不简单按后缀一刀切；
- 默认禁止新增 `*Support.ts`/`*Support.tsx`。确有必要时必须经过架构评审，并在精确到文件的例外记录中写明领域含义、不能使用更具体名称的原因、负责人和复审/删除条件；
- 存量 Support 进入精确 baseline，数量只允许下降；baseline 用于阻止新增债务，不作为要求机械清零的拆分指标；
- 增加无行为转发函数、兼容 re-export 和重复实现的人工审查清单。

验收：新代码评审不再以“文件降到阈值以下”为拆分完成条件，同时任何新增 Support 文件都会被门禁拦截或具有可审计的单文件例外。

### 批次 1：低风险正名与合并

处理：

- `hookOutputSupport` → `hookOutputParser`；
- yolo prompt/transcript 正名；
- dangerous permission rules 正名；
- permission editing 合入 repository；
- permission rule queries 正名；
- MCP connection reducer 正名并移出 presentation；
- swarm permission repository 正名。

特点：以移动和 API 收敛为主，不改变状态机。

### 批次 1.5：行为与依赖基线

该批次是批次 2～6 的共同准入条件，不与结构迁移混在同一个提交中。目标是先回答“当前代码实际上做什么”，再讨论目标目录。

#### MCP precedence 基线

批次 2 开始前，必须用当前公开 API 固化以下组合：

- 同名 server 分别出现在 enterprise、user、project、local 时的最终来源；
- enterprise/policy 配置与项目级 enable/disable 同时存在时的结果；
- `allowManagedMcpServersOnly` 开启和关闭时的来源过滤；
- allowlist、denylist 同时命中时的最终判定；
- manual、plugin、zyAI server signature 相同或 URL 经 CCR proxy 还原后相同时的 dedup；
- 配置文件不存在、语法错误、环境变量缺失时的降级行为。

测试首先记录当前行为，不把预期的“理想 precedence”写进 characterization test。如果当前行为与产品预期冲突，应单独形成行为修复决策，不能在纯结构迁移中顺手改变。

#### Permission rule 删除事务基线

批次 1 中可以完成名称收敛，但真正建立 `permissionRuleRepository` 前必须固化：

- 删除成功后磁盘规则、当前 `ToolPermissionContext` 和 `AppStateStore` 的可见状态；
- 目标规则不存在时是幂等成功还是错误；
- 磁盘写入失败时内存和 AppState 是否保持原值；
- 磁盘写入成功、后续内存同步失败时当前恢复行为；
- 多个规则内容相同但 source 不同时的删除范围；
- 多进程或 watcher 同时刷新规则时的最终一致性。

完成测试后再确认事务边界。推荐目标是“先计算 next rules → 原子持久化 → 更新 runtime context/AppState”；但在测试和产品确认前，这只是候选方案，不作为既定事实。

#### 循环依赖基线

Support 被溶解后，原来的间接依赖会变成直接依赖。批次 2 和批次 3 开始前分别记录 MCP、settings、permissions 的文件级和领域级依赖边，并计算强连通分量：

```text
mcp -> settings
settings -> permissions schema
permissions -> mcp types/policy
```

上图只是需要重点检查的潜在路径，不代表当前一定存在循环。实现时优先将稳定契约放到领域自己的 `types.ts` 或 schema owner 中，不得为了消除循环把业务实现重新放回 `utils`。依赖基线应复用或扩展现有 `lint-architecture.ts`，不为此未经评估地新增依赖。

准入标准：

- MCP precedence 和 permission delete 测试在重构前即可稳定通过；
- 已保存重构前依赖图摘要；
- 目标设计不会增加新的跨领域强连通分量；
- Q3/Q4 已有“当前行为 + 目标行为 + 是否允许行为变化”的书面结论。

### 批次 2：MCP 配置

处理 config sources、parsing、repository、merge、policy、mutations，删除所有 Support 转发壳。本批次只能在 MCP precedence 测试和依赖基线完成后开始；不得与 permissions filesystem/schema 结构迁移并行推进。

完成 MCP 后先重新生成依赖图并稳定一个迭代，再进入批次 3，避免 MCP 与 permissions 同时改变直接导入关系而难以定位循环来源。

### 批次 3：Permissions filesystem 与 settings schema

先根据 permission delete characterization tests 确定 repository 事务边界，再拆 pure path/policy/storage，最后迁移 schema 所有权。开始前必须确认 MCP 批次没有遗留新增循环；MCP 和 permission 不在同一个迭代中并行大改。

### 批次 4：Query pipeline

先单独交付 query characterization test 工作包，再开始正名和提取 accumulator/retry/usage。测试至少覆盖 event 顺序、retry 前后的 partial usage、provider fallback、abort 到达各阶段的时机、idle watchdog、流中错误和 generator 提前关闭。每一次提取后都运行完整 query 时序测试，而不只运行 accumulator 单测。

### 批次 5：Tool execution

先单独交付 tool lifecycle characterization test 工作包，再建立阶段模型、收回 Support 中的控制流并提取 invocation/result/telemetry。测试覆盖 permission deny/ask、pre-hook stop、tool throw、abort、post-hook override、MCP auth、消息只发布一次和 telemetry 顺序。该批次与 Query pipeline 分开，避免同时修改消息流两端。

### 批次 6：Bash security

先将现有安全案例整理成独立的 rule-id 回归工作包，再迁移 scanner 和规则模块，最后收敛主入口。安全行为变化必须单独提交并明确说明，不能夹在纯移动提交中。

### 批次 7：CLI、IDE、Plugin validation、Wire loop

处理剩余 adapter、presenter 和 repository 边界，完成 `*Support` 清零。

### 测试工作量与排期缓冲

characterization tests 不是重构前的附带步骤，而是独立交付物。以下是用于排期的保守估算，不是固定工期承诺：

| 测试工作包 | 预计投入 | 主要难点 |
|---|---:|---|
| MCP precedence/policy | 0.5～1.5 工程日 | 多来源组合、feature/policy 分支、文件 IO |
| Permission delete transaction | 0.5～1.5 工程日 | 磁盘、runtime context、AppState 一致性与失败注入 |
| Query streaming lifecycle | 1.5～3 工程日 | async generator、retry、abort、partial usage、时序断言 |
| Tool execution lifecycle | 1.5～3 工程日 | permission/hook/tool/result 多阶段与消息顺序 |
| Bash security rule corpus | 1～2 工程日 | 规则顺序、混淆输入、平台 shell 差异 |

仅测试基线预计需要约 5～11 个工程日，尚不包含结构迁移和行为修复。实际排期应预留 flaky timing test 稳定化、测试注入点建设和跨平台验证时间。不能因为测试工作量较大而跳过基线，也不能把测试与大规模文件移动压进同一个提交。

---

## 13. 每批提交的标准步骤

每个领域按以下顺序执行：

1. 记录当前公开 API、调用方、共享状态和副作用；
2. 记录当前文件级/领域级依赖图和强连通分量，标出 Support 当前遮挡的间接依赖；
3. 补 characterization tests，固定当前行为；测试工作包可以独立提交，不与结构迁移捆绑；
4. 对照测试结论解决该批次的准入问题，记录允许和禁止的行为变化；
5. 先建立目标模块和正式名称；
6. 迁移一个完整职责，不移动半段状态机；
7. 直接更新全部消费者；每增加一条直接依赖就检查是否形成新的跨领域环；
8. 在同一批次删除旧 Support 和旧入口；
9. 重新生成依赖摘要，确认没有新增强连通分量；
10. 检查 runtime context 和 AppStateStore 使用；
11. 更新架构文档和本计划进度；
12. 执行：

```bash
bun run format
bun tsc --noEmit
bun run lint:architecture
bun test <相关测试>
```

纯移动提交和行为修改提交应尽量分开。若无法分开，必须在提交说明中列出行为差异和回滚方式。

---

## 14. 验收标准

### 14.1 结构验收

- `src/` 中不存在泛化 `*Support.ts`/`*Support.tsx`；
- 不存在仅为旧 API 转发的 facade；
- 不存在兼容 re-export、空占位文件或两处正式实现；
- 每个新文件能够用一句话说明业务职责；
- repository、policy、adapter、presenter 和 orchestrator 依赖方向明确；
- 共享状态只通过 `AppStateStore`，运行时能力只通过 runtime context 注入。

### 14.2 行为验收

- query event、tool lifecycle、hook lifecycle 顺序保持一致；
- MCP 配置优先级和 policy 保持一致；
- permission allow/ask/deny 与 auto mode 行为保持一致；
- Bash 安全规则无未经说明的放宽；
- CLI/UI 用户可见文本全部通过 i18n；
- Windows、Linux、macOS 的路径和 spawn 行为有针对性验证。

### 14.3 可维护性验收

- 一个典型需求只需修改一个职责模块；
- policy 和 parser 可在无 AppState、无 IO 环境下测试；
- 中心状态机可以从上到下连续阅读；
- helper 参数不演变为包含十几个字段的共享 context；
- 不以单文件行数、文件数量或 Support 清零本身证明架构质量。

---

## 15. 决策门禁与仍需确认的问题

以下问题不阻塞方案编写，但会阻塞对应结构迁移。不得靠推测选择新结构，也不得在纯重构提交中隐式改变行为：

1. `queryModel` 的非流式入口是否必须继续完全复用流式事件，还是允许 provider 提供独立 non-stream API；
2. tool post-hook 的 output override 是否属于结果归一化，还是属于 hook lifecycle 的最终状态迁移；
3. MCP enterprise 配置是否允许项目级 disable：先由 precedence characterization tests 固化当前行为，再由产品/安全要求确认是否保持；该结论是批次 2 的硬准入条件；
4. permission rule 删除是否必须同时更新磁盘、AppState 和当前 `ToolPermissionContext`：先通过成功、失败和并发场景测试确定当前事务边界，再决定是否采用“持久化成功后更新内存”的目标模型；该结论是 repository 重构的硬准入条件；
5. Bash security 是否允许引入内部 scanner 数据结构，但不引入新的第三方 shell parser；
6. IDE adapter 是数据驱动 registry 还是按编辑器独立文件，应以平台差异数量决定；
7. swarm permission 文件协议是否需要向后兼容旧会话；若需要，兼容逻辑必须有明确删除版本和计划，不能成为永久入口。

默认实施策略是保持 characterization tests 记录的现有行为，不引入新依赖。Q3/Q4 必须在批次 1.5 解决；Q1/Q2/Q5 必须在各自测试工作包完成后解决；Q6/Q7 可以在对应低风险批次开始前解决。任何行为或兼容性取舍都应形成独立记录和独立提交。

---

## 16. 建议的首个落地批次

首批建议选择 **MCP 配置 + permission 微型 Support 正名/合并**，原因是：

- 当前转发壳最明确，收益容易验证；
- 不需要先重写 query/tool 的异步状态机；
- 可以先建立 repository/policy/orchestrator 的项目级范式；
- 后续 permissions、swarm、plugin validation 可以复用同一边界语言。

首批完成后再评估这一范式是否适合 query/tool/Bash，而不是一次性大规模改名和搬迁。
