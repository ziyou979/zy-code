// ReplStore — REPL 查询生命周期 + UI 队列状态的外部 store。
//
// 设计原则：
// - 复用 src/state/store.ts 的 createStore（与 AppState 相同模式）
// - 响应式 state 通过 Store<ReplState>.setState 更新（触发 React re-render）
// - 非响应式 mutable 字段通过 store.mutable 直接读写（不触发 re-render）
// - action 方法作为 store 对象的附加属性（非 state 成员）
//
// Phase 1：仅包含类型定义和空工厂。后续 Phase 逐步迁入 state 和 action。

import { randomUUID } from 'node:crypto'
import type React from 'react'
import { createStore, type Store } from './store.js'
import type { Message as MessageType, UserMessage } from '../types/message.js'
import type { SpinnerMode } from '../components/Spinner.js'
import type { StreamingToolUse, StreamingThinking } from '../utils/messages.js'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import type { QueryGuard } from '../utils/QueryGuard.js'
import type { FileStateCache } from '../utils/fileStateCache.js'
import type { ContentReplacementState } from '../utils/toolResultStorage.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { ScopedMcpServerConfig } from '../services/mcp/types.js'
import type { Theme } from '../utils/theme.js'
import type { PromptQueueItem } from '../screens/repl/useReplRequestPrompt.js'
import type { SandboxPermissionRequest } from '../screens/repl/useReplSandboxAsk.js'
import { isHumanTurn } from '../utils/messagePredicates.js'

// ── 响应式 state（变化触发 React re-render）──

export type ToolJSXState = {
  jsx: React.ReactNode | null
  shouldHidePromptInput: boolean
  shouldContinueAnimation?: true
  showSpinner?: boolean
  isLocalJSXCommand?: boolean
  isImmediate?: boolean
}

export type ReplState = {
  messages: MessageType[]
  conversationId: string
  submitCount: number

  streamMode: SpinnerMode
  streamingToolUses: StreamingToolUse[]
  streamingText: string | null
  streamingThinking: StreamingThinking | null
  inProgressToolUseIDs: Set<string>
  lastQueryCompletionTime: number
  isExternalLoading: boolean

  toolUseConfirmQueue: ToolUseConfirm[]
  promptQueue: PromptQueueItem[]
  sandboxPermissionRequestQueue: SandboxPermissionRequest[]

  toolJSX: ToolJSXState | null
  userInputOnProcessing: string | undefined
  idleReturnPending: { input: string; idleMinutes: number } | null
  isMessageSelectorVisible: boolean
  messageSelectorPreselect: UserMessage | undefined

  mainThreadAgentDefinition: AgentDefinition | undefined
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined

  spinnerMessage: string | null
  spinnerColor: keyof Theme | null
  spinnerShimmerColor: keyof Theme | null
}

// ── 非响应式 mutable（直接读写，不触发 re-render）──

export type ReplMutable = {
  queryGuard: QueryGuard
  abortController: AbortController | null
  readFileState: FileStateCache
  responseLengthRef: number
  hasInterruptibleToolInProgress: boolean
  contentReplacementState: ContentReplacementState | null
  discoveredSkillNames: Set<string>
  loadedNestedMemoryPaths: Set<string>
  titleGenerationAttempted: boolean
  skipIdleCheck: boolean
  idleHintShown: string | false
  userInputBaseline: number
  userMessagePending: boolean
  sendWireResult: () => void
  restoreMessageSync: (m: UserMessage) => void
}

// ── Store 类型（base Store + mutable + actions）──

export type ReplStoreInstance = Store<ReplState> & {
  mutable: ReplMutable
  update(partial: Partial<ReplState>): void
  setField<K extends keyof ReplState>(key: K, action: React.SetStateAction<ReplState[K]>): void
  setMessages(action: React.SetStateAction<MessageType[]>): void
  setConversationId(id: string): void
  regenerateConversationId(): void
  incrementSubmitCount(): void
  setUserInputOnProcessing(input: string | undefined): void
  setStreamMode(v: SpinnerMode): void
  setStreamingToolUses(v: React.SetStateAction<StreamingToolUse[]>): void
  setInProgressToolUseIDs(v: React.SetStateAction<Set<string>>): void
  setToolUseConfirmQueue(v: React.SetStateAction<ToolUseConfirm[]>): void
  setPromptQueue(v: React.SetStateAction<PromptQueueItem[]>): void
  setSandboxPermissionRequestQueue(v: React.SetStateAction<SandboxPermissionRequest[]>): void
  setIdleReturnPending(v: React.SetStateAction<ReplState['idleReturnPending']>): void
  setIsMessageSelectorVisible(v: React.SetStateAction<boolean>): void
  setMessageSelectorPreselect(v: UserMessage | undefined): void
  setLastQueryCompletionTime(v: number): void
  setDynamicMcpConfig(
    v: React.SetStateAction<Record<string, ScopedMcpServerConfig> | undefined>,
  ): void
  setMainThreadAgentDefinition(v: React.SetStateAction<AgentDefinition | undefined>): void
}

// ── 工厂参数 ──

