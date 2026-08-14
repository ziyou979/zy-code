import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getErrnoCode } from '../utils/errors.js'
import { getAutoMemPath, isAutoMemoryEnabled } from './paths.js'

/**
 * 路径校验检测到遍历或注入尝试时抛出的错误。
 */
export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathTraversalError'
  }
}

/**
 * 通过拒绝危险模式来清理文件路径 key。
 * 检查 null 字节、URL 编码的路径遍历和其他注入向量。
 * 返回清理后的字符串，或抛出 PathTraversalError。
 */
function sanitizePathKey(key: string): string {
  // null 字节可在基于 C 的 syscall 中截断路径
  if (key.includes('\0')) {
    throw new PathTraversalError(`Null byte in path key: "${key}"`)
  }
  // URL 编码的路径遍历（如 %2e%2e%2f = ../）
  let decoded: string
  try {
    decoded = decodeURIComponent(key)
  } catch {
    // 非法百分号编码（如 %ZZ、单独的 %）不是有效 URL 编码，
    // 因此不可能形成 URL 编码的路径遍历
    decoded = key
  }
  if (decoded !== key && (decoded.includes('..') || decoded.includes('/'))) {
    throw new PathTraversalError(`URL-encoded traversal in path key: "${key}"`)
  }
  // Unicode 规范化攻击：全角 ．．／（U+FF0E U+FF0F）经 NFKC 规范化后会变为 ASCII ../。
  // path.resolve/fs.writeFile 虽将它们视为字面字节而非分隔符，
  // 但下游层或文件系统可能会规范化，因此出于纵深防御予以拒绝（PSR M22187 向量 4）。
  const normalized = key.normalize('NFKC')
  if (
    normalized !== key &&
    (normalized.includes('..') ||
      normalized.includes('/') ||
      normalized.includes('\\') ||
      normalized.includes('\0'))
  ) {
    throw new PathTraversalError(`Unicode-normalized traversal in path key: "${key}"`)
  }
  // 拒绝反斜杠（Windows 路径分隔符可被用作遍历向量）
  if (key.includes('\\')) {
    throw new PathTraversalError(`Backslash in path key: "${key}"`)
  }
  // 拒绝绝对路径
  if (key.startsWith('/')) {
    throw new PathTraversalError(`Absolute path key: "${key}"`)
  }
  return key
}

/**
 * team memory feature 是否启用。
 * Team memory 是 auto memory 的子目录，因此要求 auto memory 已启用。
 * 这可确保通过 env var 或 settings 禁用 auto memory 时，所有 team-memory consumer
 *（prompt、内容注入、同步 watcher、文件检测）的行为一致。
 */
export function isTeamMemoryEnabled(): boolean {
  if (!isAutoMemoryEnabled()) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('zy_herring_clock', false)
}

/**
 * 返回 team memory 路径：<memoryBase>/projects/<sanitized-project-root>/memory/team/
 * 它位于 auto-memory 目录下，按项目隔离。
 */
export function getTeamMemPath(): string {
  return (join(getAutoMemPath(), 'team') + sep).normalize('NFC')
}

/**
 * 返回 team memory 入口：<memoryBase>/projects/<sanitized-project-root>/memory/team/MEMORY.md
 * 它位于 auto-memory 目录下，按项目隔离。
 */
export function getTeamMemEntrypoint(): string {
  return join(getAutoMemPath(), 'team', 'MEMORY.md')
}

/**
 * 解析路径最深现有祖先中的 symlink。目标文件可能尚不存在，因为即将创建；
 * 因此沿目录树向上遍历，直到 realpath() 成功，再把不存在的尾部重新拼接到解析后的祖先。
 *
 * 安全边界（PSR M22186）：path.resolve() 不会解析 symlink。攻击者若能在 teamDir
 * 内放置指向外部的 symlink（例如指向
 * ~/.ssh/authorized_keys) would pass a resolve()-based containment check.
 * 对最深现有祖先使用 realpath()，可确保比较实际文件系统位置，而非符号路径。
 *
 */
async function realpathDeepestExisting(absolutePath: string): Promise<string> {
  const tail: string[] = []
  let current = absolutePath
  // 向上遍历直到 realpath 成功。ENOENT 表示当前段尚不存在，将其弹入尾部并尝试父目录。
  // ENOTDIR 表示路径中间存在非目录组件，同样弹出后重试，以便 realpath 祖先并检测
  // symlink 逃逸。到达文件系统根目录（dirname('/') === '/'）时循环终止。
  for (let parent = dirname(current); current !== parent; parent = dirname(current)) {
    try {
      const realCurrent = await realpath(current)
      // 按相反顺序重新拼接不存在的尾部，最深弹出的部分最先加入
      return tail.length === 0 ? realCurrent : join(realCurrent, ...tail.reverse())
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        // 可能确实不存在，此时可安全向上遍历；也可能是目标不存在的 dangling symlink。
        // dangling symlink 是攻击入口：writeFile 会跟随链接，在 teamDir 外创建目标。
        // lstat 可区分两者：dangling symlink 的链接条目仍存在，因此成功；真正不存在的
        // 路径则以 ENOENT 失败。
        try {
          const st = await lstat(current)
          if (st.isSymbolicLink()) {
            throw new PathTraversalError(
              `Dangling symlink detected (target does not exist): "${current}"`,
            )
          }
          // lstat 成功但当前项不是 symlink，说明 realpath 的 ENOENT 来自祖先中的
          // dangling symlink；继续向上查找
        } catch (lstatErr: unknown) {
          if (lstatErr instanceof PathTraversalError) {
            throw lstatErr
          }
          const lstatCode = getErrnoCode(lstatErr)
          if (lstatCode !== 'ENOENT' && lstatCode !== 'ENOTDIR') {
            throw new PathTraversalError(
              `Cannot verify path containment (${lstatCode}): "${current}"`,
            )
          }
          // lstat 也失败，说明路径确实不存在，可以继续向上查找。
        }
      } else if (code === 'ENOTDIR') {
        // 中间路径段不是目录；继续向上查找可解析的祖先。
      } else if (code === 'ELOOP') {
        // symlink 循环，表示文件系统状态损坏或存在恶意构造
        throw new PathTraversalError(`Symlink loop detected in path: "${current}"`)
      } else {
        // EACCES、EPERM、EIO 等错误意味着无法验证包含关系，必须关闭失败。
        throw new PathTraversalError(`Cannot verify path containment (${code}): "${current}"`)
      }
      tail.push(current.slice(parent.length + sep.length))
      current = parent
    }
  }
  // 到达文件系统根目录仍未找到现有祖先，这很少发生，因为根目录通常存在。
  // 回退到输入值，后续包含关系检查会拒绝它。
  return absolutePath
}

