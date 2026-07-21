# ZY Code 架构规范剩余债务清零方案

## 1. 方案定位

本方案承接 [规范统一与架构治理执行计划](architecture-governance-plan.md)，只处理 2026-07-15
复审后仍存在的架构、命名、状态、类型和质量门禁问题。

本轮目标不是继续维持“未超过债务基线”，而是把仓库推进到以下状态：

1. 架构检查在无债务基线的情况下报告 0 条违规。
2. `src/utils/` 只保留无业务语义、无 IO、无共享状态的纯函数，并且单文件不超过 800 行。React 组件上限 1200 行，service/command 上限 1200 行。
3. `src/` 根目录只保留 `main.tsx` 和 `macro.d.ts`。
4. 共享 UI 状态统一由 `AppStateStore` 组合，运行时能力通过 `runtimeContext` 注入。
5. 普通模块使用 camelCase，Hook 使用 `useXxx`，检查器与文档规则完全一致。
6. `feature()` 只直接出现在 `if` 或三元表达式条件位置。
7. 非适配层不再依赖无解释的 `as any`；允许项必须精确、可审计。
8. 用户可见文本全部通过 i18n，英文和中文资源同步。
9. `bun run quality` 真正代表格式、静态检查、类型和测试全部清洁，而不是只因 warning
   或 baseline 未增长而通过。

## 1.2 最新推进进度（更新于 2026-07-21）

本轮已完成当前工作区改动的规范修复和质量门禁收口。架构债务仍未清零，但本轮没有新增
跨层、命名或类型债务，且历史债务总量继续下降。

最新校验结果：

| 项目 | 当前值 | 相比基线 | 说明 |
|---|---:|---:|---|
| 架构违规总数 | 1148 | 无新增 | `bun run lint:architecture` 通过 |
| `hardcodedText` | 795 | 与当前基线持平 | 本轮新增用户文本均已进入 i18n |
| `featureMacro` | 318 | 与当前基线持平 | 本轮未新增非法宏组合 |
| `fileLength` | 29 | 与当前基线持平 | 本轮路径迁移和类型恢复未扩大超长文件债务 |
| `as any` | 56 | 与当前基线持平 | 适配层 21，非适配层 35 |
| 跨层违规 | 0 | 已清零 | 本轮发现的 `services -> UI`、`types -> services` 依赖已迁移 |
| locale key | 英中各 3476 | 完全对称 | key 与插值均一致 |

本轮已完成的正式改造：

1. 恢复 `QueryEngine` 唯一正式实现并迁入 `src/query/queryEngine.ts`，调用方和测试已统一到新路径。
2. 修复 `systemThemeWatcher` 的 OSC 查询/刷新流程以及空响应保护，避免主题探测回归。
3. 将依赖 Ink 的终端呈现模块从 `services/` 迁入 `terminal-ui/`、`markdown/` 和
   `bootstrap/lifecycle/`，清除新增跨层依赖。
4. 将 `ThinkingConfig`、工具结果存储状态等共享类型下沉到 `src/types/`，清除
   `types -> services` 反向依赖。
5. 完成 WebSocket、LSP、后端、Shell、Cron 等模块的大小写/命名统一，并同步全部导入路径。
6. 消除本轮新增的 `as any`，修正文件持久化结果、动态功能模块和上下文压缩调用的类型边界。
7. 修复英文/中文插值不一致和 GitHub App 示例硬编码；顶层 `t/tSync` 调用已清零。
8. 格式化与 lint 脚本改为显式扫描正式源码目录，避免嵌套 worktree 配置污染主项目检查。
9. 上述改造均已验证：
   - `bun run format`
   - `bun tsc --noEmit`
   - `bun run lint:architecture`
   - `bun run lint:i18n`
   - `bun run lint:locale`
   - 相关测试 46 项全部通过

当前状态判断：

- 当前工作区改动已满足“无新增架构债务”的合入门禁。
- 存量仍有 1148 条架构债务，不能据此宣称仓库已经完全符合零债务规范。
- 后续主线仍是 `hardcodedText`、非法 `feature()`、超长文件和 `utils` 边界的存量清理。

### 拆分准则（2026-07-15 补充）

过去几轮尝试了不同类型的文件拆分，总结出以下准则，后续拆分应以此为据：

