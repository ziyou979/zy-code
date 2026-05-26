import type { TranslationResource } from '../resourceTypes.js'

export const enPowerupLessons: TranslationResource = {
  'powerup.lesson.atMentions.body': `Type \`@\` in the prompt to fuzzy-match a file path and pull it in as context.

**Usage:**
- \`@src/utils/config\` — reference the whole file
- \`@config:42\` — reference line 42 of the config file
- \`@*.test.ts\` — reference all test files

**Pro tips:**
- Drag-and-drop a file onto the terminal also references it
- Combine multiple \`@\` in one message`,
  'powerup.lesson.atMentions.tagline': '@ files, line refs',
  'powerup.lesson.atMentions.title': 'Talk to your codebase',

  'powerup.lesson.automate.body': `Automate repetitive work with custom skills and hooks.

**Skills (custom commands):**
- Drop a markdown file under \`.zy/skills/\` to define a new command
- Can bundle prompt templates and tool calls

**Hooks (lifecycle triggers):**
- Defined in settings; run automatically before/after a tool
- Common uses: auto-format, auto-test, notifications`,
  'powerup.lesson.automate.tagline': 'skills, hooks',
  'powerup.lesson.automate.title': 'Automate your workflow',

  'powerup.lesson.background.body': `Send long-running tasks to the background and keep working on other things.

**Usage:**
- Append \`&\` to a message — runs in the background immediately
- \`/tasks\` — see all background task status
- \`Ctrl+B\` — push the current conversation to the background

**Pro tips:**
- A notification fires when a background task completes
- Combine with \`--worktree\` to run unrelated tasks in parallel`,
  'powerup.lesson.background.tagline': 'tasks, /tasks',
  'powerup.lesson.background.title': 'Run in the background',

  'powerup.lesson.crossDevice.body': `Take over the current session from your phone or another device.

**Usage:**
- \`/remote-control\` — generate a remote-control link
- \`/teleport\` — transfer the current session state to another device

**Scenarios:**
- Monitor background tasks from your phone on the way home
- Review code from a tablet in a meeting
- Seamless switching across multiple computers`,
  'powerup.lesson.crossDevice.tagline': '/remote-control, /teleport',
  'powerup.lesson.crossDevice.title': 'Code from anywhere',

  'powerup.lesson.mcp.body': `Connect external tools and data sources via MCP (Model Context Protocol).

**Usage:**
- \`/mcp\` — manage connected MCP servers
- \`.mcp.json\` at the project root — declare the MCP servers the project needs

**Common scenarios:**
- Database query tools
- Jira / Linear and other project trackers
- Browser-automation tools for web app testing`,
  'powerup.lesson.mcp.tagline': 'MCP, /mcp',
  'powerup.lesson.mcp.title': 'Extend with tools',

  'powerup.lesson.memory.body': `Teach zy-code your coding style and project conventions with AGENTS.md.

**Three memory levels:**
- \`~/.zy/AGENTS.md\` — global rules (apply to every project)
- \`./AGENTS.md\` — project-root rules
- \`./src/AGENTS.md\` — subdirectory rules (apply when working under that directory)

**Pro tips:**
- \`/memory\` quick-writes a new rule
- Rules support glob patterns to scope to specific files`,
  'powerup.lesson.memory.tagline': 'AGENTS.md, /memory',
  'powerup.lesson.memory.title': 'Teach your rules',

  'powerup.lesson.modelDial.body': `Switch models and reasoning depth on demand to balance speed and quality.

**Usage:**
- \`/model\` — switch to a different model
- \`/effort\` — adjust reasoning depth (low/medium/high)

**Suggestions:**
- Simple questions: compact model + low effort to save cost
- Complex architecture: advanced model + high effort
- Default standard + medium fits everyday coding`,
  'powerup.lesson.modelDial.tagline': '/model, /effort',
  'powerup.lesson.modelDial.title': 'Dial the model',

  'powerup.lesson.modes.body': `Press \`Shift+Tab\` to cycle permission modes and control how autonomously zy-code acts.

**Four modes:**
- **Ask** — confirm every step (safest)
- **Auto-edit** — auto-edit files, confirm shell commands
- **Full-auto** — fully autonomous
- **Plan** — analysis and planning only, no modifications

**Pro tips:**
- Append \`!\` to a message to temporarily switch to full-auto
- \`/plan\` enters plan mode directly`,
  'powerup.lesson.modes.tagline': 'shift+tab, plan, auto',
  'powerup.lesson.modes.title': 'Steer with modes',

  'powerup.lesson.subagents.body': `Spawn parallel subagents to handle multiple subtasks at once.

**Usage:**
- zy-code decides automatically when to split into subagents
- You can also say "process these files in parallel"

**Pro tips:**
- The \`--worktree\` flag isolates each subagent in its own git worktree
- \`/agents\` lists currently active agents
- Great for bulk refactors and multi-file generation`,
  'powerup.lesson.subagents.tagline': 'subagents, /agents',
  'powerup.lesson.subagents.title': 'Multiply yourself',

  'powerup.lesson.undo.body': `Roll back any change zy-code made — don't fear mistakes.

**Usage:**
- \`Esc-Esc\` — interrupt the current action and undo the last step
- \`/rewind\` — jump back to any history point
- \`/clear\` — wipe context and start over

**Pro tips:**
- File edits create checkpoints; rewind precisely to any step
- \`/branch\` forks a new conversation from a history point`,
  'powerup.lesson.undo.tagline': '/rewind, Esc-Esc',
  'powerup.lesson.undo.title': 'Undo anything',
}
