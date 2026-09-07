import { feature } from 'bun:bundle'
import { getKairosActive, getUserMsgOptIn } from '../../bootstrap/runtime/runtimeContext.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'

/**
 * 判断当前用户是否有权启用 Brief。这里只包含门控依赖，避免设置页为读取一个布尔值
 * 而加载 BriefTool 的 UI、附件处理和工具注册链，进而落入循环模块的未完成导出。
 */
export function isBriefEntitled(): boolean {
  // 正向三元表达式是构建期 DCE 的必要结构，不能改成否定条件的提前返回。
  return feature('KAIROS') || feature('KAIROS_BRIEF')
    ? getKairosActive() ||
        isEnvTruthy(process.env.ZY_CODE_BRIEF) ||
        getFeatureValue_CACHED_MAY_BE_STALE('zy_kairos_brief', false)
    : false
}

/**
 * 判断 Brief 是否在当前会话实际启用。授权和用户选择加入分别检查，Kairos 模式可直接启用。
 */
export function isBriefEnabled(): boolean {
  // 顶层 feature() 条件使外部构建可以完整删除 Brief 运行时分支。
  return feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (getKairosActive() || getUserMsgOptIn()) && isBriefEntitled()
    : false
}
