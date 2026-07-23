import {
  execFileNoThrow,
  execFileNoThrowWithCwd,
  execSyncWithDefaults_DEPRECATED,
} from '../shell/execFileNoThrow.js'
import { getFsImplementation } from '../../services/infra/fsOperations.js'
import { getPlatform } from '../shell/platform.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'
import type { IdeType } from './ideTypes.js'

export const EXTENSION_ID = isInternalBuild() ? 'anthropic.zy-code-internal' : 'anthropic.zy-code'

type VsCodeSupportArgs = {
  ideType: IdeType
  isVSCodeIde: (ide: IdeType | null) => boolean
}

function getInstallationEnv(): NodeJS.ProcessEnv | undefined {
  // Cursor on Linux 可能把 code 命令错误实现为直接拉起 GUI。
  // 清空 DISPLAY 让这类误调用直接失败，避免安装流程弹出新窗口。
  if (getPlatform() === 'linux') {
    return {
      ...process.env,
      DISPLAY: '',
    }
  }
  return undefined
}

async function isExecutableAvailable(command: string, args: string[]): Promise<boolean> {
  const result = await execFileNoThrow(command, args)
  return result.code === 0
}

/**
 * 检测 Cursor IDE 是否已安装
 */
export async function isCursorInstalled(): Promise<boolean> {
  return isExecutableAvailable('cursor', ['--version'])
}

/**
 * 检测 Windsurf IDE 是否已安装
 */
export async function isWindsurfInstalled(): Promise<boolean> {
  return isExecutableAvailable('windsurf', ['--version'])
}

/**
 * 检测 VSCode IDE 是否已安装
 */
export async function isVSCodeInstalled(): Promise<boolean> {
  const result = await execFileNoThrow('code', ['--help'])
  return result.code === 0 && Boolean(result.stdout?.includes('Visual Studio Code'))
}

function getZyCodeVersion(): string {
  return MACRO.VERSION
}

async function getInstalledVSCodeExtensionVersion(command: string): Promise<string | null> {
  const { stdout } = await execFileNoThrow(command, ['--list-extensions', '--show-versions'], {
    env: getInstallationEnv(),
  })
  const lines = stdout?.split('\n') || []
  for (const line of lines) {
    const [extensionId, version] = line.split('@')
    if (extensionId === 'anthropic.zy-code' && version) {
      return version
    }
  }
  return null
}

function getVSCodeIDECommandByParentProcess(): string | null {
  try {
    const platform = getPlatform()
    if (platform !== 'macos') {
      return null
    }

    let pid = process.ppid
    for (let index = 0; index < 10; index++) {
      if (!pid || pid === 0 || pid === 1) {
        break
      }

      const command = execSyncWithDefaults_DEPRECATED(
        // eslint-disable-next-line custom-rules/no-direct-ps-commands
        `ps -o command= -p ${pid}`,
      )?.trim()

      if (command) {
        const appNames = {
          'Visual Studio Code.app': 'code',
          'Cursor.app': 'cursor',
          'Windsurf.app': 'windsurf',
          'Visual Studio Code - Insiders.app': 'code',
          'VSCodium.app': 'codium',
        }
        const pathToExecutable = '/Contents/MacOS/Electron'

        for (const [appName, executableName] of Object.entries(appNames)) {
          const appIndex = command.indexOf(appName + pathToExecutable)
          if (appIndex !== -1) {
            const folderPathEnd = appIndex + appName.length
            return `${command.substring(0, folderPathEnd)}/Contents/Resources/app/bin/${executableName}`
          }
        }
      }

      const ppidStr = execSyncWithDefaults_DEPRECATED(
        // eslint-disable-next-line custom-rules/no-direct-ps-commands
        `ps -o ppid= -p ${pid}`,
      )?.trim()
      if (!ppidStr) {
        break
      }
      pid = parseInt(ppidStr.trim(), 10)
    }

    return null
  } catch {
    return null
  }
}

async function getVSCodeIDECommand(ideType: IdeType): Promise<string | null> {
  const parentExecutable = getVSCodeIDECommandByParentProcess()
  if (parentExecutable) {
    try {
      await getFsImplementation().stat(parentExecutable)
      return parentExecutable
    } catch {
      // 父进程推断出的 CLI 路径不存在时，回退到常规命令名探测。
    }
  }

  const ext = getPlatform() === 'windows' ? '.cmd' : ''
  switch (ideType) {
    case 'vscode':
      return `code${ext}`
    case 'cursor':
      return `cursor${ext}`
    case 'windsurf':
      return `windsurf${ext}`
    default:
      return null
  }
}

/**
 * 检查指定 IDE 类型是否已安装 ZY Code 扩展
 */
export async function isIDEExtensionInstalledForType({
  ideType,
  isVSCodeIde,
}: VsCodeSupportArgs): Promise<boolean> {
  if (!isVSCodeIde(ideType)) {
    return false
  }

  const command = await getVSCodeIDECommand(ideType)
  if (!command) {
    return false
  }

  try {
    const result = await execFileNoThrowWithCwd(command, ['--list-extensions'], {
      env: getInstallationEnv(),
    })
    return Boolean(result.stdout?.includes(EXTENSION_ID))
  } catch {
    return false
  }
}

export {
  getInstallationEnv,
  getInstalledVSCodeExtensionVersion,
  getZyCodeVersion,
  getVSCodeIDECommand,
  type VsCodeSupportArgs,
}
