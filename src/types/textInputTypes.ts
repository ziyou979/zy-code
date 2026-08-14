import type { UUID } from 'node:crypto'
import type React from 'react'
import type { Key } from '../ink/index.js'
import type { PermissionResult } from './index.js'
import type { ImageDimensions, PastedContent } from './inputContent.js'
import type { TextHighlight } from '../terminal-ui/textHighlighting.js'
import type { AgentId } from './ids.js'
import type { UserContentBlock } from './llm.js'
import type { AssistantMessage, MessageOrigin } from './message.js'

/**
 * 用于命令输入中途自动补全的内联 ghost text。
 */
export type InlineGhostText = {
  /** 要显示的 ghost text（例如 /commit 对应 "mit"）。 */
  readonly text: string
  /** 完整命令名（例如 "commit"）。 */
  readonly fullCommand: string
  /** ghost text 在输入中的显示位置。 */
  readonly insertPosition: number
}

/**
 * 文本输入组件的基础 props。
 */
export type BaseTextInputProps = {
  /**
   * 光标位于输入开头并按上箭头时，处理历史导航的可选 callback。
   */
  readonly onHistoryUp?: () => void

  /**
   * 光标位于输入末尾并按下箭头时，处理历史导航的可选 callback。
   */
  readonly onHistoryDown?: () => void

  /**
   * `value` 为空时显示的文本。
   */
  readonly placeholder?: string

  /**
   * 是否允许通过行尾反斜杠输入多行内容，默认为 `true`。
   */
  readonly multiline?: boolean

  /**
   * 是否监听用户输入。多个输入组件同时存在、需要把输入“路由”到特定组件时使用。
   */
  readonly focus?: boolean

  /**
   * 替换全部字符并遮蔽值，适用于密码输入。
   */
  readonly mask?: string

  /**
   * 是否显示光标，并允许用方向键在文本输入中导航。
   */
  readonly showCursor?: boolean

  /**
   * 是否高亮粘贴文本。
   */
  readonly highlightPastedText?: boolean

  /**
   * 文本输入中显示的值。
   */
  readonly value: string

  /**
   * 值更新时调用的函数。
   */
  readonly onChange: (value: string) => void

  /**
   * 按下 `Enter` 时调用的函数，首个参数为输入值。
   */
  readonly onSubmit?: (value: string) => void

  /**
   * 按 Ctrl+C 退出时调用的函数。
   */
  readonly onExit?: () => void

  /**
   * 显示退出消息的可选 callback。
   */
  readonly onExitMessage?: (show: boolean, key?: string) => void

  /**
   * 显示自定义消息的可选 callback。
   */
  // readonly onMessage?: (show: boolean, message?: string) => void

  /**
   * 重置历史位置的可选 callback。
   */
  readonly onHistoryReset?: () => void

  /**
   * 输入被清除（如连按两次 Escape）时的可选 callback。
   */
  readonly onClearInput?: () => void

  /**
   * 文本换行的列数。
   */
  readonly columns: number

  /**
   * 输入 viewport 的最大可见行数。换行后的输入超过此数时，只渲染光标附近的行。
   */
  readonly maxVisibleLines?: number

  /**
   * 粘贴图像时的可选 callback。
   */
  readonly onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void

  /**
   * 粘贴超过 800 个字符的大段文本时的可选 callback。
   */
  readonly onPaste?: (text: string) => void

  /**
   * 粘贴状态变化时的 callback。
   */
  readonly onIsPastingChange?: (isPasting: boolean) => void

  /**
   * 是否禁用上下箭头键移动光标。
   */
  readonly disableCursorMovementForUpDownKeys?: boolean

  /**
   * 跳过文本层的双击 Escape handler。当 Escape 由 keybinding context（如 Autocomplete）
   * 接管时设置；子 effect 会先于父 effect 注册 useInput 监听器，因此 keybinding 的
   * stopImmediatePropagation 无法隔离文本输入。
   */
  readonly disableEscapeDoublePress?: boolean

  /**
   * 光标在文本中的 offset。
   */
  readonly cursorOffset: number

  /**
   * 设置光标 offset 的 callback。
   */
  onChangeCursorOffset: (offset: number) => void

  /**
   * 命令输入后显示的可选提示文本，用于展示可用命令参数。
   */
  readonly argumentHint?: string

  /**
   * undo 功能的可选 callback。
   */
  readonly onUndo?: () => void

  /**
   * 是否使用暗色渲染文本。
   */
  readonly dimColor?: boolean

  /**
   * 用于搜索结果或其他高亮的可选文本高亮项。
   */
  readonly highlights?: TextHighlight[]

  /**
   * 用作 placeholder 的可选自定义 React 元素；提供后覆盖标准 `placeholder` 字符串渲染。
   */
  readonly placeholderElement?: React.ReactNode

  /**
   * 用于命令输入中途自动补全的可选内联 ghost text。
   */
  readonly inlineGhostText?: InlineGhostText

  /**
   * 在按键路由前应用于原始输入的可选 filter。返回可能经过转换的输入字符串；
   * 对非空输入返回 '' 会丢弃该事件。
   */
  readonly inputFilter?: (input: string, key: Key) => string
}

