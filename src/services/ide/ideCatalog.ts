/**
 * IDE 类型目录：类型、配置、展示名称等纯映射。
 *
 * 从 ide.ts 中提取，不依赖 IO 或外部状态。
 */
import { basename } from 'node:path'
import capitalize from 'lodash-es/capitalize.js'
import memoize from 'lodash-es/memoize.js'
import { env } from '../environment/env.js'
import { envDynamic } from '../environment/envDynamic.js'
import type { IdeType } from './ideTypes.js'

export type DetectedIDEInfo = {
  name: string
  url: string
  isValid: boolean
  authToken?: string
  ideRunningInWindows?: boolean
}

export type IdeConfig = {
  ideKind: 'vscode' | 'jetbrains'
  displayName: string
  processKeywordsMac: string[]
  processKeywordsWindows: string[]
  processKeywordsLinux: string[]
}

export const supportedIdeConfigs: Record<IdeType, IdeConfig> = {
  cursor: {
    ideKind: 'vscode',
    displayName: 'Cursor',
    processKeywordsMac: ['Cursor Helper', 'Cursor.app'],
    processKeywordsWindows: ['cursor.exe'],
    processKeywordsLinux: ['cursor'],
  },
  windsurf: {
    ideKind: 'vscode',
    displayName: 'Windsurf',
    processKeywordsMac: ['Windsurf Helper', 'Windsurf.app'],
    processKeywordsWindows: ['windsurf.exe'],
    processKeywordsLinux: ['windsurf'],
  },
  vscode: {
    ideKind: 'vscode',
    displayName: 'VS Code',
    processKeywordsMac: ['Visual Studio Code', 'Code Helper'],
    processKeywordsWindows: ['code.exe'],
    processKeywordsLinux: ['code'],
  },
  intellij: {
    ideKind: 'jetbrains',
    displayName: 'IntelliJ IDEA',
    processKeywordsMac: ['idea', 'idea.sh'],
    processKeywordsWindows: ['idea64.exe'],
    processKeywordsLinux: ['idea.sh'],
  },
  pycharm: {
    ideKind: 'jetbrains',
    displayName: 'PyCharm',
    processKeywordsMac: ['pycharm', 'pycharm.sh'],
    processKeywordsWindows: ['pycharm64.exe'],
    processKeywordsLinux: ['pycharm.sh'],
  },
  webstorm: {
    ideKind: 'jetbrains',
    displayName: 'WebStorm',
    processKeywordsMac: ['webstorm', 'webstorm.sh'],
    processKeywordsWindows: ['webstorm64.exe'],
    processKeywordsLinux: ['webstorm.sh'],
  },
  phpstorm: {
    ideKind: 'jetbrains',
    displayName: 'PhpStorm',
    processKeywordsMac: ['phpstorm', 'phpstorm.sh'],
    processKeywordsWindows: ['phpstorm64.exe'],
    processKeywordsLinux: ['phpstorm.sh'],
  },
  rubymine: {
    ideKind: 'jetbrains',
    displayName: 'RubyMine',
    processKeywordsMac: ['rubymine', 'rubymine.sh'],
    processKeywordsWindows: ['rubymine64.exe'],
    processKeywordsLinux: ['rubymine.sh'],
  },
  clion: {
    ideKind: 'jetbrains',
    displayName: 'CLion',
    processKeywordsMac: ['clion', 'clion.sh'],
    processKeywordsWindows: ['clion64.exe'],
    processKeywordsLinux: ['clion.sh'],
  },
  goland: {
    ideKind: 'jetbrains',
    displayName: 'GoLand',
    processKeywordsMac: ['goland', 'goland.sh'],
    processKeywordsWindows: ['goland64.exe'],
    processKeywordsLinux: ['goland.sh'],
  },
  rider: {
    ideKind: 'jetbrains',
    displayName: 'Rider',
    processKeywordsMac: ['rider', 'rider.sh'],
    processKeywordsWindows: ['rider64.exe'],
    processKeywordsLinux: ['rider.sh'],
  },
  datagrip: {
    ideKind: 'jetbrains',
    displayName: 'DataGrip',
    processKeywordsMac: ['datagrip', 'datagrip.sh'],
    processKeywordsWindows: ['datagrip64.exe'],
    processKeywordsLinux: ['datagrip.sh'],
  },
  appcode: {
    ideKind: 'jetbrains',
    displayName: 'AppCode',
    processKeywordsMac: ['appcode', 'appcode.sh'],
    processKeywordsWindows: [],
    processKeywordsLinux: [],
  },
  dataspell: {
    ideKind: 'jetbrains',
    displayName: 'DataSpell',
    processKeywordsMac: ['dataspell', 'dataspell.sh'],
    processKeywordsWindows: ['dataspell64.exe'],
    processKeywordsLinux: ['dataspell.sh'],
  },
  aqua: {
    ideKind: 'jetbrains',
    displayName: 'Aqua',
    processKeywordsMac: ['aqua', 'aqua.sh'],
    processKeywordsWindows: ['aqua64.exe'],
    processKeywordsLinux: ['aqua.sh'],
  },
  gateway: {
    ideKind: 'jetbrains',
    displayName: 'Gateway',
    processKeywordsMac: ['gateway', 'gateway.sh'],
    processKeywordsWindows: ['gateway64.exe'],
    processKeywordsLinux: ['gateway.sh'],
  },
  fleet: {
    ideKind: 'jetbrains',
    displayName: 'Fleet',
    processKeywordsMac: ['fleet'],
    processKeywordsWindows: ['fleet.exe'],
    processKeywordsLinux: ['fleet'],
  },
  androidstudio: {
    ideKind: 'jetbrains',
    displayName: 'Android Studio',
    processKeywordsMac: ['Android Studio'],
    processKeywordsWindows: ['studio64.exe'],
    processKeywordsLinux: ['studio.sh'],
  },
}

