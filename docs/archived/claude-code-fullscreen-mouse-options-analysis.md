# Claude Code fullscreen 鼠标选项点击能力分析

## 结论

Claude Code 与 zy-code 在 fullscreen/alt-screen 下的底层路线基本一致：进入备用屏幕、启用 DEC 鼠标追踪、解析 SGR 鼠标事件，再通过 Ink/React 树做 hit-test 和事件派发。

zy-code 与 Claude Code 的主要差距不在终端协议层，而在交互组件层：底层已经支持 `onClick`、命中测试和冒泡，但修复前 `Select`/`ListItem` 与 slash command 候选这类选项组件没有把每一行注册为可点击目标，也没有把“点击某行”映射为对应 action。因此当时只有显式挂了 `onClick` 的组件（例如折叠块、链接、Logo、路径等）能响应点击；普通 TUI 选项只能通过键盘、数字键或 Enter 使用。

## 与 fullscreen-and-ink-improvements.md 的现状校准

`docs/future-plan/fullscreen-and-ink-improvements.md` 是 2026-06-06 形成的差异分析，内容需要分段看：

- 前半部分的“zy-code 缺少 / 完全缺失”多处已经过时，例如 fullscreen reason、Windows+SSH 自动禁用、settings 持久化、`/tui` MVP、`ZY_CODE_DISABLE_ALTERNATE_SCREEN`、tmux focus-events 提示、upsell/downsell、feature flag 灰度、frameSink、LIVE_COUNTS、Click-to-Expand 等能力，在当前源码中已经存在或已有等价实现。
- 文档第六节“实施优先级总览”和第七节 Bash 折叠结论更接近当前状态：除屏幕阅读器完整模式、`/tui` relaunch/resume Step B 等少数项外，大部分 fullscreen/Ink 差异已经完成。
- 旧文档的 Click-to-Expand 章节描述的是“消息/折叠块级点击展开”，它已经由 `Messages.tsx` 的 `expandedKeys`、`VirtualMessageList.tsx` 的 `VirtualItem onClick`、`ClickEvent.cellIsBlank` 等链路覆盖。这不等于“所有 TUI 选项都可点击”。

因此，本文件讨论的是旧文档没有覆盖到的新残差：**通用选项组件的鼠标 action 化**。现状可以概括为：

| 层级 | 当前状态 | 代表位置 |
| --- | --- | --- |
| fullscreen 决策与推广 | 基本已同步旧文档规划 | `src/utils/fullscreen.ts`、`src/commands/tui/tui.ts`、`src/components/FullscreenUpsell/FullscreenUpsellDialog.tsx`、`src/hooks/notifs/useFullscreenDownsell.ts` |
| Ink 鼠标协议与事件派发 | 已具备；absolute overlay 命中已补齐 | `src/ink/termio/dec.ts`、`src/ink/parse-keypress.ts`、`src/ink/components/App.tsx`、`src/ink/hit-test.ts` |
| 消息/折叠块点击展开 | 已具备 | `src/components/Messages.tsx`、`src/components/VirtualMessageList.tsx` |
| 通用 Select/Menu 选项点击 | 本轮已补齐 | `src/components/CustomSelect/select.tsx`、`src/components/CustomSelect/select-mouse-actions.ts`、`src/components/design-system/ListItem.tsx` |
| slash command 候选点击 | 本轮已补齐 | `src/components/PromptInput/PromptInputFooterSuggestions.tsx`、`src/components/PromptInput/PromptInputFooter.tsx`、`src/components/FullscreenLayout.tsx`、`src/hooks/useTypeahead.tsx` |

这也是用户实际体验上“折叠块可点击、选项不可点击”的修复前根因：旧文档 P1 的 Click-to-Expand 已经解决了消息列表；本轮把相同的鼠标事件能力继续推广到了 `CustomSelect` 与 slash command 候选列表。

