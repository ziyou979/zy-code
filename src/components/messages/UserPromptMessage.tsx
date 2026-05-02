import { feature } from 'bun:bundle'
import type { TextBlock } from '../../types/llm.js'
import React, { useContext, useMemo } from 'react'
import { getKairosActive, getUserMsgOptIn } from '../../bootstrap/state.js'
import { Box } from '../../ink.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { useAppState } from '../../state/AppState.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { countCharInString } from '../../utils/stringUtils.js'
import { MessageActionsSelectedContext } from '../messageActions.js'
import { HighlightedThinkingText } from './HighlightedThinkingText.js'
type Props = {
  addMargin: boolean
  param: TextBlock
  isTranscriptMode?: boolean
  timestamp?: string
}

// 对用户提示文本设置硬性上限。通过 stdin 管道传输大文件
//（例如 `cat 11k-line-file | zy`）会产生单条用户消息，其
// <Text> 节点在每帧都需要全屏 Ink 渲染器进行换行/输出，
// 导致按键延迟超过 500ms。React.memo 可以跳过 React 渲染，但
// Ink 输出阶段仍会遍历完整的挂载文本。非全屏模式通过
// <Static>（打印后忘记，交给终端回滚缓冲区）避免此问题。
// 保留头部和尾部是因为 `{ cat file; echo prompt; } | zy` 会把
// 用户的实际问题放在末尾。
const MAX_DISPLAY_CHARS = 10_000
const TRUNCATE_HEAD_CHARS = 2_500
const TRUNCATE_TAIL_CHARS = 2_500
export function UserPromptMessage({
  addMargin,
  param: { text },
  isTranscriptMode,
  timestamp,
}: Props): React.ReactNode {
  // REPL.tsx 传入 isBriefOnly={viewedTeammateTask ? false : isBriefOnly}，
  // 但该 prop 没有传递到这一层——通过直接读取 viewingAgentTaskId 来复现覆盖逻辑。
  // 在此处计算（而非在子组件中），以便父级 Box 在 brief 模式下可以省略 backgroundColor：
  // 子组件会渲染为标签式布局，而 Box 的 backgroundColor 会无条件绘制在子元素后面
  //（子元素无法选择退出）。
  //
  // Hooks 保留在 feature() 三元表达式内部，这样外部构建不会为每条
  // 回滚消息承担 store 订阅开销（useSyncExternalStore 会绕过 React.memo）。
  // 运行时门控类似于 isBriefEnabled()，但内联以避免将 BriefTool.ts → prompt.ts
  // 的工具名称字符串引入外部构建。
  const isBriefOnly =
    feature('KAIROS') || feature('KAIROS_BRIEF')
      ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
        useAppState((s) => s.isBriefOnly)
      : false
  const viewingAgentTaskId =
    feature('KAIROS') || feature('KAIROS_BRIEF')
      ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
        useAppState((s_0) => s_0.viewingAgentTaskId)
      : null
  // 提升至 mount 阶段——每条消息的组件在每个滚动周期都会重新渲染。
  const briefEnvEnabled =
    feature('KAIROS') || feature('KAIROS_BRIEF')
      ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
        useMemo(() => isEnvTruthy(process.env.ZY_CODE_BRIEF), [])
      : false
  const useBriefLayout =
    feature('KAIROS') || feature('KAIROS_BRIEF')
      ? (getKairosActive() ||
          (getUserMsgOptIn() &&
            (briefEnvEnabled || getFeatureValue_CACHED_MAY_BE_STALE('zy_kairos_brief', false)))) &&
        isBriefOnly &&
        !isTranscriptMode &&
        !viewingAgentTaskId
      : false

  // 在提前返回之前进行截断，以确保 hook 顺序稳定。
  const displayText = useMemo(() => {
    if (text.length <= MAX_DISPLAY_CHARS) return text
    const head = text.slice(0, TRUNCATE_HEAD_CHARS)
    const tail = text.slice(-TRUNCATE_TAIL_CHARS)
    const hiddenLines =
      countCharInString(text, '\n', TRUNCATE_HEAD_CHARS) - countCharInString(tail, '\n')
    return `${head}\n… +${hiddenLines} lines …\n${tail}`
  }, [text])
  const isSelected = useContext(MessageActionsSelectedContext)
  if (!text) {
    logError(new Error('No content found in user prompt message'))
    return null
  }
  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      backgroundColor={
        isSelected
          ? 'messageActionsBackground'
          : useBriefLayout
            ? undefined
            : 'userMessageBackground'
      }
      paddingRight={useBriefLayout ? 0 : 1}
    >
      <HighlightedThinkingText
        text={displayText}
        useBriefLayout={useBriefLayout}
        timestamp={useBriefLayout ? timestamp : undefined}
      />
    </Box>
  )
}
