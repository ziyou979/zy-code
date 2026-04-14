import chalk from 'chalk';
import * as React from 'react';
import { useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useMergedTools } from '../../hooks/useMergedTools.js';
import { Box, Text } from '../../ink.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { Tools } from '../../Tool.js';
import { resolveAgentOverrides } from '../../tools/AgentTool/agentDisplay.js';
import { getActiveAgentsFromList } from '../../tools/AgentTool/loadAgentsDir.js';
import { toError } from '../../utils/errors.js';
import { logError } from '../../utils/log.js';
import { Select } from '../CustomSelect/select.js';
import { Dialog } from '../design-system/Dialog.js';
import { AgentDetail } from './AgentDetail.js';
import { AgentEditor } from './AgentEditor.js';
import { AgentNavigationFooter } from './AgentNavigationFooter.js';
import { AgentsList } from './AgentsList.js';
import { deleteAgentFromFile } from './agentFileUtils.js';
import { CreateAgentWizard } from './new-agent-creation/CreateAgentWizard.js';
type Props = {
  tools: Tools;
  onExit: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
export function AgentsMenu({
  tools,
  onExit
}: Props) {
  const [modeState, setModeState] = useState({
    mode: "list-agents",
    source: "all"
  });
  const agentDefinitions = useAppState(s => s.agentDefinitions);
  const mcpTools = useAppState(s_0 => s_0.mcp.tools);
  const toolPermissionContext = useAppState(s_1 => s_1.toolPermissionContext);
  const setAppState = useSetAppState();
  const {
    allAgents,
    activeAgents: agents
  } = agentDefinitions;
  const [changes, setChanges] = useState([]);
  const mergedTools = useMergedTools(tools, mcpTools, toolPermissionContext);
  useExitOnCtrlCDWithKeybindings();
  const t3 = allAgents.filter(a => a.source === "built-in");
  const t4 = allAgents.filter(a_0 => a_0.source === "userSettings");
  const t5 = allAgents.filter(a_1 => a_1.source === "projectSettings");
  const t6 = allAgents.filter(a_2 => a_2.source === "policySettings");
  const t7 = allAgents.filter(a_3 => a_3.source === "localSettings");
  const t8 = allAgents.filter(a_4 => a_4.source === "flagSettings");
  const t9 = allAgents.filter(a_5 => a_5.source === "plugin");
  const agentsBySource = {
    "built-in": t3,
    userSettings: t4,
    projectSettings: t5,
    policySettings: t6,
    localSettings: t7,
    flagSettings: t8,
    plugin: t9,
    all: allAgents
  };
  const handleAgentCreated = message => {
    setChanges(prev => [...prev, message]);
    setModeState({
      mode: "list-agents",
      source: "all"
    });
  };
  const handleAgentDeleted = async agent => {
    try {
      await deleteAgentFromFile(agent);
      setAppState(state => {
        const allAgents_0 = state.agentDefinitions.allAgents.filter(a_6 => !(a_6.agentType === agent.agentType && a_6.source === agent.source));
        return {
          ...state,
          agentDefinitions: {
            ...state.agentDefinitions,
            allAgents: allAgents_0,
            activeAgents: getActiveAgentsFromList(allAgents_0)
          }
        };
      });
      setChanges(prev_0 => [...prev_0, `Deleted agent: ${chalk.bold(agent.agentType)}`]);
      setModeState({
        mode: "list-agents",
        source: "all"
      });
    } catch (error) {
      logError(toError(error));
    }
  };
  switch (modeState.mode) {
    case "list-agents":
      {
        let t13;
        t13 = modeState.source === "all" ? [...agentsBySource["built-in"], ...agentsBySource.userSettings, ...agentsBySource.projectSettings, ...agentsBySource.localSettings, ...agentsBySource.policySettings, ...agentsBySource.flagSettings, ...agentsBySource.plugin] : agentsBySource[modeState.source];
        const agentsToShow = t13;
        let t14;
        t14 = resolveAgentOverrides(agentsToShow, agents);
        const allResolved = t14;
        const resolvedAgents = allResolved;
        let t15;
        t15 = () => {
          const exitMessage = changes.length > 0 ? `Agent changes:\n${changes.join("\n")}` : undefined;
          onExit(exitMessage ?? "Agents dialog dismissed", {
            display: changes.length === 0 ? "system" : undefined
          });
        };
        let t16;
        t16 = agent_0 => setModeState({
          mode: "agent-menu",
          agent: agent_0,
          previousMode: modeState
        });
        let t17;
        t17 = () => setModeState({
          mode: "create-agent"
        });
        let t18;
        t18 = <AgentsList source={modeState.source} agents={resolvedAgents} onBack={t15} onSelect={t16} onCreateNew={t17} changes={changes} />;
        let t19;
        t19 = <AgentNavigationFooter />;
        let t20;
        t20 = <>{t18}{t19}</>;
        return t20;
      }
    case "create-agent":
      {
        let t13;
        t13 = () => setModeState({
          mode: "list-agents",
          source: "all"
        });
        let t14;
        t14 = <CreateAgentWizard tools={mergedTools} existingAgents={agents} onComplete={handleAgentCreated} onCancel={t13} />;
        return t14;
      }
    case "agent-menu":
      {
        let t13;
        let t14;
        t14 = a_9 => a_9.agentType === modeState.agent.agentType && a_9.source === modeState.agent.source;
        t13 = allAgents.find(t14);
        const freshAgent_1 = t13;
        const agentToUse = freshAgent_1 || modeState.agent;
        const isEditable = agentToUse.source !== "built-in" && agentToUse.source !== "plugin" && agentToUse.source !== "flagSettings";
        let t14;
        t14 = {
          label: "View agent",
          value: "view"
        };
        let t15;
        t15 = isEditable ? [{
          label: "Edit agent",
          value: "edit"
        }, {
          label: "Delete agent",
          value: "delete"
        }] : [];
        let t16;
        t16 = {
          label: "Back",
          value: "back"
        };
        let t17;
        t17 = [t14, ...t15, t16];
        const menuItems = t17;
        let t18;
        t18 = value_0 => {
          switch (value_0) {
            case "view":
              {
                setModeState({
                  mode: "view-agent",
                  agent: agentToUse,
                  previousMode: modeState.previousMode
                });
                break;
              }
            case "edit":
              {
                setModeState({
                  mode: "edit-agent",
                  agent: agentToUse,
                  previousMode: modeState
                });
                break;
              }
            case "delete":
              {
                setModeState({
                  mode: "delete-confirm",
                  agent: agentToUse,
                  previousMode: modeState
                });
                break;
              }
            case "back":
              {
                setModeState(modeState.previousMode);
              }
          }
        };
        const handleMenuSelect = t18;
        let t19;
        t19 = () => setModeState(modeState.previousMode);
        let t20;
        t20 = () => setModeState(modeState.previousMode);
        let t21;
        t21 = <Select options={menuItems} onChange={handleMenuSelect} onCancel={t20} />;
        let t22;
        t22 = changes.length > 0 && <Box marginTop={1}><Text dimColor={true}>{changes[changes.length - 1]}</Text></Box>;
        let t23;
        t23 = <Box flexDirection="column">{t21}{t22}</Box>;
        let t24;
        t24 = <Dialog title={modeState.agent.agentType} onCancel={t19} hideInputGuide={true}>{t23}</Dialog>;
        let t25;
        t25 = <AgentNavigationFooter />;
        let t26;
        t26 = <>{t24}{t25}</>;
        return t26;
      }
    case "view-agent":
      {
        let t13;
        let t14;
        t14 = a_8 => a_8.agentType === modeState.agent.agentType && a_8.source === modeState.agent.source;
        t13 = allAgents.find(t14);
        const freshAgent_0 = t13;
        const agentToDisplay = freshAgent_0 || modeState.agent;
        let t14;
        t14 = () => setModeState({
          mode: "agent-menu",
          agent: agentToDisplay,
          previousMode: modeState.previousMode
        });
        let t15;
        t15 = () => setModeState({
          mode: "agent-menu",
          agent: agentToDisplay,
          previousMode: modeState.previousMode
        });
        let t16;
        t16 = <AgentDetail agent={agentToDisplay} tools={mergedTools} allAgents={allAgents} onBack={t15} />;
        let t17;
        t17 = <Dialog title={agentToDisplay.agentType} onCancel={t14} hideInputGuide={true}>{t16}</Dialog>;
        let t18;
        t18 = <AgentNavigationFooter instructions="Press Enter or Esc to go back" />;
        let t19;
        t19 = <>{t17}{t18}</>;
        return t19;
      }
    case "delete-confirm":
      {
        let t13;
        t13 = [{
          label: "Yes, delete",
          value: "yes"
        }, {
          label: "No, cancel",
          value: "no"
        }];
        const deleteOptions = t13;
        let t14;
        t14 = () => {
          if ("previousMode" in modeState) {
            setModeState(modeState.previousMode);
          }
        };
        let t15;
        t15 = <Text>Are you sure you want to delete the agent{" "}<Text bold={true}>{modeState.agent.agentType}</Text>?</Text>;
        let t16;
        t16 = <Box marginTop={1}><Text dimColor={true}>Source: {modeState.agent.source}</Text></Box>;
        let t17;
        t17 = value => {
          if (value === "yes") {
            handleAgentDeleted(modeState.agent);
          } else {
            if ("previousMode" in modeState) {
              setModeState(modeState.previousMode);
            }
          }
        };
        let t18;
        t18 = () => {
          if ("previousMode" in modeState) {
            setModeState(modeState.previousMode);
          }
        };
        let t19;
        t19 = <Box marginTop={1}><Select options={deleteOptions} onChange={t17} onCancel={t18} /></Box>;
        let t20;
        t20 = <Dialog title="Delete agent" onCancel={t14} color="error">{t15}{t16}{t19}</Dialog>;
        let t21;
        t21 = <AgentNavigationFooter instructions={"Press \u2191\u2193 to navigate, Enter to select, Esc to cancel"} />;
        let t22;
        t22 = <>{t20}{t21}</>;
        return t22;
      }
    case "edit-agent":
      {
        let t13;
        let t14;
        t14 = a_7 => a_7.agentType === modeState.agent.agentType && a_7.source === modeState.agent.source;
        t13 = allAgents.find(t14);
        const freshAgent = t13;
        const agentToEdit = freshAgent || modeState.agent;
        const t15 = `Edit agent: ${agentToEdit.agentType}`;
        let t15;
        t15 = () => setModeState(modeState.previousMode);
        let t16;
        let t17;
        t16 = message_0 => {
          handleAgentCreated(message_0);
          setModeState(modeState.previousMode);
        };
        t17 = () => setModeState(modeState.previousMode);
        let t18;
        t18 = <AgentEditor agent={agentToEdit} tools={mergedTools} onSaved={t16} onBack={t17} />;
        let t19;
        t19 = <Dialog title={t14} onCancel={t15} hideInputGuide={true}>{t18}</Dialog>;
        let t20;
        t20 = <AgentNavigationFooter />;
        let t21;
        t21 = <>{t19}{t20}</>;
        return t21;
      }
    default:
      {
        return null;
      }
  }
}