## 2026-07-01 补充：slash command 候选也是独立路径

实测还发现一个遗漏：Claude Code 的 `/` slash command 候选列表也支持鼠标悬浮与点击，而 zy-code 的 slash command 候选不走 `CustomSelect`，因此前面的 `Select` 修复无法覆盖它。

zy-code 的 slash command/file/agent/shell 等输入补全候选由以下链路渲染：

1. `src/hooks/useTypeahead.tsx` 负责生成候选、维护 `selectedSuggestion`，并处理 Tab/Enter 接受逻辑。
2. `src/components/PromptInput/PromptInputFooter.tsx` 在普通渲染模式内联渲染候选。
3. fullscreen 模式下，`PromptInputFooter` 将候选数据写入 `promptOverlayContext`。
4. `src/components/FullscreenLayout.tsx` 的 `SuggestionsOverlay` 再把候选 portal 到 prompt 上方。
5. `src/components/PromptInput/PromptInputFooterSuggestions.tsx` 渲染每一行候选。

此前缺口有两层：

1. 第 5 步的候选行只渲染 `Text`，没有行级 `Box onMouseEnter/onClick`，同时 overlay context 只传候选数据，不传鼠标 action。
2. fullscreen 的 `SuggestionsOverlay` 使用 `position="absolute" bottom="100%"` 从 bottom slot 父布局框上方逃逸；渲染器支持这种可见逃逸，但 `src/ink/hit-test.ts` 过去会在鼠标点不在父节点矩形内时直接返回，导致视觉上可见的 overlay 无法触发 hover/click。

结果是键盘方向键/Enter 可用，但鼠标悬浮不会把高亮切到鼠标所在行。

本轮实现后的行为：

- hover 某一行候选：调用 `focusSuggestion(index)`，更新 `selectedSuggestion`，因此高亮随鼠标移动。
- click 某一行候选：调用 `acceptSuggestion(index)`，复用键盘 Enter 的接受/执行逻辑。
- 普通 footer 与 fullscreen overlay 共用同一个 `PromptInputFooterSuggestions` 组件。
- 候选行 `Box width="100%"`，命中范围覆盖整行，而不是只覆盖文字宽度。
- `hitTest` 会继续检查逃出父布局框的 absolute 子节点，覆盖 fullscreen overlay 浮在 prompt 上方的场景。

这条路径需要与 `CustomSelect` 分开维护：`CustomSelect` 修菜单/选择器，`PromptInputFooterSuggestions` 修输入框补全候选，两者都属于“控件层 action 化”，但状态源与接受逻辑不同。

## Claude Code 侧观察

Claude Code CLI bundle 路径：

`D:\nvm\nvm4w\nodejs\node_global\node_modules\@anthropic-ai\claude-code\bin\claude.exe`

提取到的关键锚点：

| 能力 | Claude bundle offset | 观察 |
| --- | ---: | --- |
| SGR 鼠标追踪 | `59731522` | bundle 中存在 `ESC[?1000h` + `ESC[?1006h` 的启用序列；该偏移附近来自打包内容，但能确认二进制包含 DEC mouse tracking。 |
| 同步输出 | `16330719` | 存在 `ESC[?2026h`，用于 synchronized update，减少 fullscreen 重绘闪烁。 |
| React/Ink 事件 props | `97604896` | 可读字符串包含 `onClick`、`onMouseEnter`、`onMouseLeave`、`onWheel`、`onKeyDown`、`onAction`、`hoverIgnoresBlankCells` 等，说明其 TUI host 层把鼠标/动作事件作为通用 props 处理。 |
| 终端模式抽象 | `97958736` | 可读字符串包含 `alternateScreen`、`bracketedPaste`、`mouseTracking`、`normal`、`button`、`any`、`focusEvents`。 |
| DEC 模式解析 | `219922903` | 可读 minified JS 显示 `MOUSE_NORMAL`、`MOUSE_BUTTON`、`MOUSE_ANY` 被解析为 `{ type:"mode", action:{ type:"mouseTracking", mode:"normal/button/any/off" } }`。 |

