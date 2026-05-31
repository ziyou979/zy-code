import { tSync } from '../i18n/index.js'

// 空内容占位文案。**记忆化**：它既是展示文案，又是消息相等性哨兵（constructors 写入、
// predicates/normalize 比对）。对哨兵而言相等一致性优先于语言反应性——若每次调用都重译，
// 跨语言切换会让切换前创建的占位消息无法再被识别。首次调用（启动后、语言已就绪）冻结取值，
// 全程一致；同时避免了模块顶层求值（断环 + 不冻结于 import 时刻的语言）。
let _noContentMessage: string | undefined
export function getNoContentMessage(): string {
  if (_noContentMessage === undefined) {
    _noContentMessage = tSync('common.noContent')
  }
  return _noContentMessage
}
