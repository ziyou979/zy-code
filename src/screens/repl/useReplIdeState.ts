// REPL IDE 簇 state + hook 装配。
// 抽自 screens/REPL.tsx：
// - 4 个 useState：ideSelection / ideToInstallExtension / ideInstallationStatus / showIdeOnboarding
// - 3 个 hook：useIdeSelection、useIDEIntegration、useIDEStatusIndicator
//
// 依赖跨簇 state：mcpClients（merged）、rawMcpClients（mcp.clients 原始引用）、
// setDynamicMcpConfig（MCP 簇 setter）。等 MCP 簇抽出后这些会顺势收敛进 MCP container；
// 当前先以 prop 透传。

import type React from 'react'
import { useState } from 'react'
import { useIDEStatusIndicator } from '../../hooks/notifs/useIDEStatusIndicator.js'
import { useIDEIntegration } from '../../hooks/useIDEIntegration.js'
import { type IDESelection, useIdeSelection } from '../../hooks/useIdeSelection.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from '../../services/mcp/types.js'
import type { IDEExtensionInstallationStatus, IdeType } from '../../utils/ide.js'

export type UseReplIdeStateParams = {
  autoConnectIdeFlag: boolean | undefined
  isRemoteSession: boolean
  /** 合并后的 mcpClients —— 由 useMergedClients(initialMcpClients, mcp.clients) 产出。 */
  mcpClients: MCPServerConnection[]
  /** mcp.clients 原始引用 —— useIdeSelection 直接消费，不能用 merged 版本（语义差异）。 */
  rawMcpClients: MCPServerConnection[]
  /** MCP 簇 setter；useIDEIntegration 内部会写入 dynamicMcpConfig.ide 节点。 */
  setDynamicMcpConfig: React.Dispatch<
    React.SetStateAction<Record<string, ScopedMcpServerConfig> | undefined>
  >
}

export type UseReplIdeStateResult = {
  ideSelection: IDESelection | undefined
  /** 仅供 onSubmit 等用户操作在显式清空 IDE 选择时调用（REPL.tsx 原 setIDESelection(undefined)）。 */
  setIDESelection: React.Dispatch<React.SetStateAction<IDESelection | undefined>>
  ideToInstallExtension: IdeType | null
  setIDEToInstallExtension: React.Dispatch<React.SetStateAction<IdeType | null>>
  ideInstallationStatus: IDEExtensionInstallationStatus | null
  showIdeOnboarding: boolean
  setShowIdeOnboarding: React.Dispatch<React.SetStateAction<boolean>>
}

// 远程会话下统一把 MCP clients 视作空集，避免 IDE hook 与远程 bridge 抢通道。
const EMPTY_MCP_CLIENTS: MCPServerConnection[] = []

export function useReplIdeState({
  autoConnectIdeFlag,
  isRemoteSession,
  mcpClients,
  rawMcpClients,
  setDynamicMcpConfig,
}: UseReplIdeStateParams): UseReplIdeStateResult {
  const [ideSelection, setIDESelection] = useState<IDESelection | undefined>(undefined)
  const [ideToInstallExtension, setIDEToInstallExtension] = useState<IdeType | null>(null)
  const [ideInstallationStatus, setIDEInstallationStatus] =
    useState<IDEExtensionInstallationStatus | null>(null)
  const [showIdeOnboarding, setShowIdeOnboarding] = useState(false)

  useIdeSelection(isRemoteSession ? EMPTY_MCP_CLIENTS : rawMcpClients, setIDESelection)

  useIDEIntegration({
    autoConnectIdeFlag,
    ideToInstallExtension,
    setDynamicMcpConfig,
    setShowIdeOnboarding,
    setIDEInstallationState: setIDEInstallationStatus,
  })

  useIDEStatusIndicator({
    ideSelection,
    mcpClients,
    ideInstallationStatus,
  })

  return {
    ideSelection,
    setIDESelection,
    ideToInstallExtension,
    setIDEToInstallExtension,
    ideInstallationStatus,
    showIdeOnboarding,
    setShowIdeOnboarding,
  }
}
