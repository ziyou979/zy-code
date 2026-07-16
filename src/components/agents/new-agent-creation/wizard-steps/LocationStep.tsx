import { tSync } from '../../../../i18n/index.js'
import { Box } from '../../../../ink/index.js'
import type { SettingSource } from '../../../../services/settings/constants.js'
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js'
import { Select } from '../../../CustomSelect/select.js'
import { Byline } from '../../../design-system/Byline.js'
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js'
import { useWizard } from '../../../wizard/index.js'
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js'
export function LocationStep() {
  const { goNext, updateWizardData, cancelWizard: cancel } = useWizard()
  const locationOptions = [
    {
      label: tSync('wizard.locationProject'),
      value: 'projectSettings' as SettingSource,
    },
    {
      label: tSync('wizard.locationPersonal'),
      value: 'userSettings' as SettingSource,
    },
  ]
  return (
    <WizardDialogLayout
      subtitle={tSync('wizard.chooseLocation')}
      footerText={
        <Byline>
          <KeyboardShortcutHint shortcut={'\u2191\u2193'} action="navigate" />
          <KeyboardShortcutHint shortcut="Enter" action="select" />
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        </Byline>
      }
    >
      <Box>
        <Select
          key="location-select"
          options={locationOptions}
          onChange={(value: string) => {
            updateWizardData({
              location: value as SettingSource,
            })
            goNext()
          }}
          onCancel={() => cancel()}
        />
      </Box>
    </WizardDialogLayout>
  )
}
