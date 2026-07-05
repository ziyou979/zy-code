# Claude Code 鼠标悬浮与高亮对齐方案

## 背景

本分析基于本机 Claude Code `2.1.198` 二进制：

`D:\nvm\nvm4w\nodejs\node_global\node_modules\@anthropic-ai\claude-code\bin\claude.exe`

用户实测发现：

- slash command 列表中，Claude 会用高亮表达鼠标悬浮项。
- 输入 `/model` 时，`model` 作为匹配文本也会高亮。
- model picker 中，Claude 鼠标悬浮某一模型时，左侧出现 `>`，当前已选模型仍保留绿色 `✓`。
- ZY Code 当前对部分选择器使用 hover 高亮，但在 model picker 等存在持久选中态的控件中，会把 hover 渲染得像 selected/current。

因此问题不是简单的“Claude 用高亮还是用 `>`”，而是 Claude 根据控件语义区分了三类状态。

## Claude Code 提取结论

| 区域 | Claude offset | 观察到的机制 |
| --- | ---: | --- |
| ModelPicker | `230599725` | 调用通用 select 组件，传入 `defaultValue`、`defaultFocusValue`、`onChange`、`onFocus`，明确区分当前值和焦点值。 |
| 通用 Select | `223081256` | 每行渲染时分别计算 `isFocused` 与 `isSelected`；文字颜色规则为 selected -> `success`，focused -> `suggestion`。 |
| 通用 ListItem | `223065072` | 组件内部维护本地 hover 状态；hover 且可点击时，仅在左侧 indicator 显示暗色 `>`，不把行渲染为 selected。 |
| Slash suggestions | `223111331` | 使用 `hoveredId ?? selectedSuggestionId` 作为 active suggestion；active 行整体使用 `suggestion` 色，未 active 行 dim。 |
| Slash match highlight | `223111331` | `Yoo`/match renderer 根据 `item.query` 给匹配片段上 `suggestion` 色，和 active suggestion 高亮可以同时存在。 |

### Claude 的状态模型

Claude 至少区分三种视觉状态：

1. **match**
   - 来源：用户输入的查询文本，如 `/model` 中的 `model`。
   - 表达：匹配片段使用 `suggestion` 色。
   - 不代表 focus，也不代表 selected。

2. **active / hover / focus**
   - 来源：键盘当前候选项，或鼠标悬浮项。
   - 在 slash suggestions 中：整行高亮，因为没有持久选中态。
   - 在 select/model picker 中：左侧 indicator 使用 `>`，文字通常只在真正 focused 时使用 `suggestion` 色；单纯 mouse hover 不伪装成 selected。

3. **selected / current**
   - 来源：已经选中的当前值，如当前模型。
   - 表达：`success` 色与 `✓`。
   - 不应该被 mouse hover 临时覆盖。

## ZY Code 现状

### Slash suggestions

对应文件：

- `src/components/PromptInput/PromptInputFooterSuggestions.tsx`
- `src/hooks/useTypeahead.tsx`

现状：

- `PromptInputFooterSuggestions.tsx:163` 维护 `hoveredId`。
- `PromptInputFooterSuggestions.tsx:181-183` 使用 `isHovered || selectedSuggestion` 得到 `isEffectivelySelected`。
- `PromptInputFooterSuggestions.tsx:189-190` hover 行使用 selected 风格渲染。
- `useTypeahead.tsx:1396-1558` 已将鼠标点击和键盘 Enter 统一到 `acceptSuggestion(index)`。
- `useTypeahead.tsx:1560-1575` 提供 `focusSuggestion(index)`，可把 hover 同步到 `selectedSuggestion`。

这个方向基本符合 Claude：slash suggestions 没有持久 selected/current，hover 行用高亮是合理的。

当前差异：

- ZY 当前 `SuggestionItem` 没有标准化 `query` 字段，匹配片段高亮能力不如 Claude 完整。
- 如果 hover 只更新 `hoveredId`，而不调用 `focusSuggestion(index)`，键盘 Enter 的 active 项和鼠标看到的 active 项可能短暂不一致。

### CustomSelect / ModelPicker

对应文件：

