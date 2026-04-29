import React, { useState } from 'react';
import { Box, Text } from '../../../../ink.js';
import { useKeybinding } from '../../../../keybindings/useKeybinding.js';
import { editPromptInEditor } from '../../../../utils/promptEditor.js';
import { tSync } from '../../../../i18n/index.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Byline } from '../../../design-system/Byline.js';
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js';
import TextInput from '../../../TextInput.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
export function PromptStep() {
  const {
    goNext,
    goBack,
    updateWizardData,
    wizardData
  } = useWizard();
  const [systemPrompt, setSystemPrompt] = useState((wizardData.systemPrompt as any) || "");
  const [cursorOffset, setCursorOffset] = useState((systemPrompt as any).length);
  const [error, setError] = useState(null);
  useKeybinding("confirm:no", goBack, {
    context: "Settings"
  });
  const handleExternalEditor = async () => {
    const result = await editPromptInEditor(systemPrompt as any);
    if (result.content !== null) {
      setSystemPrompt(result.content);
      setCursorOffset(result.content.length);
    }
  };
  useKeybinding("chat:externalEditor", handleExternalEditor, {
    context: "Chat"
  });
  const handleSubmit = () => {
    const trimmedPrompt = (systemPrompt as any).trim();
    if (!trimmedPrompt) {
      setError(tSync('wizard.promptRequired'));
      return;
    }
    setError(null);
    updateWizardData({
      systemPrompt: trimmedPrompt as any
    });
    goNext();
  };
  return <WizardDialogLayout subtitle={tSync('wizard.systemPrompt')} footerText={<Byline><KeyboardShortcutHint shortcut="Type" action="enter text" /><KeyboardShortcutHint shortcut="Enter" action="continue" /><ConfigurableShortcutHint action="chat:externalEditor" context="Chat" fallback="ctrl+g" description="open in editor" /><ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="go back" /></Byline>}><Box flexDirection="column">{<Text>{tSync('wizard.enterSystemPrompt')}</Text>}{<Text dimColor={true}>{tSync('wizard.promptBeComprehensive')}</Text>}{<Box marginTop={1}><TextInput value={systemPrompt} onChange={setSystemPrompt} onSubmit={handleSubmit} placeholder={tSync('wizard.promptPlaceholder')} columns={80} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} focus={true} showCursor={true} /></Box>}{error && <Box marginTop={1}><Text color="error">{error}</Text></Box>}</Box></WizardDialogLayout>;
}
