# Claude Code fullscreen 鼠标选项点击能力分析

## 结论

Claude Code 与 zy-code 在 fullscreen/alt-screen 下的底层路线基本一致：进入备用屏幕、启用 DEC 鼠标追踪、解析 SGR 鼠标事件，再通过 Ink/React 树做 hit-test 和事件派发。

当前 zy-code 的主要差距不在终端协议层，而在交互组件层：底层已经支持 `onClick`、命中测试和冒泡，但 `Select`/`ListItem` 这类选项组件没有把每一行选项注册为可点击目标，也没有把“点击某行”映射为 `focusOption + onChange/selectFocusedOption`。因此只有显式挂了 `onClick` 的组件（例如折叠块、链接、Logo、路径等）能响应点击；普通 TUI 选项只能通过键盘、数字键或 Enter 使用。

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

第 4 点是 zy-code 当前缺失最明显的部分。

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

### 缺失点

| 缺口 | zy-code 位置 | 说明 |
| --- | --- | --- |
| `Select` 只注册键盘输入 | `src/components/CustomSelect/use-select-input.ts:83`、`:113`、`:133`、`:167` | 当前只有 keybinding/useInput 路径：上下移动、Enter、数字键选择。没有鼠标 click 路径。 |
| 普通选项行没有 `onClick` | `src/components/CustomSelect/select.tsx:396`、`:504`、`:617`、`:754` | 不同布局下的 option row 都只是 `Box`/`SelectOption`/`TwoColumnRow`，没有挂点击处理。 |
| `SelectOption`/`ListItem` 不接收点击语义 | `src/components/CustomSelect/select-option.tsx:22`、`src/components/design-system/ListItem.tsx:103` | 选项组件只管视觉状态和 cursor declaration，没有 `onClick`、`onMouseEnter`、disabled/action 等交互 props。 |
| 点击只会触发显式 handler | `src/ink/hit-test.ts:41`、`:71` | hit-test 会命中节点并向上冒泡，但只有某个祖先存在 `_eventHandlers.onClick` 时才算 handled。普通选项行没有 handler，所以点击不会改变状态。 |

这解释了现象：折叠块能点，是因为折叠块/路径/链接等局部组件显式挂了 `onClick`；选项不能点，是因为 `Select` 没有把每个 option 行注册为 clickable。

## 差异模型

Claude Code 更像是“控件默认可动作化”：

- 选项行不仅是文本，还绑定 action/click。
- 鼠标点击进入同一套 action 语义，而不是每个命令组件自己手写。
- Host 层提供 `onClick`/`onAction`/hover/wheel；控件层统一消费。

zy-code 当前是“底层可点击，控件按需显式接线”：

- Ink host 已有 `onClick`。
- `dispatchClick` 也会冒泡。
- 但 `Select`、`ListItem`、大量 command TUI 仍按传统键盘组件设计。

所以两边差距可以归纳为：

1. 不是缺 DEC 1006。
2. 不是缺 hit-test。
3. 不是缺 `onClick` prop。
4. 缺的是 `Select`/menu/list-item 级别的点击协议和复用实现。

## 建议实现路线

### P1：让 `Select` 普通选项可点击

在 `src/components/CustomSelect/select.tsx` 中给每个可见 option row 包一层 `Box onClick`，点击时执行与键盘 Enter 一致的逻辑：

1. disabled option：忽略。
2. 普通 option：先 `state.focusOption(option.value)`，再 `state.selectFocusedOption?.()` 或直接 `state.onChange?.(option.value)`。
3. input option：点击时 focus 到该 input option；是否立即进入输入模式需要按现有 UX 决策，建议第一版只聚焦，不提交。
4. multi-select 若复用同 hook：点击应等价 Space/Enter toggle。

注意：`Select` 有 `compact`、`compact-vertical`、`expanded`、two-column description 等多条渲染路径，必须全部覆盖，否则会出现某些菜单可点、某些不可点。

### P1：抽一个内部 helper，避免散落逻辑

建议在 `src/components/CustomSelect/` 下增加窄作用域 helper，而不是放到 `src/utils/`：

- `selectMouseActions.ts`
- 或在 `use-select-input.ts` 中导出 `activateOptionByValue`

职责：

- 检查 disabled。
- 根据 option 类型决定 focus/select/submit。
- 保持与键盘路径一致。

这样后续 `MultiSelect`、MCP elicitation、agents/hooks menu 可以共享行为。

### P2：扩展 `ListItem` 的点击语义

`ListItem` 可以增加可选 props：

- `onClick?: (event: ClickEvent) => void`
- `disabled?: boolean`
- `hoverable?: boolean`

但不建议第一步就让所有 `ListItem` 自动可点。更稳妥的方式是由 `SelectOption` 显式传入，避免消息列表、状态行等“长得像列表但不是菜单”的区域误触。

### P2：hover/focus 联动

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

| Priority | 任务 | 涉及文件 |
| --- | --- | --- |
| P1 | 给 `Select` 所有布局的 option row 增加 `onClick` | `src/components/CustomSelect/select.tsx` |
| P1 | 提取点击激活逻辑，复用 disabled/input/multi-select 判断 | `src/components/CustomSelect/use-select-input.ts` 或新建同目录 helper |
| P1 | 添加 Select 鼠标点击测试 | `tests/components/CustomSelect/` |
| P2 | 给 `ListItem`/`SelectOption` 增加可选点击/hover props | `src/components/design-system/ListItem.tsx`、`src/components/CustomSelect/select-option.tsx` |
| P2 | hover 聚焦选项 | `src/components/CustomSelect/select.tsx` |
| P3 | 设计统一 `onAction` 控件协议 | `src/ink/events/`、design-system 组件 |

