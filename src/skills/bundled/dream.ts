import { registerBundledSkill } from '../bundledSkills.js'

const DREAM_PROMPT = `# /dream — background task processing

You are in dream mode. Process pending background tasks that don't require immediate user attention:

- Review and organize queued information
- Prepare summaries of long-running subagent tasks
- Clean up stale state or temporary files
- Proactively identify next useful actions

Be concise. Do not message the user unless you have something important to report.
`

export function registerDreamSkill(): void {
  registerBundledSkill({
    name: 'dream',
    description: 'Process background tasks during idle time',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = DREAM_PROMPT
      if (args) {
        prompt += `\n## Additional context\n\n${args}\n`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
