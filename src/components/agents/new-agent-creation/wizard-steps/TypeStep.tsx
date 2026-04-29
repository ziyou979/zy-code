import React, { useState } from 'react';
import { Box, Text } from '../../../../ink.js';
import { useKeybinding } from '../../../../keybindings/useKeybinding.js';
import type { AgentDefinition } from '../../../../tools/AgentTool/loadAgentsDir.js';
import { tSync } from '../../../../i18n/index.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Byline } from '../../../design-system/Byline.js';
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js';
import TextInput from '../../../TextInput.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import { validateAgentType } from '../../validateAgent.js';
type Props = {
  existingAgents: AgentDefinition[];
};
export function TypeStep(_props) {
  const {
    goNext,
    goBack,
    updateWizardData,
    wizardData
  } = useWizard();
  const [agentType, setAgentType] = useState((wizardData.agentType as any) || "");
  const [error, setError] = useState(null);
  const [cursorOffset, setCursorOffset] = useState((agentType as any).length);
  useKeybinding("confirm:no", goBack, {
    context: "Settings"
  });
  const handleSubmit = value => {
    const trimmedValue = value.trim();
    const validationError = validateAgentType(trimmedValue);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    updateWizardData({
      agentType: trimmedValue
    });
    goNext();
  };
  return <WizardDialogLayout subtitle={tSync('wizard.agentType')} footerText={<Byline><KeyboardShortcutHint shortcut="Type" action="enter text" /><KeyboardShortcutHint shortcut="Enter" action="continue" /><ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="go back" /></Byline>}><Box flexDirection="column">{<Text>{tSync('wizard.enterIdentifier')}</Text>}{<Box marginTop={1}><TextInput value={agentType} onChange={setAgentType} onSubmit={handleSubmit} placeholder={tSync('wizard.agentTypePlaceholder')} columns={60} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} focus={true} showCursor={true} /></Box>}{error && <Box marginTop={1}><Text color="error">{error}</Text></Box>}</Box></WizardDialogLayout>;
}
