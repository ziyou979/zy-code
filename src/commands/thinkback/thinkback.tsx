import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import * as React from 'react'
import { useEffect, useState } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Spinner } from '../../components/Spinner.js'
import { tSync } from '../../i18n/index.js'
import instances from '../../ink/instances.js'
import { Box, Text } from '../../ink.js'
import { enablePluginOp } from '../../services/plugins/pluginOperations.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { logForDebugging } from '../../utils/debug.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { isENOENT, toError } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { pathExists } from '../../utils/file.js'
import { logError } from '../../utils/log.js'
import { getPlatform } from '../../utils/platform.js'
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js'
import { isPluginInstalled } from '../../utils/plugins/installedPluginsManager.js'
import {
  addMarketplaceSource,
  clearMarketplacesCache,
  loadKnownMarketplacesConfig,
  refreshMarketplace,
} from '../../utils/plugins/marketplaceManager.js'
import { OFFICIAL_MARKETPLACE_NAME } from '../../utils/plugins/officialMarketplace.js'
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js'
import { installSelectedPlugins } from '../../utils/plugins/pluginStartupCheck.js'

// Marketplace and plugin identifiers - varies by user type
const ANTHROPIC_MARKETPLACE_NAME = 'claude-code-marketplace'
const INTERNAL_MARKETPLACE_REPO = 'anthropics/claude-code-marketplace'
const ANTHROPIC_MARKETPLACE_REPO = 'anthropics/claude-plugins-official'
function getMarketplaceName(): string {
  return isInternalBuild() ? ANTHROPIC_MARKETPLACE_NAME : OFFICIAL_MARKETPLACE_NAME
}
function getMarketplaceRepo(): string {
  return isInternalBuild() ? INTERNAL_MARKETPLACE_REPO : ANTHROPIC_MARKETPLACE_REPO
}
function getPluginId(): string {
  return `thinkback@${getMarketplaceName()}`
}
const SKILL_NAME = 'thinkback'

/**
 * Get the thinkback skill directory from the installed plugin's cache path
 */
async function getThinkbackSkillDir(): Promise<string | null> {
  const { enabled } = await loadAllPlugins()
  const thinkbackPlugin = enabled.find(
    (p) => p.name === 'thinkback' || p.source?.includes(getPluginId()),
  )
  if (!thinkbackPlugin) {
    return null
  }
  const skillDir = join(thinkbackPlugin.path, 'skills', SKILL_NAME)
  if (await pathExists(skillDir)) {
    return skillDir
  }
  return null
}
export async function playAnimation(skillDir: string): Promise<{
  success: boolean
  message: string
}> {
  const dataPath = join(skillDir, 'year_in_review.js')
  const playerPath = join(skillDir, 'player.js')

  // Both files are prerequisites for the node subprocess. Read them here
  // (not at call sites) so all callers get consistent error messaging. The
  // subprocess runs with reject: false, so a missing file would otherwise
  // silently return success. Using readFile (not access) per AGENTS.md.
  //
  // Non-ENOENT errors (EACCES etc) are logged and returned as failures rather
  // than thrown — the old pathExists-based code never threw, and one caller
  // (handleSelect) uses `void playAnimation().then(...)` without a .catch().
  try {
    await readFile(dataPath)
  } catch (e: unknown) {
    if (isENOENT(e)) {
      return {
        success: false,
        message: tSync('thinkback.noAnimationFound'),
      }
    }
    logError(e)
    return {
      success: false,
      message: `Could not access animation data: ${toError(e).message}`,
    }
  }
  try {
    await readFile(playerPath)
  } catch (e: unknown) {
    if (isENOENT(e)) {
      return {
        success: false,
        message: tSync('thinkback.playerNotFound'),
      }
    }
    logError(e)
    return {
      success: false,
      message: `Could not access player script: ${toError(e).message}`,
    }
  }

  // Get ink instance for terminal takeover
  const inkInstance = instances.get(process.stdout)
  if (!inkInstance) {
    return {
      success: false,
      message: 'Failed to access terminal instance',
    }
  }
  inkInstance.enterAlternateScreen()
  try {
    await execa('node', [playerPath], {
      stdio: 'inherit',
      cwd: skillDir,
      reject: false,
    })
  } catch {
    // Animation may have been interrupted (e.g., Ctrl+C)
  } finally {
    inkInstance.exitAlternateScreen()
  }

  // Open the HTML file in browser for video download
  const htmlPath = join(skillDir, 'year_in_review.html')
  if (await pathExists(htmlPath)) {
    const platform = getPlatform()
    const openCmd = platform === 'macos' ? 'open' : platform === 'windows' ? 'start' : 'xdg-open'
    void execFileNoThrow(openCmd, [htmlPath])
  }
  return {
    success: true,
    message: 'Year in review animation complete!',
  }
}
type InstallState =
  | {
      phase: 'checking'
    }
  | {
      phase: 'installing-marketplace'
    }
  | {
      phase: 'installing-plugin'
    }
  | {
      phase: 'enabling-plugin'
    }
  | {
      phase: 'ready'
    }
  | {
      phase: 'error'
      message: string
    }
