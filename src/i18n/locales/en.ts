import type { TranslationResource } from './resourceTypes.js'

/**
 * English — base language (source of truth for keys)
 */
export const en: TranslationResource = {
  // Tips
  'tip.newUserWarmup':
    'Start with small features or bug fixes, tell Zy to propose a plan, and verify its suggested edits',
  'tip.planModeForComplexTasks':
    'Use Plan Mode to prepare for a complex request before making changes. Press {shortcut} twice to enable.',
  'tip.defaultPermissionModeConfig':
    'Use /config to change your default permission mode (including Plan Mode)',
  'tip.gitWorktrees':
    'Use git worktrees to run multiple Zy sessions in parallel.',
  'tip.colorWhenMultiSessions':
    'Running multiple ZY Code sessions? Use /color and /rename to tell them apart at a glance.',
  'tip.terminalSetupApple':
    'Run /terminal-setup to enable convenient terminal integration like Option + Enter for new line and more',
  'tip.terminalSetupOther':
    'Run /terminal-setup to enable convenient terminal integration like Shift + Enter for new line and more',
  'tip.shiftEnterApple':
    'Press Option+Enter to send a multi-line message',
  'tip.shiftEnterOther':
    'Press Shift+Enter to send a multi-line message',
  'tip.shiftEnterSetupApple':
    'Run /terminal-setup to enable Option+Enter for new lines',
  'tip.shiftEnterSetupOther':
    'Run /terminal-setup to enable Shift+Enter for new lines',
  'tip.memoryCommand':
    'Use /memory to view and manage ZY Code memory',
  'tip.themeCommand':
    'Use /theme to change the color theme',
  'tip.colortermTruecolor':
    'Try setting environment variable COLORTERM=truecolor for richer colors',
  'tip.powershellToolEnv':
    'Set ZY_CODE_USE_POWERSHELL_TOOL=1 to enable the PowerShell tool (preview)',
  'tip.statusLine':
    'Use /statusline to set up a custom status line that will display beneath the input box',
  'tip.promptQueue':
    'Hit Enter to queue up additional messages while ZY Code is working.',
  'tip.enterToSteer':
    'Send messages to ZY code while it works to steer ZY Code in real-time',
  'tip.todoList':
    'Ask ZY Code to create a todo list when working on complex tasks to track progress and remain on track',
  'tip.installGithubApp':
    'Run /install-github-app to tag @zy right from your Github issues and PRs',
  'tip.installSlackApp':
    'Run /install-slack-app to use ZY Code in Slack',
  'tip.permissions':
    'Use /permissions to pre-approve and pre-deny bash, edit, and MCP tools',
  'tip.dragAndDropImages':
    'Did you know you can drag and drop image files into your terminal?',
  'tip.pasteImagesMac':
    'Paste images into ZY Code using control+v (not cmd+v!)',
  'tip.doubleEsc':
    'Double-tap esc to rewind the conversation to a previous point in time',
  'tip.doubleEscCodeRestore':
    'Double-tap esc to rewind the code and/or conversation to a previous point in time',
  'tip.continue':
    'Run zy --continue or zy --resume to resume a conversation',
  'tip.renameConversation':
    'Name your conversations with /rename to find them easily in /resume later',
  'tip.customCommands':
    'Create skills by adding .md files to .zy/skills/ in your project or ~/.zy/skills/ for skills that work in any project',
  'tip.shiftTab':
    'Hit {shortcut} to cycle between modes',
  'tip.imagePaste':
    'Use {shortcut} to paste images from your clipboard',
  'tip.customAgents':
    'Use /agents to optimize specific tasks. Eg. Software Architect, Code Writer, Code Reviewer',
  'tip.agentFlag':
    'Use --agent <agent_name> to directly start a conversation with a subagent',
  'tip.desktopApp':
    'Run ZY Code locally or remotely using the Zy desktop app: clau.de/desktop',
  'tip.desktopShortcut':
    'Continue your session in ZY Code Desktop with {shortcut}',
  'tip.webApp':
    'Run tasks in the cloud while you keep coding locally · clau.de/web',
  'tip.mobileApp':
    '/mobile to use ZY Code from the Zy app on your phone',
  'tip.opusPlanModeReminder':
    'Your default model setting is Opus Plan Mode. Press {shortcut} twice to activate Plan Mode and plan with Zy Opus.',
  'tip.frontendDesignPlugin':
    'Working with HTML/CSS? Install the frontend-design plugin:\n{command}',
  'tip.vercelPlugin':
    'Working with Vercel? Install the vercel plugin:\n{command}',
  'tip.effortHighB':
    'Use {cmd} for better one-shot answers. Zy thinks it through first.',
  'tip.effortHighA':
    'Working on something tricky? {cmd} gives better first answers',
  'tip.subagentFanoutB':
    'For big tasks, tell ZY Code to {cmd}. They work in parallel and keep your main thread clean.',
  'tip.subagentFanoutA':
    'Say {cmd} and ZY Code sends a team. Each one digs deep so nothing gets missed.',
  'tip.loopCommandB':
    'Use {cmd} to run any prompt on a schedule. Set it and forget it.',
  'tip.loopCommandA':
    '{cmd} runs any prompt on a recurring schedule. Great for monitoring deploys, babysitting PRs, or polling status.',
  'tip.guestPasses':
    'Share ZY Code and earn {reward} of extra usage · {passes}',
  'tip.guestPassesNoReward':
    'You have free guest passes to share · {passes}',
  'tip.overageCredit':
    '{amount} · third-party apps · {shortcut}',
  'tip.feedbackCommand':
    'Use /feedback to help us improve!',
  'tip.clearContext':
    'Use /clear to start fresh when switching topics and free up context',
  'tip.btwSideQuestion':
    'Use /btw to ask a quick side question without interrupting current work',

  // Rate limit
  'rateLimit.hit': "You've hit your {limit}",
  'rateLimit.close': "You're close to",
  'rateLimit.outOfExtraUsage': "You're out of extra usage",
  'rateLimit.nowUsingExtraUsage': "You're now using extra usage",
  'rateLimit.usedPercent': "You've used {pct}% of your {limit}",
  'rateLimit.approaching': 'Approaching {limit}',
  'rateLimit.resetsAt': 'resets {time}',
  'rateLimit.sonnetLimit': 'Sonnet limit',
  'rateLimit.opusLimit': 'Opus limit',
  'rateLimit.weeklyLimit': 'weekly limit',
  'rateLimit.sessionLimit': 'session limit',
  'rateLimit.usageLimit': 'usage limit',
  'rateLimit.extraUsageSpendingLimit':
    "You're close to your extra usage spending limit",
  'rateLimit.feedbackReset':
    "If you have feedback about this limit, post in {channel}. You can reset your limits with /reset-limits",
  'rateLimit.hitWithReset': "You've hit your {limit} · {resetTime}",
  'rateLimit.usedPercentWithReset': "You've used {pct}% of your {limit} · {resetTime}",
  'rateLimit.approachingWithReset': 'Approaching {limit} · {resetTime}',
  'rateLimit.nowUsingExtraUsageWithReset': "You're now using extra usage · Your {limit} {resetTime}",

  // Rate limit upsell
  'rateLimit.upsell.extraUsage': '/extra-usage to finish what you\u2019re working on.',
  'rateLimit.upsell.login': '/login to switch to an API usage-billed account.',
  'rateLimit.upsell.openingOptions': 'Opening your options\u2026',
  'rateLimit.upsell.upgrade': '/upgrade to increase your usage limit.',
  'rateLimit.upsell.requestAdmin':
    '/extra-usage to request more usage from your admin.',
  'rateLimit.upsell.upgradeOrExtra':
    '/upgrade or /extra-usage to finish what you\u2019re working on.',

  // Spinner
  'spinner.idle': 'Idle',
  'spinner.teammatesRunning': 'teammates running',
  'spinner.workedFor': 'Worked for {duration}',
  'spinner.reconnecting': 'Reconnecting',
  'spinner.disconnected': 'Disconnected',
  'spinner.next': 'Next: {subject}',
  'spinner.tip': 'Tip: {tip}',
  'spinner.targetUsed': 'Target: {used} used ({budget} min {tick})',
  'spinner.targetPercent': 'Target: {used} / {budget} ({pct}%){eta}',
  'spinner.inBackground': '{count} in background',

  // Notifications
  'notif.authError': 'Authentication error · Try again',
  'notif.notLoggedIn': 'Not logged in · Run /login',
  'notif.debugMode': 'Debug mode',
  'notif.tokenCount': '{count} tokens',
  'notif.nowUsingExtraUsage': 'Now using extra usage',
  'notif.apiKeyHelperSlow': 'apiKeyHelper is taking a while',

  // Usage
  'usage.currentSession': 'Current session',
  'usage.currentWeekAll': 'Current week (all models)',
  'usage.currentWeekSonnet': 'Current week (Sonnet only)',
  'usage.extraUsage': 'Extra usage',
  'usage.extraUsageNotEnabled':
    'Extra usage not enabled · /extra-usage to enable',
  'usage.unlimited': 'Unlimited',
  'usage.loading': 'Loading usage data\u2026',
  'usage.loadError': 'Failed to load usage data',
  'usage.loadErrorDetail': 'Failed to load usage data: {detail}',
  'usage.percentUsed': '{pct}% used',
  'usage.resets': 'Resets {time}',
  'usage.spent': '{used} / {total} spent',
  'usage.subscriptionOnly':
    '/usage is only available for subscription plans.',
  'usage.error': 'Error: {error}',

  // Token warning
  'tokenWarning.untilAutoCompact': '{pct}% until auto-compact',
  'tokenWarning.contextUsed': '{pct}% context used',
  'tokenWarning.contextLow': 'Context low ({pct}% remaining)',
  'tokenWarning.runCompact': 'Run /compact to compact & continue',
  'tokenWarning.collapseErrors': 'collapse errors: {count}',
  'tokenWarning.collapseIdle': 'collapse idle ({count} empty runs)',
  'tokenWarning.summarized': '{collapsed} / {total} summarized',

  // Effort callout
  'effort.mediumRecommended': 'Medium (recommended)',
  'effort.high': 'High',
  'effort.low': 'Low',

  // Press Enter
  'pressEnterToContinue': 'Press Enter to continue\u2026',

  // Common
  'common.retry': 'retry',
  'common.cancel': 'cancel',
  'common.expand': 'expand',
  'common.collapse': 'collapse',
  'common.select': 'select',
  'common.confirm': 'confirm',
  'common.navigate': 'navigate',
  'common.toggle': 'toggle',
  'common.manage': 'manage',

  // Summary — search/read/list activities (collapsed tool output)
  // {count} is always provided; each language handles pluralization internally
  'summary.search.pattern_one': 'pattern',
  'summary.search.pattern_other': 'patterns',
  'summary.read.file_one': 'file',
  'summary.read.file_other': 'files',
  'summary.list.directory_one': 'directory',
  'summary.list.directory_other': 'directories',
  'summary.repl.time_one': 'time',
  'summary.repl.time_other': 'times',
  'summary.bash.command_one': 'command',
  'summary.bash.command_other': 'commands',
  'summary.memory_one': 'memory',
  'summary.memory_other': 'memories',

  // Summary — verb templates with {count} and {unit}
  // active/first: first item in a group, still in progress (e.g., "Searching for 2 patterns")
  // active/sub: not the first item, still in progress (e.g., "searching for 2 patterns")
  // done/first: first item, completed (e.g., "Searched for 2 patterns")
  // done/sub: not the first item, completed (e.g., "searched for 2 patterns")
  'summary.search.active.first': 'Searching for {count} {unit}',
  'summary.search.active.sub': 'searching for {count} {unit}',
  'summary.search.done.first': 'Searched for {count} {unit}',
  'summary.search.done.sub': 'searched for {count} {unit}',
  'summary.read.active.first': 'Reading {count} {unit}',
  'summary.read.active.sub': 'reading {count} {unit}',
  'summary.read.done.first': 'Read {count} {unit}',
  'summary.read.done.sub': 'read {count} {unit}',
  'summary.list.active.first': 'Listing {count} {unit}',
  'summary.list.active.sub': 'listing {count} {unit}',
  'summary.list.done.first': 'Listed {count} {unit}',
  'summary.list.done.sub': 'listed {count} {unit}',
  'summary.repl.active': "REPL'ing {count} {unit}",
  'summary.repl.done': "REPL'd {count} {unit}",
  'summary.mcp.active.first': 'Querying {server}',
  'summary.mcp.active.sub': 'querying {server}',
  'summary.mcp.done.first': 'Queried {server}',
  'summary.mcp.done.sub': 'queried {server}',
  'summary.bash.active.first': 'Running {count} bash {unit}',
  'summary.bash.active.sub': 'running {count} bash {unit}',
  'summary.bash.done.first': 'Ran {count} bash {unit}',
  'summary.bash.done.sub': 'ran {count} bash {unit}',
  'summary.memoryRead.active.first': 'Recalling {count} {unit}',
  'summary.memoryRead.active.sub': 'recalling {count} {unit}',
  'summary.memoryRead.done.first': 'Recalled {count} {unit}',
  'summary.memoryRead.done.sub': 'recalled {count} {unit}',
  'summary.memorySearch.active.first': 'Searching memories',
  'summary.memorySearch.active.sub': 'searching memories',
  'summary.memorySearch.done.first': 'Searched memories',
  'summary.memorySearch.done.sub': 'searched memories',
  'summary.memoryWrite.active.first': 'Writing {count} {unit}',
  'summary.memoryWrite.active.sub': 'writing {count} {unit}',
  'summary.memoryWrite.done.first': 'Wrote {count} {unit}',
  'summary.memoryWrite.done.sub': 'wrote {count} {unit}',

  // Shortcut hints
  'shortcut.hint': '{shortcut} to {action}',
  'shortcut.hintParens': '({shortcut} to {action})',
  'shortcut.toExpand': '{shortcut} to expand',
  'shortcut.toCollapse': '{shortcut} to collapse',

  // Task output tool
  'task.readOutput': 'Read output ({shortcut} to expand)',
  'task.stillRunning': 'Task is still running\u2026',
  'task.errorLabel': 'Error:',

  // Git operations (fullscreen)
  'summary.git.committed': 'committed',
  'summary.git.amended': 'amended commit',
  'summary.git.cherryPicked': 'cherry-picked',
  'summary.git.pushedTo': 'pushed to',
  'summary.git.merged': 'merged',
  'summary.git.rebasedOnto': 'rebased onto',
  'summary.git.prCreated': 'created',
  'summary.git.prEdited': 'edited',
  'summary.git.prMerged': 'merged',
  'summary.git.prCommented': 'commented on',
  'summary.git.prClosed': 'closed',
  'summary.git.prMarkedReady': 'marked ready',
  'summary.line_one': 'line',
  'summary.line_other': 'lines',
}
