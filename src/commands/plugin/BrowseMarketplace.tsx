import { WARNING, POINTER, ARROW_UP, TICK, ELLIPSIS, RADIO_ON, RADIO_OFF, ARROW_DOWN, CROSS } from '../../constants/figures.js'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Byline } from '../../components/design-system/Byline.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { count } from '../../utils/array.js'
import { openBrowser } from '../../utils/browser.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js'
import { formatInstallCount, getInstallCounts } from '../../utils/plugins/installCounts.js'
import {
  isPluginGloballyInstalled,
  isPluginInstalled,
} from '../../utils/plugins/installedPluginsManager.js'
import {
  createPluginId,
  formatFailureDetails,
  formatMarketplaceLoadingErrors,
  getMarketplaceSourceDisplay,
  loadMarketplacesWithGracefulDegradation,
} from '../../utils/plugins/marketplaceHelpers.js'
import {
  getMarketplace,
  loadKnownMarketplacesConfig,
} from '../../utils/plugins/marketplaceManager.js'
import { OFFICIAL_MARKETPLACE_NAME } from '../../utils/plugins/officialMarketplace.js'
import { installPluginFromMarketplace } from '../../utils/plugins/pluginInstallationHelpers.js'
import { isPluginBlockedByPolicy } from '../../utils/plugins/pluginPolicy.js'
import { plural } from '../../utils/stringUtils.js'
import { truncateToWidth } from '../../utils/truncate.js'
import { findPluginOptionsTarget, PluginOptionsFlow } from './PluginOptionsFlow.js'
import { PluginTrustWarning } from './PluginTrustWarning.js'
import {
  buildPluginDetailsMenuOptions,
  extractGitHubRepo,
  type InstallablePlugin,
  PluginSelectionKeyHint,
} from './pluginDetailsHelpers.js'
import type { ViewState as ParentViewState } from './types.js'
import { usePagination } from './usePagination.js'

type Props = {
  error: string | null
  setError: (error: string | null) => void
  result: string | null
  setResult: (result: string | null) => void
  setViewState: (state: ParentViewState) => void
  onInstallComplete?: () => void | Promise<void>
  targetMarketplace?: string
  targetPlugin?: string
}
type ViewState =
  | 'marketplace-list'
  | 'plugin-list'
  | 'plugin-details'
  | {
      type: 'plugin-options'
      plugin: LoadedPlugin
      pluginId: string
    }
