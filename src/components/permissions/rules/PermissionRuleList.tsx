import chalk from 'chalk';
import figures from 'figures';
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useAppState, useSetAppState } from 'src/state/AppState.js';
import { tSync } from 'src/i18n/index.js';
import { applyPermissionUpdate, persistPermissionUpdate } from 'src/utils/permissions/PermissionUpdate.js';
import type { CommandResultDisplay } from '../../../commands.js';
import { Select } from '../../../components/CustomSelect/select.js';
import { useExitOnCtrlCDWithKeybindings } from '../../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useSearchInput } from '../../../hooks/useSearchInput.js';
import { Box, Text, useTerminalFocus } from '../../../ink.js';
import { useKeybinding } from '../../../keybindings/useKeybinding.js';
import { getAutoModeDenials } from '../../../utils/autoModeDenials.js';
import type { PermissionBehavior, PermissionRule } from '../../../utils/permissions/PermissionRule.js';
import { permissionRuleValueToString } from '../../../utils/permissions/permissionRuleParser.js';
import { deletePermissionRule, getAllowRules, getAskRules, getDenyRules, permissionRuleSourceDisplayString } from '../../../utils/permissions/permissions.js';
import { jsonStringify } from '../../../utils/slowOperations.js';
import { Pane } from '../../design-system/Pane.js';
import { Tab, Tabs, useTabHeaderFocus, useTabsWidth } from '../../design-system/Tabs.js';
import { SearchBox } from '../../SearchBox.js';
// @ts-ignore
import type { Option } from '../../ui/option.js';
import { AddPermissionRules } from './AddPermissionRules.js';
import { AddWorkspaceDirectory } from './AddWorkspaceDirectory.js';
import { PermissionRuleDescription } from './PermissionRuleDescription.js';
import { PermissionRuleInput } from './PermissionRuleInput.js';
import { RecentDenialsTab } from './RecentDenialsTab.js';
import { RemoveWorkspaceDirectory } from './RemoveWorkspaceDirectory.js';
import { WorkspaceTab } from './WorkspaceTab.js';
type TabType = 'recent' | 'allow' | 'ask' | 'deny' | 'workspace';
type RuleSourceTextProps = {
  rule: PermissionRule;
  onDelete?: () => void;
  onCancel?: () => void;
};
function RuleSourceText({
  rule
}: RuleSourceTextProps) {
  const t1 = permissionRuleSourceDisplayString(rule.source);
  return <Text dimColor={true}>{`From ${t1}`}</Text>;
}

// Helper function to get the appropriate label for rule behavior
function getRuleBehaviorLabel(ruleBehavior: PermissionBehavior): string {
  switch (ruleBehavior) {
    case 'allow':
      return 'allowed';
    case 'deny':
      return 'denied';
    case 'ask':
      return 'ask';
  }
}

// Component for showing tool details and managing the interactive deletion workflow
function RuleDetails({
  rule,
  onDelete,
  onCancel
}: RuleSourceTextProps) {
  const exitState = useExitOnCtrlCDWithKeybindings();
  useKeybinding("confirm:no", onCancel, {
    context: "Confirmation"
  });
  const t2 = permissionRuleValueToString(rule.ruleValue);
  const ruleDescription = <Box flexDirection="column" marginX={2}>{<Text bold={true}>{t2}</Text>}{<PermissionRuleDescription ruleValue={rule.ruleValue} />}{<RuleSourceText rule={rule} />}</Box>;
  const footer = <Box marginLeft={3}>{exitState.pending ? <Text dimColor={true}>Press {exitState.keyName} again to exit</Text> : <Text dimColor={true}>Esc to cancel</Text>}</Box>;
  if (rule.source === "policySettings") {
    return <>{<Box flexDirection="column" gap={1} borderStyle="round" paddingLeft={1} paddingRight={1} borderColor="permission">{<Text bold={true} color="permission">Rule details</Text>}{ruleDescription}{<Text italic={true}>This rule is configured by managed settings and cannot be modified.{"\n"}Contact your system administrator for more information.</Text>}</Box>}{footer}</>;
  }
  const t8 = getRuleBehaviorLabel(rule.ruleBehavior);
  const deleteTitle = rule.ruleBehavior === 'allow' ? tSync('permission.deleteAllowedTool') : rule.ruleBehavior === 'deny' ? tSync('permission.deleteDeniedTool') : tSync('permission.deleteAskTool');
  return <>{<Box flexDirection="column" gap={1} borderStyle="round" paddingLeft={1} paddingRight={1} borderColor="error">{<Text bold={true} color="error">{deleteTitle}</Text>}{ruleDescription}{<Text>{tSync('permission.deletePermissionRule')}</Text>}{<Select onChange={_ => _ === "yes" ? onDelete() : onCancel()} onCancel={onCancel} options={[{
        label: tSync('permission.yes'),
        value: "yes"
      }, {
        label: tSync('permission.no'),
        value: "no"
      }]} />}</Box>}{footer}</>;
}
type RulesTabContentProps = {
  options: Option[];
  searchQuery: string;
  isSearchMode: boolean;
  isFocused: boolean;
  onSelect: (value: string) => void;
  onCancel: () => void;
  lastFocusedRuleKey: string | undefined;
  cursorOffset?: number;
  onHeaderFocusChange?: (focused: boolean) => void;
  tab?: TabType;
  getRulesOptions?: any;
  handleToolSelect?: any;
};