export type CreateReplStoreParams = {
  initialMessages?: MessageType[]
  initialMainThreadAgentDefinition?: AgentDefinition
  initialDynamicMcpConfig?: Record<string, ScopedMcpServerConfig>
  initialExternalLoading: boolean
  titleGenerationAttempted: boolean
  queryGuard: QueryGuard
  readFileState: FileStateCache
  contentReplacementState: ContentReplacementState | null
}

// ── 工厂函数 ──

export function createReplStore(params: CreateReplStoreParams): ReplStoreInstance {
  const store = createStore<ReplState>({
    messages: params.initialMessages ?? [],
    conversationId: randomUUID(),
    submitCount: 0,

    streamMode: 'responding',
    streamingToolUses: [],
    streamingText: null,
    streamingThinking: null,
    inProgressToolUseIDs: new Set(),
    lastQueryCompletionTime: 0,
    isExternalLoading: params.initialExternalLoading,

    toolUseConfirmQueue: [],
    promptQueue: [],
    sandboxPermissionRequestQueue: [],

    toolJSX: null,
    userInputOnProcessing: undefined,
    idleReturnPending: null,
    isMessageSelectorVisible: false,
    messageSelectorPreselect: undefined,

    mainThreadAgentDefinition: params.initialMainThreadAgentDefinition,
    dynamicMcpConfig: params.initialDynamicMcpConfig,

    spinnerMessage: null,
    spinnerColor: null,
    spinnerShimmerColor: null,
  })

  const mutable: ReplMutable = {
    queryGuard: params.queryGuard,
    abortController: null,
    readFileState: params.readFileState,
    responseLengthRef: 0,
    hasInterruptibleToolInProgress: false,
    contentReplacementState: params.contentReplacementState,
    discoveredSkillNames: new Set(),
    loadedNestedMemoryPaths: new Set(),
    titleGenerationAttempted: params.titleGenerationAttempted,
    skipIdleCheck: false,
    idleHintShown: false,
    userInputBaseline: 0,
    userMessagePending: false,
    sendWireResult: () => {},
    restoreMessageSync: () => {},
  }

  const instance: ReplStoreInstance = {
    ...store,
    mutable,
    setMessages(action) {
      const prev = store.getState().messages
      const next = typeof action === 'function' ? action(prev) : action
      if (next.length < mutable.userInputBaseline) {
        mutable.userInputBaseline = 0
      } else if (next.length > prev.length && mutable.userMessagePending) {
        const delta = next.length - prev.length
        const added =
          prev.length === 0 || next[0] === prev[0] ? next.slice(-delta) : next.slice(0, delta)
        if (added.some(isHumanTurn)) {
          mutable.userMessagePending = false
        } else {
          mutable.userInputBaseline = next.length
        }
      }
      store.setState((prev) => ({ ...prev, messages: next }))
    },
    setConversationId(id) {
      store.setState((prev) => ({ ...prev, conversationId: id }))
    },
    regenerateConversationId() {
      store.setState((prev) => ({ ...prev, conversationId: randomUUID() }))
    },
    incrementSubmitCount() {
      store.setState((prev) => ({ ...prev, submitCount: prev.submitCount + 1 }))
    },
    update(partial) {
      store.setState((prev) => ({ ...prev, ...partial }))
    },
    setField(key, action) {
      store.setState((prev) => ({
        ...prev,
        [key]:
          typeof action === 'function'
            ? (action as (p: ReplState[typeof key]) => ReplState[typeof key])(prev[key])
            : action,
      }))
    },
    setUserInputOnProcessing(input) {
      if (input !== undefined) {
        mutable.userInputBaseline = store.getState().messages.length
        mutable.userMessagePending = true
      } else {
        mutable.userMessagePending = false
      }
      store.setState((prev) => ({ ...prev, userInputOnProcessing: input }))
    },
    setStreamMode(mode) {
      instance.update({ streamMode: mode })
    },
    setStreamingToolUses(toolUses) {
      instance.setField('streamingToolUses', toolUses)
    },
    setInProgressToolUseIDs(ids) {
      instance.setField('inProgressToolUseIDs', ids)
    },
    setToolUseConfirmQueue(queue) {
      instance.setField('toolUseConfirmQueue', queue)
    },
    setPromptQueue(queue) {
      instance.setField('promptQueue', queue)
    },
    setSandboxPermissionRequestQueue(queue) {
      instance.setField('sandboxPermissionRequestQueue', queue)
    },
    setIdleReturnPending(pending) {
      instance.setField('idleReturnPending', pending)
    },
    setIsMessageSelectorVisible(visible) {
      instance.setField('isMessageSelectorVisible', visible)
    },
    setMessageSelectorPreselect(message) {
      instance.update({ messageSelectorPreselect: message })
    },
    setLastQueryCompletionTime(time) {
      instance.update({ lastQueryCompletionTime: time })
    },
    setDynamicMcpConfig(config) {
      instance.setField('dynamicMcpConfig', config)
    },
    setMainThreadAgentDefinition(definition) {
      instance.setField('mainThreadAgentDefinition', definition)
    },
  }

  return instance
}