**有收益的拆分：**
- 提取可独立测试的**纯函数**（如 `typeaheadTokenUtils.ts` 中的 `findShellTokenStart`）
- 提取**UI 子组件**（如 `MessageSelectorDetails.tsx`）
- 提取**纯数据常量**（如 `descriptionI18n.ts` 中的 i18n key 映射表）
- 提取**被多个文件引用的实用逻辑**（如 `commandMetadataFormatters.ts` 中的 `formatSkillLoadingMetadata`）
- 作为**领域迁移的一步**，将 utils 中的业务函数迁入 services（如 `gitUrlUtils.ts` 中的 URL 规范化）

**无收益的拆分：**
- 纯搬类型定义到新文件，原文件仍远超阈值 —— 引入间接层但未解决实际问题
- 提取不跨文件复用的内部类型
- 为了降低指标行数而拆分，没有改善模块内聚性

## 1.3 剩余任务优先级清单（执行中）

为避免频繁切换上下文，后续改造按“收益 / 风险 / 依赖”综合排序，优先处理能持续降低
`fileLength`、`as any`、`hardcodedText` 和领域耦合度的任务。

### P0：持续消化超长文件与重复职责

这是当前收益最高的主线，优先继续处理大体积、高扇入、规则密集的模块。

1. 继续筛选并拆分剩余 `fileLength` 文件（当前 29 个）。
2. 优先处理同时满足以下条件的文件：
   - 超过架构长度阈值或接近阈值；
   - 同时承载解析、状态、IO、UI 组装等多重职责；
   - 已出现重复实现、support 逻辑内聚度低或导入面过宽。
3. 拆分策略保持一致：
   - 先抽纯函数、类型和 support 逻辑；
   - 再下沉运行时编排逻辑；
   - 不增加永久兼容 re-export；
   - 每次拆分后立即跑格式化、类型和架构检查。

### P1：继续压降 `as any`

当前剩余 56 处（适配层 21，非适配层 35），继续优先消化非适配层存量。

1. 优先处理非适配层、高复用路径和跨层传播点。
2. 优先文件类型：
   - `services/tool-runtime/`
   - `services/plugins/`
   - `services/telemetry/`
   - 高扇入的 `components/` 和消息渲染链路
3. 替换策略：
   - 优先 `unknown + 类型缩窄`
   - 优先局部接口、判别联合、`keyof`、泛型
   - 禁止把 `as any` 简单换成更大的强制断言来掩盖问题

### P2：继续清理硬编码用户文本并补 i18n

当前 `hardcodedText` 还剩 795 条，体量仍大，但适合和局部模块治理穿插推进。

1. 优先处理用户直接可见、频繁触达的界面与命令输出。
2. 优先目录：
   - `components/`
   - `screens/`
   - Tool `UI.tsx`
   - 产生终端提示和错误文案的 `services/`
3. 要求：
   - 新增 key 时中英文同步补齐；
   - 插值变量必须保持一致；
   - 不把协议字段、日志内部字段、命令参数误迁入 i18n。

### P3：继续清理非法 `feature()` 宏

当前 `featureMacro` 为 318，已经有下降，但仍需按领域批次持续清零。

1. 后续按领域整批处理，不和大规模状态迁移混在同一批提交。
2. 优先顺序维持原方案：
   - CLI / entrypoints / bridge
   - commands / components / screens / hooks
   - services / query / tasks
   - tools
3. 每批都要关注短路求值、早返回和动态导入语义不被改变。

### P4：逐步收敛 utils 边界违规

虽然这类问题短期不会像 `fileLength` 一样立刻大量下降，但它是后续架构真正清零的硬骨头。

1. 继续按正式领域迁移 `utils` 中的业务语义和 IO 逻辑。
2. 不允许因为“先过检查”而把业务逻辑继续塞进 `utils/`。
3. 每迁移一批都同步删除旧实现，避免形成双实现并存。

### P5：最后集中处理命名、根目录历史文件和基线退出

这部分依赖前面的大移动基本完成后再集中推进，避免反复改名与重复搬迁。

1. 根目录历史文件迁移到明确领域目录。
2. 命名统一改造按目录/领域批量处理。
3. 最后再收口基线，进入真正零容忍模式。

### 当前建议执行策略

后续几轮建议保持下面这个节奏不变：

1. 先做一批高价值大文件拆分。
2. 在相关文件内顺手消化一部分 `as any` 与硬编码文本。
3. 每轮结束都跑：
   - `bun run format`
   - `bun tsc --noEmit`
   - `bun run lint:architecture -- --verbose`
4. 每完成一个稳定里程碑，就把结果回写到本方案文档。

### 1.1 非目标