/**
 * VimTextInput 的扩展 props。
 */
export type VimTextInputProps = BaseTextInputProps & {
  /**
   * 初始 vim 模式。
   */
  readonly initialMode?: VimMode

  /**
   * 模式变化时的可选 callback。
   */
  readonly onModeChange?: (mode: VimMode) => void
}

/**
 * Vim editor 模式。
 */
export type VimMode = 'INSERT' | 'NORMAL' | 'VISUAL'

/**
 * 输入 hook 结果的公共属性。
 */
export type BaseInputState = {
  onInput: (input: string, key: Key) => void
  renderedValue: string
  offset: number
  setOffset: (offset: number) => void
  /** 光标在渲染文本中的行号（从 0 开始），已计入换行。 */
  cursorLine: number
  /** 光标在当前行中的列号，以显示宽度计。 */
  cursorColumn: number
  /** viewport 起点在完整文本中的字符 offset；未启用窗口化时为 0。 */
  viewportCharOffset: number
  /** viewport 终点在完整文本中的字符 offset；未启用窗口化时为 text.length。 */
  viewportCharEnd: number

  // 用于处理粘贴
  isPasting?: boolean
  pasteState?: {
    chunks: string[]
    timeoutId: ReturnType<typeof setTimeout> | null
  }
}

/**
 * 文本输入 state。
 */
export type TextInputState = BaseInputState

/**
 * 包含模式的 vim 输入 state。
 */
export type VimInputState = BaseInputState & {
  mode: VimMode
  setMode: (mode: VimMode) => void
}

/**
 * prompt 输入模式。
 */
export type PromptInputMode = 'bash' | 'prompt' | 'orphaned-permission' | 'task-notification'

export type EditablePromptInputMode = Exclude<PromptInputMode, `${string}-notification`>

/**
 * 队列优先级；普通模式与 proactive 模式语义相同。
 *
 *  - `now`   — 立即中断并发送。abort 所有进行中的 tool call，相当于 Esc + 发送。
 *              consumer（print.ts、REPL.tsx）订阅队列变化，看到 'now' 命令时 abort。
 *  - `next`  — turn 中途 drain。等待当前 tool call 完成，再在 tool result 与下次 API
 *              往返之间发送此消息，并唤醒进行中的 SleepTool 调用。
 *  - `later` — turn 结束时 drain。等待当前 turn 完成，再作为新 query 处理，并唤醒
 *              进行中的 SleepTool 调用。query.ts 会在 sleep 后提高 drain 阈值，
 *              使消息附加到同一 turn。
 *
 * SleepTool 仅在 proactive 模式可用，因此“唤醒 SleepTool”在普通模式下不产生效果。
 */
