import { tSync } from '../../i18n/index.js'
import type { BundledSkillDefinition } from '../bundledSkills.js'

/**
 * /review skill — 对 Pull Request 进行代码评审。
 * 对齐 Claude Code 2.1.220 的内建 /review：无参时引导用户从 gh pr list 选择，
 * 有参时按 PR 双模板审查，首个参数之外的文本作为附加指令透传。
 */

/** 无参模板：引导列出 PR 供用户选择（CC nR_）。 */
const NO_ARGS_PROMPT = `Run \`gh pr list\` to show the open pull requests, then ask the user which one to review (\`/review <number>\`).`

/**
 * 有参模板：以 PR 为目标收集 diff 并审查（CC oR_）。
 * @param pr PR 编号（已去除反引号与 # 前缀）
 * @param extraInstructions 首个参数之外的附加指令，可为空
 */
function buildPrReviewPrompt(pr: string, extraInstructions: string): string {
  return `Review target: GitHub pull request \`${pr}\`.
Gather this target's diff with (instead of any local \`git diff\`):
1. \`gh pr view ${pr} --json title,body,author,baseRefName,headRefName,state,additions,deletions,changedFiles,labels\` for context
2. \`gh pr diff ${pr}\` for the unified diff
The PR's diff is the only review scope \u2014 local working-tree changes are out of scope. When you need surrounding code, Read the files in this checkout if it matches the PR's branch, otherwise fetch file contents via \`gh\`.
${extraInstructions ? `\nAdditional instructions from the user: ${extraInstructions}\n` : ''}
Analyze the changes and provide a thorough code review that includes:
- An overview of what the PR does
- Analysis of code quality and style
- Specific suggestions for improvements
- Any potential issues or risks
Keep your review concise but thorough. Focus on:
- Code correctness
- Following project conventions
- Performance implications
- Test coverage
- Security considerations
Format your review with clear sections and bullet points.`
}

/**
 * /review 技能定义（内置插件 review@builtin 提供）。
 * MCP 服务（mcp.ts）通过 getBuiltinPluginSkillCommands() 获取对应命令。
 */
export const reviewSkill: BundledSkillDefinition = {
  name: 'review',
  description: tSync('commands.review'),
  whenToUse:
    'When the user wants to review a pull request, asks for a code review, or says things like "review PR 123", "check this PR", "code review".',
  argumentHint: '[pr number]',
  progressMessage: 'reviewing pull request',
  userInvocable: true,
  async getPromptForCommand(args) {
    const [target = '', ...rest] = args.trim().split(/\s+/)
    const pr = target.replaceAll('`', '').replace(/^#/, '')
    const text = pr ? buildPrReviewPrompt(pr, rest.join(' ')) : NO_ARGS_PROMPT
    return [{ type: 'text', text }]
  },
}
