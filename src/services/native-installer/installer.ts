/**
 * 原生安装器实现。
 *
 * 本模块实现 docs/native-installer.md 所述的文件型原生安装器系统，提供：
 * - 使用符号链接管理目录结构
 * - 版本安装与激活
 * - 通过锁保证多进程安全
 * - 基于修改时间的简单 fallback 机制
 * - 同时支持 JS 和原生构建
 */

import { constants as fsConstants, type Stats } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getMaxVersion, shouldSkipVersion } from '../updater/autoUpdater.js'
import { registerCleanup } from '../cleanup/cleanupRegistry.js'
import { getGlobalConfig, saveGlobalConfig } from '../config/config.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { getCurrentInstallationType } from '../doctor/doctorDiagnostic.js'
import { env } from '../environment/env.js'
import { envDynamic } from '../environment/envDynamic.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'
import { errorMessage, getErrnoCode, isENOENT, toError } from '../../utils/errors.js'
import { execFileNoThrowWithCwd } from '../shell/execFileNoThrow.js'
import { getShellType } from '../native-installer/localInstaller.js'
import * as lockfile from '../file-persistence/lockfile.js'
import { logError } from '../../services/infra/log.js'
import { gt, gte } from '../../utils/semver.js'
import {
  filterZyAliases,
  getShellConfigPaths,
  readFileLines,
  writeFileLines,
} from '../shell/shellConfig.js'
import { sleep } from '../../utils/sleep.js'
import {
  getUserBinDir,
  getXDGCacheHome,
  getXDGDataHome,
  getXDGStateHome,
} from '../environment/xdg.js'
import { downloadVersion, getLatestVersion } from './download.js'
import {
  acquireProcessLifetimeLock,
  cleanupStaleLocks,
  isLockActive,
  isPidBasedLockingEnabled,
  readLockContent,
  withLock,
} from './pidLock.js'

export const VERSION_RETENTION_COUNT = 2

// 7 天对应的毫秒数，用作基于 mtime 的锁过期时间。该时长足以覆盖笔记本休眠，
// 又能在合理时间内清理崩溃进程遗留的锁。
const LOCK_STALE_MS = 7 * 24 * 60 * 60 * 1000

export type SetupMessage = {
  message: string
  userActionRequired: boolean
  type: 'path' | 'alias' | 'info' | 'error'
}

export function getPlatform(): string {
  // 使用已处理平台检测且默认值为 'linux' 的 env.platform。
  const os = env.platform

  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null

  if (!arch) {
    const error = new Error(`Unsupported architecture: ${process.arch}`)
    logForDebugging(`Native installer does not support architecture: ${process.arch}`, {
      level: 'error',
    })
    throw error
  }

  // 在 Linux 上检测 musl，并相应调整 platform。
  if (os === 'linux' && envDynamic.isMuslEnvironment()) {
    return `linux-${arch}-musl`
  }

  return `${os}-${arch}`
}

export function getBinaryName(platform: string): string {
  return platform.startsWith('win32') ? 'zy.exe' : 'zy'
}

function getBaseDirectories() {
  const platform = getPlatform()
  const executableName = getBinaryName(platform)

  return {
    // 数据目录（永久存储）。
    versions: join(getXDGDataHome(), 'zy', 'versions'),

    // 缓存目录（可删除）。
    staging: join(getXDGCacheHome(), 'zy', 'staging'),

    // 状态目录。
    locks: join(getXDGStateHome(), 'zy', 'locks'),

    // 用户 bin 目录。
    executable: join(getUserBinDir(), executableName),
  }
}

