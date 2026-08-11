import { logError } from 'src/services/infra/log.js'
import { BULLET, CROSS, INFO, STAR, WARNING } from '../constants/figures.js'
import type { MCPServerConnection } from './mcp/types.js'
import { ZyError } from '../utils/errors.js'
import { normalizePathForComparison, pathsEqual } from '../services/infra/file.js'
import { jsonParse } from '../services/infra/slowOperations.js'
import { getConnectedIdeClient } from './ide/ide.js'
import { callIdeRpc } from './mcp/mcpToolCall.js'

class DiagnosticsTrackingError extends ZyError {}

const MAX_DIAGNOSTICS_SUMMARY_CHARS = 4000

export interface Diagnostic {
  message: string
  severity: 'Error' | 'Warning' | 'Info' | 'Hint'
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  source?: string
  code?: string
}

export interface DiagnosticFile {
  uri: string
  diagnostics: Diagnostic[]
}

export class DiagnosticTrackingService {
  private static instance: DiagnosticTrackingService | undefined
  private baseline: Map<string, Diagnostic[]> = new Map()

  private initialized = false
  private mcpClient: MCPServerConnection | undefined

  // 跟踪文件最后处理/获取的时间
  private lastProcessedTimestamps: Map<string, number> = new Map()

  // 跟踪哪些文件已收到右文件诊断以及是否已更改
  // Map<normalizedPath, lastZyFsRightDiagnostics>
  private rightFileDiagnosticsState: Map<string, Diagnostic[]> = new Map()

  static getInstance(): DiagnosticTrackingService {
    if (!DiagnosticTrackingService.instance) {
      DiagnosticTrackingService.instance = new DiagnosticTrackingService()
    }
    return DiagnosticTrackingService.instance
  }

  initialize(mcpClient: MCPServerConnection) {
    if (this.initialized) {
      return
    }

    // TODO: Do not cache the connected mcpClient since it can change.
    this.mcpClient = mcpClient
    this.initialized = true
  }

  async shutdown(): Promise<void> {
    this.initialized = false
    this.baseline.clear()
    this.rightFileDiagnosticsState.clear()
    this.lastProcessedTimestamps.clear()
  }

  /**
   * 重置跟踪状态同时保持服务已初始化。
   * 这会清除所有已跟踪的文件和诊断。
   */
  reset() {
    this.baseline.clear()
    this.rightFileDiagnosticsState.clear()
    this.lastProcessedTimestamps.clear()
  }

  private normalizeFileUri(fileUri: string): string {
    // Remove our protocol prefixes
    const protocolPrefixes = ['file://', '_Zy_fs_right:', '_Zy_fs_left:']

    let normalized = fileUri
    for (const prefix of protocolPrefixes) {
      if (fileUri.startsWith(prefix)) {
        normalized = fileUri.slice(prefix.length)
        break
      }
    }

    // Use shared utility for platform-aware path normalization
    // (handles Windows case-insensitivity and path separators)
    return normalizePathForComparison(normalized)
  }

  /**
   * 确保在处理前文件已在 IDE 中打开。
   * 这对语言服务（如诊断）正常工作很重要。
   */
  async ensureFileOpened(fileUri: string): Promise<void> {
    if (!this.initialized || !this.mcpClient || this.mcpClient.type !== 'connected') {
      return
    }

    try {
      // Call the openFile tool to ensure the file is loaded
      await callIdeRpc(
        'openFile',
        {
          filePath: fileUri,
          preview: false,
          startText: '',
          endText: '',
          selectToEndOfLine: false,
          makeFrontmost: false,
        },
        this.mcpClient,
      )
    } catch (error) {
      logError(error as Error)
    }
  }

