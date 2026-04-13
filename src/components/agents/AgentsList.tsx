import figures from 'figures';
import * as React from 'react';
import type { SettingSource } from 'src/utils/settings/constants.js';
import { Box, Text } from '../../ink.js';
import type { ResolvedAgent } from '../../tools/AgentTool/agentDisplay.js';
import { AGENT_SOURCE_GROUPS, compareAgentsByName, getOverrideSourceLabel, resolveAgentModelDisplay } from '../../tools/AgentTool/agentDisplay.js';
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js';
import { count } from '../../utils/array.js';
import { Dialog } from '../design-system/Dialog.js';
import { Divider } from '../design-system/Divider.js';
import { getAgentSourceDisplayName } from './utils.js';
type Props = {
  source: SettingSource | 'all' | 'built-in' | 'plugin';
  agents: ResolvedAgent[];
  onBack: () => void;
  onSelect: (agent: AgentDefinition) => void;
  onCreateNew?: () => void;
  changes?: string[];
};
export function AgentsList({
  source,
  agents,
  onBack,
  onSelect,
  onCreateNew,
  changes
}: Props) {
  const [selectedAgent, setSelectedAgent] = React.useState(null);
  const [isCreateNewSelected, setIsCreateNewSelected] = React.useState(true);
  const sortedAgents = [...agents].sort(compareAgentsByName);
  const getOverrideInfo = agent => ({
    isOverridden: !!agent.overriddenBy,
    overriddenBy: agent.overriddenBy || null
  });
  const renderCreateNewOption = () => <Box><Text color={isCreateNewSelected ? "suggestion" : undefined}>{isCreateNewSelected ? `${figures.pointer} ` : "  "}</Text><Text color={isCreateNewSelected ? "suggestion" : undefined}>Create new agent</Text></Box>;
  const renderAgent = agent_0 => {
    const isBuiltIn = agent_0.source === "built-in";
    const isSelected = !isBuiltIn && !isCreateNewSelected && selectedAgent?.agentType === agent_0.agentType && selectedAgent?.source === agent_0.source;
    const {
      isOverridden,
      overriddenBy
    } = getOverrideInfo(agent_0);
    const dimmed = isBuiltIn || isOverridden;
    const textColor = !isBuiltIn && isSelected ? "suggestion" : undefined;
    const resolvedModel = resolveAgentModelDisplay(agent_0);
    return <Box key={`${agent_0.agentType}-${agent_0.source}`}><Text dimColor={dimmed && !isSelected} color={textColor}>{isBuiltIn ? "" : isSelected ? `${figures.pointer} ` : "  "}</Text><Text dimColor={dimmed && !isSelected} color={textColor}>{agent_0.agentType}</Text>{resolvedModel && <Text dimColor={true} color={textColor}>{" \xB7 "}{resolvedModel}</Text>}{agent_0.memory && <Text dimColor={true} color={textColor}>{" \xB7 "}{agent_0.memory} memory</Text>}{overriddenBy && <Text dimColor={!isSelected} color={isSelected ? "warning" : undefined}>{" "}{figures.warning} shadowed by {getOverrideSourceLabel(overriddenBy)}</Text>}</Box>;
  };
  let selectableAgentsInOrder;
  const nonBuiltIn = sortedAgents.filter(a => a.source !== "built-in");
  if (source === "all") {
    selectableAgentsInOrder = AGENT_SOURCE_GROUPS.filter(g => g.source !== "built-in").flatMap(t5 => {
      const {
        source: groupSource
      } = t5;
      return nonBuiltIn.filter(a_0 => a_0.source === groupSource);
    });
  } else {
    selectableAgentsInOrder = nonBuiltIn;
  }
  React.useEffect(() => {
    if (!selectedAgent && !isCreateNewSelected && selectableAgentsInOrder.length > 0) {
      if (onCreateNew) {
        setIsCreateNewSelected(true);
      } else {
        setSelectedAgent(selectableAgentsInOrder[0] || null);
      }
    }
  }, [selectableAgentsInOrder, selectedAgent, isCreateNewSelected, onCreateNew]);
  const handleKeyDown = e => {
    if (e.key === "return") {
      e.preventDefault();
      if (isCreateNewSelected && onCreateNew) {
        onCreateNew();
      } else {
        if (selectedAgent) {
          onSelect(selectedAgent);
        }
      }
      return;
    }
    if (e.key !== "up" && e.key !== "down") {
      return;
    }
    e.preventDefault();
    const hasCreateOption = !!onCreateNew;
    const totalItems = selectableAgentsInOrder.length + (hasCreateOption ? 1 : 0);
    if (totalItems === 0) {
      return;
    }
    let currentPosition = 0;
    if (!isCreateNewSelected && selectedAgent) {
      const agentIndex = selectableAgentsInOrder.findIndex(a_1 => a_1.agentType === selectedAgent.agentType && a_1.source === selectedAgent.source);
      if (agentIndex >= 0) {
        currentPosition = hasCreateOption ? agentIndex + 1 : agentIndex;
      }
    }
    const newPosition = e.key === "up" ? currentPosition === 0 ? totalItems - 1 : currentPosition - 1 : currentPosition === totalItems - 1 ? 0 : currentPosition + 1;
    if (hasCreateOption && newPosition === 0) {
      setIsCreateNewSelected(true);
      setSelectedAgent(null);
    } else {
      const agentIndex_0 = hasCreateOption ? newPosition - 1 : newPosition;
      const newAgent = selectableAgentsInOrder[agentIndex_0];
      if (newAgent) {
        setIsCreateNewSelected(false);
        setSelectedAgent(newAgent);
      }
    }
  };
  const renderBuiltInAgentsSection = t9 => {
    const title = t9 === undefined ? "Built-in (always available):" : t9;
    const builtInAgents = sortedAgents.filter(a_2 => a_2.source === "built-in");
    return <Box flexDirection="column" marginBottom={1} paddingLeft={2}><Text bold={true} dimColor={true}>{title}</Text>{builtInAgents.map(renderAgent)}</Box>;
  };
  const renderAgentGroup = (title_0, groupAgents) => {
    if (!groupAgents.length) {
      return null;
    }
    const folderPath = groupAgents[0]?.baseDir;
    return <Box flexDirection="column" marginBottom={1}><Box paddingLeft={2}><Text bold={true} dimColor={true}>{title_0}</Text>{folderPath && <Text dimColor={true}> ({folderPath})</Text>}</Box>{groupAgents.map(agent_1 => renderAgent(agent_1))}</Box>;
  };
  const sourceTitle = getAgentSourceDisplayName(source);
  let T0;
  let T1;
  let t11;
  let t12;
  let t13;
  let t14;
  let t16;
  let t17;
  let t18;
  let t19;
  let t20;
  let t22;
  t22 = Symbol.for("react.early_return_sentinel");
  const builtInAgents_0 = sortedAgents.filter(a_3 => a_3.source === "built-in");
  const hasNoAgents = !sortedAgents.length || source !== "built-in" && !sortedAgents.some(a_4 => a_4.source !== "built-in");
  if (hasNoAgents) {
    const t27 = source !== "built-in" && sortedAgents.some(a_5 => a_5.source === "built-in") && <><Divider />{renderBuiltInAgentsSection()}</>;
    t22 = <Dialog title={sourceTitle} subtitle="No agents found" onCancel={onBack} hideInputGuide={true}>{<Box flexDirection="column" gap={1} tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>{onCreateNew && <Box>{renderCreateNewOption()}</Box>}{<Text dimColor={true}>No agents found. Create specialized subagents that Zy can delegate to.</Text>}{<Text dimColor={true}>Each subagent has its own context window, custom system prompt, and specific tools.</Text>}{<Text dimColor={true}>Try creating: Code Reviewer, Code Simplifier, Security Reviewer, Tech Lead, or UX Reviewer.</Text>}{t27}</Box>}</Dialog>;
  } else {
    T1 = Dialog;
    t17 = sourceTitle;
    const t23 = count(sortedAgents, a_6 => !a_6.overriddenBy);
    t18 = `${t23} agents`;
    t19 = onBack;
    t20 = true;
    const t21 = changes && changes.length > 0 && <Box marginTop={1}><Text dimColor={true}>{changes[changes.length - 1]}</Text></Box>;
    T0 = Box;
    t11 = "column";
    t12 = 0;
    t13 = true;
    t14 = handleKeyDown;
    const t15 = onCreateNew && <Box marginBottom={1}>{renderCreateNewOption()}</Box>;
    t16 = source === "all" ? <>{AGENT_SOURCE_GROUPS.filter(g_0 => g_0.source !== "built-in").map(t24 => {
        const {
          label,
          source: groupSource_0
        } = t24;
        return <React.Fragment key={groupSource_0}>{renderAgentGroup(label, sortedAgents.filter(a_7 => a_7.source === groupSource_0))}</React.Fragment>;
      })}{builtInAgents_0.length > 0 && <Box flexDirection="column" marginBottom={1} paddingLeft={2}><Text dimColor={true}><Text bold={true}>Built-in agents</Text> (always available)</Text>{builtInAgents_0.map(renderAgent)}</Box>}</> : source === "built-in" ? <><Text dimColor={true} italic={true}>Built-in agents are provided by default and cannot be modified.</Text><Box marginTop={1} flexDirection="column">{sortedAgents.map(agent_2 => renderAgent(agent_2))}</Box></> : <>{sortedAgents.filter(a_8 => a_8.source !== "built-in").map(agent_3 => renderAgent(agent_3))}{sortedAgents.some(a_9 => a_9.source === "built-in") && <><Divider />{renderBuiltInAgentsSection()}</>}</>;
  }
  if (t22 !== Symbol.for("react.early_return_sentinel")) {
    return t22;
  }
  return <T1 title={t17} subtitle={t18} onCancel={t19} hideInputGuide={t20}>{t21}{<T0 flexDirection={t11} tabIndex={t12} autoFocus={t13} onKeyDown={t14}>{t15}{t16}</T0>}</T1>;
}