- 不在结构迁移时顺便改变产品行为、协议字段或 UI 交互。
- 不为了减少文件数量合并职责不同的领域。
- 不创建永久兼容 re-export、空 `UI.tsx`、空 `prompt.ts` 或未接线的新实现。
- 不引入新的第三方依赖；优先使用 Bun、TypeScript、Biome 和仓库现有工具。
- 不手工修改 `dist/`，不修改 `build.ts` 的 `define` 宏值。

## 2. 当前真实基线

以下数字来自 2026-07-15 的只读复审：

| 项目 | 当前值 | 说明 |
|---|---:|---|
| 架构违规总数 | 324 | 检查成功仅表示未超出历史基线 |
| `src/` 根文件 | 17 | 全部仍是待迁移历史文件 |
| `utils` 依赖业务层 | 116 | 与 IO/i18n 等类别可能重叠 |
| `utils` IO | 66 | 文件、网络、进程或外部 IO 库 |
| `utils` i18n | 8 | 说明模块包含用户行为或业务语义 |
| `utils` 终端输出 | 6 | 应迁入 CLI、服务或日志边界 |
| 非法 `feature()` | 111 | 同一表达式可能被两个规则重复计数 |
| `as any` | 746 | 其中适配层 32，非适配层 714 |
| 超过 800 行的 `utils` 文件 | 13 | 最大文件 1,523 行 |
| Biome warning | 2,294 | 当前配置为 warning，因此不阻断退出码 |
| locale key | 英中各 3,003 | key 和插值目前对称 |

当前通过项：

- `bun run format:check`
- `bun tsc --noEmit`
- `bun run lint:i18n`
- `bun run lint:locale`
- 相对导入 `.js` 后缀检查
- 服务和组件直接导入 `bootstrap/state` 的数量为 0
- 适配层外未发现直接导入 Anthropic/OpenAI SDK 类型

## 3. 总体执行顺序

必须按以下依赖顺序推进：

```text
R0 修复门禁可信度
 ├─> R1 状态边界收敛
 ├─> R2 feature 宏清零
 ├─> R3 utils 领域迁移与大文件拆分
 │    └─> R4 src 根文件迁移
 ├─> R5 文件命名统一
 ├─> R6 as any 类型债务治理
 └─> R7 i18n 与 Biome warning 收敛
              └─> R8 删除基线并完成最终验收
```

R1、R2 可以在 R0 完成后并行准备，但同一批提交不能同时修改状态架构和 feature 逻辑。
R3 会改变大量正式路径，应先于 R4 完成，否则根文件迁移容易再次依赖错误的 `utils` 路径。
R5 应在主要移动完成后执行，避免同一个文件先改名再迁移两次。

## 4. R0：让门禁反映真实规范

### 4.1 目标

先修复检查器盲区。此阶段不清理大批业务债务，只保证后续数字可信、债务只能下降。

### 4.2 改动点

主要文件：

- `scripts/lint-architecture.ts`
- `scripts/architecture-debt-baseline.json`
- `scripts/lint-no-toplevel-i18n.ts`
- `package.json`
- `biome.json`
- `docs/development-guidelines.md`
- `docs/architecture.md`

具体改进：

1. **修正普通模块命名规则。**
   - 删除当前对 kebab-case `.ts` 的无条件放行。
   - Hook 只允许 `useXxx.ts` 或 `useXxx.tsx`。
   - React 组件只允许与主导出一致的 PascalCase 文件名。
   - Slash command、第三方镜像、平台镜像如确需保留特殊名称，使用精确到文件的豁免，不使用目录级白名单。

2. **增加文件长度检查。**
   - `utils` 默认上限 800 行。
   - React 实现默认上限 800 行。
   - 普通 service/command 默认上限 1,200 行。
   - Parser、生成文件和第三方镜像只能通过精确清单豁免，并在输出中显示原因。

3. **修正根文件大小写判断。**
   - Windows 文件系统与 Git index 大小写不一致时，检查器应使用规范化后的 Git 路径或大小写不敏感匹配。
   - 不能把历史 `QueryEngine.ts`、`Task.ts` 等误报成“新增文件”。
   - 历史文件仍然是债务，只修正分类，不把它们移出债务统计。

4. **让 `as any` 基线精确到文件。**
   - 当前只比较全仓总量，无法阻止从一个文件删除、在另一个文件新增。
   - 新基线记录 `file + line/context hash + category + reason`。
   - 非适配层新增 `as any` 立即失败。
   - 适配层新增项也必须带中文注释说明第三方类型缺陷或 SDK 扩展字段。

