import { useEffect, useState } from 'react'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Byline } from '../../components/design-system/Byline.js'
import { Pane } from '../../components/design-system/Pane.js'
import { Tab, Tabs } from '../../components/design-system/Tabs.js'
import { CROSS, POINTER, TICK } from '../../constants/figures.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Text } from '../../ink.js'
import { tSync } from '../../i18n/index.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { PluginError } from '../../services/plugins/types.js'
import { errorMessage } from '../../utils/errors.js'
import { clearAllCaches } from '../../services/plugins/cacheUtils.js'
import { loadMarketplacesWithGracefulDegradation } from '../../services/plugins/marketplaceHelpers.js'
import {
  loadKnownMarketplacesConfig,
  removeMarketplaceSource,
} from '../../services/plugins/marketplaceManager.js'
import { getPluginEditableScopes } from '../../services/plugins/pluginStartupCheck.js'
import type { EditableSettingSource } from '../../services/settings/constants.js'
import { getSettingsForSource, updateSettingsForSource } from '../../services/settings/settings.js'
import { AddMarketplace } from './AddMarketplace.js'
import { BrowseMarketplace } from './BrowseMarketplace.js'
import { DiscoverPlugins } from './DiscoverPlugins.js'
import { ManageMarketplaces } from './ManageMarketplaces.js'
import { ManagePlugins } from './ManagePlugins.js'
import { formatErrorMessage, getErrorGuidance } from './PluginErrors.js'
import { type ParsedCommand, parsePluginArgs } from './parseArgs.js'
import type { ViewState } from './types.js'
import { ValidatePlugin } from './ValidatePlugin.js'

type TabId = 'discover' | 'installed' | 'marketplaces' | 'errors'
function MarketplaceList({ onComplete }: { onComplete: (result: string) => void }) {
  useEffect(() => {
    const loadList = async function loadList() {
      try {
        const config = await loadKnownMarketplacesConfig()
        const names = Object.keys(config)
        if (names.length === 0) {
          onComplete(tSync('pluginSettings.noMarketplaces'))
        } else {
          onComplete(
            `${tSync('pluginSettings.configuredMarketplaces')}\n${names.map((n) => `  • ${n}`).join('\n')}`,
          )
        }
      } catch (err) {
        onComplete(
          `${tSync('pluginSettings.errorLoadingMarketplaces', { error: errorMessage(err) })}`,
        )
      }
    }
    loadList()
  }, [onComplete])
  return <Text>{tSync('pluginSettings.loadingMarketplaces')}</Text>
}
function McpRedirectBanner() {
  return null
}
type ErrorRowAction =
  | {
      kind: 'navigate'
      tab: TabId
      viewState: ViewState
    }
  | {
      kind: 'remove-extra-marketplace'
      name: string
      sources: Array<{
        source: EditableSettingSource
        scope: string
      }>
    }
  | {
      kind: 'remove-installed-marketplace'
      name: string
    }
  | {
      kind: 'managed-only'
      name: string
    }
  | {
      kind: 'none'
    }
type ErrorRow = {
  label: string
  message: string
  guidance?: string | null
  action: ErrorRowAction
  scope?: string
}

/**
 * Determine which settings sources define an extraKnownMarketplace entry.
 * Returns the editable sources (user/project/local) and whether policy also has it.
 */
