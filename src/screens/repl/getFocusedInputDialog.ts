/**
 * getFocusedInputDialog — 纯派生函数，从 REPL.tsx 提取。
 *
 * 确定哪个对话框应该获得焦点（如果有）。权限和交互式对话框
 * 即使在设置了 toolJSX 时也可以显示，只要 shouldContinueAnimation
 * 为 true。
 */

import { feature } from 'bun:bundle'
import type React from 'react'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import type { ToolJSXState } from '../../state/ReplStore.js'
import type { FocusedInputDialog } from './useReplOnCancel.js'
import type { PromptQueueItem } from './useReplRequestPrompt.js'
import type { SandboxPermissionRequest } from './useReplSandboxAsk.js'
import type { ResumeReturnPrompt } from '../../services/sessionStorage/resumeReturn.js'

export interface GetFocusedInputDialogParams {
  isExiting: boolean
  exitFlow: React.ReactNode
  isMessageSelectorVisible: boolean
  isPromptInputActive: boolean
  sandboxPermissionRequestQueue: readonly SandboxPermissionRequest[]
  toolJSX: ToolJSXState | null
  toolUseConfirmQueue: ToolUseConfirm[]
  promptQueue: PromptQueueItem[]
  workerSandboxPermissionsQueue: readonly unknown[]
  elicitationQueue: readonly unknown[]
  idleReturnPending: { input: string; idleMinutes: number } | null
  resumeReturnPending?: ResumeReturnPrompt | null
  isLoading: boolean
  ultraplanPendingChoice: unknown
  ultraplanLaunchPending: unknown
  showIdeOnboarding: boolean
  showEffortCallout: boolean
  showRemoteCallout: boolean
  lspRecommendation: unknown
  hintRecommendation: unknown
  showFullscreenUpsell: boolean
  showDesktopUpsellStartup: boolean
}

export function getFocusedInputDialog(p: GetFocusedInputDialogParams): FocusedInputDialog {
  // 退出状态始终优先
  if (p.isExiting || p.exitFlow) {
    return undefined
  }

  // 高优先级对话框（无论打字与否始终显示）
  if (p.isMessageSelectorVisible) {
    return 'message-selector'
  }

  // 用户打字时抑制中断对话框
  if (p.isPromptInputActive) {
    return undefined
  }
  if (p.sandboxPermissionRequestQueue[0]) {
    return 'sandbox-permission'
  }

  // 权限/交互式对话框（除非被 toolJSX 阻止否则显示）
  const allowDialogsWithAnimation = !p.toolJSX || p.toolJSX.shouldContinueAnimation
  if (allowDialogsWithAnimation && p.toolUseConfirmQueue[0]) {
    return 'tool-permission'
  }
  if (allowDialogsWithAnimation && p.promptQueue[0]) {
    return 'prompt'
  }
  // 来自 swarm worker 的 worker 沙盒权限提示（网络访问）
  if (allowDialogsWithAnimation && p.workerSandboxPermissionsQueue[0]) {
    return 'worker-sandbox-permission'
  }
  if (allowDialogsWithAnimation && p.elicitationQueue[0]) {
    return 'elicitation'
  }
  if (allowDialogsWithAnimation && p.idleReturnPending) {
    return 'idle-return'
  }
  if (allowDialogsWithAnimation && p.resumeReturnPending) {
    return 'resume-return'
  }
  if (
    feature('ULTRAPLAN') &&
    allowDialogsWithAnimation &&
    !p.isLoading &&
    p.ultraplanPendingChoice
  ) {
    return 'ultraplan-choice'
  }
  if (
    feature('ULTRAPLAN') &&
    allowDialogsWithAnimation &&
    !p.isLoading &&
    p.ultraplanLaunchPending
  ) {
    return 'ultraplan-launch'
  }

  // Onboarding 对话框（特殊条件）
  if (allowDialogsWithAnimation && p.showIdeOnboarding) {
    return 'ide-onboarding'
  }

  // Effort callout（启用 effort 时为 Opus 4.6 用户显示一次）
  if (allowDialogsWithAnimation && p.showEffortCallout) {
    return 'effort-callout'
  }

  // 远程 callout（首次启用桥之前显示一次）
  if (allowDialogsWithAnimation && p.showRemoteCallout) {
    return 'remote-callout'
  }

  // LSP 插件推荐（最低优先级 - 非阻塞建议）
  if (allowDialogsWithAnimation && p.lspRecommendation) {
    return 'lsp-recommendation'
  }

  // 来自 CLI/SDK stderr 的插件提示（与 LSP 推荐相同优先级）
  if (allowDialogsWithAnimation && p.hintRecommendation) {
    return 'plugin-hint'
  }

  // 全屏模式推荐（最多 3 次启动）
  if (allowDialogsWithAnimation && p.showFullscreenUpsell) {
    return 'fullscreen-upsell'
  }

  // 桌面应用推荐（最多 3 次启动，最低优先级）
  if (allowDialogsWithAnimation && p.showDesktopUpsellStartup) {
    return 'desktop-upsell'
  }
  return undefined
}
