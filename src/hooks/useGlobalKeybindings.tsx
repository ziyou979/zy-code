/**
 * 注册全局快捷键处理器的组件。
 *
 * 必须在 KeybindingSetup 内部渲染才能访问快捷键上下文。
 * 此组件不渲染任何内容 — 仅注册快捷键处理器。
 */
import { feature } from 'bun:bundle'
import { useCallback } from 'react'
import instances from '../ink/instances.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import type { Screen } from '../screens/REPL.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { count } from '../utils/array.js'
import { getTerminalPanel } from '../terminal-ui/terminalPanel.js'

type Props = {
  screen: Screen
  setScreen: React.Dispatch<React.SetStateAction<Screen>>
  showAllInTranscript: boolean
  setShowAllInTranscript: React.Dispatch<React.SetStateAction<boolean>>
  messageCount: number
  onEnterTranscript?: () => void
  onExitTranscript?: () => void
  virtualScrollActive?: boolean
  searchBarOpen?: boolean
}

/**
 * 注册全局快捷键处理器：
 * - ctrl+t: 切换待办列表
 * - ctrl+o: 切换转录模式
 * - ctrl+e: 切换转录中显示所有消息
 * - ctrl+c/escape: 退出转录模式
 */
export function GlobalKeybindingHandlers({
  screen,
  setScreen,
  showAllInTranscript,
  setShowAllInTranscript,
  messageCount,
  onEnterTranscript,
  onExitTranscript,
  virtualScrollActive,
  searchBarOpen = false,
}: Props): null {
  const expandedView = useAppState((s) => s.expandedView)
  const setAppState = useSetAppState()

  // 切换待办列表 (ctrl+t) - 循环切换视图
  const handleToggleTodos = useCallback(() => {
    logEvent('zy_toggle_todos', {
      is_expanded: expandedView === 'tasks',
    })
    setAppState((prev) => {
      const { getAllInProcessTeammateTasks } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../tasks/in-process-teammate-task/InProcessTeammateTask.js') as typeof import('../tasks/in-process-teammate-task/InProcessTeammateTask.js')
      const hasTeammates =
        count(getAllInProcessTeammateTasks(prev.tasks), (t) => t.status === 'running') > 0
      if (hasTeammates) {
        // 两者都存在：none → tasks → teammates → none
        switch (prev.expandedView) {
          case 'none':
            return {
              ...prev,
              expandedView: 'tasks' as const,
            }
          case 'tasks':
            return {
              ...prev,
              expandedView: 'teammates' as const,
            }
          case 'teammates':
            return {
              ...prev,
              expandedView: 'none' as const,
            }
        }
      }
      // 仅任务：none ↔ tasks
      return {
        ...prev,
        expandedView: prev.expandedView === 'tasks' ? ('none' as const) : ('tasks' as const),
      }
    })
  }, [expandedView, setAppState])

  // 切换转录模式 (ctrl+o)。双向切换 prompt ↔ transcript。
  // Brief 视图有自己的专用切换键 ctrl+shift+b。
  const isBriefOnly =
    feature('KAIROS') || feature('KAIROS_BRIEF')
      ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
        useAppState((state) => state.isBriefOnly)
      : false
  const handleToggleTranscript = useCallback(() => {
    if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
      // 逃生通道：当 defaultView=chat 被持久化后 GB 开关被关闭，
      // 可能让 isBriefOnly 卡在开启状态，显示空白的 filterForBriefTool
      // 视图。用户会按 ctrl+o — 先清除卡住的状态。
      // 仅在 prompt 屏幕需要 — 转录模式已忽略 isBriefOnly
      // （Messages.tsx 过滤器以 !isTranscriptMode 为门控）。
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { isBriefEnabled } =
        require('../tools/BriefTool/BriefTool.js') as typeof import('../tools/BriefTool/BriefTool.js')
      /* eslint-enable @typescript-eslint/no-require-imports */
      if (!isBriefEnabled() && isBriefOnly && screen !== 'transcript') {
        setAppState((prev) => {
          if (!prev.isBriefOnly) {
            return prev
          }
          return {
            ...prev,
            isBriefOnly: false,
          }
        })
        return
      }
    }
    const isEnteringTranscript = screen !== 'transcript'
    logEvent('zy_toggle_transcript', {
      is_entering: isEnteringTranscript,
      show_all: showAllInTranscript,
      message_count: messageCount,
    })
    setScreen((s) => (s === 'transcript' ? 'prompt' : 'transcript'))
    setShowAllInTranscript(false)
    if (isEnteringTranscript && onEnterTranscript) {
      onEnterTranscript()
    }
    if (!isEnteringTranscript && onExitTranscript) {
      onExitTranscript()
    }
  }, [
    screen,
    setScreen,
    isBriefOnly,
    showAllInTranscript,
    setShowAllInTranscript,
    messageCount,
    setAppState,
    onEnterTranscript,
    onExitTranscript,
  ])

  // 切换转录中显示所有消息 (ctrl+e)
  const handleToggleShowAll = useCallback(() => {
    logEvent('zy_transcript_toggle_show_all', {
      is_expanding: !showAllInTranscript,
      message_count: messageCount,
    })
    setShowAllInTranscript((prev) => !prev)
  }, [showAllInTranscript, setShowAllInTranscript, messageCount])

  // 退出转录模式 (ctrl+c 或 escape)
  const handleExitTranscript = useCallback(() => {
    logEvent('zy_transcript_exit', {
      show_all: showAllInTranscript,
      message_count: messageCount,
    })
    setScreen('prompt')
    setShowAllInTranscript(false)
    if (onExitTranscript) {
      onExitTranscript()
    }
  }, [setScreen, showAllInTranscript, setShowAllInTranscript, messageCount, onExitTranscript])

  // 切换仅简报视图 (ctrl+shift+b)。纯显示过滤器切换 —
  // 不触碰 opt-in 状态。非对称门控（与 /brief 镜像）：
  // OFF 转换始终允许，这样即使 GB 开关在会话中途关闭，
  // 同一个按键也能让你退出。
  const handleToggleBrief = useCallback(() => {
    if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { isBriefEnabled: checkBriefEnabled } =
        require('../tools/BriefTool/BriefTool.js') as typeof import('../tools/BriefTool/BriefTool.js')
      /* eslint-enable @typescript-eslint/no-require-imports */
      if (!checkBriefEnabled() && !isBriefOnly) {
        return
      }
      const next = !isBriefOnly
      logEvent('zy_brief_mode_toggled', {
        enabled: next,
        gated: false,
        source: 'keybinding' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      setAppState((prev) => {
        if (prev.isBriefOnly === next) {
          return prev
        }
        return {
          ...prev,
          isBriefOnly: next,
        }
      })
    }
  }, [isBriefOnly, setAppState])

  // 注册快捷键处理器
  useKeybinding('app:toggleTodos', handleToggleTodos, {
    context: 'Global',
  })
  useKeybinding('app:toggleTranscript', handleToggleTranscript, {
    context: 'Global',
  })
  if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
    // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
    useKeybinding('app:toggleBrief', handleToggleBrief, {
      context: 'Global',
    })
  }

  // 注册 teammate 快捷键
  useKeybinding(
    'app:toggleTeammatePreview',
    () => {
      setAppState((prevState) => ({
        ...prevState,
        showTeammateMessagePreview: !prevState.showTeammateMessagePreview,
      }))
    },
    {
      context: 'Global',
    },
  )

  // 切换内置终端面板 (meta+j)。
  // toggle() 在 spawnSync 中阻塞，直到用户从 tmux 分离。
  const handleToggleTerminal = useCallback(() => {
    if (feature('TERMINAL_PANEL')) {
      if (!getFeatureValue_CACHED_MAY_BE_STALE('zy_terminal_panel', false)) {
        return
      }
      getTerminalPanel().toggle()
    }
  }, [])
  useKeybinding('app:toggleTerminal', handleToggleTerminal, {
    context: 'Global',
  })

  // 清屏并强制完全重绘 (ctrl+l)。当终端被外部清除
  // （如 macOS Cmd+K）且 Ink 的差异引擎认为未更改的
  // 单元格不需要重绘时的恢复路径。
  const handleRedraw = useCallback(() => {
    instances.get(process.stdout)?.forceRedraw()
  }, [])
  useKeybinding('app:redraw', handleRedraw, {
    context: 'Global',
  })

  // 转录模式专用绑定（仅在转录模式下激活）
  const isInTranscript = screen === 'transcript'
  useKeybinding('transcript:toggleShowAll', handleToggleShowAll, {
    context: 'Transcript',
    isActive: isInTranscript && !virtualScrollActive,
  })
  useKeybinding('transcript:exit', handleExitTranscript, {
    context: 'Transcript',
    // 搜索栏打开是一种模式（拥有按键）。导航状态（高亮
    // 可见，n/N 激活，搜索栏关闭）不是 — Esc 直接退出
    // 转录模式，与 less q 相同。useSearchInput 不阻止冒泡，
    // 因此若无此门控，其 onCancel 和此处理程序会在一次
    // Esc 中同时触发（子组件先注册，先触发，然后冒泡）。
    isActive: isInTranscript && !searchBarOpen,
  })
  return null
}