function ThinkbackInstaller({
  onReady,
  onError,
}: {
  onReady: () => void
  onError: (message: string) => void
}): React.ReactNode {
  const [state, setState] = useState<InstallState>({
    phase: 'checking',
  })
  const [progressMessage, setProgressMessage] = useState('')
  useEffect(() => {
    async function checkAndInstall(): Promise<void> {
      try {
        // Check if marketplace is installed
        const knownMarketplaces = await loadKnownMarketplacesConfig()
        const marketplaceName = getMarketplaceName()
        const marketplaceRepo = getMarketplaceRepo()
        const pluginId = getPluginId()
        const marketplaceInstalled = marketplaceName in knownMarketplaces

        // Check if plugin is already installed first
        const pluginAlreadyInstalled = isPluginInstalled(pluginId)
        if (!marketplaceInstalled) {
          // Install the marketplace
          setState({
            phase: 'installing-marketplace',
          })
          logForDebugging(`Installing marketplace ${marketplaceRepo}`)
          await addMarketplaceSource(
            {
              source: 'github',
              repo: marketplaceRepo,
            },
            (message) => {
              setProgressMessage(message)
            },
          )
          clearAllCaches()
          logForDebugging(`Marketplace ${marketplaceName} installed`)
        } else if (!pluginAlreadyInstalled) {
          // Marketplace installed but plugin not installed - refresh to get latest plugins
          // Only refresh when needed to avoid potentially destructive git operations
          setState({
            phase: 'installing-marketplace',
          })
          setProgressMessage('Updating marketplace…')
          logForDebugging(`Refreshing marketplace ${marketplaceName}`)
          await refreshMarketplace(marketplaceName, (message_0) => {
            setProgressMessage(message_0)
          })
          clearMarketplacesCache()
          clearAllCaches()
          logForDebugging(`Marketplace ${marketplaceName} refreshed`)
        }
        if (!pluginAlreadyInstalled) {
          // Install the plugin
          setState({
            phase: 'installing-plugin',
          })
          logForDebugging(`Installing plugin ${pluginId}`)
          const result = await installSelectedPlugins([pluginId])
          if (result.failed.length > 0) {
            const errorMsg = result.failed.map((f) => `${f.name}: ${f.error}`).join(', ')
            throw new Error(`Failed to install plugin: ${errorMsg}`)
          }
          clearAllCaches()
          logForDebugging(`Plugin ${pluginId} installed`)
        } else {
          // Plugin is installed, check if it's enabled
          const { disabled } = await loadAllPlugins()
          const isDisabled = disabled.some(
            (p) => p.name === 'thinkback' || p.source?.includes(pluginId),
          )
          if (isDisabled) {
            // Enable the plugin
            setState({
              phase: 'enabling-plugin',
            })
            logForDebugging(`Enabling plugin ${pluginId}`)
            const enableResult = await enablePluginOp(pluginId)
            if (!enableResult.success) {
              throw new Error(`Failed to enable plugin: ${enableResult.message}`)
            }
            clearAllCaches()
            logForDebugging(`Plugin ${pluginId} enabled`)
          }
        }
        setState({
          phase: 'ready',
        })
        onReady()
      } catch (error) {
        const err = toError(error)
        logError(err)
        setState({
          phase: 'error',
          message: err.message,
        })
        onError(err.message)
      }
    }
    void checkAndInstall()
  }, [onReady, onError])
  if (state.phase === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="error">
          {tSync('thinkback.errorPrefix')} {state.message}
        </Text>
      </Box>
    )
  }
  if (state.phase === 'ready') {
    return null
  }
  const statusMessage =
    state.phase === 'checking'
      ? tSync('thinkback.checkingInstallation')
      : state.phase === 'installing-marketplace'
        ? tSync('thinkback.installingMarketplace')
        : state.phase === 'enabling-plugin'
          ? tSync('thinkback.enablingPlugin')
          : tSync('thinkback.installingPlugin')
  return (
    <Box flexDirection="column">
      <Box>
        <Spinner />
        <Text>{progressMessage || statusMessage}</Text>
      </Box>
    </Box>
  )
}
type MenuAction = 'play' | 'edit' | 'fix' | 'regenerate'
type GenerativeAction = Exclude<MenuAction, 'play'>
function ThinkbackMenu({
  onDone,
  onAction,
  skillDir,
  hasGenerated,
}: {
  onDone: LocalJSXCommandOnDone
  onAction: (action: GenerativeAction) => void
  skillDir: string
  hasGenerated: boolean
}) {
  const [hasSelected, setHasSelected] = useState(false)
  const options = hasGenerated
    ? [
        {
          label: tSync('thinkback.playAnimation'),
          value: 'play' as const,
          description: tSync('thinkback.playAnimationDesc'),
        },
        {
          label: tSync('thinkback.editContent'),
          value: 'edit' as const,
          description: tSync('thinkback.editContentDesc'),
        },
        {
          label: tSync('thinkback.fixErrors'),
          value: 'fix' as const,
          description: tSync('thinkback.fixErrorsDesc'),
        },
        {
          label: tSync('thinkback.regenerate'),
          value: 'regenerate' as const,
          description: tSync('thinkback.regenerateDesc'),
        },
      ]
    : [
        {
          label: tSync('thinkback.letsGo'),
          value: 'regenerate' as const,
          description: tSync('thinkback.generateAnimation'),
        },
      ]
  const handleSelect = function handleSelect(value: MenuAction) {
    setHasSelected(true)
    if (value === 'play') {
      playAnimation(skillDir).then(() => {
        onDone(undefined, {
          display: 'skip',
        })
      })
    } else {
      onAction(value)
    }
  }
  const handleCancel = function handleCancel() {
    onDone(undefined, {
      display: 'skip',
    })
  }
  if (hasSelected) {
    return null
  }
  return (
    <Dialog
      title={tSync('thinkback.dialogTitle')}
      subtitle={tSync('thinkback.dialogSubtitle')}
      onCancel={handleCancel}
      color="zy"
    >
      {
        <Box flexDirection="column" gap={1}>
          {!hasGenerated && (
            <Box flexDirection="column">
              <Text>{tSync('thinkback.reliveYear')}</Text>
              <Text dimColor={true}>{tSync('thinkback.personalizedAnimation')}</Text>
            </Box>
          )}
          {<Select options={options} onChange={handleSelect} visibleOptionCount={5} />}
        </Box>
      }
    </Dialog>
  )
}
const EDIT_PROMPT =
  'Use the Skill tool to invoke the "thinkback" skill with mode=edit to modify my existing ZY Code year in review animation. Ask me what I want to change. When the animation is ready, tell the user to run /think-back again to play it.'
