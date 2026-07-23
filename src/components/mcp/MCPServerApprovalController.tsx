import type { Root } from '../../ink/index.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { getMcpConfigsByScope } from '../../services/mcp/configRepository.js'
import { getProjectMcpServerStatus } from '../../services/mcp/projectServerApproval.js'
import { AppStateProvider } from '../../state/AppState.js'
import { MCPServerApprovalDialog } from '../MCPServerApprovalDialog.js'
import { MCPServerMultiselectDialog } from '../MCPServerMultiselectDialog.js'

/**
 * Show MCP server approval dialogs for pending project servers.
 * Uses the provided Ink root to render (reusing the existing instance
 * from main.tsx instead of creating a separate one).
 */
export async function handleMcpjsonServerApprovals(root: Root): Promise<void> {
  const { servers: projectServers } = getMcpConfigsByScope('project')
  const pendingServers = Object.keys(projectServers).filter(
    (serverName) => getProjectMcpServerStatus(serverName) === 'pending',
  )
  if (pendingServers.length === 0) {
    return
  }
  await new Promise<void>((resolve) => {
    const done = (): void => void resolve()
    if (pendingServers.length === 1 && pendingServers[0] !== undefined) {
      const serverName = pendingServers[0]
      root.render(
        <AppStateProvider>
          <KeybindingSetup>
            <MCPServerApprovalDialog serverName={serverName} onDone={done} />
          </KeybindingSetup>
        </AppStateProvider>,
      )
    } else {
      root.render(
        <AppStateProvider>
          <KeybindingSetup>
            <MCPServerMultiselectDialog serverNames={pendingServers} onDone={done} />
          </KeybindingSetup>
        </AppStateProvider>,
      )
    }
  })
}
