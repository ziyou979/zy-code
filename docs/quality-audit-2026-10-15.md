# 测试失败与架构违规审计（2026-10-15）

下文记录最初的失败原因审计；该阶段没有调整业务逻辑、放宽断言或更新违规基线。后续修复及验证结果见文末。

## 结论与证据范围

- 上次全量结果为 2265 pass、1 skip、16 fail；当前 Bun 为 1.3.14。
- 将涉及失败的 7 个测试文件分别放入独立 Bun 进程运行，42 项测试全部通过。
- 再组合污染源与被影响文件，全部 16 个失败标题均可重现，没有尚未解释的失败项。
- 这 16 项的直接原因是跨文件模块 mock 污染，不是这些日志证明了 16 个产品功能故障。独立通过也不能替代后续修复污染后的全量回归。
- 架构检查单独复跑，仍有 49 个未登记的硬编码文本节点和 1 个未登记的含 any 断言。文案节点中包含确定误报，不能将全部告警当作真实用户文本。

完整原始日志位于 `.tmp/auto-mode-full-test.log`、`.tmp/architecture-audit.log`。本次独立复跑日志为 `.tmp/audit-*.log`，组合复现日志为 `.tmp/audit-pair-*.log`。

## 测试失败分组

| 被影响文件 | 全量失败数 | 单独运行 | 直接原因 |
| --- | ---: | ---: | --- |
| `tests/services/settings/modelTierSettings.test.ts` | 7 | 10 pass | 真实配置读取被 settings mock 替代，部分主模型读取又被固定值 mock 替代 |
| `tests/services/permissions/autoModeEvaluationTask.test.ts` | 2 | 2 pass | 主模型 getter 固定为 `gpt-5[1m]`，与评测模型不一致，正常触发配置变更保护 |
| `tests/services/permissions/autoModeQualification.test.ts` | 2 | 7 pass | 路由 resolver 被固定返回值替代，修改 auth 文件不再改变评测指纹 |
| `tests/services/model/resolveModelCapabilities.test.ts` | 1 | 5 pass | `getInitialSettings` 没有读取测试写入的 `modelCapabilityCatalogUrl: null`，导致仍调用公共目录 fetch mock |
| `tests/services/feature-flags/betas.test.ts` | 1 | 1 pass | `localModelHasCapability` 残留 mock 返回 false，覆盖真实能力配置 |
| `tests/services/model/antLingProvider.test.ts` | 1 | 4 pass | 翻译函数残留为返回原始 key，实际拿到 `onboarding.platform.ant-ling` |
| `tests/tools/AgentTool/briefPreviewTree.test.tsx` | 2 | 13 pass | 翻译函数残留为返回原始 key，渲染得到 `agent.moreToolUses_one/other`，不包含预期摘要文案 |
| 合计 | 16 | 42 pass | 全部可通过跨文件组合复现 |

### 已确认的污染源

1. `tests/services/api/countTokens.test.ts:10` 全局替换 model 模块，其中 `getMainLoopModel` 固定返回 `gpt-5[1m]`。`vi.clearAllMocks()` 清除调用记录，不恢复真实模型实现。后续设置测试即使正确写盘，getter 仍返回固定值；评测任务因此触发 `Classifier configuration changed`。
2. `tests/services/auth/isUsingOAuth.test.ts:50` 全局替换 `resolveModelRequestContext`。测试结束后仍留下最后一次固定路由，资格测试中的真实 auth 文件变更不再影响路由和指纹。
3. `tests/services/api/messagesToOpenAI.test.ts:247/273/304` 替换 `localModelHasCapability`，最后一次实现始终返回 false。当前组合实测中，调用 `mock.restore()` 不能使后续文件重新使用真实模块实现。
4. `tests/utils/promptShellExecution.test.ts:41` 将 `getInitialSettings` 替换成闭包里的 `settingsOverride`；后续真实配置写入和 `resetSettingsCache()` 都不能改变这个替身的返回值。目录禁用查询和模型档位测试因此失败。
5. `tests/services/permissions/bypassPermissionPolicy.test.ts:66` 虽然尝试恢复模块，但使用的是 `import * as settingsActual` 这种 live binding。模块已被替换后，`{ ...settingsActual }` 再读取到的可能仍是替身，不是 mock 前的真实快照。组合运行能重现 7 项档位失败。
6. `tests/utils/fullscreen.test.ts:22`、`tests/services/tools/permissionsDenyOverride.test.ts:24` 等测试替换整个 i18n 模块，使 `tSync` 返回 key。前者与两个界面测试文件组合即可重现 3 项翻译相关失败。

