import React from 'react'
import { Box } from '../../../../ink.js'
import { useKeybinding } from '../../../../keybindings/useKeybinding.js'
import type { AgentColorName } from '../../../../tools/AgentTool/agentColorManager.js'
import { tSync } from '../../../../i18n/index.js'
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js'
import { Byline } from '../../../design-system/Byline.js'
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js'
import { useWizard } from '../../../wizard/index.js'
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js'
import { ColorPicker } from '../../ColorPicker.js'
export function ColorStep() {
  const { goNext, goBack, updateWizardData, wizardData } = useWizard()
  useKeybinding('confirm:no', goBack, {
    context: 'Confirmation',
  })
  const handleConfirm = (color) => {
    updateWizardData({
      selectedColor: color,
      finalAgent: {
        agentType: wizardData.agentType,
        whenToUse: wizardData.whenToUse,
        getSystemPrompt: () => wizardData.systemPrompt,
        tools: wizardData.selectedTools,
        ...(wizardData.selectedModel
          ? {
              model: wizardData.selectedModel,
            }
          : {}),
        ...(color
          ? {
              color: color as AgentColorName,
            }
          : {}),
        source: wizardData.location,
      },
    })
    goNext()
  }
  // @ts-ignore
  return (
    <WizardDialogLayout
      subtitle={tSync('wizard.chooseColor') as any}
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
        <ColorPicker
          agentName={String(wizardData.agentType || 'agent')}
          currentColor={'automatic' as any}
          onConfirm={handleConfirm}
        />
      </Box>
    </WizardDialogLayout>
  ) as React.ReactElement
}