function getExtraMarketplaceSourceInfo(name: string): {
  editableSources: Array<{
    source: EditableSettingSource
    scope: string
  }>
  isInPolicy: boolean
} {
  const editableSources: Array<{
    source: EditableSettingSource
    scope: string
  }> = []
  const sourcesToCheck = [
    {
      source: 'userSettings' as const,
      scope: 'user',
    },
    {
      source: 'projectSettings' as const,
      scope: 'project',
    },
    {
      source: 'localSettings' as const,
      scope: 'local',
    },
  ]
  for (const { source, scope } of sourcesToCheck) {
    const settings = getSettingsForSource(source)
    if (settings?.extraKnownMarketplaces?.[name]) {
      editableSources.push({
        source,
        scope,
      })
    }
  }
  const policySettings = getSettingsForSource('policySettings')
  const isInPolicy = Boolean(policySettings?.extraKnownMarketplaces?.[name])
  return {
    editableSources,
    isInPolicy,
  }
}
function buildMarketplaceAction(name: string): ErrorRowAction {
  const { editableSources, isInPolicy } = getExtraMarketplaceSourceInfo(name)
  if (editableSources.length > 0) {
    return {
      kind: 'remove-extra-marketplace',
      name,
      sources: editableSources,
    }
  }
  if (isInPolicy) {
    return {
      kind: 'managed-only',
      name,
    }
  }

  // Marketplace is in known_marketplaces.json but not in extraKnownMarketplaces
  // (e.g. previously installed manually) — route to ManageMarketplaces
  return {
    kind: 'navigate',
    tab: 'marketplaces',
    viewState: {
      type: 'manage-marketplaces',
      targetMarketplace: name,
      action: 'remove',
    },
  }
}
function buildPluginAction(pluginName: string): ErrorRowAction {
  return {
    kind: 'navigate',
    tab: 'installed',
    viewState: {
      type: 'manage-plugins',
      targetPlugin: pluginName,
      action: 'uninstall',
    },
  }
}
const TRANSIENT_ERROR_TYPES = new Set(['git-auth-failed', 'git-timeout', 'network-error'])
function isTransientError(error: PluginError): boolean {
  return TRANSIENT_ERROR_TYPES.has(error.type)
}

/**
 * Extract the plugin name from a PluginError, checking explicit fields first,
 * then falling back to the source field (format: "pluginName@marketplace").
 */
function getPluginNameFromError(error: PluginError): string | undefined {
  if ('pluginId' in error && error.pluginId) {
    return error.pluginId
  }
  if ('plugin' in error && error.plugin) {
    return error.plugin
  }
  // Fallback: source often contains "pluginName@marketplace"
  if (error.source.includes('@')) {
    return error.source.split('@')[0]
  }
  return undefined
}
function buildErrorRows(
  failedMarketplaces: Array<{
    name: string
    error?: string
  }>,
  extraMarketplaceErrors: PluginError[],
  pluginLoadingErrors: PluginError[],
  otherErrors: PluginError[],
  brokenInstalledMarketplaces: Array<{
    name: string
    error: string
  }>,
  transientErrors: PluginError[],
  pluginScopes: Map<string, string>,
): ErrorRow[] {
  const rows: ErrorRow[] = []

  // --- Transient errors at the top (restart to retry) ---
  for (const error of transientErrors) {
    const pluginName =
      'pluginId' in error ? error.pluginId : 'plugin' in error ? error.plugin : undefined
    rows.push({
      label: pluginName ?? error.source,
      message: formatErrorMessage(error),
      guidance: tSync('pluginSettings.restartToRetry'),
      action: {
        kind: 'none',
      },
    })
  }

  // --- Marketplace errors ---
  // Track shown marketplace names to avoid duplicates across sources
  const shownMarketplaceNames = new Set<string>()
  for (const m of failedMarketplaces) {
    shownMarketplaceNames.add(m.name)
    const action = buildMarketplaceAction(m.name)
    const sourceInfo = getExtraMarketplaceSourceInfo(m.name)
    const scope = sourceInfo.isInPolicy ? 'managed' : sourceInfo.editableSources[0]?.scope
    rows.push({
      label: m.name,
      message: m.error ?? tSync('pluginSettings.installationFailed'),
      guidance: action.kind === 'managed-only' ? tSync('pluginSettings.managedByOrg') : undefined,
      action,
      scope,
    })
  }
  for (const e of extraMarketplaceErrors) {
    const marketplace = 'marketplace' in e ? e.marketplace : e.source
    if (shownMarketplaceNames.has(marketplace)) {
      continue
    }
    shownMarketplaceNames.add(marketplace)
    const action = buildMarketplaceAction(marketplace)
    const sourceInfo = getExtraMarketplaceSourceInfo(marketplace)
    const scope = sourceInfo.isInPolicy ? 'managed' : sourceInfo.editableSources[0]?.scope
    rows.push({
      label: marketplace,
      message: formatErrorMessage(e),
      guidance:
        action.kind === 'managed-only' ? tSync('pluginSettings.managedByOrg') : getErrorGuidance(e),
      action,
      scope,
    })
  }

  // Installed marketplaces that fail to load data (from known_marketplaces.json)
  for (const m of brokenInstalledMarketplaces) {
    if (shownMarketplaceNames.has(m.name)) {
      continue
    }
    shownMarketplaceNames.add(m.name)
    rows.push({
      label: m.name,
      message: m.error,
      action: {
        kind: 'remove-installed-marketplace',
        name: m.name,
      },
    })
  }

  // --- Plugin errors ---
  const shownPluginNames = new Set<string>()
  for (const error of pluginLoadingErrors) {
    const pluginName = getPluginNameFromError(error)
    if (pluginName && shownPluginNames.has(pluginName)) {
      continue
    }
    if (pluginName) {
      shownPluginNames.add(pluginName)
    }
    const marketplace = 'marketplace' in error ? error.marketplace : undefined
    // Try pluginId@marketplace format first, then just pluginName
    const scope = pluginName
      ? (pluginScopes.get(error.source) ?? pluginScopes.get(pluginName))
      : undefined
    rows.push({
      label: pluginName
        ? marketplace
          ? `${pluginName} @ ${marketplace}`
          : pluginName
        : error.source,
      message: formatErrorMessage(error),
      guidance: getErrorGuidance(error),
      action: pluginName
        ? buildPluginAction(pluginName)
        : {
            kind: 'none',
          },
      scope,
    })
  }

  // --- Other errors (non-marketplace, non-plugin-specific) ---
  for (const error of otherErrors) {
    rows.push({
      label: error.source,
      message: formatErrorMessage(error),
      guidance: getErrorGuidance(error),
      action: {
        kind: 'none',
      },
    })
  }
  return rows
}

