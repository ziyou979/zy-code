import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import type { BundledSkillDefinition } from '../bundledSkills.js'
import { toolMatchesName } from '../../tools/tool.js'
import type { ToolUseContext } from '../../tools/tool.js'

/**
 * /simplify skill — 对改动代码做复用/简化/效率/深度四角度清理并直接修复。
 * 对齐 Claude Code 2.1.220 的内建 /simplify：
 * Agent 工具可用（且非子 agent 上下文）时走 4-agent 并行审查（QGE），
 * 否则单遍内联完成四角度（ZGE）。只做质量清理，不猎 bug（那是 /code-review 的职责）。
 */

/** Phase 0：收集 diff（CC gMe）。 */
const GATHER_DIFF_PROMPT = `## Phase 0 \u2014 Gather the diff

Run \`git diff @{upstream}...HEAD\` (or \`git diff main...HEAD\` / \`git diff HEAD~1\`
if there's no upstream) to get the unified diff under review. If there are
uncommitted changes, or the range diff is empty, also run \`git diff HEAD\` and
include the working-tree changes in scope \u2014 the review often runs before the
commit. If a PR number, branch name, or file path was passed as an argument,
review that target instead. Treat this diff as the review scope.
`

/** 角度 1：复用（CC xWt）。 */
const REUSE_ANGLE = `Flag new code that re-implements something the codebase
already has \u2014 Grep shared/utility modules and files adjacent to the change,
and name the existing helper to call instead.
`

/** 角度 2：简化（CC yMe）。 */
const SIMPLIFICATION_ANGLE = `### Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state,
copy-paste with slight variation, deep nesting, dead code left behind. Name
the simpler form that does the same job.
`

/** 角度 3：效率（CC _Me）。 */
const EFFICIENCY_ANGLE = `### Efficiency

Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or
hot paths. Also flag long-lived objects built from closures or captured
environments \u2014 they keep the entire enclosing scope alive for the object's
lifetime (a memory leak when that scope holds large values); prefer a
class/struct that copies only the fields it needs. Name the cheaper
alternative.
`

/** 角度 4：深度（CC bMe）。 */
const ALTITUDE_ANGLE = `### Altitude

Check that each change is implemented at the right depth, not as a fragile
bandaid. Special cases layered on shared infrastructure are a sign the fix
isn't deep enough \u2014 prefer generalizing the underlying mechanism over adding
special cases.
`

/** 四角度内容（Reuse 标题在模板中固定，其余角度自带标题）。 */
const ANGLES = `${REUSE_ANGLE}
${SIMPLIFICATION_ANGLE}
${EFFICIENCY_ANGLE}
${ALTITUDE_ANGLE}`

const PROMPT_HEADER = `You are improving the quality of the changed code, not hunting for bugs. Review
it for reuse, simplification, efficiency, and altitude issues, then fix what you
find. Do not look for correctness bugs \u2014 that is what \`/code-review\` is for.

`

/** Agent 版模板：4 个清理 agent 并行（CC QGE）。 */
const FAN_OUT_PROMPT = `\`/simplify \u2192 4 cleanup agents in parallel \u2192 apply the fixes\`

${PROMPT_HEADER}${GATHER_DIFF_PROMPT}
## Phase 1 \u2014 Review (4 cleanup agents in parallel)

Launch **4 independent review agents** via the ${AGENT_TOOL_NAME} tool, all in a
single message so they run concurrently. Pass each agent the diff and one of
the four angles below. Each returns its findings with \`file\`, \`line\`, a
one-line \`summary\`, and the concrete cost (what is duplicated, wasted, or
harder to maintain).

### Reuse

${ANGLES}
## Phase 2 \u2014 Apply the fixes

Wait for all four agents to complete, dedup findings that point at the same
line or mechanism, and fix each remaining one directly. Skip any finding whose
fix would change intended behavior, require changes well outside the reviewed
diff, or that you judge to be a false positive \u2014 note the skip rather than
arguing with it. Finish with a brief summary of what was fixed and what was
skipped (or confirm the code was already clean).
`

/** 单遍模板：Agent 不可用时内联完成四角度（CC ZGE）。 */
const SINGLE_PASS_PROMPT = `\`/simplify \u2192 ${AGENT_TOOL_NAME} tool unavailable \u2192 single-pass inline cleanup \u2192 apply the fixes\`

${PROMPT_HEADER}The ${AGENT_TOOL_NAME} tool isn't available in this context, so the usual
4-agent fan-out can't run. Work through all four angles below yourself, in
this same context, in one pass \u2014 do not skip an angle for lack of fan-out.

${GATHER_DIFF_PROMPT}
## Phase 1 \u2014 Review (4 cleanup angles, single pass)

Review the diff against each angle below in turn. For each, note findings with
\`file\`, \`line\`, a one-line \`summary\`, and the concrete cost (what is
duplicated, wasted, or harder to maintain).

### Reuse

${ANGLES}
## Phase 2 \u2014 Apply the fixes

Dedup findings that point at the same line or mechanism, and fix each
remaining one directly. Skip any finding whose fix would change intended
behavior, require changes well outside the reviewed diff, or that you judge to
be a false positive \u2014 note the skip rather than arguing with it. Finish with a
brief summary of what was fixed and what was skipped (or confirm the code was
already clean). State clearly in your summary that this was a single-pass
review done without the ${AGENT_TOOL_NAME} tool, not the full 4-agent
fan-out, so whoever reads it isn't misled about what actually ran.
`

/**
 * 是否可 fan-out 4 个 agent（对齐 CC z3o）：
 * 子 agent 上下文内不再嵌套 fan-out；Agent 工具缺失时回退单遍。
 */
function canFanOutAgents(context: ToolUseContext): boolean {
  if (context.agentId) {
    return false
  }
  const tools = context.options.tools
  if (!tools) {
    return true
  }
  return tools.some((t) => toolMatchesName(t, AGENT_TOOL_NAME))
}

/**
 * /simplify 技能定义（内置插件 simplify@builtin 提供）。
 */
export const simplifySkill: BundledSkillDefinition = {
  name: 'simplify',
  description:
    'Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only \u2014 it does not hunt for bugs; use /code-review for that.',
  argumentHint: '[<target>]',
  userInvocable: true,
  async getPromptForCommand(args, context) {
    const target = args.trim()
    const targetPrefix = target ? `Review target: \`${target}\`\n\n` : ''
    const prompt = canFanOutAgents(context) ? FAN_OUT_PROMPT : SINGLE_PASS_PROMPT
    return [{ type: 'text', text: `${targetPrefix}${prompt}` }]
  },
}
