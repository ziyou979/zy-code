import { getCommands } from '../../commands.js'
import { toolRegistry } from '../../tools/registry.js'
import { loadAllPluginsCacheOnly } from '../plugins/pluginLoader.js'
import { getAllMcpConfigs } from '../mcp/config.js'

export type ExtensionEntry = {
  name: string
  source?: string
}

export type ExtensionInventory = {
  commands: ExtensionEntry[]
  tools: ExtensionEntry[]
  plugins: ExtensionEntry[]
  skills: ExtensionEntry[]
  mcp: ExtensionEntry[]
}

const SKILL_SOURCES = new Set(['skills', 'bundled', 'mcp', 'plugin', 'managed'])

export async function getExtensionInventory(cwd: string): Promise<ExtensionInventory> {
  const [commands, pluginResult, mcpResult] = await Promise.all([
    getCommands(cwd),
    loadAllPluginsCacheOnly(),
    getAllMcpConfigs(),
  ])

  const tools = toolRegistry.getAll()

  const skillCommands = commands.filter(
    (cmd) => cmd.type === 'prompt' && SKILL_SOURCES.has(cmd.loadedFrom ?? ''),
  )
  const localCommands = commands.filter((cmd) => cmd.type === 'local' || cmd.type === 'local-jsx')

  return {
    commands: localCommands.map((cmd) => ({
      name: cmd.name,
      source: cmd.type,
    })),
    tools: tools.map((tool) => ({
      name: tool.name,
    })),
    plugins: pluginResult.enabled.map((plugin) => ({
      name: plugin.name,
      source: plugin.source,
    })),
    skills: skillCommands.map((cmd) => ({
      name: cmd.name,
      source: cmd.loadedFrom,
    })),
    mcp: Object.entries(mcpResult.servers).map(([name, config]) => ({
      name,
      source: config.scope,
    })),
  }
}