/**
 * Remove a marketplace from extraKnownMarketplaces in the given settings sources,
 * and also remove any associated enabled plugins.
 */
function removeExtraMarketplace(
  name: string,
  sources: Array<{
    source: EditableSettingSource
  }>,
): void {
  for (const { source } of sources) {
    const settings = getSettingsForSource(source)
    if (!settings) {
      continue
    }
    const updates: Record<string, unknown> = {}

    // Remove from extraKnownMarketplaces
    if (settings.extraKnownMarketplaces?.[name]) {
      updates.extraKnownMarketplaces = {
        ...settings.extraKnownMarketplaces,
        [name]: undefined,
      }
    }

    // Remove associated enabled plugins (format: "plugin@marketplace")
    if (settings.enabledPlugins) {
      const suffix = `@${name}`
      let removedPlugins = false
      const updatedPlugins = {
        ...settings.enabledPlugins,
      }
      for (const pluginId in updatedPlugins) {
        if (pluginId.endsWith(suffix)) {
          updatedPlugins[pluginId] = undefined
          removedPlugins = true
        }
      }
      if (removedPlugins) {
        updates.enabledPlugins = updatedPlugins
      }
    }
    if (Object.keys(updates).length > 0) {
      updateSettingsForSource(source, updates)
    }
  }
}
function ErrorsTabContent({
  setViewState,
  setActiveTab,
  markPluginsChanged,
}: {
  setViewState: (state: ViewState) => void
  setActiveTab: (tab: TabId) => void
  markPluginsChanged: () => void
}) {
  const errors = useAppState((s) => s.plugins.errors)
  const installationStatus = useAppState((state) => state.plugins.installationStatus)
  const setAppState = useSetAppState()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [marketplaceLoadFailures, setMarketplaceLoadFailures] = useState<
    { name: string; error: string }[]
  >([])
  useEffect(() => {
    ;(async () => {
      try {
        const config = await loadKnownMarketplacesConfig()
        const { failures } = await loadMarketplacesWithGracefulDegradation(config)
        setMarketplaceLoadFailures(failures)
      } catch {}
    })()
  }, [])
  const failedMarketplaces = installationStatus.marketplaces.filter((m) => m.status === 'failed')
  const failedMarketplaceNames = new Set(failedMarketplaces.map((marketplace) => marketplace.name))
  const transientErrors = errors.filter(isTransientError)
  const extraMarketplaceErrors = errors.filter(
    (e) =>
      (e.type === 'marketplace-not-found' ||
        e.type === 'marketplace-load-failed' ||
        e.type === 'marketplace-blocked-by-policy') &&
      !failedMarketplaceNames.has(e.marketplace),
  )
  const pluginLoadingErrors = errors.filter((error) => {
    if (isTransientError(error)) {
      return false
    }
    if (
      error.type === 'marketplace-not-found' ||
      error.type === 'marketplace-load-failed' ||
      error.type === 'marketplace-blocked-by-policy'
    ) {
      return false
    }
    return getPluginNameFromError(error) !== undefined
  })
  const otherErrors = errors.filter((error) => {
    if (isTransientError(error)) {
      return false
    }
    if (
      error.type === 'marketplace-not-found' ||
      error.type === 'marketplace-load-failed' ||
      error.type === 'marketplace-blocked-by-policy'
    ) {
      return false
    }
    return getPluginNameFromError(error) === undefined
  })
  const pluginScopes = getPluginEditableScopes()
  const rows = buildErrorRows(
    failedMarketplaces,
    extraMarketplaceErrors,
    pluginLoadingErrors,
    otherErrors,
    marketplaceLoadFailures,
    transientErrors,
    pluginScopes,
  )
  useKeybinding(
    'confirm:no',
    () => {
      setViewState({
        type: 'menu',
      })
    },
    {
      context: 'Confirmation',
    },
  )
  const handleSelect = () => {
    const row = rows[selectedIndex]
    if (!row) {
      return
    }
    const { action } = row
    switch (action.kind) {
      case 'navigate': {
        setActiveTab(action.tab)
        setViewState(action.viewState)
        break
      }
      case 'remove-extra-marketplace': {
        const scopes = action.sources.map((source) => source.scope).join(', ')
        removeExtraMarketplace(action.name, action.sources)
        clearAllCaches()
        setAppState((prev) => ({
          ...prev,
          plugins: {
            ...prev.plugins,
            errors: prev.plugins.errors.filter(
              (error) => !('marketplace' in error && error.marketplace === action.name),
            ),
            installationStatus: {
              ...prev.plugins.installationStatus,
              marketplaces: prev.plugins.installationStatus.marketplaces.filter(
                (marketplace) => marketplace.name !== action.name,
              ),
            },
          },
        }))
        setActionMessage(
          `${TICK} ${tSync('pluginSettings.removedFrom', { name: action.name, scopes })}`,
        )
        markPluginsChanged()
        break
      }
      case 'remove-installed-marketplace': {
        ;(async () => {
          try {
            await removeMarketplaceSource(action.name)
            clearAllCaches()
            setMarketplaceLoadFailures((prev) => prev.filter((f) => f.name !== action.name))
            setActionMessage(
              `${TICK} ${tSync('pluginSettings.removedMarketplace', { name: action.name })}`,
            )
            markPluginsChanged()
          } catch (err) {
            setActionMessage(
              `${tSync('pluginSettings.failedToRemove', { name: action.name, error: err instanceof Error ? err.message : String(err) })}`,
            )
          }
        })()
        break
      }
      case 'managed-only': {
        break
      }
      case 'none':
    }
  }
  useKeybindings(
    {
      'select:previous': () => setSelectedIndex((prev) => Math.max(0, prev - 1)),
      'select:next': () => setSelectedIndex((prev) => Math.min(rows.length - 1, prev + 1)),
      'select:accept': handleSelect,
    },
    {
      context: 'Select',
      isActive: rows.length > 0,
    },
  )
  const clampedIndex = Math.min(selectedIndex, Math.max(0, rows.length - 1))
  if (clampedIndex !== selectedIndex) {
    setSelectedIndex(clampedIndex)
  }
  const selectedAction = rows[clampedIndex]?.action
  const hasAction =
    selectedAction && selectedAction.kind !== 'none' && selectedAction.kind !== 'managed-only'
  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        {
          <Box marginLeft={1}>
            <Text dimColor={true}>{tSync('pluginSettings.noPluginErrors')}</Text>
          </Box>
        }
        <Box marginTop={1}>
          <Text dimColor={true} italic={true}>
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Confirmation"
              fallback="Esc"
              description="back"
            />
          </Text>
        </Box>
      </Box>
    )
  }
  const ContainerBox = Box
  const rowElements = rows.map((row, idx) => {
    const isSelected = idx === clampedIndex
    return (
      <Box key={idx} marginLeft={1} flexDirection="column" marginBottom={1}>
        <Text>
          <Text color={isSelected ? 'suggestion' : 'error'}>{isSelected ? POINTER : CROSS} </Text>
          <Text bold={isSelected}>{row.label}</Text>
          {row.scope && <Text dimColor={true}> ({row.scope})</Text>}
        </Text>
        <Box marginLeft={3}>
          <Text color="error">{row.message}</Text>
        </Box>
        {row.guidance && (
          <Box marginLeft={3}>
            <Text dimColor={true} italic={true}>
              {row.guidance}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
  return (
    <ContainerBox flexDirection={'column'}>
      {rowElements}
      {actionMessage && (
        <Box marginTop={1} marginLeft={1}>
          <Text color="zy">{actionMessage}</Text>
        </Box>
      )}
      {
        <Box marginTop={1}>
          <Text dimColor={true} italic={true}>
            <Byline>
              {
                <ConfigurableShortcutHint
                  action="select:previous"
                  context="Select"
                  fallback={'\u2191'}
                  description="navigate"
                />
              }
              {hasAction && (
                <ConfigurableShortcutHint
                  action="select:accept"
                  context="Select"
                  fallback="Enter"
                  description="resolve"
                />
              )}
              {
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Confirmation"
                  fallback="Esc"
                  description="back"
                />
              }
            </Byline>
          </Text>
        </Box>
      }
    </ContainerBox>
  )
}
function getInitialViewState(parsedCommand: ParsedCommand): ViewState {
  switch (parsedCommand.type) {
    case 'help':
      return {
        type: 'help',
      }
    case 'validate':
      return {
        type: 'validate',
        path: parsedCommand.path,
      }
    case 'install':
      if (parsedCommand.marketplace) {
        return {
          type: 'browse-marketplace',
          targetMarketplace: parsedCommand.marketplace,
          targetPlugin: parsedCommand.plugin,
        }
      }
      if (parsedCommand.plugin) {
        return {
          type: 'discover-plugins',
          targetPlugin: parsedCommand.plugin,
        }
      }
      return {
        type: 'discover-plugins',
      }
    case 'manage':
      return {
        type: 'manage-plugins',
      }
    case 'uninstall':
      return {
        type: 'manage-plugins',
        targetPlugin: parsedCommand.plugin,
        action: 'uninstall',
      }
    case 'enable':
      return {
        type: 'manage-plugins',
        targetPlugin: parsedCommand.plugin,
        action: 'enable',
      }
    case 'disable':
      return {
        type: 'manage-plugins',
        targetPlugin: parsedCommand.plugin,
        action: 'disable',
      }
    case 'marketplace':
      if (parsedCommand.action === 'list') {
        return {
          type: 'marketplace-list',
        }
      }
      if (parsedCommand.action === 'add') {
        return {
          type: 'add-marketplace',
          initialValue: parsedCommand.target,
        }
      }
      if (parsedCommand.action === 'remove') {
        return {
          type: 'manage-marketplaces',
          targetMarketplace: parsedCommand.target,
          action: 'remove',
        }
      }
      if (parsedCommand.action === 'update') {
        return {
          type: 'manage-marketplaces',
          targetMarketplace: parsedCommand.target,
          action: 'update',
        }
      }
      return {
        type: 'marketplace-menu',
      }
    default:
      // Default to discover view showing all plugins
      return {
        type: 'discover-plugins',
      }
  }
}
function getInitialTab(viewState: ViewState): TabId {
  if (viewState.type === 'manage-plugins') {
    return 'installed'
  }
  if (viewState.type === 'manage-marketplaces') {
    return 'marketplaces'
  }
  return 'discover'
}
export function PluginSettings({
  onComplete,
  args,
  showMcpRedirectMessage,
}: {
  onComplete: (result?: string) => void
  args: string
  showMcpRedirectMessage?: boolean
}) {
  const parsedCommand = parsePluginArgs(args)
  const initialViewState = getInitialViewState(parsedCommand)
  const [viewState, setViewState] = useState(initialViewState)
  const initialTab = getInitialTab(initialViewState)
  const [activeTab, setActiveTab] = useState(initialTab)
  const [inputValue, setInputValue] = useState(
    viewState.type === 'add-marketplace' ? viewState.initialValue || '' : '',
  )
  const [cursorOffset, setCursorOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [childSearchActive, setChildSearchActive] = useState(false)
  const setAppState = useSetAppState()
  const pluginErrorCount = useAppState((s) => {
    let count = s.plugins.errors.length
    for (const m of s.plugins.installationStatus.marketplaces) {
      if (m.status === 'failed') {
        count++
      }
    }
    return count
  })
  const errorsTabTitle =
    pluginErrorCount > 0
      ? tSync('pluginSettings.errorsTabWithCount', { count: pluginErrorCount })
      : tSync('pluginSettings.errorsTab')
  const exitState = useExitOnCtrlCDWithKeybindings()
  const cliMode =
    parsedCommand.type === 'marketplace' &&
    parsedCommand.action === 'add' &&
    parsedCommand.target !== undefined
  const markPluginsChanged = () => {
    setAppState((prev) =>
      prev.plugins.needsRefresh
        ? prev
        : {
            ...prev,
            plugins: {
              ...prev.plugins,
              needsRefresh: true,
            },
          },
    )
  }
  const handleTabChange = (tabId: string) => {
    const tab = tabId as TabId
    setActiveTab(tab)
    setError(null)
    switch (tab) {
      case 'discover': {
        setViewState({
          type: 'discover-plugins',
        })
        break
      }
      case 'installed': {
        setViewState({
          type: 'manage-plugins',
        })
        break
      }
      case 'marketplaces': {
        setViewState({
          type: 'manage-marketplaces',
        })
        break
      }
      case 'errors':
    }
  }
  useEffect(() => {
    if (viewState.type === 'menu' && !result) {
      onComplete()
    }
  }, [viewState.type, result, onComplete])
  useEffect(() => {
    if (viewState.type === 'browse-marketplace' && activeTab !== 'discover') {
      setActiveTab('discover')
    }
  }, [viewState.type, activeTab])
  const handleAddMarketplaceEscape = () => {
    setActiveTab('marketplaces')
    setViewState({
      type: 'manage-marketplaces',
    })
    setInputValue('')
    setError(null)
  }
  useKeybinding('confirm:no', handleAddMarketplaceEscape, {
    context: 'Settings',
    isActive: viewState.type === 'add-marketplace',
  })
  useEffect(() => {
    if (result) {
      onComplete(result)
    }
  }, [result, onComplete])
  useEffect(() => {
    if (viewState.type === 'help') {
      onComplete()
    }
  }, [viewState.type, onComplete])
  if (viewState.type === 'help') {
    return (
      <Box flexDirection="column">
        <Text bold={true}>{tSync('pluginHelp.title')}</Text>
        <Text> </Text>
        <Text dimColor={true}>{tSync('pluginHelp.installation')}</Text>
        <Text> {tSync('pluginHelp.install')}</Text>
        <Text> {tSync('pluginHelp.installMarketplace')}</Text>
        <Text>{tSync('pluginHelp.installPlugin')}</Text>
        <Text> {tSync('pluginHelp.installPluginAt')}</Text>
        <Text> </Text>
        <Text dimColor={true}>{tSync('pluginHelp.management')}</Text>
        <Text> {tSync('pluginHelp.manage')}</Text>
        <Text>{tSync('pluginHelp.enable')}</Text>
        <Text>{tSync('pluginHelp.disable')}</Text>
        <Text>{tSync('pluginHelp.uninstall')}</Text>
        <Text> </Text>
        <Text dimColor={true}>{tSync('pluginHelp.marketplaces')}</Text>
        <Text> {tSync('pluginHelp.marketplaceMenu')}</Text>
        <Text> {tSync('pluginHelp.marketplaceAdd')}</Text>
        <Text> {tSync('pluginHelp.marketplaceAddDirect')}</Text>
        <Text> {tSync('pluginHelp.marketplaceUpdate')}</Text>
        <Text> {tSync('pluginHelp.marketplaceUpdateSpecific')}</Text>
        <Text> {tSync('pluginHelp.marketplaceRemove')}</Text>
        <Text> {tSync('pluginHelp.marketplaceRemoveSpecific')}</Text>
        <Text> {tSync('pluginHelp.marketplaceList')}</Text>
        <Text> </Text>
        <Text dimColor={true}>{tSync('pluginHelp.validation')}</Text>
        <Text> {tSync('pluginHelp.validate')}</Text>
        <Text> </Text>
        <Text dimColor={true}>{tSync('pluginHelp.other')}</Text>
        <Text> {tSync('pluginHelp.mainMenu')}</Text>
        <Text> {tSync('pluginHelp.help')}</Text>
        <Text> {tSync('pluginHelp.alias')}</Text>
      </Box>
    )
  }
  if (viewState.type === 'validate') {
    return <ValidatePlugin onComplete={onComplete} path={viewState.path} />
  }
  if (viewState.type === 'marketplace-menu') {
    setViewState({
      type: 'menu',
    })
    return null
  }
  if (viewState.type === 'marketplace-list') {
    return <MarketplaceList onComplete={onComplete} />
  }
  if (viewState.type === 'add-marketplace') {
    return (
      <AddMarketplace
        inputValue={inputValue}
        setInputValue={setInputValue}
        cursorOffset={cursorOffset}
        setCursorOffset={setCursorOffset}
        error={error}
        setError={setError}
        result={result}
        setResult={setResult}
        setViewState={setViewState}
        onAddComplete={markPluginsChanged}
        cliMode={cliMode}
      />
    )
  }
  return (
    <Pane color="suggestion">
      <Tabs
        title="Plugins"
        selectedTab={activeTab}
        onTabChange={handleTabChange}
        color="suggestion"
        disableNavigation={childSearchActive}
        banner={
          showMcpRedirectMessage && activeTab === 'installed' ? <McpRedirectBanner /> : undefined
        }
      >
        {
          <Tab id="discover" title="Discover">
            {viewState.type === 'browse-marketplace' ? (
              <BrowseMarketplace
                error={error}
                setError={setError}
                result={result}
                setResult={setResult}
                setViewState={setViewState}
                onInstallComplete={markPluginsChanged}
                targetMarketplace={viewState.targetMarketplace}
                targetPlugin={viewState.targetPlugin}
              />
            ) : (
              <DiscoverPlugins
                error={error}
                setError={setError}
                result={result}
                setResult={setResult}
                setViewState={setViewState}
                onInstallComplete={markPluginsChanged}
                onSearchModeChange={setChildSearchActive}
                targetPlugin={
                  viewState.type === 'discover-plugins' ? viewState.targetPlugin : undefined
                }
              />
            )}
          </Tab>
        }
        {
          <Tab id="installed" title="Installed">
            <ManagePlugins
              setViewState={setViewState}
              setResult={setResult}
              onManageComplete={markPluginsChanged}
              onSearchModeChange={setChildSearchActive}
              targetPlugin={
                viewState.type === 'manage-plugins' ? viewState.targetPlugin : undefined
              }
              targetMarketplace={
                viewState.type === 'manage-plugins' ? viewState.targetMarketplace : undefined
              }
              action={viewState.type === 'manage-plugins' ? viewState.action : undefined}
            />
          </Tab>
        }
        {
          <Tab id="marketplaces" title="Marketplaces">
            <ManageMarketplaces
              setViewState={setViewState}
              error={error}
              setError={setError}
              setResult={setResult}
              exitState={exitState}
              onManageComplete={markPluginsChanged}
              targetMarketplace={
                viewState.type === 'manage-marketplaces' ? viewState.targetMarketplace : undefined
              }
              action={viewState.type === 'manage-marketplaces' ? viewState.action : undefined}
            />
          </Tab>
        }
        {
          <Tab id="errors" title={errorsTabTitle}>
            {
              <ErrorsTabContent
                setViewState={setViewState}
                setActiveTab={setActiveTab}
                markPluginsChanged={markPluginsChanged}
              />
            }
          </Tab>
        }
      </Tabs>
    </Pane>
  )
}
