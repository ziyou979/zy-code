import type { HrTime } from '@opentelemetry/api'
import { type ExportResult, ExportResultCode } from '@opentelemetry/core'
import type {
  LogRecordExporter,
  ReadableLogRecord,
} from '@opentelemetry/sdk-logs'
import { appendFile, mkdir } from 'fs/promises'
import * as path from 'path'
import type { CoreUserData } from 'src/utils/user.js'
import { getSessionId } from '../../bootstrap/state.js'
import { ZyCodeInternalEvent } from '../../types/generated/events_mono/claude_code/v1/claude_code_internal_event.js'
import { GrowthbookExperimentEvent } from '../../types/generated/events_mono/growthbook/v1/growthbook_experiment_event.js'
import { getZyConfigHomeDir, isInternalBuild } from '../../utils/envUtils.js'
import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { stripProtoFields } from './index.js'
import { type EventMetadata, toZyEventFormat } from './metadata.js'

// API envelope - event_data is the JSON output from proto toJSON()
type ZyEventLoggingEvent = {
  event_type: 'ZyCodeInternalEvent' | 'GrowthbookExperimentEvent'
  event_data: unknown
}

type ZyEventLoggingPayload = {
  events: ZyEventLoggingEvent[]
}

/**
 * Simplified exporter for local telemetry event logging.
 * Writes events to local JSONL files instead of sending to remote API.
 */
export class ZyEventExporter implements LogRecordExporter {
  private readonly isKilled: () => boolean
  private isShutdown = false

  constructor(options: { isKilled?: () => boolean } = {}) {
    this.isKilled = options.isKilled ?? (() => false)
  }