基于这些锚点可以推断 Claude Code 的 fullscreen 鼠标能力是分层实现的：

1. 终端层启用 DEC mouse tracking，至少包含普通点击/释放和 SGR 坐标格式；bundle 中还出现 `button`/`any` 模式，说明支持拖拽与悬停类事件。
2. 输入解析层把终端序列转换为结构化鼠标事件。
3. UI host 层支持通用 `onClick`、`onMouseEnter`、`onMouseLeave`、`onWheel`、`onAction` 等 props。
4. 交互控件层把每个菜单项/选项渲染为可命中的节点，并将鼠标点击转为对应 action。

第 4 点是 zy-code 修复前缺失最明显的部分；本轮已先覆盖 `CustomSelect` 与 slash command 候选两条主路径。

### 2026-07-01 补充：Claude Code 的 hoveredId 分离设计

通过提取 Claude Code 二进制（offset `220256761`、`228502661`）发现其关键设计：

**核心组件签名**（minified 后还原）：
```javascript
function SuggestionList({
  suggestions,
  selectedSuggestion,  // 只用于滚动计算
  hoveredId,           // 独立的 hover 状态
  onHoverChange,       // 更新 hoveredId 的回调
  onSelect,            // 点击时调用
  // ...
})
```

**关键实现逻辑**：
1. `hoveredId` 与 `selectedSuggestion` 是完全独立的状态
2. `onMouseEnter` 只更新 `hoveredId`，不触发滚动
3. 高亮逻辑：`isSelected = x.id === (hoveredId ?? selectedSuggestion)`
4. 滚动逻辑只基于 `selectedSuggestion`，与 `hoveredId` 无关
5. `onMouseLeave` 清除 `hoveredId`（设为 `null`）

**为什么这样设计**：
- 鼠标只能移入当前可见的选项，如果 hover 触发滚动，会导致：
  1. 鼠标下的选项可能移出视口
  2. 触发新的 `onMouseEnter` 事件
  3. 形成循环，导致 UI 抖动

**zy-code 的修复方案**：
- `CustomSelect` 和 `PromptInputFooterSuggestions` 都采用相同的 `hoveredId` 分离设计
- `select-mouse-actions.ts` 中的 `createOptionHoverHandler` 更新 `hoveredId` 而非调用 `focusOption`

## zy-code 当前实现

### 已有能力

| 能力 | zy-code 位置 | 状态 |
| --- | --- | --- |
| 进入备用屏幕并启用鼠标追踪 | `src/ink/components/AlternateScreen.tsx:51`、`:62` | 已有 |
| DEC 模式常量 | `src/ink/termio/dec.ts:17`-`:20`、`:51` | 已有 |
| 同时启用 1000/1002/1003/1006 | `src/ink/termio/dec.ts:51`-`:55` | 已有 |
| SGR 鼠标事件解析 | `src/ink/parse-keypress.ts:65`、`:572` | 已有 |
| 鼠标事件进入 App 处理 | `src/ink/components/App.tsx:524`、`:573` | 已有 |
| 点击命中测试和冒泡 | `src/ink/hit-test.ts:17`、`:45`、`:71` | 已有 |
| Box 暴露 `onClick`/hover props | `src/ink/components/Box.tsx:29`、`:42` | 已有 |
| ThemedBox 透传 `onClick` | `src/components/design-system/ThemedBox.tsx:38` | 已有 |

`src/ink/termio/dec.ts` 已经启用：

```ts
decset(DEC.MOUSE_NORMAL) +
decset(DEC.MOUSE_BUTTON) +
decset(DEC.MOUSE_ANY) +
decset(DEC.MOUSE_SGR)
```

