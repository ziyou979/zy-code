/**
 * Copy 命令，仅包含最少 metadata。
 * 实现从 copy.tsx 延迟加载，以缩短启动时间。
 */
import type { Command } from '../../commands/index.js'

const copy = {
  type: 'local-jsx',
  name: 'copy',
  description: "Copy Zy's last response to clipboard (or /copy N for the Nth-latest)",
  load: () => import('./copy.js'),
} satisfies Command

export default copy
