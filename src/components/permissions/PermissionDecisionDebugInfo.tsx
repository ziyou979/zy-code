import { feature } from 'bun:bundle';
import chalk from 'chalk';
import figures from 'figures';
import React, { useMemo } from 'react';
import { Ansi, Box, color, Text, useTheme } from '../../ink.js';
import { useAppState } from '../../state/AppState.js';
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js';
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js';
import type { PermissionDecision, PermissionDecisionReason } from '../../utils/permissions/PermissionResult.js';
import { extractRules } from '../../utils/permissions/PermissionUpdate.js';
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js';
import { permissionRuleValueToString } from '../../utils/permissions/permissionRuleParser.js';
import { detectUnreachableRules } from '../../utils/permissions/shadowedRuleDetection.js';
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js';
import { getSettingSourceDisplayNameLowercase } from '../../utils/settings/constants.js';
type PermissionDecisionInfoItemProps = {
  title?: string;
  decisionReason: PermissionDecisionReason;
};
function decisionReasonDisplayString(decisionReason: PermissionDecisionReason & {
  type: Exclude<PermissionDecisionReason['type'], 'subcommandResults'>;
}): string {
  if ((feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) && decisionReason.type === 'classifier') {
    return `${chalk.bold(decisionReason.classifier)} classifier: ${decisionReason.reason}`;
  }
  switch (decisionReason.type) {
    case 'rule':
      return `${chalk.bold(permissionRuleValueToString(decisionReason.rule.ruleValue))} rule from ${getSettingSourceDisplayNameLowercase(decisionReason.rule.source)}`;
    case 'mode':
      return `${permissionModeTitle(decisionReason.mode)} mode`;
    case 'sandboxOverride':
      return 'Requires permission to bypass sandbox';
    case 'workingDir':
      return decisionReason.reason;
    case 'safetyCheck':
    case 'other':
      return decisionReason.reason;
    case 'permissionPromptTool':
      return `${chalk.bold(decisionReason.permissionPromptToolName)} permission prompt tool`;
    case 'hook':
      return decisionReason.reason ? `${chalk.bold(decisionReason.hookName)} hook: ${decisionReason.reason}` : `${chalk.bold(decisionReason.hookName)} hook`;
    case 'asyncAgent':
      return decisionReason.reason;
    default:
      return '';
  }
}
function PermissionDecisionInfoItem({
  title,
  decisionReason
}: PermissionDecisionInfoItemProps) {
  const [theme] = useTheme();
  const formatDecisionReason = function formatDecisionReason() {
    switch (decisionReason.type) {
      case "subcommandResults":
        {
          return <Box flexDirection="column">{Array.from(decisionReason.reasons.entries()).map(t2 => {
              const [subcommand, result] = t2;
              const icon = result.behavior === "allow" ? color("success", theme)(figures.tick) : color("error", theme)(figures.cross);
              return <Box flexDirection="column" key={subcommand}><Text>{icon} {subcommand}</Text>{result.decisionReason !== undefined && result.decisionReason.type !== "subcommandResults" && <Text><Text dimColor={true}>{"  "}⎿{"  "}</Text><Ansi>{decisionReasonDisplayString(result.decisionReason)}</Ansi></Text>}{result.behavior === "ask" && <SuggestedRules suggestions={result.suggestions} />}</Box>;
            })}</Box>;
        }
      default:
        {
          return <Text><Ansi>{decisionReasonDisplayString(decisionReason)}</Ansi></Text>;
        }
    }
  };
  const t3 = formatDecisionReason();
  return <Box flexDirection="column">{title && <Text>{title}</Text>}{t3}</Box>;
}
function SuggestedRules({
  suggestions
}: PermissionDecisionInfoItemProps) {
  let T0;
  let T1;
  let t1;
  let t3;
  let t4;
  let t5;
  t5 = Symbol.for("react.early_return_sentinel");
  const rules = extractRules(suggestions);
  if (rules.length === 0) {
    t5 = null;
  } else {
    T1 = Text;
    const t2 = <Text dimColor={true}>{"  "}⎿{"  "}</Text>;
    t3 = "Suggested rules:";
    t4 = " ";
    T0 = Ansi;
    t1 = rules.map(rule => chalk.bold(permissionRuleValueToString(rule))).join(", ");
  }
  if (t5 !== Symbol.for("react.early_return_sentinel")) {
    return t5;
  }
  return <T1>{t2}{t3}{t4}{<T0>{t1}</T0>}</T1>;
}
type Props = {
  permissionResult: PermissionDecision;
  toolName?: string; // Filter unreachable rules to this tool
};

// Helper function to extract directories from permission updates
function extractDirectories(updates: PermissionUpdate[] | undefined): string[] {
  if (!updates) return [];
  return updates.flatMap(update => {
    switch (update.type) {
      case 'addDirectories':
        return update.directories;
      default:
        return [];
    }
  });
}

