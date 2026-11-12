import type { UUID } from 'node:crypto'
import { tSync } from '../../i18n/index.js'
import { getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import type { ToolUseContext } from '../../tools/tool.js'
import { AGENT_COLORS, type AgentColorName } from '../../tools/AgentTool/agentColorManager.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../types.js'
import { getTranscriptPath, saveAgentColor } from '../../services/sessionStorage.js'
import { isTeammate } from '../../services/swarm/teammate.js'

const RESET_ALIASES = ['default', 'reset', 'none', 'gray', 'grey'] as const

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  // Teammates cannot set their own color
  if (isTeammate()) {
    onDone(tSync('commands.out.color.teammate'), { display: 'system' })
    return null
  }

  if (!args || args.trim() === '') {
    const colorList = AGENT_COLORS.join(', ')
    onDone(tSync('commands.out.color.missing', { colors: colorList }), {
      display: 'system',
    })
    return null
  }

  const colorArg = args.trim().toLowerCase()

  // Handle reset to default (gray)
  if (RESET_ALIASES.includes(colorArg as (typeof RESET_ALIASES)[number])) {
    const sessionId = getSessionId() as UUID
    const fullPath = getTranscriptPath()

    // Use "default" sentinel (not empty string) so truthiness guards
    // in sessionStorage.ts persist the reset across session restarts
    await saveAgentColor(sessionId, 'default', fullPath)

    context.setAppState((prev) => ({
      ...prev,
      standaloneAgentContext: {
        ...prev.standaloneAgentContext,
        name: prev.standaloneAgentContext?.name ?? '',
        color: undefined,
      },
    }))

    onDone(tSync('commands.out.color.reset'), { display: 'system' })
    return null
  }

  if (!AGENT_COLORS.includes(colorArg as AgentColorName)) {
    const colorList = AGENT_COLORS.join(', ')
    onDone(tSync('commands.out.color.invalid', { color: colorArg, colors: colorList }), {
      display: 'system',
    })
    return null
  }

  const sessionId = getSessionId() as UUID
  const fullPath = getTranscriptPath()

  // Save to transcript for persistence across sessions
  await saveAgentColor(sessionId, colorArg, fullPath)

  // Update AppState for immediate effect
  context.setAppState((prev) => ({
    ...prev,
    standaloneAgentContext: {
      ...prev.standaloneAgentContext,
      name: prev.standaloneAgentContext?.name ?? '',
      color: colorArg as AgentColorName,
    },
  }))

  onDone(tSync('commands.out.color.set', { color: colorArg }), { display: 'system' })
  return null
}