5. **去除 feature 重复计数。**
   - 同一个 `if (feature(...) && ...)` 当前可能同时触发两条规则。
   - 使用 AST 或至少以源码位置为主键去重，使数字代表真实改动点。
   - 检查 `!feature()`、多行条件、三元表达式、动态 import 等边界情况。

6. **新增硬编码用户文本检查。**
   - 优先覆盖 `components`、`screens`、`commands`、Tool `UI.tsx` 和产生用户输出的 services。
   - 排除测试 fixture、协议字段、日志字段、命令参数、路径和专有名词。
   - 初期使用精确 baseline，后续按 R7 清零。

7. **收紧 Biome 结果语义。**
   - 先按规则和文件建立 warning 基线。
   - correctness 类 warning 优先提升为 error。
   - `lint` 最终必须在 warning 为 0 或显式批准的精确基线为 0 时通过。
   - 不一次性执行全仓 unsafe fix。

### 4.3 可能遇到的问题

- 文本扫描容易误判注释、类型字符串和测试 fixture；应优先复用 TypeScript AST，无法使用 AST 时必须保留精确排除列表。
- 修复命名检查后会一次暴露大量存量文件，不能直接让主分支永久红灯；应生成新的精确命名债务基线，并在 R5 清零。
- Git index 与工作区文件大小写不同会导致 Windows 正常、Linux 构建失败；检查器需同时比较真实路径和 Git 路径。
- warning 基线如果只记录总数，会重复 `as any` 的问题；必须按规则和文件记录。

### 4.4 验收

- 为每条新增规则添加脚本级测试或 fixture。
- 故意新增一个 kebab-case 普通模块、超长 utils、缺少 `.js` 的导入和非适配层 `as any`，检查必须失败。
- 删除临时 fixture 后：

```powershell
bun run format
bun tsc --noEmit
bun test tests/scripts
bun run lint:architecture -- --verbose
```

退出条件：检查结果能区分“当前债务”“新增债务”“已消除债务”，且每项都有稳定 ID。

## 5. R1：统一共享状态与运行时能力

### 5.1 当前问题

`src/state/replStore.ts` 创建了独立外部 store，包含消息、流式输出、工具确认队列、prompt
队列和 UI 选择状态；`src/screens/REPL.tsx` 会实例化它。这与“共享状态统一进入
`AppStateStore`、slice 最终由唯一 store 组合”的规范不一致。

同时，`ReplMutable` 中的 `AbortController`、`QueryGuard`、缓存和回调并不是 UI 状态，不能机械塞入
`AppStateStore`。

### 5.2 改进设计

按性质拆成三类：

| 当前内容 | 目标位置 | 处理方式 |
|---|---|---|
| messages、streamingText、streamMode、队列、选择状态 | `src/state/slices/` | 拆成 REPL session、streaming、interaction slice，由 `AppStateStore` 组合 |
| selector、更新器 | 对应 slice | 组件只通过 selector/update action 使用，不直接修改嵌套对象 |
| AbortController、QueryGuard、缓存、一次性回调 | 显式运行时接口或 REPL 局部 ref | 不触发渲染；需要跨服务使用的能力通过 `runtimeContext` 注入 |
| 服务端或持久化设置 | 对应 service | 不进入 UI store |

推荐新增或调整：

```text
src/state/slices/replSessionSlice.ts
src/state/slices/replStreamingSlice.ts
src/state/slices/replInteractionSlice.ts
src/state/selectors/replSelectors.ts
src/bootstrap/runtime/runtimeContext.ts
```

执行步骤：

1. 为 `ReplState` 每个字段标记所有者、读者、写者和生命周期。
2. 先为现有 `ReplStore` 补 selector/action 行为测试，记录 render 触发语义。
3. 每次迁移一个 slice；组件改用 `AppStateStore` 后立即删除对应旧字段和 action。
4. 运行时 mutable 字段改为显式依赖，不允许再创建第二个全局 store。
5. 最后删除 `createReplStore`、旧 Context/provider 和不再使用的兼容类型。
6. 更新 `docs/architecture.md`，明确 UI state、session runtime、persistent settings 三者边界。

### 5.3 风险与处理

- **渲染次数增加：** selector 必须保持细粒度，Set/数组更新保持引用稳定，并增加渲染回归测试。
- **陈旧闭包：** 回调迁移时优先使用 action 或 ref，测试 interrupt、resume、tool confirmation 等异步路径。
- **多会话串状态：** 明确 store 的 session key 和 reset 时机，测试新建、恢复、切换和远程 bridge 会话。
- **Abort 生命周期泄漏：** session 结束时集中清理 controller、订阅和回调。
- **测试构造成本上升：** 提供类型安全的 store fixture，不用 `as any` 构造状态。

