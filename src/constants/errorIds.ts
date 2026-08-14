/**
 * 用于在生产环境追踪错误来源的错误 ID。
 * 这些 ID 是经过混淆的标识符，可帮助定位由哪个 logError() 调用产生错误。
 *
 * 每种错误均以独立 const 导出，以获得最佳死代码消除效果；外部构建只能看到数字。
 *
 * 新增错误类型：
 * 1. 使用下一个 ID 新增 const。
 * 2. 递增“下一个 ID”。
 * 下一个 ID：346
 */

export const E_TOOL_USE_SUMMARY_GENERATION_FAILED = 344
