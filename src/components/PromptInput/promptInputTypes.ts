import * as React from 'react'
import { type AppState } from 'src/state/AppState.js'
import { type Command } from '../../commands.js'
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { type ActiveSpeculationState } from '../../services/prompt-suggestion/speculation.js'
import type { ProcessUserInputContext } from '../../services/process-user-input/processUserInput.js'
import type { ToolPermissionContext } from '../../tool.js'
import type { InProcessTeammateTaskState } from '../../tasks/in-process-teammate-task/types.js'
import { type LocalAgentTaskState } from '../../tasks/local-agent-task/LocalAgentTask.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../../types/message.js'
import type { PromptInputMode, VimMode } from '../../types/textInputTypes.js'
import type { AutoUpdaterResult } from '../../utils/autoUpdater.js'
import { type PastedContent } from '../../services/config/config.js'
import type { PromptInputHelpers } from '../../utils/handlePromptSubmit.js'

export type Props = {
  debug: boolean
  ideSelection: IDESelection | undefined
  toolPermissionContext: ToolPermissionContext
  setToolPermissionContext: (ctx: ToolPermissionContext) => void
  apiKeyStatus: VerificationStatus
  commands: Command[]
  agents: AgentDefinition[]
  isLoading: boolean
  verbose: boolean
  messages: Message[]
  onAutoUpdaterResult: (result: AutoUpdaterResult) => void
  autoUpdaterResult: AutoUpdaterResult | null
  input: string
  onInputChange: (value: string) => void
  mode: PromptInputMode
  onModeChange: (mode: PromptInputMode) => void
  stashedPrompt:
    | {
        text: string
        cursorOffset: number
        pastedContents: Record<number, PastedContent>
      }
    | undefined
  setStashedPrompt: (
    value:
      | {
          text: string
          cursorOffset: number
          pastedContents: Record<number, PastedContent>
        }
      | undefined,
  ) => void
  submitCount: number
  onShowMessageSelector: () => void
  /** Fullscreen message actions: shift+↑ enters cursor. */
  onMessageActionsEnter?: () => void
  mcpClients: MCPServerConnection[]
  pastedContents: Record<number, PastedContent>
  setPastedContents: React.Dispatch<React.SetStateAction<Record<number, PastedContent>>>
  vimMode: VimMode
  setVimMode: (mode: VimMode) => void
  showBashesDialog: string | boolean
  setShowBashesDialog: (show: string | boolean) => void
  onExit: () => void
  getToolUseContext: (
    messages: Message[],
    newMessages: Message[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext
  onSubmit: (
    input: string,
    helpers: PromptInputHelpers,
    speculationAccept?: {
      state: ActiveSpeculationState
      speculationSessionTimeSavedMs: number
      setAppState: (f: (prev: AppState) => AppState) => void
    },
    options?: {
      fromKeybinding?: boolean
    },
  ) => Promise<void>
  onAgentSubmit?: (
    input: string,
    task: InProcessTeammateTaskState | LocalAgentTaskState,
    helpers: PromptInputHelpers,
  ) => Promise<void>
  isSearchingHistory: boolean
  setIsSearchingHistory: (isSearching: boolean) => void
  onDismissSideQuestion?: () => void
  isSideQuestionVisible?: boolean
  helpOpen: boolean
  setHelpOpen: React.Dispatch<React.SetStateAction<boolean>>
  hasSuppressedDialogs?: boolean
  isLocalJSXCommandActive?: boolean
  insertTextRef?: React.MutableRefObject<{
    insert: (text: string) => void
    setInputWithCursor: (value: string, cursor: number) => void
    cursorOffset: number
  } | null>
  voiceInterimRange?: {
    start: number
    end: number
  } | null
}
