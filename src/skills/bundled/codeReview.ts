import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import type { BundledSkillDefinition } from '../bundledSkills.js'

/**
 * /code-review skill — 对 Pull Request 进行多 agent 代码评审。
 * 对齐 Claude Code 2.1.220 的 code-review 插件（code-review@claude-code-plugins）：
 * 资格预检 → AGENTS.md 收集 → 5 个并行标准模型 agent 独立审查 → 置信度打分过滤
 * （<80 丢弃）→ 重新资格检查 → gh 评论。适配点：CLAUDE.md → AGENTS.md、
 * Haiku/Sonnet → ZY 模型 tier（compact/standard）、评论署名 → ZY Code。
 */

// 快模型 / 标准模型 agent 表述（对应 CC 插件的 Haiku / Sonnet agent）
const FAST_AGENT = `compact-model ${AGENT_TOOL_NAME}`
const STANDARD_AGENT = `standard-model ${AGENT_TOOL_NAME}`

const CODE_REVIEW_PROMPT = `Provide a code review for the given pull request.

To do this, follow these steps precisely:

1. Use a ${FAST_AGENT} to check if the pull request (a) is closed, (b) is a draft, (c) does not need a code review (eg. because it is an automated pull request, or is very simple and obviously ok), or (d) already has a code review from you from earlier. If so, do not proceed.
2. Use another ${FAST_AGENT} to give you a list of file paths to (but not the contents of) any relevant AGENTS.md files from the codebase: the root AGENTS.md file (if one exists), as well as any AGENTS.md files in the directories whose files the pull request modified
3. Use a ${FAST_AGENT} to view the pull request, and ask the agent to return a summary of the change
4. Then, launch 5 parallel ${STANDARD_AGENT} agents to independently code review the change. The agents should do the following, then return a list of issues and the reason each issue was flagged (eg. AGENTS.md adherence, bug, historical git context, etc.):
   a. Agent #1: Audit the changes to make sure they compily with the AGENTS.md. Note that AGENTS.md is guidance for the assistant as it writes code, so not all instructions will be applicable during code review.
   b. Agent #2: Read the file changes in the pull request, then do a shallow scan for obvious bugs. Avoid reading extra context beyond the changes, focusing just on the changes themselves. Focus on large bugs, and avoid small issues and nitpicks. Ignore likely false positives.
   c. Agent #3: Read the git blame and history of the code modified, to identify any bugs in light of that historical context
   d. Agent #4: Read previous pull requests that touched these files, and check for any comments on those pull requests that may also apply to the current pull request.
   e. Agent #5: Read code comments in the modified files, and make sure the changes in the pull request comply with any guidance in the comments.
5. For each issue found in #4, launch a parallel ${FAST_AGENT} that takes the PR, issue description, and list of AGENTS.md files (from step 2), and returns a score to indicate the agent's level of confidence for whether the issue is real or false positive. To do that, the agent should score each issue on a scale from 0-100, indicating its level of confidence. For issues that were flagged due to AGENTS.md instructions, the agent should double check that the AGENTS.md actually calls out that issue specifically. The scale is (give this rubric to the agent verbatim):
   a. 0: Not confident at all. This is a false positive that doesn't stand up to light scrutiny, or is a pre-existing issue.
   b. 25: Somewhat confident. This might be a real issue, but may also be a false positive. The agent wasn't able to verify that it's a real issue. If the issue is stylistic, it is one that was not explicitly called out in the relevant AGENTS.md.
   c. 50: Moderately confident. The agent was able to verify this is a real issue, but it might be a nitpick or not happen very often in practice. Relative to the rest of the PR, it's not very important.
   d. 75: Highly confident. The agent double checked the issue, and verified that it is very likely it is a real issue that will be hit in practice. The existing approach in the PR is insufficient. The issue is very important and will directly impact the code's functionality, or it is an issue that is directly mentioned in the relevant AGENTS.md.
   e. 100: Absolutely certain. The agent double checked the issue, and confirmed that it is definitely a real issue, that will happen frequently in practice. The evidence directly confirms this.
6. Filter out any issues with a score less than 80. If there are no issues that meet this criteria, do not proceed.
7. Use a ${FAST_AGENT} to repeat the eligibility check from #1, to make sure that the pull request is still eligible for code review.
8. Finally, use the gh bash command to comment back on the pull request with the result. When writing your comment, keep in mind to:
   a. Keep your output brief
   b. Avoid emojis
   c. Link and cite relevant code, files, and URLs

Examples of false positives, for steps 4 and 5:

- Pre-existing issues
- Something that looks like a bug but is not actually a bug
- Pedantic nitpicks that a senior engineer wouldn't call out
- Issues that a linter, typechecker, or compiler would catch (eg. missing or incorrect imports, type errors, broken tests, formatting issues, pedantic style issues like newlines). No need to run these build steps yourself -- it is safe to assume that they will be run separately as part of CI.
- General code quality issues (eg. lack of test coverage, general security issues, poor documentation), unless explicitly required in AGENTS.md
- Issues that are called out in AGENTS.md, but explicitly silenced in the code (eg. due to a lint ignore comment)
- Changes in functionality that are likely intentional or are directly related to the broader change
- Real issues, but on lines that the user did not modify in their pull request

Notes:

- Do not check build signal or attempt to build or typecheck the app. These will run separately, and are not relevant to your code review.
- Use \`gh\` to interact with Github (eg. to fetch a pull request, or to create inline comments), rather than web fetch
- Make a todo list first
- You must cite and link each bug (eg. if referring to a AGENTS.md, you must link it)
- For your final comment, follow the following format precisely (assuming for this example that you found 3 issues):

---

### Code review

Found 3 issues:

1. <brief description of bug> (AGENTS.md says "<...>")

<link to file and line with full sha1 + line range for context, note that you MUST provide the full sha and not use bash here, eg. https://github.com/anthropics/claude-code/blob/1d54823877c4de72b2316a64032a54afc404e619/README.md#L13-L17>

2. <brief description of bug> (some/other/AGENTS.md says "<...>")

<link to file and line with full sha1 + line range for context>

3. <brief description of bug> (bug due to <file and code snippet>)

<link to file and line with full sha1 + line range for context>

🤖 Generated with [ZY Code](https://zy.com/zy-code)

<sub>- If this code review was useful, please react with 👍. Otherwise, react with 👎.</sub>

---

- Or, if you found no issues:

---

### Code review

No issues found. Checked for bugs and AGENTS.md compliance.

🤖 Generated with [ZY Code](https://zy.com/zy-code)

- When linking to code, follow the following format precisely, otherwise the Markdown preview won't render correctly: https://github.com/anthropics/claude-cli-internal/blob/c21d3c10bc8e898b7ac1a2d745bdc9bc4e423afe/package.json#L10-L15
  - Requires full git sha
  - You must provide the full sha. Commands like \`https://github.com/owner/repo/blob/\$(git rev-parse HEAD)/foo/bar\` will not work, since your comment will be directly rendered in Markdown.
  - Repo name must match the repo you're code reviewing
  - # sign after the file name
  - Line range format is L[start]-L[end]
  - Provide at least 1 line of context before and after, centered on the line you are commenting about (eg. if you are commenting about lines 5-6, you should link to \`L4-7\`)`

