# REPL 重构结构评审

> 评审对象：`src/screens/REPL.tsx` 与 `src/screens/repl/` 目录
> 评审时间：2026-05-29
> 关注点：拆分是否合理、复杂度是否真正解耦、子组件命名分组是否合适
>
> **三方评审结构**：
> - §1–5：初稿评审（qoder）
> - claude code 反驳（外部输入，未收录全文）：认可解耦成果，但框架上认为「复杂度转移」总论被夸大、god-hook 切 3 个会更糟、replQueryFlow 已拆、prop drilling 与可测性是真实 tradeoff
> - §6：qoder 收到 claude code 反驳后的二轮自修正与反思
> - §7：第三方独立评审（ZY Code，逐文件交叉验证后给出）

## 一、现状速览

`screens/repl/` 共 26 个文件，约 6788 行；加上根目录的 `REPL.tsx`（1231 行），整个 REPL 体系 ~8020 行。

**体量分布（前 6 名）**

| 文件 | 行数 |
|------|------|
| `repl/replQueryFlow.ts` | 1177 |
| `REPL.tsx` | 1231 |
| `repl/ReplMainView.tsx` | 1020 |
| `repl/ReplDialogDispatch.tsx` | 486 |
| `repl/useReplQueryCallbacks.ts` | 471 |
| `repl/replCallbacks.ts` | 463 |

## 二、合理之处（解耦确实发生了）

1. **横向切出 11 个边界清晰的领域 hook**：`Input / Voice / Loading / Transcript / OnCancel / Notifications / IdeState / SandboxAsk / SessionRestore / ToolPermission / Proactive`，输入输出收敛，单元可测。
2. **引入 `createReplStore` + `ReplStoreProvider`**，吸收了 `messages / toolJSX / streamingToolUses / queues` 等高频共享态，子组件通过 `useReplState` 字段订阅，避免顶层一次性 re-render 全树。`REPL.tsx` 注释明确"REPL 自身订阅整体、子组件按字段订阅"，是经过权衡的设计。
3. **视图按 screen 双分支拆分**：`prompt → ReplMainView`、`transcript → ReplTranscriptView`，避免一个组件兼顾两屏。
4. **副作用集中**到 `useReplEffects / useReplInitialMessage / useReplSessionRestore`，纯渲染交给 view，符合 React 的关注点分离。
5. **回调 Impl 抽到 `replCallbacks.ts`**（rewindConversationToImpl / restoreMessageSyncImpl / onInitImpl …），主组件用 `useCallback + ctx` 调用 Impl，依赖收敛、可单测。

## 三、复杂度被"转移"而非"消除"的地方

下列 4 处是真问题，不是完全的解耦。

### 1. `useReplQueryCallbacks` 是 god-hook

`UseReplQueryCallbacksParams` 一个 param 对象有 **~70 个字段**，`REPL.tsx` 调用处一次性透传 ~50 个进去。它对外吐 6 个 callback：`getToolUseContext / handleBackgroundSession / onQueryEvent / onQueryImpl / onQuery / onSubmit`。

> 这等于把原 `REPL.tsx` 里"查询编排"那一坨原地挪了文件位置——参数面没收敛，依赖面没收敛，仅是把 function body 平移走。

**改进方向**：再切成 `useReplQuerySubmit`（onSubmit 链）、`useReplQueryStream`（onQueryEvent / onQueryImpl）、`useReplToolUseContextBuilder`（getToolUseContext）三块，并用 ref/store 收敛而不是 50 个 prop。

### 2. `ReplMainView` 接近 100 个 prop

`REPL.tsx` 透传了约 90 个 prop。Store 已经存在，但许多本可以走 store 的字段（`mainLoopModel / commands / tools / mcpClients / addNotification / focusedInputDialog` 等）仍走 prop drilling。

> 视图被拆出来了，但"prop drilling"这一种复杂度只是从内联换成了 props 列表。

