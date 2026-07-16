import { WARNING } from '../../constants/figures.js'
import { tSync } from '../../i18n/index.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink/index.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { getAgentModelDisplay } from '../../services/model/agent.js'
import type { Tools } from '../../tools/Tool.js'
import { getAgentColor } from '../../tools/AgentTool/agentColorManager.js'
import { getMemoryScopeDisplay } from '../../tools/AgentTool/agentMemory.js'
import { resolveAgentTools } from '../../tools/AgentTool/agentToolUtils.js'
import { type AgentDefinition, isBuiltInAgent } from '../../tools/AgentTool/loadAgentsDir.js'
import { Markdown } from '../Markdown.js'
import { getActualRelativeAgentFilePath } from './agentFileUtils.js'

type Props = {
  agent: AgentDefinition
  tools: Tools
  onBack: () => void
}
export function AgentDetail({ agent, tools, onBack }: Props) {
  const resolvedTools = resolveAgentTools(agent, tools, false)
  const filePath = getActualRelativeAgentFilePath(agent)
  const backgroundColor = getAgentColor(agent.agentType)
  useKeybinding('confirm:no', onBack, {
    context: 'Confirmation',
  })
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'return') {
      e.preventDefault()
      onBack()
    }
  }
  const renderToolsList = function renderToolsList() {
    if (resolvedTools.hasWildcard) {
      return <Text>{tSync('agentDetail.allTools')}</Text>
    }
    if (!agent.tools || agent.tools.length === 0) {
      return <Text>{tSync('agentDetail.none')}</Text>
    }
    return (
      <>
        {resolvedTools.validTools.length > 0 && <Text>{resolvedTools.validTools.join(', ')}</Text>}
        {resolvedTools.invalidTools.length > 0 && (
          <Text color="warning">
            {WARNING} Unrecognized: {resolvedTools.invalidTools.join(', ')}
          </Text>
        )}
      </>
    )
  }
  const toolsList = renderToolsList()
  const modelDisplay = getAgentModelDisplay(agent.model)
  const systemPromptSection = !isBuiltInAgent(agent) && (
    <>
      <Box>
        <Text>
          <Text bold={true}>System prompt</Text>:
        </Text>
      </Box>
      <Box marginLeft={2} marginRight={2}>
        <Markdown>{agent.getSystemPrompt()}</Markdown>
      </Box>
    </>
  )
  return (
    <Box flexDirection={'column'} gap={1} tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>
      {<Text dimColor={true}>{filePath}</Text>}
      {
        <Box flexDirection="column">
          {
            <Text>
              <Text bold={true}>Description</Text> (tells Zy when to use this agent):
            </Text>
          }
          <Box marginLeft={2}>
            <Text>{agent.whenToUse}</Text>
          </Box>
        </Box>
      }
      {
        <Box>
          {
            <Text>
              <Text bold={true}>Tools</Text>:{' '}
            </Text>
          }
          {toolsList}
        </Box>
      }
      {
        <Text>
          {<Text bold={true}>Model</Text>}: {modelDisplay}
        </Text>
      }
      {agent.permissionMode && (
        <Text>
          <Text bold={true}>Permission mode</Text>: {agent.permissionMode}
        </Text>
      )}
      {agent.memory && (
        <Text>
          <Text bold={true}>Memory</Text>: {getMemoryScopeDisplay(agent.memory)}
        </Text>
      )}
      {agent.hooks && Object.keys(agent.hooks).length > 0 && (
        <Text>
          <Text bold={true}>Hooks</Text>: {Object.keys(agent.hooks).join(', ')}
        </Text>
      )}
      {agent.skills && agent.skills.length > 0 && (
        <Text>
          <Text bold={true}>Skills</Text>:{' '}
          {agent.skills.length > 10
            ? tSync('agent.skillsCount', { count: agent.skills.length })
            : agent.skills.join(', ')}
        </Text>
      )}
      {backgroundColor && (
        <Box>
          <Text>
            <Text bold={true}>Color</Text>:{' '}
            <Text backgroundColor={backgroundColor} color="inverseText">
              {' '}
              {agent.agentType}{' '}
            </Text>
          </Text>
        </Box>
      )}
      {systemPromptSection}
    </Box>
  )
}
