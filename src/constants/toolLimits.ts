/**
 * 与工具结果尺寸限制有关的常量。
 */

/**
 * 工具结果持久化到磁盘前允许的默认最大字符数。超过限制后，结果会保存到文件，
 * 模型只接收预览和文件路径，不再接收完整内容。
 *
 * 单个工具可声明更低的 maxResultSizeChars，但无论工具如何声明，此常量都是全局上限。
 */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000

/**
 * 工具结果的最大 token 数。
 * 根据工具结果尺寸分析，将其设为合理上限，避免超大结果占用过多上下文。
 *
 * 按每 token 约 4 字节估算，相当于约 400KB 文本。
 */
export const MAX_TOOL_RESULT_TOKENS = 100_000

/**
 * 根据字节数估算 token 数时采用的每 token 字节数。
 * 这是保守估计，实际 token 数可能有所不同。
 */
export const BYTES_PER_TOKEN = 4

/**
 * 由 token 限制推导出的工具结果最大字节数。
 */
export const MAX_TOOL_RESULT_BYTES = MAX_TOOL_RESULT_TOKENS * BYTES_PER_TOKEN

/**
 * 单条用户消息（即一轮并行工具结果）内所有 tool_result 块的默认最大字符总数。
 * 消息中的块合计超限时，会优先把最大的块持久化到磁盘并替换为预览，直到回到预算内。
 * 各消息独立评估：前后两轮各有一个 150K 结果时，两者都不会被处理。
 *
 * 这样可以避免 N 个并行工具各自达到单工具上限，例如一轮产生 10 × 40K = 400K。
 *
 * 可通过 GrowthBook flag zy_hawthorn_window 在运行时覆盖；参见
 * toolResultStorage.ts 中的 getPerMessageBudgetLimit()。
 */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000

/**
 * 紧凑视图中工具摘要字符串的最大字符数。
 * getToolUseSummary() 实现会用它截断长输入，供 agent 分组渲染展示。
 */
export const TOOL_SUMMARY_MAX_LENGTH = 50
