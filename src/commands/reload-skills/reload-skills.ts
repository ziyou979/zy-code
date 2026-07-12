import { clearCommandMemoizationCaches, getSkillToolCommands } from '../../commands.js'
import { tSync } from '../../i18n/index.js'
import { clearPluginSkillsCache } from '../../services/plugins/loadPluginCommands.js'
import { clearDynamicSkills } from '../../skills/loadSkillsDir.js'
import type { LocalCommandCall } from '../../types/command.js'
import { plural } from '../../utils/stringUtils.js'

export const call: LocalCommandCall = async (_args, context) => {
  // 0. 重扫前先保存技能列表用于对比变化
  const beforeSkills = await getSkillToolCommands(process.cwd())
  const beforeNames = new Set(beforeSkills.map((s) => s.name).filter(Boolean))

  // 1. 清除所有 memoization 缓存（getSkillToolCommands、getSlashCommandToolSkills、skill index）
  clearCommandMemoizationCaches()
  // 2. 清除 skill 目录命令缓存（getSkillDirCommands、conditional skills）
  //    注意：此处仅清除 skill 相关缓存，不清除插件缓存
  const { clearSkillCaches } = await import('../../skills/loadSkillsDir.js')
  clearSkillCaches()
  // 3. 清除动态技能状态
  clearDynamicSkills()
  // 4. 清除插件技能缓存（仅限于技能部分，不涉及完整插件生命周期）
  clearPluginSkillsCache()

  // 5. 触发重新扫描：调用 getSkillToolCommands 会触发重新加载
  const skills = await getSkillToolCommands(process.cwd())
  const skillCount = skills.length

  // 6. 检测是否有变化（新增/移除的技能）
  const afterNames = new Set(skills.map((s) => s.name).filter(Boolean))
  const added = [...afterNames].filter((n) => !beforeNames.has(n))
  const removed = [...beforeNames].filter((n) => !afterNames.has(n))

  if (added.length === 0 && removed.length === 0) {
    // 无变化：简洁提示，不列技能列表（CC 行为对齐）
    return {
      type: 'text' as const,
      value: tSync('commands.reloadSkills.noChanges', {
        count: String(skillCount),
      }),
    }
  }

  // 有变化：展示变化详情
  const parts: string[] = []
  if (added.length > 0) {
    parts.push(
      tSync('commands.reloadSkills.added', {
        count: String(added.length),
        names: added.join(', '),
      }),
    )
  }
  if (removed.length > 0) {
    parts.push(
      tSync('commands.reloadSkills.removed', {
        count: String(removed.length),
        names: removed.join(', '),
      }),
    )
  }

  return {
    type: 'text' as const,
    value: tSync('commands.reloadSkills.changed', {
      count: String(skillCount),
      changes: parts.join('; '),
    }),
  }
}
