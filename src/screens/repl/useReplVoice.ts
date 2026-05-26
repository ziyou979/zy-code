// REPL 语音输入集成 hook。
// 抽自 screens/REPL.tsx 的 useVoiceIntegration 条件 require + 调用点。
// 保留 feature('VOICE_MODE') 两次调用（require 一次 + hook 调用一次），
// AGENTS.md 第 13 条明确允许把 `feature() ? require(...) : null` 模式跨模块迁移，
// DCE 按 caller 模块独立生效。
//
// 同模块导出 ReplVoiceKeybindingHandler 组件包装，避免 REPL 主体维护两份 fallback。

import { feature } from 'bun:bundle'
import type React from 'react'

// 与 hooks/useVoiceIntegration.tsx:94 的 InsertTextHandle 同形；inline 以避免
// 把 hook 模块的私有类型公开化（外部构建中该模块整体被 DCE 消除）。
type InsertTextHandle = {
  insert: (text: string) => void
  setInputWithCursor: (value: string, cursor: number) => void
  cursorOffset: number
}
type UseVoiceIntegrationArgs = {
  setInputValueRaw: React.Dispatch<React.SetStateAction<string>>
  inputValueRef: React.RefObject<string>
  insertTextRef: React.RefObject<InsertTextHandle | null>
}
type InterimRange = {
  start: number
  end: number
}
type StripOpts = {
  char?: string
  anchor?: boolean
  floor?: number
}
export type ReplVoiceState = {
  stripTrailing: (maxStrip: number, opts?: StripOpts) => number
  resetAnchor: () => void
  handleKeyEvent: (fallbackMs?: number) => void
  interimRange: InterimRange | null
}

// 死代码消除：仅 VOICE_MODE 构建保留 useVoiceIntegration 实体；
// 外部构建退化为 stripTrailing/handleKeyEvent/resetAnchor 全部 no-op 的 hook。
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const useVoiceIntegrationLazy: typeof import('../../hooks/useVoiceIntegration.js').useVoiceIntegration =
  feature('VOICE_MODE')
    ? require('../../hooks/useVoiceIntegration.js').useVoiceIntegration
    : () => ({
        stripTrailing: () => 0,
        handleKeyEvent: () => {},
        resetAnchor: () => {},
      })

export const ReplVoiceKeybindingHandler: typeof import('../../hooks/useVoiceIntegration.js').VoiceKeybindingHandler =
  feature('VOICE_MODE')
    ? require('../../hooks/useVoiceIntegration.js').VoiceKeybindingHandler
    : () => null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */

export function useReplVoice(args: UseVoiceIntegrationArgs): ReplVoiceState {
  return feature('VOICE_MODE')
    ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() 是构建时常量，DCE 后路径稳定
      useVoiceIntegrationLazy(args)
    : {
        stripTrailing: () => 0,
        handleKeyEvent: () => {},
        resetAnchor: () => {},
        interimRange: null,
      }
}
