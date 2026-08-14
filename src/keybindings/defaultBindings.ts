import { feature } from 'bun:bundle'
import { satisfies } from 'src/utils/semver.js'
import { isRunningWithBun } from '../services/environment/bundledMode.js'
import { getPlatform } from '../services/shell/platform.js'
import type { KeybindingBlock } from './types.js'

/**
 * 与当前 ZY Code 行为一致的默认快捷键。
 * 先加载这些绑定，再由用户 keybindings.json 覆盖。
 */

// 平台专用的图片粘贴快捷键：
// - Windows：alt+v（ctrl+v 是系统粘贴）；
// - 其他平台：ctrl+v。
const IMAGE_PASTE_KEY = getPlatform() === 'windows' ? 'alt+v' : 'ctrl+v'

// 未启用 VT mode 时，Windows Terminal 可能无法识别 shift+tab 等仅含修饰键的 chord
// See: https://github.com/microsoft/terminal/issues/879#issuecomment-618801651
// Node enabled VT mode in 24.2.0 / 22.17.0: https://github.com/nodejs/node/pull/58358
// Bun enabled VT mode in 1.2.23: https://github.com/oven-sh/bun/pull/21161
const SUPPORTS_TERMINAL_VT_MODE =
  getPlatform() !== 'windows' ||
  (isRunningWithBun()
    ? satisfies(process.versions.bun, '>=1.2.23')
    : satisfies(process.versions.node, '>=22.17.0 <23.0.0 || >=24.2.0'))

// 平台专用的模式切换快捷键：
// - 未启用 VT mode 的 Windows：meta+m（shift+tab 不可靠）；
// - 其他平台：shift+tab。
const MODE_CYCLE_KEY = SUPPORTS_TERMINAL_VT_MODE ? 'shift+tab' : 'meta+m'

