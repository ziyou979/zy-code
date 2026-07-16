import { tSync } from '../../../../i18n/index.js'
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js'
import { Byline } from '../../../design-system/Byline.js'
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js'
import { useWizard } from '../../../wizard/index.js'
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js'
import { ModelSelector } from '../../ModelSelector.js'
export function ModelStep() {
  const { goNext, goBack, updateWizardData, wizardData } = useWizard<{ selectedModel?: string }>()
  const handleComplete = (model: string | undefined) => {
    updateWizardData({
      selectedModel: model,
    })
    goNext()
  }
  return (
    <WizardDialogLayout
      subtitle={tSync('wizard.selectModel')}
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
      <ModelSelector
        initialModel={wizardData.selectedModel}
        onComplete={handleComplete}
        onCancel={goBack}
      />
    </WizardDialogLayout>
  )
}
