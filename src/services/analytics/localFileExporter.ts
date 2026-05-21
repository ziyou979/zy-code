import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type ExportResult, ExportResultCode } from '@opentelemetry/core'
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs'

/**
 * Local-only exporter that writes all events to a local file
 * instead of sending them to the remote endpoint.
 */
export class LocalFileExporter implements LogRecordExporter {
  private readonly logFile: string
  private isShutdown = false

  constructor() {
    const logDir = join(process.env.HOME || process.env.USERPROFILE || '~', '.zy', 'telemetry')
    this.logFile = join(logDir, 'zy_events.log')
    mkdirSync(logDir, { recursive: true })
  }

  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    if (this.isShutdown) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('Exporter has been shutdown'),
      })
      return
    }

    try {
      for (const log of logs) {
        const entry = {
          timestamp: log.hrTime
            ? new Date(log.hrTime[0] * 1000 + log.hrTime[1] / 1000000).toISOString()
            : new Date().toISOString(),
          scope: log.instrumentationScope?.name,
          body: log.body,
          attributes: log.attributes,
        }
        appendFileSync(this.logFile, `${JSON.stringify(entry)}\n`, 'utf8')
      }
      resultCallback({ code: ExportResultCode.SUCCESS })
    } catch {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('Failed to write to local file'),
      })
    }
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true
  }

  async forceFlush(): Promise<void> {
    // No-op for file-based exporter
  }
}
