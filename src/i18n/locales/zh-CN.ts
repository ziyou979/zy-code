import type { TranslationResource } from './resourceTypes.js'
import { zhMcp } from './zh-CN/mcp.js'
import { zhPermissions } from './zh-CN/permissions.js'
import { zhOnboarding } from './zh-CN/onboarding.js'
import { zhCommands } from './zh-CN/commands.js'
import { zhTasks } from './zh-CN/tasks.js'
import { zhAgents } from './zh-CN/agents.js'
import { zhSummary } from './zh-CN/summary.js'
import { zhSettings } from './zh-CN/settings.js'
import { zhChat } from './zh-CN/chat.js'
import { zhSession } from './zh-CN/session.js'
import { zhShell } from './zh-CN/shell.js'
import { zhStats } from './zh-CN/stats.js'
import { zhUi } from './zh-CN/ui.js'
import { zhMisc } from './zh-CN/misc.js'
import { zhPowerupLessons } from './zh-CN/powerupLessons.js'

/**
 * 简体中文
 *
 * 按 prefix 分组到 ./<locale>/<group>.ts；本文件仅做合并入口，无业务逻辑。
 * 新增 key 时：
 *   1. 在对应分组文件加，按 key 字典序排列
 *   2. 同步在另一个 locale 的同名分组文件加
 *   3. 不属于现有分组的零散 key 进 misc.ts
 */
export const zhCN: TranslationResource = {
  ...zhMcp,
  ...zhPermissions,
  ...zhOnboarding,
  ...zhCommands,
  ...zhTasks,
  ...zhAgents,
  ...zhSummary,
  ...zhSettings,
  ...zhChat,
  ...zhSession,
  ...zhShell,
  ...zhStats,
  ...zhUi,
  ...zhMisc,
  ...zhPowerupLessons,
}
