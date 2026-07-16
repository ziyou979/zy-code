/**
 * Shared helper functions and types for plugin details views
 *
 * Used by both DiscoverPlugins and BrowseMarketplace components.
 */

import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Byline } from '../../components/design-system/Byline.js'
import { Box, Text } from '../../ink/index.js'
import { tSync } from '../../i18n/index.js'
import type { PluginMarketplaceEntry } from '../../services/plugins/schemas.js'

/**
 * Represents a plugin available for installation from a marketplace
 */
export type InstallablePlugin = {
  entry: PluginMarketplaceEntry
  marketplaceName: string
  pluginId: string
  isInstalled: boolean
}

/**
 * Menu option for plugin details view
 */
export type PluginDetailsMenuOption = {
  label: string
  action: string
}

/**
 * Extract GitHub repo info from a plugin's source
 */
export function extractGitHubRepo(plugin: InstallablePlugin): string | null {
  const isGitHub =
    plugin.entry.source &&
    typeof plugin.entry.source === 'object' &&
    'source' in plugin.entry.source &&
    plugin.entry.source.source === 'github'
  if (isGitHub && typeof plugin.entry.source === 'object' && 'repo' in plugin.entry.source) {
    return plugin.entry.source.repo
  }
  return null
}

/**
 * Build menu options for plugin details view with scoped installation options
 */
export function buildPluginDetailsMenuOptions(
  hasHomepage: string | undefined,
  githubRepo: string | null,
): PluginDetailsMenuOption[] {
  const options: PluginDetailsMenuOption[] = [
    {
      label: tSync('managePlugins.menuInstallUser'),
      action: 'install-user',
    },
    {
      label: tSync('managePlugins.menuInstallProject'),
      action: 'install-project',
    },
    {
      label: tSync('managePlugins.menuInstallLocal'),
      action: 'install-local',
    },
  ]
  if (hasHomepage) {
    options.push({
      label: tSync('managePlugins.menuOpenHomepage'),
      action: 'homepage',
    })
  }
  if (githubRepo) {
    options.push({
      label: tSync('managePlugins.menuViewGitHub'),
      action: 'github',
    })
  }
  options.push({
    label: tSync('managePlugins.menuBackToList'),
    action: 'back',
  })
  return options
}

/**
 * Key hint component for plugin selection screens
 */
export function PluginSelectionKeyHint({ hasSelection }: { hasSelection: boolean }) {
  return (
    <Box marginTop={1}>
      <Text dimColor={true} italic={true}>
        <Byline>
          {hasSelection && (
            <ConfigurableShortcutHint
              action="plugin:install"
              context="Plugin"
              fallback="i"
              description="install"
              bold={true}
            />
          )}
          {
            <ConfigurableShortcutHint
              action="plugin:toggle"
              context="Plugin"
              fallback="Space"
              description="toggle"
            />
          }
          {
            <ConfigurableShortcutHint
              action="select:accept"
              context="Select"
              fallback="Enter"
              description="details"
            />
          }
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
  )
}