- `src/components/CustomSelect/select.tsx`
- `src/components/CustomSelect/SelectMulti.tsx`
- `src/components/design-system/ListItem.tsx`
- `src/components/ModelPicker.tsx`

现状：

- `select.tsx:274` 维护 `hoveredId`。
- `select.tsx:392-394`、`522-524`、`647-649`、`801-803` 将 hover 与 selected 合并为 `isEffectivelySelected`。
- `select.tsx:682-694` 两栏布局中，hover 会触发 `success` 色和 `✓`，这会把 hover 表达成已选中。
- `SelectMulti.tsx:156-158` 同样将 hover 与 selected 合并。
- `ListItem.tsx:133-181` 只有 `isFocused` 显示 `>`，`isSelected` 显示 `success` 与 `✓`；没有 Claude 那种本地 hover indicator。
- `ModelPicker.tsx:62-100` 下方 effort 信息依赖 `focusedValue`，而不是 hover 值。若 hover 不同步 focus，用户看到的 hover 行和 effort 上下文可能不一致。

这与 Claude 的 select/model picker 语义不同：ZY 把 hover 临时伪装成 selected/current。

### Bash 权限确认中的 input option 鼠标失效

用户实测：

- Bash 权限确认出现三项时，第 2 项“是，并且不再询问: node:*”鼠标 hover 无效，点击也无效。
- Claude Code 在同类场景下也有相同问题。

对应 ZY Code 代码：

- `src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx` 会在可保存 Bash 前缀规则时生成 `type: 'input'` 的 `yes-prefix-edited` 选项。
- `src/components/CustomSelect/select.tsx` 对普通选项会包一层带 `onClick` / `onMouseEnter` 的 `Box`，但 `option.type === 'input'` 的分支直接返回 `SelectInputOption`。
- `src/components/CustomSelect/select-input-option.tsx` 内部渲染 `SelectOption` 时没有传 `onClick`、`onMouseEnter`、`onMouseLeave`。

因此第 2 项不是普通 selectable row，而是 inline input row。它没有被挂上鼠标 handler，hit-test 即使命中节点，也找不到可冒泡执行的 `onClick` / `onMouseEnter`。这与前面的 hover 颜色语义不同，是 input option 的事件覆盖缺口。

修复目标：

- input option 的鼠标悬浮也要有反馈。
- 点击空 input option 应聚焦该项，进入可编辑状态。
- 点击已有预填值的 input option 应直接确认，行为与键盘数字键选择一致。

建议改动：

1. 扩展 `SelectInputOption` props，增加：
   - `onClick?: (event: ClickEvent) => void`
   - `onMouseEnter?: () => void`
   - `onMouseLeave?: () => void`

2. 在 `select.tsx` 的所有 `option.type === 'input'` 分支传入：
   - `onClick={createOptionClickHandler(option, state.focusOption, state.selectFocusedOption, onChange)}`
   - `onMouseEnter={createOptionHoverHandler(option, setHoveredId)}`
   - `onMouseLeave={createHoverLeaveHandler(setHoveredId)}`

3. `handleOptionClick()` 对 input option 需要对齐数字键选择语义：
   - 当前值为空：只聚焦并显示/激活输入框。
   - 当前值非空：直接调用 `onChange(option.value)`，选择 `yes-prefix-edited`。
   - `allowEmptySubmitToCancel` 为 true：即使当前值为空也直接提交。

4. `SelectInputOption` 内部的 `SelectOption` 需要透传这些 handler。
   - 如果后续实现了 `ListItem` 本地 hover indicator，input option 可以自然获得 dim `>`。
   - 对 focused input option，继续由 `isFocused` 显示 `suggestion` 色 `>`。

5. 如果需要更完整的鼠标体验，可在第二阶段支持点击 TextInput 内部定位光标；但这不是本问题的 P1 修复范围。

## 对齐原则

1. **不要全局规定 hover 必须高亮或必须 `>`。**
   - slash suggestions：hover 是 active suggestion，可高亮。
   - select/model picker：hover 是可点击提示，不是 selected/current，应优先使用 `>`。