// Component for rendering rules tab content with full width support
function RulesTabContent(props) {
  const {
    options,
    searchQuery,
    isSearchMode,
    isFocused,
    onSelect,
    onCancel,
    lastFocusedRuleKey,
    cursorOffset,
    onHeaderFocusChange
  } = props;
  const tabWidth = useTabsWidth();
  const {
    headerFocused,
    focusHeader,
    blurHeader
  } = useTabHeaderFocus();
  useEffect(() => {
    if (isSearchMode && headerFocused) {
      blurHeader();
    }
  }, [isSearchMode, headerFocused, blurHeader]);
  useEffect(() => {
    onHeaderFocusChange?.(headerFocused);
  }, [headerFocused, onHeaderFocusChange]);
  const t6 = Math.min(10, options.length);
  return <Box flexDirection="column">{<Box marginBottom={1} flexDirection="column"><SearchBox query={searchQuery} isFocused={isSearchMode && !headerFocused} isTerminalFocused={isFocused} width={tabWidth} cursorOffset={cursorOffset} /></Box>}{<Select options={options} onChange={onSelect} onCancel={onCancel} visibleOptionCount={t6} isDisabled={isSearchMode || headerFocused} defaultFocusValue={lastFocusedRuleKey} onUpFromFirstItem={focusHeader} />}</Box>;
}