  async export(
    logs: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): Promise<void> {
    if (this.isShutdown) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('Exporter has been shutdown'),
      })
      return
    }

    try {
      // Filter for event logs by scope name or event_type attribute
      const eventLogs = logs.filter(
        log =>
          log.instrumentationScope?.name === 'zy-code-events' ||
          log.attributes?.event_type !== undefined,
      )

      if (eventLogs.length === 0) {
        resultCallback({ code: ExportResultCode.SUCCESS })
        return
      }

      const payload = this.transformLogsToEvents(eventLogs)
      if (payload.events.length === 0) {
        resultCallback({ code: ExportResultCode.SUCCESS })
        return
      }

      if (this.isKilled()) {
        resultCallback({ code: ExportResultCode.SUCCESS })
        return
      }

      await this.appendEventsToLocalFile(payload.events)
      resultCallback({ code: ExportResultCode.SUCCESS })
    } catch (error) {
      logError(error)
      resultCallback({
        code: ExportResultCode.FAILED,
        error: toError(error),
      })
    }
  }

  private getEventsFilePath(): string {
    const sessionId = getSessionId()
    const dir = path.join(getZyConfigHomeDir(), 'telemetry')
    return path.join(dir, `events.${sessionId}.jsonl`)
  }

  private async appendEventsToLocalFile(
    events: ZyEventLoggingEvent[],
  ): Promise<void> {
    if (events.length === 0) return

    try {
      const filePath = this.getEventsFilePath()
      const dir = path.dirname(filePath)
      await mkdir(dir, { recursive: true })

      const content = events.map(e => jsonStringify(e)).join('\n') + '\n'
      await appendFile(filePath, content, 'utf8')
    } catch (error) {
      logError(error)
      throw error
    }
  }

  private hrTimeToDate(hrTime: HrTime): Date {
    const [seconds, nanoseconds] = hrTime
    return new Date(seconds * 1000 + nanoseconds / 1000000)
  }

  private transformLogsToEvents(
    logs: ReadableLogRecord[],
  ): ZyEventLoggingPayload {
    const events: ZyEventLoggingEvent[] = []

    for (const log of logs) {
      const attributes = log.attributes || {}

      // Check if this is a GrowthBook experiment event
      if (attributes.event_type === 'GrowthbookExperimentEvent') {
        const timestamp = this.hrTimeToDate(log.hrTime)
        const account_uuid = attributes.account_uuid as string | undefined
        const organization_uuid = attributes.organization_uuid as
          | string
          | undefined
        events.push({
          event_type: 'GrowthbookExperimentEvent',
          event_data: GrowthbookExperimentEvent.toJSON({
            event_id: attributes.event_id as string,
            timestamp,
            experiment_id: attributes.experiment_id as string,
            variation_id: attributes.variation_id as number,
            environment: attributes.environment as string,
            user_attributes: attributes.user_attributes as string,
            experiment_metadata: attributes.experiment_metadata as string,
            device_id: attributes.device_id as string,
            session_id: attributes.session_id as string,
            auth:
              account_uuid || organization_uuid
                ? { account_uuid, organization_uuid }
                : undefined,
          }),
        })
        continue
      }

      // Extract event name
      const eventName =
        (attributes.event_name as string) || (log.body as string) || 'unknown'

      // Extract metadata objects directly (no JSON parsing needed)
      const coreMetadata = attributes.core_metadata as unknown as EventMetadata | undefined
      const userMetadata = attributes.user_metadata as CoreUserData
      const eventMetadata = (attributes.event_metadata || {}) as Record<
        string,
        unknown
      >

      if (!coreMetadata) {
        // Emit partial event if core metadata is missing
        if (isInternalBuild()) {
          console.debug(
            `ZY event logging: core_metadata missing for event ${eventName}`,
          )
        }
        events.push({
          event_type: 'ZyCodeInternalEvent',
          event_data: ZyCodeInternalEvent.toJSON({
            event_id: attributes.event_id as string | undefined,
            event_name: eventName,
            client_timestamp: this.hrTimeToDate(log.hrTime),
            session_id: getSessionId(),
            additional_metadata: Buffer.from(
              jsonStringify({
                transform_error: 'core_metadata attribute is missing',
              }),
            ).toString('base64'),
          }),
        })
        continue
      }

      // Transform to ZY format
      const formatted = toZyEventFormat(
        coreMetadata,
        userMetadata,
        eventMetadata,
      )

      // _PROTO_* keys are PII-tagged values meant only for privileged BQ
      // columns. Hoist known keys to proto fields, then defensively strip any
      // remaining _PROTO_* so an unrecognized future key can't silently land
      // in the general-access additional_metadata blob. sink.ts applies the
      // same strip before Datadog; this closes the ZY side.
      const {
        _PROTO_skill_name,
        _PROTO_plugin_name,
        _PROTO_marketplace_name,
        ...rest
      } = formatted.additional
      const additionalMetadata = stripProtoFields(rest)

      events.push({
        event_type: 'ZyCodeInternalEvent',
        event_data: ZyCodeInternalEvent.toJSON({
          event_id: attributes.event_id as string | undefined,
          event_name: eventName,
          client_timestamp: this.hrTimeToDate(log.hrTime),
          device_id: attributes.user_id as string | undefined,
          email: userMetadata?.email,
          auth: formatted.auth,
          ...formatted.core,
          env: formatted.env,
          process: formatted.process,
          skill_name:
            typeof _PROTO_skill_name === 'string'
              ? _PROTO_skill_name
              : undefined,
          plugin_name:
            typeof _PROTO_plugin_name === 'string'
              ? _PROTO_plugin_name
              : undefined,
          marketplace_name:
            typeof _PROTO_marketplace_name === 'string'
              ? _PROTO_marketplace_name
              : undefined,
          additional_metadata:
            Object.keys(additionalMetadata).length > 0
              ? Buffer.from(jsonStringify(additionalMetadata)).toString(
                  'base64',
                )
              : undefined,
        }),
      })
    }

    return { events }
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true
    if (isInternalBuild()) {
      console.debug('ZY event logging exporter shutdown complete')
    }
  }

  async forceFlush(): Promise<void> {
    // No-op: writes are synchronous and don't need flushing
    if (isInternalBuild()) {
      console.debug('ZY event logging exporter flush complete')
    }
  }
}