### 5.4 验收

- `createReplStore` 和独立 `ReplStoreInstance` 为 0。
- 共享 UI 状态只存在于 `AppStateStore` 组合的 slice 中。
- runtime capability 的外部消费者只依赖接口，不导入 `bootstrap/state` 实现。
- REPL 提交、中断、恢复、工具确认、流式文本和会话切换测试全部通过。

## 6. R2：清零非法 feature 宏

### 6.1 改进方法

按领域分批处理 111 条报告，先按源码位置去重，再逐个改写：

```ts
// 修改前
if (feature('KAIROS') && pendingAssistantChat) {
  run()
}

// 修改后
if (feature('KAIROS')) {
  if (pendingAssistantChat) {
    run()
  }
}
```

否定复合条件不能简单取反，必须保持短路和返回语义：

```ts
if (!feature('KAIROS')) {
  return fallback
}
if (!pendingAssistantChat) {
  return fallback
}
```

建议批次：

1. CLI/entrypoints/bridge。
2. commands/components/screens/hooks。
3. services/query/tasks。
4. tools。
5. utils 中尚未迁移的文件；这些文件应与 R3 的领域迁移协调，避免重复改动。

### 6.2 风险

- `&&`、`||`、否定和早返回改写可能改变求值顺序。
- 某些 feature 分支包含动态 import 或 require，位置变化可能破坏构建期 DCE。
- 内部/外部构建使用不同 feature 组合，只跑默认测试不足以验证。

### 6.3 验收

- 每批增加或更新对应 feature 开启/关闭测试。
- 对包含动态导入的批次运行构建，并检查禁用构建不包含对应模块。
- `featureMacro` 债务按批次单调下降，最终为 0。
- 不修改 `build.ts` 的 `define` 宏值来绕过问题。

## 7. R3：清空 utils 业务、IO 和大文件债务

### 7.1 迁移原则

不能按文件名机械移动。每个文件先回答：

1. 它是否有业务语义？
2. 是否执行 IO、访问进程、网络或环境？
3. 正式领域服务是否已经存在？
4. 哪个公开 API 是真实消费者需要的最小契约？
5. 是否与另一个正式实现重复？

如果答案指向业务或 IO，迁入现有 `src/services/<domain>/`；只有纯计算部分可以留在
`utils`。移动完成后直接更新消费者并删除旧文件，不新增永久 re-export。

### 7.2 推荐迁移波次

#### 波次 A：已有明确正式领域

| 当前职责/代表文件 | 推荐正式位置 |
|---|---|
| session storage、restore、title、transcript | `services/session-storage/`、`services/session-transcript/` |
| tool result、tool pool、tool search | `services/tool-runtime/`、`services/tool-use-summary/` |
| tasks、cron task、task storage | `services/task-runtime/`、`services/jobs/` |
| plugin、permission、hook 调用链 | `services/plugins/`、`services/permissions/`、`services/hooks/` |
| analytics、stats、telemetry sink | `services/analytics/`、`services/telemetry/` |
| attachment/image/pdf | `services/attachments/` |
| markdown/frontmatter | `services/markdown/` |
| memory、AGENTS.md、context suggestion | `services/memory/` 或职责更精确的现有服务 |

#### 波次 B：文件、Git、进程和网络 IO

处理 `file.ts`、`fsOperations.ts`、`git.ts`、`gitDiff.ts`、`proxy.ts`、`http.ts`、
`ripgrep.ts`、`localInstaller.ts`、`autoUpdater.ts` 等。

- GitHub API 进入 `services/github/`，通用 Git 工作区操作可建立 `services/git/`，但先确认没有重复实现。
- 文件持久化进入 `services/file-persistence/`；搜索进入 `services/file-search/` 或 `services/search/`。
- 安装与更新进入 `services/native-installer/` 或独立 updater 服务。
- 网络 transport 进入对应 MCP、bridge 或 API 领域，不能建立含混的 `services/network/` 大杂烩。

#### 波次 C：13 个超长 utils

