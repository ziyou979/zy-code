import { feature } from 'bun:bundle';
import chalk from 'chalk';
import figures from 'figures';
import React from 'react';
import { tSync } from 'src/i18n/index.js';
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
      return tSync('permissionDebug.requiresBypassSandbox');
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
          return <Box flexDirection="column">{Array.from(decisionReason.reasons.entries()).map((t2) => {
              const [subcommand, result] = t2;
              const icon = result.behavior === "allow" ? color("success", theme)(figures.tick) : color("error", theme)(figures.cross);
              return <Box flexDirection="column" key={subcommand}><Text>{icon} {subcommand}</Text>{result.decisionReason !== undefined && result.decisionReason.type !== "subcommandResults" && <Text><Text dimColor={true}>{"  "}⎿{"  "}</Text><Ansi>{decisionReasonDisplayString(result.decisionReason)}</Ansi></Text>}{result.behavior === "ask" && <SuggestedRules suggestions={(result as any).suggestions} />}</Box>;
            })}</Box>;
        }
      default:
        {
          return <Text><Ansi>{decisionReasonDisplayString(decisionReason)}</Ansi></Text>;
        }
    }
  };
  const formatDecisionReasonResult = formatDecisionReason();
  return <Box flexDirection="column">{title && <Text>{title}</Text>}{formatDecisionReasonResult}</Box>;
}
function SuggestedRules({
  suggestions
}: any) {
  let AnsiComponent;
  let TextComponent;
  let joinedString;


  let earlyReturn;
  earlyReturn = Symbol.for("react.early_return_sentinel");
  const rules = extractRules(suggestions);
  if (rules.length === 0) {
    earlyReturn = null;
  } else {
    TextComponent = Text;
    const textElement = <Text dimColor={true}>{"  "}⎿{"  "}</Text>;

    AnsiComponent = Ansi;
    joinedString = rules.map((rule) => chalk.bold(permissionRuleValueToString(rule))).join(", ");
    if (earlyReturn !== Symbol.for("react.early_return_sentinel")) {
      return earlyReturn;
    }
    return <TextComponent>{textElement}{tSync('permissionDebug.suggestedRules')}{" "}{<AnsiComponent>{joinedString}</AnsiComponent>}</TextComponent>;
  }
  if (earlyReturn !== Symbol.for("react.early_return_sentinel")) {
    return earlyReturn;
  }
  return null;
}
type Props = {
  permissionResult: PermissionDecision;
  toolName?: string; // Filter unreachable rules to this tool
  suggestions?: any;
  width?: number;
};