/**
 * /code-review ultra 引导（对应 CC 系统提示中对 /code-review ultra 的说明）。
 * ZY 命令路由不支持同名双实现，/code-review ultra 命中本 skill 时输出引导，
 * 由用户通过 /ultrareview 触发带计费确认的云审。
 */
const ULTRA_REVIEW_GUIDANCE = `If the user asks about "ultrareview" or how to run it, explain that /code-review ultra launches a multi-agent cloud review of the current branch (or /code-review ultra <PR#> for a GitHub PR); /ultrareview is a deprecated alias for the same command. It is user-triggered and billed; you cannot launch it yourself, so do not attempt to via Bash or otherwise. It needs a git repository (offer to "git init" if not in one); the no-arg form bundles the local branch and does not need a GitHub remote.`

/**
 * /code-review 技能定义（内置插件 code-review@builtin 提供）。
 */
export const codeReviewSkill: BundledSkillDefinition = {
  name: 'code-review',
  description: 'Code review a pull request',
  whenToUse:
    'When the user wants to review a pull request with automated multi-agent review, confidence scoring, or inline PR comments; or says things like "code review this PR", "review PR 123", "check this PR".',
  allowedTools: ['Bash', 'Read', 'Glob', 'Grep', 'LS'],
  userInvocable: true,
  async getPromptForCommand(args) {
    if (args.trim().startsWith('ultra')) {
      return [{ type: 'text', text: ULTRA_REVIEW_GUIDANCE }]
    }
    return [{ type: 'text', text: `${CODE_REVIEW_PROMPT}\n\nInvocation arguments: ${args.trim()}` }]
  },
}