type MarketplaceInfo = {
  name: string
  totalPlugins: number
  installedCount: number
  source?: string
}
export function BrowseMarketplace({
  error,
  setError,
  result: _result,
  setResult,
  setViewState: setParentViewState,
  onInstallComplete,
  targetMarketplace,
  targetPlugin,
}: Props): React.ReactNode {
  // View state
  const [viewState, setViewState] = useState<ViewState>('marketplace-list')
  const [selectedMarketplace, setSelectedMarketplace] = useState<string | null>(null)
  const [selectedPlugin, setSelectedPlugin] = useState<InstallablePlugin | null>(null)

  // Data state
  const [marketplaces, setMarketplaces] = useState<MarketplaceInfo[]>([])
  const [availablePlugins, setAvailablePlugins] = useState<InstallablePlugin[]>([])
  const [loading, setLoading] = useState(true)
  const [installCounts, setInstallCounts] = useState<Map<string, number> | null>(null)

  // Selection state
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedForInstall, setSelectedForInstall] = useState<Set<string>>(new Set())
  const [installingPlugins, setInstallingPlugins] = useState<Set<string>>(new Set())

  // Pagination for plugin list (continuous scrolling)
  const pagination = usePagination<InstallablePlugin>({
    totalItems: availablePlugins.length,
    selectedIndex,
  })

  // Details view state
  const [detailsMenuIndex, setDetailsMenuIndex] = useState(0)
  const [isInstalling, setIsInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  // Warning state for non-critical errors (e.g., some marketplaces failed to load)
  const [warning, setWarning] = useState<string | null>(null)

  // Handle escape to go back - viewState-dependent navigation
  const handleBack = React.useCallback(() => {
    if (viewState === 'plugin-list') {
      // If navigated directly to a specific marketplace via targetMarketplace,
      // go back to manage-marketplaces showing that marketplace's details
      if (targetMarketplace) {
        setParentViewState({
          type: 'manage-marketplaces',
          targetMarketplace,
        })
      } else if (marketplaces.length === 1) {
        // If there's only one marketplace, skip the marketplace-list view
        // since we auto-navigated past it on load
        setParentViewState({
          type: 'menu',
        })
      } else {
        setViewState('marketplace-list')
        setSelectedMarketplace(null)
        setSelectedForInstall(new Set())
      }
    } else if (viewState === 'plugin-details') {
      setViewState('plugin-list')
      setSelectedPlugin(null)
    } else {
      // At root level (marketplace-list), exit the plugin menu
      setParentViewState({
        type: 'menu',
      })
    }
  }, [viewState, targetMarketplace, setParentViewState, marketplaces.length])
  useKeybinding('confirm:no', handleBack, {
    context: 'Confirmation',
  })

  // Load marketplaces and count installed plugins
  useEffect(() => {
    async function loadMarketplaceData() {
      try {
        const config = await loadKnownMarketplacesConfig()

        // Load marketplaces with graceful degradation
        const { marketplaces: loadedMarketplaces, failures } =
          await loadMarketplacesWithGracefulDegradation(config)
        const marketplaceInfos: MarketplaceInfo[] = []
        for (const { name, config: marketplaceConfig, data: marketplace } of loadedMarketplaces) {
          if (marketplace) {
            // Count how many plugins from this marketplace are installed
            const installedFromThisMarketplace = count(marketplace.plugins, (plugin) =>
              // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
              isPluginInstalled(createPluginId((plugin as any).name, name)),
            )
            marketplaceInfos.push({
              name,
              totalPlugins: marketplace.plugins.length,
              installedCount: installedFromThisMarketplace,
              source: getMarketplaceSourceDisplay(marketplaceConfig.source),
            })
          }
        }

        // Sort so zy-plugin-directory is always first
        marketplaceInfos.sort((a, b) => {
          if (a.name === 'zy-plugin-directory') {
            return -1
          }
          if (b.name === 'zy-plugin-directory') {
            return 1
          }
          return 0
        })
        setMarketplaces(marketplaceInfos)

        // Handle marketplace loading errors/warnings
        const successCount = count(loadedMarketplaces, (m) => m.data !== null)
        const errorResult = formatMarketplaceLoadingErrors(failures, successCount)
        if (errorResult) {
          if (errorResult.type === 'warning') {
            setWarning(`${errorResult.message}. Showing available marketplaces.`)
          } else {
            throw new Error(errorResult.message)
          }
        }

        // Skip marketplace selection if there's only one marketplace
        if (marketplaceInfos.length === 1 && !targetMarketplace && !targetPlugin) {
          const singleMarketplace = marketplaceInfos[0]
          if (singleMarketplace) {
            setSelectedMarketplace(singleMarketplace.name)
            setViewState('plugin-list')
          }
        }

        // Handle targetMarketplace and targetPlugin after marketplaces are loaded
        if (targetPlugin) {
          // Search for the plugin across all marketplaces
          let foundPlugin: InstallablePlugin | null = null
          let foundMarketplace: string | null = null
          for (const [marketplaceName] of Object.entries(config)) {
            const currentMarketplace = await getMarketplace(marketplaceName)
            if (currentMarketplace) {
              const foundPluginEntry = currentMarketplace.plugins.find(
                // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
                (p: any) => p.name === targetPlugin,
              )
              if (foundPluginEntry) {
                const pluginId = createPluginId(foundPluginEntry.name, marketplaceName)
                foundPlugin = {
                  entry: foundPluginEntry,
                  marketplaceName: marketplaceName,
                  pluginId,
                  // isPluginGloballyInstalled: only block when user/managed scope
                  // exists (nothing to add). Project/local-scope installs don't
                  // block — user may want to promote to user scope (gh-29997).
                  isInstalled: isPluginGloballyInstalled(pluginId),
                }
                foundMarketplace = marketplaceName
                break
              }
            }
          }
          if (foundPlugin && foundMarketplace) {
            // Block only on global (user/managed) install — project/local scope
            // means the user might still want to add a user-scope entry so the
            // plugin is available in other projects (gh-29997, gh-29240, gh-29392).
            // The plugin-details view offers all three scope options; the backend
            // (installPluginOp → addInstalledPlugin) already supports multiple
            // scope entries per plugin.
            const foundPluginId = foundPlugin.pluginId
            const globallyInstalled = isPluginGloballyInstalled(foundPluginId)
            if (globallyInstalled) {
              setError(
                `Plugin '${foundPluginId}' is already installed globally. Use '/plugin' to manage existing plugins.`,
              )
            } else {
              // Navigate to the plugin details view
              setSelectedMarketplace(foundMarketplace)
              setSelectedPlugin(foundPlugin)
              setViewState('plugin-details')
            }
          } else {
            setError(`Plugin "${targetPlugin}" not found in any marketplace`)
          }
        } else if (targetMarketplace) {
          // Navigate directly to the specified marketplace
          const marketplaceExists = marketplaceInfos.some(
            (marketplaceInfo) => marketplaceInfo.name === targetMarketplace,
          )
          if (marketplaceExists) {
            setSelectedMarketplace(targetMarketplace)
            setViewState('plugin-list')
          } else {
            setError(`Marketplace "${targetMarketplace}" not found`)
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load marketplaces')
      } finally {
        setLoading(false)
      }
    }
    void loadMarketplaceData()
  }, [setError, targetMarketplace, targetPlugin])

  // Load plugins when a marketplace is selected
  useEffect(() => {
    if (!selectedMarketplace) {
      return
    }
    let cancelled = false
    async function loadPluginsForMarketplace(marketplaceName: string) {
      setLoading(true)
      try {
        const targetMarketplaceData = await getMarketplace(marketplaceName)
        if (cancelled) {
          return
        }
        if (!targetMarketplaceData) {
          throw new Error(`Failed to load marketplace: ${marketplaceName}`)
        }

        // Filter out already installed plugins
        const installablePlugins: InstallablePlugin[] = []
        for (const entry of targetMarketplaceData.plugins) {
          const currentPluginId = createPluginId(entry.name, marketplaceName)
          if (isPluginBlockedByPolicy(currentPluginId)) {
            continue
          }
          installablePlugins.push({
            entry,
            marketplaceName: marketplaceName,
            pluginId: currentPluginId,
            // Only mark as "installed" when globally scoped (user/managed).
            // Project/local installs don't block — user can add user scope
            // via the plugin-details view (gh-29997).
            isInstalled: isPluginGloballyInstalled(currentPluginId),
          })
        }

        // Fetch install counts and sort by popularity
        try {
          const counts = await getInstallCounts()
          if (cancelled) {
            return
          }
          setInstallCounts(counts)
          if (counts) {
            // Sort by install count (descending), then alphabetically
            installablePlugins.sort((pluginA, pluginB) => {
              const countA = counts.get(pluginA.pluginId) ?? 0
              const countB = counts.get(pluginB.pluginId) ?? 0
              if (countA !== countB) {
                return countB - countA
              }
              return pluginA.entry.name.localeCompare(pluginB.entry.name)
            })
          } else {
            // No counts available - sort alphabetically
            installablePlugins.sort((pluginA, pluginB) =>
              pluginA.entry.name.localeCompare(pluginB.entry.name),
            )
          }
        } catch (error) {
          if (cancelled) {
            return
          }
          // Log the error, then gracefully degrade to alphabetical sort
          logForDebugging(`Failed to fetch install counts: ${errorMessage(error)}`)
          installablePlugins.sort((pluginA, pluginB) =>
            pluginA.entry.name.localeCompare(pluginB.entry.name),
          )
        }
        setAvailablePlugins(installablePlugins)
        setSelectedIndex(0)
        setSelectedForInstall(new Set())
      } catch (error) {
        if (cancelled) {
          return
        }
        setError(error instanceof Error ? error.message : 'Failed to load plugins')
      } finally {
        setLoading(false)
      }
    }
    void loadPluginsForMarketplace(selectedMarketplace)
    return () => {
      cancelled = true
    }
  }, [selectedMarketplace, setError])

  // Install selected plugins
  const installSelectedPlugins = async () => {
    if (selectedForInstall.size === 0) {
      return
    }
    const pluginsToInstall = availablePlugins.filter((pluginItem) =>
      selectedForInstall.has(pluginItem.pluginId),
    )
    setInstallingPlugins(new Set(pluginsToInstall.map((installPlugin) => installPlugin.pluginId)))
    let successCount = 0
    let failureCount = 0
    const newFailedPlugins: Array<{
      name: string
      reason: string
    }> = []
    for (const pluginToInstall of pluginsToInstall) {
      const installResult = await installPluginFromMarketplace({
        pluginId: pluginToInstall.pluginId,
        entry: pluginToInstall.entry,
        marketplaceName: pluginToInstall.marketplaceName,
        scope: 'user',
      })
      if (installResult.success) {
        successCount++
      } else {
        failureCount++
        newFailedPlugins.push({
          name: pluginToInstall.entry.name,
          // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
          reason: (installResult as any).error,
        })
      }
    }
    setInstallingPlugins(new Set())
    setSelectedForInstall(new Set())
    clearAllCaches()

    // Handle installation results
    if (failureCount === 0) {
      // All succeeded
      const message =
        `✓ Installed ${successCount} ${plural(successCount, 'plugin')}. ` +
        `Run /reload-plugins to activate.`
      setResult(message)
    } else if (successCount === 0) {
      // All failed - show error with reasons
      setError(`Failed to install: ${formatFailureDetails(newFailedPlugins, true)}`)
    } else {
      // Mixed results - show partial success
      const partialSuccessMessage =
        `✓ Installed ${successCount} of ${successCount + failureCount} plugins. ` +
        `Failed: ${formatFailureDetails(newFailedPlugins, false)}. ` +
        `Run /reload-plugins to activate successfully installed plugins.`
      setResult(partialSuccessMessage)
    }

    // Handle completion callback and navigation
    if (successCount > 0) {
      if (onInstallComplete) {
        await onInstallComplete()
      }
    }
    setParentViewState({
      type: 'menu',
    })
  }

  // Install single plugin from details view
  const handleSinglePluginInstall = async (
    pluginForInstall: InstallablePlugin,
    scope: 'user' | 'project' | 'local' = 'user',
  ) => {
    setIsInstalling(true)
    setInstallError(null)
    const installResult = await installPluginFromMarketplace({
      pluginId: pluginForInstall.pluginId,
      entry: pluginForInstall.entry,
      marketplaceName: pluginForInstall.marketplaceName,
      scope,
    })
    if (installResult.success) {
      const loaded = await findPluginOptionsTarget(pluginForInstall.pluginId)
      if (loaded) {
        setIsInstalling(false)
        setViewState({
          type: 'plugin-options',
          plugin: loaded,
          pluginId: pluginForInstall.pluginId,
        })
        return
      }
      setResult(installResult.message)
      if (onInstallComplete) {
        await onInstallComplete()
      }
      setParentViewState({
        type: 'menu',
      })
    } else {
      setIsInstalling(false)
      // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
      setInstallError((installResult as any).error)
    }
  }

  // Handle error state
  useEffect(() => {
    if (error) {
      setResult(error)
    }
  }, [error, setResult])

  // Marketplace-list navigation
  useKeybindings(
    {
      'select:previous': () => {
        if (selectedIndex > 0) {
          setSelectedIndex(selectedIndex - 1)
        }
      },
      'select:next': () => {
        if (selectedIndex < marketplaces.length - 1) {
          setSelectedIndex(selectedIndex + 1)
        }
      },
      'select:accept': () => {
        const selectedMarketplaceInfo = marketplaces[selectedIndex]
        if (selectedMarketplaceInfo) {
          setSelectedMarketplace(selectedMarketplaceInfo.name)
          setViewState('plugin-list')
        }
      },
    },
    {
      context: 'Select',
      isActive: viewState === 'marketplace-list',
    },
  )

  // Plugin-list navigation
  useKeybindings(
    {
      'select:previous': () => {
        if (selectedIndex > 0) {
          pagination.handleSelectionChange(selectedIndex - 1, setSelectedIndex)
        }
      },
      'select:next': () => {
        if (selectedIndex < availablePlugins.length - 1) {
          pagination.handleSelectionChange(selectedIndex + 1, setSelectedIndex)
        }
      },
      'select:accept': () => {
        if (selectedIndex === availablePlugins.length && selectedForInstall.size > 0) {
          void installSelectedPlugins()
        } else if (selectedIndex < availablePlugins.length) {
          const selectedPluginItem = availablePlugins[selectedIndex]
          if (selectedPluginItem) {
            if (selectedPluginItem.isInstalled) {
              setParentViewState({
                type: 'manage-plugins',
                targetPlugin: selectedPluginItem.entry.name,
                targetMarketplace: selectedPluginItem.marketplaceName,
              })
            } else {
              setSelectedPlugin(selectedPluginItem)
              setViewState('plugin-details')
              setDetailsMenuIndex(0)
              setInstallError(null)
            }
          }
        }
      },
    },
    {
      context: 'Select',
      isActive: viewState === 'plugin-list',
    },
  )
  useKeybindings(
    {
      'plugin:toggle': () => {
        if (selectedIndex < availablePlugins.length) {
          const toggledPlugin = availablePlugins[selectedIndex]
          if (toggledPlugin && !toggledPlugin.isInstalled) {
            const newSelection = new Set(selectedForInstall)
            if (newSelection.has(toggledPlugin.pluginId)) {
              newSelection.delete(toggledPlugin.pluginId)
            } else {
              newSelection.add(toggledPlugin.pluginId)
            }
            setSelectedForInstall(newSelection)
          }
        }
      },
      'plugin:install': () => {
        if (selectedForInstall.size > 0) {
          void installSelectedPlugins()
        }
      },
    },
    {
      context: 'Plugin',
      isActive: viewState === 'plugin-list',
    },
  )

  // Plugin-details navigation
  const detailsMenuOptions = React.useMemo(() => {
    if (!selectedPlugin) {
      return []
    }
    const hasHomepage = selectedPlugin.entry.homepage
    const githubRepo = extractGitHubRepo(selectedPlugin)
    return buildPluginDetailsMenuOptions(hasHomepage, githubRepo)
  }, [selectedPlugin])
  useKeybindings(
    {
      'select:previous': () => {
        if (detailsMenuIndex > 0) {
          setDetailsMenuIndex(detailsMenuIndex - 1)
        }
      },
      'select:next': () => {
        if (detailsMenuIndex < detailsMenuOptions.length - 1) {
          setDetailsMenuIndex(detailsMenuIndex + 1)
        }
      },
      'select:accept': () => {
        if (!selectedPlugin) {
          return
        }
        const action = detailsMenuOptions[detailsMenuIndex]?.action
        const hasHomepage_0 = selectedPlugin.entry.homepage
        const githubRepo_0 = extractGitHubRepo(selectedPlugin)
        if (action === 'install-user') {
          void handleSinglePluginInstall(selectedPlugin, 'user')
        } else if (action === 'install-project') {
          void handleSinglePluginInstall(selectedPlugin, 'project')
        } else if (action === 'install-local') {
          void handleSinglePluginInstall(selectedPlugin, 'local')
        } else if (action === 'homepage' && hasHomepage_0) {
          void openBrowser(hasHomepage_0)
        } else if (action === 'github' && githubRepo_0) {
          void openBrowser(`https://github.com/${githubRepo_0}`)
        } else if (action === 'back') {
          setViewState('plugin-list')
          setSelectedPlugin(null)
        }
      },
    },
    {
      context: 'Select',
      isActive: viewState === 'plugin-details' && !!selectedPlugin,
    },
  )
  if (typeof viewState === 'object' && viewState.type === 'plugin-options') {
    const { plugin: optionsPlugin, pluginId: optionsPluginId } = viewState
    function finish(msg: string): void {
      setResult(msg)
      if (onInstallComplete) {
        void onInstallComplete()
      }
      setParentViewState({
        type: 'menu',
      })
    }
    return (
      <PluginOptionsFlow
        plugin={optionsPlugin}
        pluginId={optionsPluginId}
        onDone={(outcome, detail) => {
          switch (outcome) {
            case 'configured':
              finish(
                `✓ Installed and configured ${optionsPlugin.name}. Run /reload-plugins to apply.`,
              )
              break
            case 'skipped':
              finish(`✓ Installed ${optionsPlugin.name}. Run /reload-plugins to apply.`)
              break
            case 'error':
              finish(`Installed but failed to save config: ${detail}`)
              break
          }
        }}
      />
    )
  }

  // Loading state
  if (loading) {
    return <Text>Loading…</Text>
  }

  // Error state
  if (error) {
    return <Text color="error">{error}</Text>
  }

  // Marketplace selection view
  if (viewState === 'marketplace-list') {
    if (marketplaces.length === 0) {
      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>Select marketplace</Text>
          </Box>
          <Text>No marketplaces configured.</Text>
          <Text dimColor>Add a marketplace first using {"'Add marketplace'"}.</Text>
          <Box marginTop={1} paddingLeft={1}>
            <Text dimColor>
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="go back"
              />
            </Text>
          </Box>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Select marketplace</Text>
        </Box>

        {/* Warning banner for marketplace load failures */}
        {warning && (
          <Box marginBottom={1} flexDirection="column">
            <Text color="warning">
              {WARNING} {warning}
            </Text>
          </Box>
        )}
        {marketplaces.map((marketplaceItem, index) => (
          <Box
            key={marketplaceItem.name}
            flexDirection="column"
            marginBottom={index < marketplaces.length - 1 ? 1 : 0}
          >
            <Box>
              <Text color={selectedIndex === index ? 'suggestion' : undefined}>
                {selectedIndex === index ? POINTER : ' '} {marketplaceItem.name}
              </Text>
            </Box>
            <Box marginLeft={2}>
              <Text dimColor>
                {marketplaceItem.totalPlugins} {plural(marketplaceItem.totalPlugins, 'plugin')}{' '}
                available
                {marketplaceItem.installedCount > 0 &&
                  ` · ${marketplaceItem.installedCount} already installed`}
                {marketplaceItem.source && ` · ${marketplaceItem.source}`}
              </Text>
            </Box>
          </Box>
        ))}

        <Box marginTop={1}>
          <Text dimColor italic>
            <Byline>
              <ConfigurableShortcutHint
                action="select:accept"
                context="Select"
                fallback="Enter"
                description="select"
              />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="go back"
              />
            </Byline>
          </Text>
        </Box>
      </Box>
    )
  }

  // Plugin details view
  if (viewState === 'plugin-details' && selectedPlugin) {
    const hasHomepage = selectedPlugin.entry.homepage
    const githubRepo = extractGitHubRepo(selectedPlugin)
    const menuOptions = buildPluginDetailsMenuOptions(hasHomepage, githubRepo)
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Plugin Details</Text>
        </Box>

        {/* Plugin metadata */}
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{selectedPlugin.entry.name}</Text>
          {selectedPlugin.entry.version && (
            <Text dimColor>Version: {selectedPlugin.entry.version}</Text>
          )}
          {selectedPlugin.entry.description && (
            <Box marginTop={1}>
              <Text>{selectedPlugin.entry.description}</Text>
            </Box>
          )}
          {selectedPlugin.entry.author && (
            <Box marginTop={1}>
              <Text dimColor>
                By:{' '}
                {typeof selectedPlugin.entry.author === 'string'
                  ? selectedPlugin.entry.author
                  : selectedPlugin.entry.author.name}
              </Text>
            </Box>
          )}
        </Box>

        {/* What will be installed */}
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Will install:</Text>
          {selectedPlugin.entry.commands && (
            <Text dimColor>
              · Commands:{' '}
              {Array.isArray(selectedPlugin.entry.commands)
                ? selectedPlugin.entry.commands.join(', ')
                : Object.keys(selectedPlugin.entry.commands).join(', ')}
            </Text>
          )}
          {selectedPlugin.entry.agents && (
            <Text dimColor>
              · Agents:{' '}
              {Array.isArray(selectedPlugin.entry.agents)
                ? selectedPlugin.entry.agents.join(', ')
                : Object.keys(selectedPlugin.entry.agents).join(', ')}
            </Text>
          )}
          {selectedPlugin.entry.hooks && (
            <Text dimColor>· Hooks: {Object.keys(selectedPlugin.entry.hooks).join(', ')}</Text>
          )}
          {selectedPlugin.entry.mcpServers && (
            <Text dimColor>
              · MCP Servers:{' '}
              {Array.isArray(selectedPlugin.entry.mcpServers)
                ? selectedPlugin.entry.mcpServers.join(', ')
                : typeof selectedPlugin.entry.mcpServers === 'object'
                  ? Object.keys(selectedPlugin.entry.mcpServers).join(', ')
                  : 'configured'}
            </Text>
          )}
          {!selectedPlugin.entry.commands &&
            !selectedPlugin.entry.agents &&
            !selectedPlugin.entry.hooks &&
            !selectedPlugin.entry.mcpServers &&
            (typeof selectedPlugin.entry.source === 'object' &&
            'source' in selectedPlugin.entry.source &&
            (selectedPlugin.entry.source.source === 'github' ||
              selectedPlugin.entry.source.source === 'url' ||
              selectedPlugin.entry.source.source === 'npm' ||
              selectedPlugin.entry.source.source === 'pip') ? (
              <Text dimColor>· Component summary not available for remote plugin</Text>
            ) : (
              // TODO: Actually scan local plugin directories to show real components
              // This would require accessing the filesystem to check for:
              // - commands/ directory and list files
              // - agents/ directory and list files
              // - hooks/ directory and list files
              // - .mcp.json or mcp-servers.json files
              <Text dimColor>· Components will be discovered at installation</Text>
            ))}
        </Box>

        <PluginTrustWarning />

        {/* Error message */}
        {installError && (
          <Box marginBottom={1}>
            <Text color="error">Error: {installError}</Text>
          </Box>
        )}

        {/* Menu options */}
        <Box flexDirection="column">
          {menuOptions.map((option, menuOptionIndex) => (
            <Box key={option.action}>
              {detailsMenuIndex === menuOptionIndex && <Text>{'> '}</Text>}
              {detailsMenuIndex !== menuOptionIndex && <Text>{'  '}</Text>}
              <Text bold={detailsMenuIndex === menuOptionIndex}>
                {isInstalling && option.action === 'install' ? 'Installing…' : option.label}
              </Text>
            </Box>
          ))}
        </Box>

        <Box marginTop={1} paddingLeft={1}>
          <Text dimColor>
            <Byline>
              <ConfigurableShortcutHint
                action="select:accept"
                context="Select"
                fallback="Enter"
                description="select"
              />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="back"
              />
            </Byline>
          </Text>
        </Box>
      </Box>
    )
  }

  // Plugin installation view
  if (availablePlugins.length === 0) {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Install plugins</Text>
        </Box>
        <Text dimColor>No new plugins available to install.</Text>
        <Text dimColor>All plugins from this marketplace are already installed.</Text>
        <Box marginLeft={3}>
          <Text dimColor italic>
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Confirmation"
              fallback="Esc"
              description="go back"
            />
          </Text>
        </Box>
      </Box>
    )
  }

  // Get visible plugins from pagination
  const visiblePlugins = pagination.getVisibleItems(availablePlugins)
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Install Plugins</Text>
      </Box>

      {/* Scroll up indicator */}
      {pagination.scrollPosition.canScrollUp && (
        <Box>
          <Text dimColor> {ARROW_UP} more above</Text>
        </Box>
      )}

      {/* Plugin list */}
      {visiblePlugins.map((plugin_6, visibleIndex) => {
        const actualIndex = pagination.toActualIndex(visibleIndex)
        const isSelected = selectedIndex === actualIndex
        const isSelectedForInstall = selectedForInstall.has(plugin_6.pluginId)
        const isInstalling_0 = installingPlugins.has(plugin_6.pluginId)
        const isLast = visibleIndex === visiblePlugins.length - 1
        return (
          <Box
            key={plugin_6.pluginId}
            flexDirection="column"
            marginBottom={isLast && !error ? 0 : 1}
          >
            <Box>
              <Text color={isSelected ? 'suggestion' : undefined}>
                {isSelected ? POINTER : ' '}{' '}
              </Text>
              <Text color={plugin_6.isInstalled ? 'success' : undefined}>
                {plugin_6.isInstalled
                  ? TICK
                  : isInstalling_0
                    ? ELLIPSIS
                    : isSelectedForInstall
                      ? RADIO_ON
                      : RADIO_OFF}{' '}
                {plugin_6.entry.name}
                {plugin_6.entry.category && <Text dimColor> [{plugin_6.entry.category}]</Text>}
                {plugin_6.entry.tags?.includes('community-managed') && (
                  <Text dimColor> [Community Managed]</Text>
                )}
                {plugin_6.isInstalled && <Text dimColor> (installed)</Text>}
                {installCounts && selectedMarketplace === OFFICIAL_MARKETPLACE_NAME && (
                  <Text dimColor>
                    {' · '}
                    {formatInstallCount(installCounts.get(plugin_6.pluginId) ?? 0)} installs
                  </Text>
                )}
              </Text>
            </Box>
            {plugin_6.entry.description && (
              <Box marginLeft={4}>
                <Text dimColor>{truncateToWidth(plugin_6.entry.description, 60)}</Text>
                {plugin_6.entry.version && <Text dimColor> · v{plugin_6.entry.version}</Text>}
              </Box>
            )}
          </Box>
        )
      })}

      {/* Scroll down indicator */}
      {pagination.scrollPosition.canScrollDown && (
        <Box>
          <Text dimColor> {ARROW_DOWN} more below</Text>
        </Box>
      )}

      {/* Error messages shown in the UI */}
      {error && (
        <Box marginTop={1}>
          <Text color="error">
            {CROSS} {error}
          </Text>
        </Box>
      )}

      <PluginSelectionKeyHint hasSelection={selectedForInstall.size > 0} />
    </Box>
  )
}
