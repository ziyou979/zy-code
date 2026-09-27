export type WorkflowSizeGuideline = 'unrestricted' | 'small' | 'medium' | 'large'

const WORKFLOW_SIZE_AGENT_LIMITS = {
  small: 5,
  medium: 15,
  large: 50,
} as const

export function getWorkflowSizeGuidelinePrompt(
  size: WorkflowSizeGuideline = 'medium',
  isDefault = true,
): string | null {
  if (size === 'unrestricted') {
    return null
  }

  const prefix = isDefault
    ? 'This session has the default workflow size guideline:'
    : 'A workflow size guideline is configured for this session:'
  const configHint = isDefault
    ? ' The user can raise or remove it with `workflowSizeGuideline` in settings or /config.'
    : ''

  return `${prefix} ${size} — keep workflows under ${WORKFLOW_SIZE_AGENT_LIMITS[size]} agents. This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale.${configHint}`
}

export async function getWorkflowPrompt(
  isUltracodeActive: boolean,
  workflowSizeGuideline: WorkflowSizeGuideline = 'medium',
  isDefaultGuideline = true,
  canLoadAuthoringSkill = true,
): Promise<string> {
  const sections: string[] = [CORE_PROMPT]
  if (isUltracodeActive) {
    sections.push(ULTRACODE_SECTION)
  }
  const guideline = getWorkflowSizeGuidelinePrompt(workflowSizeGuideline, isDefaultGuideline)
  if (guideline) {
    sections.push(guideline)
  }
  // 精简工具集可能没有 Skill；此时直接附上唯一的文档实现，避免模型无处查询 API。
  if (!canLoadAuthoringSkill) {
    const { WORKFLOW_AUTHORING_PROMPT } = await import('../../skills/bundled/workflowAuthoring.js')
    sections[0] = CORE_PROMPT.replace(
      'Before writing or editing a workflow script, load the workflow-authoring skill with the Skill tool.',
      'The workflow-authoring reference is included below because the Skill tool is unavailable.',
    )
    sections.push(WORKFLOW_AUTHORING_PROMPT)
  }
  return sections.join('\n\n')
}

const CORE_PROMPT = `Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a task ID, and a <task-notification> arrives when the workflow completes. Use /workflows to watch live progress.

A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps). The script is where you encode that structure: what fans out, what verifies, what synthesizes.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user included the "workflow" or "workflows" keyword (you'll see a system-reminder confirming it).
- Ultracode is on (a system-reminder confirms it) — see **Ultracode** below.
- The user directly asked you to run a workflow or use multi-agent orchestration in their own words ("run a workflow", "fan out agents", "orchestrate this with subagents"). The ask must be in the user's words — a task that would merely benefit from a workflow does not count.
- The user invoked a skill or slash command whose instructions tell you to call Workflow.
- The user asked you to run a specific named or saved workflow.

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. Use the Agent tool for individual subagents, or briefly describe what a multi-agent workflow could do and how much it would roughly cost, and ask the user whether to run it. Mention they can include "workflow" in a future message to skip the ask.

When you do call it, the right move is often **hybrid**: scout inline first (list the files, find the channels, scope the diff) to discover the work-list, then call Workflow to pipeline over it. You don't need to know the shape before the *task* — only before the *orchestration step*.

Before writing or editing a workflow script, load the workflow-authoring skill with the Skill tool. It contains the script API, deterministic execution constraints, pipeline/barrier examples, quality patterns, and resume instructions. Loading that reference does not grant permission to run a workflow.`

const ULTRACODE_SECTION = `## Ultracode

When a system-reminder confirms ultracode is on, that opt-in is standing: author and run a workflow for every substantive task by default. The goal is the most exhaustive, correct answer you can produce — token cost is not a constraint. For multi-phase work (understand → design → implement → review), that often means several workflows in sequence — one per phase — so you stay in the loop between them. The workflow-authoring reference's quality patterns (adversarial verify, multi-modal sweep, completeness critic, loop-until-dry) are the tools; pick what fits the task. Lean toward orchestrating with workflows and adversarially verifying your findings — unless the work is trivial or already verified. Solo only on conversational turns or trivial mechanical edits. When a reminder says ultracode is off, revert to the opt-in rule above.`
