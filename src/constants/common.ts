import { formatMonthYear } from '../utils/format.js'
import memoize from 'lodash-es/memoize.js'

// 确保得到 ISO 格式的本地日期。
export function getLocalISODate(): string {
  // 检查仅供 ant 使用的日期覆盖值。
  if (process.env.ZY_CODE_OVERRIDE_DATE) {
    return process.env.ZY_CODE_OVERRIDE_DATE
  }

  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// 为保持 prompt cache 稳定而记忆化：会话开始时只获取一次日期。
// 主交互路径通过 context.ts 中的 memoize(getUserContext) 获得此行为；简单模式
//（--bare）会按请求调用 getSystemPrompt，因此需要显式缓存日期，避免午夜时使缓存前缀失效。
// 跨过午夜后，getDateChangeAttachments 会在尾部附加新日期；简单模式会禁用附件，
// 此时需要在“午夜后日期暂时过期”和“几乎整段会话缓存失效”之间取舍，前者代价更低。
export const getSessionStartDate = memoize(getLocalISODate)

// 按用户本地时区返回“月份 YYYY”，例如“February 2026”。
// 该值每月而非每天变化，用于工具 prompt，以尽量减少缓存失效。
export function getLocalMonthYear(): string {
  const date = process.env.ZY_CODE_OVERRIDE_DATE
    ? new Date(process.env.ZY_CODE_OVERRIDE_DATE)
    : new Date()
  return formatMonthYear(date)
}
