import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  DEFAULT_MAX_AGE_DAYS,
  isKairosCronEnabled,
} from '../../tools/ScheduleCronTool/prompt.js'
import { SCHEDULE_WAKEUP_TOOL_NAME } from '../../tools/ScheduleWakeupTool/prompt.js'
import { registerBundledSkill } from '../bundledSkills.js'

const USAGE_MESSAGE = `Usage: /loop [interval] <prompt>

Run a prompt or slash command on a recurring interval.

Intervals: Ns, Nm, Nh, Nd (e.g. 5m, 30m, 2h, 1d). Minimum granularity is 1 minute.
If no interval is specified, the loop self-paces each next wakeup.

Examples:
  /loop 5m /babysit-prs
  /loop 30m check the deploy
  /loop 1h /standup 1
  /loop check the deploy          (dynamic, self-paced)
  /loop check the deploy every 20m`

function hasExplicitInterval(args: string): boolean {
  return (
    /^\d+[smhd](?:\s|$)/i.test(args) ||
    /\bevery\s+\d+\s*(?:s|m|h|d|seconds?|minutes?|hours?|days?)\s*$/i.test(args)
  )
}

function buildFixedPrompt(args: string): string {
  return `# /loop — schedule a recurring prompt

Parse the input below into \`[interval] <prompt…>\` and schedule it with ${CRON_CREATE_TOOL_NAME}.

## Parsing (in priority order)

1. **Leading token**: if the first whitespace-delimited token matches \`^\\d+[smhd]$\` (e.g. \`5m\`, \`2h\`), that's the interval; the rest is the prompt.
2. **Trailing "every" clause**: otherwise, if the input ends with \`every <N><unit>\` or \`every <N> <unit-word>\` (e.g. \`every 20m\`, \`every 5 minutes\`, \`every 2 hours\`), extract that as the interval and strip it from the prompt. Only match when what follows "every" is a time expression — \`check every PR\` has no interval.
If the resulting prompt is empty, show usage \`/loop [interval] <prompt>\` and stop — do not call ${CRON_CREATE_TOOL_NAME}.

Examples:
- \`5m /babysit-prs\` → interval \`5m\`, prompt \`/babysit-prs\` (rule 1)
- \`check the deploy every 20m\` → interval \`20m\`, prompt \`check the deploy\` (rule 2)
- \`run tests every 5 minutes\` → interval \`5m\`, prompt \`run tests\` (rule 2)
- \`5m\` → empty prompt → show usage

## Interval → cron

Supported suffixes: \`s\` (seconds, rounded up to nearest minute, min 1), \`m\` (minutes), \`h\` (hours), \`d\` (days). Convert:

| Interval pattern      | Cron expression     | Notes                                    |
|-----------------------|---------------------|------------------------------------------|
| \`Nm\` where N ≤ 59   | \`*/N * * * *\`     | every N minutes                          |
| \`Nm\` where N ≥ 60   | \`0 */H * * *\`     | round to hours (H = N/60, must divide 24)|
| \`Nh\` where N ≤ 23   | \`0 */N * * *\`     | every N hours                            |
| \`Nd\`                | \`0 0 */N * *\`     | every N days at midnight local           |
| \`Ns\`                | treat as \`ceil(N/60)m\` | cron minimum granularity is 1 minute  |

**If the interval doesn't cleanly divide its unit** (e.g. \`7m\` → \`*/7 * * * *\` gives uneven gaps at :56→:00; \`90m\` → 1.5h which cron can't express), pick the nearest clean interval and tell the user what you rounded to before scheduling.

## Action

1. Call ${CRON_CREATE_TOOL_NAME} with:
   - \`cron\`: the expression from the table above
   - \`prompt\`: the parsed prompt from above, verbatim (slash commands are passed through unchanged)
   - \`recurring\`: \`true\`
2. Briefly confirm: what's scheduled, the cron expression, the human-readable cadence, that recurring tasks auto-expire after ${DEFAULT_MAX_AGE_DAYS} days, and that they can cancel sooner with ${CRON_DELETE_TOOL_NAME} (include the job ID).
3. **Then immediately execute the parsed prompt now** — don't wait for the first cron fire. If it's a slash command, invoke it via the Skill tool; otherwise act on it directly.

## Input

${args}`
}

function buildDynamicPrompt(args: string): string {
  return `# /loop — dynamic self-paced loop

The user invoked /loop without an interval. Work on the objective now, then decide when another observation would be useful.

At the end of every iteration:

1. If the objective is complete, permanently blocked, or the user asked to stop, call ${SCHEDULE_WAKEUP_TOOL_NAME} with \`stop: true\`.
2. Otherwise call ${SCHEDULE_WAKEUP_TOOL_NAME} with a delay from 60 to 3600 seconds, a concise reason, and this stable prompt:

<<autonomous-loop-dynamic>>
Continue this self-paced loop objective: ${args}
Inspect current state, make meaningful progress, and either stop when complete or call ${SCHEDULE_WAKEUP_TOOL_NAME} again for the next useful observation.

Do not use ${CRON_CREATE_TOOL_NAME} for this dynamic loop. Only one wakeup may be pending, and every ${SCHEDULE_WAKEUP_TOOL_NAME} call replaces it.

Begin the first iteration now.`
}

export function buildLoopPrompt(args: string): string {
  const trimmed = args.trim()
  if (!trimmed) {
    return USAGE_MESSAGE
  }
  return hasExplicitInterval(trimmed) ? buildFixedPrompt(trimmed) : buildDynamicPrompt(trimmed)
}

export function registerLoopSkill(): void {
  registerBundledSkill({
    name: 'loop',
    description: 'Run a prompt repeatedly on a fixed interval or a self-paced dynamic cadence.',
    whenToUse:
      'When the user wants to set up a recurring task, poll for status, or run something repeatedly on an interval (e.g. "check the deploy every 5 minutes", "keep running /babysit-prs"). Do NOT invoke for one-off tasks.',
    argumentHint: '[interval] <prompt>',
    userInvocable: true,
    isEnabled: isKairosCronEnabled,
    async getPromptForCommand(args) {
      return [{ type: 'text', text: buildLoopPrompt(args) }]
    },
  })
}
