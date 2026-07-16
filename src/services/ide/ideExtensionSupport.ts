import * as os from 'node:os'
import { join } from 'node:path'
import axios from 'axios'
import {
  execFileNoThrow,
  execFileNoThrowWithCwd,
  execSyncWithDefaults_DEPRECATED,
} from '../shell/execFileNoThrow.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { logError } from '../../utils/log.js'
import { getPlatform } from '../shell/platform.js'
import { lt } from '../../utils/semver.js'
import { sleep } from '../../utils/sleep.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import type { IdeType } from './ide.js'

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

async function installFromArtifactory(command: string): Promise<string> {
  const npmrcPath = join(os.homedir(), '.npmrc')
  let authToken: string | null = null
  const fs = getFsImplementation()

  try {
    const npmrcContent = await fs.readFile(npmrcPath, {
      encoding: 'utf8',
    })
    const lines = npmrcContent.split('\n')
    for (const line of lines) {
      const match = line.match(
        /\/\/artifactory\.infra\.ant\.dev\/artifactory\/api\/npm\/npm-all\/:_authToken=(.+)/,
      )
      if (match?.[1]) {
        authToken = match[1].trim()
        break
      }
    }
  } catch (error) {
    logError(error as Error)
    throw new Error(`Failed to read npm authentication: ${error}`)
  }

  if (!authToken) {
    throw new Error('No artifactory auth token found in ~/.npmrc')
  }

  const versionUrl =
    'https://artifactory.infra.ant.dev/artifactory/armorcode-zy-code-internal/zy-vscode-releases/stable'

  try {
    const versionResponse = await axios.get(versionUrl, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    })

    const version = versionResponse.data.trim()
    if (!version) {
      throw new Error('No version found in artifactory response')
    }

    const vsixUrl = `https://artifactory.infra.ant.dev/artifactory/armorcode-zy-code-internal/zy-vscode-releases/${version}/zy-code.vsix`
    const tempVsixPath = join(os.tmpdir(), `zy-code-${version}-${Date.now()}.vsix`)

    try {
      const vsixResponse = await axios.get(vsixUrl, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
        responseType: 'stream',
      })

      const writeStream = getFsImplementation().createWriteStream(tempVsixPath)
      await new Promise<void>((resolve, reject) => {
        vsixResponse.data.pipe(writeStream)
        writeStream.on('finish', resolve)
        writeStream.on('error', reject)
      })

      await sleep(500)

      const result = await execFileNoThrowWithCwd(
        command,
        ['--force', '--install-extension', tempVsixPath],
        {
          env: getInstallationEnv(),
        },
      )

      if (result.code !== 0) {
        throw new Error(`${result.code}: ${result.error} ${result.stderr}`)
      }

      return version
    } finally {
      try {
        await fs.unlink(tempVsixPath)
      } catch {
        // 忽略临时文件清理失败，避免掩盖真实安装结果。
      }
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(`Failed to fetch extension version from artifactory: ${error.message}`)
    }
    throw error
  }
}

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

export async function installIDEExtensionForType({
  ideType,
  isVSCodeIde,
}: VsCodeSupportArgs): Promise<string | null> {
  if (!isVSCodeIde(ideType)) {
    return null
  }

  const command = await getVSCodeIDECommand(ideType)
  if (!command) {
    return null
  }

  // TODO: 自建 VSIX 分发后恢复 Artifactory 安装路径（原 ant.dev 不可访问）
  // if (isInternalBuild()) {
  //   return await installFromArtifactory(command)
  // }
  let version = await getInstalledVSCodeExtensionVersion(command)
  if (!version || lt(version, getZyCodeVersion())) {
    await sleep(500)
    const result = await execFileNoThrowWithCwd(
      command,
      ['--force', '--install-extension', 'anthropic.zy-code'],
      {
        env: getInstallationEnv(),
      },
    )
    if (result.code !== 0) {
      throw new Error(`${result.code}: ${result.error} ${result.stderr}`)
    }
    version = getZyCodeVersion()
  }
  return version
}

async function isExecutableAvailable(command: string, args: string[]): Promise<boolean> {
  const result = await execFileNoThrow(command, args)
  return result.code === 0
}

export async function isCursorInstalled(): Promise<boolean> {
  return isExecutableAvailable('cursor', ['--version'])
}

export async function isWindsurfInstalled(): Promise<boolean> {
  return isExecutableAvailable('windsurf', ['--version'])
}

export async function isVSCodeInstalled(): Promise<boolean> {
  const result = await execFileNoThrow('code', ['--help'])
  return result.code === 0 && Boolean(result.stdout?.includes('Visual Studio Code'))
}

void installFromArtifactory