export type QueuePriority = 'now' | 'next' | 'later'

/**
 * 入队命令类型。
 */
export type QueuedCommand = {
  value: string | Array<UserContentBlock>
  mode: PromptInputMode
  /** 入队时默认为 `mode` 隐含的优先级。 */
  priority?: QueuePriority
  uuid?: UUID
  orphanedPermission?: OrphanedPermission
  /** 包含图像的原始粘贴内容；图像在执行时调整尺寸。 */
  pastedContents?: Record<number, PastedContent>
  /**
   * 展开 [Pasted text #N] placeholder 前的输入字符串。用于 ultraplan 关键词检测，
   * 避免粘贴内容中的关键词触发 CCR session。未设置时回退到 `value`；
   * bridge/UDS/MCP 来源没有粘贴展开。
   */
  preExpansionValue?: string
  /**
   * 为 true 时，即使输入以 `/` 开头也按纯文本处理。用于不应触发本地 slash command
   * 或 skill 的远程消息（如 bridge/CCR）。
   */
  skipSlashCommands?: boolean
  /**
   * 为 true 时仍分发 slash command，但先经 isBridgeSafeCommand() 过滤；'local-jsx'
   * 和仅终端命令会返回说明性错误，而非执行。Remote Control bridge 入站路径会设置此项，
   * 使移动端/Web client 能运行 skill 和安全命令，同时避免再次暴露 PR #19134
   *（/model 弹出本地选择器）问题。
   */
  bridgeOrigin?: boolean
  /**
   * 为 true 时，生成的 UserMessage 会带 `isMeta: true`：在 transcript UI 中隐藏，
   * 但模型可见。用于通过队列路由、而非直接调用 `onQuery` 的系统 prompt
   *（proactive tick、teammate 消息、资源更新）。
   */
  isMeta?: boolean
  /**
   * 命令来源。写入生成的 UserMessage，使 transcript 以结构化方式记录来源，
   * 而非只依靠内容中的 XML tag。undefined 表示人类键盘输入。
   */
  origin?: MessageOrigin
  /**
   * 传递到 billing-header 归因块中 cc_workload= 的 workload tag。队列是 cron
   * scheduler 触发与 turn 实际运行之间的异步边界，其间可能插入用户 prompt；
   * 因此 tag 随 QueuedCommand 自身传递，仅在该命令出队时提升到 bootstrap state。
   */
  workload?: string
  /**
   * 应接收此通知的 agent；undefined 表示主线程。subagent 在进程内运行并共享模块级
   * 命令队列，query.ts 的 drain gate 按此字段过滤，避免 subagent 的后台 task 通知
   * 泄漏到 coordinator context。PR #18453 合并队列时丢失了双队列原有的隔离性。
   */
  agentId?: AgentId
}

/**
 * 判断图像 PastedContent 数据非空的类型守卫。空内容图像（如拖入 0 字节文件）会生成
 * 空 base64 字符串，并被 API 以 `image cannot be empty` 拒绝。所有把 PastedContent
 * 转为 ImageBlock 的位置都应使用此守卫，使 filter 与 ID 列表保持同步。
 */
export function isValidImagePaste(c: PastedContent): boolean {
  return c.type === 'image' && c.content.length > 0
}

/** 从 QueuedCommand 的 pastedContents 提取图像粘贴 ID。 */
export function getImagePasteIds(
  pastedContents: Record<number, PastedContent> | undefined,
): number[] | undefined {
  if (!pastedContents) {
    return undefined
  }
  const ids = Object.values(pastedContents)
    .filter(isValidImagePaste)
    .map((c) => c.id)
  return ids.length > 0 ? ids : undefined
}

export type OrphanedPermission = {
  permissionResult: PermissionResult
  assistantMessage: AssistantMessage
}