**改进方向**：让 `ReplMainView` 自己 `useReplState() / useAppState()`，把 props 砍到只剩"父级才能给"的部分（如 `ref / 一次性 callback`）。

### 3. `replQueryFlow.ts` 1177 行未拆

这是最大的单文件，仍然是巨型管线。重构主要拆了"hooks 容器"，没真正拆 query 流水线。也是为什么 `useReplQueryCallbacks` 上下文巨量——下游消费的就是这条单管线。

**改进方向**：按阶段切 `prepare / route / dispatch / aggregate / finalize` 等子模块。

### 4. `replCallbacks.ts` 463 行命名过宽

里面同时有 `rewindConversationToImpl / restoreMessageSyncImpl / executeQueuedInputImpl / handleIncomingPromptImpl / onInitImpl / onAgentSubmitImpl / handleExitImpl / buildMessageActionCaps`——一个杂物袋。命名 `*Impl` 与 `useRepl*` 之间没有清晰的"为什么进 hook 为什么进 impl"分类规则。

## 四、命名 / 分组合理性

### 命名

`useRepl*` 前缀一致、可读，文件名能直接对应到职责，单看名字基本可猜内容，这点是好的。

### 分组

当前 `screens/repl/` 是**完全扁平**的 26 个文件，没有进一步按域分子目录。横向看，文件已自然形成 5 个簇，可考虑：

```
screens/repl/
  view/           ReplMainView.tsx, ReplTranscriptView.tsx, ReplDialogDispatch.tsx
  query/          replQueryFlow.ts, useReplQueryCallbacks.ts, useReplBackgroundQuery.ts
  lifecycle/      useReplEffects.ts, useReplInitialMessage.ts, useReplSessionRestore.ts,
                  useReplScheduledTasks.ts, useReplProactive.ts
  input/          useReplInput.ts, useReplVoice.ts, useReplOnCancel.ts, useReplRequestPrompt.ts
  state/          useReplLoadingState.ts, useReplIdeState.ts,
                  useReplToolPermissionContext.ts, useReplActiveRemote.ts,
                  useReplNotificationsCluster.ts, useReplSandboxAsk.tsx, useReplTranscript.ts
  callbacks/      replCallbacks.ts, getFocusedInputDialog.ts, handleSummarize.ts
```

子目录化后能立刻看出"输入/查询/视图/生命周期/状态"五条线，比当前一面墙的扁平列表更易导航。

## 五、结论

| 维度 | 评价 |
|------|------|
| 是否真的拆开 | ✅ 领域 hook、view/query 分层、ReplStore 引入，不是纯文件搬运 |
| 是否还有复杂度搬家 | ⚠️ 3 处明显：god-hook、prop drilling、巨型管线 |
| 命名 | ✅ 一致清晰 |
| 分组 | ⚠️ 26 个文件平铺，建议子目录化 |

**一句话总结**：**结构改善了，但还差一公里**。下一步要做的不是再拆文件，而是：

1. 让 `ReplMainView` / `useReplQueryCallbacks` 直接吃 store，而不是 70/90 个 prop。
2. 切 `replQueryFlow.ts`。
3. `screens/repl/` 子目录化。

## 六、评审自审与修正（qoder 二轮，2026-05-29）

qoder 收到 claude code 的框架性反驳后，重新审视初稿判断，记录收回与让步。保留原文不删，把论辩痕迹明文记录，便于后续读者看清取舍。

### 6.1 收回的判断

#### A. 「god-hook 切成 3 个 hook」是错药方

原文 §3.1 建议把 `useReplQueryCallbacks` 切成 `useReplQuerySubmit / useReplQueryStream / useReplToolUseContextBuilder`，**这是错的**。

理由：`onSubmit → onQuery → onQueryImpl → getToolUseContext` 是同一条调用链，共享同一个 ctx。切成 3 个 hook 后，这同一个 ctx 要么复制 3 份 prop 面、要么 hook 之间互相 plumbing —— 总耦合面只增不减。

