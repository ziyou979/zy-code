import { tSync } from '../../i18n/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getDefaultAdvancedModel, getDefaultMainLoopModel } from '../model/model.js'

/**
 * 获取 /ultraplan 远程会话使用的模型。
 *
 * 优先使用 settings.models.advanced，未配置时回退到 settings.mainLoopModel
 * 对应的 tier 模型，再未配置则抛错。
 *
 * CCR runs against the direct API — use the canonical ID, not the
 * provider-specific string getModelStrings() would return (which may be a
 * Bedrock ARN or Vertex ID on the local CLI). Read at call time, not module
 * load: the GrowthBook cache is empty at import and `/config` Gates can flip
 * it between invocations.
 */
export function getUltraplanModel(): string {
  const model = getDefaultAdvancedModel() ?? getDefaultMainLoopModel()
  if (!model) {
    throw new Error(tSync('ultraplan.noModelConfigured'))
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('zy_ultraplan_model', model)
}
