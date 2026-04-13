import React from 'react';
import { Box, Text } from '../../../../ink.js';
import { useKeybinding } from '../../../../keybindings/useKeybinding.js';
import { isAutoMemoryEnabled } from '../../../../memdir/paths.js';
import type { Tools } from '../../../../Tool.js';
import { getMemoryScopeDisplay } from '../../../../tools/AgentTool/agentMemory.js';
import type { AgentDefinition } from '../../../../tools/AgentTool/loadAgentsDir.js';
import { truncateToWidth } from '../../../../utils/format.js';
import { getAgentModelDisplay } from '../../../../utils/model/agent.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Byline } from '../../../design-system/Byline.js';
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import { getNewRelativeAgentFilePath } from '../../agentFileUtils.js';
import { validateAgent } from '../../validateAgent.js';
type Props = {
  tools: Tools;
  existingAgents: AgentDefinition[];
  onSave: () => void;
  onSaveAndEdit: () => void;
  error?: string | null;
};
export function ConfirmStep({
  tools,
  existingAgents,
  onSave,
  onSaveAndEdit,
  error
}: Props) {
  const {
    goBack,
    wizardData
  } = useWizard();
  useKeybinding("confirm:no", goBack, {
    context: "Confirmation"
  });
  const handleKeyDown = e => {
    if (e.key === "s" || e.key === "return") {
      e.preventDefault();
      onSave();
    } else {
      if (e.key === "e") {
        e.preventDefault();
        onSaveAndEdit();
      }
    }
  };
  const agent = wizardData.finalAgent;
  const validation = validateAgent(agent, tools, existingAgents);
  const systemPromptPreview = truncateToWidth(agent.getSystemPrompt(), 240);
  const whenToUsePreview = truncateToWidth(agent.whenToUse, 240);
  const getToolsDisplay = toolNames => {
    if (toolNames === undefined) {
      return "All tools";
    }
    if (toolNames.length === 0) {
      return "None";
    }
    if (toolNames.length === 1) {
      return toolNames[0] || "None";
    }
    if (toolNames.length === 2) {
      return toolNames.join(" and ");
    }
    return `${toolNames.slice(0, -1).join(", ")}, and ${toolNames[toolNames.length - 1]}`;
  };
  const memoryDisplayElement = isAutoMemoryEnabled() ? <Text><Text bold={true}>Memory</Text>: {getMemoryScopeDisplay(agent.memory)}</Text> : null;
  const t23 = <Text bold={true}>Name</Text>;
  const t25 = getNewRelativeAgentFilePath({
    source: wizardData.location,
    agentType: agent.agentType
  });
  const t27 = getToolsDisplay(agent.tools);
  const t29 = getAgentModelDisplay(agent.model);
  const T1 = WizardDialogLayout;
  const T0 = Box;
  const t23 = <Box marginTop={2}><Text color="success">Press {<Text bold={true}>s</Text>} or {<Text bold={true}>Enter</Text>} to save,{" "}<Text bold={true}>e</Text> to save and edit</Text></Box>;
  return <T1 subtitle={"Confirm and save"} footerText={<Byline><KeyboardShortcutHint shortcut="s/Enter" action="save" /><KeyboardShortcutHint shortcut="e" action="edit in your editor" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" /></Byline>}>{<T0 flexDirection={"column"} tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>{<Text>{t23}: {agent.agentType}</Text>}{<Text>{<Text bold={true}>Location</Text>}:{" "}{t25}</Text>}{<Text>{<Text bold={true}>Tools</Text>}: {t27}</Text>}{<Text>{<Text bold={true}>Model</Text>}: {t29}</Text>}{memoryDisplayElement}{<Box marginTop={1}><Text><Text bold={true}>Description</Text> (tells Zy when to use this agent):</Text></Box>}{<Box marginLeft={2} marginTop={1}><Text>{whenToUsePreview}</Text></Box>}{<Box marginTop={1}><Text><Text bold={true}>System prompt</Text>:</Text></Box>}{<Box marginLeft={2} marginTop={1}><Text>{systemPromptPreview}</Text></Box>}{validation.warnings.length > 0 && <Box marginTop={1} flexDirection="column"><Text color="warning">Warnings:</Text>{validation.warnings.map((warning, i) => <Text key={i} dimColor={true}>{" "}• {warning}</Text>)}</Box>}{validation.errors.length > 0 && <Box marginTop={1} flexDirection="column"><Text color="error">Errors:</Text>{validation.errors.map((err, i_0) => <Text key={i_0} color="error">{" "}• {err}</Text>)}</Box>}{error && <Box marginTop={1}><Text color="error">{error}</Text></Box>}{t23}</T0>}</T1>;
}
