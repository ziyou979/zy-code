import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import chalk from 'chalk'
import type { ThemeName } from 'src/utils/theme.js'
import { supportsHyperlinks } from '../../ink/supportsHyperlinks.js'
import { color } from '../../ink/index.js'
import { maybeMarkProjectOnboardingComplete } from '../../services/settings/projectOnboardingState.js'
import type { ToolUseContext } from '../../tools/tool.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../types.js'
import {
  backupTerminalPreferences,
  checkAndRestoreTerminalBackup,
  getTerminalPlistPath,
  markTerminalSetupComplete,
} from '../../services/shell/appleTerminalBackup.js'
import { setupShellCompletion } from '../../services/cache/completionCache.js'
import { getGlobalConfig, saveGlobalConfig } from '../../services/config/config.js'
import { env } from '../../services/environment/env.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { isFsInaccessible } from '../../utils/errors.js'
import { execFileNoThrow } from '../../services/shell/execFileNoThrow.js'
import { addItemToJSONCArray, safeParseJSONC } from '../../utils/json.js'
import { logError } from '../../utils/log.js'
import { getPlatform } from '../../services/shell/platform.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { tSync } from '../../i18n/index.js'

const EOL = '\n'

// Terminals that natively support CSI u / Kitty keyboard protocol
const NATIVE_CSIU_TERMINALS: Record<string, string> = {
  ghostty: 'Ghostty',
  kitty: 'Kitty',
  'iTerm.app': 'iTerm2',
  WezTerm: 'WezTerm',
  WarpTerminal: 'Warp',
}

/**
 * Detect if we're running in a VSCode Remote SSH session.
 * In this case, keybindings need to be installed on the LOCAL machine,
 * not the remote server where Zy is running.
 */
function isVSCodeRemoteSSH(): boolean {
  const askpassMain = process.env.VSCODE_GIT_ASKPASS_MAIN ?? ''
  const path = process.env.PATH ?? ''

  // Check both env vars - VSCODE_GIT_ASKPASS_MAIN is more reliable when git extension
  // is active, and PATH is a fallback. Omit path separator for Windows compatibility.
  return (
    askpassMain.includes('.vscode-server') ||
    askpassMain.includes('.cursor-server') ||
    askpassMain.includes('.windsurf-server') ||
    path.includes('.vscode-server') ||
    path.includes('.cursor-server') ||
    path.includes('.windsurf-server')
  )
}
export function getNativeCSIuTerminalDisplayName(): string | null {
  if (!env.terminal || !(env.terminal in NATIVE_CSIU_TERMINALS)) {
    return null
  }
  return NATIVE_CSIU_TERMINALS[env.terminal] ?? null
}

/**
 * Format a file path as a clickable hyperlink.
 *
 * Paths containing spaces (e.g., "Application Support") are not clickable
 * in most terminals - they get split at the space. OSC 8 hyperlinks solve
 * this by embedding a file:// URL that the terminal can open on click,
 * while displaying the clean path to the user.
 *
 * Unlike createHyperlink(), this doesn't apply any color styling so the
 * path inherits the parent's styling (e.g., chalk.dim).
 */
