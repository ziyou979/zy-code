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
