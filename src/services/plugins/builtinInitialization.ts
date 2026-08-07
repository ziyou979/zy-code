/**
 * Built-in Plugin Initialization
 *
 * Initializes built-in plugins that ship with the CLI and appear in the
 * /plugin UI for users to enable/disable.
 *
 * Not all bundled features should be built-in plugins — use this for
 * features that users should be able to explicitly enable/disable. For
 * features with complex setup or automatic-enabling logic (e.g.
 * claude-in-chrome), use src/skills/bundled/ instead.
 *
 * To add a new built-in plugin:
 * 1. 从 builtinRegistry.ts 导入 registerBuiltinPlugin
 * 2. Call registerBuiltinPlugin() with the plugin definition here
 */

import { registerBuiltinPlugin } from './builtinRegistry.js'
import { codeReviewSkill } from '../../skills/bundled/codeReview.js'
import { reviewSkill } from '../../skills/bundled/review.js'
import { securityReviewSkill } from '../../skills/bundled/securityReview.js'
import { simplifySkill } from '../../skills/bundled/simplify.js'

/**
 * Initialize built-in plugins. Called during CLI startup.
 *
 * review 系列命令以内置插件形式提供（`{name}@builtin`），对齐 Claude Code
 * 的插件命令形态（code-review/security-review/simplify 在 CC 中即插件）：
 * prompt 编译进二进制（等价 CC 的内置插件），用户可在 /plugin UI 中启用/禁用。
 */
export function initBuiltinPlugins(): void {
  registerBuiltinPlugin({
    name: 'review',
    description: 'Review a GitHub pull request',
    skills: [reviewSkill],
  })
  registerBuiltinPlugin({
    name: 'code-review',
    // 插件级描述对齐 CC code-review 插件的 marketplace meta
    description:
      'Automated code review for pull requests using multiple specialized agents with confidence-based scoring',
    skills: [codeReviewSkill],
  })
  registerBuiltinPlugin({
    name: 'security-review',
    description: 'Complete a security review of the pending changes on the current branch',
    skills: [securityReviewSkill],
  })
  registerBuiltinPlugin({
    name: 'simplify',
    description: 'Clean up the changed code without changing behavior',
    skills: [simplifySkill],
  })
  // 注：commit/commit-push-pr 不再内置。CC 2.1.221 运行时实测两者均
  // "Unknown command"（内部命令，外部构建过滤）；用户需要时经市场插件
  // commit-commands@claude-plugins-official 获得（ZY 的加载链已验证兼容）。
}
