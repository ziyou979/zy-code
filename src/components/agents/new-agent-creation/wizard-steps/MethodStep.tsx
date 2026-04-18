import React from 'react';
import { Box } from '../../../../ink.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Select } from '../../../CustomSelect/select.js';
import { Byline } from '../../../design-system/Byline.js';
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
export function MethodStep() {
  const {
    goNext,
    goBack,
    updateWizardData,
    goToStep
  } = useWizard() as any;
  const methodOptions = [{
    label: "Generate with Zy (recommended)",
    value: "generate"
  }, {
    label: "Manual configuration",
    value: "manual"
  }];
  return <WizardDialogLayout subtitle="Creation method" footerText={<Byline><KeyboardShortcutHint shortcut={"\u2191\u2193"} action="navigate" /><KeyboardShortcutHint shortcut="Enter" action="select" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" /></Byline>}><Box><Select key="method-select" options={methodOptions} onChange={value => {
        const method = value as 'generate' | 'manual';
        updateWizardData({
          method,
          wasGenerated: method === "generate"
        });
        if (method === "generate") {
          goNext();
        } else {
          goToStep(3);
        }
      }} onCancel={() => goBack()} /></Box></WizardDialogLayout>;
}