async function isPossibleZyBinary(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath)
    // 下载前，同一 filePath 上的版本锁文件大小为 0；同时允许较小文件，
    // 因为较小的 wrapper script 也应视为有效。
    if (!stats.isFile() || stats.size === 0) {
      return false
    }

    // 检查文件是否可执行。注意：Windows 依赖扩展名（.exe、.bat、.cmd）和 ACL
    // 权限，而非 Unix 权限位，因此无法保证适用于 Windows 上的所有可执行文件。
    await access(filePath, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function getVersionPaths(version: string) {
  const dirs = getBaseDirectories()

  // 创建目录，但不创建作为文件的 executable path。
  const dirsToCreate = [dirs.versions, dirs.staging, dirs.locks]
  await Promise.all(dirsToCreate.map((dir) => mkdir(dir, { recursive: true })))

  // 确保可执行文件的父目录存在。
  const executableParentDir = dirname(dirs.executable)
  await mkdir(executableParentDir, { recursive: true })

  const installPath = join(dirs.versions, version)

  // 文件不存在时创建空文件。
  try {
    await stat(installPath)
  } catch {
    await writeFile(installPath, '', { encoding: 'utf8' })
  }

  return {
    stagingPath: join(dirs.staging, version),
    installPath,
  }
}

// 持有版本文件锁期间执行 callback。文件已被锁定时返回 false，
// callback 已执行时返回 true。
async function tryWithVersionLock(
  versionFilePath: string,
  callback: () => void | Promise<void>,
  retries = 0,
): Promise<boolean> {
  const dirs = getBaseDirectories()

  const lockfilePath = getLockFilePathFromVersionPath(dirs, versionFilePath)

  // 确保 locks 目录存在。
  await mkdir(dirs.locks, { recursive: true })

  if (isPidBasedLockingEnabled()) {
    // 使用基于 PID 的锁，并可选择重试。
    let attempts = 0
    const maxAttempts = retries + 1
    const minTimeout = retries > 0 ? 1000 : 100
    const maxTimeout = retries > 0 ? 5000 : 500

    while (attempts < maxAttempts) {
      const success = await withLock(versionFilePath, lockfilePath, async () => {
        try {
          await callback()
        } catch (error) {
          logError(error)
          throw error
        }
      })

      if (success) {
        logEvent('zy_version_lock_acquired', {
          is_pid_based: true,
          is_lifetime_lock: false,
          attempts: attempts + 1,
        })
        return true
      }

      attempts++
      if (attempts < maxAttempts) {
        // 按指数退避等待后重试。
        const timeout = Math.min(minTimeout * 2 ** (attempts - 1), maxTimeout)
        await sleep(timeout)
      }
    }

    logEvent('zy_version_lock_failed', {
      is_pid_based: true,
      is_lifetime_lock: false,
      attempts: maxAttempts,
    })
    logLockAcquisitionError(versionFilePath, new Error('Lock held by another process'))
    return false
  }

  // 使用基于 mtime 的锁（proper-lockfile），过期时间为 30 天。
  let release: (() => Promise<void>) | null = null
  try {
    // 获取锁阶段：捕获锁错误并返回 false。过期时间采用与 lockCurrentVersion()
    // 一致的 30 天，确保正常使用（包括笔记本休眠）时不会将运行中进程的锁视为过期，
    // 同时仍能最终清理崩溃进程遗留的锁，且足以覆盖任何现实会话时长。
    try {
      release = await lockfile.lock(versionFilePath, {
        stale: LOCK_STALE_MS,
        retries: {
          retries,
          minTimeout: retries > 0 ? 1000 : 100,
          maxTimeout: retries > 0 ? 5000 : 500,
        },
        lockfilePath,
        // 平稳处理锁失效，避免未处理拒绝。持锁期间另一进程删除锁目录时可能发生。
        onCompromised: (err: Error) => {
          logForDebugging(
            `NON-FATAL: Version lock was compromised during operation: ${err.message}`,
            { level: 'info' },
          )
        },
      })
    } catch (lockError) {
      logEvent('zy_version_lock_failed', {
        is_pid_based: false,
        is_lifetime_lock: false,
      })
      logLockAcquisitionError(versionFilePath, lockError)
      return false
    }

    // 操作阶段：记录错误，但继续向上传播。
    try {
      await callback()
      logEvent('zy_version_lock_acquired', {
        is_pid_based: false,
        is_lifetime_lock: false,
      })
      return true
    } catch (error) {
      logError(error)
      throw error
    }
  } finally {
    if (release) {
      await release()
    }
  }
}

async function atomicMoveToInstallPath(stagedBinaryPath: string, installPath: string) {
  // 安装目录不存在时创建。
  await mkdir(dirname(installPath), { recursive: true })

  // 从 staging 原子移动到最终位置。
  const tempInstallPath = `${installPath}.tmp.${process.pid}.${Date.now()}`

  try {
    // 先复制到 install path 旁的临时文件，再重命名。若 staging 与 install 位于
    // 不同文件系统，直接从 staging 重命名会因 EXDEV 失败。
    await copyFile(stagedBinaryPath, tempInstallPath)
    await chmod(tempInstallPath, 0o755)
    await rename(tempInstallPath, installPath)
    logForDebugging(`Atomically installed binary to ${installPath}`)
  } catch (error) {
    // 清理存在的临时文件。
    try {
      await unlink(tempInstallPath)
    } catch {
      // 忽略清理错误。
    }
    throw error
  }
}

async function installVersionFromPackage(stagingPath: string, installPath: string) {
  try {
    // 从 staging 中的 npm package 结构提取二进制文件。
    const nodeModulesDir = join(stagingPath, 'node_modules', '@anthropic-ai')
    const entries = await readdir(nodeModulesDir)
    const nativePackage = entries.find((entry: string) => entry.startsWith('zy-cli-native-'))

    if (!nativePackage) {
      logEvent('zy_native_install_package_failure', {
        stage_find_package: true,
        error_package_not_found: true,
      })
      const error = new Error('Could not find platform-specific native package')
      throw error
    }

    const stagedBinaryPath = join(nodeModulesDir, nativePackage, 'cli')

    try {
      await stat(stagedBinaryPath)
    } catch {
      logEvent('zy_native_install_package_failure', {
        stage_binary_exists: true,
        error_binary_not_found: true,
      })
      const error = new Error('Native binary not found in staged package')
      throw error
    }

    await atomicMoveToInstallPath(stagedBinaryPath, installPath)

    // 清理 staging 目录。
    await rm(stagingPath, { recursive: true, force: true })

    logEvent('zy_native_install_package_success', {})
  } catch (error) {
    // 若上方尚未记录，则记录日志。
    const msg = errorMessage(error)
    if (
      !msg.includes('Could not find platform-specific') &&
      !msg.includes('Native binary not found')
    ) {
      logEvent('zy_native_install_package_failure', {
        stage_atomic_move: true,
        error_move_failed: true,
      })
    }
    logError(toError(error))
    throw error
  }
}

async function installVersionFromBinary(stagingPath: string, installPath: string) {
  try {
    // 直接下载二进制文件时（GCS、通用 bucket），文件直接位于 staging 中。
    const platform = getPlatform()
    const binaryName = getBinaryName(platform)
    const stagedBinaryPath = join(stagingPath, binaryName)

    try {
      await stat(stagedBinaryPath)
    } catch {
      logEvent('zy_native_install_binary_failure', {
        stage_binary_exists: true,
        error_binary_not_found: true,
      })
      const error = new Error('Staged binary not found')
      throw error
    }

    await atomicMoveToInstallPath(stagedBinaryPath, installPath)

    // Clean up staging directory
    await rm(stagingPath, { recursive: true, force: true })

    logEvent('zy_native_install_binary_success', {})
  } catch (error) {
    if (!errorMessage(error).includes('Staged binary not found')) {
      logEvent('zy_native_install_binary_failure', {
        stage_atomic_move: true,
        error_move_failed: true,
      })
    }
    logError(toError(error))
    throw error
  }
}

async function installVersion(
  stagingPath: string,
  installPath: string,
  downloadType: 'npm' | 'binary',
) {
  // 使用明确的下载类型，不做猜测。
  if (downloadType === 'npm') {
    await installVersionFromPackage(stagingPath, installPath)
  } else {
    await installVersionFromBinary(stagingPath, installPath)
  }
}

/**
 * 执行核心更新操作：按需下载、安装并更新符号链接。
 * 返回是否进行了新安装，而非仅更新符号链接。
 */
async function performVersionUpdate(version: string, forceReinstall: boolean): Promise<boolean> {
  const { stagingPath: baseStagingPath, installPath } = await getVersionPaths(version)
  const { executable: executablePath } = getBaseDirectories()

  // 无锁更新使用唯一 staging 路径，避免并发下载冲突。
  const stagingPath = isEnvTruthy(process.env.ENABLE_LOCKLESS_UPDATES)
    ? `${baseStagingPath}.${process.pid}.${Date.now()}`
    : baseStagingPath

  // 尚未安装或要求强制重装时才下载。
  const needsInstall = !(await versionIsAvailable(version)) || forceReinstall
  if (needsInstall) {
    logForDebugging(
      forceReinstall
        ? `Force reinstalling native installer version ${version}`
        : `Downloading native installer version ${version}`,
    )
    const downloadType = await downloadVersion(version, stagingPath)
    await installVersion(stagingPath, installPath, downloadType)
  } else {
    logForDebugging(`Version ${version} already installed, updating symlink`)
  }

  // 创建从 ~/.local/bin/zy 到版本二进制文件的直接符号链接。
  await removeDirectoryIfEmpty(executablePath)
  await updateSymlink(executablePath, installPath)

  // 验证可执行文件确实已创建或更新。
  if (!(await isPossibleZyBinary(executablePath))) {
    let installPathExists = false
    try {
      await stat(installPath)
      installPathExists = true
    } catch {
      // installPath 不存在。
    }
    throw new Error(
      `Failed to create executable at ${executablePath}. ` +
        `Source file exists: ${installPathExists}. ` +
        `Check write permissions to ${executablePath}.`,
    )
  }
  return needsInstall
}

async function versionIsAvailable(version: string): Promise<boolean> {
  const { installPath } = await getVersionPaths(version)
  return isPossibleZyBinary(installPath)
}

async function updateLatest(
  channelOrVersion: string,
  forceReinstall: boolean = false,
): Promise<{
  success: boolean
  latestVersion: string
  lockFailed?: boolean
  lockHolderPid?: number
}> {
  const startTime = Date.now()
  let version = await getLatestVersion(channelOrVersion)
  const { executable: executablePath } = getBaseDirectories()

  logForDebugging(`Checking for native installer update to version ${version}`)

  // 检查是否设置最高版本，作为 auto-update 的服务端 kill switch。
  if (!forceReinstall) {
    const maxVersion = await getMaxVersion()
    if (maxVersion && gt(version, maxVersion)) {
      logForDebugging(
        `Native installer: maxVersion ${maxVersion} is set, capping update from ${version} to ${maxVersion}`,
      )
      // 当前版本已达到或超过 maxVersion 时完全跳过更新。
      if (gte(MACRO.VERSION, maxVersion)) {
        logForDebugging(
          `Native installer: current version ${MACRO.VERSION} is already at or above maxVersion ${maxVersion}, skipping update`,
        )
        logEvent('zy_native_update_skipped_max_version', {
          latency_ms: Date.now() - startTime,
          max_version: maxVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          available_version: version as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return { success: true, latestVersion: version }
      }
      version = maxVersion
    }
  }

  // 若当前运行的正是目标版本，且版本二进制文件与可执行文件均存在并有效，则提前退出。
  // 可执行文件不存在、无效（如安装失败留下空文件或损坏文件）或通过 npx 运行时仍需继续。
  if (
    !forceReinstall &&
    version === MACRO.VERSION &&
    (await versionIsAvailable(version)) &&
    (await isPossibleZyBinary(executablePath))
  ) {
    logForDebugging(`Found ${version} at ${executablePath}, skipping install`)
    logEvent('zy_native_update_complete', {
      latency_ms: Date.now() - startTime,
      was_new_install: false,
      was_force_reinstall: false,
      was_already_running: true,
    })
    return { success: true, latestVersion: version }
  }

  // 检查是否应因 minimumVersion 设置跳过此版本。
  if (!forceReinstall && shouldSkipVersion(version)) {
    logEvent('zy_native_update_skipped_minimum_version', {
      latency_ms: Date.now() - startTime,
      target_version: version as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return { success: true, latestVersion: version }
  }

  // 记录实际执行的是安装还是仅创建符号链接。
  let wasNewInstall = false
  let latencyMs: number

  if (isEnvTruthy(process.env.ENABLE_LOCKLESS_UPDATES)) {
    // 无锁模式依靠原子操作，错误向上传播。
    wasNewInstall = await performVersionUpdate(version, forceReinstall)
    latencyMs = Date.now() - startTime
  } else {
    // 基于锁的更新。
    const { installPath } = await getVersionPaths(version)
    // 强制重装时移除已有锁，以绕过过期锁。
    if (forceReinstall) {
      await forceRemoveLock(installPath)
    }

    const lockAcquired = await tryWithVersionLock(
      installPath,
      async () => {
        wasNewInstall = await performVersionUpdate(version, forceReinstall)
      },
      3, // retries
    )

    latencyMs = Date.now() - startTime

    // 获取锁失败，取得持锁进程 PID 以生成错误消息。
    if (!lockAcquired) {
      const dirs = getBaseDirectories()
      let lockHolderPid: number | undefined
      if (isPidBasedLockingEnabled()) {
        const lockfilePath = getLockFilePathFromVersionPath(dirs, installPath)
        if (isLockActive(lockfilePath)) {
          lockHolderPid = readLockContent(lockfilePath)?.pid
        }
      }
      logEvent('zy_native_update_lock_failed', {
        latency_ms: latencyMs,
        lock_holder_pid: lockHolderPid,
      })
      return {
        success: false,
        latestVersion: version,
        lockFailed: true,
        lockHolderPid,
      }
    }
  }

  logEvent('zy_native_update_complete', {
    latency_ms: latencyMs,
    was_new_install: wasNewInstall,
    was_force_reinstall: forceReinstall,
  })
  logForDebugging(`Successfully updated to version ${version}`)
  return { success: true, latestVersion: version }
}

// 导出供测试使用。
export async function removeDirectoryIfEmpty(path: string): Promise<void> {
  // 仅用 rmdir 即可处理所有情况：路径是文件时返回 ENOTDIR，目录非空时返回
  // ENOTEMPTY，不存在时返回 ENOENT，无需先执行 stat+readdir。
  try {
    await rmdir(path)
    logForDebugging(`Removed empty directory at ${path}`)
  } catch (error) {
    const code = getErrnoCode(error)
    // 非目录、不存在、非空均为预期情况，静默跳过。ENOTDIR 是常规路径，
    // 因为 executablePath 通常是符号链接。
    if (code !== 'ENOTDIR' && code !== 'ENOENT' && code !== 'ENOTEMPTY') {
      logForDebugging(`Could not remove directory at ${path}: ${error}`)
    }
  }
}

async function updateSymlink(symlinkPath: string, targetPath: string): Promise<boolean> {
  const platform = getPlatform()
  const isWindows = platform.startsWith('win32')

  // Windows 上直接复制可执行文件，不创建符号链接。
  if (isWindows) {
    try {
      // 确保父目录存在。
      const parentDir = dirname(symlinkPath)
      await mkdir(parentDir, { recursive: true })

      // 检查文件是否已存在且内容相同。
      let existingStats: Stats | undefined
      try {
        existingStats = await stat(symlinkPath)
      } catch {
        // symlinkPath 不存在。
      }

      if (existingStats) {
        try {
          const targetStats = await stat(targetPath)
          // 大小相同时假定文件相同，避免读取大型文件。
          if (existingStats.size === targetStats.size) {
            return false
          }
        } catch {
          // 无法比较时继续复制。
        }
        // 使用重命名策略处理 Windows 文件锁；与删除不同，即使可执行文件正在运行，
        // 重命名也始终可用。
        const oldFileName = `${symlinkPath}.old.${Date.now()}`
        await rename(symlinkPath, oldFileName)

        // 尝试复制新可执行文件，失败时回滚。
        try {
          await copyFile(targetPath, symlinkPath)
          // 成功后立即尝试非阻塞清理旧文件。
          try {
            await unlink(oldFileName)
          } catch {
            // 文件仍在运行，忽略；Windows 最终会清理。
          }
        } catch (copyError) {
          // 复制失败，恢复旧可执行文件。
          try {
            await rename(oldFileName, symlinkPath)
          } catch (restoreError) {
            // 严重情况：用户已无可用的可执行文件，优先报告恢复错误。
            const errorWithCause = new Error(`Failed to restore old executable: ${restoreError}`, {
              cause: copyError,
            })
            logError(errorWithCause)
            throw errorWithCause
          }
          throw copyError
        }
      } else {
        // 首次安装，没有已有文件可重命名。直接复制可执行文件，并处理 copyFile
        // 自身的 ENOENT，而非预先 stat()，以避免 TOCTOU 和额外 syscall。
        try {
          await copyFile(targetPath, symlinkPath)
        } catch (e) {
          if (isENOENT(e)) {
            throw new Error(`Source file does not exist: ${targetPath}`)
          }
          throw e
        }
      }
      // Windows 无需 chmod，可执行性由 .exe 扩展名决定。
      return true
    } catch (error) {
      logError(
        new Error(`Failed to copy executable from ${targetPath} to ${symlinkPath}: ${error}`),
      )
      return false
    }
  }

  // 非 Windows 平台沿用符号链接，并确保父目录存在，与上方 Windows 路径一致。
  const parentDir = dirname(symlinkPath)
  try {
    await mkdir(parentDir, { recursive: true })
    logForDebugging(`Created directory ${parentDir} for symlink`)
  } catch (mkdirError) {
    logError(new Error(`Failed to create directory ${parentDir}: ${mkdirError}`))
    return false
  }

  // 检查符号链接是否已存在并指向正确目标。
  try {
    let symlinkExists = false
    try {
      await stat(symlinkPath)
      symlinkExists = true
    } catch {
      // symlinkPath 不存在。
    }

    if (symlinkExists) {
      try {
        const currentTarget = await readlink(symlinkPath)
        const resolvedCurrentTarget = resolve(dirname(symlinkPath), currentTarget)
        const resolvedTargetPath = resolve(targetPath)

        if (resolvedCurrentTarget === resolvedTargetPath) {
          return false
        }
      } catch {
        // 路径存在但不是符号链接，将在下方移除。
      }

      // 创建新链接前移除已有文件或符号链接。
      await unlink(symlinkPath)
    }
  } catch (error) {
    logError(new Error(`Failed to check/remove existing symlink: ${error}`))
  }

  // 使用原子重命名避免竞态。先以临时名称创建符号链接，再原子重命名为最终名称，
  // 确保即使并发更新，符号链接也始终存在且有效。
  const tempSymlink = `${symlinkPath}.tmp.${process.pid}.${Date.now()}`
  try {
    await symlink(targetPath, tempSymlink)

    // 原子重命名为最终名称，并替换已有项。
    await rename(tempSymlink, symlinkPath)
    logForDebugging(`Atomically updated symlink ${symlinkPath} -> ${targetPath}`)
    return true
  } catch (error) {
    // 清理存在的临时符号链接。
    try {
      await unlink(tempSymlink)
    } catch {
      // 忽略清理错误。
    }
    logError(new Error(`Failed to create symlink from ${symlinkPath} to ${targetPath}: ${error}`))
    return false
  }
}

export async function checkInstall(force: boolean = false): Promise<SetupMessage[]> {
  // 环境变量禁用安装检查时全部跳过。
  if (isEnvTruthy(process.env.DISABLE_INSTALLATION_CHECKS)) {
    return []
  }

  // 获取实际安装类型和配置。
  const installationType = await getCurrentInstallationType()

  // 开发构建跳过检查；此前原生安装留下的 config.installMethod 不应在运行开发
  // 构建时触发警告。
  if (installationType === 'development') {
    return []
  }

  const config = getGlobalConfig()

  // 仅在以下情况显示警告：实际从原生安装运行；配置中显式将 installMethod 设为
  // 'native'；或安装过程传入 force=true。
  const shouldCheckNative =
    force || installationType === 'native' || config.installMethod === 'native'

  if (!shouldCheckNative) {
    return []
  }

  const dirs = getBaseDirectories()
  const messages: SetupMessage[] = []
  const localBinDir = dirname(dirs.executable)
  const resolvedLocalBinPath = resolve(localBinDir)
  const platform = getPlatform()
  const isWindows = platform.startsWith('win32')

  // 检查 bin 目录是否存在。
  try {
    await access(localBinDir)
  } catch {
    messages.push({
      message: `installMethod is native, but directory ${localBinDir} does not exist`,
      userActionRequired: true,
      type: 'error',
    })
  }

  // 检查 zy 可执行文件是否存在且有效。非 Windows 平台直接调用 readlink 并按 errno
  // 分流：ENOENT 表示缺失，EINVAL 表示存在但不是符号链接。这避免 access()→readlink()
  // 间删除导致误报“Not a symlink”的 TOCTOU。isPossibleZyBinary 内部会 stat 路径，
  // 因此不预先 access()，避免 access 与 stat 间的 TOCTOU。
  if (isWindows) {
    // Windows 上是复制的可执行文件，而非符号链接。
    if (!(await isPossibleZyBinary(dirs.executable))) {
      messages.push({
        message: `installMethod is native, but zy command is missing or invalid at ${dirs.executable}`,
        userActionRequired: true,
        type: 'error',
      })
    }
  } else {
    try {
      const target = await readlink(dirs.executable)
      const absoluteTarget = resolve(dirname(dirs.executable), target)
      if (!(await isPossibleZyBinary(absoluteTarget))) {
        messages.push({
          message: `Zy symlink points to missing or invalid binary: ${target}`,
          userActionRequired: true,
          type: 'error',
        })
      }
    } catch (e) {
      if (isENOENT(e)) {
        messages.push({
          message: `installMethod is native, but zy command not found at ${dirs.executable}`,
          userActionRequired: true,
          type: 'error',
        })
      } else {
        // EINVAL（非符号链接）或其他情况：按普通二进制文件检查。
        if (!(await isPossibleZyBinary(dirs.executable))) {
          messages.push({
            message: `${dirs.executable} exists but is not a valid Zy binary`,
            userActionRequired: true,
            type: 'error',
          })
        }
      }
    }
  }

  // 检查 bin 目录是否在 PATH 中。
  const isInCurrentPath = (process.env.PATH || '').split(delimiter).some((entry) => {
    try {
      const resolvedEntry = resolve(entry)
      // Windows 上不区分大小写比较路径。
      if (isWindows) {
        return resolvedEntry.toLowerCase() === resolvedLocalBinPath.toLowerCase()
      }
      return resolvedEntry === resolvedLocalBinPath
    } catch {
      return false
    }
  })

  if (!isInCurrentPath) {
    if (isWindows) {
      // Windows 专用 PATH 说明。
      const windowsBinPath = localBinDir.replace(/\//g, '\\')
      messages.push({
        message: `Native installation exists but ${windowsBinPath} is not in your PATH. Add it by opening: System Properties → Environment Variables → Edit User PATH → New → Add the path above. Then restart your terminal.`,
        userActionRequired: true,
        type: 'path',
      })
    } else {
      // Unix 风格 PATH 说明。
      const shellType = getShellType()
      const configPaths = getShellConfigPaths()
      const configFile = configPaths[shellType as keyof typeof configPaths]
      const displayPath = configFile ? configFile.replace(homedir(), '~') : 'your shell config file'

      messages.push({
        message: `Native installation exists but ~/.local/bin is not in your PATH. Run:\n\necho 'export PATH="$HOME/.local/bin:$PATH"' >> ${displayPath} && source ${displayPath}`,
        userActionRequired: true,
        type: 'path',
      })
    }
  }

  return messages
}

type InstallLatestResult = {
  latestVersion: string | null
  wasUpdated: boolean
  lockFailed?: boolean
  lockHolderPid?: number
}

// 进程内 singleflight 守卫。prompt suggestion overlay 切换时
// NativeAutoUpdater 会重新挂载（PromptInput.tsx:2916），isUpdating 守卫无法跨越
// 重挂载。此前每次重挂载都会启动新的 271MB 二进制下载，而旧下载仍在进行。
// 遥测显示 session 42fed33f 的 arrayBuffer 以约 650MB/s 增长至 91GB。
let inFlightInstall: Promise<InstallLatestResult> | null = null

export function installLatest(
  channelOrVersion: string,
  forceReinstall: boolean = false,
): Promise<InstallLatestResult> {
  if (forceReinstall) {
    return installLatestImpl(channelOrVersion, forceReinstall)
  }
  if (inFlightInstall) {
    logForDebugging('installLatest: joining in-flight call')
    return inFlightInstall
  }
  const promise = installLatestImpl(channelOrVersion, forceReinstall)
  inFlightInstall = promise
  const clear = (): void => {
    inFlightInstall = null
  }
  void promise.then(clear, clear)
  return promise
}

async function installLatestImpl(
  channelOrVersion: string,
  forceReinstall: boolean = false,
): Promise<InstallLatestResult> {
  const updateResult = await updateLatest(channelOrVersion, forceReinstall)

  if (!updateResult.success) {
    return {
      latestVersion: null,
      wasUpdated: false,
      lockFailed: updateResult.lockFailed,
      lockHolderPid: updateResult.lockHolderPid,
    }
  }

  // 安装成功；上方提前返回已覆盖失败情况。标记为 native，并禁用旧版 auto-updater
  // 以保护符号链接。
  const config = getGlobalConfig()
  if (config.installMethod !== 'native') {
    saveGlobalConfig((current) => ({
      ...current,
      installMethod: 'native',
      // 禁用旧版 auto-updater，防止 npm 会话删除原生符号链接。
      // 原生安装改用能正确识别原生安装的 NativeAutoUpdater。
      autoUpdates: false,
      // 标记为保护机制所致，而非用户偏好。
      autoUpdatesProtectedForNative: true,
    }))
    logForDebugging(
      'Native installer: Set installMethod to "native" and disabled legacy auto-updater for protection',
    )
  }

  void cleanupOldVersions()

  return {
    latestVersion: updateResult.latestVersion,
    wasUpdated: updateResult.success,
    lockFailed: false,
  }
}

async function getVersionFromSymlink(symlinkPath: string): Promise<string | null> {
  try {
    const target = await readlink(symlinkPath)
    const absoluteTarget = resolve(dirname(symlinkPath), target)
    if (await isPossibleZyBinary(absoluteTarget)) {
      return absoluteTarget
    }
  } catch {
    // 不是符号链接、路径不存在或目标不存在。
  }
  return null
}

function getLockFilePathFromVersionPath(
  dirs: ReturnType<typeof getBaseDirectories>,
  versionPath: string,
) {
  const versionName = basename(versionPath)
  return join(dirs.locks, `${versionName}.lock`)
}

/**
 * 为当前运行版本加锁，防止其被删除。锁在整个进程生命周期内保持。
 *
 * 启用时使用基于 PID 的锁，可立即检测崩溃进程；基于 mtime 的锁则需等待 30 天超时。
 */
export async function lockCurrentVersion(): Promise<void> {
  const dirs = getBaseDirectories()

  // 仅从 versions 目录运行时加锁。
  if (!process.execPath.includes(dirs.versions)) {
    return
  }

  const versionPath = resolve(process.execPath)
  try {
    const lockfilePath = getLockFilePathFromVersionPath(dirs, versionPath)

    // 确保 locks 目录存在。
    await mkdir(dirs.locks, { recursive: true })

    if (isPidBasedLockingEnabled()) {
      // 获取基于 PID 的锁并保持至进程结束。该机制可立即检测崩溃进程，
      // 同时能跨越笔记本休眠，因为进程虽挂起但 PID 仍存在。
      const acquired = await acquireProcessLifetimeLock(versionPath, lockfilePath)

      if (!acquired) {
        logEvent('zy_version_lock_failed', {
          is_pid_based: true,
          is_lifetime_lock: true,
        })
        logLockAcquisitionError(versionPath, new Error('Lock already held by another process'))
        return
      }

      logEvent('zy_version_lock_acquired', {
        is_pid_based: true,
        is_lifetime_lock: true,
      })
      logForDebugging(`Acquired PID lock on running version: ${versionPath}`)
    } else {
      // 获取基于 mtime 的锁并保持至进程退出。过期时间设为 30 天，避免正常使用时
      // 被误判过期；笔记本休眠会挂起进程并停止 mtime 心跳，因此这一点至关重要。
      // 30 天足以覆盖现实会话，也仍能最终清理遗留锁。
      let release: (() => Promise<void>) | undefined
      try {
        release = await lockfile.lock(versionPath, {
          stale: LOCK_STALE_MS,
          retries: 0, // Don't retry - if we can't lock, that's fine
          lockfilePath,
          // Handle lock compromise gracefully (e.g., if another process deletes the lock directory)
          onCompromised: (err: Error) => {
            logForDebugging(`NON-FATAL: Lock on running version was compromised: ${err.message}`, {
              level: 'info',
            })
          },
        })
        logEvent('zy_version_lock_acquired', {
          is_pid_based: false,
          is_lifetime_lock: true,
        })
        logForDebugging(`Acquired mtime-based lock on running version: ${versionPath}`)

        // 显式释放锁；proper-lockfile 的 cleanup 在 signal-exit v3+v4 下不可靠。
        registerCleanup(async () => {
          try {
            await release?.()
          } catch {
            // 锁可能已释放。
          }
        })
      } catch (lockError) {
        if (isENOENT(lockError)) {
          logForDebugging(`Cannot lock current version - file does not exist: ${versionPath}`, {
            level: 'info',
          })
          return
        }
        logEvent('zy_version_lock_failed', {
          is_pid_based: false,
          is_lifetime_lock: true,
        })
        logLockAcquisitionError(versionPath, lockError)
        return
      }
    }
  } catch (error) {
    if (isENOENT(error)) {
      logForDebugging(`Cannot lock current version - file does not exist: ${versionPath}`, {
        level: 'info',
      })
      return
    }
    // 退回旧行为，不为运行中的版本加锁。大部分情况下可用，但使用 ripgrep 等
    // 原生二进制文件时会失败。
    logForDebugging(
      `NON-FATAL: Failed to lock current version during execution ${errorMessage(error)}`,
      { level: 'info' },
    )
  }
}

function logLockAcquisitionError(versionPath: string, lockError: unknown) {
  logError(
    new Error(
      `NON-FATAL: Lock acquisition failed for ${versionPath} (expected in multi-process scenarios)`,
      { cause: lockError },
    ),
  )
}

/**
 * 强制移除指定版本路径的锁文件。指定 --force 时用于绕过过期锁。
 */
async function forceRemoveLock(versionFilePath: string): Promise<void> {
  const dirs = getBaseDirectories()
  const lockfilePath = getLockFilePathFromVersionPath(dirs, versionFilePath)

  try {
    await unlink(lockfilePath)
    logForDebugging(`Force-removed lock file at ${lockfilePath}`)
  } catch (error) {
    // 记录但不抛错，仍会尝试获取锁。
    logForDebugging(`Failed to force-remove lock file: ${errorMessage(error)}`)
  }
}

export async function cleanupOldVersions(): Promise<void> {
  // 主动让出执行权，避免阻塞启动。
  await Promise.resolve()

  const dirs = getBaseDirectories()
  const oneHourAgo = Date.now() - 3600000

  // Windows 上清理旧的重命名可执行文件；启动时这些文件已不再运行。
  if (getPlatform().startsWith('win32')) {
    const executableDir = dirname(dirs.executable)
    try {
      const files = await readdir(executableDir)
      let cleanedCount = 0
      for (const file of files) {
        if (!/^zy\.exe\.old\.\d+$/.test(file)) {
          continue
        }
        try {
          await unlink(join(executableDir, file))
          cleanedCount++
        } catch {
          // 文件可能仍被其他进程使用。
        }
      }
      if (cleanedCount > 0) {
        logForDebugging(`Cleaned up ${cleanedCount} old Windows executables on startup`)
      }
    } catch (error) {
      if (!isENOENT(error)) {
        logForDebugging(`Failed to clean up old Windows executables: ${error}`)
      }
    }
  }

  // 清理超过 1 小时的孤立 staging 目录。
  try {
    const stagingEntries = await readdir(dirs.staging)
    let stagingCleanedCount = 0
    for (const entry of stagingEntries) {
      const stagingPath = join(dirs.staging, entry)
      try {
        // 此处必须使用 stat() 取得 mtime。理论上存在 TOCTOU：并发安装器可能在 stat
        // 与 rm 之间更新过期 staging 目录，但 1 小时阈值使其概率极低，且
        // rm({force:true}) 可容忍并发。
        // deletion.
        const stats = await stat(stagingPath)
        if (stats.mtime.getTime() < oneHourAgo) {
          await rm(stagingPath, { recursive: true, force: true })
          stagingCleanedCount++
          logForDebugging(`Cleaned up old staging directory: ${entry}`)
        }
      } catch {
        // 忽略单项错误。
      }
    }
    if (stagingCleanedCount > 0) {
      logForDebugging(`Cleaned up ${stagingCleanedCount} orphaned staging directories`)
      logEvent('zy_native_staging_cleanup', {
        cleaned_count: stagingCleanedCount,
      })
    }
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(`Failed to clean up staging directories: ${error}`)
    }
  }

  // 清理崩溃进程留下的过期 PID 锁；cleanupStaleLocks 会处理 ENOENT。
  if (isPidBasedLockingEnabled()) {
    const staleLocksCleaned = cleanupStaleLocks(dirs.locks)
    if (staleLocksCleaned > 0) {
      logForDebugging(`Cleaned up ${staleLocksCleaned} stale version locks`)
      logEvent('zy_native_stale_locks_cleanup', {
        cleaned_count: staleLocksCleaned,
      })
    }
  }

  // 仅 readdir versions 目录一次，将条目分为临时文件和候选二进制文件，
  // 每项最多 stat 一次。
  let versionEntries: string[]
  try {
    versionEntries = await readdir(dirs.versions)
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(`Failed to readdir versions directory: ${error}`)
    }
    return
  }

  type VersionInfo = {
    name: string
    path: string
    resolvedPath: string
    mtime: Date
  }
  const versionFiles: VersionInfo[] = []
  let tempFilesCleanedCount = 0

  for (const entry of versionEntries) {
    const entryPath = join(dirs.versions, entry)
    if (/\.tmp\.\d+\.\d+$/.test(entry)) {
      // 孤立临时安装文件，格式为 {version}.tmp.{pid}.{timestamp}。
      try {
        const stats = await stat(entryPath)
        if (stats.mtime.getTime() < oneHourAgo) {
          await unlink(entryPath)
          tempFilesCleanedCount++
          logForDebugging(`Cleaned up orphaned temp install file: ${entry}`)
        }
      } catch {
        // 忽略单项错误。
      }
      continue
    }
    // 候选版本二进制文件：stat 一次，并复用于 isFile/size/mtime/mode。
    try {
      const stats = await stat(entryPath)
      if (!stats.isFile()) {
        continue
      }
      if (process.platform !== 'win32' && stats.size > 0 && (stats.mode & 0o111) === 0) {
        // 通过已有 stat 结果的 mode bit 检查可执行性，避免第二次 syscall
        //（access(X_OK)）以及 stat 与 access 间的 TOCTOU。Windows 上跳过：libuv
        // 仅为 .exe/.com/.bat/.cmd 设置执行位，而版本文件是不带扩展名的 semver
        // 字符串（如 "1.2.3"），否则会全部被拒绝。此前 access(X_OK) 在 Windows
        // 上本来也会放行所有可读文件。
        continue
      }
      versionFiles.push({
        name: entry,
        path: entryPath,
        resolvedPath: resolve(entryPath),
        mtime: stats.mtime,
      })
    } catch {
      // 跳过无法 stat 的文件。
    }
  }

  if (tempFilesCleanedCount > 0) {
    logForDebugging(`Cleaned up ${tempFilesCleanedCount} orphaned temp install files`)
    logEvent('zy_native_temp_files_cleanup', {
      cleaned_count: tempFilesCleanedCount,
    })
  }

  if (versionFiles.length === 0) {
    return
  }

  try {
    // 识别受保护版本。
    const currentBinaryPath = process.execPath
    const protectedVersions = new Set<string>()
    if (currentBinaryPath?.includes(dirs.versions)) {
      protectedVersions.add(resolve(currentBinaryPath))
    }

    const currentSymlinkVersion = await getVersionFromSymlink(dirs.executable)
    if (currentSymlinkVersion) {
      protectedVersions.add(currentSymlinkVersion)
    }

    // 保护被其他运行中进程持有 active lock 的版本。
    for (const v of versionFiles) {
      if (protectedVersions.has(v.resolvedPath)) {
        continue
      }

      const lockFilePath = getLockFilePathFromVersionPath(dirs, v.resolvedPath)
      let hasActiveLock = false
      if (isPidBasedLockingEnabled()) {
        hasActiveLock = isLockActive(lockFilePath)
      } else {
        try {
          hasActiveLock = await lockfile.check(v.resolvedPath, {
            stale: LOCK_STALE_MS,
            lockfilePath: lockFilePath,
          })
        } catch {
          hasActiveLock = false
        }
      }
      if (hasActiveLock) {
        protectedVersions.add(v.resolvedPath)
        logForDebugging(`Protecting locked version from cleanup: ${v.name}`)
      }
    }

    // 可清理版本：不受保护，按最新优先排序，并复用缓存的 mtime。
    const eligibleVersions = versionFiles
      .filter((v) => !protectedVersions.has(v.resolvedPath))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

    const versionsToDelete = eligibleVersions.slice(VERSION_RETENTION_COUNT)

    if (versionsToDelete.length === 0) {
      logEvent('zy_native_version_cleanup', {
        total_count: versionFiles.length,
        deleted_count: 0,
        protected_count: protectedVersions.size,
        retained_count: VERSION_RETENTION_COUNT,
        lock_failed_count: 0,
        error_count: 0,
      })
      return
    }

    let deletedCount = 0
    let lockFailedCount = 0
    let errorCount = 0

    await Promise.all(
      versionsToDelete.map(async (version) => {
        try {
          const deleted = await tryWithVersionLock(version.path, async () => {
            await unlink(version.path)
          })
          if (deleted) {
            deletedCount++
          } else {
            lockFailedCount++
            logForDebugging(`Skipping deletion of ${version.name} - locked by another process`)
          }
        } catch (error) {
          errorCount++
          logError(new Error(`Failed to delete version ${version.name}: ${error}`))
        }
      }),
    )

    logEvent('zy_native_version_cleanup', {
      total_count: versionFiles.length,
      deleted_count: deletedCount,
      protected_count: protectedVersions.size,
      retained_count: VERSION_RETENTION_COUNT,
      lock_failed_count: lockFailedCount,
      error_count: errorCount,
    })
  } catch (error) {
    if (!isENOENT(error)) {
      logError(new Error(`Version cleanup failed: ${error}`))
    }
  }
}

/**
 * 检查指定路径是否由 npm 管理。
 * @param executablePath 要检查的路径，可以是符号链接
 * @returns 路径由 npm 管理时为 true，否则为 false
 */
async function isNpmSymlink(executablePath: string): Promise<boolean> {
  // 适用时将符号链接解析到目标。
  let targetPath = executablePath
  const stats = await lstat(executablePath)
  if (stats.isSymbolicLink()) {
    targetPath = await realpath(executablePath)
  }

  // npm prefix 可能变化，用户安装时也可手动设置 --prefix，因此检查 prefix
  // 并不可靠；改用以下启发式规则：
  return targetPath.endsWith('.js') || targetPath.includes('node_modules')
}

/**
 * 从可执行目录移除 zy 符号链接。切换离开原生安装时使用；
 * 仅移除原生二进制符号链接，不移除 npm 管理的 JS 文件。
 */
export async function removeInstalledSymlink(): Promise<void> {
  const dirs = getBaseDirectories()

  try {
    // 检查是否为 npm 管理的安装。
    if (await isNpmSymlink(dirs.executable)) {
      logForDebugging(`Skipping removal of ${dirs.executable} - appears to be npm-managed`)
      return
    }

    // 这是原生二进制符号链接，可安全移除。
    await unlink(dirs.executable)
    logForDebugging(`Removed zy symlink at ${dirs.executable}`)
  } catch (error) {
    if (isENOENT(error)) {
      return
    }
    logError(new Error(`Failed to remove zy symlink: ${error}`))
  }
}

/**
 * 从 shell 配置文件清理旧 zy alias。仅处理 alias 移除，不设置 PATH。
 */
export async function cleanupShellAliases(): Promise<SetupMessage[]> {
  const messages: SetupMessage[] = []
  const configMap = getShellConfigPaths()

  for (const [shellType, configFile] of Object.entries(configMap)) {
    try {
      const lines = await readFileLines(configFile)
      if (!lines) {
        continue
      }

      const { filtered, hadAlias } = filterZyAliases(lines)

      if (hadAlias) {
        await writeFileLines(configFile, filtered)
        messages.push({
          message: `Removed zy alias from ${configFile}. Run: unalias zy`,
          userActionRequired: true,
          type: 'alias',
        })
        logForDebugging(`Cleaned up zy alias from ${shellType} config`)
      }
    } catch (error) {
      logError(error)
      messages.push({
        message: `Failed to clean up ${configFile}: ${error}`,
        userActionRequired: false,
        type: 'error',
      })
    }
  }

  return messages
}

async function manualRemoveNpmPackage(
  packageName: string,
): Promise<{ success: boolean; error?: string; warning?: string }> {
  try {
    // 获取 npm 全局 prefix。
    const prefixResult = await execFileNoThrowWithCwd('npm', ['config', 'get', 'prefix'])
    if (prefixResult.code !== 0 || !prefixResult.stdout) {
      return {
        success: false,
        error: 'Failed to get npm global prefix',
      }
    }

    const globalPrefix = prefixResult.stdout.trim()
    let manuallyRemoved = false

    // 尝试移除文件的辅助逻辑。单独使用 unlink 已足够；文件缺失时会抛出 ENOENT，
    // catch 会统一处理。预先 stat() 会增加一次 syscall，并引入 TOCTOU 窗口，
    // 使并发清理导致错误的 false 返回值。
    async function tryRemove(filePath: string, description: string) {
      try {
        await unlink(filePath)
        logForDebugging(`Manually removed ${description}: ${filePath}`)
        return true
      } catch {
        return false
      }
    }

    if (getPlatform().startsWith('win32')) {
      // Windows：只移除可执行文件，不移除 package 目录。
      const binCmd = join(globalPrefix, 'zy.cmd')
      const binPs1 = join(globalPrefix, 'zy.ps1')
      const binExe = join(globalPrefix, 'zy')

      if (await tryRemove(binCmd, 'bin script')) {
        manuallyRemoved = true
      }

      if (await tryRemove(binPs1, 'PowerShell script')) {
        manuallyRemoved = true
      }

      if (await tryRemove(binExe, 'bin executable')) {
        manuallyRemoved = true
      }
    } else {
      // Unix/Mac：只移除符号链接，不移除 package 目录。
      const binSymlink = join(globalPrefix, 'bin', 'zy')

      if (await tryRemove(binSymlink, 'bin symlink')) {
        manuallyRemoved = true
      }
    }

    if (manuallyRemoved) {
      logForDebugging(`Successfully removed ${packageName} manually`)
      const nodeModulesPath = getPlatform().startsWith('win32')
        ? join(globalPrefix, 'node_modules', packageName)
        : join(globalPrefix, 'lib', 'node_modules', packageName)

      return {
        success: true,
        warning: `${packageName} executables removed, but node_modules directory was left intact for safety. You may manually delete it later at: ${nodeModulesPath}`,
      }
    } else {
      return { success: false }
    }
  } catch (manualError) {
    logForDebugging(`Manual removal failed: ${manualError}`, {
      level: 'error',
    })
    return {
      success: false,
      error: `Manual removal failed: ${manualError}`,
    }
  }
}

async function attemptNpmUninstall(
  packageName: string,
): Promise<{ success: boolean; error?: string; warning?: string }> {
  const { code, stderr } = await execFileNoThrowWithCwd(
    'npm',
    ['uninstall', '-g', packageName],
    // eslint-disable-next-line custom-rules/no-process-cwd -- matches original behavior
    { cwd: process.cwd() },
  )

  if (code === 0) {
    logForDebugging(`Removed global npm installation of ${packageName}`)
    return { success: true }
  } else if (stderr && !stderr.includes('npm ERR! code E404')) {
    // 检查 ENOTEMPTY 错误，并尝试手动移除。
    if (stderr.includes('npm error code ENOTEMPTY')) {
      logForDebugging(`Failed to uninstall global npm package ${packageName}: ${stderr}`, {
        level: 'error',
      })
      logForDebugging(`Attempting manual removal due to ENOTEMPTY error`)

      const manualResult = await manualRemoveNpmPackage(packageName)
      if (manualResult.success) {
        return { success: true, warning: manualResult.warning }
      } else if (manualResult.error) {
        return {
          success: false,
          error: `Failed to remove global npm installation of ${packageName}: ${stderr}. Manual removal also failed: ${manualResult.error}`,
        }
      }
    }

    // 不是“package not found”错误时才报告。
    logForDebugging(`Failed to uninstall global npm package ${packageName}: ${stderr}`, {
      level: 'error',
    })
    return {
      success: false,
      error: `Failed to remove global npm installation of ${packageName}: ${stderr}`,
    }
  }

  return { success: false } // Package not found, not an error
}

export async function cleanupNpmInstallations(): Promise<{
  removed: number
  errors: string[]
  warnings: string[]
}> {
  const errors: string[] = []
  const warnings: string[] = []
  let removed = 0

  // 始终尝试移除 @anthropic-ai/zy-code。
  const codePackageResult = await attemptNpmUninstall('@anthropic-ai/zy-code')
  if (codePackageResult.success) {
    removed++
    if (codePackageResult.warning) {
      warnings.push(codePackageResult.warning)
    }
  } else if (codePackageResult.error) {
    errors.push(codePackageResult.error)
  }

  // MACRO.PACKAGE_URL 已定义且不同时也尝试移除。
  if (MACRO.PACKAGE_URL && MACRO.PACKAGE_URL !== '@anthropic-ai/zy-code') {
    const macroPackageResult = await attemptNpmUninstall(MACRO.PACKAGE_URL)
    if (macroPackageResult.success) {
      removed++
      if (macroPackageResult.warning) {
        warnings.push(macroPackageResult.warning)
      }
    } else if (macroPackageResult.error) {
      errors.push(macroPackageResult.error)
    }
  }

  // 检查 ~/.zy/local 下的本地安装。
  const localInstallDir = join(homedir(), '.zy', 'local')

  try {
    await rm(localInstallDir, { recursive: true })
    removed++
    logForDebugging(`Removed local installation at ${localInstallDir}`)
  } catch (error) {
    if (!isENOENT(error)) {
      errors.push(`Failed to remove ${localInstallDir}: ${error}`)
      logForDebugging(`Failed to remove local installation: ${error}`, {
        level: 'error',
      })
    }
  }

  return { removed, errors, warnings }
}