  /**
   * 在编辑前捕获特定文件的基线诊断。
   * 这会在编辑文件前调用，以确保我们有基线可供比较。
   */
  async beforeFileEdited(filePath: string): Promise<void> {
    if (!this.initialized || !this.mcpClient || this.mcpClient.type !== 'connected') {
      return
    }

    const timestamp = Date.now()

    try {
      const result = await callIdeRpc(
        'getDiagnostics',
        { uri: `file://${filePath}` },
        this.mcpClient,
      )
      const diagnosticFile = this.parseDiagnosticResult(result)[0]
      if (diagnosticFile) {
        // Compare normalized paths (handles protocol prefixes and Windows case-insensitivity)
        if (
          !pathsEqual(this.normalizeFileUri(filePath), this.normalizeFileUri(diagnosticFile.uri))
        ) {
          logError(
            new DiagnosticsTrackingError(
              `Diagnostics file path mismatch: expected ${filePath}, got ${diagnosticFile.uri})`,
            ),
          )
          return
        }

        // Store with normalized path key for consistent lookups on Windows
        const normalizedPath = this.normalizeFileUri(filePath)
        this.baseline.set(normalizedPath, diagnosticFile.diagnostics)
        this.lastProcessedTimestamps.set(normalizedPath, timestamp)
      } else {
        // No diagnostic file returned, store an empty baseline
        const normalizedPath = this.normalizeFileUri(filePath)
        this.baseline.set(normalizedPath, [])
        this.lastProcessedTimestamps.set(normalizedPath, timestamp)
      }
    } catch (_error) {
      // Fail silently if IDE doesn't support diagnostics
    }
  }

  /**
   * 从 file://、_Zy_fs_right 和 _Zy_fs_ URI 获取不在基线中的新诊断。
   * 仅处理已编辑文件的诊断。
   */
  async getNewDiagnostics(): Promise<DiagnosticFile[]> {
    if (!this.initialized || !this.mcpClient || this.mcpClient.type !== 'connected') {
      return []
    }

    // Check if we have any files with diagnostic changes
    let allDiagnosticFiles: DiagnosticFile[] = []
    try {
      const result = await callIdeRpc(
        'getDiagnostics',
        {}, // Empty params fetches all diagnostics
        this.mcpClient,
      )
      allDiagnosticFiles = this.parseDiagnosticResult(result)
    } catch (_error) {
      // If fetching all diagnostics fails, return empty
      return []
    }
    const diagnosticsForFileUrisWithBaselines = allDiagnosticFiles
      .filter((file) => this.baseline.has(this.normalizeFileUri(file.uri)))
      .filter((file) => file.uri.startsWith('file://'))

    const diagnosticsForZyFsRightUrisWithBaselinesMap = new Map<string, DiagnosticFile>()
    allDiagnosticFiles
      .filter((file) => this.baseline.has(this.normalizeFileUri(file.uri)))
      .filter((file) => file.uri.startsWith('_Zy_fs_right:'))
      .forEach((file) => {
        diagnosticsForZyFsRightUrisWithBaselinesMap.set(this.normalizeFileUri(file.uri), file)
      })

    const newDiagnosticFiles: DiagnosticFile[] = []

    // Process file:// protocol diagnostics
    for (const file of diagnosticsForFileUrisWithBaselines) {
      const normalizedPath = this.normalizeFileUri(file.uri)
      const baselineDiagnostics = this.baseline.get(normalizedPath) || []

      // Get the _Zy_fs_right file if it exists
      const ZyFsRightFile = diagnosticsForZyFsRightUrisWithBaselinesMap.get(normalizedPath)

      // Determine which file to use based on the state of right file diagnostics
      let fileToUse = file

      if (ZyFsRightFile) {
        const previousRightDiagnostics = this.rightFileDiagnosticsState.get(normalizedPath)

        // Use _Zy_fs_right if:
        // 1. We've never gotten right file diagnostics for this file (previousRightDiagnostics === undefined)
        // 2. OR the right file diagnostics have just changed
        if (
          !previousRightDiagnostics ||
          !this.areDiagnosticArraysEqual(previousRightDiagnostics, ZyFsRightFile.diagnostics)
        ) {
          fileToUse = ZyFsRightFile
        }

        // Update our tracking of right file diagnostics
        this.rightFileDiagnosticsState.set(normalizedPath, ZyFsRightFile.diagnostics)
      }

      // Find new diagnostics that aren't in the baseline
      const newDiagnostics = fileToUse.diagnostics.filter(
        (d) => !baselineDiagnostics.some((b) => this.areDiagnosticsEqual(d, b)),
      )

      if (newDiagnostics.length > 0) {
        newDiagnosticFiles.push({
          uri: file.uri,
          diagnostics: newDiagnostics,
        })
      }

      // Update baseline with current diagnostics
      this.baseline.set(normalizedPath, fileToUse.diagnostics)
    }

    return newDiagnosticFiles
  }

