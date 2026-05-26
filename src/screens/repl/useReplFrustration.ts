// 挫败感检测条件 require 包装。
// 抽自 screens/REPL.tsx 的 useFrustrationDetection 条件加载块：
// 仅 ant 内部构建（dogfooding）加载实体，外部构建退化为 closed-state 桩，
// 完全消除该模块（包括两个 O(n) useMemo 与 GrowthBook 调用）。
//
// 与 useReplVoice 同模式：把 isInternalBuild() ? require(...) : noop 跨模块迁移，
// DCE 仍按 caller 模块独立生效（AGENTS.md 第 13 条同款约定）。

import type { Message } from '../../types/message.js'
import { isInternalBuild } from '../../utils/envUtils.js'

// 与 FeedbackSurvey.SurveyState 同形 —— stub 仅返回 'closed' 子集，
// 但 ant 内部构建会返回完整联合，因此在类型层面采用宽集合避免 JSX prop 收窄报错。
export type ReplFrustrationDetection = {
  state: 'closed' | 'open' | 'thanks' | 'transcript_prompt' | 'submitting' | 'submitted'
  handleTranscriptSelect: () => void
}

/* eslint-disable @typescript-eslint/no-require-imports */
const useFrustrationDetectionLazy: typeof import('../../components/FeedbackSurvey/useFrustrationDetection.js').useFrustrationDetection =
  isInternalBuild()
    ? require('../../components/FeedbackSurvey/useFrustrationDetection.js').useFrustrationDetection
    : () => ({
        state: 'closed',
        handleTranscriptSelect: () => {},
      })
/* eslint-enable @typescript-eslint/no-require-imports */

export function useReplFrustration(
  messages: readonly Message[],
  isLoading: boolean,
  hasActivePrompt: boolean,
  isSurveyOpen: boolean,
): ReplFrustrationDetection {
  return useFrustrationDetectionLazy(messages, isLoading, hasActivePrompt, isSurveyOpen)
}