/**
 * 检查经 symlink 解析的实际路径是否位于实际 team memory 目录内。
 * 两侧都执行 realpath，因此比较的是 canonical 文件系统位置。
 *
 * teamDir 不存在时返回 true 并跳过检查。这是安全的：symlink 逃逸要求 teamDir 内
 * 已存在 symlink，也就要求 teamDir 本身存在。目录不存在便不存在其中的 symlink，
 * 第一轮字符串级包含关系检查已足够。
 */
async function isRealPathWithinTeamDir(realCandidate: string): Promise<boolean> {
  let realTeamDir: string
  try {
    // getTeamMemPath() 含尾部分隔符；部分平台的 realpath() 会拒绝它，因此移除
    realTeamDir = await realpath(getTeamMemPath().replace(/[/\\]+$/, ''))
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // team 目录不存在，不可能发生 symlink 逃逸，跳过检查
      return true
    }
    // 遇到意外错误（EACCES、EIO）时关闭失败
    return false
  }
  const relativePath = relative(realTeamDir, realCandidate)
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  )
}

/**
 * 检查解析后的绝对路径是否位于 team memory 目录内。使用 path.resolve() 转换相对路径
 * 并消除遍历段，但不解析 symlink；写入校验应使用包含 symlink 解析的
 * validateTeamMemWritePath() 或 validateTeamMemKey()。
 */
export function isTeamMemPath(filePath: string): boolean {
  // 安全边界：resolve() 转为绝对路径并消除 .. 段，防止路径遍历攻击，
  // 例如 "team/../../etc/passwd"
  const resolvedPath = resolve(filePath)
  const relativePath = relative(resolve(getTeamMemPath()), resolvedPath)
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

/**
 * 校验绝对文件路径能否安全写入 team memory 目录；有效时返回解析后的绝对路径。
 * 路径包含注入载荷、通过 .. 段越出目录或经 symlink 逃逸时抛出 PathTraversalError
 *（PSR M22186）。
 */
export async function validateTeamMemWritePath(filePath: string): Promise<string> {
  if (filePath.includes('\0')) {
    throw new PathTraversalError(`Null byte in path: "${filePath}"`)
  }
  // 第一轮：归一化 .. 段并检查字符串级包含关系，在访问文件系统前快速拒绝明显遍历尝试
  const resolvedPath = resolve(filePath)
  const teamDir = resolve(getTeamMemPath())
  // 防止前缀攻击：getTeamMemPath 返回的 teamDir 已以 sep 结尾，
  // 因此 "team-evil/" 不会匹配 "team/"
  const relativePath = relative(teamDir, resolvedPath)
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new PathTraversalError(`Path escapes team memory directory: "${filePath}"`)
  }
  // 第二轮：解析最深现有祖先中的 symlink，并确认实际路径仍位于真实 team 目录内。
  // 这能捕获仅靠 path.resolve() 无法检测的 symlink 逃逸。
  const realPath = await realpathDeepestExisting(resolvedPath)
  if (!(await isRealPathWithinTeamDir(realPath))) {
    throw new PathTraversalError(`Path escapes team memory directory via symlink: "${filePath}"`)
  }
  return resolvedPath
}

/**
 * 针对 team memory 目录校验服务器提供的相对路径 key。先净化 key、与 team 目录拼接，
 * 再解析最深现有祖先中的 symlink，并对真实 team 目录验证包含关系。
 * 返回解析后的绝对路径；key 恶意时抛出 PathTraversalError（PSR M22186）。
 */
export async function validateTeamMemKey(relativeKey: string): Promise<string> {
  sanitizePathKey(relativeKey)
  const teamDir = resolve(getTeamMemPath())
  const fullPath = join(teamDir, relativeKey)
  // 第一轮：归一化 .. 段并检查字符串级包含关系
  const resolvedPath = resolve(fullPath)
  const relativePath = relative(teamDir, resolvedPath)
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new PathTraversalError(`Key escapes team memory directory: "${relativeKey}"`)
  }
  // 第二轮：解析 symlink 并验证真实包含关系
  const realPath = await realpathDeepestExisting(resolvedPath)
  if (!(await isRealPathWithinTeamDir(realPath))) {
    throw new PathTraversalError(`Key escapes team memory directory via symlink: "${relativeKey}"`)
  }
  return resolvedPath
}

/**
 * 检查文件路径是否位于 team memory 目录内，且 team memory 已启用。
 */
export function isTeamMemFile(filePath: string): boolean {
  return isTeamMemoryEnabled() && isTeamMemPath(filePath)
}