export function isVSCodeIde(ide: IdeType | null): boolean {
  if (!ide) return false
  const config = supportedIdeConfigs[ide]
  return config && config.ideKind === 'vscode'
}

export function isJetBrainsIde(ide: IdeType | null): boolean {
  if (!ide) return false
  const config = supportedIdeConfigs[ide]
  return config && config.ideKind === 'jetbrains'
}

export const isSupportedVSCodeTerminal = memoize(() => {
  return isVSCodeIde(env.terminal as IdeType)
})

export const isSupportedJetBrainsTerminal = memoize(() => {
  return isJetBrainsIde(envDynamic.terminal as IdeType)
})

export const isSupportedTerminal = memoize(() => {
  return (
    isSupportedVSCodeTerminal() ||
    isSupportedJetBrainsTerminal() ||
    Boolean(process.env.FORCE_CODE_TERMINAL)
  )
})

export function getTerminalIdeType(): IdeType | null {
  if (isSupportedVSCodeTerminal()) {
    return env.terminal as IdeType
  }
  if (isSupportedJetBrainsTerminal()) {
    return envDynamic.terminal as IdeType
  }
  return null
}

const EDITOR_DISPLAY_NAMES: Record<string, string> = {
  code: 'VS Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  antigravity: 'Antigravity',
  vi: 'Vim',
  vim: 'Vim',
  nano: 'nano',
  notepad: 'Notepad',
  'start /wait notepad': 'Notepad',
  emacs: 'Emacs',
  subl: 'Sublime Text',
  atom: 'Atom',
}

export function toIDEDisplayName(terminal: string | null): string {
  if (!terminal) {
    return 'IDE'
  }

  const config = supportedIdeConfigs[terminal as IdeType]
  if (config) {
    return config.displayName
  }

  // Check editor command names (exact match first)
  const editorName = EDITOR_DISPLAY_NAMES[terminal.toLowerCase().trim()]
  if (editorName) {
    return editorName
  }

  // Extract command name from path/arguments (e.g., "/usr/bin/code --wait" -> "code")
  const command = terminal.split(' ')[0]
  const commandName = command ? basename(command).toLowerCase() : null
  if (commandName) {
    const mappedName = EDITOR_DISPLAY_NAMES[commandName]
    if (mappedName) {
      return mappedName
    }
    // Fallback: capitalize the command basename
    return capitalize(commandName)
  }

  // Fallback: capitalize first letter
  return capitalize(terminal)
}