既有注释中“spread 原始模块避免污染”“mock.restore 后已恢复”的说法不足以保证隔离。保留其他导出只解决导出缺失问题，没有恢复被覆盖的函数；对 live binding 的恢复还可能再次复制替身。

### 可直接运行的复现命令

```powershell
# 能力查询污染：后一个文件原本独立通过，组合后失败 1 项
bun test tests/services/api/messagesToOpenAI.test.ts tests/services/feature-flags/betas.test.ts

# 模型路由污染：后一个文件原本独立通过，组合后失败 2 项
bun test tests/services/auth/isUsingOAuth.test.ts tests/services/permissions/autoModeQualification.test.ts

# 主模型污染：组合后失败 5 项，其中评测 2 项、档位 3 项
bun test tests/services/api/countTokens.test.ts tests/services/settings/modelTierSettings.test.ts tests/services/permissions/autoModeEvaluationTask.test.ts

# 配置读取污染：组合后目录查询失败 1 项、档位失败 7 项
bun test tests/utils/promptShellExecution.test.ts tests/services/model/resolveModelCapabilities.test.ts tests/services/settings/modelTierSettings.test.ts

# 错误的模块恢复：组合后档位失败 7 项
bun test tests/services/permissions/bypassPermissionPolicy.test.ts tests/services/model/resolveModelCapabilities.test.ts tests/services/settings/modelTierSettings.test.ts

# 翻译污染：组合后平台名失败 1 项、摘要文案失败 2 项
bun test tests/utils/fullscreen.test.ts tests/services/model/antLingProvider.test.ts tests/tools/AgentTool/briefPreviewTree.test.tsx
```

各组合的失败存在重叠；不能把这些命令的失败数相加。按完整失败标题去重，与原全量 16 项逐项比较，覆盖 16/16。

## 架构检查分类

检查器当前报告 585 条普通违规，其中大部分已经登记；导致退出失败的是 49 条未登记文本节点，以及另外检查的 1 处新含 any 断言。“新增”指不在精确违规基线中，不代表刚刚这个任务新增。

| 文件 | 文案节点数 | 审核结论 |
| --- | ---: | --- |
| `src/components/MessageActions.tsx` | 17 | 存在真实遗漏：`edit`、`copy`、`navigate`、`back` 和输入标签用于用户界面；动态拼接的 `collapse/expand`、`copy ...` 还需一起审核，当前清单不是完整覆盖 |
| `src/components/IdeOnboardingDialog.tsx` | 11 | 真实遗漏：欢迎文案、IDE 功能介绍和继续提示直接写英文 |
| `src/components/PromptInput/usePromptInputViewModel.tsx` | 7 | 真实遗漏：macOS Option/Meta 提示为英文；同一段文案会被拆成多个节点计数 |
| `src/components/messages/CollapsedReadSearchContent.tsx` | 6 | Hook 统计、记忆召回等整句未走 i18n；`PreToolUse` 等技术名称可保持原名，但句子应通过翻译模板组合 |
| `src/commands/effort/EffortPicker.tsx` | 4 | 均为 `Enter`/`Esc` 字面量；应按快捷键组件规范统一，不能直接理解为四个英文句子未翻译 |
| `src/components/messages/TeamMemCollapsed.tsx` | 2 | `team` 与其他翻译片段拼接，应翻译完整组合文案 |
| `src/components/PromptInput/Notifications.tsx` | 1 | `edit in ...` 确实是向用户展示的说明，应通过含编辑器名变量的翻译模板生成 |
| `src/components/VertexLogin.tsx:102` | 1 | 确定误报：`Record<Phase, Phase>` 中的 `summary: 'checks'` 表示返回状态，不是用户文案，不能翻译 `checks` |
| 合计 | 49 | 存在真实遗漏、快捷键规范问题和确定误报，不应整体加入白名单 |

