import type { TranslationResource } from '../resourceTypes.js'

export const enCommands: TranslationResource = {
  'commands.addDir': 'Add a new working directory',
  'commands.advisor': 'Configure the advisor model',
  'commands.agents': 'Manage agent configurations',
  'commands.batch':
    'Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree agents that each open a PR.',
  'commands.batch.missingInstruction':
    'Provide an instruction describing the batch change you want to make.\n\nExamples:\n  /batch migrate from react to vue\n  /batch replace all uses of lodash with native equivalents\n  /batch add type annotations to all untyped function parameters',
  'commands.batch.notAGitRepo':
    'This is not a git repository. The `/batch` command requires a git repo because it spawns agents in isolated git worktrees and creates PRs from each. Initialize a repo first, or run this from inside an existing one.',
  'commands.batch.whenToUse':
    'Use when the user wants to make a sweeping, mechanical change across many files (migrations, refactors, bulk renames) that can be decomposed into independent parallel units.',
  'commands.bg': 'Send this session to the background and free the terminal',
  'commands.branch': 'Create a branch of the current conversation at this point',
  'commands.bridgeKick': 'Inject bridge failure states for debugging',
  'commands.btw': 'Ask a quick side question without interrupting the main conversation',
  'commands.chrome': 'Claude in Chrome (Beta) settings',
  'commands.claudeInChrome':
    'Automates your Chrome browser to interact with web pages — clicking, filling forms, screenshots, and more.',
  'commands.claudeInChrome.whenToUse':
    'When the user wants to interact with web pages, automate browser tasks, or perform browser-based actions.',
  'commands.clear': 'Clear conversation history and free up context',
  'commands.color': 'Set the prompt bar color for this session',
  'commands.commit': 'Create a git commit',
  'commands.commitPushPr': 'Commit, push, and open a PR',
  'commands.compact': 'Clear conversation history but keep a summary in context',
  'commands.config': 'Open config panel',
  'commands.context': 'Visualize current context usage as a colored grid',
  'commands.contextNonInteractive': 'Show current context usage',
  'commands.copy': "Copy Zy's last response to clipboard",
  'commands.cost': 'Show the total cost and duration of the current session',
  'commands.debug': 'Enable debug logging for this session and help diagnose issues.',
  'commands.desktop': 'Continue the current session in Zy Desktop',
  'commands.diff': 'View uncommitted changes and per-turn diffs',
  'commands.doctor': 'Diagnose and verify your ZY Code installation and settings',
  'commands.effort': 'Set effort level for model usage',
  'commands.exit': 'Exit the REPL',
  'commands.export': 'Export the current conversation to a file or clipboard',
  'commands.feedback': 'Submit feedback about ZY Code',
  'commands.files': 'List all files currently in context',
  'commands.goal': 'Set a goal — keep working until the condition is met',
  'commands.heapdump': 'Dump the JS heap to ~/Desktop',
  'commands.help': 'Show help and available commands',
  'commands.hooks': 'View hook configurations for tool events',
  'commands.ide': 'Manage IDE integrations and show status',
  'commands.init': 'Initialize a new AGENTS.md file with codebase documentation',
  'commands.initVerifiers': 'Create verifier skill(s) for automated verification of code changes',
  'commands.insights': 'Generate a report analyzing your ZY Code sessions',
  'commands.installGitHubApp': 'Set up ZY GitHub Actions for a repository',
  'commands.installSlackApp': 'Install the ZY Slack app',
  'commands.keybindings': 'Open or create your keybindings configuration file',
  'commands.keybindingsHelp':
    'Customize keyboard shortcuts, rebind keys, add chord bindings, or modify ~/.zy/keybindings.json.',
  'commands.login': 'Sign in with your account',
  'commands.logout': 'Sign out from your account',
  'commands.loop':
    'Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo, defaults to 10m).',
  'commands.loop.whenToUse':
    'When the user wants to set up a recurring task, poll for status, or run something repeatedly on an interval.',
  'commands.mcp': 'Manage MCP servers',
  'commands.memory': 'Edit ZY memory files',
  'commands.mobile': 'Show QR code to download the ZY mobile app',
  'commands.model': 'Set the AI model for ZY Code',
  'commands.outputStyle': 'Deprecated: use /config to change output style',
  'commands.permissions': 'Manage allow & deny tool permission rules',
  'commands.plan': 'Enable plan mode or view the current session plan',
  'commands.plugin': 'Manage ZY Code plugins',
  'commands.powerup': 'Interactive feature guide — learn tips & tricks',
  'commands.prComments': 'Get comments from a GitHub pull request',
  'commands.rateLimitOptions': 'Show options when rate limit is reached',
  'commands.releaseNotes': 'View release notes',
  'commands.reloadPlugins': 'Activate pending plugin changes in the current session',
  'commands.remoteEnv': 'Configure the default remote environment for teleport sessions',
  'commands.remoteSetup': 'Configure remote environment setup',
  'commands.rename': 'Rename the current conversation',
  'commands.resume': 'Resume a previous conversation',
  'commands.review': 'Review a pull request',
  'commands.rewind': 'Restore the code and/or conversation to a previous point',
  'commands.sandbox': 'Configure code execution sandbox',
  'commands.schedule':
    'Create, update, list, or run scheduled remote agents that execute on a cron schedule.',
  'commands.schedule.authRequired':
    'You need to authenticate with a zy.ai account first. API accounts are not supported. Run /login, then try /schedule again.',
  'commands.schedule.connectionError':
    "We're having trouble connecting with your remote zy.ai account to set up a scheduled task. Please try /schedule again in a few minutes.",
  'commands.schedule.noConnectors':
    'No connected MCP connectors found. The user may need to connect servers at https://zy.ai/settings/connectors',
  'commands.schedule.noEnvironments':
    'No remote environments found, and we could not create one automatically. Visit https://zy.ai/code to set one up, then run /schedule again.',
  'commands.schedule.whenToUse':
    'When the user wants to schedule a recurring remote agent, set up automated tasks, or manage scheduled agents.',
  'commands.securityReview':
    'Complete a security review of the pending changes on the current branch',
  'commands.session': 'Show remote session URL and QR code',
  'commands.simplify':
    'Review changed code for reuse, quality, and efficiency, then fix any issues found.',
  'commands.skills': 'List available skills',
  'commands.source.bundled': 'bundled',
  'commands.source.plugin': 'plugin',
  'commands.source.workflow': 'workflow',
  'commands.stats': 'Show your ZY Code usage statistics and activity',
  'commands.status':
    'Show ZY Code status including version, model, account, API connectivity, and tool statuses',
  'commands.statusline': 'Toggle the built-in status bar at the bottom of the screen',
  'commands.stickers': 'Order ZY Code stickers',
  'commands.tag': 'Toggle a searchable tag on the current session',
  'commands.tasks': 'List and manage background tasks',
  'commands.terminalSetup': 'Set up key bindings for newlines in your terminal',
  'commands.theme': 'Change the theme',
  'commands.thinkback': 'Your 2025 ZY Code Year in Review',
  'commands.thinkbackPlay': 'Play the thinkback animation',
  'commands.ultrareview': 'Finds and verifies bugs in your branch. Runs in ZY Code on the web.',
  'commands.updateConfig':
    'Configure the ZY Code harness via settings.json. Set up automated behaviors with hooks, manage permissions, env vars, plugins, and MCP servers.',
  'commands.upgrade': 'Upgrade to Max for higher rate limits and more Opus',
  'commands.usage': 'Show plan usage limits',
  'commands.version': 'Print the version this session is running',
  'commands.vim': 'Toggle between Vim and Normal editing modes',
  'commands.zyApi':
    'Build apps with the Zy API or Anthropic SDK. Trigger when code imports anthropic SDK or user asks about Zy API.',
}
