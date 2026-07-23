import * as os from 'node:os'
import { join } from 'node:path'
import axios from 'axios'
import { execFileNoThrowWithCwd } from '../shell/execFileNoThrow.js'
import { getFsImplementation } from '../../services/infra/fsOperations.js'
import { logError } from '../../services/infra/log.js'
import { getPlatform } from '../shell/platform.js'
import { lt } from '../../utils/semver.js'
import { sleep } from '../../utils/sleep.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'
import type { IdeType } from './ideTypes.js'
import {
  getInstallationEnv,
  getInstalledVSCodeExtensionVersion,
  getZyCodeVersion,
  getVSCodeIDECommand,
  EXTENSION_ID,
  type VsCodeSupportArgs,
} from './editorDiscovery.js'

/**
 * 安装 ZY Code 扩展到指定 IDE。
 * 如果已安装且版本匹配则跳过。
 */
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
        // 忽略临时文件清理失败
      }
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(`Failed to fetch extension version from artifactory: ${error.message}`)
    }
    throw error
  }
}

// 保留对内部构建安装函数的引用，当前未启用但保持编译可达
void installFromArtifactory
