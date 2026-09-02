import { getAuthProfileForModel, getMainLoopModel, getProviderForModel } from './model.js'
import type { ApiFormat } from './apiFormat.js'
import { getEffectiveApiFormat, type APIProvider } from './providers.js'

/**
 * 一次请求的模型路由上下文。
 *
 * provider、连接与协议格式必须基于同一个 model 一次性解析，避免调用方分别读取
 * 全局状态后得到互相矛盾的结果。
 */
export type ModelRequestContext = {
  model?: string
  provider: APIProvider
  authProfile?: string
  apiFormat: ApiFormat
}

/** 解析模型请求所需的路由事实；未传模型时使用当前主循环模型。 */
export function resolveModelRequestContext(model?: string | null): ModelRequestContext {
  const resolvedModel = model ?? getMainLoopModel()
  const provider = getProviderForModel(resolvedModel)
  const authProfile = getAuthProfileForModel(resolvedModel)
  const apiFormat = getEffectiveApiFormat(provider, resolvedModel)

  if (!apiFormat) {
    throw new Error(`Provider "${provider}" does not declare a supported API format`)
  }

  return {
    model: resolvedModel,
    provider,
    authProfile,
    apiFormat,
  }
}