| 文件 | 行数 | 处理方向 |
|---|---:|---|
| `cursor.ts` | 1,523 | 判断是否为 Ink/terminal 语义；纯算法与终端能力分离 |
| `agentsMd.ts` | 1,362 | 加载/IO 进入 memory 或 instructions 服务；纯解析单独保留 |
| `analyzeContext.ts` | 1,279 | 进入 compact/context-analysis，拆分收集、评分、渲染 |
| `teammateMailbox.ts` | 1,216 | 进入 swarm/coordinator 领域，拆分协议、存储和轮询 |
| `collapseReadSearch.ts` | 1,205 | 进入 compact，拆分判定、聚合和展示模型 |
| `fileHistory.ts` | 1,053 | 进入 file-persistence/session-storage，隔离 IO 与 diff 纯逻辑 |
| `stats.ts` | 1,024 | 进入 analytics/telemetry，拆分聚合和持久化 |
| `toolResultStorage.ts` | 1,011 | 进入 tool-runtime，拆分 schema、存储和生命周期 |
| `tasks.ts` | 949 | 进入 task-runtime，拆分存储、锁和状态转换 |
| `commitAttribution.ts` | 928 | 进入 git/github，拆分规则计算和仓库 IO |
| `git.ts` | 892 | 进入 git service，按读取、状态、分支和远端操作拆分 |
| `sessionStoragePortable.ts` | 830 | 合并到 session-storage 正式实现，不保留第二套入口 |
| `imageResizer.ts` | 814 | 进入 attachments；保留纯尺寸计算与 IO adapter 的边界 |

### 7.3 每个迁移批次的固定步骤

1. 生成生产代码、测试、文档和动态导入消费者清单。
2. 为当前公开行为补测试，特别是错误、取消和平台差异。
3. 先提取纯类型和纯函数，再移动 IO orchestration。
4. 更新所有生产导入到正式路径，确保 `.js` 后缀。
5. 更新镜像测试路径和 API snapshot。
6. 删除旧实现；全局搜索旧路径必须为 0。
7. 运行相关测试、类型检查和架构检查，记录债务下降量。

### 7.4 风险

- utils 被大量低层模块引用，迁入 services 后可能形成循环依赖；必要时把稳定契约放在领域 `types.ts`，而不是把实现移回 utils。
- 便携实现可能包含 Windows/macOS/Linux 分支，拆分时必须保留平台测试。
- 文件锁、原子写入、取消和重试属于行为契约，不能在纯移动提交中重写。
- 一些文件同时承担解析和 IO，应拆成纯 core 与 service adapter，避免整文件粗暴迁移。

### 7.5 验收

- `utilsDep`、`utilsIO`、`utilsI18n`、`utilsOutput` 全部为 0。
- `utils` 单文件全部不超过 800 行。
- 不存在 `utils/hooks`、`utils/permissions`、`utils/plugins` 或新的兼容入口。
- 每个领域只有一个正式实现位置。

## 8. R4：迁移 src 根目录历史模块

### 8.1 目标映射

最终根目录只允许：

```text
src/main.tsx
src/macro.d.ts
```

17 个历史文件按职责评估后迁移：

| 当前文件组 | 建议目标 |
|---|---|
| `QueryEngine.ts`、`query.ts` | `src/query/`，区分 engine、配置、状态转换和停止逻辑 |
| `Task.ts`、`tasks.ts` | `src/tasks/` 与 `services/task-runtime/` |
| `Tool.ts`、`tools.ts` | `src/tools/` 与 `services/tool-runtime/` |
| `commands.ts` | `src/commands/` 的注册入口或职责明确的 registry 模块 |
| `context.ts` | `src/context/` 或 runtime context，先区分 React Context 与运行时数据 |
| `cost-tracker.ts`、`costHook.ts` | cost/token runtime 或对应 React hook |
| `dialogLaunchers.tsx`、`replLauncher.tsx` | 组件/屏幕/CLI 启动边界，以主导出职责决定 |
| `history.ts` | `services/session-storage/` 或 `services/session-transcript/` |
| `ink.ts` | `src/ink/` 的明确公开入口 |
| `interactiveHelpers.tsx` | UI helper 或 CLI interaction 领域，禁止继续作为根目录杂项 |
| `projectOnboardingState.ts` | settings/onboarding 领域 |
| `setup.ts` | bootstrap/cli 启动阶段 |

### 8.2 特别问题

- Git index 中部分文件使用 PascalCase，而 Windows 工作区显示不同大小写。只改大小写时必须先改为临时名，再改到目标名。
- `QueryEngine`、`Tool`、`Task` 可能属于公开 API snapshot；移动前先确认 SDK/插件消费者。
- 根文件通常是高扇入入口，禁止用永久 re-export 假装完成迁移。
- 如果一次无法迁完，应按完整领域批次处理，而不是留下半套新旧路径。

