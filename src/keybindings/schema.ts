/**
 * keybindings.json 配置的 Zod schema。
 * 用于校验和生成 JSON Schema。
 */

import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'
export { KEYBINDING_CONTEXTS } from './types.js'
import { KEYBINDING_CONTEXTS } from './types.js'

/**
 * 各快捷键 context 的易读说明。
 */
export const KEYBINDING_CONTEXT_DESCRIPTIONS: Record<(typeof KEYBINDING_CONTEXTS)[number], string> =
  {
    Global: 'Active everywhere, regardless of focus',
    Chat: 'When the chat input is focused',
    Autocomplete: 'When autocomplete menu is visible',
    Confirmation: 'When a confirmation/permission dialog is shown',
    Help: 'When the help overlay is open',
    Transcript: 'When viewing the transcript',
    HistorySearch: 'When searching command history (ctrl+r)',
    Task: 'When a task/agent is running in the foreground',
    ThemePicker: 'When the theme picker is open',
    Settings: 'When the settings menu is open',
    Tabs: 'When tab navigation is active',
    Scroll: 'When a scrollable view is focused',
    Attachments: 'When navigating image attachments in a select dialog',
    Footer: 'When footer indicators are focused',
    MessageSelector: 'When the message selector (rewind) is open',
    MessageActions: 'When the message actions menu is open',
    DiffDialog: 'When the diff dialog is open',
    ModelPicker: 'When the model picker is open',
    Select: 'When a select/list component is focused',
    Plugin: 'When the plugin dialog is open',
  }

/**
 * 所有有效的快捷键 action 标识符。
 */
export const KEYBINDING_ACTIONS = [
  // 应用级 action（Global context）
  'app:interrupt',
  'app:exit',
  'app:toggleTodos',
  'app:toggleTranscript',
  'app:toggleBrief',
  'app:toggleTeammatePreview',
  'app:toggleTerminal',
  'app:redraw',
  'app:globalSearch',
  'app:quickOpen',
  // 历史记录导航
  'history:search',
  'history:previous',
  'history:next',
  // Chat 输入 action
  'chat:cancel',
  'chat:killAgents',
  'chat:cycleMode',
  'chat:modelPicker',
  'chat:thinkingToggle',
  'chat:submit',
  'chat:newline',
  'chat:undo',
  'chat:externalEditor',
  'chat:stash',
  'chat:imagePaste',
  'chat:messageActions',
  // 自动补全菜单 action
  'autocomplete:accept',
  'autocomplete:dismiss',
  'autocomplete:previous',
  'autocomplete:next',
  // 确认对话框 action
  'confirm:yes',
  'confirm:no',
  'confirm:previous',
  'confirm:next',
  'confirm:nextField',
  'confirm:previousField',
  'confirm:cycleMode',
  'confirm:toggle',
  'confirm:toggleExplanation',
  // Tabs 导航 action
  'tabs:next',
  'tabs:previous',
  // Transcript 查看器 action
  'transcript:toggleShowAll',
  'transcript:exit',
  // 历史搜索 action
  'historySearch:next',
  'historySearch:accept',
  'historySearch:cancel',
  'historySearch:execute',
  // Task/agent 相关 action
  'task:background',
  // 主题选择器 action
  'theme:toggleSyntaxHighlighting',
  // 帮助菜单 action
  'help:dismiss',
  // 附件导航（选择对话框中的图片附件）
  'attachments:next',
  'attachments:previous',
  'attachments:remove',
  'attachments:exit',
  // 页脚指示器 action
  'footer:up',
  'footer:down',
  'footer:next',
  'footer:previous',
  'footer:openSelected',
  'footer:clearSelection',
  'footer:close',
  // 消息选择器（rewind）action
  'messageSelector:up',
  'messageSelector:down',
  'messageSelector:top',
  'messageSelector:bottom',
  'messageSelector:select',
  // Diff 对话框 action
  'diff:dismiss',
  'diff:previousSource',
  'diff:nextSource',
  'diff:back',
  'diff:viewDetails',
  'diff:previousFile',
  'diff:nextFile',
  // 模型选择器 action（仅限 ant）
  'modelPicker:decreaseEffort',
  'modelPicker:increaseEffort',
  // Select 组件 action；与 confirm: 分开以避免冲突
  'select:next',
  'select:previous',
  'select:accept',
  'select:cancel',
  // Plugin 对话框 action
  'plugin:toggle',
  'plugin:install',
  // 权限对话框 action
  'permission:toggleDebug',
  // Settings 配置面板 action
  'settings:search',
  'settings:retry',
  'settings:close',
  // Voice 相关 action
  'voice:pushToTalk',
] as const

/**
 * 单个快捷键绑定块的 schema。
 */
export const KeybindingBlockSchema = lazySchema(() =>
  z
    .object({
      context: z
        .enum(KEYBINDING_CONTEXTS)
        .describe('UI context where these bindings apply. Global bindings work everywhere.'),
      bindings: z
        .record(
          z.string().describe('Keystroke pattern (e.g., "ctrl+k", "shift+tab")'),
          z
            .union([
              z.enum(KEYBINDING_ACTIONS),
              z
                .string()
                .regex(/^command:[a-zA-Z0-9:\-_]+$/)
                .describe(
                  'Command binding (e.g., "command:help", "command:compact"). Executes the slash command as if typed.',
                ),
              z.null().describe('Set to null to unbind a default shortcut'),
            ])
            .describe('Action to trigger, command to invoke, or null to unbind'),
        )
        .describe('Map of keystroke patterns to actions'),
    })
    .describe('A block of keybindings for a specific context'),
)

/**
 * 整个 keybindings.json 文件的 schema。
 * 使用对象包装格式，并支持可选的 $schema 和 $docs 元数据。
 */
export const KeybindingsSchema = lazySchema(() =>
  z
    .object({
      $schema: z.string().optional().describe('JSON Schema URL for editor validation'),
      $docs: z.string().optional().describe('Documentation URL'),
      bindings: z.array(KeybindingBlockSchema()).describe('Array of keybinding blocks by context'),
    })
    .describe('ZY Code keybindings configuration. Customize keyboard shortcuts by context.'),
)

/**
 * 从 schema 推导出的 TypeScript 类型。
 */
export type KeybindingsSchemaType = z.infer<ReturnType<typeof KeybindingsSchema>>
