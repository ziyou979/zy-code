import type { TranslationResource } from './resourceTypes.js'
import { enMcp } from './en/mcp.js'
import { enPermissions } from './en/permissions.js'
import { enOnboarding } from './en/onboarding.js'
import { enCommands } from './en/commands.js'
import { enTasks } from './en/tasks.js'
import { enAgents } from './en/agents.js'
import { enSummary } from './en/summary.js'
import { enSettings } from './en/settings.js'
import { enChat } from './en/chat.js'
import { enSession } from './en/session.js'
import { enShell } from './en/shell.js'
import { enStats } from './en/stats.js'
import { enUi } from './en/ui.js'
import { enMisc } from './en/misc.js'

/**
 * English — base language (source of truth for keys)
 *
 * 按 prefix 分组到 ./<locale>/<group>.ts；本文件仅做合并入口，无业务逻辑。
 * 新增 key 时：
 *   1. 在对应分组文件加，按 key 字典序排列
 *   2. 同步在另一个 locale 的同名分组文件加
 *   3. 不属于现有分组的零散 key 进 misc.ts
 */
export const en: TranslationResource = {
  ...enMcp,
  ...enPermissions,
  ...enOnboarding,
  ...enCommands,
  ...enTasks,
  ...enAgents,
  ...enSummary,
  ...enSettings,
  ...enChat,
  ...enSession,
  ...enShell,
  ...enStats,
  ...enUi,
  ...enMisc,
}