更深一层：**~70 字段的 param 接口正是「抽出 hook」这个动作本身的代价**。逻辑内联在 REPL 时所有值都在闭包里，没有 param 面；一旦抽出 hook，要么显式 param、要么走 store/context、要么 prop drilling，三选一都付代价。

正确的问法不是「切成几块」，而是 **「这个 hook 该不该存在」**：

| 方案 | 优势 | 代价 |
|------|------|------|
| A. 放回 REPL 内联，`ctx = useMemo(...)` | 无 param 面 | REPL 多 ~230 行 |
| B. 保持现状 hook 抽离 | REPL 干净 | 70 字段 param 显式接口 |
| C. 让 ctx 直接读 store/context | 无 param 面 + REPL 干净 | 失去显式数据流，难单测 |

这三方案是真实的 tradeoff，原文「切三个」不在三角里。

#### B. 「`replQueryFlow.ts` 1177 行未拆」表述错误

原文 §3.3 称「这是最大的单文件，仍然是巨型管线，重构主要拆了 hooks 容器，没真正拆 query 流水线」。

**事实核查**：`replQueryFlow.ts` 实际已经是 5 个 export function + 2 个 ctx type 的分离结构：

- `QueryFlowContext` / `SubmitFlowContext`（type）
- `buildToolUseContext`
- `handleQueryEvent`
- `runQueryImpl`
- `runQuery`
- `handleSubmit`

每个函数各自可测。「拆成多个文件」是 cosmetic 改进，不影响实际可维护性。原文基于行数下判断而未读结构，属于评审硬伤，收回。

#### C. 「`ReplMainView` 直接吃 store」的建议自相矛盾

原文一边表扬抽离 hook「可单测」（依赖通过 param 注入），一边推 `ReplMainView` 用 `useReplState() / useAppState()` 自取 —— 后者要 mock 一堆 Provider 才能测，**会损害可测性**。

「少 prop」与「组件是 props 的纯函数」是真实 tradeoff，不是单调更优。原文把「少 prop」当无条件改进，是疏忽。

### 6.2 修正后的精确判断

| 原文判断 | 修正后 |
|---|---|
| god-hook，建议切 3 个 | god-hook 是抽离的固有代价；应先回答「该不该抽」，切 3 个会更糟 |
| `replQueryFlow.ts` 未真正拆 query 流水线 | 已分 5 函数 + 2 ctx type，进一步拆文件是 cosmetic |
| `ReplMainView` prop drilling 都该走 store | 约 1/3 是 ceremony 可消（`addNotification` / `mainLoopModel` 等 context/hook 类）；剩余 2/3 是显式数据流的合理代价；强推 store 会损失可测性 |
| 「复杂度搬家」总论 | 部分场景成立（ceremony 类）、部分场景是内在复杂度的必然表达，原文 framing 过强 |

### 6.3 仍然站得住的判断

- **§3.4 `replCallbacks.ts` 是杂物袋**：8 个互不相关 Impl 塞一个文件，`*Impl` 与 `useRepl*` 命名规则也不清晰。这条最扎实。
- **`ReplMainView` 透传 `addNotification / mainLoopModel` 是无意义 ceremony**：这两个本来就是 `useNotifications()` context 与 `useMainLoopModel()` hook，组件自取无任何代价。可砍 ~20–30 个 prop。
- **子目录化建议**：低风险导航改进，仍然推荐。
- **第二节「合理之处」**：5 条解耦成果描述准确，不是客套。

### 6.4 内在复杂度 vs 偶然复杂度的分界

查询管线天然触及 `messages + tools + permissions + mcp + remote + streaming` —— 这是**内在复杂度**，无法通过设计消除。但「用什么方式表达这种依赖」是**偶然复杂度**：

- god-hook 的 70 param 是抽离动作的固有代价（内在 + 偶然边界处）
- `ReplMainView` 透传 context/hook 类 prop 是纯偶然复杂度（可消）
- `ReplMainView` 透传 ref / 一次性 callback 是显式数据流（合理代价）

