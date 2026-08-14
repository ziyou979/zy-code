/**
 * 执行文本操作时需要跳过的二进制文件扩展名。
 * 这些文件通常较大，按文本比较也没有意义。
 */
export const BINARY_EXTENSIONS = new Set([
  // 图片
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.tiff',
  '.tif',
  // 视频
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.wmv',
  '.flv',
  '.m4v',
  '.mpeg',
  '.mpg',
  // 音频
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  '.m4a',
  '.wma',
  '.aiff',
  '.opus',
  // 压缩包
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.xz',
  '.z',
  '.tgz',
  '.iso',
  // 可执行文件与二进制文件
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.o',
  '.a',
  '.obj',
  '.lib',
  '.app',
  '.msi',
  '.deb',
  '.rpm',
  // 文档（PDF 在此列出，FileReadTool 会在调用处将其排除）
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  // 字体
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  // 字节码与 VM 产物
  '.pyc',
  '.pyo',
  '.class',
  '.jar',
  '.war',
  '.ear',
  '.node',
  '.wasm',
  '.rlib',
  // 数据库文件
  '.sqlite',
  '.sqlite3',
  '.db',
  '.mdb',
  '.idx',
  // 设计与 3D 文件
  '.psd',
  '.ai',
  '.eps',
  '.sketch',
  '.fig',
  '.xd',
  '.blend',
  '.3ds',
  '.max',
  // Flash 文件
  '.swf',
  '.fla',
  // 锁文件与性能分析数据
  '.lockb',
  '.dat',
  '.data',
])

/**
 * 检查文件路径是否使用二进制文件扩展名。
 */
export function hasBinaryExtension(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

/**
 * 检测二进制内容时读取的字节数。
 */
const BINARY_CHECK_SIZE = 8192

/**
 * 通过空字节或高占比不可打印字符，检查 buffer 是否包含二进制内容。
 */
export function isBinaryContent(buffer: Buffer): boolean {
  // 检查前 BINARY_CHECK_SIZE 个字节；buffer 较小时检查全部内容。
  const checkSize = Math.min(buffer.length, BINARY_CHECK_SIZE)

  let nonPrintable = 0
  for (let i = 0; i < checkSize; i++) {
    const byte = buffer[i]!
    // 空字节是二进制内容的强信号。
    if (byte === 0) {
      return true
    }
    // 统计不可打印且非空白的字节。
    // 可打印 ASCII 范围为 32～126，常见空白字节为 9、10、13。
    if (
      byte < 32 &&
      byte !== 9 && // tab
      byte !== 10 && // newline
      byte !== 13 // carriage return
    ) {
      nonPrintable++
    }
  }

  // 不可打印字符超过 10% 时，很可能是二进制内容。
  return nonPrintable / checkSize > 0.1
}
