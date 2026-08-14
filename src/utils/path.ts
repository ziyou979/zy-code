import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { getCwd } from '../services/environment/cwd.js'
import { getFsImplementation } from '../services/infra/fsOperations.js'
import { getPlatform } from '../services/shell/platform.js'
import { posixPathToWindowsPath } from '../services/shell/windowsPaths.js'

/**
 * 将可能含波浪号（~）的路径展开为绝对路径。
 *
 * 在 Windows 上，POSIX 风格路径（如 `/c/Users/...`）会自动转换为 Windows 格式
 *（如 `C:\Users\...`）。函数始终返回当前平台的原生路径格式。
 *
 * @param path - The path to expand, may contain:
 *   - `~` - expands to user's home directory
 *   - `~/path` - expands to path within user's home directory
 *   - absolute paths - returned normalized
 *   - relative paths - resolved relative to baseDir
 *   - POSIX paths on Windows - converted to Windows format
 * @param baseDir - The base directory for resolving relative paths (defaults to current working directory)
 * @returns The expanded absolute path in the native format for the current platform
 *
 * @throws {Error} If path is invalid
 *
 * @example
 * expandPath('~') // '/home/user'
 * expandPath('~/Documents') // '/home/user/Documents'
 * expandPath('./src', '/project') // '/project/src'
 * expandPath('/absolute/path') // '/absolute/path'
 */
export function expandPath(path: string, baseDir?: string): string {
  // 未提供 baseDir 时默认使用 getCwd()
  const actualBaseDir = baseDir ?? getCwd() ?? getFsImplementation().cwd()

  // 输入校验
  if (typeof path !== 'string') {
    throw new TypeError(`Path must be a string, received ${typeof path}`)
  }

  if (typeof actualBaseDir !== 'string') {
    throw new TypeError(`Base directory must be a string, received ${typeof actualBaseDir}`)
  }

  // 安全检查：拒绝 null byte
  if (path.includes('\0') || actualBaseDir.includes('\0')) {
    throw new Error('Path contains null bytes')
  }

  // 处理空路径或仅含空白的路径
  const trimmedPath = path.trim()
  if (!trimmedPath) {
    return normalize(actualBaseDir).normalize('NFC')
  }

  // 处理 home 目录表示法
  if (trimmedPath === '~') {
    return homedir().normalize('NFC')
  }

  if (trimmedPath.startsWith('~/')) {
    return join(homedir(), trimmedPath.slice(2)).normalize('NFC')
  }

  // Windows 上将 POSIX 风格路径（如 /c/Users/...）转换为 Windows 格式
  let processedPath = trimmedPath
  if (getPlatform() === 'windows' && trimmedPath.match(/^\/[a-z]\//i)) {
    try {
      processedPath = posixPathToWindowsPath(trimmedPath)
    } catch {
      // 转换失败时使用原始路径
      processedPath = trimmedPath
    }
  }

  // 处理绝对路径
  if (isAbsolute(processedPath)) {
    return normalize(processedPath).normalize('NFC')
  }

  // 处理相对路径
  return resolve(actualBaseDir, processedPath).normalize('NFC')
}

/**
 * 将绝对路径转换为相对于 cwd 的路径，以节省 tool 输出 token。
 * 路径位于 cwd 外部（相对路径会以 .. 开头）时原样返回绝对路径，避免歧义。
 *
 * @param absolutePath - The absolute path to relativize
 * @returns Relative path if under cwd, otherwise the original absolute path
 */
export function toRelativePath(absolutePath: string): string {
  const relativePath = relative(getCwd(), absolutePath)
  // 相对路径会越出 cwd（以 .. 开头）时保留绝对路径
  return relativePath.startsWith('..') ? absolutePath : relativePath
}

/**
 * 获取给定文件或目录路径对应的目录。路径本身是目录时原样返回；
 * 路径是文件或不存在时返回其父目录。
 *
 * @param path - The file or directory path
 * @returns The directory path
 */
export function getDirectoryForPath(path: string): string {
  const absolutePath = expandPath(path)
  // 安全边界：跳过 UNC 路径的文件系统操作，防止 NTLM 凭据泄漏。
  if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
    return dirname(absolutePath)
  }
  try {
    const stats = getFsImplementation().statSync(absolutePath)
    if (stats.isDirectory()) {
      return absolutePath
    }
  } catch {
    // 路径不存在或无法访问
  }
  // 路径不是目录或不存在时返回父目录
  return dirname(absolutePath)
}

/**
 * 检查路径是否包含向父目录跳转的目录遍历模式。
 *
 * @param path - The path to check for traversal patterns
 * @returns true if the path contains traversal (e.g., '../', '..\', or ends with '..')
 */
export function containsPathTraversal(path: string): boolean {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path)
}

// 从共享的零依赖来源重新导出。
export { sanitizePath } from '../services/session-storage/sessionStoragePortable.js'

/**
 * 归一化路径以用作 JSON 配置键。Windows 路径可能因来自 git、Node.js API
 * 或用户输入而使用不同分隔符（C:\path 或 C:/path）；这里统一为正斜杠，
 * 确保 JSON 序列化结果一致。
 *
 * @param path - The path to normalize
 * @returns The normalized path with consistent forward slashes
 */
export function normalizePathForConfigKey(path: string): string {
  // 先用 Node 的 normalize 解析 . 和 .. 段
  const normalized = normalize(path)
  // 再把所有反斜杠转换为正斜杠，以保持 JSON 键一致；Windows 上多数路径操作
  // 也接受正斜杠，因此这样转换是安全的
  return normalized.replace(/\\/g, '/')
}
