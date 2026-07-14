// api.ts — barrel reexport，保持对外 import 路径不变。
// 实现已下沉到 apiNormalize.ts / systemReminder.ts / attachmentApi.ts。

// 从 apiNormalize.ts 重新导出公共 API
export {
  filterUnresolvedToolUses,
  normalizeMessagesForAPI,
  reorderAttachmentsForAPI,
  reorderMessagesInUI,
} from './apiNormalize.js'
export { ensureToolResultPairing } from './attachment-api/toolResultPairing.js'

// 从 attachmentApi.ts 重新导出公共 API
export { normalizeAttachmentForAPI, wrapCommandText } from './attachmentApi.js'
// 从 systemReminder.ts 重新导出公共 API
export { wrapInSystemReminder, wrapMessagesInSystemReminder } from './systemReminder.js'