export const DEFAULT_BINDINGS: KeybindingBlock[] = [
  {
    context: 'Global',
    bindings: {
      // ctrl+c 和 ctrl+d 使用基于时间的特殊双击处理。这里仍需定义，供 resolver 查找，但用户
      // 不能重新绑定；若尝试覆盖，reservedShortcuts.ts 中的校验会报错。
      'ctrl+c': 'app:interrupt',
      'ctrl+d': 'app:exit',
      'ctrl+l': 'app:redraw',
      'ctrl+t': 'app:toggleTodos',
      'ctrl+o': 'app:toggleTranscript',
      ...(feature('KAIROS') || feature('KAIROS_BRIEF')
        ? { 'ctrl+shift+b': 'app:toggleBrief' as const }
        : {}),
      'ctrl+shift+o': 'app:toggleTeammatePreview',
      'ctrl+r': 'history:search',
      // 文件导航。cmd+ 绑定仅在支持 kitty protocol 的终端触发，ctrl+shift 是跨平台后备方案。
      ...(feature('QUICK_SEARCH')
        ? {
            'ctrl+shift+f': 'app:globalSearch' as const,
            'cmd+shift+f': 'app:globalSearch' as const,
            'ctrl+shift+p': 'app:quickOpen' as const,
            'cmd+shift+p': 'app:quickOpen' as const,
          }
        : {}),
      ...(feature('TERMINAL_PANEL') ? { 'meta+j': 'app:toggleTerminal' } : {}),
    },
  },
  {
    context: 'Chat',
    bindings: {
      escape: 'chat:cancel',
      // 使用 ctrl+x chord 前缀，避免遮蔽 readline 编辑键（ctrl+a/b/e/f/...）。
      'ctrl+x ctrl+k': 'chat:killAgents',
      [MODE_CYCLE_KEY]: 'chat:cycleMode',
      'meta+p': 'chat:modelPicker',
      'meta+t': 'chat:thinkingToggle',
      enter: 'chat:submit',
      up: 'history:previous',
      down: 'history:next',
      // 编辑快捷键；迁移期间暂在此定义
      // 撤销使用两组绑定以兼容不同终端行为：
      // - 旧终端使用 ctrl+_，发送 \x1f 控制字符；
      // - Kitty protocol 使用 ctrl+shift+-，发送带修饰键的物理按键。
      'ctrl+_': 'chat:undo',
      'ctrl+shift+-': 'chat:undo',
      // ctrl+x ctrl+e 是 readline 原生的 edit-and-execute-command 绑定。
      'ctrl+x ctrl+e': 'chat:externalEditor',
      'ctrl+g': 'chat:externalEditor',
      'ctrl+s': 'chat:stash',
      // 图片粘贴快捷键，具体平台按键在上方定义
      [IMAGE_PASTE_KEY]: 'chat:imagePaste',
      ...(feature('MESSAGE_ACTIONS') ? { 'shift+up': 'chat:messageActions' as const } : {}),
      // Voice 按住说话激活键。注册后 getShortcutDisplay 可直接找到它，不会触发 fallback
      // analytics 日志。重新绑定时添加 voice:pushToTalk 条目，最后一项优先；禁用请使用 /voice。
      // 用户可将 space 设为 null 来禁用按住说话；此时按键会继续传给输入框。
      ...(feature('VOICE_MODE') ? { space: 'voice:pushToTalk' } : {}),
    },
  },
  {
    context: 'Autocomplete',
    bindings: {
      tab: 'autocomplete:accept',
      escape: 'autocomplete:dismiss',
      up: 'autocomplete:previous',
      down: 'autocomplete:next',
    },
  },
  {
    context: 'Settings',
    bindings: {
      // Settings 菜单只使用 escape 关闭，不使用 `n`
      escape: 'confirm:no',
      // 配置面板列表导航，复用 Select action
      up: 'select:previous',
      down: 'select:next',
      k: 'select:previous',
      j: 'select:next',
      'ctrl+p': 'select:previous',
      'ctrl+n': 'select:next',
      // 切换或激活选中的设置；仅用 space，enter 会保存并关闭
      space: 'select:accept',
      // 保存并关闭配置面板
      enter: 'settings:close',
      // 进入搜索模式
      '/': 'settings:search',
      // 重试加载用量数据，仅在出错时启用
      r: 'settings:retry',
    },
  },
  {
    context: 'Confirmation',
    bindings: {
      y: 'confirm:yes',
      n: 'confirm:no',
      enter: 'confirm:yes',
      escape: 'confirm:no',
      // 带列表对话框的导航
      up: 'confirm:previous',
      down: 'confirm:next',
      tab: 'confirm:nextField',
      space: 'confirm:toggle',
      // 循环切换模式，用于文件权限对话框和 teams 对话框
      'shift+tab': 'confirm:cycleMode',
      // 在权限对话框中切换权限说明
      'ctrl+e': 'confirm:toggleExplanation',
      // 切换权限调试信息
      'ctrl+d': 'permission:toggleDebug',
    },
  },
  {
    context: 'Tabs',
    bindings: {
      // Tab 循环导航
      tab: 'tabs:next',
      'shift+tab': 'tabs:previous',
      right: 'tabs:next',
      left: 'tabs:previous',
    },
  },
  {
    context: 'Transcript',
    bindings: {
      'ctrl+e': 'transcript:toggleShowAll',
      'ctrl+c': 'transcript:exit',
      escape: 'transcript:exit',
      // q 遵循 pager 约定（less、tmux copy-mode）。Transcript 是无 prompt 的模态阅读视图，
      // 因此没有组件需要把 q 当作普通字符接收。
      q: 'transcript:exit',
    },
  },
  {
    context: 'HistorySearch',
    bindings: {
      'ctrl+r': 'historySearch:next',
      escape: 'historySearch:accept',
      tab: 'historySearch:accept',
      'ctrl+c': 'historySearch:cancel',
      enter: 'historySearch:execute',
    },
  },
  {
    context: 'Task',
    bindings: {
      // 将运行中的前台任务转入后台，包括 bash 命令和 agent。
      // 在 tmux 中需按两次 ctrl+b，以转义 tmux 前缀。
      'ctrl+b': 'task:background',
    },
  },
  {
    context: 'ThemePicker',
    bindings: {
      'ctrl+t': 'theme:toggleSyntaxHighlighting',
    },
  },
  {
    context: 'Scroll',
    bindings: {
      pageup: 'scroll:pageUp',
      pagedown: 'scroll:pageDown',
      wheelup: 'scroll:lineUp',
      wheeldown: 'scroll:lineDown',
      'ctrl+home': 'scroll:top',
      'ctrl+end': 'scroll:bottom',
      // 复制选区。ctrl+shift+c 是标准终端复制；cmd+c 仅在使用 kitty keyboard protocol 的
      // 终端（kitty/WezTerm/ghostty/iTerm2）触发，因为只有这些终端会把 super 修饰键传到 pty，
      // 其他终端中不会生效。清除选区的 Esc 和依 context 处理的 ctrl+c 通过原始 useInput
      // 处理，以便按条件继续传播。
      'ctrl+shift+c': 'selection:copy',
      'cmd+c': 'selection:copy',
    },
  },
  {
    context: 'Help',
    bindings: {
      escape: 'help:dismiss',
    },
  },
  // 附件导航，用于选择对话框中的图片附件
  {
    context: 'Attachments',
    bindings: {
      right: 'attachments:next',
      left: 'attachments:previous',
      backspace: 'attachments:remove',
      delete: 'attachments:remove',
      down: 'attachments:exit',
      escape: 'attachments:exit',
    },
  },
  // 页脚指示器导航，包括 tasks、teams、diff、loop
  {
    context: 'Footer',
    bindings: {
      up: 'footer:up',
      'ctrl+p': 'footer:up',
      down: 'footer:down',
      'ctrl+n': 'footer:down',
      right: 'footer:next',
      left: 'footer:previous',
      enter: 'footer:openSelected',
      escape: 'footer:clearSelection',
    },
  },
  // 消息选择器（rewind 对话框）导航
  {
    context: 'MessageSelector',
    bindings: {
      up: 'messageSelector:up',
      down: 'messageSelector:down',
      k: 'messageSelector:up',
      j: 'messageSelector:down',
      'ctrl+p': 'messageSelector:up',
      'ctrl+n': 'messageSelector:down',
      'ctrl+up': 'messageSelector:top',
      'shift+up': 'messageSelector:top',
      'meta+up': 'messageSelector:top',
      'shift+k': 'messageSelector:top',
      'ctrl+down': 'messageSelector:bottom',
      'shift+down': 'messageSelector:bottom',
      'meta+down': 'messageSelector:bottom',
      'shift+j': 'messageSelector:bottom',
      enter: 'messageSelector:select',
    },
  },
  // cursor 活跃时 PromptInput 会卸载，因此不存在按键冲突
  ...(feature('MESSAGE_ACTIONS')
    ? [
        {
          context: 'MessageActions' as const,
          bindings: {
            up: 'messageActions:prev' as const,
            down: 'messageActions:next' as const,
            k: 'messageActions:prev' as const,
            j: 'messageActions:next' as const,
            // macOS 上 meta 表示 cmd，kitty keyboard protocol 使用 super，因此两者都绑定
            'meta+up': 'messageActions:top' as const,
            'meta+down': 'messageActions:bottom' as const,
            'super+up': 'messageActions:top' as const,
            'super+down': 'messageActions:bottom' as const,
            // 存在鼠标选区时，shift+方向键会扩展选区（ScrollKeybindingHandler:573）。正确的
            // 分层交互是先按 esc 清除选区，再用 shift+↑ 跳转。
            'shift+up': 'messageActions:prevUser' as const,
            'shift+down': 'messageActions:nextUser' as const,
            escape: 'messageActions:escape' as const,
            'ctrl+c': 'messageActions:ctrlc' as const,
            // 与 MESSAGE_ACTIONS 保持一致，但不直接导入，以免将 React/Ink 引入此配置模块
            enter: 'messageActions:enter' as const,
            c: 'messageActions:c' as const,
            p: 'messageActions:p' as const,
          },
        },
      ]
    : []),
  // Diff 对话框导航
  {
    context: 'DiffDialog',
    bindings: {
      escape: 'diff:dismiss',
      left: 'diff:previousSource',
      right: 'diff:nextSource',
      up: 'diff:previousFile',
      down: 'diff:nextFile',
      enter: 'diff:viewDetails',
      // 注意：详情模式下由左方向键处理 diff:back
    },
  },
  // 模型选择器 effort 循环切换，仅限 ant
  {
    context: 'ModelPicker',
    bindings: {
      left: 'modelPicker:decreaseEffort',
      right: 'modelPicker:increaseEffort',
    },
  },
  // Select 组件导航，用于 /model、/resume、权限提示等
  {
    context: 'Select',
    bindings: {
      up: 'select:previous',
      down: 'select:next',
      j: 'select:next',
      k: 'select:previous',
      'ctrl+n': 'select:next',
      'ctrl+p': 'select:previous',
      enter: 'select:accept',
      escape: 'select:cancel',
    },
  },
  // Plugin 对话框 action，用于管理、浏览和发现 plugin
  // select:* 导航复用上方的 Select context
  {
    context: 'Plugin',
    bindings: {
      space: 'plugin:toggle',
      i: 'plugin:install',
    },
  },
]
