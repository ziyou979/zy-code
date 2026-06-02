const ULTRA_EFFORT_ENTER_FULL = `Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the Workflow tool on every substantive task; token cost is not a constraint. See the Workflow tool's **Ultracode** section and quality patterns. Solo only on conversational/trivial turns.`

const ULTRA_EFFORT_ENTER_LIGHT = `Ultracode is still on — use the Workflow tool; see its Ultracode section.`

const ULTRA_EFFORT_EXIT = `Ultracode is off — the Workflow tool's standard opt-in rule applies again.`

const WORKFLOW_KEYWORD_REQUEST = `The user included the keyword "workflow" or "workflows", which means you should use the Workflow tool to fulfill their request.`

export function getUltracodeEnterReminderText(type: 'full' | 'light'): string {
  return type === 'full' ? ULTRA_EFFORT_ENTER_FULL : ULTRA_EFFORT_ENTER_LIGHT
}

export function getUltracodeExitReminderText(): string {
  return ULTRA_EFFORT_EXIT
}

export function getWorkflowKeywordReminderText(): string {
  return WORKFLOW_KEYWORD_REQUEST
}