## 七、第三方独立评审（ZY Code，2026-05-29）

> 评审者：ZY Code（基于 qoder 初稿 §1–5、claude code 反驳原文、qoder 二轮自修正 §6，逐文件交叉验证后给出独立判断）

### 7.1 同意 claude code 反驳 / qoder 二轮修正的部分

- **claude code「切 3 个 hook 会让情况更糟」→ qoder §6.1A 收回**：完全同意。`replQueryFlow.ts` 中 `handleSubmit → runQuery → runQueryImpl → handleQueryEvent` 是同一条调用链，`buildToolUseContext` 被整条链共享。切 3 个 hook 只会把同一个 ctx 在 hook 间多传一遍，耦合面只增不减。
- **claude code「replQueryFlow.ts 已拆」→ qoder §6.1B 收回**：完全同意。5 个 export function + 2 个 ctx type，结构清晰。1177 行是内在复杂度的真实表达（`handleSubmit` 单函数处理了即时命令、空闲返回、历史记录、推测接受、远程模式、正常提交 6 条分支路径）。

### 7.2 认为 claude code 反驳 / qoder 二轮修正过头的地方

**关于 `ReplMainView` props：claude code 和 qoder 二轮都没有看彻底。**

claude code 指出初稿自相矛盾——「一边表扬 hook 可单测，一边推 ReplMainView 自己吃 store 损可测性」。qoder §6.1C/§6.2 接受了这个 tradeoff，退到「约 1/3 是 ceremony 可消，剩余 2/3 是显式数据流的合理代价」。

但实际看代码（`ReplMainView.tsx:377-413`），**组件已经在大量读 store**：

- 14 个 `useReplState()` 选择器
- 12 个 `useAppState()` 选择器

文件头注释也写着「Renders inside `<ReplStoreProvider>`; reads store state via `useReplState()`. Only truly local values (callbacks, refs, flags) are props.」

也就是说——**stated 设计原则和实际实现不一致**。组件一边声称只接 local values 作 props，一边已经重度依赖 store。那 90 个 props 中，像 `addNotification`（来自 `useNotifications()` context）、`mainLoopModel`（来自 `useMainLoopModel()` hook）这类「无状态上下文类」，组件自取零成本。可测性论点在这里是虚的——你本来就要 mock Provider，多一个 `useNotifications` 不会增加测试负担。

claude code 把「少 prop」和「可测性」对立起来是对的，qoder 接受这个对立也合理，但两边都没有追问：**既然 ReplMainView 已经在吃 store，为什么不把这条原则贯彻到底？** 剩下的 ceremony props 不是「显式数据流的合理代价」，而是「拆到一半留下的尾巴」。

### 7.3 两方都未发现的关键问题

#### `useReplQueryCallbacks` 是纯 passthrough，应当消除

对比 `useReplQueryCallbacks.ts:52-137`（`UseReplQueryCallbacksParams`，~70 字段）和 `replQueryFlow.ts:140-202`（`QueryFlowContext`，~50 字段）：

**这两个类型几乎是同一个东西**。`useReplQueryCallbacks` 做的事：

1. 解构 70 个 params
2. 用 `useMemo` 把同样的字段重新组装成 `queryFlowCtx`（`useReplQueryCallbacks.ts:210-303`）
3. 包 6 个 `useCallback`，每个都是 `(args) => flowFn(queryFlowCtx, args)` 的一行转发

这个 hook 不含有任何业务逻辑——它是 React 层和纯 TS 层之间的**机械翻译层**。70 字段的 params 接口不是「抽离的固有代价」（qoder §6.1A 转述 claude code 观点后的说法），而是**多了一层不必要的中间接口**。

正确的做法：让 `useReplQueryCallbacks` 直接读 store/context 构建 `queryFlowCtx`，而不是从 REPL.tsx 接收 70 个 params 再原样打包。这正是 qoder §6.1 的 option C，qoder 列出来了但没有推荐——可能因为接受了 claude code 的「可测性」框架而高估了代价。