  private parseDiagnosticResult(result: unknown): DiagnosticFile[] {
    if (Array.isArray(result)) {
      const textBlock = result.find((block) => block.type === 'text')
      if (textBlock && 'text' in textBlock) {
        const parsed = jsonParse(textBlock.text)
        return parsed
      }
    }
    return []
  }

  private areDiagnosticsEqual(a: Diagnostic, b: Diagnostic): boolean {
    return (
      a.message === b.message &&
      a.severity === b.severity &&
      a.source === b.source &&
      a.code === b.code &&
      a.range.start.line === b.range.start.line &&
      a.range.start.character === b.range.start.character &&
      a.range.end.line === b.range.end.line &&
      a.range.end.character === b.range.end.character
    )
  }

  private areDiagnosticArraysEqual(a: Diagnostic[], b: Diagnostic[]): boolean {
    if (a.length !== b.length) {
      return false
    }

    // Check if every diagnostic in 'a' exists in 'b'
    return (
      a.every((diagA) => b.some((diagB) => this.areDiagnosticsEqual(diagA, diagB))) &&
      b.every((diagB) => a.some((diagA) => this.areDiagnosticsEqual(diagA, diagB)))
    )
  }

  /**
   * 处理新查询的开始。此方法：
   * - 如果未初始化则初始化诊断跟踪器
   * - 如果已初始化则重置跟踪器（用于新的查询循环）
   * - 从提供的客户端列表中自动查找 IDE 客户端
   *
   * @param clients 可能包含 IDE 客户端的 MCP 客户端数组
   * @param shouldQuery 是否实际发起查询（而非仅执行命令）
   */
  async handleQueryStart(clients: MCPServerConnection[]): Promise<void> {
    // Only proceed if we should query and have clients
    if (!this.initialized) {
      // Find the connected IDE client
      const connectedIdeClient = getConnectedIdeClient(clients)

      if (connectedIdeClient) {
        this.initialize(connectedIdeClient)
      }
    } else {
      // Reset diagnostic tracking for new query loops
      this.reset()
    }
  }

  /**
   * 将诊断格式化为人类可读的摘要字符串。
   * 这对于在消息或日志中显示诊断很有用。
   *
   * @param files 要格式化的诊断文件数组
   * @returns 诊断的格式化字符串表示
   */
  static formatDiagnosticsSummary(files: DiagnosticFile[]): string {
    const truncationMarker = '…[truncated]'
    const result = files
      .map((file) => {
        const filename = file.uri.split('/').pop() || file.uri
        const diagnostics = file.diagnostics
          .map((d) => {
            const severitySymbol = DiagnosticTrackingService.getSeveritySymbol(d.severity)

            return `  ${severitySymbol} [Line ${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}${d.code ? ` [${d.code}]` : ''}${d.source ? ` (${d.source})` : ''}`
          })
          .join('\n')

        return `${filename}:\n${diagnostics}`
      })
      .join('\n\n')

    if (result.length > MAX_DIAGNOSTICS_SUMMARY_CHARS) {
      return (
        result.slice(0, MAX_DIAGNOSTICS_SUMMARY_CHARS - truncationMarker.length) + truncationMarker
      )
    }
    return result
  }

  /**
   * 获取诊断的严重程度符号
   */
  static getSeveritySymbol(severity: Diagnostic['severity']): string {
    return (
      {
        Error: CROSS,
        Warning: WARNING,
        Info: INFO,
        Hint: STAR,
      }[severity] || BULLET
    )
  }
}

export const diagnosticTracker = DiagnosticTrackingService.getInstance()
