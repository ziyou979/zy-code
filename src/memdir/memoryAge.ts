/**
 * 从 mtime 起经过的天数，向下取整：今天为 0，昨天为 1，更早为 2 以上。
 * 负数输入（未来的 mtime 或时钟偏差）会限制为 0。
 */
export function memoryAgeDays(mtimeMs: number): number {
  const now = new Date(Date.now())
  const mtime = new Date(mtimeMs)
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const memoryDay = Date.UTC(mtime.getFullYear(), mtime.getMonth(), mtime.getDate())
  return Math.max(0, Math.round((today - memoryDay) / 86_400_000))
}

/**
 * 易读的时间差字符串。Model 不擅长日期计算；与“47 天前”相比，
 * 原始 ISO 时间戳不容易触发对过期风险的推理。
 */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d === 0) {
    return 'today'
  }
  if (d === 1) {
    return 'yesterday'
  }
  return `${d} days ago`
}

/**
 * 针对超过 1 天的 memory 返回纯文本过期提示。对新鲜的 memory（今天或昨天）
 * 返回 ''，因为此时警告只会增加噪声。
 *
 * consumer 已自行提供包装时使用（如 messages.ts 的
 * relevant_memories → wrapMessagesInSystemReminder）。
 *
 * 该提示源于用户反馈：过期的代码状态 memory（引用已变更代码的 file:line）
 * 会被当作事实。这种引用反而使过期说法听起来更权威。
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d <= 1) {
    return ''
  }
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  )
}

/**
 * 使用 <system-reminder> tag 包装的单个 memory 过期提示。
 * memory 不超过 1 天时返回 ''。适用于不会自行添加 system-reminder 包装的调用方
 *（如 FileReadTool 输出）。
 */
export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs)
  if (!text) {
    return ''
  }
  return `<system-reminder>${text}</system-reminder>\n`
}