// Helper function to extract directories from permission updates
function extractDirectories(updates: PermissionUpdate[] | undefined): string[] {
  if (!updates) return [];
  return updates.flatMap((update) => {
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
  const update = updates.findLast((u) => u.type === 'setMode');
  return update?.type === 'setMode' ? update.mode : undefined;
}
function SuggestionDisplay({
  suggestions,
  width
}: Props) {
  if (!suggestions || suggestions.length === 0) {
    return <Box flexDirection="row">{<Box justifyContent="flex-end" minWidth={width}>{<Text dimColor={true}>{tSync('permissionDebug.suggestions')} </Text>}</Box>}{<Text>{tSync('permissionDebug.none')}</Text>}</Box>;
  }
  let boxElement;
  let earlyReturn;
  earlyReturn = Symbol.for("react.early_return_sentinel");
  const rules = extractRules(suggestions);
  const directories = extractDirectories(suggestions);
  const mode = extractMode(suggestions);
  if (rules.length === 0 && directories.length === 0 && !mode) {
    earlyReturn = <Box flexDirection="row">{<Box justifyContent="flex-end" minWidth={width}>{<Text dimColor={true}>{tSync('permissionDebug.suggestion')} </Text>}</Box>}{<Text>{tSync('permissionDebug.none')}</Text>}</Box>;
  } else {
    boxElement = <Box flexDirection="column">{<Box flexDirection="row">{<Box justifyContent="flex-end" minWidth={width}>{<Text dimColor={true}>{tSync('permissionDebug.suggestions')} </Text>}</Box>}{<Text> </Text>}</Box>}{rules.length > 0 && <Box flexDirection="row"><Box justifyContent="flex-end" minWidth={width}><Text dimColor={true}> {tSync('permissionDebug.rules')} </Text></Box><Box flexDirection="column">{rules.map((rule, index) => <Text key={index}>{figures.bullet} {permissionRuleValueToString(rule)}</Text>)}</Box></Box>}{directories.length > 0 && <Box flexDirection="row"><Box justifyContent="flex-end" minWidth={width}><Text dimColor={true}> {tSync('permissionDebug.directories')} </Text></Box><Box flexDirection="column">{directories.map((dir, index_0) => <Text key={index_0}>{figures.bullet} {dir}</Text>)}</Box></Box>}{mode && <Box flexDirection="row"><Box justifyContent="flex-end" minWidth={width}><Text dimColor={true}> {tSync('permissionDebug.mode')} </Text></Box><Text>{permissionModeTitle(mode)}</Text></Box>}</Box>;
  }
  if (earlyReturn !== Symbol.for("react.early_return_sentinel")) {
    return earlyReturn;
  }
  return boxElement;
}
export function PermissionDecisionDebugInfo({
  permissionResult,
  toolName
}) {
  const toolPermissionContext = useAppState((s) => s.toolPermissionContext);
  const decisionReason = permissionResult.decisionReason;
  const suggestions = "suggestions" in permissionResult ? permissionResult.suggestions : undefined;
  let unreachableRules;
  const sandboxAutoAllowEnabled = SandboxManager.isSandboxingEnabled() && SandboxManager.isAutoAllowBashIfSandboxedEnabled();
  const all = detectUnreachableRules(toolPermissionContext, {
    sandboxAutoAllowEnabled
  });
  const suggestedRules = extractRules(suggestions);
  if (suggestedRules.length > 0) {
    unreachableRules = all.filter((u) => suggestedRules.some((suggested) => suggested.toolName === u.rule.ruleValue.toolName && suggested.ruleContent === u.rule.ruleValue.ruleContent));
  } else if (toolName) {
    unreachableRules = all.filter((u_0) => u_0.rule.ruleValue.toolName === toolName);
  } else {
    unreachableRules = all;
  }
  return <Box flexDirection="column">{<Box flexDirection="row">{<Box justifyContent="flex-end" minWidth={10}><Text dimColor={true}>{tSync('permissionDebug.behavior')} </Text></Box>}<Text>{(permissionResult as any).behavior}</Text></Box>}{(permissionResult as any).behavior !== "allow" && <Box flexDirection="row"><Box justifyContent="flex-end" minWidth={10}><Text dimColor={true}>{tSync('permissionDebug.message')} </Text></Box><Text>{(permissionResult as any).message}</Text></Box>}{<Box flexDirection="row">{<Box justifyContent="flex-end" minWidth={10}><Text dimColor={true}>{tSync('permissionDebug.reason')} </Text></Box>}{decisionReason === undefined ? <Text>undefined</Text> : <PermissionDecisionInfoItem decisionReason={decisionReason} />}</Box>}{<SuggestionDisplay suggestions={suggestions as any} width={10} permissionResult={permissionResult as any} />}{unreachableRules.length > 0 && <Box flexDirection="column" marginTop={1}><Text color="warning">{figures.warning} {tSync('permissionDebug.unreachableRules', { count: unreachableRules.length })}</Text>{unreachableRules.map((u_1, i) => <Box key={i} flexDirection="column" marginLeft={2}><Text color="warning">{permissionRuleValueToString(u_1.rule.ruleValue)}</Text><Text dimColor={true}>{"  "}{u_1.reason}</Text><Text dimColor={true}>{"  "}{tSync('permissionDebug.fix')}{u_1.fix}</Text></Box>)}</Box>}</Box>;
}