const FIX_PROMPT =
  'Use the Skill tool to invoke the "thinkback" skill with mode=fix to fix validation or rendering errors in my existing ZY Code year in review animation. Run the validator, identify errors, and fix them. When the animation is ready, tell the user to run /think-back again to play it.'
const REGENERATE_PROMPT =
  'Use the Skill tool to invoke the "thinkback" skill with mode=regenerate to create a completely new ZY Code year in review animation from scratch. Delete the existing animation and start fresh. When the animation is ready, tell the user to run /think-back again to play it.'
function ThinkbackFlow({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  const [installComplete, setInstallComplete] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [skillDir, setSkillDir] = useState<string | null>(null)
  const [hasGenerated, setHasGenerated] = useState<boolean | null>(null)
  const handleReady = function handleReady() {
    setInstallComplete(true)
  }
  const handleError = (message: string) => {
    setInstallError(message)
    onDone(tSync('thinkback.errorWithThinkback', { message }), {
      display: 'system',
    })
  }
  useEffect(() => {
    if (installComplete && !skillDir && !installError) {
      getThinkbackSkillDir().then((dir) => {
        if (dir) {
          logForDebugging(`Thinkback skill directory: ${dir}`)
          setSkillDir(dir)
        } else {
          handleError(tSync('thinkback.skillDirNotFound'))
        }
      })
    }
  }, [installComplete, skillDir, installError, handleError])
  useEffect(() => {
    if (!skillDir) {
      return
    }
    const dataPath = join(skillDir, 'year_in_review.js')
    pathExists(dataPath).then((exists) => {
      logForDebugging(`Checking for ${dataPath}: ${exists ? 'found' : 'not found'}`)
      setHasGenerated(exists)
    })
  }, [skillDir])
  const handleAction = function handleAction(action: GenerativeAction) {
    const prompts: Record<GenerativeAction, string> = {
      edit: EDIT_PROMPT,
      fix: FIX_PROMPT,
      regenerate: REGENERATE_PROMPT,
    }
    onDone(prompts[action], {
      display: 'user',
      shouldQuery: true,
    })
  }
  if (installError) {
    return (
      <Box flexDirection="column">
        {
          <Text color="error">
            {tSync('thinkback.errorPrefix')} {installError}
          </Text>
        }
        {<Text dimColor={true}>{tSync('thinkback.tryManualInstall')}</Text>}
      </Box>
    )
  }
  if (!installComplete) {
    return <ThinkbackInstaller onReady={handleReady} onError={handleError} />
  }
  if (!skillDir || hasGenerated === null) {
    return (
      <Box>
        <Spinner />
        <Text>{tSync('thinkback.loadingSkill')}</Text>
      </Box>
    )
  }
  return (
    <ThinkbackMenu
      onDone={onDone}
      onAction={handleAction}
      skillDir={skillDir}
      hasGenerated={hasGenerated}
    />
  )
}
export async function call(
  onDone: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
      shouldQuery?: boolean
    },
  ) => void,
): Promise<React.ReactNode> {
  return <ThinkbackFlow onDone={onDone} />
}