// Helper function to extract mode from permission updates
function extractMode(updates: PermissionUpdate[] | undefined): PermissionMode | undefined {
  if (!updates) return undefined;
  const update = updates.findLast(u => u.type === 'setMode');
  return update?.type === 'setMode' ? update.mode : undefined;
}
function SuggestionDisplay({
  suggestions,
  width
}: Props) {
  if (!suggestions || suggestions.length === 0) {
    return <Box flexDirection="row">{<Box justifyContent="flex-end" minWidth={width}>{<Text dimColor={true}>Suggestions </Text>}</Box>}{<Text>None</Text>}</Box>;
  }
  let t1;
  let t2;
  t2 = Symbol.for("react.early_return_sentinel");
  const rules = extractRules(suggestions);
  const directories = extractDirectories(suggestions);
  const mode = extractMode(suggestions);
  if (rules.length === 0 && directories.length === 0 && !mode) {
    t2 = <Box flexDirection="row">{<Box justifyContent="flex-end" minWidth={width}>{<Text dimColor={true}>Suggestion </Text>}</Box>}{<Text>None</Text>}</Box>;
  } else {
    t1 = <Box flexDirection="column">{<Box flexDirection="row">{<Box justifyContent="flex-end" minWidth={width}>{<Text dimColor={true}>Suggestions </Text>}</Box>}{<Text> </Text>}</Box>}{rules.length > 0 && <Box flexDirection="row"><Box justifyContent="flex-end" minWidth={width}><Text dimColor={true}> Rules </Text></Box><Box flexDirection="column">{rules.map((rule, index) => <Text key={index}>{figures.bullet} {permissionRuleValueToString(rule)}</Text>)}</Box></Box>}{directories.length > 0 && <Box flexDirection="row"><Box justifyContent="flex-end" minWidth={width}><Text dimColor={true}> Directories </Text></Box><Box flexDirection="column">{directories.map((dir, index_0) => <Text key={index_0}>{figures.bullet} {dir}</Text>)}</Box></Box>}{mode && <Box flexDirection="row"><Box justifyContent="flex-end" minWidth={width}><Text dimColor={true}> Mode </Text></Box><Text>{permissionModeTitle(mode)}</Text></Box>}</Box>;
  }
  if (t2 !== Symbol.for("react.early_return_sentinel")) {
    return t2;
  }
  return t1;
}
export function PermissionDecisionDebugInfo({
  permissionResult,
  toolName
}) {
  const toolPermissionContext = useAppState(s => s.toolPermissionContext);
  const decisionReason = permissionResult.decisionReason;
  const suggestions = "suggestions" in permissionResult ? permissionResult.suggestions : undefined;
  let unreachableRules;
  const sandboxAutoAllowEnabled = SandboxManager.isSandboxingEnabled() && SandboxManager.isAutoAllowBashIfSandboxedEnabled();
  const all = detectUnreachableRules(toolPermissionContext, {
    sandboxAutoAllowEnabled
  });
  const suggestedRules = extractRules(suggestions);
  if (suggestedRules.length > 0) {
    unreachableRules = all.filter(u => suggestedRules.some(suggested => suggested.toolName === u.rule.ruleValue.toolName && suggested.ruleContent === u.rule.ruleValue.ruleContent));
  } else if (toolName) {
    unreachableRules = all.filter(u_0 => u_0.rule.ruleValue.toolName === toolName);
  } else {
    unreachableRules = all;
  }
  return <Box flexDirection="column">{<Box flexDirection="row">{<Box justifyContent="flex-end" minWidth={10}><Text dimColor={true}>Behavior </Text></Box>}<Text>{permissionResult.behavior}</Text></Box>}{permissionResult.behavior !== "allow" && <Box flexDirection="row"><Box justifyContent="flex-end" minWidth={10}><Text dimColor={true}>Message </Text></Box><Text>{permissionResult.message}</Text></Box>}{<Box flexDirection="row">{<Box justifyContent="flex-end" minWidth={10}><Text dimColor={true}>Reason </Text></Box>}{decisionReason === undefined ? <Text>undefined</Text> : <PermissionDecisionInfoItem decisionReason={decisionReason} />}</Box>}{<SuggestionDisplay suggestions={suggestions} width={10} />}{unreachableRules.length > 0 && <Box flexDirection="column" marginTop={1}><Text color="warning">{figures.warning} Unreachable Rules ({unreachableRules.length})</Text>{unreachableRules.map((u_1, i) => <Box key={i} flexDirection="column" marginLeft={2}><Text color="warning">{permissionRuleValueToString(u_1.rule.ruleValue)}</Text><Text dimColor={true}>{"  "}{u_1.reason}</Text><Text dimColor={true}>{"  "}Fix: {u_1.fix}</Text></Box>)}</Box>}</Box>;
}
