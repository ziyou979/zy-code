import { logForDebugging } from '../../services/infra/debug.js'
import { which } from '../shell/which.js'

// 会话级缓存，避免重复检查
const binaryCache = new Map<string, boolean>()

/**
 * 检查系统中是否已安装且可使用指定二进制文件或命令。
 * Unix 系统（macOS、Linux、WSL）使用 `which`，Windows 使用 `where`。
 *
 * @param command 待检查的命令名，例如 `gopls`、`rust-analyzer`
 * @returns 命令存在时为 true，否则为 false
 */
export async function isBinaryInstalled(command: string): Promise<boolean> {
  // 边界情况：命令为空或仅含空白
  if (!command?.trim()) {
    logForDebugging('[binaryCheck] Empty command provided, returning false')
    return false
  }

  // 去除命令两端空白
  const trimmedCommand = command.trim()

  // 优先检查缓存
  const cached = binaryCache.get(trimmedCommand)
  if (cached !== undefined) {
    logForDebugging(`[binaryCheck] Cache hit for '${trimmedCommand}': ${cached}`)
    return cached
  }

  let exists = false
  if (await which(trimmedCommand).catch(() => null)) {
    exists = true
  }

  // 缓存检查结果
  binaryCache.set(trimmedCommand, exists)

  logForDebugging(`[binaryCheck] Binary '${trimmedCommand}' ${exists ? 'found' : 'not found'}`)

  return exists
}

/**
 * 清除二进制文件检查缓存，供测试使用。
 */
export function clearBinaryCache(): void {
  binaryCache.clear()
}