### 含 any 的断言

`src/services/api/anthropicProviderAdapter.ts:161`：

```ts
const rawStream = result.data as unknown as AsyncIterable<any>
```

这是一处真实的不安全类型逃逸。注释里的 Biome ignore 只影响 Biome，不会豁免架构检查。应优先删除不必要的断言、使用 SDK 推导的流类型，或在转换边界使用明确事件类型及守卫。

检查器将其标成 `nonAdapter` 则是目录分类偏差：只把 `/conversions/`、`/bridge/`、`/adapters/` 算作适配层，没有识别 `services/api/*ProviderAdapter.ts`。这不意味着把它改标成适配层就可以接受新 any；分类标签与是否超出基线是两个问题。

当前含 any 断言总量为 41，低于基线 54；仍失败是因为规则按具体声明位置及内容比较，有 1 处新断言，不能用减少其他旧断言来抵消。

### 不属于本次阻塞的项目

- 27 个超过 1500 行的文件是职责审查提示，不直接导致失败，也不要求机械拆文件。
- `utilsDep` 4 项、`utilsI18n` 1 项、`utilsIO` 1 项已有基线登记，属于已有边界债务。
- 不能通过直接执行 `--write-baseline` 消除此次失败；那会把真实漏翻译和不安全断言一起接受。

## 处理优先级

1. 先修测试隔离。优先使用真实临时配置、运行时注入和纯函数参数；确需整模块 mock 的测试使用独立进程或明确的 mock 前导出快照恢复。增加“污染源 + 被影响文件”的组合回归，单独跑绿不再作为隔离已修复的证据。
2. 对具有安全约束的评测、资格与模式切换测试保留现有断言；应恢复真实依赖，而不是关闭配置变更保护或改成无条件接受。
3. 补齐确实面向用户的中英文模板。整句插值，避免逐个词翻译和在模块初始化时固定语言。
4. 修正状态映射误报，为检查器增加相应上下文测试；保留对真正 UI `summary` 字段的检测。统一快捷键提示组件。
5. 移除流对象的不必要类型断言，再运行类型检查、相关协议测试和全量测试。完善适配层路径识别，但不以放宽白名单替代类型修复。

修复完成的标准应为：组合回归和全量回归同时通过，真实文案告警消除，误报有检查器测试说明，且违规基线没有未经审核的扩张。

## 修复与验证结果

- 将污染源的整模块 mock 改为可恢复的函数 spy，并在测试结束后恢复。提示词 shell 守卫使用真实临时设置验证；输出落盘测试也恢复配置目录函数，避免将其他测试指向已删除的临时目录。
- 增加独立 Bun 进程运行的跨文件组合回归，覆盖污染源及其受影响测试，保留权限、评测及模式切换的既有安全断言。
- 补齐菜单、IDE 引导、编辑器提醒、Hook 及团队记忆摘要的完整中英文模板，复用快捷键提示组件；翻译在渲染时读取。
- 状态转换映射仅在同一有限状态联合类型内获得机器标识豁免，新增检查器测试确保普通 UI 字段及非法状态仍会报错。
- 删除流对象的多余类型断言，直接使用 SDK 推导类型。没有修改架构违规基线，也没有以路径分类调整规避类型检查。
- 全量测试：2284 通过、1 跳过、0 失败；跳过项为既有的真实 WebSearch 集成测试。跨文件组合回归通过。
- 类型、格式、架构、翻译初始化和中英文键值一致性检查通过。架构检查没有新增违规；含 any 断言为 40，基线为 54。
- 中英文原生 TUI 输入验证通过，覆盖消息操作菜单、思考强度选择及 IDE 引导的显示与键盘操作。