#### `ReplMainView` 的 props 来源分析

90 个 props 大致可分三类：

| 类别 | 数量 | 示例 | 能否消掉 |
|------|------|------|----------|
| Store/context 类（组件已能自取） | ~20-30 | `addNotification`, `mainLoopModel`, `tools`, `commands`, `mcpClients` | ✅ 自取零成本 |
| Hook 产物（REPL.tsx 中 hook 计算结果） | ~40-50 | `inputValue`, `isLoading`, `spinnerMessage`, `onCancel`, `onSubmit` | ⚠️ 需要把对应 hook 下沉到 ReplMainView，或保持 props |
| Ref / 一次性 callback | ~10-20 | `scrollRef`, `insertTextRef`, `handleRestoreMessage` | ❌ 显式数据流，合理代价 |

第一类是纯 ceremony，应该消掉。第二类是「REPL 已拆出专职 hook 但产物仍需透传」的结构性代价——消掉意味着把 hook 下沉到 ReplMainView，等于撤销部分拆分。第三类是真实的显式数据流代价。

### 7.4 对三方各论点的最终裁决

| 论点 | qoder 初稿 §1–5 | claude code 反驳 / qoder §6 | ZY Code 裁决 |
|------|------------|-------------------|--------------|
| god-hook 切 3 个 | 建议切 | claude code：会更糟；qoder：收回 | ✅ claude code 对 |
| `replQueryFlow.ts` 未拆 | 是巨型管线 | claude code：已拆；qoder：收回 | ✅ claude code 对 |
| `ReplMainView` prop drilling | 都该走 store | claude code：强推 store 损可测性；qoder：接受 tradeoff | ⚠️ 三方都不完全对：组件**已经**在吃 store，ceremony 类 props (~20-30) 应继续消掉 |
| `replCallbacks.ts` 是杂物袋 | 命名过宽 | claude code：仍站得住；qoder：同意 | ✅ 站得住，但严重度不高——4 个 export，命名可优化但不影响维护 |
| god-hook 70 params 是内在代价 | — | claude code：是抽离的固有代价；qoder：同意 | ❌ **不是**——`useReplQueryCallbacks` 是纯 passthrough，应让 hook 自己读 store，消除 params/ctx 双重接口 |
| 子目录化 | 推荐 | 仍推荐 | ✅ 低风险导航改进 |

### 7.5 行动建议（按 ROI 排序）

1. **消除 `useReplQueryCallbacks` 的 passthrough**：让 hook 直接读 store/context 构建 `queryFlowCtx`，砍掉 `UseReplQueryCallbacksParams` 类型。REPL.tsx 调用处从透传 ~70 个字段变成零参（或仅传不可从 store 读取的少数 callback）。这是当前最大的偶然复杂度。
2. **消掉 `ReplMainView` 的 ceremony props**：`addNotification`、`mainLoopModel`、`tools`、`commands`、`mcpClients` 等 store/context 类 props 让组件自取，贯彻文件头 stated 原则。
3. **子目录化**：低风险，随时可做。
4. **`replCallbacks.ts` 按领域拆或重命名**：优先级最低，当前 4 个 export 不构成维护瓶颈。

## 附：相关文件链接

- [REPL.tsx](../src/screens/REPL.tsx)
- [ReplMainView.tsx](../src/screens/repl/ReplMainView.tsx)
- [ReplTranscriptView.tsx](../src/screens/repl/ReplTranscriptView.tsx)
- [ReplDialogDispatch.tsx](../src/screens/repl/ReplDialogDispatch.tsx)
- [replQueryFlow.ts](../src/screens/repl/replQueryFlow.ts)
- [useReplQueryCallbacks.ts](../src/screens/repl/useReplQueryCallbacks.ts)
- [replCallbacks.ts](../src/screens/repl/replCallbacks.ts)
