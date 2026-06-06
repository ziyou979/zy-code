// 装配阶段公共类型。
// rootAction 拆分时统一通过这些类型把上下文传给 mode 模块，
// 避免 7 个 launchRepl 出口各自维护一组散参数。

import type React from 'react'
import type { StatsStore } from '../../context/stats.js'
import type { Root } from '../../ink.js'
import type { Props as REPLProps } from '../../screens/REPL.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { FpsMetrics } from '../../utils/fpsTracker.js'

// renderAndRun 在 main.tsx 内构造，沿用 replLauncher 的签名形态。
export type RenderAndRun = (root: Root, element: React.ReactNode) => Promise<void>

// App 容器属性，对应 replLauncher.tsx:8-12 的 AppWrapperProps。
export type AssemblyAppProps = {
  getFpsMetrics: () => FpsMetrics | undefined
  stats?: StatsStore
  initialState: AppState
}

// rootAction 第 2731 行构造的 sessionConfig，对应 REPLProps 的子集。
// 仅用于 sessionConfig 模式分支（interactive / resume / resumeChooser）。
// 远程类分支（directConnect / ssh / coordinatorRemote / bridge）会手写字段。
export type SessionConfig = Pick<
  REPLProps,
  | 'debug'
  | 'commands'
  | 'initialTools'
  | 'mcpClients'
  | 'autoConnectIdeFlag'
  | 'mainThreadAgentDefinition'
  | 'disableSlashCommands'
  | 'dynamicMcpConfig'
  | 'strictMcpConfig'
  | 'systemPrompt'
  | 'appendSystemPrompt'
  | 'taskListId'
  | 'thinkingConfig'
  | 'onTurnComplete'
>

// 所有 mode 模块共享的最小入参，由 rootAction 在装配末尾一次性构造。
export type AssemblyContext = {
  root: Root
  appProps: AssemblyAppProps
  renderAndRun: RenderAndRun
}

// Commander action 回调传入的 options。字段来自 main.tsx 中 .option() 注册
// 以及 feature() 门控的动态选项。所有字段可选（commander 未传时为 undefined）。
export interface RootActionOptions {
  // 模式控制
  bare?: boolean
  print?: boolean | string
  init?: boolean
  initOnly?: boolean
  maintenance?: boolean
  continue?: boolean
  resume?: boolean | string
  forkSession?: boolean
  fromPr?: boolean | string

  // 模型与推理
  model?: string
  thinking?: 'adaptive' | 'enabled' | 'disabled'
  maxThinkingTokens?: number
  effort?: string
  advisor?: string

  // 输入/输出
  inputFormat?: string
  outputFormat?: string
  verbose?: boolean
  jsonSchema?: string
  prefill?: string
  name?: string
  replayUserMessages?: boolean
  sessionPersistence?: boolean

  // 系统提示
  systemPrompt?: string
  systemPromptFile?: string
  appendSystemPrompt?: string
  appendSystemPromptFile?: string

  // 工具与权限
  disableSlashCommands?: boolean
  strictMcpConfig?: boolean
  permissionPromptTool?: string
  enableAutoMode?: boolean
  enableAuthStatus?: boolean

  // 代理
  agent?: string
  agents?: string
  agentId?: string

  // 限制
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: number

  // 远程/桥接
  sdkUrl?: string
  remote?: string | true
  remoteControl?: string | true
  rc?: string | true
  teleport?: string | true
  messagingSocketPath?: string

  // 工作区
  worktree?: boolean | string
  tmux?: boolean
  resumeSessionAt?: string
  rewindFiles?: string

  // Kairos/团队
  assistant?: boolean
  brief?: boolean
  proactive?: boolean
  channels?: string[]
  dangerouslyLoadDevelopmentChannels?: string[]

  // 调试
  debug?: boolean
  debugToStderr?: boolean

  // 权限
  dangerouslySkipPermissions?: boolean
  allowDangerouslySkipPermissions?: boolean
  permissionMode?: string

  // 工具列表（CLI --tools / --allowed-tools / --disallowed-tools）
  tools?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]

  // MCP
  mcpConfig?: string[]
  addDir?: string[]

  // 模型
  fallbackModel?: string

  // SDK / 集成
  betas?: string[]
  ide?: boolean
  sessionId?: string
  includeHookEvents?: boolean
  includePartialMessages?: boolean

  // 其他
  chrome?: boolean
  tasks?: boolean | string
  file?: string[]
  workload?: string

  // feature() 门控的选项可能以 [key: string] 形式存在
  [key: string]: unknown
}
