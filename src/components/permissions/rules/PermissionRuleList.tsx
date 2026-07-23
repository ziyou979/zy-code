import chalk from 'chalk'
import { useEffect, useRef, useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import { useAppState, useSetAppState } from 'src/state/AppState.js'
import {
  applyPermissionUpdate,
  persistPermissionUpdate,
} from 'src/services/permissions/permissionUpdate.js'
import type { CommandResultDisplay } from '../../../commands/index.js'
import { Select } from '../../CustomSelect/select.js'
import { WARNING } from '../../../constants/figures.js'
import { useExitOnCtrlCDWithKeybindings } from '../../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useSearchInput } from '../../../hooks/useSearchInput.js'
import { Box, Text, useTerminalFocus } from '../../../ink/index.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { getAutoModeDenials } from '../../../services/hooks/autoModeDenials.js'
import type {
  PermissionBehavior,
  PermissionRule,
} from '../../../services/permissions/permissionRule.js'
import { permissionRuleValueToString } from '../../../services/permissions/permissionRuleParser.js'
import { deletePermissionRule } from '../../../services/permissions/permissionRuleRepository.js'
import {
  getAllowRules,
  getAskRules,
  getDenyRules,
  permissionRuleSourceDisplayString,
} from '../../../services/permissions/permissionRuleQueries.js'
import { jsonStringify } from '../../../services/infra/slowOperations.js'
import { Pane } from '../../design-system/Pane.js'
import { Tab, Tabs, useTabHeaderFocus, useTabsWidth } from '../../design-system/Tabs.js'
import { SearchBox } from '../../SearchBox.js'
// @ts-expect-error
import type { Option } from '../../ui/option.js'
import { AddPermissionRules } from './AddPermissionRules.js'
import { AddWorkspaceDirectory } from './AddWorkspaceDirectory.js'
import { PermissionRuleDescription } from './PermissionRuleDescription.js'
import { PermissionRuleInput } from './PermissionRuleInput.js'
import { RecentDenialsTab } from './RecentDenialsTab.js'
import { RemoveWorkspaceDirectory } from './RemoveWorkspaceDirectory.js'
import { WorkspaceTab } from './WorkspaceTab.js'

type TabType = 'recent' | 'allow' | 'ask' | 'deny' | 'workspace'
type RuleSourceTextProps = {
  rule: PermissionRule
  onDelete?: () => void
  onCancel?: () => void
}
function RuleSourceText({ rule }: RuleSourceTextProps) {
  const sourceDisplay = permissionRuleSourceDisplayString(rule.source)
  return (
    <Text dimColor={true}>{tSync('permissionRules.fromSource', { source: sourceDisplay })}</Text>
  )
}

// Helper function to get the appropriate label for rule behavior
function getRuleBehaviorLabel(ruleBehavior: PermissionBehavior): string {
  switch (ruleBehavior) {
    case 'allow':
      return 'allowed'
    case 'deny':
      return 'denied'
    case 'ask':
      return 'ask'
  }
}

// Component for showing tool details and managing the interactive deletion workflow
function RuleDetails({ rule, onDelete, onCancel }: RuleSourceTextProps) {
  const exitState = useExitOnCtrlCDWithKeybindings()
  useKeybinding('confirm:no', onCancel ?? (() => {}), {
    context: 'Confirmation',
  })
  const ruleValueString = permissionRuleValueToString(rule.ruleValue)
  const ruleDescription = (
    <Box flexDirection="column" marginX={2}>
      {<Text bold={true}>{ruleValueString}</Text>}
      {<PermissionRuleDescription ruleValue={rule.ruleValue} />}
      {<RuleSourceText rule={rule} />}
    </Box>
  )
  const footer = (
    <Box marginLeft={3}>
      {exitState.pending ? (
        <Text dimColor={true}>Press {exitState.keyName} again to exit</Text>
      ) : (
        <Text dimColor={true}>Esc to cancel</Text>
      )}
    </Box>
  )
  if (rule.source === 'policySettings') {
    return (
      <>
        {
          <Box
            flexDirection="column"
            gap={1}
            borderStyle="round"
            paddingLeft={1}
            paddingRight={1}
            borderColor="permission"
          >
            {
              <Text bold={true} color="permission">
                {tSync('permissionRules.ruleDetails')}
              </Text>
            }
            {ruleDescription}
            {<Text italic={true}>{tSync('permissionRules.managedByPolicy')}</Text>}
          </Box>
        }
        {footer}
      </>
    )
  }
  const _behaviorLabel = getRuleBehaviorLabel(rule.ruleBehavior)
  const deleteTitle =
    rule.ruleBehavior === 'allow'
      ? tSync('permission.deleteAllowedTool')
      : rule.ruleBehavior === 'deny'
        ? tSync('permission.deleteDeniedTool')
        : tSync('permission.deleteAskTool')
  return (
    <>
      {
        <Box
          flexDirection="column"
          gap={1}
          borderStyle="round"
          paddingLeft={1}
          paddingRight={1}
          borderColor="error"
        >
          {
            <Text bold={true} color="error">
              {deleteTitle}
            </Text>
          }
          {ruleDescription}
          {<Text>{tSync('permission.deletePermissionRule')}</Text>}
          {
            <Select
              onChange={(_: string) => (_ === 'yes' ? onDelete?.() : onCancel?.())}
              onCancel={onCancel}
              options={[
                {
                  label: tSync('permission.yes'),
                  value: 'yes',
                },
                {
                  label: tSync('permission.no'),
                  value: 'no',
                },
              ]}
            />
          }
        </Box>
      }
      {footer}
    </>
  )
}
type RulesTabContentProps = {
  options: Option[]
  searchQuery: string
  isSearchMode: boolean
  isFocused: boolean
  onSelect: (value: string) => void
  onCancel: () => void
  lastFocusedRuleKey: string | undefined
  cursorOffset?: number
  onHeaderFocusChange?: (focused: boolean) => void
  tab?: TabType
  // biome-ignore lint/suspicious/noExplicitAny: 权限系统动态类型处理
  getRulesOptions?: (
    tab: TabType,
    query?: string,
  ) => { options: Option[]; rulesByKey: Map<string, PermissionRule> }
  // biome-ignore lint/suspicious/noExplicitAny: 权限系统动态类型处理
  handleToolSelect?: (value: string, tab: TabType) => void
}

// Component for rendering rules tab content with full width support
function RulesTabContent(props: RulesTabContentProps) {
  const {
    options,
    searchQuery,
    isSearchMode,
    isFocused,
    onSelect,
    onCancel,
    lastFocusedRuleKey,
    cursorOffset,
    onHeaderFocusChange,
  } = props
  const tabWidth = useTabsWidth()
  const { headerFocused, focusHeader, blurHeader } = useTabHeaderFocus()
  useEffect(() => {
    if (isSearchMode && headerFocused) {
      blurHeader()
    }
  }, [isSearchMode, headerFocused, blurHeader])
  useEffect(() => {
    onHeaderFocusChange?.(headerFocused)
  }, [headerFocused, onHeaderFocusChange])
  const visibleOptionCount = Math.min(10, options.length)
  return (
    <Box flexDirection="column">
      {
        <Box marginBottom={1} flexDirection="column">
          <SearchBox
            query={searchQuery}
            isFocused={isSearchMode && !headerFocused}
            isTerminalFocused={isFocused}
            width={tabWidth}
            cursorOffset={cursorOffset}
          />
        </Box>
      }
      {
        <Select
          options={options}
          onChange={onSelect}
          onCancel={onCancel}
          visibleOptionCount={visibleOptionCount}
          isDisabled={isSearchMode || headerFocused}
          defaultFocusValue={lastFocusedRuleKey}
          onUpFromFirstItem={focusHeader}
        />
      }
    </Box>
  )
}

// Composes the subtitle + search + Select for a single allow/ask/deny tab.
function PermissionRulesTab({
  tab,
  getRulesOptions,
  handleToolSelect,
  ...rulesProps
}: RulesTabContentProps) {
  const TabContainer = Box
  const TabContentComponent = RulesTabContent
  const rulesOptions = getRulesOptions!(tab!, rulesProps.searchQuery)
  return (
    <TabContainer flexDirection={'column'} flexShrink={tab === 'allow' ? 0 : undefined}>
      {
        <Text>
          {
            (
              {
                allow: tSync('permissionRules.allowedToolsSubtitle'),
                ask: tSync('permissionRules.askToolsSubtitle'),
                deny: tSync('permissionRules.deniedToolsSubtitle'),
              } as Record<string, string>
            )[tab!]
          }
        </Text>
      }
      {
        <TabContentComponent
          {...rulesProps}
          options={rulesOptions.options}
          onSelect={(v: string) => handleToolSelect?.(v, tab!)}
        />
      }
    </TabContainer>
  )
}
type Props = {
  onExit: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
      shouldQuery?: boolean
      metaMessages?: string[]
    },
  ) => void
  initialTab?: TabType
  onRetryDenials?: (commands: string[]) => void
}
export function PermissionRuleList({ onExit, initialTab, onRetryDenials }: Props) {
  const autoModeDenials = getAutoModeDenials()
  const hasDenials = autoModeDenials.length > 0
  const defaultTab = initialTab ?? (hasDenials ? 'recent' : 'allow')
  const [changes, setChanges] = useState<string[]>([])
  const toolPermissionContext = useAppState((s) => s.toolPermissionContext)
  const setAppState = useSetAppState()
  const isTerminalFocused = useTerminalFocus()
  const denialStateRef = useRef<{
    approved: Set<number>
    retry: Set<number>
    denials: readonly { display: string }[]
  }>({
    approved: new Set(),
    retry: new Set(),
    denials: [],
  })
  const handleDenialStateChange = (newState: {
    approved: Set<number>
    retry: Set<number>
    denials: readonly { display: string }[]
  }) => {
    denialStateRef.current = newState
  }
  const [selectedRule, setSelectedRule] = useState<PermissionRule | undefined>()
  const [lastFocusedRuleKey, setLastFocusedRuleKey] = useState<string | undefined>()
  const [addingRuleToTab, setAddingRuleToTab] = useState<TabType | null>(null)
  const [validatedRule, setValidatedRule] = useState<{
    ruleValue: PermissionRule['ruleValue']
    ruleBehavior: PermissionBehavior
  } | null>(null)
  const [isAddingWorkspaceDirectory, setIsAddingWorkspaceDirectory] = useState(false)
  const [removingDirectory, setRemovingDirectory] = useState<string | null>(null)
  const [isSearchMode, setIsSearchMode] = useState(false)
  const [headerFocused, setHeaderFocused] = useState(true)
  const handleHeaderFocusChange = (focused: boolean) => {
    setHeaderFocused(focused)
  }
  const allowRulesMap = new Map()
  getAllowRules(toolPermissionContext).forEach((rule) => {
    allowRulesMap.set(jsonStringify(rule), rule)
  })
  const allowRulesByKey = allowRulesMap
  const denyRulesMap = new Map()
  getDenyRules(toolPermissionContext).forEach((denyRule) => {
    denyRulesMap.set(jsonStringify(denyRule), denyRule)
  })
  const denyRulesByKey = denyRulesMap
  const askRulesMap = new Map()
  getAskRules(toolPermissionContext).forEach((askRule) => {
    askRulesMap.set(jsonStringify(askRule), askRule)
  })
  const askRulesByKey = askRulesMap
  const getRulesOptions = (tab: TabType, searchQueryParam?: string) => {
    const query = searchQueryParam === undefined ? '' : searchQueryParam
    const rulesByKey = (() => {
      switch (tab) {
        case 'allow': {
          return allowRulesByKey
        }
        case 'deny': {
          return denyRulesByKey
        }
        case 'ask': {
          return askRulesByKey
        }
        case 'workspace':
        case 'recent': {
          return new Map()
        }
      }
    })()
    const options = []
    if (tab !== 'workspace' && tab !== 'recent' && !query) {
      options.push({
        label: tSync('permissionRules.addNewRule'),
        value: 'add-new-rule',
      })
    }
    const sortedRuleKeys = Array.from(rulesByKey.keys()).sort((a, b) => {
      const ruleA = rulesByKey.get(a)
      const ruleB = rulesByKey.get(b)
      if (ruleA && ruleB) {
        const ruleAString = permissionRuleValueToString(ruleA.ruleValue).toLowerCase()
        const ruleBString = permissionRuleValueToString(ruleB.ruleValue).toLowerCase()
        return ruleAString.localeCompare(ruleBString)
      }
      return 0
    })
    const lowerQuery = query.toLowerCase()
    for (const ruleKey of sortedRuleKeys) {
      const rule = rulesByKey.get(ruleKey)
      if (rule) {
        const ruleString = permissionRuleValueToString(rule.ruleValue)
        if (query && !ruleString.toLowerCase().includes(lowerQuery)) {
          continue
        }
        options.push({
          label: ruleString,
          value: ruleKey,
        })
      }
    }
    return {
      options,
      rulesByKey,
    }
  }
  const exitState = useExitOnCtrlCDWithKeybindings()
  const isSearchModeActive =
    !selectedRule &&
    !addingRuleToTab &&
    !validatedRule &&
    !isAddingWorkspaceDirectory &&
    !removingDirectory
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    cursorOffset: searchCursorOffset,
  } = useSearchInput({
    isActive: isSearchModeActive && isSearchMode,
    onExit: () => {
      setIsSearchMode(false)
    },
  })
  const handleKeyDown = (e: import('../../../ink/events/keyboardEvent.js').KeyboardEvent) => {
    if (!isSearchModeActive) {
      return
    }
    if (isSearchMode) {
      return
    }
    if (e.ctrl || e.meta) {
      return
    }
    if (e.key === '/') {
      e.preventDefault()
      setIsSearchMode(true)
      setSearchQuery('')
    } else {
      if (
        e.key.length === 1 &&
        e.key !== 'j' &&
        e.key !== 'k' &&
        e.key !== 'm' &&
        e.key !== 'i' &&
        e.key !== 'r' &&
        e.key !== ' '
      ) {
        e.preventDefault()
        setIsSearchMode(true)
        setSearchQuery(e.key)
      }
    }
  }
  const handleToolSelect = (selectedValue: string, tab: TabType) => {
    const { rulesByKey } = getRulesOptions(tab)
    if (selectedValue === 'add-new-rule') {
      setAddingRuleToTab(tab)
      return
    } else {
      setSelectedRule(rulesByKey.get(selectedValue))
      return
    }
  }
  const handleRuleInputCancel = () => {
    setAddingRuleToTab(null)
  }
  const handleRuleInputSubmit = (
    ruleValue: PermissionRule['ruleValue'],
    ruleBehavior: PermissionBehavior,
  ) => {
    setValidatedRule({
      ruleValue,
      ruleBehavior,
    })
    setAddingRuleToTab(null)
  }
  const handleAddRulesSuccess = (
    rules: PermissionRule[],
    unreachable?: Array<{ shadowType: string; rule: PermissionRule; reason: string; fix: string }>,
  ) => {
    setValidatedRule(null)
    for (const rule of rules) {
      setChanges((prev) => [
        ...prev,
        `Added ${rule.ruleBehavior} rule ${chalk.bold(permissionRuleValueToString(rule.ruleValue))}`,
      ])
    }
    if (unreachable && unreachable.length > 0) {
      for (const u of unreachable) {
        const severity = u.shadowType === 'deny' ? 'blocked' : 'shadowed'
        setChanges((prev) => [
          ...prev,
          chalk.yellow(
            `${WARNING} Warning: ${permissionRuleValueToString(u.rule.ruleValue)} is ${severity}`,
          ),
          chalk.dim(`  ${u.reason}`),
          chalk.dim(`  Fix: ${u.fix}`),
        ])
      }
    }
  }
  const handleAddRuleCancel = () => {
    setValidatedRule(null)
  }
  const handleRequestAddDirectory = () => setIsAddingWorkspaceDirectory(true)
  const handleRequestRemoveDirectory = (path: string) => setRemovingDirectory(path)
  const handleRulesCancel = () => {
    const denialState = denialStateRef.current
    const denialsFor = (set: Set<number>) =>
      Array.from(set)
        .map((idx) => denialState.denials[idx])
        .filter((d) => d !== undefined)
    const retryDenials = denialsFor(denialState.retry)
    if (retryDenials.length > 0) {
      const commands = retryDenials.map((denial) => denial.display)
      onRetryDenials?.(commands)
      onExit(undefined, {
        shouldQuery: true,
        metaMessages: [
          `Permission granted for: ${commands.join(', ')}. You may now retry ${commands.length === 1 ? 'this command' : 'these commands'} if you would like.`,
        ],
      })
      return
    }
    const approvedDenials = denialsFor(denialState.approved)
    if (approvedDenials.length > 0 || changes.length > 0) {
      const approvedMsg =
        approvedDenials.length > 0
          ? [`Approved ${approvedDenials.map((denial) => chalk.bold(denial.display)).join(', ')}`]
          : []
      onExit([...approvedMsg, ...changes].join('\n'))
    } else {
      onExit('Permissions dialog dismissed', {
        display: 'system',
      })
    }
  }
  useKeybinding('confirm:no', handleRulesCancel, {
    context: 'Settings',
    isActive: isSearchModeActive && !isSearchMode,
  })
  const handleDeleteRule = () => {
    if (!selectedRule) {
      return
    }
    // biome-ignore lint/suspicious/noExplicitAny: 权限系统动态类型处理
    const { options: options_0 } = getRulesOptions(selectedRule.ruleBehavior as unknown as TabType)
    const selectedKey = jsonStringify(selectedRule)
    const ruleKeys = options_0
      .filter((opt) => opt.value !== 'add-new-rule')
      .map((opt_0) => opt_0.value)
    const currentIndex = ruleKeys.indexOf(selectedKey)
    let nextFocusKey
    if (currentIndex !== -1) {
      if (currentIndex < ruleKeys.length - 1) {
        nextFocusKey = ruleKeys[currentIndex + 1]
      } else {
        if (currentIndex > 0) {
          nextFocusKey = ruleKeys[currentIndex - 1]
        }
      }
    }
    setLastFocusedRuleKey(nextFocusKey)
    deletePermissionRule({
      rule: selectedRule,
      initialContext: toolPermissionContext,
      setToolPermissionContext(toolPermissionContext_0) {
        setAppState((prev_1) => ({
          ...prev_1,
          toolPermissionContext: toolPermissionContext_0,
        }))
      },
    })
    setChanges((prev_2) => [
      ...prev_2,
      // biome-ignore lint/suspicious/noExplicitAny: 权限系统动态类型处理
      `Deleted ${selectedRule.ruleBehavior} rule ${chalk.bold(permissionRuleValueToString(selectedRule.ruleValue))}`,
    ])
    setSelectedRule(undefined)
  }
  if (selectedRule) {
    return (
      <RuleDetails
        rule={selectedRule}
        onDelete={handleDeleteRule}
        onCancel={() => setSelectedRule(undefined)}
      />
    )
  }
  if (addingRuleToTab && addingRuleToTab !== 'workspace' && addingRuleToTab !== 'recent') {
    return (
      <PermissionRuleInput
        onCancel={handleRuleInputCancel}
        onSubmit={handleRuleInputSubmit}
        ruleBehavior={addingRuleToTab}
      />
    )
  }
  if (validatedRule) {
    return (
      <AddPermissionRules
        onAddRules={handleAddRulesSuccess}
        onCancel={handleAddRuleCancel}
        ruleValues={[validatedRule.ruleValue]}
        ruleBehavior={validatedRule.ruleBehavior}
        initialContext={toolPermissionContext}
        setToolPermissionContext={(toolPermissionContext_1) => {
          setAppState((prev_3) => ({
            ...prev_3,
            toolPermissionContext: toolPermissionContext_1,
          }))
        }}
      />
    )
  }
  if (isAddingWorkspaceDirectory) {
    return (
      <AddWorkspaceDirectory
        onAddDirectory={(path_0, remember) => {
          const destination = remember ? 'localSettings' : 'session'
          const permissionUpdate: Parameters<typeof applyPermissionUpdate>[1] = {
            type: 'addDirectories' as const,
            directories: [path_0],
            destination,
          }
          const updatedContext = applyPermissionUpdate(toolPermissionContext, permissionUpdate)
          setAppState((prev_4) => ({
            ...prev_4,
            toolPermissionContext: updatedContext,
          }))
          if (remember) {
            persistPermissionUpdate(permissionUpdate)
          }
          setChanges((prev_5) => [
            ...prev_5,
            `Added directory ${chalk.bold(path_0)} to workspace${remember ? ' and saved to local settings' : ' for this session'}`,
          ])
          setIsAddingWorkspaceDirectory(false)
        }}
        onCancel={() => setIsAddingWorkspaceDirectory(false)}
        permissionContext={toolPermissionContext}
        directoryPath={undefined}
      />
    )
  }
  if (removingDirectory) {
    return (
      <RemoveWorkspaceDirectory
        directoryPath={removingDirectory}
        onRemove={() => {
          setChanges((prev_6) => [
            ...prev_6,
            `Removed directory ${chalk.bold(removingDirectory)} from workspace`,
          ])
          setRemovingDirectory(null)
        }}
        onCancel={() => setRemovingDirectory(null)}
        permissionContext={toolPermissionContext}
        setPermissionContext={(toolPermissionContext_2) => {
          setAppState((prev_7) => ({
            ...prev_7,
            toolPermissionContext: toolPermissionContext_2,
          }))
        }}
      />
    )
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
    onHeaderFocusChange: handleHeaderFocusChange,
  } satisfies Partial<RulesTabContentProps> as Omit<RulesTabContentProps, 'tab'>
  const isHidden =
    !!selectedRule ||
    !!addingRuleToTab ||
    !!validatedRule ||
    isAddingWorkspaceDirectory ||
    !!removingDirectory
  return (
    <Box flexDirection="column" onKeyDown={handleKeyDown}>
      {
        <Pane color="permission">
          {
            <Tabs
              title="Permissions:"
              color="permission"
              defaultTab={defaultTab}
              hidden={isHidden}
              initialHeaderFocused={!hasDenials}
              navFromContent={!isSearchMode}
            >
              {
                <Tab id="recent" title={tSync('permissionRules.recentlyDenied')}>
                  <RecentDenialsTab
                    onHeaderFocusChange={handleHeaderFocusChange}
                    onStateChange={handleDenialStateChange}
                  />
                </Tab>
              }
              {
                <Tab id="allow" title={tSync('permissionRules.allowTab')}>
                  <PermissionRulesTab tab="allow" {...sharedRulesProps} />
                </Tab>
              }
              {
                <Tab id="ask" title={tSync('permissionRules.askTab')}>
                  <PermissionRulesTab tab="ask" {...sharedRulesProps} />
                </Tab>
              }
              {
                <Tab id="deny" title={tSync('permissionRules.denyTab')}>
                  <PermissionRulesTab tab="deny" {...sharedRulesProps} />
                </Tab>
              }
              {
                <Tab id="workspace" title={tSync('permissionRules.workspaceTab')}>
                  <Box flexDirection="column">
                    {<Text>{tSync('permissionRules.workspaceDescription')}</Text>}
                    <WorkspaceTab
                      onExit={onExit}
                      toolPermissionContext={toolPermissionContext}
                      onRequestAddDirectory={handleRequestAddDirectory}
                      onRequestRemoveDirectory={handleRequestRemoveDirectory}
                      onHeaderFocusChange={handleHeaderFocusChange}
                    />
                  </Box>
                </Tab>
              }
            </Tabs>
          }
          {
            <Box marginTop={1} paddingLeft={1}>
              <Text dimColor={true}>
                {exitState.pending ? (
                  tSync('permissionRules.pressAgainToExit', { keyName: exitState.keyName ?? '' })
                ) : headerFocused ? (
                  <>←/→ tab switch · ↓ return · Esc cancel</>
                ) : isSearchMode ? (
                  <>Type to filter · Enter/↓ select · ↑ tabs · Esc clear</>
                ) : hasDenials && defaultTab === 'recent' ? (
                  <>Enter approve · r retry · ↑↓ navigate · ←/→ switch · Esc cancel</>
                ) : (
                  <>↑↓ navigate · Enter select · Type to search · ←/→ switch · Esc cancel</>
                )}
              </Text>
            </Box>
          }
        </Pane>
      }
    </Box>
  )
}
