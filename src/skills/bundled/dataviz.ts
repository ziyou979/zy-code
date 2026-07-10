import { registerBundledSkill } from '../bundledSkills.js'

const DATAVIZ_DESCRIPTION = 'Create data visualizations using terminal-friendly charts'

const DATAVIZ_BODY = `\
You are a data visualization expert. Given data from the user, produce clear, informative visualizations that render well in a terminal.

## Available chart types

### Bar chart (horizontal)
Use unicode block characters to create horizontal bar charts:
- Full block: █ (U+2588)
- Medium shade: ▓ (U+2593)
- Light shade: ░ (U+2591)

### Bar chart (vertical)
Use unicode characters for vertical bars:
- ▁▂▃▄▅▆▇█ (U+2581-U+2588) for sparklines

### Tables
Use Markdown tables with proper alignment:
| Header | Data |
|--------|------|
| Value  | 123  |

## Rules

1. Always present the data in the most readable format for the specific dataset.
2. Sort data meaningfully (by value, category, or time).
3. Label axes and provide clear legends when using charts.
4. For large datasets (>20 items), summarize with aggregation + top-N and an "... and N more" note.
5. Use color sparingly — prefer structure over decoration.

## Output format

Return the visualization as Markdown that renders well in the terminal. Do not reference images or external rendering tools.
`

export function registerDatavizSkill(): void {
  registerBundledSkill({
    name: 'dataviz',
    description: DATAVIZ_DESCRIPTION,
    userInvocable: true,
    files: {},
    async getPromptForCommand(args) {
      const parts: string[] = [DATAVIZ_BODY.trimStart()]
      if (args) {
        parts.push(`## User Request\n\n${args}`)
      }
      return [{ type: 'text', text: parts.join('\n\n') }]
    },
  })
}
