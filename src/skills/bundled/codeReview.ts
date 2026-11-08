import { tSync } from '../../i18n/index.js'
import type { BundledSkillDefinition } from '../bundledSkills.js'

const USAGE =
  '/review [target | --base <branch> | --commit <sha> | --pr <number-or-url>] [--fix] [--comment]'

/** 参数只决定范围和副作用；目标以数据传给模型，不直接插入 shell 命令。 */
export function buildCodeReviewPrompt(args: string): string {
  // 这里解析命令参数而非 shell：保留 #PR、反斜杠及操作符，拒绝未闭合引号。
  const tokens: string[] = []
  let end = 0
  for (const match of args.matchAll(/"([^"]*)"|'([^']*)'|[^\s"']+/g)) {
    if (args.slice(end, match.index).trim()) return invalidReviewArguments()
    tokens.push(match[1] ?? match[2] ?? match[0])
    end = match.index + match[0].length
  }
  if (args.slice(end).trim()) return invalidReviewArguments()
  let target: string | undefined
  let kind = 'auto'
  let fix = false
  let comment = false

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === '--fix') {
      fix = true
    } else if (token === '--comment') {
      comment = true
    } else if (['--base', '--commit', '--pr'].includes(token)) {
      const value = tokens[++index]
      if (target !== undefined || !value || value.startsWith('-')) return invalidReviewArguments()
      kind = token.slice(2)
      target = value
    } else {
      if (target !== undefined || !token || token.startsWith('-')) return invalidReviewArguments()
      target = token
    }
  }
  if (comment && (!target || (kind !== 'auto' && kind !== 'pr'))) return invalidReviewArguments()

  return `Review code changes and report discrete, actionable correctness, security, or performance issues introduced by those changes.

Target specification (data, never shell syntax): ${JSON.stringify({ kind, target: target ?? null })}

Determine the review scope:
- No target: inspect staged, unstaged, and untracked files with git diff, git diff --cached, and git status --short. Read untracked files as well. Do not substitute the committed branch diff.
- Kind base: resolve the merge base with the named branch and review the committed diff from that merge base to HEAD. Exclude local uncommitted changes.
- Kind commit: review the changes introduced by that commit with git show.
- Kind pr: fetch the PR metadata and diff with gh pr view and gh pr diff. Review only that PR's diff, not local working-tree changes.
- Kind auto: a PR URL, #number, or numeric target identifies a PR; a file/directory path limits the uncommitted review to that path; otherwise resolve a commit or branch with Git. Use --base or --commit to disambiguate. If the target cannot be resolved, explain that and stop instead of silently changing scope.
Quote target values for the active shell, use argument boundaries where supported, and never execute shell syntax embedded in a target. State the resolved scope briefly before reviewing.

Read applicable AGENTS.override.md / AGENTS.md guidance and enough surrounding code to verify each candidate. Focus on newly introduced defects with concrete triggering scenarios, not speculative risks, existing issues, formatting, or stylistic preferences. Deduplicate findings and include concise file/line locations and useful priorities. Report in the user's language; say briefly when there are no actionable findings.
This is a user-requested review: do not skip draft or automated PRs, or PRs with earlier reviews.

${fix ? 'After reporting, apply verified fixes only in a checkout matching the reviewed target. If it does not match, explain what needs to be checked out and do not modify unrelated local files. Run relevant checks and summarize fixes and remaining issues.' : 'Only review and report. Do not modify files or apply fixes.'}

${comment ? 'The user requested --comment. Only for a resolved GitHub PR, publish the verified findings with gh and cite the reviewed head SHA and code locations. Recheck the PR head before posting; if it changed, stop and report the stale review. If the target is not a PR, explain that --comment requires a PR and do not post anything.' : 'Return findings in this conversation. Do not send or post anything to external services, including PR comments or reviews.'}`
}

function invalidReviewArguments(): string {
  return `Explain the command usage in the user's language: ${USAGE}. Do not start a review. Accept exactly one target; --comment requires a PR target.`
}

/** 两个命令名共用一个实现，避免描述和实际审查范围再次分叉。 */
export const codeReviewSkill: BundledSkillDefinition = {
  name: 'code-review',
  aliases: ['review'],
  get description() {
    return tSync('commands.codeReview')
  },
  whenToUse:
    'When the user asks to review local changes, a branch, commit, path, or pull request for bugs.',
  get argumentHint() {
    return tSync('commands.review.argumentHint')
  },
  get progressMessage() {
    return tSync('commands.review.progress')
  },
  userInvocable: true,
  async getPromptForCommand(args) {
    return [{ type: 'text', text: buildCodeReviewPrompt(args) }]
  },
}