2. **match、active、selected 三种状态独立建模。**
   - match 可以叠加在 active 上。
   - active 可以来自 keyboard focus 或 mouse hover。
   - selected/current 必须只来自真实 value。

3. **点击路径必须与键盘路径共享业务逻辑。**
   - slash click 走 `acceptSuggestion(index)`。
   - select click 走 `focusOption(value)` + select/toggle。

4. **hover 不应触发意外滚动。**
   - 对可见行 hover，可以同步 active/focus。
   - 对 select 若担心滚动，优先增加本地 hover indicator，而不是把 hover 合并进 selected。

## ZY Code 对齐方案

### P1：修正 CustomSelect 的 hover 语义

目标：

- `isSelected` 只表示真实选中值。
- `isFocused` 继续表示键盘焦点。
- 鼠标 hover 在非 focused 行上显示暗色 `>`，但不显示 `✓`，不使用 `success`。
- `type: 'input'` 的行也必须挂载 hover/click handler，至少支持鼠标聚焦。

建议改动：

1. 在 `ListItem` 增加内部 hover indicator 语义，对齐 Claude：
   - 当 `onClick` 或 `onMouseEnter` 存在时启用本地 hover 状态。
   - `isFocused` 优先显示 `suggestion` 色 `>`。
   - scroll indicator 次之。
   - 本地 hover 最后显示 dim `>`。
   - 文本颜色仍只由 `isSelected` / `isFocused` 决定。

2. `SelectOption` 继续透传 `onMouseEnter` / `onMouseLeave`，但不要把 hover 传成 `isSelected`。

3. 在 `select.tsx` 中移除 `isEffectivelySelected = isHovered || isSelected` 这类合并：
   - 普通、expanded、compact-vertical、two-column 四个分支都改成 `isSelected` 只来自 `state.value === option.value`。
   - hover 只用于 indicator，或直接交给 `ListItem` 的本地 hover。
   - 两栏布局 `TwoColumnRow` 当前绕过 `ListItem`，需要单独补本地 hover indicator，或改为复用一个共享 indicator helper。

4. `ModelPicker` 的 effort 信息是否跟随 hover，需要单独决策：
   - Claude model picker 从提取结果看 `onFocus` 驱动 effort 信息，鼠标 hover 只显示 indicator 时不一定改变 focus。
   - 建议先保持键盘 focus 驱动 effort，不让单纯 hover 改变 effort，避免鼠标扫过导致底部说明频繁变化。
   - 如果用户期待 effort 跟随鼠标，可在第二阶段让 hover 同步 focus，但仍不能改变 selected/current。

5. 补齐 input option 事件：
   - `SelectInputOption` 接收并透传 `onClick` / `onMouseEnter` / `onMouseLeave`。
   - `select.tsx` 的 input 分支复用普通选项的 mouse action helper。
   - 点击空 input option 只聚焦；点击已有预填值的 input option 直接提交。

### P1：修正 SelectMulti 的 hover 语义

目标：

- 多选 selected 只表示真实选中。
- hover 不应让 `[ ]` 变成 `[✓]`。

建议改动：

- `SelectMulti.tsx:156-178` 去掉 `isEffectivelySelected`。
- checkbox 渲染只看 `isSelected`。
- hover 只影响左侧 indicator 或焦点色，不影响 `selectedValues` 的视觉状态。

### P1：保持 slash suggestions 的 active 高亮，但不要同步 hover 与 selectedSuggestion

目标：

- slash command、file、agent 等 suggestions 保持 Claude 风格：active 行高亮。
- 鼠标 hover 的行是视觉 active 行，点击该行时接受该行。
- 键盘 Enter 仍接受 `selectedSuggestion`，避免鼠标 hover 触发列表窗口重算。

建议改动：

- 保留 `hoveredId` 作为即时视觉状态，active 计算建议为：
  - 若 `hoveredId` 有效，用 hovered；
  - 否则使用 `selectedSuggestion`。
- 不要在 `onMouseEnter` 中调用 `onFocusSuggestion(index)`。
  - Windows Terminal 会持续发送 mouse-move 事件。
  - 如果 hover 同步 `selectedSuggestion`，suggestion 窗口会按新焦点重新居中。
  - 重绘后鼠标同一屏幕坐标可能命中下一项，从而继续触发 focus，表现为“列表跟随鼠标上下滚动”。
  - JetBrains Terminal 事件频率/触发时机不同，可能不明显，但根因仍是 hover 改变列表窗口锚点。
