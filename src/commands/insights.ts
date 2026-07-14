/**
 * insights.ts 的稳定公开入口。
 * 具体职责已拆分到同名子目录，调用方无需感知内部模块布局。
 */
export { buildExportData } from './insights/exportData.js'
export { deduplicateSessionBranches } from './insights/sessionAnalysis.js'
export { detectMultiClauding } from './insights/sessionAnalysis.js'
export { generateUsageReport } from './insights/exportData.js'
export type { InsightsExport } from './insights/exportData.js'
export { default } from './insights/exportData.js'
