import type { ThemeName } from '../environment/theme.js'
import type { FileStateCache } from '../file-persistence/fileStateCache.js'

/**
 * Spinner 提示（tips）的类型定义。
 * 原上游类型文件缺失，调用方用 @ts-expect-error 退化为 any；这里按实际用法补齐。
 */
export type TipContext = {
  theme: ThemeName
  /** 本会话已读取的文件，用于按文件路径判断提示相关性 */
  readFileState?: FileStateCache
  /** 本会话执行过的 CLI 命令名，用于按命令判断提示相关性 */
  bashTools?: Set<string>
}

export type Tip = {
  id: string
  content: (context: TipContext) => Promise<string>
  /** 两次展示之间至少间隔的会话数 */
  cooldownSessions: number
  isRelevant: (context?: TipContext) => Promise<boolean>
}
