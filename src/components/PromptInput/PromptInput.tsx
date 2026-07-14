import React from 'react'
import type { Props } from './promptInputTypes.js'
import { usePromptInputState } from './usePromptInputState.js'
import { usePromptInputSuggestions } from './usePromptInputSuggestions.js'
import { usePromptInputSubmission } from './usePromptInputSubmission.js'
import { usePromptInputKeybindings } from './usePromptInputKeybindings.js'
import { usePromptInputViewModel } from './usePromptInputViewModel.js'
import { renderPromptInput } from './RenderPromptInput.js'

function PromptInput(props: Props) {
  const stage0 = usePromptInputState(props)
  const stage1 = usePromptInputSuggestions(stage0)
  const stage2 = usePromptInputSubmission(stage1)
  const stage3 = usePromptInputKeybindings(stage2)
  const stage4 = usePromptInputViewModel(stage3)
  return renderPromptInput(stage4)
}

export default React.memo(PromptInput)
export type { Props } from './promptInputTypes.js'
