/**
 * /reload-skills — 重扫技能目录并使新技能在当前会话中立即可用。
 * 与 /reload-plugins 不同：仅影响 skill 缓存，不涉及插件生命周期。
 * /reload-plugins 负责插件变更（插件提供的 commands/agents/skills/hooks/MCP/LSP），
 * /reload-skills 负责 skill 目录（本地 .claude/skills、内建技能、search index 等）。
 */
import type { Command } from '../../commands.js'

const reloadSkills = {
  type: 'local',
  name: 'reload-skills',
  description: 'Rescan skill directories and apply skill changes to the current session',
  supportsNonInteractive: false,
  load: () => import('./reload-skills.js'),
} satisfies Command

export default reloadSkills
