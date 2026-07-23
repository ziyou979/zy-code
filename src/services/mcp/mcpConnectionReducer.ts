import omit from 'lodash-es/omit.js'
import reject from 'lodash-es/reject.js'
import type { Command } from '../../commands/index.js'
import type { Tool } from '../../tools/tool.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { PluginError } from '../plugins/types.js'
import { getMcpPrefix } from './mcpStringUtils.js'
import type { MCPServerConnection, ServerResource } from './types.js'
import { commandBelongsToServer } from './utils.js'

export type PendingMcpUpdate = MCPServerConnection & {
  tools?: Tool[]
  commands?: Command[]
  resources?: ServerResource[]
}

function getErrorKey(error: PluginError): string {
  const plugin = 'plugin' in error ? error.plugin : 'no-plugin'
  return `${error.type}:${error.source}:${plugin}`
}

export function addErrorsToAppState(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  newErrors: PluginError[],
): void {
  if (newErrors.length === 0) {
    return
  }

  setAppState((prevState) => {
    const existingKeys = new Set(prevState.plugins.errors.map((error) => getErrorKey(error)))
    const uniqueNewErrors = newErrors.filter((error) => !existingKeys.has(getErrorKey(error)))

    if (uniqueNewErrors.length === 0) {
      return prevState
    }

    return {
      ...prevState,
      plugins: {
        ...prevState.plugins,
        errors: [...prevState.plugins.errors, ...uniqueNewErrors],
      },
    }
  })
}

export function applyPendingMcpUpdates(prevState: AppState, updates: PendingMcpUpdate[]): AppState {
  let mcp = prevState.mcp

  for (const update of updates) {
    const { tools: rawTools, commands: rawCommands, resources: rawResources, ...client } = update
    const tools =
      client.type === 'disabled' || client.type === 'failed' ? (rawTools ?? []) : rawTools
    const commands =
      client.type === 'disabled' || client.type === 'failed' ? (rawCommands ?? []) : rawCommands
    const resources =
      client.type === 'disabled' || client.type === 'failed' ? (rawResources ?? []) : rawResources

    const prefix = getMcpPrefix(client.name)
    const existingClientIndex = mcp.clients.findIndex((entry) => entry.name === client.name)

    const updatedClients =
      existingClientIndex === -1
        ? [...mcp.clients, client]
        : mcp.clients.map((entry) => (entry.name === client.name ? client : entry))

    const updatedTools =
      tools === undefined
        ? mcp.tools
        : [...reject(mcp.tools, (tool) => tool.name?.startsWith(prefix)), ...tools]

    const updatedCommands =
      commands === undefined
        ? mcp.commands
        : [
            ...reject(mcp.commands, (command) => commandBelongsToServer(command, client.name)),
            ...commands,
          ]

    const updatedResources =
      resources === undefined
        ? mcp.resources
        : {
            ...mcp.resources,
            ...(resources.length > 0
              ? { [client.name]: resources }
              : omit(mcp.resources, client.name)),
          }

    mcp = {
      ...mcp,
      clients: updatedClients,
      tools: updatedTools,
      commands: updatedCommands,
      resources: updatedResources,
    }
  }

  return { ...prevState, mcp }
}
