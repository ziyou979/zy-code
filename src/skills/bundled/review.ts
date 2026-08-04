import { tSync } from '../../i18n/index.js'
import type { Command } from '../../commands/types.js'
import { getBundledSkills, registerBundledSkill } from '../bundledSkills.js'

/**
 * /review skill — 对 Pull Request 进行代码评审。
 * 支持指定 PR 编号，或不带参数时列出待选 PR。
 */

function buildPrompt(args: string): string {
  return `Review a GitHub pull request. This command is deliberately PR-focused; for the current working diff use /code-review.

1. If no PR number or URL is provided, run \`gh pr list\` and ask the user to choose one. Do not guess.
2. Run \`gh pr view <target> --json title,body,author,baseRefName,headRefName,state,additions,deletions,changedFiles,labels\`.
3. Run \`gh pr diff <target>\` and read relevant files for repository context.
4. Analyze the changes and provide a thorough code review that includes:
   - Overview of what the PR does
   - Analysis of code quality and style
   - Specific suggestions for improvements
   - Any potential issues or risks
Keep your review concise but thorough. Focus on:
- Code correctness
- Following project conventions
- Performance implications
- Test coverage
- Security considerations
Format your review with clear sections and bullet points.
PR target: ${args}`
}

// 导出 review 命令供 MCP 服务使用（mcp.ts 需要将其暴露为 MCP 工具）
export let reviewCommand: Command | undefined

export function registerReviewSkill(): void {
  registerBundledSkill({
    name: 'review',
    description: tSync('commands.review'),
    whenToUse:
      'When the user wants to review a pull request, asks for a code review, or says things like "review PR 123", "check this PR", "code review".',
    argumentHint: '[PR number or URL]',
    userInvocable: true,
    async getPromptForCommand(args) {
      return [{ type: 'text', text: buildPrompt(args.trim()) }]
    },
  })
  // 从注册表中获取已创建的命令对象，供外部引用
  reviewCommand = getBundledSkills().find((c) => c.name === 'review')
}
