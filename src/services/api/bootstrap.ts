import isEqual from 'lodash-es/isEqual.js'
import { z } from 'zod'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'

const bootstrapResponseSchema = lazySchema(() =>
  z.object({
    client_data: z.record(z.unknown()).nullish(),
    additional_model_options: z
      .array(
        z
          .object({
            model: z.string(),
            name: z.string(),
            description: z.string(),
          })
          .transform(({ model, name, description }) => ({
            value: model,
            label: name,
            description,
          })),
      )
      .nullish(),
  }),
)

type BootstrapResponse = z.infer<ReturnType<typeof bootstrapResponseSchema>>

async function fetchBootstrapAPI(): Promise<BootstrapResponse | null> {
  // 跳过 Bootstrap API 调用（当前区域无法访问）
  logForDebugging('[Bootstrap] 已跳过：API 在当前区域不可访问')
  return null
}

/**
 * 从 API 获取引导数据并持久化到磁盘缓存。
 */
export async function fetchBootstrapData(): Promise<void> {
  try {
    const response = await fetchBootstrapAPI()
    if (!response) return

    const clientData = response.client_data ?? null
    const additionalModelOptions = response.additional_model_options ?? []

    // 仅在数据实际变更时持久化 — 避免每次启动都写入配置。
    const config = getGlobalConfig()
    if (
      isEqual(config.clientDataCache, clientData) &&
      isEqual(config.additionalModelOptionsCache, additionalModelOptions)
    ) {
      logForDebugging('[Bootstrap] 缓存未变更，跳过写入')
      return
    }

    logForDebugging('[Bootstrap] 缓存已更新，持久化到磁盘')
    saveGlobalConfig((current) => ({
      ...current,
      clientDataCache: clientData,
      additionalModelOptionsCache: additionalModelOptions,
    }))
  } catch (error) {
    logError(error)
  }
}