function formatPathLink(filePath: string): string {
  if (!supportsHyperlinks()) {
    return filePath
  }
  const fileUrl = pathToFileURL(filePath).href
  // OSC 8 hyperlink: \e]8;;URL\a TEXT \e]8;;\a
  return `\x1b]8;;${fileUrl}\x07${filePath}\x1b]8;;\x07`
}
export function shouldOfferTerminalSetup(): boolean {
  // iTerm2, WezTerm, Ghostty, Kitty, and Warp natively support CSI u / Kitty
  // keyboard protocol, which ZY Code already parses. No setup needed for
  // these terminals.
  return (
    (platform() === 'darwin' && env.terminal === 'Apple_Terminal') ||
    env.terminal === 'vscode' ||
    env.terminal === 'cursor' ||
    env.terminal === 'windsurf' ||
    env.terminal === 'alacritty' ||
    env.terminal === 'zed'
  )
}
export async function setupTerminal(theme: ThemeName): Promise<string> {
  let result = ''
  switch (env.terminal) {
    case 'Apple_Terminal':
      result = await enableOptionAsMetaForTerminal(theme)
      break
    case 'vscode':
      result = await installBindingsForVSCodeTerminal('VSCode', theme)
      break
    case 'cursor':
      result = await installBindingsForVSCodeTerminal('Cursor', theme)
      break
    case 'windsurf':
      result = await installBindingsForVSCodeTerminal('Windsurf', theme)
      break
    case 'alacritty':
      result = await installBindingsForAlacritty(theme)
      break
    case 'zed':
      result = await installBindingsForZed(theme)
      break
    case null:
      break
  }
  saveGlobalConfig((current) => {
    if (['vscode', 'cursor', 'windsurf', 'alacritty', 'zed'].includes(env.terminal ?? '')) {
      if (current.shiftEnterKeyBindingInstalled === true) {
        return current
      }
      return {
        ...current,
        shiftEnterKeyBindingInstalled: true,
      }
    } else if (env.terminal === 'Apple_Terminal') {
      if (current.optionAsMetaKeyInstalled === true) {
        return current
      }
      return {
        ...current,
        optionAsMetaKeyInstalled: true,
      }
    }
    return current
  })
  maybeMarkProjectOnboardingComplete()

  // Install shell completions (ant-only, since the completion command is ant-only)
  if (isInternalBuild()) {
    result += await setupShellCompletion()
  }
  return result
}
export function isShiftEnterKeyBindingInstalled(): boolean {
  return getGlobalConfig().shiftEnterKeyBindingInstalled === true
}
export function hasUsedBackslashReturn(): boolean {
  return getGlobalConfig().hasUsedBackslashReturn === true
}
export function markBackslashReturnUsed(): void {
  const config = getGlobalConfig()
  if (!config.hasUsedBackslashReturn) {
    saveGlobalConfig((current) => ({
      ...current,
      hasUsedBackslashReturn: true,
    }))
  }
}
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  _args: string,
): Promise<null> {
  if (env.terminal && env.terminal in NATIVE_CSIU_TERMINALS) {
    const message = tSync('terminalSetup.nativeSupported', {
      terminal: NATIVE_CSIU_TERMINALS[env.terminal]!,
    })
    onDone(message)
    return null
  }

  // Check if terminal is supported
  if (!shouldOfferTerminalSetup()) {
    const terminalName = env.terminal || tSync('terminalSetup.currentTerminal')
    const currentPlatform = getPlatform()

    // Build platform-specific terminal suggestions
    let platformTerminals = ''
    if (currentPlatform === 'macos') {
      platformTerminals = tSync('terminalSetup.macosTerminals')
    } else if (currentPlatform === 'windows') {
      platformTerminals = tSync('terminalSetup.windowsTerminals')
    }
    // For Linux and other platforms, we don't show native terminal options
    // since they're not currently supported

    const message = `${tSync('terminalSetup.cannotRunFrom', { terminal: terminalName })}

${tSync('terminalSetup.configuresShortcut')}
${chalk.dim(tSync('terminalSetup.backslashNote'))}

${tSync('terminalSetup.setupSteps')}
${platformTerminals}${tSync('terminalSetup.ideTerminals')}
${tSync('terminalSetup.persistNote')}

${chalk.dim(tSync('terminalSetup.nativeNote'))}`
    onDone(message)
    return null
  }
  const result = await setupTerminal(context.options.theme)
  onDone(result)
  return null
}
type VSCodeKeybinding = {
  key: string
  command: string
  args: {
    text: string
  }
  when: string
}
async function installBindingsForVSCodeTerminal(
  editor: 'VSCode' | 'Cursor' | 'Windsurf' = 'VSCode',
  theme: ThemeName,
): Promise<string> {
  // Check if we're running in a VSCode Remote SSH session
  // In this case, keybindings need to be installed on the LOCAL machine
  if (isVSCodeRemoteSSH()) {
    return `${color('warning', theme)(tSync('terminalSetup.cannotInstallRemote', { editor }))}${EOL}${EOL}${tSync('terminalSetup.remoteInstallHint', { editor })}${EOL}${EOL}${tSync('terminalSetup.installSteps')}${EOL}1. ${tSync('terminalSetup.stepOpenLocal', { editor })}${EOL}2. ${tSync('terminalSetup.stepCommandPalette')}${EOL}3. ${tSync('terminalSetup.stepAddBinding')}${EOL}${EOL}${chalk.dim(`[
  {
    "key": "shift+enter",
    "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "\\u001b\\r" },
    "when": "terminalFocus"
  }
]`)}${EOL}`
  }
  const editorDir = editor === 'VSCode' ? 'Code' : editor
  const userDirPath = join(
    homedir(),
    platform() === 'win32'
      ? join('AppData', 'Roaming', editorDir, 'User')
      : platform() === 'darwin'
        ? join('Library', 'Application Support', editorDir, 'User')
        : join('.config', editorDir, 'User'),
  )
  const keybindingsPath = join(userDirPath, 'keybindings.json')
  try {
    // Ensure user directory exists (idempotent with recursive)
    await mkdir(userDirPath, {
      recursive: true,
    })

    // Read existing keybindings file, or default to empty array if it doesn't exist
    let content = '[]'
    let keybindings: VSCodeKeybinding[] = []
    let fileExists = false
    try {
      content = await readFile(keybindingsPath, {
        encoding: 'utf-8',
      })
      fileExists = true
      keybindings = (safeParseJSONC(content) as VSCodeKeybinding[]) ?? []
    } catch (e: unknown) {
      if (!isFsInaccessible(e)) {
        throw e
      }
    }

    // Backup the existing file before modifying it
    if (fileExists) {
      const randomSha = randomBytes(4).toString('hex')
      const backupPath = `${keybindingsPath}.${randomSha}.bak`
      try {
        await copyFile(keybindingsPath, backupPath)
      } catch {
        return `${color('warning', theme)(tSync('terminalSetup.backupError', { editor }))}${EOL}${chalk.dim(tSync('terminalSetup.seePath', { path: formatPathLink(keybindingsPath) }))}${EOL}${chalk.dim(tSync('terminalSetup.backupPath', { path: formatPathLink(backupPath) }))}${EOL}`
      }
    }

    // Check if keybinding already exists
    const existingBinding = keybindings.find(
      (binding) =>
        binding.key === 'shift+enter' &&
        binding.command === 'workbench.action.terminal.sendSequence' &&
        binding.when === 'terminalFocus',
    )
    if (existingBinding) {
      return `${color('warning', theme)(tSync('terminalSetup.foundExisting', { editor }))}${EOL}${chalk.dim(tSync('terminalSetup.seePath', { path: formatPathLink(keybindingsPath) }))}${EOL}`
    }

    // Create the new keybinding
    const newKeybinding: VSCodeKeybinding = {
      key: 'shift+enter',
      command: 'workbench.action.terminal.sendSequence',
      args: {
        text: '\u001b\r',
      },
      when: 'terminalFocus',
    }

    // Modify the content by adding the new keybinding while preserving comments and formatting
    const updatedContent = addItemToJSONCArray(content, newKeybinding)

    // Write the updated content back to the file
    await writeFile(keybindingsPath, updatedContent, {
      encoding: 'utf-8',
    })
    return `${color('success', theme)(tSync('terminalSetup.installSuccessVscode', { editor }))}${EOL}${chalk.dim(tSync('terminalSetup.seePath', { path: formatPathLink(keybindingsPath) }))}${EOL}`
  } catch (error) {
    logError(error)
    throw new Error(tSync('terminalSetup.installFailed', { editor }))
  }
}
async function enableOptionAsMetaForProfile(profileName: string): Promise<boolean> {
  // First try to add the property (in case it doesn't exist)
  // Quote the profile name to handle names with spaces (e.g., "Man Page", "Red Sands")
  const { code: addCode } = await execFileNoThrow('/usr/libexec/PlistBuddy', [
    '-c',
    `Add :'Window Settings':'${profileName}':useOptionAsMetaKey bool true`,
    getTerminalPlistPath(),
  ])

  // If adding fails (likely because it already exists), try setting it instead
  if (addCode !== 0) {
    const { code: setCode } = await execFileNoThrow('/usr/libexec/PlistBuddy', [
      '-c',
      `Set :'Window Settings':'${profileName}':useOptionAsMetaKey true`,
      getTerminalPlistPath(),
    ])
    if (setCode !== 0) {
      logError(
        new Error(`Failed to enable Option as Meta key for Terminal.app profile: ${profileName}`),
      )
      return false
    }
  }
  return true
}
async function disableAudioBellForProfile(profileName: string): Promise<boolean> {
  // First try to add the property (in case it doesn't exist)
  // Quote the profile name to handle names with spaces (e.g., "Man Page", "Red Sands")
  const { code: addCode } = await execFileNoThrow('/usr/libexec/PlistBuddy', [
    '-c',
    `Add :'Window Settings':'${profileName}':Bell bool false`,
    getTerminalPlistPath(),
  ])

  // If adding fails (likely because it already exists), try setting it instead
  if (addCode !== 0) {
    const { code: setCode } = await execFileNoThrow('/usr/libexec/PlistBuddy', [
      '-c',
      `Set :'Window Settings':'${profileName}':Bell false`,
      getTerminalPlistPath(),
    ])
    if (setCode !== 0) {
      logError(new Error(`Failed to disable audio bell for Terminal.app profile: ${profileName}`))
      return false
    }
  }
  return true
}