- 点击时继续调用 `onAcceptSuggestion(index)`，所以鼠标仍可直接选择 hover 项。
- 鼠标离开 overlay 时不要强制把 selectedSuggestion 清空，保持最后 active 项。

### P2：补齐 slash match highlight

目标：

- 对齐 Claude 中 query match 与 active highlight 并存的效果。

建议改动：

- 给 `SuggestionItem` 增加可选 `query?: string` 字段，或复用已有 `matchedAlias` 但语义需要更明确。
- 在 `SuggestionItemRow` 内拆出 `HighlightedText`：
  - 普通片段使用当前 row 的基础颜色/dim。
  - match 片段使用 `suggestion` 色。
  - active 行可加 bold，但不要让 match 与 active 互相覆盖。
- slash command suggestions 生成时写入 query，例如 `/model` 的 query 为 `model` 或 `/model`，按实际渲染需要统一。

### P2：抽象状态命名，减少再次混淆

建议在组件内部统一命名：

- `isMatched` / `query`
- `isActive`：当前可接受/焦点项，适用于 suggestions。
- `isFocused`：键盘焦点，适用于 select。
- `isHovered`：鼠标临时悬浮。
- `isSelected`：真实选中/current。

避免继续使用 `isEffectivelySelected`，它是当前混淆的主要来源。

## 建议测试

1. `tests/components/CustomSelect/select-mouse.test.tsx`
   - hover 普通选项不调用 selected 语义。
   - hover disabled 选项不显示 hover indicator。
   - click 仍聚焦并选择。

2. 新增/扩展 CustomSelect 渲染测试
   - selected 行显示 `✓`。
   - hover 非 selected 行只显示 `>`，不显示 `✓`。
   - focused 行显示 `suggestion` 色 `>`。
   - input option hover 有 `>` 反馈。
   - 空 input option click 只调用 `focusOption`，不调用 `onChange`。
   - 预填 input option click 直接调用 `onChange`，不只停留在高亮/聚焦。

3. `tests/components/CustomSelect/select-multi-mouse.test.tsx`
   - hover 未选中项不显示 `[✓]`。
   - click 后才显示 `[✓]`。

4. slash suggestions 测试
   - hover 不调用 `onFocusSuggestion(index)`。
   - click 调用 `onAcceptSuggestion(index)`。
   - active 行高亮。
   - match 文本和 active 行可以同时高亮。

5. `tests/ink/hit-test.test.ts`
   - 保留 fullscreen absolute overlay 子树可 hit-test 的覆盖，防止 slash suggestion 鼠标再次失效。

6. Bash 权限确认回归测试
   - 构造包含 `yes-prefix-edited` 的 `bashToolUseOptions()`。
   - 验证第 2 项是 `type: 'input'`。
   - 渲染 `Select` 后，移动鼠标到第 2 项可触发 hover。
   - 第 2 项已有预填规则时，点击应直接提交；没有预填规则时才只聚焦进入编辑。

## 实施顺序

1. 先补 input option 的 `onClick` / `onMouseEnter` / `onMouseLeave` 透传，修复 Bash 权限第 2 项鼠标完全无效的问题。
2. 再改 `ListItem` / `SelectOption` / `select.tsx`，修正单选模型 picker 的 selected 与 hover 混淆。
3. 再改 `SelectMulti.tsx`，避免 hover 伪装成多选勾选。
4. 然后收敛 slash suggestion：hover 只更新 `hoveredId`，保留 active 高亮，click 直接接受 hover 项。
5. 最后补 query match highlight，使 `/model` 这类匹配片段高亮与 Claude 更一致。

## 验证命令

代码改动后必须执行：

```bash
bun run format
bun test tests/components/CustomSelect/select-mouse.test.tsx tests/components/CustomSelect/select-multi-mouse.test.tsx tests/ink/hit-test.test.ts
bun tsc --noEmit
```