### 8.3 验收

- `rootFile` 为 0。
- API snapshot、CLI、MCP 和 SDK 入口测试通过。
- 全局搜索旧根路径为 0，文档历史记录除外。

## 9. R5：统一文件命名

### 9.1 清理范围

修复 R0 检查器后，以新生成的精确清单为准。当前扫描有 77 个带连字符的 TS/TSX 候选，
其中需要逐个区分：

- 普通模块：改为 camelCase，例如 `option-map.ts` → `optionMap.ts`。
- Hook：改为 `useXxx`，例如 `use-select-state.ts` → `useSelectState.ts`。
- React 组件：文件名与主导出 PascalCase 一致。
- Slash command 实现：如果不是组件，使用 camelCase；命令目录仍保持 kebab-case。
- 第三方或平台镜像：只在确认不能改名后登记精确豁免。

### 9.2 执行方式

- 每批只处理一个目录或一个紧密领域。
- Windows 下使用临时中间名处理大小写变更。
- 同步更新 import、测试、文档、动态路径和 API snapshot。
- 改名提交不混入业务逻辑修改。

### 9.3 风险与验收

风险包括 Linux 大小写敏感路径失效、动态 import 字符串遗漏、Git history 识别成删除加新增。

验收：命名债务为 0；在 Windows 和 CI 目标平台执行类型检查、测试和构建。

## 10. R6：治理 746 处 as any

### 10.1 分类处理

先由脚本输出每处使用的类别，不直接全局替换：

| 类型 | 改进方式 |
|---|---|
| SDK/第三方扩展字段 | 局部 adapter interface、模块增强或具体交叉类型，并写中文原因 |
| JSON、配置、IPC 输入 | `unknown` + zod/现有 schema/运行时守卫 |
| 动态对象索引 | 泛型、`keyof`、判别联合或 `Record` |
| React/Ink 第三方类型缺陷 | 最小局部接口，禁止把 any 扩散到组件 props |
| 测试 fixture | 类型安全 builder，必要时使用 `unknown as Target` 且说明旧格式 |
| 真实无法表达的边界 | 精确豁免到单行，并登记删除条件 |

### 10.2 优先级

1. 非适配层高频文件和共享类型。
2. services/tool-runtime、plugins、telemetry 等跨层传播点。
3. components 中的动态 props 和消息渲染。
4. entrypoints、transport 和 adapter。
5. 测试 fixture。

每批只清理一个领域，不以“总量下降”替代类型正确性。修改 LLM 类型或 provider adapter 时必须运行全量测试。

### 10.3 风险与验收

- 把 `any` 改为错误的强制断言只会隐藏问题；优先运行时缩窄。
- schema 加严可能拒绝旧会话、插件或远端消息；需准备兼容 fixture。
- 泛型重构可能扩大公开 API，需要检查 API snapshot。

最终验收：非适配层无未批准 `as any`；适配层只剩有具体原因的最小边界，且架构检查按位置阻止新增。

## 11. R7：清理 i18n 漏洞和 Biome warning

### 11.1 i18n

locale key 对称不代表不存在硬编码用户文本。按以下顺序审计：

1. `screens`、`components`。
2. `commands`、Tool UI/prompt。
3. 会向终端、错误提示、通知输出文本的 services。
4. Keyboard shortcut action 与 `actionKeyMap` 的完整性。

每个新增 key 同时加入英文和中文分组，插值变量完全一致。日志内部字段、协议枚举、路径、命令参数和测试原始 fixture 不翻译。

### 11.2 Biome warning

按风险而不是数量处理：

1. correctness：unused、unreachable、hook dependency、hook top-level。
2. suspicious：implicit any、模板字符串错误、回调返回值。
3. style/performance：block statements、Node protocol、optional chain 等。
4. `noExplicitAny` 与 R6 合并处理，避免重复提交。

每处理完一类，将对应规则从 warning 提升为 error。不要用全局 ignore 或扩大白名单清零。

### 11.3 验收

- 用户可见硬编码债务为 0。
- 英中 key、插值、聚合文件保持一致。
- Biome warning 和 info 为 0，或只剩仓库明确接受且有精确原因的生成/第三方镜像项。
- `bun run lint` 的成功不再依赖 warning 不影响退出码。

## 12. R8：删除债务基线并最终验收

### 12.1 基线退出策略

每个批次只能删除已经实际解决的 baseline 项，禁止用 `--write-baseline` 吞掉新增违规。

