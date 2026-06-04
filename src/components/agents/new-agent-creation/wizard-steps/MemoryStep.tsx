import { tSync } from '../../../../i18n/index.js'
import { Box } from '../../../../ink.js'
import { useKeybinding } from '../../../../keybindings/useKeybinding.js'
import { isAutoMemoryEnabled } from '../../../../memdir/paths.js'
import {
  type AgentMemoryScope,
  loadAgentMemoryPrompt,
} from '../../../../tools/AgentTool/agentMemory.js'
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js'
import { Select } from '../../../CustomSelect/select.js'
import { Byline } from '../../../design-system/Byline.js'
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js'
import { useWizard } from '../../../wizard/index.js'
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js'

type MemoryOption = {
  label: string
  value: AgentMemoryScope | 'none'
}
export function MemoryStep() {
  const { goNext, goBack, updateWizardData, wizardData } = useWizard()
  useKeybinding('confirm:no', goBack, {
    context: 'Confirmation',
  })
  const isUserScope = wizardData.location === 'userSettings'
  const memoryOptions = isUserScope
    ? [
        {
          label: tSync('wizard.memoryUserScopeRec'),
          value: 'user',
        },
        {
          label: tSync('wizard.memoryNone'),
          value: 'none',
        },
        {
          label: tSync('wizard.memoryProjectScopePlain'),
          value: 'project',
        },
        {
          label: tSync('wizard.memoryLocalScope'),
          value: 'local',
        },
      ]
    : [
        {
          label: tSync('wizard.memoryProjectScopeRec'),
          value: 'project',
        },
        {
          label: tSync('wizard.memoryNone'),
          value: 'none',
        },
        {
          label: tSync('wizard.memoryUserScopePlain'),
          value: 'user',
        },
        {
          label: tSync('wizard.memoryLocalScope'),
          value: 'local',
        },
      ]
  const handleSelect = (value: string) => {
    const memory = value === 'none' ? undefined : (value as AgentMemoryScope)
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    const agentType = (wizardData.finalAgent as any)?.agentType
    updateWizardData({
      selectedMemory: memory,
      finalAgent: wizardData.finalAgent
        ? {
            // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
            ...(wizardData.finalAgent as any),
            memory,
            getSystemPrompt:
              isAutoMemoryEnabled() && memory && agentType
                ? () => `${wizardData.systemPrompt}\n\n${loadAgentMemoryPrompt(agentType, memory)}`
                : () => wizardData.systemPrompt,
          }
        : undefined,
    })
    goNext()
  }
  return (
    <WizardDialogLayout
      subtitle={tSync('wizard.configureMemory')}
      footerText={
        <Byline>
          <KeyboardShortcutHint shortcut={'\u2191\u2193'} action="navigate" />
          <KeyboardShortcutHint shortcut="Enter" action="select" />
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="go back"
          />
        </Byline>
      }
    >
      <Box>
        <Select
          key="memory-select"
          options={memoryOptions}
          onChange={handleSelect}
          onCancel={goBack}
        />
      </Box>
    </WizardDialogLayout>
  )
}
