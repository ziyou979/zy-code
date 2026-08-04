import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { REPORT_FINDINGS_TOOL_NAME } from '../../tools/ReportFindingsTool/prompt.js'
import { registerBundledSkill } from '../bundledSkills.js'

const CODE_REVIEW_PROMPT = `# Code Review

Review the requested target for concrete correctness bugs and worthwhile reuse, simplification, or efficiency improvements.

## Arguments

The invocation syntax is /code-review [low|medium|high|xhigh|max] [--fix] [--comment] [<target>].

- The default level is medium.
- target may be a GitHub PR number/URL, a base branch, or omitted for the current working-tree/branch diff.
- Reject unknown level names instead of silently treating them as a target.
- --comment only posts findings when the target is a GitHub PR.

## Review depth

- low: one focused pass; report only obvious, high-confidence defects.
- medium: inspect the diff and directly affected call sites; keep the finding set small.
- high: use ${AGENT_TOOL_NAME} to run independent correctness, removed-behavior, and cross-file checks in parallel.
- xhigh and max: do the high-level passes, trace callers and callees, inspect tests and invariants, and independently verify every candidate. Broader investigation is allowed, but findings must still be concrete.

## Procedure

1. Establish the target and obtain its complete diff. For a PR, use gh pr view and gh pr diff. Otherwise inspect git status, staged and unstaged changes, and the branch diff against the merge base.
2. Read the changed code in repository context. Do not review the diff as isolated text.
3. Find candidates from these distinct angles:
   - correctness: inverted conditions, off-by-one errors, null/undefined paths, missing awaits, falsy-zero checks, wrong variables, swallowed errors, and unsafe escaping;
   - removed behavior: identify the invariant enforced by every removed/replaced guard and confirm where it is re-established;
   - cross-file behavior: trace changed functions into callers and callees for new preconditions, return shapes, exceptions, and ordering dependencies;
   - reuse and efficiency: report duplication or unnecessary work only when the repository already provides a clearly better implementation or the cost is material.
4. Verify each candidate against the actual code. Drop speculative, pre-existing, style-only, or untestable findings. Each surviving finding needs a repository-relative file, a precise line when possible, a concrete failure scenario, and a CONFIRMED or PLAUSIBLE verdict.
5. Call ${REPORT_FINDINGS_TOOL_NAME} exactly once with the verified findings, most severe first. Pass an empty array when none survive. Do not duplicate the finding list as prose.

## Applying fixes (--fix)

After reporting the original findings, fix each verified issue directly. Skip a finding when it is intended behavior, outside the reviewed diff, or disproven while editing. Run focused verification. Then call ${REPORT_FINDINGS_TOOL_NAME} once more with the same findings and each item's actual outcome: fixed, skipped, or no_change_needed.

## Posting to GitHub (--comment)

After reporting findings, post each finding as an inline PR comment when the target is a GitHub PR. Prefer the GitHub inline-comment tool when available; otherwise use gh api repos/{owner}/{repo}/pulls/{pr}/comments. Include a suggestion block only when it is a complete fix. For non-PR targets, state that --comment was ignored.`

export function registerCodeReviewSkill(): void {
  registerBundledSkill({
    name: 'code-review',
    description: 'Review code changes with configurable depth and structured findings.',
    argumentHint: '[low|medium|high|xhigh|max] [--fix] [--comment] [target]',
    whenToUse:
      'When the user wants to review a working diff, branch, or pull request with configurable depth, structured findings, optional fixes, or inline PR comments.',
    userInvocable: true,
    async getPromptForCommand(args) {
      return [
        { type: 'text', text: `${CODE_REVIEW_PROMPT}\n\nInvocation arguments: ${args.trim()}` },
      ]
    },
  })
}