当所有类别为 0 后：

1. 将 `architecture-debt-baseline.json` 变为空基线，或让脚本切换为零容忍模式。
2. 删除只为兼容历史债务存在的代码分支。
3. 更新 `docs/architecture.md` 和 `development-guidelines.md`，确保示例路径真实存在。
4. 将本方案各项标为完成并记录最终数字。

### 12.2 最终验证矩阵

```powershell
bun run format
bun run format:check
bun run lint
bun run lint:i18n
bun run lint:locale
bun run lint:architecture -- --verbose
bun tsc --noEmit
bun test
bun run build
bun dist/cli.js --help
```

另外执行与外部环境无关的 CLI、MCP、SDK smoke test。真实凭据、远端 MCP、SSH 和交互终端能力应在预发布环境单独验证，不在单元测试中访问真实用户目录。

最终退出条件：

- 架构违规 0。
- 命名违规 0。
- 非法 feature 宏 0。
- utils 边界违规 0，超长 utils 0。
- 根文件债务 0。
- 未批准 `as any` 0。
- i18n 硬编码和资源不一致 0。
- Biome diagnostics 0。
- 类型、测试、构建和 smoke test 全部通过。

## 13. 建议批次与提交边界

推荐每个提交只完成一个可验证目标：

```text
1.  chore: make architecture diagnostics match documented rules
2.  refactor: move repl session state into app state slices
3.  refactor: inject repl runtime capabilities explicitly
4.  refactor: normalize feature macro usage in cli and bridge
5.  refactor: normalize feature macro usage in ui and services
6.  refactor: migrate session and task helpers out of utils
7.  refactor: migrate file git and network io out of utils
8.  refactor: split remaining oversized pure helpers
9.  refactor: move query task and tool roots into domains
10. refactor: move remaining src root modules into domains
11. refactor: normalize hook and module filenames
12. refactor: remove non-adapter any usage by domain
13. fix: route remaining user-visible text through i18n
14. chore: promote clean biome rules to errors
15. chore: remove architecture debt baseline
```

目录迁移、全仓格式化、业务行为修复不得放在同一个提交中。

## 14. 工期与里程碑建议

以下是单人持续执行的粗略工程量，不包含等待外部集成环境的时间：

| 阶段 | 预计时间 | 里程碑 |
|---|---:|---|
| R0 门禁可信度 | 3～5 天 | 新增债务可被精确阻断 |
| R1 状态治理 | 1～2 周 | 独立 ReplStore 删除 |
| R2 feature 清零 | 3～6 天 | featureMacro 为 0 |
| R3 utils 治理 | 3～6 周 | 四类 utils 债务及超长文件为 0 |
| R4 根文件迁移 | 1～2 周 | src 根文件只剩两个 |
| R5 命名统一 | 3～7 天 | 命名债务为 0 |
| R6 类型债务 | 2～5 周 | 非适配层 any 清零 |
| R7 i18n/Biome | 1～3 周 | 用户文案和 diagnostics 清洁 |
| R8 最终收口 | 2～4 天 | baseline 删除、全矩阵通过 |

总工期约 10～18 周。多人并行时应按领域分工，而不是多人同时修改 `AppStateStore`、
`runtimeContext`、`QueryEngine` 或同一批 import 路径。

### 14.1 前两周推荐落地内容

第一周：

- 完成 R0 的命名、文件长度、根文件大小写和 per-file `as any` 检查。
- 生成新的真实债务报表，但不扩大既有豁免。
- 为 `ReplStore` 建立字段所有权和生命周期表，补关键行为测试。

第二周：

- 迁移 REPL streaming 与 interaction 两个低耦合 slice。
- 清理 CLI/bridge 第一批 feature 宏。
- 选择 session-storage 或 task-runtime 作为第一个 utils 迁移试点。

两周结束应能证明三件事：门禁数字可信、状态迁移方法可复制、utils 领域迁移不会依赖永久兼容入口。

## 15. 每批执行记录模板

```markdown
### 批次：R?-??

- 目标：
- 修改范围：
- 正式实现路径：
- 删除路径：
- 行为变化：无 / 有，具体说明
- 风险点及保护测试：
- 债务变化：分类、修改前、修改后
- `as any` 变化：适配层 / 非适配层
- `bun run format`：
- `bun tsc --noEmit`：
- 相关 `bun test`：
- 阶段完整门禁：
- 未解决问题与下一批依赖：
```

任何批次只要债务数字增加、正式实现出现两处、旧路径仍有生产消费者，均不得标记完成。
