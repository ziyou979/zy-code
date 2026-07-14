import { tSync } from '../../../../i18n/index.js'
import type { KeyboardEvent } from '../../../../ink/events/keyboard-event.js'
import { Box, Text } from '../../../../ink.js'
import { useKeybinding } from '../../../../keybindings/useKeybinding.js'
import { isAutoMemoryEnabled } from '../../../../memdir/paths.js'
import { getAgentModelDisplay } from '../../../../services/model/agent.js'
import type { Tools } from '../../../../tool.js'
import { getMemoryScopeDisplay } from '../../../../tools/AgentTool/agentMemory.js'
import type { AgentDefinition } from '../../../../tools/AgentTool/loadAgentsDir.js'
import { truncateToWidth } from '../../../../utils/format.js'
import type { SettingSource } from '../../../../services/settings/constants.js'
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js'
import { Byline } from '../../../design-system/Byline.js'
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js'
import { useWizard } from '../../../wizard/index.js'
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js'
import { getNewRelativeAgentFilePath } from '../../agentFileUtils.js'
import { validateAgent } from '../../validateAgent.js'
import type { AgentWizardData } from '../types.js'

type Props = {
  tools: Tools
  existingAgents: AgentDefinition[]
  onSave: () => void
  onSaveAndEdit: () => void
  error?: string | null
}
export function ConfirmStep({ tools, existingAgents, onSave, onSaveAndEdit, error }: Props) {
  const { goBack, wizardData } = useWizard<AgentWizardData>()
  useKeybinding('confirm:no', goBack, {
    context: 'Confirmation',
  })
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 's' || e.key === 'return') {
      e.preventDefault()
      onSave()
    } else {
      if (e.key === 'e') {
        e.preventDefault()
        onSaveAndEdit()
      }
    }
  }
  const agent = wizardData.finalAgent!
  const validation = validateAgent(agent, tools, existingAgents)
  const systemPromptPreview = truncateToWidth(agent.getSystemPrompt(), 240)
  const whenToUsePreview = truncateToWidth(agent.whenToUse, 240)
  const getToolsDisplay = (toolNames: string[] | undefined) => {
    if (toolNames === undefined) {
      return tSync('wizard.allTools')
    }
    if (toolNames.length === 0) {
      return tSync('wizard.none')
    }
    if (toolNames.length === 1) {
      return toolNames[0] || tSync('wizard.none')
    }
    if (toolNames.length === 2) {
      return toolNames.join(' and ')
    }
    return `${toolNames.slice(0, -1).join(', ')}, and ${toolNames[toolNames.length - 1]}`
  }
  const memoryDisplayElement = isAutoMemoryEnabled() ? (
    <Text>
      {tSync('wizard.agentMemory')}: {getMemoryScopeDisplay(agent.memory)}
    </Text>
  ) : null
  const agentFilePath = getNewRelativeAgentFilePath({
    source: wizardData.location ?? 'projectSettings',
    agentType: agent.agentType,
  })
  const toolsDisplay = getToolsDisplay(agent.tools)
  const modelDisplay = getAgentModelDisplay(agent.model)
  const saveHintElement = (
    <Box marginTop={2}>
      <Text color="success">{tSync('wizard.pressSaveOrEnter')}</Text>
    </Box>
  )
  return (
    <WizardDialogLayout
      subtitle={tSync('wizard.confirmAndSave')}
      footerText={
        <Byline>
          <KeyboardShortcutHint shortcut="s/Enter" action="save" />
          <KeyboardShortcutHint shortcut="e" action="edit in your editor" />
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        </Byline>
      }
    >
      {
        <Box flexDirection={'column'} tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>
          {
            <Text>
              {tSync('wizard.agentName')}: {agent.agentType}
            </Text>
          }
          {
            <Text>
              {tSync('wizard.agentLocation')}: {agentFilePath}
            </Text>
          }
          {
            <Text>
              {tSync('wizard.agentTools')}: {toolsDisplay}
            </Text>
          }
          {
            <Text>
              {tSync('wizard.agentModel')}: {modelDisplay}
            </Text>
          }
          {memoryDisplayElement}
          {
            <Box marginTop={1}>
              <Text>{tSync('wizard.agentDescription')}</Text>
            </Box>
          }
          {
            <Box marginLeft={2} marginTop={1}>
              <Text>{whenToUsePreview}</Text>
            </Box>
          }
          {
            <Box marginTop={1}>
              <Text>{tSync('wizard.agentSystemPrompt')}</Text>
            </Box>
          }
          {
            <Box marginLeft={2} marginTop={1}>
              <Text>{systemPromptPreview}</Text>
            </Box>
          }
          {validation.warnings.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text color="warning">{tSync('wizard.warnings')}</Text>
              {validation.warnings.map((warning, i) => (
                <Text key={i} dimColor={true}>
                  {' '}
                  • {warning}
                </Text>
              ))}
            </Box>
          )}
          {validation.errors.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text color="error">{tSync('wizard.errors')}</Text>
              {validation.errors.map((err, i_0) => (
                <Text key={i_0} color="error">
                  {' '}
                  • {err}
                </Text>
              ))}
            </Box>
          )}
          {error && (
            <Box marginTop={1}>
              <Text color="error">{error}</Text>
            </Box>
          )}
          {saveHintElement}
        </Box>
      }
    </WizardDialogLayout>
  )
}
