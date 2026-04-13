import React, { type ReactNode } from 'react';
import { Box } from '../../../../ink.js';
import type { SettingSource } from '../../../../utils/settings/constants.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Select } from '../../../CustomSelect/select.js';
import { Byline } from '../../../design-system/Byline.js';
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import type { AgentWizardData } from '../types.js';
export function LocationStep() {
  const {
    goNext,
    updateWizardData,
    cancel
  } = useWizard();
  const locationOptions = [{
    label: "Project (.zy/agents/)",
    value: "projectSettings" as SettingSource
  }, {
    label: "Personal (~/.zy/agents/)",
    value: "userSettings" as SettingSource
  }];
  return <WizardDialogLayout subtitle="Choose location" footerText={<Byline><KeyboardShortcutHint shortcut={"\u2191\u2193"} action="navigate" /><KeyboardShortcutHint shortcut="Enter" action="select" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" /></Byline>}><Box><Select key="location-select" options={locationOptions} onChange={value => {
        updateWizardData({
          location: value as SettingSource
        });
        goNext();
      }} onCancel={() => cancel()} /></Box></WizardDialogLayout>;
}
