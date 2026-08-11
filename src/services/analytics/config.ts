/**
 * 共享分析配置
 *
 * 用于确定何时应在所有分析系统（Datadog、直接 API）中
 * 禁用分析的通用逻辑
 */

import { isTelemetryDisabled } from '../telemetry/privacyLevel.js'

/**
 * 检查分析操作是否应被禁用
 *
 * 以下情况禁用分析：
 * - 测试环境 (NODE_ENV === 'test')
 * - 第三方云提供商
 * - 隐私级别为 no-telemetry 或 essential-traffic
 */
export function isAnalyticsDisabled(): boolean {
  return process.env.NODE_ENV === 'test' || isTelemetryDisabled()
}

/**
 * 检查反馈调查是否应被抑制。
 *
 * 与 isAnalyticsDisabled() 不同，这不会在 3P 提供商
 * (Bedrock/Vertex) 上阻止。调查是一个本地 UI 提示，
 * 不包含会话记录数据 —— 企业客户通过 OTEL 捕获响应。
 */
export function isFeedbackSurveyDisabled(): boolean {
  return process.env.NODE_ENV === 'test' || isTelemetryDisabled()
}