// Enable Option as Meta key for Terminal.app
async function enableOptionAsMetaForTerminal(theme: ThemeName): Promise<string> {
  try {
    // Create a backup of the current plist file
    const backupPath = await backupTerminalPreferences()
    if (!backupPath) {
      throw new Error(tSync('terminalSetup.backupFailed'))
    }

    // Read the current default profile from the plist
    const { stdout: defaultProfile, code: readCode } = await execFileNoThrow('defaults', [
      'read',
      'com.apple.Terminal',
      'Default Window Settings',
    ])
    if (readCode !== 0 || !defaultProfile.trim()) {
      throw new Error(tSync('terminalSetup.failedReadDefaultProfile'))
    }
    const { stdout: startupProfile, code: startupCode } = await execFileNoThrow('defaults', [
      'read',
      'com.apple.Terminal',
      'Startup Window Settings',
    ])
    if (startupCode !== 0 || !startupProfile.trim()) {
      throw new Error(tSync('terminalSetup.failedReadStartupProfile'))
    }
    let wasAnyProfileUpdated = false
    const defaultProfileName = defaultProfile.trim()
    const optionAsMetaEnabled = await enableOptionAsMetaForProfile(defaultProfileName)
    const audioBellDisabled = await disableAudioBellForProfile(defaultProfileName)
    if (optionAsMetaEnabled || audioBellDisabled) {
      wasAnyProfileUpdated = true
    }
    const startupProfileName = startupProfile.trim()

    // Only proceed if the startup profile is different from the default profile
    if (startupProfileName !== defaultProfileName) {
      const startupOptionAsMetaEnabled = await enableOptionAsMetaForProfile(startupProfileName)
      const startupAudioBellDisabled = await disableAudioBellForProfile(startupProfileName)
      if (startupOptionAsMetaEnabled || startupAudioBellDisabled) {
        wasAnyProfileUpdated = true
      }
    }
    if (!wasAnyProfileUpdated) {
      throw new Error(
        tSync('terminalSetup.failedConfigureProfiles'),
      )
    }

    // Flush the preferences cache
    await execFileNoThrow('killall', ['cfprefsd'])
    markTerminalSetupComplete()
    return `${color('success', theme)(tSync('terminalSetup.configuredSettings'))}${EOL}${color('success', theme)(tSync('terminalSetup.enabledOptionAsMeta'))}${EOL}${color('success', theme)(tSync('terminalSetup.switchedToVisualBell'))}${EOL}${chalk.dim(tSync('terminalSetup.optionEnterNewline'))}${EOL}${chalk.dim(tSync('terminalSetup.restartRequired'))}${EOL}`
  } catch (error) {
    logError(error)

    // Attempt to restore from backup
    const restoreResult = await checkAndRestoreTerminalBackup()
    const errorMessage = tSync('terminalSetup.failedEnableOptionAsMeta')
    if (restoreResult.status === 'restored') {
      throw new Error(`${errorMessage} ${tSync('terminalSetup.settingsRestored')}`)
    } else if (restoreResult.status === 'failed') {
      throw new Error(
        `${errorMessage} ${tSync('terminalSetup.restoreFailedManual', { backupPath: restoreResult.backupPath })}`,
      )
    } else {
      throw new Error(`${errorMessage} ${tSync('terminalSetup.noBackupAvailable')}`)
    }
  }
}
async function installBindingsForAlacritty(theme: ThemeName): Promise<string> {
  const ALACRITTY_KEYBINDING = `[[keyboard.bindings]]
key = "Return"
mods = "Shift"
chars = "\\u001B\\r"`

  // Get Alacritty config file paths in order of preference
  const configPaths: string[] = []

  // XDG config path (Linux and macOS)
  const xdgConfigHome = process.env.XDG_CONFIG_HOME
  if (xdgConfigHome) {
    configPaths.push(join(xdgConfigHome, 'alacritty', 'alacritty.toml'))
  } else {
    configPaths.push(join(homedir(), '.config', 'alacritty', 'alacritty.toml'))
  }

  // Windows-specific path
  if (platform() === 'win32') {
    const appData = process.env.APPDATA
    if (appData) {
      configPaths.push(join(appData, 'alacritty', 'alacritty.toml'))
    }
  }

  // Find existing config file by attempting to read it, or use first preferred path
  let configPath: string | null = null
  let configContent = ''
  let configExists = false
  for (const path of configPaths) {
    try {
      configContent = await readFile(path, {
        encoding: 'utf-8',
      })
      configPath = path
      configExists = true
      break
    } catch (e: unknown) {
      if (!isFsInaccessible(e)) {
        throw e
      }
      // File missing or inaccessible — try next config path
    }
  }

  // If no config exists, use the first path (XDG/default location)
  if (!configPath) {
    configPath = configPaths[0] ?? null
  }
  if (!configPath) {
    throw new Error(tSync('terminalSetup.noConfigPathAlacritty'))
  }
  try {
    if (configExists) {
      // Check if keybinding already exists (look for Shift+Return binding)
      if (configContent.includes('mods = "Shift"') && configContent.includes('key = "Return"')) {
        return `${color('warning', theme)(tSync('terminalSetup.foundExistingAlacritty'))}${EOL}${chalk.dim(tSync('terminalSetup.seePath', { path: formatPathLink(configPath) }))}${EOL}`
      }

      // Create backup
      const randomSha = randomBytes(4).toString('hex')
      const backupPath = `${configPath}.${randomSha}.bak`
      try {
        await copyFile(configPath, backupPath)
      } catch {
        return `${color('warning', theme)(tSync('terminalSetup.backupErrorAlacritty'))}${EOL}${chalk.dim(tSync('terminalSetup.seePath', { path: formatPathLink(configPath) }))}${EOL}${chalk.dim(tSync('terminalSetup.backupPath', { path: formatPathLink(backupPath) }))}${EOL}`
      }
    } else {
      // Ensure config directory exists (idempotent with recursive)
      await mkdir(dirname(configPath), {
        recursive: true,
      })
    }

    // Add the keybinding to the config
    let updatedContent = configContent
    if (configContent && !configContent.endsWith('\n')) {
      updatedContent += '\n'
    }
    updatedContent += `\n${ALACRITTY_KEYBINDING}\n`

    // Write the updated config
    await writeFile(configPath, updatedContent, {
      encoding: 'utf-8',
    })
    return `${color('success', theme)(tSync('terminalSetup.installSuccessAlacritty'))}${EOL}${color('success', theme)(tSync('terminalSetup.mayNeedRestartAlacritty'))}${EOL}${chalk.dim(tSync('terminalSetup.seePath', { path: formatPathLink(configPath) }))}${EOL}`
  } catch (error) {
    logError(error)
    throw new Error(tSync('terminalSetup.installFailedAlacritty'))
  }
}
async function installBindingsForZed(theme: ThemeName): Promise<string> {
  // Zed uses JSON keybindings similar to VSCode
  const zedDir = join(homedir(), '.config', 'zed')
  const keymapPath = join(zedDir, 'keymap.json')
  try {
    // Ensure zed directory exists (idempotent with recursive)
    await mkdir(zedDir, {
      recursive: true,
    })

    // Read existing keymap file, or default to empty array if it doesn't exist
    let keymapContent = '[]'
    let fileExists = false
    try {
      keymapContent = await readFile(keymapPath, {
        encoding: 'utf-8',
      })
      fileExists = true
    } catch (e: unknown) {
      if (!isFsInaccessible(e)) {
        throw e
      }
    }
    if (fileExists) {
      // Check if keybinding already exists
      if (keymapContent.includes('shift-enter')) {
        return `${color('warning', theme)(tSync('terminalSetup.foundExistingZed'))}${EOL}${chalk.dim(tSync('terminalSetup.seePath', { path: formatPathLink(keymapPath) }))}${EOL}`
      }

      // Create backup
      const randomSha = randomBytes(4).toString('hex')
      const backupPath = `${keymapPath}.${randomSha}.bak`
      try {
        await copyFile(keymapPath, backupPath)
      } catch {
        return `${color('warning', theme)(tSync('terminalSetup.backupErrorZed'))}${EOL}${chalk.dim(tSync('terminalSetup.seePath', { path: formatPathLink(keymapPath) }))}${EOL}${chalk.dim(tSync('terminalSetup.backupPath', { path: formatPathLink(backupPath) }))}${EOL}`
      }
    }

    // Parse and modify the keymap
    let keymap: Array<{
      context?: string
      bindings: Record<string, string | string[]>
    }>
    try {
      keymap = jsonParse(keymapContent)
      if (!Array.isArray(keymap)) {
        keymap = []
      }
    } catch {
      keymap = []
    }

    // Add the new keybinding for terminal context
    keymap.push({
      context: 'Terminal',
      bindings: {
        'shift-enter': ['terminal::SendText', '\u001b\r'],
      },
    })

    // Write the updated keymap
    await writeFile(keymapPath, `${jsonStringify(keymap, null, 2)}\n`, {
      encoding: 'utf-8',
    })
    return `${color('success', theme)(tSync('terminalSetup.installSuccessZed'))}${EOL}${chalk.dim(tSync('terminalSetup.seePath', { path: formatPathLink(keymapPath) }))}${EOL}`
  } catch (error) {
    logError(error)
    throw new Error(tSync('terminalSetup.installFailedZed'))
  }
}
