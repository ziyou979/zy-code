/**
 * 时间戳格式化——收敛各处手写的 padStart 样板。
 * 全部使用本地时区，输入缺省为当前时间。
 */

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 本地时间 `HH:mm:ss`（24 小时制），用于状态行/日志时间戳。 */
export function formatTimestamp(date: Date = new Date()): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** 本地日期 `YYYY-MM-DD`。 */
export function formatLocalISODate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 文件名安全的时间戳 `YYYY-MM-DD-HHmmss`，用于导出文件名。 */
export function formatFileTimestamp(date: Date = new Date()): string {
  return `${formatLocalISODate(date)}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
}

/** 12 小时制 `h:mm:ssam/pm`，用于面向用户的紧凑展示。 */
export function formatTimestamp12h(date: Date = new Date()): string {
  const h = date.getHours() % 12 || 12
  const ampm = date.getHours() < 12 ? 'am' : 'pm'
  return `${h}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${ampm}`
}