这意味着底层并不只支持折叠块；任何渲染在 alt-screen 内、并挂了 `onClick` 的 Box 理论上都可以点击。

### 修复前缺失点

| 缺口 | zy-code 位置 | 说明 |
| --- | --- | --- |
| `Select` 只注册键盘输入 | `src/components/CustomSelect/use-select-input.ts:83`、`:113`、`:133`、`:167` | 当前只有 keybinding/useInput 路径：上下移动、Enter、数字键选择。没有鼠标 click 路径。 |
| 普通选项行没有 `onClick` | `src/components/CustomSelect/select.tsx:396`、`:504`、`:617`、`:754` | 不同布局下的 option row 都只是 `Box`/`SelectOption`/`TwoColumnRow`，没有挂点击处理。 |
| `SelectOption`/`ListItem` 不接收点击语义 | `src/components/CustomSelect/select-option.tsx:22`、`src/components/design-system/ListItem.tsx:103` | 选项组件只管视觉状态和 cursor declaration，没有 `onClick`、`onMouseEnter`、disabled/action 等交互 props。 |
| 点击只会触发显式 handler | `src/ink/hit-test.ts:41`、`:71` | hit-test 会命中节点并向上冒泡，但只有某个祖先存在 `_eventHandlers.onClick` 时才算 handled。普通选项行没有 handler，所以点击不会改变状态。 |

这解释了修复前现象：折叠块能点，是因为折叠块/路径/链接等局部组件显式挂了 `onClick`；选项不能点，是因为 `Select` 和 slash command 候选没有把每个 option row 注册为 clickable。

## 差异模型

Claude Code 更像是“控件默认可动作化”：

- 选项行不仅是文本，还绑定 action/click。
- 鼠标点击进入同一套 action 语义，而不是每个命令组件自己手写。
- Host 层提供 `onClick`/`onAction`/hover/wheel；控件层统一消费。

zy-code 的实现模型仍是“底层可点击，控件按需显式接线”：

- Ink host 已有 `onClick`。
- `dispatchClick` 也会冒泡。
- 本轮已将 `Select`、`ListItem` 和 slash command 候选接入鼠标 action；后续仍需检查其他 command TUI 是否还有自绘列表遗漏。

所以两边差距可以归纳为：

1. 不是缺 DEC 1006。
2. 不是缺 hit-test。
3. 不是缺 `onClick` prop。
4. 缺的是 `Select`/menu/list-item 级别的点击协议和复用实现。

## 已落地实现路线

### P1：让 `Select` 普通选项可点击

状态：已落地。

在 `src/components/CustomSelect/select.tsx` 中给每个可见 option row 包一层 `Box onClick`，点击时执行与键盘 Enter 一致的逻辑：

1. disabled option：忽略。
2. 普通 option：先 `state.focusOption(option.value)`，再 `state.selectFocusedOption?.()` 或直接 `state.onChange?.(option.value)`。
3. input option：点击时 focus 到该 input option；是否立即进入输入模式需要按现有 UX 决策，建议第一版只聚焦，不提交。
4. multi-select 若复用同 hook：点击应等价 Space/Enter toggle。

注意：`Select` 有 `compact`、`compact-vertical`、`expanded`、two-column description 等多条渲染路径，必须全部覆盖，否则会出现某些菜单可点、某些不可点。

### P1：抽一个内部 helper，避免散落逻辑

状态：已落地为 `src/components/CustomSelect/select-mouse-actions.ts`。

在 `src/components/CustomSelect/` 下增加窄作用域 helper，而不是放到 `src/utils/`：

- `select-mouse-actions.ts`
- 或在 `use-select-input.ts` 中导出 `activateOptionByValue`

职责：

- 检查 disabled。
- 根据 option 类型决定 focus/select/submit。
- 保持与键盘路径一致。

这样后续 `MultiSelect`、MCP elicitation、agents/hooks menu 可以共享行为。

