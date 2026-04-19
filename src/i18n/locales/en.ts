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
    'Hit {shortcut} to cycle between modes (default, auto-accept edit, and plan mode)',
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
    '{amount} · {command}',
  'tip.feedbackCommand':
    'Use /feedback to help us improve!',
  'tip.clearContext':
    'Use /clear to start fresh when switching topics and free up context',
  'tip.btwSideQuestion':
    'Use /btw to ask a quick side question without interrupting current work',
  'tip.vscodeCommandInstall':
    `Open the Command Palette (Cmd+Shift+P) and run "Shell Command: Install '{command}' command in PATH" to enable IDE integration`,
  'tip.ideUpsellExternalTerminal':
    'Connect ZY Code to your IDE · /ide',

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
  'spinner.verbWithDuration': '{verb} for {duration}',
  'spinner.idleFor': 'Idle for {duration}',
  'spinner.compacting': 'Compacting conversation',
  'spinner.hooksRunning': 'Running {hookType} hooks\u2026',

  // Thinking
  'thinking.label': 'thinking',
  'thinking.thoughtFor': 'thought for {duration}',
  'shortcut.interrupt': 'interrupt',
  'shortcut.shortcutsHint': '? for shortcuts',
  'shortcut.background': 'run in background',

  // Permission prompts
  'permission.cancel': 'cancel',
  'permission.amend': 'amend',
  'permission.explain': 'explain',
  'permission.hide': 'hide',
  'permission.doYouWantToProceed': 'Do you want to proceed?',
  'permission.escToCancel': 'Esc to {cancel}',
  'permission.tabToAmend': 'Tab to {amend}',
  'permission.ctrlEToExplain': 'ctrl+e to {explain}',
  'permission.ctrlEToHide': 'ctrl+e to {hide}',
  'permission.feedbackAccept': 'tell Zy what to do next',
  'permission.feedbackReject': 'tell Zy what to do differently',
  'permission.showDebugInfo': 'Ctrl+d to show debug info',
  'permission.hideDebugInfo': 'Ctrl-D to hide debug info',

  // Trust dialog
  'trustDialog.title': 'Accessing workspace:',
  'trustDialog.safetyCheck': "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.",
  'trustDialog.capabilities': "ZY Code'll be able to read, edit, and execute files here.",
  'trustDialog.securityGuide': 'Security guide',
  'trustDialog.trust': 'Yes, I trust this folder',
  'trustDialog.exit': 'No, exit',
  'trustDialog.pressAgainToExit': 'Press {key} again to exit',
  'trustDialog.enterToConfirm': 'Enter to confirm · Esc to cancel',

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
  'common.add': 'add',
  'common.complete': 'complete',
  'common.close': 'close',

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

  // Logo / Welcome screen
  'logo.welcomeBack': 'Welcome back!',
  'logo.welcomeBackUser': 'Welcome back, {username}!',
  'logo.recentActivity': 'Recent Activity',
  'logo.noRecentActivity': 'No recent activity',
  'logo.recentActivityFooter': '/resume to see more',
  'logo.whatsNew': "What's new",
  'logo.whatsNewFooter': '/release-notes for more',
  'logo.whatsNewEmpty': 'Check the ZY Code changelog for updates',
  'logo.noPrompt': 'No prompt',
  'logo.homeDirWarning': 'Note: You have launched zy in your home directory. For the best experience, launch it in a project directory instead.',
  'logo.tipsGettingStarted': 'Tips for getting started',
  'logo.guestPassesTitle': '3 guest passes',
  'logo.guestPassesSubtitle': 'Share ZY Code and earn {reward} of extra usage',
  'logo.guestPassesSubtitleNoReward': 'Share ZY Code with friends',
  'logo.guestPassesFooter': '/passes',

  // Bash tool
  'bash.runInBackground': 'run in background',
  'bash.running': 'Running\u2026',
  'bash.waiting': 'Waiting\u2026',
  'bash.runningInBackground': 'Running in the background',
  'bash.done': 'Done',
  'bash.noOutput': '(No output)',
  'bash.imageDetected': '[Image data detected and sent to ZY]',
  'bash.runningCommand': 'Running command',
  'bash.runningActivity': 'Running {desc}',

  // File read tool
  'fileRead.readImage': 'Read image ({size})',
  'fileRead.noCellsFound': 'No cells found in notebook',
  'fileRead.readCells': 'Read {count} cells',
  'fileRead.readPdf': 'Read PDF ({size})',
  'fileRead.readPages': 'Read {count} {unit}',
  'fileRead.readLines': 'Read {count} {unit}',
  'fileRead.readPages_one': 'page',
  'fileRead.readPages_other': 'pages',
  'fileRead.readLines_one': 'line',
  'fileRead.readLines_other': 'lines',
  'fileRead.unchanged': 'Unchanged since last read',
  'fileRead.notFound': 'File not found',
  'fileRead.errorReading': 'Error reading file',
  'fileRead.readingPlan': 'Reading Plan',
  'fileRead.readAgentOutput': 'Read agent output',
  'fileRead.read': 'Read',

  // File write tool
  'fileWrite.noContent': '(No content)',
  'fileWrite.wroteLines': 'Wrote {lines} lines to {path}',
  'fileWrite.wroteLines_one': 'line',
  'fileWrite.wroteLines_other': 'lines',
  'fileWrite.plusLines': '+{count} {unit}',
  'fileWrite.plusLines_one': 'line',
  'fileWrite.plusLines_other': 'lines',
  'fileWrite.noChanges': '(No changes)',
  'fileWrite.errorWriting': 'Error writing file',
  'fileWrite.planHint': '/plan to preview',
  'fileWrite.updatedPlan': 'Updated plan',
  'fileWrite.write': 'Write',

  // Shell progress
  'shellProgress.timeout': 'timeout',
  'shellProgress.lines': 'lines',
  'shellProgress.done': 'Done',
  'shellProgress.error': 'Error',
  'shellProgress.stopped': 'Stopped',

  // Help menu
  'help.bashMode': '! for bash mode',
  'help.commands': '/ for commands',
  'help.filePaths': '@ for file paths',
  'help.background': '& for background',
  'help.sideQuestion': '/btw for side question',
  'help.clearInput': 'double tap esc to clear input',
  'help.cycleModes': '{shortcut} to cycle permission modes',
  'help.cycleModeAction': 'to cycle permission modes',
  'help.verboseOutput': '{shortcut} for verbose output',
  'help.toggleTasks': '{shortcut} to toggle tasks',
  'help.undo': '{shortcut} to undo',
  'help.suspend': 'ctrl + z to suspend',
  'help.pasteImages': '{shortcut} to paste images',
  'help.switchModel': '{shortcut} to switch model',
    'help.stashPrompt': '{shortcut} to stash prompt',
  'help.externalEditor': '{shortcut} to edit in $EDITOR',
  'help.customizeKeybindings': '/keybindings to customize',
  'help.terminal': '{shortcut} for terminal',
  'help.shortcutsTitle': 'Shortcuts',
  'help.description': 'Zy understands your codebase, makes edits with your permission, and executes commands — right from your terminal.',
  'help.newlineShift': 'shift + \u23CE for newline',
  'help.newlineBackslash': '\\\u23CE for newline',
  'help.newlineBackslashFull': 'backslash (\\) + return (\u23CE) for newline',

  // Permission mode
  'permissionMode.on': 'on',

  // System message
  'systemMessage.verbWithDuration': '{verb} for {duration}',
  'systemMessage.tasksStillRunning': '{count} still running',

  // Attachment
  'attachment.completed': 'completed in background',
  'attachment.stopped': 'stopped',
  'attachment.stillRunning': 'still running in background',

  // Log selector / session search
  'logSelector.searching': 'Searching…',
  'logSelector.results': 'ZY found these results:',
  'logSelector.noResults': 'No matching sessions found.',
  'logSelector.renameSession': 'Rename session:',
  'logSelector.searchDeeply': 'Search deeply with ZY',
  'logSelector.currentWorktree': 'Current worktree',
  'logSelector.resumeSession': 'Resume session',
  'logSelector.searchFailed': 'Search failed',
  'logSelector.collapseHint': '<- Collapse',
  'logSelector.expandHint': '-> Expand',
  'logSelector.sidechain': '(Sidechain)',
  'logSelector.showCurrentDir': 'Show current directory',
  'logSelector.showAllProjects': 'Show all projects',
  'logSelector.toggleBranch': 'Toggle branch',
  'logSelector.showCurrentWorktree': 'Show current worktree',
  'logSelector.showAllWorktrees': 'Show all worktrees',
  'logSelector.preview': 'Preview',
  'logSelector.rename': 'Rename',
  'logSelector.cancel': 'Cancel',
  'logSelector.save': 'Save',
  'logSelector.search': 'Search',
  'logSelector.skip': 'Skip',
  'logSelector.clear': 'Clear',
  'logSelector.typeToSearch': 'Type to search',
  'logSelector.pressAgainToExit': 'Press {key} again to exit',

  // System message
  'systemMessage.defaultVerb': 'Done',

  // Onboarding
  'onboarding.selectLanguage': 'Select your language',
  'onboarding.languageDescription': 'This controls the language for the interface and responses.',
  'onboarding.language.english': 'English',
  'onboarding.language.chinese': 'Chinese (Simplified)',
  'onboarding.selectApiFormat': 'Select API format',
  'onboarding.apiFormatDescription': 'Choose the request format for your custom API endpoint.',
  'onboarding.apiFormat.anthropic': 'Anthropic format',
  'onboarding.apiFormat.anthropicDesc': 'Uses Anthropic Messages API format (supports thinking, cache_control, etc.)',
  'onboarding.apiFormat.openai': 'OpenAI compatible format',
  'onboarding.apiFormat.openaiDesc': 'Uses OpenAI Chat Completions API format (for vLLM, LiteLLM, etc.)',
  'onboarding.platform.dashscope': 'Bailian DashScope',
  'onboarding.platform.dashscopeDesc': 'Alibaba Cloud Bailian Platform',
  'onboarding.platform.openai': 'OpenAI',
  'onboarding.platform.openaiDesc': 'OpenAI API (GPT-4, o-series, etc.)',
  'onboarding.platform.ollama': 'Ollama',
  'onboarding.platform.ollamaDesc': 'Local open-source models (run locally)',
  'onboarding.platform.ollamaApiKey': 'Ollama URL (optional)',
  'onboarding.platform.zhipu': 'ZHIPU AI',
  'onboarding.platform.zhipuDesc': 'ZHIPU AI (ChatGLM, GLM-4, etc.)',
  'onboarding.platform.kimi': 'Kimi',
  'onboarding.platform.kimiDesc': 'Moonshot AI Kimi Platform',
  'onboarding.platform.openrouter': 'OpenRouter',
  'onboarding.platform.openrouterDesc': 'Unified API for multiple model providers',
  'onboarding.platform.anthropic': 'Anthropic',
  'onboarding.platform.anthropicDesc': 'Anthropic Claude API',
  'onboarding.model.qwen36plusDesc': 'Comprehensive capability (recommended)',
  'onboarding.model.qwen35plusDesc': 'High-performance inference',
  'onboarding.model.qwen35flashDesc': 'Fast and lightweight tasks',
  'onboarding.model.gpt4oDesc': 'GPT-4o (recommended)',
  'onboarding.model.gpt4oMiniDesc': 'GPT-4o mini (faster)',
  'onboarding.model.glm4PlusDesc': 'GLM-4-Plus (recommended)',
  'onboarding.model.glm4FlashDesc': 'GLM-4-Flash (fast)',
  'onboarding.model.kimiMoonDesc': 'Moonshot-v1 (recommended)',
  'onboarding.model.kimiMoon8kDesc': 'Moonshot-v1-8k (lightweight)',
  'onboarding.platform.genericDesc': 'Custom API endpoint (Anthropic or OpenAI format)',
  'onboarding.model.custom': 'Custom model',
  'onboarding.model.customDesc': 'Enter a full model name',
  'onboarding.selectPlatform': 'Select AI Platform',
  'onboarding.enterApiKey': 'Enter {apiKeyLabel}',
  'onboarding.confirmBack': 'Enter to confirm · 9 to go back',
  'onboarding.enterModelName': 'Enter Model Name',
  'onboarding.selectDefaultModel': 'Select Default Conversation Model',
  'onboarding.modelDescription': 'Model used at startup, can be changed later via /model',
  'onboarding.orCustomModel': 'Or select "Custom model" for other models',
  'onboarding.enterToConfirm': 'Enter to confirm · Esc to exit',
  'onboarding.enterToConfirmSkip': 'Enter to confirm · Esc to skip',
  'onboarding.pressAgainToExit': 'Press {key} again to exit',
  'onboarding.security.title': 'Security notes:',
  'onboarding.security.risk1': 'ZY Code can make mistakes',
  'onboarding.security.risk1desc': 'You should always review ZY Code&apos;s responses, especially when running code.',
  'onboarding.security.risk2': 'Due to prompt injection risks, only use it with code you trust',
  'onboarding.security.risk2desc': 'For more details see:',
  'onboarding.terminalSetup.title': 'Use ZY Code&apos;s terminal setup?',
  'onboarding.terminalSetup.description': 'For the optimal coding experience, enable the recommended settings for your terminal: {settings}',
  'onboarding.terminalSetup.appleSettings': 'Option+Enter for newlines and visual bell',
  'onboarding.terminalSetup.otherSettings': 'Shift+Enter for newlines',
  'onboarding.terminalSetup.yes': 'Yes, use recommended settings',
  'onboarding.terminalSetup.no': 'No, maybe later with /terminal-setup',

  // Teammate
  'teammate.toolUseCount_one': '{count} tool use',
  'teammate.toolUseCount_other': '{count} tool uses',
  'teammate.tokenCount': '{count} tokens',
  'teammate.enterToView': 'enter to view',

  // Permission dialogs - common
  'permission.yes': 'Yes',
  'permission.no': 'No',
  'permission.noAndTell': 'No, and tell Zy what to do differently (esc)',
  'permission.yesDontAskAgain': "Yes, and don't ask again for {name}",
  'permission.yesDontAskAgainInCwd': "Yes, and don't ask again for {name} in {cwd}",
  'permission.yesDontAskAgainCommands': "Yes, and don't ask again for {name} commands in {cwd}",
  'permission.yesDontAskAgainDomain': "Yes, and don't ask again for {domain}",
  'permission.yesAllowEditsThisSession': 'Yes, allow all edits during this session ({shortcut})',
  'permission.yesAllowReadThisSession': 'Yes, during this session',
  'permission.yesAllowReadFromDir': 'Yes, allow reading from {dir}/ during this session',
  'permission.yesAllowReadSinglePath': 'Yes, allow reading from {dir}/',
  'permission.yesAllowReadMultiplePathsStart': 'Yes, allow reading from',
  'permission.fromThisProject': 'from this project',
  'permission.yesAllowEditsInDir': 'Yes, allow all edits in {dir}/ during this session ({shortcut})',
  'permission.yesAllowZyFolderEdits': 'Yes, and allow Zy to edit its own settings for this session',
  'permission.yesInstallPlugin': 'Yes, install {pluginName}',
  'permission.yesAllowAccessDir': 'Yes, and always allow access to {dir}/ from this project',
  'permission.yesAllowAccessDirs': 'Yes, and always allow access to {dirs} from this project',
  'permission.yesAllowReadAndAccess': 'Yes, and allow {paths} access and {commands} commands',
  'permission.yesAllowAccessAndCommands': 'Yes, and allow access to {paths} and {commands} commands',
  'permission.noDontShowPluginAgain': "No, and don't show plugin installation hints again",
  'permission.noRecommended': 'No (recommended)',
  'permission.tellZyNext': 'and tell Zy what to do next',
  'permission.tellZyDifferently': 'and tell Zy what to do differently',
  'permission.allowNetworkConnection': 'Do you want to allow this connection?',
  'permission.allowWebFetch': 'Do you want to allow Zy to fetch this content?',
  'permission.deletePermissionRule': 'Are you sure you want to delete this permission rule?',
  'permission.deleteAllowedTool': 'Delete allowed tool?',
  'permission.deleteDeniedTool': 'Delete denied tool?',
  'permission.deleteAskTool': 'Delete ask tool?',

  // Permission dialogs - directory access (persist across sessions)
  'permission.alwaysAllowAccessToDir': 'Yes, and always allow access to {dir}',
  'permission.alwaysAllowAccessToDirs': 'Yes, and always allow access to {dirs} from this project',

  // Permission dialogs - commands only (don't ask again)
  'permission.dontAskAgainForCommands': "Yes, and don't ask again for {commands} commands in {cwd}",
  'permission.yesDontAskAgainPrefix': "Yes, and don't ask again for",
  'permission.commandPrefixPlaceholder': 'command prefix (e.g., npm run:*)',
  'permission.powershellPrefixPlaceholder': 'command prefix (e.g., Get-Process:*)',
  'permission.classifierDescriptionPlaceholder': 'describe what to allow...',

  // Permission dialogs - mixed paths and commands
  'permission.allowAccessAndCommands': 'Yes, and allow access to {paths} and {commands} commands',
  'permission.allowPathsAccessAndCommands': 'Yes, and allow {paths} access and {commands} commands',

  // Shortcut hints
  'shortcut.stopAgents': 'stop agents',
  'shortcut.cycleMode': 'cycle mode',
  'common.running': 'Running',

  // Agent tool
  'agent.inProgress': 'In progress…',
  'agent.toolUse_one': 'tool use',
  'agent.toolUse_other': 'tool uses',
  'agent.backgroundAgentsLaunched': '{count} background agents launched',
  'agent.agentsFinished': '{count} {type} finished',
  'agent.agentsFinishedNoType': '{count} agents finished',
  'agent.runningPrefix': 'Running',
  'agent.runningAgents': 'Running {count} {type}…',
  'agent.runningAgentsNoType': 'Running {count} agents…',
  'agent.remoteLaunched': 'Remote agent launched',
  'agent.backgrounded': 'Backgrounded agent',
  'agent.moreToolUses_one': '+{count} more tool use',
  'agent.moreToolUses_other': '+{count} more tool uses',
  'agent.apiCallsOnly': '[ANT-ONLY] API calls: {path}',

  // Skills
  'skills.menu.title': 'Skills',
  'skills.menu.subtitle': '{count} {skill}',
  'skills.menu.noSkills': 'No skills found',
  'skills.menu.dismissed': 'Skills dialog dismissed',
  'skills.menu.createHint': 'Create skills in .zy/skills/ or ~/.zy/skills/',
  'skills.menu.descriptionTokens': '{count} description tokens',
  'skills.menu.pluginSkills': 'Plugin skills',
  'skills.menu.mcpSkills': 'MCP skills',
  'skills.menu.sourceSkills': '{source} skills',
  'skills.improvement.suggested': 'Skill improvement suggested for "{skillName}"',
  'skills.improvement.apply': 'Apply',
  'skills.improvement.dismiss': 'Dismiss',
  'skills.permission.useSkill': 'Use skill "{skill}"?',
  'skills.permission.mayUse': 'Zy may use instructions, code, or files from this Skill.',

  // Pill label (background task status)
  'pill.shell_one': '1 shell',
  'pill.shell_other': '{count} shells',
  'pill.monitor_one': '1 monitor',
  'pill.monitor_other': '{count} monitors',
  'pill.team_one': '1 team',
  'pill.team_other': '{count} teams',
  'pill.localAgent_one': '1 local agent',
  'pill.localAgent_other': '{count} local agents',
  'pill.cloudSession_one': '1 cloud session',
  'pill.cloudSession_other': '{count} cloud sessions',
  'pill.backgroundWorkflow_one': '1 background workflow',
  'pill.backgroundWorkflow_other': '{count} background workflows',
  'pill.dreaming': 'dreaming',
  'pill.ultraplanReady': 'ultraplan ready',
  'pill.ultraplanNeedsInput': 'ultraplan needs your input',
  'pill.ultraplan': 'ultraplan',
  'pill.backgroundTask_one': '1 background task',
  'pill.backgroundTask_other': '{count} background tasks',

  // Team memory collapsed UI — verb forms: first/first lowercase/done/done lowercase
  'teamMem.read.first': 'Recalling',
  'teamMem.read.sub': 'recalling',
  'teamMem.read.done': 'Recalled',
  'teamMem.read.doneSub': 'recalled',
  'teamMem.search.first': 'Searching',
  'teamMem.search.sub': 'searching',
  'teamMem.search.done': 'Searched',
  'teamMem.search.doneSub': 'searched',
  'teamMem.write.first': 'Writing',
  'teamMem.write.sub': 'writing',
  'teamMem.write.done': 'Wrote',
  'teamMem.write.doneSub': 'wrote',
  'teamMem.memory_one': 'memory',
  'teamMem.memory_other': 'memories',
  'teamMem.searchedMemories': 'Searched team memories',
  'teamMem.searchingMemories': 'Searching team memories',
}
