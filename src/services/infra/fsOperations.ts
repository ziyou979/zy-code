import * as fs from 'node:fs'
import {
  mkdir as mkdirPromise,
  open,
  readdir as readdirPromise,
  readFile as readFilePromise,
  rename as renamePromise,
  rmdir as rmdirPromise,
  rm as rmPromise,
  stat as statPromise,
  unlink as unlinkPromise,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import * as nodePath from 'node:path'
import { getErrnoCode } from '../../utils/errors.js'
import { slowLogging } from './slowOperations.js'
/**
 * 基于 Node.js fs 模块的简化文件系统操作接口。以类型安全方式提供常用操作子集，
 * 并支持 mock、virtual 等替代实现。
 */
export type FsOperations = {
  // 文件访问与信息操作。
  /** 获取当前工作目录。 */
  cwd(): string
  /** 检查文件或目录是否存在。 */
  existsSync(path: string): boolean
  /** 异步获取文件 stat。 */
  stat(path: string): Promise<fs.Stats>
  /** 异步列出目录内容及文件类型信息。 */
  readdir(path: string): Promise<fs.Dirent[]>
  /** 异步删除文件。 */
  unlink(path: string): Promise<void>
  /** 异步移除空目录。 */
  rmdir(path: string): Promise<void>
  /** 异步移除文件和目录，支持递归选项。 */
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  /** 异步递归创建目录。 */
  mkdir(path: string, options?: { mode?: number }): Promise<void>
  /** 异步以字符串读取文件内容。 */
  readFile(path: string, options: { encoding: BufferEncoding }): Promise<string>
  /** 异步重命名或移动文件。 */
  rename(oldPath: string, newPath: string): Promise<void>
  /** 获取文件 stat。 */
  statSync(path: string): fs.Stats
  /** 不跟随符号链接获取文件 stat。 */
  lstatSync(path: string): fs.Stats

  // 文件内容操作。
  /** 使用指定编码以字符串读取文件内容。 */
  readFileSync(
    path: string,
    options: {
      encoding: BufferEncoding
    },
  ): string
  /** 以 Buffer 读取原始文件字节。 */
  readFileBytesSync(path: string): Buffer
  /** 从文件开头读取指定字节数。 */
  readSync(
    path: string,
    options: {
      length: number
    },
  ): {
    buffer: Buffer
    bytesRead: number
  }
  /** 向文件追加字符串。 */
  appendFileSync(path: string, data: string, options?: { mode?: number }): void
  /** 将文件从源路径复制到目标路径。 */
  copyFileSync(src: string, dest: string): void
  /** 删除文件。 */
  unlinkSync(path: string): void
  /** 重命名或移动文件。 */
  renameSync(oldPath: string, newPath: string): void
  /** 创建硬链接。 */
  linkSync(target: string, path: string): void
  /** 创建符号链接。 */
  symlinkSync(target: string, path: string, type?: 'dir' | 'file' | 'junction'): void
  /** 读取符号链接。 */
  readlinkSync(path: string): string
  /** 解析符号链接并返回规范路径名。 */
  realpathSync(path: string): string

  // 目录操作。
  /** 递归创建目录。未指定时 mode 默认为 0o777 & ~umask。 */
  mkdirSync(
    path: string,
    options?: {
      mode?: number
    },
  ): void
  /** 列出目录内容及文件类型信息。 */
  readdirSync(path: string): fs.Dirent[]
  /** 以字符串形式列出目录内容。 */
  readdirStringSync(path: string): string[]
  /** 检查目录是否为空。 */
  isDirEmptySync(path: string): boolean
  /** 移除空目录。 */
  rmdirSync(path: string): void
  /** 移除文件和目录，支持递归选项。 */
  rmSync(
    path: string,
    options?: {
      recursive?: boolean
      force?: boolean
    },
  ): void
  /** 创建用于向文件写入数据的可写流。 */
  createWriteStream(path: string): fs.WriteStream
  /** 异步以 Buffer 读取原始文件字节；设置 maxBytes 时最多读取该字节数。 */
  readFileBytes(path: string, maxBytes?: number): Promise<Buffer>
}

/**
 * 安全解析文件路径，并平稳处理符号链接和错误。
 *
 * 错误处理策略：
 * - 文件不存在时返回原始路径，以允许创建文件
 * - 符号链接解析失败（损坏、权限不足、循环链接）时返回原始路径，并标记为非符号链接
 * - 确保操作可继续使用原始路径，而非直接失败
 *
 * @param fs 要使用的文件系统实现
 * @param filePath 要解析的路径
 * @returns 包含解析后路径及其是否为符号链接的对象
 */
export function safeResolvePath(
  fs: FsOperations,
  filePath: string,
): { resolvedPath: string; isSymlink: boolean; isCanonical: boolean } {
  // 在任何文件系统访问前阻止 UNC 路径，避免 Windows 校验期间发起 DNS/SMB 网络请求。
  if (filePath.startsWith('//') || filePath.startsWith('\\\\')) {
    return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  }

  try {
    // 调用 realpathSync 前检查 FIFO、socket、device 等特殊文件类型。realpathSync
    // 可能在 FIFO 上等待 writer 而挂起。文件不存在时 lstatSync 抛出 ENOENT，
    // 下方 catch 会返回原始路径，以允许创建文件。
    const stats = fs.lstatSync(filePath)
    if (stats.isFIFO() || stats.isSocket() || stats.isCharacterDevice() || stats.isBlockDevice()) {
      return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
    }

    const resolvedPath = fs.realpathSync(filePath)
    return {
      resolvedPath,
      isSymlink: resolvedPath !== filePath,
      // realpathSync 已返回规范 resolvedPath，所有路径组件中的符号链接均已解析；
      // 调用方可跳过进一步解析。
      isCanonical: true,
    }
  } catch (_error) {
    // lstat/realpath 因 ENOENT、损坏链接、EACCES、ELOOP 等原因失败时，
    // 返回原始路径以允许继续操作。
    // to proceed
    return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  }
}

/**
 * 检查文件路径是否重复并应跳过。解析符号链接以识别指向同一文件的重复项；
 * 若不重复，则将解析后的路径加入 loadedPaths。
 *
 * @returns 文件重复并应跳过时为 true
 */
export function isDuplicatePath(
  fs: FsOperations,
  filePath: string,
  loadedPaths: Set<string>,
): boolean {
  const { resolvedPath } = safeResolvePath(fs, filePath)
  if (loadedPaths.has(resolvedPath)) {
    return true
  }
  loadedPaths.add(resolvedPath)
  return false
}

/**
 * 向上遍历直至 realpathSync 成功，解析路径中最深的现有祖先。通过 lstat 检测
 * 悬空符号链接（链接项存在、目标不存在），并用 readlink 解析。
 *
 * 输入路径可能不存在（写入新文件），且需要知道 OS 跟随符号链接后实际写入位置时使用。
 *
 * 返回解析后的绝对路径，并重新拼接不存在的尾部路径段。若所有现有祖先均解析到
 * 自身，即未发现符号链接，则返回 undefined。
 *
 * 处理有效父级符号链接、悬空文件符号链接、悬空父级符号链接。
 * 核心算法与 teamMemPaths.ts:realpathDeepestExisting 相同。
 */
export function resolveDeepestExistingAncestorSync(
  fs: FsOperations,
  absolutePath: string,
): string | undefined {
  let dir = absolutePath
  const segments: string[] = []
  // 使用开销较低、O(1) 的 lstat 向上查找首个现有组件。lstat 不跟随符号链接，
  // 因此可检测悬空链接；仅在最后调用一次开销为 O(depth) 的 realpathSync。
  while (dir !== nodePath.dirname(dir)) {
    let st: fs.Stats
    try {
      st = fs.lstatSync(dir)
    } catch {
      // lstat 失败，表示确实不存在，继续向上。
      segments.unshift(nodePath.basename(dir))
      dir = nodePath.dirname(dir)
      continue
    }
    if (st.isSymbolicLink()) {
      // 找到有效或悬空符号链接。先尝试 realpath 以解析链接链；
      // 悬空链接则退回 readlink。
      try {
        const resolved = fs.realpathSync(dir)
        return segments.length === 0 ? resolved : nodePath.join(resolved, ...segments)
      } catch {
        // 悬空链接：realpath 失败，但 lstat 已看到链接项。
        const target = fs.readlinkSync(dir)
        const absTarget = nodePath.isAbsolute(target)
          ? target
          : nodePath.resolve(nodePath.dirname(dir), target)
        return segments.length === 0 ? absTarget : nodePath.join(absTarget, ...segments)
      }
    }
    // 找到现有非符号链接组件。一次 realpath 即可解析其祖先中的全部符号链接；
    // 若没有则返回 undefined。
    try {
      const resolved = fs.realpathSync(dir)
      if (resolved !== dir) {
        return segments.length === 0 ? resolved : nodePath.join(resolved, ...segments)
      }
    } catch {
      // realpath 仍可能失败，如祖先目录 EACCES。此时无法解析，返回 undefined；
      // 调用方的 pathSet 中已包含逻辑路径。
    }
    return undefined
  }
  return undefined
}

/**
 * 获取所有需要检查权限的路径，包括原始路径、符号链接链中的全部中间目标，
 * 以及最终解析路径。
 *
 * 例如 test.txt -> /etc/passwd -> /private/etc/passwd：
 * - test.txt (original path)
 * - /etc/passwd (intermediate symlink target)
 * - /private/etc/passwd (final resolved path)
 *
 * 这对安全至关重要：即使文件实际位于 /private/etc/passwd（如 macOS），
 * 针对 /etc/passwd 的 deny 规则也应阻止访问。
 *
 * @param path 要检查的路径，将转换为绝对路径
 * @returns 需要检查权限的绝对路径数组
 */
export function getPathsForPermissionCheck(inputPath: string): string[] {
  // 防御性展开波浪号。tool 应在 getPath() 中处理，但此处仍规范化，
  // 为权限检查提供纵深防御。
  let path = inputPath
  if (path === '~') {
    path = homedir().normalize('NFC')
  } else if (path.startsWith('~/')) {
    path = nodePath.join(homedir().normalize('NFC'), path.slice(2))
  }

  const pathSet = new Set<string>()
  const fsImpl = getFsImplementation()

  // 始终检查原始路径。
  pathSet.add(path)

  // 在任何文件系统访问前阻止 UNC 路径，避免 Windows 校验期间发起 DNS/SMB 网络请求。
  if (path.startsWith('//') || path.startsWith('\\\\')) {
    return Array.from(pathSet)
  }

  // 沿符号链接链收集全部中间目标。对 test.txt -> /etc/passwd ->
  // /private/etc/passwd，应检查全部三个路径，而非只检查首尾。
  try {
    let currentPath = path
    const visited = new Set<string>()
    const maxDepth = 40 // Prevent runaway loops, matches typical SYMLOOP_MAX

    for (let depth = 0; depth < maxDepth; depth++) {
      // 防止循环符号链接造成无限循环。
      if (visited.has(currentPath)) {
        break
      }
      visited.add(currentPath)

      if (!fsImpl.existsSync(currentPath)) {
        // 路径不存在，属于新文件情况。existsSync 会跟随符号链接，因此悬空链接
        //（链接项存在但目标不存在）也会到达此处。解析路径及其祖先中的符号链接，
        // 使权限检查看到真实目标；否则以下情况会逃逸工作目录：
        // `./data -> /etc/cron.d/` (live parent symlink) or
        // `./evil.txt -> ~/.ssh/authorized_keys2` (dangling file symlink)
        // 此类写入原本会逃逸工作目录。
        if (currentPath === path) {
          const resolved = resolveDeepestExistingAncestorSync(fsImpl, path)
          if (resolved !== undefined) {
            pathSet.add(resolved)
          }
        }
        break
      }

      const stats = fsImpl.lstatSync(currentPath)

      // 跳过可能引发问题的特殊文件类型。
      if (
        stats.isFIFO() ||
        stats.isSocket() ||
        stats.isCharacterDevice() ||
        stats.isBlockDevice()
      ) {
        break
      }

      if (!stats.isSymbolicLink()) {
        break
      }

      // 获取直接符号链接目标。
      const target = fsImpl.readlinkSync(currentPath)

      // 目标为相对路径时，相对于符号链接所在目录解析。
      const absoluteTarget = nodePath.isAbsolute(target)
        ? target
        : nodePath.resolve(nodePath.dirname(currentPath), target)

      // 将中间目标加入集合。
      pathSet.add(absoluteTarget)
      currentPath = absoluteTarget
    }
  } catch {
    // 遍历链接链期间发生任何失败，都使用已收集结果继续。
  }

  // 为完整性再用 realpathSync 添加最终解析路径，处理目录组件中的剩余符号链接。
  const { resolvedPath, isSymlink } = safeResolvePath(fsImpl, path)
  if (isSymlink && resolvedPath !== path) {
    pathSet.add(resolvedPath)
  }

  return Array.from(pathSet)
}

export const NodeFsOperations: FsOperations = {
  cwd() {
    return process.cwd()
  },

  existsSync(fsPath) {
    using _ = slowLogging`fs.existsSync(${fsPath})`
    return fs.existsSync(fsPath)
  },

  async stat(fsPath) {
    return statPromise(fsPath)
  },

  async readdir(fsPath) {
    return readdirPromise(fsPath, { withFileTypes: true })
  },

  async unlink(fsPath) {
    return unlinkPromise(fsPath)
  },

  async rmdir(fsPath) {
    return rmdirPromise(fsPath)
  },

  async rm(fsPath, options) {
    return rmPromise(fsPath, options)
  },

  async mkdir(dirPath, options) {
    try {
      await mkdirPromise(dirPath, { recursive: true, ...options })
    } catch (e) {
      // Bun/Windows：对设置 FILE_ATTRIBUTE_READONLY 位的目录（Group Policy、
      // OneDrive、desktop.ini），recursive:true 会抛出 EEXIST。Bun 的
      // directoryExistsAt 会将 DIRECTORY+READONLY 误判为非目录
      //（bun-internal src/sys.zig existsAtType）。目录确实存在，忽略。
      // https://github.com/anthropics/zy-code/issues/30924
      if (getErrnoCode(e) !== 'EEXIST') {
        throw e
      }
    }
  },

  async readFile(fsPath, options) {
    return readFilePromise(fsPath, { encoding: options.encoding })
  },

  async rename(oldPath, newPath) {
    return renamePromise(oldPath, newPath)
  },

  statSync(fsPath) {
    using _ = slowLogging`fs.statSync(${fsPath})`
    return fs.statSync(fsPath)
  },

  lstatSync(fsPath) {
    using _ = slowLogging`fs.lstatSync(${fsPath})`
    return fs.lstatSync(fsPath)
  },

  readFileSync(fsPath, options) {
    using _ = slowLogging`fs.readFileSync(${fsPath})`
    return fs.readFileSync(fsPath, { encoding: options.encoding })
  },

  readFileBytesSync(fsPath) {
    using _ = slowLogging`fs.readFileBytesSync(${fsPath})`
    return fs.readFileSync(fsPath)
  },

  readSync(fsPath, options) {
    using _ = slowLogging`fs.readSync(${fsPath}, ${options.length} bytes)`
    let fd: number | undefined
    try {
      fd = fs.openSync(fsPath, 'r')
      const buffer = Buffer.alloc(options.length)
      const bytesRead = fs.readSync(fd, buffer, 0, options.length, 0)
      return { buffer, bytesRead }
    } finally {
      if (fd) {
        fs.closeSync(fd)
      }
    }
  },

  appendFileSync(path, data, options) {
    using _ = slowLogging`fs.appendFileSync(${path}, ${data.length} chars)`
    // 对显式指定 mode 的新文件使用 'ax' 原子创建，避免存在性检查与 open 间的
    // TOCTOU；文件已存在时退回普通 append。
    if (options?.mode !== undefined) {
      try {
        const fd = fs.openSync(path, 'ax', options.mode)
        try {
          fs.appendFileSync(fd, data)
        } finally {
          fs.closeSync(fd)
        }
        return
      } catch (e) {
        if (getErrnoCode(e) !== 'EEXIST') {
          throw e
        }
        // 文件已存在，继续执行普通 append。
      }
    }
    fs.appendFileSync(path, data)
  },

  copyFileSync(src, dest) {
    using _ = slowLogging`fs.copyFileSync(${src} → ${dest})`
    fs.copyFileSync(src, dest)
  },

  unlinkSync(path: string) {
    using _ = slowLogging`fs.unlinkSync(${path})`
    fs.unlinkSync(path)
  },

  renameSync(oldPath: string, newPath: string) {
    using _ = slowLogging`fs.renameSync(${oldPath} → ${newPath})`
    fs.renameSync(oldPath, newPath)
  },

  linkSync(target: string, path: string) {
    using _ = slowLogging`fs.linkSync(${target} → ${path})`
    fs.linkSync(target, path)
  },

  symlinkSync(target: string, path: string, type?: 'dir' | 'file' | 'junction') {
    using _ = slowLogging`fs.symlinkSync(${target} → ${path})`
    fs.symlinkSync(target, path, type)
  },

  readlinkSync(path: string) {
    using _ = slowLogging`fs.readlinkSync(${path})`
    return fs.readlinkSync(path)
  },

  realpathSync(path: string) {
    using _ = slowLogging`fs.realpathSync(${path})`
    return fs.realpathSync(path).normalize('NFC')
  },

  mkdirSync(dirPath, options) {
    using _ = slowLogging`fs.mkdirSync(${dirPath})`
    const mkdirOptions: { recursive: boolean; mode?: number } = {
      recursive: true,
    }
    if (options?.mode !== undefined) {
      mkdirOptions.mode = options.mode
    }
    try {
      fs.mkdirSync(dirPath, mkdirOptions)
    } catch (e) {
      // Bun/Windows：对设置 FILE_ATTRIBUTE_READONLY 位的目录（Group Policy、
      // OneDrive、desktop.ini），recursive:true 会抛出 EEXIST。Bun 的
      // directoryExistsAt 会将 DIRECTORY+READONLY 误判为非目录
      //（bun-internal src/sys.zig existsAtType）。目录确实存在，忽略。
      // https://github.com/anthropics/zy-code/issues/30924
      if (getErrnoCode(e) !== 'EEXIST') {
        throw e
      }
    }
  },

  readdirSync(dirPath) {
    using _ = slowLogging`fs.readdirSync(${dirPath})`
    return fs.readdirSync(dirPath, { withFileTypes: true })
  },

  readdirStringSync(dirPath) {
    using _ = slowLogging`fs.readdirStringSync(${dirPath})`
    return fs.readdirSync(dirPath)
  },

  isDirEmptySync(dirPath) {
    using _ = slowLogging`fs.isDirEmptySync(${dirPath})`
    const files = this.readdirSync(dirPath)
    return files.length === 0
  },

  rmdirSync(dirPath) {
    using _ = slowLogging`fs.rmdirSync(${dirPath})`
    fs.rmdirSync(dirPath)
  },

  rmSync(path, options) {
    using _ = slowLogging`fs.rmSync(${path})`
    fs.rmSync(path, options)
  },

  createWriteStream(path: string) {
    return fs.createWriteStream(path)
  },

  async readFileBytes(fsPath: string, maxBytes?: number) {
    if (maxBytes === undefined) {
      return readFilePromise(fsPath)
    }
    const handle = await open(fsPath, 'r')
    try {
      const { size } = await handle.stat()
      const readSize = Math.min(size, maxBytes)
      const buffer = Buffer.allocUnsafe(readSize)
      let offset = 0
      while (offset < readSize) {
        const { bytesRead } = await handle.read(buffer, offset, readSize - offset, offset)
        if (bytesRead === 0) {
          break
        }
        offset += bytesRead
      }
      return offset < readSize ? buffer.subarray(0, offset) : buffer
    } finally {
      await handle.close()
    }
  },
}

// 当前生效的文件系统实现。
let activeFs: FsOperations = NodeFsOperations

/**
 * 覆盖文件系统实现。注意：此函数不会自动更新 cwd。
 * @param implementation 要使用的文件系统实现
 */
export function setFsImplementation(implementation: FsOperations): void {
  activeFs = implementation
}

/**
 * 获取当前生效的文件系统实现。
 * @returns 当前生效的文件系统实现
 */
export function getFsImplementation(): FsOperations {
  return activeFs
}

/**
 * 将文件系统实现重置为默认 Node.js 实现。注意：此函数不会自动更新 cwd。
 */
export function setOriginalFsImplementation(): void {
  activeFs = NodeFsOperations
}

export type ReadFileRangeResult = {
  content: string
  bytesRead: number
  bytesTotal: number
}

/**
 * 从文件的 `offset` 位置开始读取最多 `maxBytes`。从 Buffer 返回独立字符串，
 * 不保留指向更大父字符串的切片引用。文件小于 offset 时返回 null。
 */
export async function readFileRange(
  path: string,
  offset: number,
  maxBytes: number,
): Promise<ReadFileRangeResult | null> {
  await using fh = await open(path, 'r')
  const size = (await fh.stat()).size
  if (size <= offset) {
    return null
  }
  const bytesToRead = Math.min(size - offset, maxBytes)
  const buffer = Buffer.allocUnsafe(bytesToRead)

  let totalRead = 0
  while (totalRead < bytesToRead) {
    const { bytesRead } = await fh.read(
      buffer,
      totalRead,
      bytesToRead - totalRead,
      offset + totalRead,
    )
    if (bytesRead === 0) {
      break
    }
    totalRead += bytesRead
  }

  return {
    content: buffer.toString('utf8', 0, totalRead),
    bytesRead: totalRead,
    bytesTotal: size,
  }
}

/**
 * 读取文件末尾 `maxBytes` 字节；文件较小时返回完整内容。
 */
export async function tailFile(path: string, maxBytes: number): Promise<ReadFileRangeResult> {
  await using fh = await open(path, 'r')
  const size = (await fh.stat()).size
  if (size === 0) {
    return { content: '', bytesRead: 0, bytesTotal: 0 }
  }
  const offset = Math.max(0, size - maxBytes)
  const bytesToRead = size - offset
  const buffer = Buffer.allocUnsafe(bytesToRead)

  let totalRead = 0
  while (totalRead < bytesToRead) {
    const { bytesRead } = await fh.read(
      buffer,
      totalRead,
      bytesToRead - totalRead,
      offset + totalRead,
    )
    if (bytesRead === 0) {
      break
    }
    totalRead += bytesRead
  }

  return {
    content: buffer.toString('utf8', 0, totalRead),
    bytesRead: totalRead,
    bytesTotal: size,
  }
}

/**
 * 以逆序产出文件各行的异步生成器。分块向前读取文件，避免将完整文件载入内存。
 * @param path 要读取的文件路径
 * @returns 逆序产出各行的异步生成器
 */
export async function* readLinesReverse(path: string): AsyncGenerator<string, void, undefined> {
  const CHUNK_SIZE = 1024 * 4
  const fileHandle = await open(path, 'r')
  try {
    const stats = await fileHandle.stat()
    let position = stats.size
    // 跨 chunk 边界携带原始字节而非已解码字符串，避免被 4KB 边界拆开的多字节
    // UTF-8 序列损坏。逐 chunk 解码会使拆分序列两侧都变成 U+FFFD；对
    // history.jsonl 而言，这会导致 JSON.parse 抛错并丢弃条目。
    let remainder = Buffer.alloc(0)
    const buffer = Buffer.alloc(CHUNK_SIZE)

    while (position > 0) {
      const currentChunkSize = Math.min(CHUNK_SIZE, position)
      position -= currentChunkSize

      await fileHandle.read(buffer, 0, currentChunkSize, position)
      const combined = Buffer.concat([buffer.subarray(0, currentChunkSize), remainder])

      const firstNewline = combined.indexOf(0x0a)
      if (firstNewline === -1) {
        remainder = combined
        continue
      }

      remainder = Buffer.from(combined.subarray(0, firstNewline))
      const lines = combined.toString('utf8', firstNewline + 1).split('\n')

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!
        if (line) {
          yield line
        }
      }
    }

    if (remainder.length > 0) {
      yield remainder.toString('utf8')
    }
  } finally {
    await fileHandle.close()
  }
}
