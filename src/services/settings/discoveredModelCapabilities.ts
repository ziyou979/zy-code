import { z } from 'zod/v4'
import { toError } from '../../utils/errors.js'
import { readModelCapabilityState, writeModelCapabilityState } from './modelCapabilityStorage.js'
import {
  parseModelCapabilityEntry,
  type ModelCapabilityEntry,
  type ModelCapabilityMatchContext,
} from './localModelCapabilities.js'
import type { ModelCatalogCapability } from '../model/modelCatalogCapabilities.js'
import type { ApiFormat } from '../model/apiFormat.js'

const FileSchema = z.object({
  version: z.literal(1),
  entries: z.array(
    z.object({
      model: z.string(),
      connectionId: z.string(),
      provider: z.string(),
      apiFormat: z.string().optional(),
      entry: z.unknown(),
      source: z.enum(['catalog', 'registry', 'user']).optional(),
      updatedAt: z.string().optional(),
    }),
  ),
})

function readFile(): z.infer<typeof FileSchema> {
  return readModelCapabilityState('discovery', FileSchema) ?? { version: 1, entries: [] }
}

/** 自动目录数据独立保存，不能覆盖用户手工维护的能力文件。 */
export function saveDiscoveredModelCapability(
  selection: {
    model: string
    connectionId: string
    provider: string
    apiFormat?: ApiFormat
  },
  capability: ModelCatalogCapability,
  source: 'catalog' | 'registry' | 'user' = 'catalog',
): { error: Error | null } {
  try {
    const file = readFile()
    const entry = parseModelCapabilityEntry({
      pattern: selection.model,
      provider: selection.provider,
      apiFormat: selection.apiFormat,
      ...capability,
    })
    if (!entry) throw new Error('Invalid discovered model capability')
    file.entries = file.entries.filter(
      (item) =>
        !(
          item.model === selection.model &&
          item.connectionId === selection.connectionId &&
          item.provider === selection.provider &&
          item.apiFormat === selection.apiFormat &&
          (item.source === 'user') === (source === 'user')
        ),
    )
    // 不能 spread 调用方对象，避免连接选项中的 apiKey 等额外字段进入能力缓存。
    file.entries.push({
      model: selection.model,
      connectionId: selection.connectionId,
      provider: selection.provider,
      apiFormat: selection.apiFormat,
      entry,
      source,
      updatedAt: new Date().toISOString(),
    })
    writeModelCapabilityState('discovery', file)
    return { error: null }
  } catch (error) {
    return { error: toError(error) }
  }
}

/** 按完整模型 ID、命名连接与协议匹配，避免同名代理模型互相污染。 */
export function getDiscoveredModelCapabilitySnapshot(
  model: string,
  context: ModelCapabilityMatchContext,
  kind: 'automatic' | 'user' = 'automatic',
):
  | { entry: ModelCapabilityEntry; source: 'catalog' | 'registry' | 'user'; updatedAt?: string }
  | undefined {
  try {
    // 手工界面覆盖与自动目录结果各保存一份，刷新不会覆盖用户选择。
    const matches = readFile().entries.filter(
      (item) =>
        item.model === model &&
        item.provider === context.provider &&
        item.connectionId === (context.connectionId ?? context.provider) &&
        item.apiFormat === context.apiFormat &&
        (item.source === 'user') === (kind === 'user'),
    )
    const selected = matches.at(-1)
    const entry = selected ? parseModelCapabilityEntry(selected.entry) : undefined
    return selected && entry
      ? { entry, source: selected.source ?? 'catalog', updatedAt: selected.updatedAt }
      : undefined
  } catch {
    // 损坏的自动元数据不应使用户手工配置失效；下一次保存会明确报告错误。
    return undefined
  }
}

export function getDiscoveredModelCapability(
  model: string,
  context: ModelCapabilityMatchContext,
  kind: 'automatic' | 'user' = 'automatic',
): ModelCapabilityEntry | undefined {
  return getDiscoveredModelCapabilitySnapshot(model, context, kind)?.entry
}