### P2：扩展 `ListItem` 的点击语义

状态：已落地为可选 `onClick`/`onMouseEnter` 透传，仍由上层显式传入。

`ListItem` 可以增加可选 props：

- `onClick?: (event: ClickEvent) => void`
- `disabled?: boolean`
- `hoverable?: boolean`

但不建议第一步就让所有 `ListItem` 自动可点。更稳妥的方式是由 `SelectOption` 显式传入，避免消息列表、状态行等“长得像列表但不是菜单”的区域误触。

### P2：hover/focus 联动

状态：`CustomSelect` 与 slash command 候选已落地；其他自绘列表待排查。

Claude bundle 中出现 `onMouseEnter`/`onMouseLeave` 和 `hoverIgnoresBlankCells`，说明它可能在 hover 时同步高亮。zy-code 可以第二阶段补：

- hover 某个选项时 `state.focusOption(option.value)`。
- blank cell 是否触发 hover 需要谨慎，避免一整行空白改变焦点。
- 可在 `ZY_CODE_DISABLE_MOUSE_CLICKS=1` 下禁用点击，但保留 wheel/hover 的策略需要另行确认。

### P3：统一 action 层

如果要更接近 Claude Code，可以引入类似 `onAction` 的控件协议：

- `ListItem action="select:accept"` 或直接 `onAction={() => ...}`
- 鼠标、Enter、Space、数字键最后都进入同一个 action handler
- command TUI 不再手写重复的 keyboard/mouse 分支

这属于架构整理，不建议和第一步混在一起。

## 风险与验证

需要重点验证：

1. fullscreen 开启时：鼠标点击 option 能选择。
2. 非 fullscreen 时：行为不变，因为终端不会发送 SGR 鼠标事件。
3. `ZY_CODE_DISABLE_MOUSE=1`：点击不触发。
4. `ZY_CODE_DISABLE_MOUSE_CLICKS=1`：滚轮仍可用，点击不触发。
5. `compact`、`compact-vertical`、`expanded`、two-column description 四类 Select 布局都可点击。
6. disabled option 不触发。
7. input option 点击只聚焦，不误提交空值。
8. 滚动列表中点击可见项时，不因虚拟窗口 `visibleFromIndex` 算错 value。

建议补测试：

- `tests/components/CustomSelect/select-mouse.test.tsx`
- `tests/ink/hit-test.test.ts`

其中 hit-test 已有底层保障的话，重点测 Select 鼠标行为即可。

## 后续任务拆分

| Priority | 状态 | 任务 | 涉及文件 |
| --- | --- | --- | --- |
| P1 | 已完成 | 给 `Select` 所有布局的 option row 增加 `onClick`/`onMouseEnter` | `src/components/CustomSelect/select.tsx` |
| P1 | 已完成 | 提取点击激活逻辑，复用 disabled/input/multi-select 判断 | `src/components/CustomSelect/select-mouse-actions.ts` |
| P1 | 已完成 | 添加 Select 鼠标点击/hover 测试 | `tests/components/CustomSelect/` |
| P1 | 已完成 | 给 slash command 候选增加 hover 高亮与点击接受 | `src/components/PromptInput/PromptInputFooterSuggestions.tsx`、`src/hooks/useTypeahead.tsx` |
| P1 | 已完成 | 让 hit-test 命中逃出父布局框的 absolute overlay | `src/ink/hit-test.ts`、`tests/ink/hit-test.test.ts` |
| P2 | 已完成 | 给 `ListItem`/`SelectOption` 增加可选点击/hover props | `src/components/design-system/ListItem.tsx`、`src/components/CustomSelect/select-option.tsx` |
| P2 | 待排查 | 检查其他 command TUI 自绘列表是否仍只支持键盘 | `src/commands/`、`src/components/` |
| P3 | 待设计 | 设计统一 `onAction` 控件协议 | `src/ink/events/`、design-system 组件 |
