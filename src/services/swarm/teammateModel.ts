import { parseUserSpecifiedModel } from '../model/model.js'

// 用户从未在 /config 中设置 teammateDefaultModel 时，新 teammate 使用已配置的 advanced
// tier 模型；同时解析 settings 中的 tier 别名和自定义模型别名。
export function getTeammateModelFallback(): string {
  return parseUserSpecifiedModel('advanced')
}