// Composes the subtitle + search + Select for a single allow/ask/deny tab.
function PermissionRulesTab({
  tab: t5,
  getRulesOptions,
  handleToolSelect: t6,
  ...t7
}: RulesTabContentProps) {
  const tab = t5;
  const handleToolSelect = t6;
  const rulesProps = t7;
  const T1 = Box;
  const T0 = RulesTabContent;
  const t1 = getRulesOptions(tab, rulesProps.searchQuery);
  return <T1 flexDirection={"column"} flexShrink={tab === "allow" ? 0 : undefined}>{<Text>{{
        allow: "ZY Code won't ask before using allowed tools.",
        ask: "ZY Code will always ask for confirmation before using these tools.",
        deny: "ZY Code will always reject requests to use denied tools."
      }[tab]}</Text>}{<T0 options={t1.options} onSelect={v => handleToolSelect(v, tab)} {...rulesProps} />}</T1>;
}
type Props = {
  onExit: (result?: string, options?: {
    display?: CommandResultDisplay;
    shouldQuery?: boolean;
    metaMessages?: string[];
  }) => void;
  initialTab?: TabType;
  onRetryDenials?: (commands: string[]) => void;
};
export function PermissionRuleList({
  onExit,
  initialTab,
  onRetryDenials
}: Props) {
  const t1 = getAutoModeDenials();
  const hasDenials = t1.length > 0;
  const defaultTab = initialTab ?? (hasDenials ? "recent" : "allow");
  const [changes, setChanges] = useState([]);
  const toolPermissionContext = useAppState(s => s.toolPermissionContext);
  const setAppState = useSetAppState();
  const isTerminalFocused = useTerminalFocus();
  const denialStateRef = useRef({
    approved: new Set(),
    retry: new Set(),
    denials: []
  });
  const handleDenialStateChange = s_0 => {
    denialStateRef.current = s_0;
  };
  const [selectedRule, setSelectedRule] = useState();
  const [lastFocusedRuleKey, setLastFocusedRuleKey] = useState();
  const [addingRuleToTab, setAddingRuleToTab] = useState(null);
  const [validatedRule, setValidatedRule] = useState(null);
  const [isAddingWorkspaceDirectory, setIsAddingWorkspaceDirectory] = useState(false);
  const [removingDirectory, setRemovingDirectory] = useState(null);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [headerFocused, setHeaderFocused] = useState(true);
  const handleHeaderFocusChange = focused => {
    setHeaderFocused(focused);
  };
  const map = new Map();
  getAllowRules(toolPermissionContext).forEach(rule => {
    map.set(jsonStringify(rule), rule);
  });
  const allowRulesByKey = map;
  const map_0 = new Map();
  getDenyRules(toolPermissionContext).forEach(rule_0 => {
    map_0.set(jsonStringify(rule_0), rule_0);
  });
  const denyRulesByKey = map_0;
  const map_1 = new Map();
  getAskRules(toolPermissionContext).forEach(rule_1 => {
    map_1.set(jsonStringify(rule_1), rule_1);
  });
  const askRulesByKey = map_1;
  const getRulesOptions = (tab, t7) => {
    const query = t7 === undefined ? "" : t7;
    const rulesByKey = (() => {
      switch (tab) {
        case "allow":
          {
            return allowRulesByKey;
          }
        case "deny":
          {
            return denyRulesByKey;
          }
        case "ask":
          {
            return askRulesByKey;
          }
        case "workspace":
        case "recent":
          {
            return new Map();
          }
      }
    })();
    const options = [];
    if (tab !== "workspace" && tab !== "recent" && !query) {
      options.push({
        label: `Add a new rule${figures.ellipsis}`,
        value: "add-new-rule"
      });
    }
    const sortedRuleKeys = Array.from(rulesByKey.keys()).sort((a, b) => {
      const ruleA = rulesByKey.get(a);
      const ruleB = rulesByKey.get(b);
      if (ruleA && ruleB) {
        const ruleAString = permissionRuleValueToString(ruleA.ruleValue).toLowerCase();
        const ruleBString = permissionRuleValueToString(ruleB.ruleValue).toLowerCase();
        return ruleAString.localeCompare(ruleBString);
      }
      return 0;
    });
    const lowerQuery = query.toLowerCase();
    for (const ruleKey of sortedRuleKeys) {
      const rule_2 = rulesByKey.get(ruleKey);
      if (rule_2) {
        const ruleString = permissionRuleValueToString(rule_2.ruleValue);
        if (query && !ruleString.toLowerCase().includes(lowerQuery)) {
          continue;
        }
        options.push({
          label: ruleString,
          value: ruleKey
        });
      }
    }
    return {
      options,
      rulesByKey
    };
  };
  const exitState = useExitOnCtrlCDWithKeybindings();
  const isSearchModeActive = !selectedRule && !addingRuleToTab && !validatedRule && !isAddingWorkspaceDirectory && !removingDirectory;
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    cursorOffset: searchCursorOffset
  } = useSearchInput({
    isActive: isSearchModeActive && isSearchMode,
    onExit: () => {
      setIsSearchMode(false);
    }
  });
  const handleKeyDown = e => {
    if (!isSearchModeActive) {
      return;
    }
    if (isSearchMode) {
      return;
    }
    if (e.ctrl || e.meta) {
      return;
    }
    if (e.key === "/") {
      e.preventDefault();
      setIsSearchMode(true);
      setSearchQuery("");
    } else {
      if (e.key.length === 1 && e.key !== "j" && e.key !== "k" && e.key !== "m" && e.key !== "i" && e.key !== "r" && e.key !== " ") {
        e.preventDefault();
        setIsSearchMode(true);
        setSearchQuery(e.key);
      }
    }
  };
  const handleToolSelect = (selectedValue, tab_0) => {
    const {
      rulesByKey: rulesByKey_0
      // @ts-ignore
    } = getRulesOptions(tab_0);
    if (selectedValue === "add-new-rule") {
      setAddingRuleToTab(tab_0);
      return;
    } else {
      setSelectedRule(rulesByKey_0.get(selectedValue));
      return;
    }
  };
  const handleRuleInputCancel = () => {
    setAddingRuleToTab(null);
  };
  const handleRuleInputSubmit = (ruleValue, ruleBehavior) => {
    setValidatedRule({
      ruleValue,
      ruleBehavior
    });
    setAddingRuleToTab(null);
  };
  const handleAddRulesSuccess = (rules, unreachable) => {
    setValidatedRule(null);
    for (const rule_3 of rules) {
      setChanges(prev => [...prev, `Added ${rule_3.ruleBehavior} rule ${chalk.bold(permissionRuleValueToString(rule_3.ruleValue))}`]);
    }
    if (unreachable && unreachable.length > 0) {
      for (const u of unreachable) {
        const severity = u.shadowType === "deny" ? "blocked" : "shadowed";
        setChanges(prev_0 => [...prev_0, chalk.yellow(`${figures.warning} Warning: ${permissionRuleValueToString(u.rule.ruleValue)} is ${severity}`), chalk.dim(`  ${u.reason}`), chalk.dim(`  Fix: ${u.fix}`)]);
      }
    }
  };
  const handleAddRuleCancel = () => {
    setValidatedRule(null);
  };
  const handleRequestAddDirectory = () => setIsAddingWorkspaceDirectory(true);
  const handleRequestRemoveDirectory = path => setRemovingDirectory(path);
  const handleRulesCancel = () => {
    const s_1 = denialStateRef.current;
    const denialsFor = set => Array.from(set).map(idx => s_1.denials[idx as any]).filter(d => d !== undefined);
    const retryDenials = denialsFor(s_1.retry);
    if (retryDenials.length > 0) {
      const commands = retryDenials.map(d_0 => d_0.display);
      onRetryDenials?.(commands);
      onExit(undefined, {
        shouldQuery: true,
        metaMessages: [`Permission granted for: ${commands.join(", ")}. You may now retry ${commands.length === 1 ? "this command" : "these commands"} if you would like.`]
      });
      return;
    }
    const approvedDenials = denialsFor(s_1.approved);
    if (approvedDenials.length > 0 || changes.length > 0) {
      const approvedMsg = approvedDenials.length > 0 ? [`Approved ${approvedDenials.map(d_1 => chalk.bold(d_1.display)).join(", ")}`] : [];
      onExit([...approvedMsg, ...changes].join("\n"));
    } else {
      onExit("Permissions dialog dismissed", {
        display: "system"
      });
    }
  };
  useKeybinding("confirm:no", handleRulesCancel, {
    context: "Settings",
    isActive: isSearchModeActive && !isSearchMode
  });
  const handleDeleteRule = () => {
    if (!selectedRule) {
      return;
    }
    const {
      options: options_0
      // @ts-ignore
    } = getRulesOptions((selectedRule as any).ruleBehavior as TabType);
    const selectedKey = jsonStringify(selectedRule);
    const ruleKeys = options_0.filter(opt => opt.value !== "add-new-rule").map(opt_0 => opt_0.value);
    const currentIndex = ruleKeys.indexOf(selectedKey);
    let nextFocusKey;
    if (currentIndex !== -1) {
      if (currentIndex < ruleKeys.length - 1) {
        nextFocusKey = ruleKeys[currentIndex + 1];
      } else {
        if (currentIndex > 0) {
          nextFocusKey = ruleKeys[currentIndex - 1];
        }
      }
    }
    setLastFocusedRuleKey(nextFocusKey);
    deletePermissionRule({
      rule: selectedRule,
      initialContext: toolPermissionContext,
      setToolPermissionContext(toolPermissionContext_0) {
        setAppState(prev_1 => ({
          ...prev_1,
          toolPermissionContext: toolPermissionContext_0
        }));
      }
    });
    setChanges(prev_2 => [...prev_2, `Deleted ${(selectedRule as any).ruleBehavior} rule ${chalk.bold(permissionRuleValueToString((selectedRule as any).ruleValue))}`]);
    setSelectedRule(undefined);
  };
  if (selectedRule) {
    return <RuleDetails rule={selectedRule} onDelete={handleDeleteRule} onCancel={() => setSelectedRule(undefined)} />;
  }
  if (addingRuleToTab && addingRuleToTab !== "workspace" && addingRuleToTab !== "recent") {
    return <PermissionRuleInput onCancel={handleRuleInputCancel} onSubmit={handleRuleInputSubmit} ruleBehavior={addingRuleToTab} />;
  }
  if (validatedRule) {
    return <AddPermissionRules onAddRules={handleAddRulesSuccess} onCancel={handleAddRuleCancel} ruleValues={[validatedRule.ruleValue]} ruleBehavior={validatedRule.ruleBehavior} initialContext={toolPermissionContext} setToolPermissionContext={toolPermissionContext_1 => {
      setAppState(prev_3 => ({
        ...prev_3,
        toolPermissionContext: toolPermissionContext_1
      }));
    }} />;
  }
  if (isAddingWorkspaceDirectory) {
    return <AddWorkspaceDirectory onAddDirectory={(path_0, remember) => {
      const destination = remember ? "localSettings" : "session";
      const permissionUpdate = {
        type: "addDirectories" as const,
        directories: [path_0],
        destination
      } as any;
      const updatedContext = applyPermissionUpdate(toolPermissionContext, permissionUpdate as any);
      setAppState(prev_4 => ({
        ...prev_4,
        toolPermissionContext: updatedContext
      }));
      if (remember) {
        persistPermissionUpdate(permissionUpdate as any);
      }
      setChanges(prev_5 => [...prev_5, `Added directory ${chalk.bold(path_0)} to workspace${remember ? " and saved to local settings" : " for this session"}`]);
      setIsAddingWorkspaceDirectory(false);
    }} onCancel={() => setIsAddingWorkspaceDirectory(false)} permissionContext={toolPermissionContext} directoryPath={undefined as any} />;
  }
  if (removingDirectory) {
    return <RemoveWorkspaceDirectory directoryPath={removingDirectory} onRemove={() => {
      setChanges(prev_6 => [...prev_6, `Removed directory ${chalk.bold(removingDirectory)} from workspace`]);
      setRemovingDirectory(null);
    }} onCancel={() => setRemovingDirectory(null)} permissionContext={toolPermissionContext} setPermissionContext={toolPermissionContext_2 => {
      setAppState(prev_7 => ({
        ...prev_7,
        toolPermissionContext: toolPermissionContext_2
      }));
    }} />;
  }
  const sharedRulesProps = {
    searchQuery,
    isSearchMode,
    isFocused: isTerminalFocused,
    onCancel: handleRulesCancel,
    lastFocusedRuleKey,
    cursorOffset: searchCursorOffset,
    getRulesOptions,
    handleToolSelect,
    onHeaderFocusChange: handleHeaderFocusChange
  } as any;
  const isHidden = !!selectedRule || !!addingRuleToTab || !!validatedRule || isAddingWorkspaceDirectory || !!removingDirectory;
  return <Box flexDirection="column" onKeyDown={handleKeyDown}>{<Pane color="permission">{<Tabs title="Permissions:" color="permission" defaultTab={defaultTab} hidden={isHidden} initialHeaderFocused={!hasDenials} navFromContent={!isSearchMode}>{<Tab id="recent" title="Recently denied"><RecentDenialsTab onHeaderFocusChange={handleHeaderFocusChange} onStateChange={handleDenialStateChange} /></Tab>}{<Tab id="allow" title="Allow"><PermissionRulesTab tab="allow" {...sharedRulesProps} /></Tab>}{<Tab id="ask" title="Ask"><PermissionRulesTab tab="ask" {...sharedRulesProps} /></Tab>}{<Tab id="deny" title="Deny"><PermissionRulesTab tab="deny" {...sharedRulesProps} /></Tab>}{<Tab id="workspace" title="Workspace"><Box flexDirection="column">{<Text>ZY Code can read files in the workspace, and make edits when auto-accept edits is on.</Text>}<WorkspaceTab onExit={onExit} toolPermissionContext={toolPermissionContext} onRequestAddDirectory={handleRequestAddDirectory} onRequestRemoveDirectory={handleRequestRemoveDirectory} onHeaderFocusChange={handleHeaderFocusChange} /></Box></Tab>}</Tabs>}{<Box marginTop={1} paddingLeft={1}><Text dimColor={true}>{exitState.pending ? <>Press {exitState.keyName} again to exit</> : headerFocused ? <>←/→ tab switch · ↓ return · Esc cancel</> : isSearchMode ? <>Type to filter · Enter/↓ select · ↑ tabs · Esc clear</> : hasDenials && defaultTab === "recent" ? <>Enter approve · r retry · ↑↓ navigate · ←/→ switch · Esc cancel</> : <>↑↓ navigate · Enter select · Type to search · ←/→ switch · Esc cancel</>}</Text></Box>}</Pane>}</Box>;
}
