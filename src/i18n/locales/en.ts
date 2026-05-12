import type { TranslationResource } from './resourceTypes.js'

/**
 * English — base language (source of truth for keys)
 */
export const en: TranslationResource = {
  // Tips
  'tip.newUserWarmup':
    'Start with small features or bug fixes, tell ZY code to propose a plan, and verify its suggested edits',
  'tip.planModeForComplexTasks':
    'Use Plan Mode to prepare for a complex request before making changes. Press {shortcut} twice to enable.',
  'tip.defaultPermissionModeConfig':
    'Use /config to change your default permission mode (including Plan Mode)',
  'tip.gitWorktrees': 'Use git worktrees to run multiple ZY code sessions in parallel.',
  'tip.colorWhenMultiSessions':
    'Running multiple ZY Code sessions? Use /color and /rename to tell them apart at a glance.',
  'tip.terminalSetupApple':
    'Run /terminal-setup to enable convenient terminal integration like Option + Enter for new line and more',
  'tip.terminalSetupOther':
    'Run /terminal-setup to enable convenient terminal integration like Shift + Enter for new line and more',
  'tip.shiftEnterApple': 'Press Option+Enter to send a multi-line message',
  'tip.shiftEnterOther': 'Press Shift+Enter to send a multi-line message',
  'tip.shiftEnterSetupApple': 'Run /terminal-setup to enable Option+Enter for new lines',
  'tip.shiftEnterSetupOther': 'Run /terminal-setup to enable Shift+Enter for new lines',
  'tip.memoryCommand': 'Use /memory to view and manage ZY Code memory',
  'tip.themeCommand': 'Use /theme to change the color theme',
  'tip.colortermTruecolor':
    'Try setting environment variable COLORTERM=truecolor for richer colors',
  'tip.powershellToolEnv':
    'Set ZY_CODE_USE_POWERSHELL_TOOL=1 to enable the PowerShell tool (preview)',
  'tip.promptQueue': 'Hit Enter to queue up additional messages while ZY Code is working.',
  'tip.enterToSteer': 'Send messages to ZY code while it works to steer ZY Code in real-time',
  'tip.todoList':
    'Ask ZY Code to create a todo list when working on complex tasks to track progress and remain on track',
  'tip.installGithubApp':
    'Run /install-github-app to tag @zy right from your Github issues and PRs',
  'tip.installSlackApp': 'Run /install-slack-app to use ZY Code in Slack',
  'tip.permissions': 'Use /permissions to pre-approve and pre-deny bash, edit, and MCP tools',
  'tip.dragAndDropImages': 'Did you know you can drag and drop image files into your terminal?',
  'tip.pasteImagesMac': 'Paste images into ZY Code using control+v (not cmd+v!)',
  'tip.doubleEsc': 'Double-tap esc to rewind the conversation to a previous point in time',
  'tip.doubleEscCodeRestore':
    'Double-tap esc to rewind the code and/or conversation to a previous point in time',
  'tip.continue': 'Run zy --continue or zy --resume to resume a conversation',
  'tip.renameConversation':
    'Name your conversations with /rename to find them easily in /resume later',
  'tip.customCommands':
    'Create skills by adding .md files to .zy/skills/ in your project or ~/.zy/skills/ for skills that work in any project',
  'tip.shiftTab':
    'Hit {shortcut} to cycle between modes (default, auto-accept edit, and plan mode)',
  'tip.imagePaste': 'Use {shortcut} to paste images from your clipboard',
  'tip.customAgents':
    'Use /agents to optimize specific tasks. Eg. Software Architect, Code Writer, Code Reviewer',
  'tip.agentFlag': 'Use --agent <agent_name> to directly start a conversation with a subagent',
  'tip.desktopApp': 'Run ZY Code locally or remotely using the Zy desktop app',
  'tip.desktopShortcut': 'Continue your session in ZY Code Desktop with {shortcut}',
  'tip.webApp': 'Run tasks in the cloud while you keep coding locally',
  'tip.mobileApp': '/mobile to use ZY Code from the Zy app on your phone',
  'tip.opusPlanModeReminder':
    'Your default model setting is Opus Plan Mode. Press {shortcut} twice to activate Plan Mode and plan with Zy Opus.',
  'tip.frontendDesignPlugin':
    'Working with HTML/CSS? Install the frontend-design plugin:\n{command}',
  'tip.vercelPlugin': 'Working with Vercel? Install the vercel plugin:\n{command}',
  'tip.effortHighB': 'Use {cmd} for better one-shot answers. Zy thinks it through first.',
  'tip.effortHighA': 'Working on something tricky? {cmd} gives better first answers',
  'tip.subagentFanoutB':
    'For big tasks, tell ZY Code to {cmd}. They work in parallel and keep your main thread clean.',
  'tip.subagentFanoutA':
    'Say {cmd} and ZY Code sends a team. Each one digs deep so nothing gets missed.',
  'tip.loopCommandB': 'Use {cmd} to run any prompt on a schedule. Set it and forget it.',
  'tip.loopCommandA':
    '{cmd} runs any prompt on a recurring schedule. Great for monitoring deploys, babysitting PRs, or polling status.',
  'tip.feedbackCommand': 'Use /feedback to help us improve!',
  'tip.clearContext': 'Use /clear to start fresh when switching topics and free up context',
  'tip.btwSideQuestion': 'Use /btw to ask a quick side question without interrupting current work',
  'tip.vscodeCommandInstall': `Open the Command Palette (Cmd+Shift+P) and run "Shell Command: Install '{command}' command in PATH" to enable IDE integration`,
  'tip.ideUpsellExternalTerminal': 'Connect ZY Code to your IDE · /ide',

  // Rate limit
  'rateLimit.hit': "You've hit your {limit}",
  'rateLimit.close': "You're close to",
  'rateLimit.outOfExtraUsage': "You're out of extra usage",
  'rateLimit.nowUsingExtraUsage': "You're now using extra usage",
  'rateLimit.usedPercent': "You've used {pct}% of your {limit}",
  'rateLimit.approaching': 'Approaching {limit}',
  'rateLimit.resetsAt': 'resets {time}',
  'rateLimit.standardLimit': 'Standard limit',
  'rateLimit.advancedLimit': 'Advanced limit',
  'rateLimit.weeklyLimit': 'weekly limit',
  'rateLimit.sessionLimit': 'session limit',
  'rateLimit.usageLimit': 'usage limit',
  'rateLimit.extraUsageSpendingLimit': "You're close to your extra usage spending limit",
  'rateLimit.feedbackReset':
    'If you have feedback about this limit, post in {channel}. You can reset your limits with /reset-limits',
  'rateLimit.hitWithReset': "You've hit your {limit} · {resetTime}",
  'rateLimit.usedPercentWithReset': "You've used {pct}% of your {limit} · {resetTime}",
  'rateLimit.approachingWithReset': 'Approaching {limit} · {resetTime}',
  'rateLimit.nowUsingExtraUsageWithReset':
    "You're now using extra usage · Your {limit} {resetTime}",

  // Rate limit upsell
  'rateLimit.upsell.extraUsage': '/extra-usage to finish what you\u2019re working on.',
  'rateLimit.upsell.login': '/login to switch to an API usage-billed account.',
  'rateLimit.upsell.openingOptions': 'Opening your options\u2026',
  'rateLimit.upsell.upgrade': '/upgrade to increase your usage limit.',
  'rateLimit.upsell.requestAdmin': '/extra-usage to request more usage from your admin.',
  'rateLimit.upsell.upgradeOrExtra':
    '/upgrade or /extra-usage to finish what you\u2019re working on.',

  // Rate limit options menu
  'rateLimit.whatDoYouWant': 'What do you want to do?',
  'rateLimit.upgradePlan': 'Upgrade your plan',
  'rateLimit.stopAndWait': 'Stop and wait for limit to reset',
  'rateLimit.requestMore': 'Request more',
  'rateLimit.requestExtraUsage': 'Request extra usage',
  'rateLimit.addFunds': 'Add funds to continue with extra usage',
  'rateLimit.switchToExtraUsage': 'Switch to extra usage',

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
  'statusBar.thinkingOn': '💭 Deep Think',
  'shortcut.interrupt': 'interrupt',
  'shortcut.shortcutsHint': '? for shortcuts',
  'shortcut.background': 'run in background',

  // Permission prompts
  // Permission notification messages
  'permission.planApprovalNeeded': 'ZY Code needs your approval for the plan',
  'permission.wantsToEnterPlanMode': 'ZY Code wants to enter plan mode',
  'permission.reviewArtifactApprovalNeeded': 'Zy needs your approval for a review artifact',
  'permission.needsAttention': 'ZY Code needs your attention',
  'permission.needsPermissionFor': 'Zy needs your permission to use {toolName}',

  'permission.cancel': 'cancel',
  'permission.amend': 'amend',
  'permission.explain': 'explain',
  'permission.hide': 'hide',
  // Permission Bash / PowerShell / WebFetch dialog titles
  'permission.attemptingAutoApprove': 'Attempting to auto-approve…',
  'permission.autoApproved': 'Auto-approved',
  'permission.matchedRule': 'matched "{rule}"',
  'permission.requiresManualApproval': 'Requires manual approval',
  'permission.bashCommandUnsandboxed': 'Bash command (unsandboxed)',
  'permission.bashCommand': 'Bash command',
  'permission.powershellCommand': 'PowerShell command',
  'permission.fetch': 'Fetch',

  // Permission mode titles (bottom bar)
  'permissionMode.default': 'Default',
  'permissionMode.defaultShort': 'Default',
  'permissionMode.plan': 'Plan Mode',
  'permissionMode.planShort': 'Plan',
  'permissionMode.acceptEdits': 'Accept edits',
  'permissionMode.acceptEditsShort': 'Accept',
  'permissionMode.bypassPermissions': 'Bypass Permissions',
  'permissionMode.bypassPermissionsShort': 'Bypass',
  'permissionMode.dontAsk': "Don't Ask",
  'permissionMode.dontAskShort': 'DontAsk',
  'permissionMode.auto': 'Auto mode',
  'permissionMode.autoShort': 'Auto',

  // Worker / swarm permission strings
  'permission.waitingTeamLeadApproval': 'Waiting for team lead approval',
  'permission.toolLabel': 'Tool: ',
  'permission.actionLabel': 'Action: ',
  'permission.permissionRequestSentToTeam': 'Permission request sent to team "{teamName}" leader',

  // File write / notebook edit action labels
  'permission.overwriteAction': 'overwrite',
  'permission.createAction': 'create',
  'permission.overwriteFile': 'Overwrite file',
  'permission.createFile': 'Create file',
  'permission.doYouWantToAction': 'Do you want to {action} {filename}?',
  'permission.editNotebook': 'Edit notebook',
  'permission.insertCellInto': 'insert this cell into',
  'permission.deleteCellFrom': 'delete this cell from',
  'permission.makeEditTo': 'make this edit to',
  'permission.doYouWantToNotebookAction': 'Do you want to {action} {filename}?',

  // Filesystem permission read/edit labels
  'permission.read': 'Read',
  'permission.edit': 'Edit',
  'permission.readFileTitle': 'Read file',

  'permission.doYouWantToProceed': 'Do you want to proceed?',
  'permission.escToCancel': 'Esc to {cancel}',
  'permission.tabToAmend': 'Tab to {amend}',
  'permission.ctrlEToExplain': 'ctrl+e to {explain}',
  'permission.ctrlEToHide': 'ctrl+e to {hide}',
  'permission.feedbackAccept': 'tell Zy what to do next',
  'permission.feedbackReject': 'tell Zy what to do differently',
  'permission.showDebugInfo': 'Ctrl+d to show debug info',
  'permission.hideDebugInfo': 'Ctrl-D to hide debug info',
  // Permission Explanation
  'permission.loadingExplanation': 'Loading explanation…',
  'permission.lowRisk': 'Low risk',
  'permission.medRisk': 'Med risk',
  'permission.highRisk': 'High risk',
  'permission.explanationUnavailable': 'Explanation unavailable',

  'permission.editFile': 'Edit file',
  'permission.doYouWantToMakeThisEdit': 'Do you want to make this edit to {filename}?',
  'permission.sedFileDoesNotExist': 'File does not exist',
  'permission.sedPatternDidNotMatch': 'Pattern did not match any content',
  'permission.saveFileToContinue': 'Save file to continue…',
  'permission.openedChangesInIDE': 'Opened changes in {ideName}',
  'permission.symlinkModifyOutside':
    'This will modify {symlinkTarget} (outside working directory) via a symlink',
  'permission.symlinkTarget': 'Symlink target: {symlinkTarget}',

  // Trust dialog
  'trustDialog.title': 'Accessing workspace:',
  'trustDialog.safetyCheck':
    "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.",
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
  'usage.extraUsageNotEnabled': 'Extra usage not enabled · /extra-usage to enable',
  'usage.unlimited': 'Unlimited',
  'usage.loading': 'Loading usage data\u2026',
  'usage.loadError': 'Failed to load usage data',
  'usage.loadErrorDetail': 'Failed to load usage data: {detail}',
  'usage.percentUsed': '{pct}% used',
  'usage.resets': 'Resets {time}',
  'usage.spent': '{used} / {total} spent',
  'usage.subscriptionOnly': '/usage is only available for subscription plans.',
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
  'effort.medium': 'Medium',
  'effort.max': 'Max',
  'effort.defaultDialogTitle': 'We recommend medium effort',
  'effort.defaultDialogDescription':
    'Effort determines how long model thinks for when completing your task. We recommend medium effort for most tasks to balance speed and intelligence and maximize rate limits. Use ultrathink to trigger high effort when needed.',

  // Press Enter
  pressEnterToContinue: 'Press Enter to continue\u2026',

  // Dialog
  'dialog.pressAgainToExit': 'Press {keyName} again to exit',

  // Common
  'common.retry': 'retry',
  'common.cancel': 'cancel',
  'common.expand': 'expand',
  'common.collapse': 'collapse',
  'common.select': 'select',
  'common.confirm': 'confirm',
  'common.navigate': 'navigate',
  'common.nav': 'nav',
  'common.toggle': 'toggle',
  'common.manage': 'manage',
  'common.add': 'add',
  'common.complete': 'complete',
  'common.close': 'close',
  'common.copy': 'copy',
  'common.remove': 'remove',
  'common.update': 'update',
  'common.resume': 'resume',
  'common.switch': 'switch',
  'common.return': 'return',
  'common.writeToFile': 'write to file',
  'common.confirmYes': 'confirm yes',
  'common.confirmNo': 'confirm no',
  'common.selectAccept': 'accept',
  'common.selectPrevious': 'previous',
  'common.selectCancel': 'cancel selection',

  // Transcript footer
  'transcript.showingDetailedTranscript': 'Showing detailed transcript',
  'transcript.toToggle': 'to toggle',
  'transcript.toNavigate': 'to navigate',
  'transcript.scroll': 'scroll',
  'transcript.top': 'top',
  'transcript.bottom': 'bottom',
  'transcript.toCollapse': 'to collapse',
  'transcript.toShowAll': 'to show all',

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
  'logo.homeDirWarning':
    'Note: You have launched zy in your home directory. For the best experience, launch it in a project directory instead.',
  'logo.tipsGettingStarted': 'Tips for getting started',

  // OAuth / Login
  'oauth.forceLoginMethod.zyai': 'Login method pre-selected: Subscription Plan (Zy Pro/Max)',
  'oauth.forceLoginMethod.console': 'Login method pre-selected: API Usage Billing',

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
  'bash.sedRequiresApproval':
    'sed command requires approval (contains potentially dangerous operations)',
  'bash.sedDangerousOperations':
    'sed command contains operations that require explicit approval (e.g., write commands, execute commands)',
  'bash.sedNoDangerousOperations': 'No dangerous sed operations detected',
  'bash.permission.requiresApproval': 'This command requires approval',
  'bash.permission.readOnlyAllowed': 'Read-only command is allowed',
  'bash.permission.sandboxAutoAllow':
    'Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)',
  'bash.permission.allowedByPromptRule': 'Allowed by prompt rule: "{rule}"',
  'bash.permission.deniedByPromptRule': 'Denied by Bash prompt rule: "{rule}"',
  'bash.permission.requiredByPromptRule': 'Required by Bash prompt rule: "{rule}"',
  'bash.permission.malformedSyntax':
    'Command contains malformed syntax that cannot be parsed: {error}',
  'bash.permission.tooManySubcommands':
    'Command splits into {count} subcommands, too many to safety-check individually',
  'bash.permission.multipleCd':
    'Multiple directory changes in one command require approval for clarity',
  'bash.permission.cdAndGit':
    'Compound commands with cd and git require approval to prevent bare repository attacks',
  'bash.permission.shellOperators':
    'This command uses shell operators that require approval for safety',
  'bash.permission.parseFailed': 'Failed to parse command',
  'bash.permission.noPipes': 'No pipes found in command',
  'bash.permission.patternsRequireApproval': 'Command contains patterns that require approval',
  'bash.permission.securityPatterns':
    'This command contains patterns that could pose security risks and requires approval',
  'bash.permission.requiresSandboxBypass': 'Requires permission to bypass sandbox',
  'bash.permission.processSubstitution': 'Process substitution requires manual approval',
  'bash.permission.processSubstitutionFull':
    'Process substitution ({pattern}) can execute arbitrary commands and requires manual approval',
  'bash.permission.shellExpansionInPaths':
    'Shell expansion syntax in paths requires manual approval',
  'bash.permission.shellExpansionInPathsFull':
    'Shell expansion syntax in paths requires manual approval',
  'bash.permission.dangerousOperationOnPath':
    'Dangerous {command} operation on critical path: {path}',

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
  'help.description':
    'Zy understands your codebase, makes edits with your permission, and executes commands — right from your terminal.',
  'help.newlineShift': 'shift + \u23CE for newline',
  'help.newlineBackslash': '\\\u23CE for newline',
  'help.newlineBackslashFull': 'backslash (\\) + return (\u23CE) for newline',

  // Permission mode
  'permissionMode.on': 'on',

  // System message
  // Note: tasksStillRunning {count} slot is filled with a phrase that already
  // contains the unit (e.g. "2 local agents"), so do not add another noun here.
  'systemMessage.verbWithDuration': '{verb} for {duration}',
  'systemMessage.tasksStillRunning': ', {count} still running',
  'systemMessage.hookSummary_one': 'Ran {count} {label} hook',
  'systemMessage.hookSummary_other': 'Ran {count} {label} hooks',
  'systemMessage.hookError': '{label} hook error: {error}',
  'systemMessage.stopHookLabel': 'stop',

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
  'onboarding.apiFormat.anthropicDesc':
    'Uses Anthropic Messages API format (supports thinking, cache_control, etc.)',
  'onboarding.apiFormat.openai': 'OpenAI format',
  'onboarding.apiFormat.openaiDesc':
    'Uses OpenAI Chat Completions API format (for vLLM, LiteLLM, etc.)',
  'onboarding.platform.dashscope': 'Bailian DashScope',
  'onboarding.platform.dashscopeDesc': 'Alibaba Cloud Bailian Platform',
  'onboarding.platform.openai': 'OpenAI',
  'onboarding.platform.openaiDesc': 'OpenAI API (GPT-4, o-series, etc.)',
  'onboarding.platform.local': 'Local Model',
  'onboarding.platform.localDesc': 'Locally deployed models (Ollama, vLLM, etc.)',
  'onboarding.platform.localApiKey': 'Local endpoint URL (optional)',
  'onboarding.platform.ollama': 'Ollama',
  'onboarding.platform.ollamaDesc': 'Local open-source models via Ollama',
  'onboarding.platform.lmstudio': 'LM Studio',
  'onboarding.platform.lmstudioDesc': 'Local models via LM Studio',
  'onboarding.platform.llamacpp': 'llama.cpp',
  'onboarding.platform.llamacppDesc': 'Local models via llama.cpp server',
  'onboarding.platform.nvidia-nim': 'NVIDIA NIM',
  'onboarding.platform.nvidia-nimDesc': 'NVIDIA NIM inference microservices',
  'onboarding.platform.zhipu': 'ZHIPU AI',
  'onboarding.platform.zhipuDesc': 'ZHIPU AI (ChatGLM, GLM-4, etc.)',
  'onboarding.platform.kimi': 'Kimi',
  'onboarding.platform.kimiDesc': 'Moonshot AI Kimi Platform',
  'onboarding.platform.openrouter': 'OpenRouter',
  'onboarding.platform.openrouterDesc': 'Unified API for multiple model providers',
  'onboarding.platform.anthropic': 'Anthropic',
  'onboarding.platform.anthropicDesc': 'Anthropic Claude API',
  'onboarding.platform.siliconflow': 'SiliconFlow',
  'onboarding.platform.siliconflowDesc': 'SiliconFlow Cloud AI Platform',
  'onboarding.platform.volcark': 'Volcengine ARK',
  'onboarding.platform.volcarkDesc': 'ByteDance Volcengine ARK Platform',
  'onboarding.platform.tencentlke': 'Tencent Cloud LKE',
  'onboarding.platform.tencentlkeDesc': 'Tencent Cloud LKE AI Platform',
  'onboarding.platform.deepseek': 'DeepSeek',
  'onboarding.platform.deepseekDesc': 'DeepSeek AI Platform',
  'onboarding.platform.minimax': 'MiniMax',
  'onboarding.platform.minimaxDesc': 'MiniMax AI Platform',
  'onboarding.platform.baiduqianfan': 'Baidu AI Studio',
  'onboarding.platform.baiduqianfanDesc': 'Baidu Qianfan / AI Studio Platform',
  'onboarding.platform.huaweicloud': 'Huawei Cloud ModelArts',
  'onboarding.platform.huaweicloudDesc': 'Huawei Cloud ModelArts MaaS',
  'onboarding.platform.together': 'Together AI',
  'onboarding.platform.togetherDesc': 'Together AI inference platform',
  'onboarding.platform.groq': 'Groq',
  'onboarding.platform.groqDesc': 'Groq ultra-fast inference',
  'onboarding.platform.fireworks': 'Fireworks AI',
  'onboarding.platform.fireworksDesc': 'Fireworks AI inference platform',
  'onboarding.platform.perplexity': 'Perplexity',
  'onboarding.platform.perplexityDesc': 'Perplexity AI search-augmented models',
  'model.tag.recommended': 'Recommended',
  'model.tag.fast': 'Fast',
  'model.tag.lightweight': 'Lightweight',
  'model.tag.reasoning': 'Reasoning',
  'model.tag.balanced': 'Balanced',
  'model.tag.coding': 'Coding',
  'model.tag.flagship': 'Flagship',
  'model.tag.budget': 'Budget-friendly',
  'onboarding.platform.generic': 'Generic (Custom)',
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
  'onboarding.tier.standard.title': 'Configure Standard Tier Model',
  'onboarding.tier.standard.desc': 'Used for everyday tasks. This is the minimum required tier.',
  'onboarding.tier.advanced.title': 'Configure Advanced Tier Model (optional)',
  'onboarding.tier.advanced.desc': 'Used for complex reasoning. Skip to use the standard model.',
  'onboarding.tier.compact.title': 'Configure Compact Tier Model (optional)',
  'onboarding.tier.compact.desc':
    'Used for fast/lightweight tasks (summaries, titles). Skip to use the standard model.',
  'onboarding.tier.mainLoop.title': 'Select Main Conversation Tier',
  'onboarding.tier.mainLoop.desc':
    'Which tier to use for the main conversation loop. Can be changed later via /config mainLoopModel.',
  'onboarding.tier.option.advanced': 'Advanced — complex reasoning',
  'onboarding.tier.option.standard': 'Standard — everyday tasks (default)',
  'onboarding.tier.option.compact': 'Compact — fast/lightweight',
  'onboarding.tier.skip': 'Skip (use standard model)',
  'onboarding.tier.custom': 'Custom model',
  'onboarding.tier.customDesc': 'Enter a full model name',
  'onboarding.enterToConfirm': 'Enter to confirm · Esc to exit',
  'onboarding.enterToConfirmSkip': 'Enter to confirm · Esc to skip',
  'onboarding.pressAgainToExit': 'Press {key} again to exit',
  'onboarding.effort.title': 'Choose effort level',
  'onboarding.effort.desc':
    "How thorough should ZY Code's responses be? Medium balances quality and speed. You can change this later with /effort.",
  'onboarding.security.title': 'Security notes:',
  'onboarding.security.risk1': 'ZY Code can make mistakes',
  'onboarding.security.risk1desc':
    'You should always review ZY Code&apos;s responses, especially when running code.',
  'onboarding.security.risk2': 'Due to prompt injection risks, only use it with code you trust',
  'onboarding.security.risk2desc': 'For more details see:',
  'onboarding.terminalSetup.title': 'Use ZY Code&apos;s terminal setup?',
  'onboarding.terminalSetup.description':
    'For the optimal coding experience, enable the recommended settings for your terminal: {settings}',
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
  'permission.yesAllowReadSinglePath': 'Yes, allow reading from {dir}/ in this project',
  'permission.yesAllowReadMultiplePathsStart': 'Yes, allow reading from',
  'permission.yesAllowReadMultiplePathsEnd': 'in this project',
  'permission.fromThisProject': 'from this project',
  'permission.yesAllowEditsInDir':
    'Yes, allow all edits in {dir}/ during this session ({shortcut})',
  'permission.yesAllowZyFolderEdits': 'Yes, and allow ZY to edit its own settings for this session',
  'permission.yesInstallPlugin': 'Yes, install {pluginName}',
  'permission.yesAllowAccessDir': 'Yes, and always allow access to {dir}/ from this project',
  'permission.yesAllowAccessDirs': 'Yes, and always allow access to {dirs} from this project',
  'permission.yesAllowReadAndAccess': 'Yes, and allow {paths} access and {commands} commands',
  'permission.yesAllowAccessAndCommands':
    'Yes, and allow access to {paths} and {commands} commands',
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
  'permission.alwaysAllowAccessToDir': 'Yes, and always allow access to {dir} in this project',
  'permission.alwaysAllowAccessToDirs': 'Yes, and always allow access to {dirs} from this project',

  // Permission dialogs - commands only (don't ask again)
  'permission.dontAskAgainForCommands': "Yes, and don't ask again for {commands} commands in {cwd}",
  'permission.yesDontAskAgainPrefix': "Yes, and don't ask again for",
  'permission.commandPrefixPlaceholder': 'command prefix (e.g., npm run:*)',
  'permission.powershellPrefixPlaceholder': 'command prefix (e.g., Get-Process:*)',
  'permission.classifierDescriptionPlaceholder': 'describe what to allow...',

  // Permission helpers — command and path list joiners
  'permission.and': 'and',
  'permission.commaAnd': ', and',
  'permission.similar': 'similar',
  'permission.morePaths': 'more',
  'permission.commaAndMore': ', and {count} more',

  // Permission dialogs - mixed paths and commands
  'permission.allowAccessAndCommands': 'Yes, and allow access to {paths} and {commands} commands',
  'permission.allowPathsAccessAndCommands': 'Yes, and allow {paths} access and {commands} commands',

  // Plan mode exit dialog
  'planMode.readyToCode': 'Ready to code?',
  'planMode.hereIsPlan': 'Here is Zy&apos;s plan:',
  'planMode.planWrittenReady':
    'Zy has written up a plan and is ready to execute. Would you like to proceed?',
  'planMode.wouldYouProceed': 'Would you like to proceed?',
  'planMode.exitPlanMode': 'Exit plan mode?',
  'planMode.wantsExit': 'Zy wants to exit plan mode',
  'planMode.requestedPermissions': 'Requested permissions:',
  'planMode.ctrlGEditIn': 'ctrl-g to edit in',
  'planMode.planSaved': 'Plan saved!',
  'planMode.usedLabel': 'used',
  'planMode.yesClearContext': 'Yes, clear context{usedLabel} and use auto mode',
  'planMode.yesClearContextBypass': 'Yes, clear context{usedLabel} and bypass permissions',
  'planMode.yesClearContextEdits': 'Yes, clear context{usedLabel} and auto-accept edits',
  'planMode.yesAutoMode': 'Yes, and use auto mode',
  'planMode.yesBypassPermissions': 'Yes, and bypass permissions',
  'planMode.yesAutoAcceptEdits': 'Yes, auto-accept edits',
  'planMode.yesManuallyApprove': 'Yes, manually approve edits',
  'planMode.noKeepPlanning': 'No, keep planning',
  'planMode.tellZyWhatToChange': 'Tell Zy what to change',
  'planMode.shiftTabApprove': 'shift+tab to approve with this feedback',
  'planMode.enterTitle': 'Enter plan mode?',
  'planMode.wantsEnter':
    'Zy wants to enter plan mode to explore and design an implementation approach.',
  'planMode.inPlanModeWill': 'In plan mode, Zy will:',
  'planMode.exploreCodebase': ' · Explore the codebase thoroughly',
  'planMode.identifyPatterns': ' · Identify existing patterns',
  'planMode.designStrategy': ' · Design an implementation strategy',
  'planMode.presentPlan': ' · Present a plan for your approval',
  'planMode.noCodeChanges': 'No code changes will be made until you approve the plan.',
  'planMode.yesEnter': 'Yes, enter plan mode',
  'planMode.noStartImpl': 'No, start implementing now',

  // Shortcut hints
  'shortcut.stopAgents': 'stop agents',
  'shortcut.cycleMode': 'cycle mode',
  'shortcut.tabs': 'tabs',
  'shortcut.nativeSelect': 'native select',
  'shortcut.viewTasks': 'view tasks',
  'shortcut.returnToTeamLead': 'return to team lead',
  'common.running': 'Running',
  'app.toggleTranscript': 'toggle transcript',
  'chat.externalEditor': 'open in external editor',
  'chat.stash': 'stash',
  'plugin.toggle': 'toggle plugin',
  'plugin.install': 'install plugin',
  'settings.search': 'search',
  'settings.retry': 'retry',
  'settings.close': 'close',
  'attachments.next': 'next attachment',
  'attachments.previous': 'previous attachment',
  'attachments.remove': 'remove attachment',
  'attachments.exit': 'exit attachments',

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
  'agent.prompt': 'Prompt:',
  'agent.response': 'Response:',
  'agent.done': 'Done',
  'agent.initializing': 'Initializing…',
  'agent.unitTokens': 'tokens',
  'agent.defaultName': 'Agent',

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
  // theme picker
  'themePicker.title': 'Theme',
  'themePicker.intro': "Let's get started.",
  'themePicker.chooseStyle': 'Choose the text style that looks best with your terminal',
  'themePicker.auto': 'Auto (match terminal)',
  'themePicker.dark': 'Dark mode',
  'themePicker.light': 'Light mode',
  'themePicker.darkDaltonized': 'Dark mode (colorblind-friendly)',
  'themePicker.lightDaltonized': 'Light mode (colorblind-friendly)',
  'themePicker.darkAnsi': 'Dark mode (ANSI colors only)',
  'themePicker.lightAnsi': 'Light mode (ANSI colors only)',
  'themePicker.syntaxUnavailable': 'Syntax highlighting disabled (via {envVar})',
  'themePicker.syntaxDisabled': 'Syntax highlighting disabled ({shortcut} to enable)',
  'themePicker.syntaxTheme': 'Syntax theme: {themeName} ({source}) ({shortcut} to disable)',
  'themePicker.syntaxThemeSimple': 'Syntax theme: {themeName} ({shortcut} to disable)',
  'themePicker.syntaxEnabled': 'Syntax highlighting enabled ({shortcut} to disable)',
  'themePicker.select': 'select',
  'themePicker.cancel': 'cancel',
  'themePicker.exitAgain': 'Press {key} again to exit',
  'onboarding.themeHelpText': '后续可通过 /theme 更改',

  // Bash security
  'bashSecurity.processSubstitutionBefore':
    'process substitution (<) which can read from command output',
  'bashSecurity.processSubstitutionAfter':
    'process substitution (>) which can write to command input',
  'bashSecurity.zshProcessSubstitution': 'Zsh process substitution (=) which can execute commands',
  'bashSecurity.zshEqualsExpansion': 'Zsh EQUALS expansion which expands to command path',
  'bashSecurity.dollarCommandSubstitution':
    '$() command substitution which can execute arbitrary commands',
  'bashSecurity.parameterSubstitution':
    '${} parameter substitution which can expand variables or execute commands',
  'bashSecurity.legacyArithmeticExpansion': '$[] legacy arithmetic expansion',
  'bashSecurity.zshStyleParameterExpansion': 'Zsh style parameter expansion (~[])',
  'bashSecurity.zshStyleGlobQualifiers':
    'Zsh style glob qualifiers (e:) which can execute commands',
  'bashSecurity.zshGlobQualifierWithCommand': 'Zsh glob qualifier (+) with command execution',
  'bashSecurity.zshAlwaysBlock': 'Zsh always block which executes code unconditionally',
  'bashSecurity.powerShellCommentSyntax': 'PowerShell comment syntax (<#) which can hide commands',
  'bashSecurity.empty': 'Command is not empty',
  'bashSecurity.incompleteTab': 'Command appears to be an incomplete fragment (starts with tab)',
  'bashSecurity.incompleteFlags':
    'Command appears to be an incomplete fragment (starts with flags)',
  'bashSecurity.incompleteOperator':
    'Command appears to be a continuation line (starts with operator)',
  'bashSecurity.complete': 'Command appears complete',
  'bashSecurity.safeHeredocNoSubstitution': 'No heredoc in substitution',
  'bashSecurity.noHeredocInSubstitution': 'No heredoc in substitution',
  'bashSecurity.safeHeredocNeedsValidation': 'Command substitution needs validation',
  'bashSecurity.commandSubstitutionNeedsValidation': 'Command substitution needs validation',
  'bashSecurity.gitNotCommit': 'Not a git commit',
  'bashSecurity.notGitCommit': 'Not a git commit',
  'bashSecurity.gitBackslash': 'Git commit contains backslash, needs full validation',
  'bashSecurity.gitCommitSubstitution': 'Git commit message contains command substitution patterns',
  'bashSecurity.gitRemainderMetacharacters': 'Git commit remainder contains shell metacharacters',
  'bashSecurity.gitRemainderRedirect': 'Git commit remainder contains unquoted redirect operator',
  'bashSecurity.gitNeedsValidation': 'Git commit needs validation',
  'bashSecurity.gitCommitNeedsValidation': 'Git commit needs validation',
  'bashSecurity.jqNotJq': 'Not jq',
  'bashSecurity.notJq': 'Not jq',
  'bashSecurity.jqSystemFunction':
    'jq command contains system() function which executes arbitrary commands',
  'bashSecurity.jqDangerousFlags':
    'jq command contains dangerous flags that could execute code or read arbitrary files',
  'bashSecurity.jqSafe': 'jq command is safe',
  'bashSecurity.shellMetacharacters':
    'Command contains shell metacharacters (;, |, or &) in arguments',
  'bashSecurity.noMetacharacters': 'No metacharacters',
  'bashSecurity.dangerousVariables':
    'Command contains variables in dangerous contexts (redirections or pipes)',
  'bashSecurity.noDangerousVariables': 'No dangerous variables',
  'bashSecurity.backticks': 'Command contains backticks (`) for command substitution',
  'bashSecurity.commandSubstitution': 'Command contains {pattern}',
  'bashSecurity.noDangerousPatterns': 'No dangerous patterns',
  'bashSecurity.inputRedirection':
    'Command contains input redirection (<) which could read sensitive files',
  'bashSecurity.outputRedirection':
    'Command contains output redirection (>) which could write to arbitrary files',
  'bashSecurity.noRedirections': 'No redirections',
  'bashSecurity.noNewlines': 'No newlines',
  'bashSecurity.newlinesMultipleCommands':
    'Command contains newlines that could separate multiple commands',
  'bashSecurity.newlinesInData': 'Newlines appear to be within data',
  'bashSecurity.noCarriageReturn': 'No carriage return',
  'bashSecurity.carriageReturn':
    'Command contains carriage return (\\r) which shell-quote and bash tokenize differently',
  'bashSecurity.crInsideDoubleQuotes': 'CR only inside double quotes',
  'bashSecurity.crOnlyInsideDoubleQuotes': 'CR only inside double quotes',
  'bashSecurity.ifsInjection':
    'Command contains IFS variable usage which could bypass security validation',
  'bashSecurity.ifsVariable':
    'Command contains IFS variable usage which could bypass security validation',
  'bashSecurity.noIfsInjection': 'No IFS injection detected',
  'bashSecurity.procEnviron':
    'Command accesses /proc/*/environ which could expose sensitive environment variables',
  'bashSecurity.noProcEnviron': 'No /proc/environ access detected',
  'bashSecurity.parseFailed': 'Parse failed, handled elsewhere',
  'bashSecurity.noCommandSeparators': 'No command separators',
  'bashSecurity.malformedTokens':
    'Command contains ambiguous syntax with command separators that could be misinterpreted',
  'bashSecurity.ambiguousSeparators':
    'Command contains ambiguous syntax with command separators that could be misinterpreted',
  'bashSecurity.noMalformedTokens': 'No malformed token injection detected',
  'bashSecurity.noMalformedToken': 'No malformed token injection detected',
  'bashSecurity.echoSafe': 'echo command is safe and has no dangerous flags',
  'bashSecurity.ansiCQuoting': 'Command contains ANSI-C quoting which can hide characters',
  'bashSecurity.localeQuoting': 'Command contains locale quoting which can hide characters',
  'bashSecurity.emptyQuotesBeforeDash':
    'Command contains empty special quotes before dash (potential bypass)',
  'bashSecurity.emptySpecialQuotesBeforeDash':
    'Command contains empty special quotes before dash (potential bypass)',
  'bashSecurity.emptyQuotesBeforeDashAlt':
    'Command contains empty quotes before dash (potential bypass)',
  'bashSecurity.emptyQuotePairDash':
    'Command contains empty quote pair adjacent to quoted dash (potential flag obfuscation)',
  'bashSecurity.consecutiveQuotes':
    'Command contains consecutive quote characters at word start (potential obfuscation)',
  'bashSecurity.quotedInFlag': 'Command contains quoted characters in flag names',
  'bashSecurity.noObfuscatedFlags': 'No obfuscated flags detected',
  'bashSecurity.backslashWhitespace':
    'Command contains backslash-escaped whitespace that could alter command parsing',
  'bashSecurity.noBackslashWhitespace': 'No backslash-escaped whitespace',
  'bashSecurity.noOperatorNodes': 'No operator nodes in AST',
  'bashSecurity.backslashOperator':
    'Command contains a backslash before a shell operator (;, |, &, <, >) which can hide command structure',
  'bashSecurity.noBackslashOperators': 'No backslash-escaped operators',
  'bashSecurity.braceExcessClosing':
    'Command has excess closing braces after quote stripping, indicating possible brace expansion obfuscation',
  'bashSecurity.braceQuotedInside':
    'Command contains quoted brace character inside brace context (potential brace expansion obfuscation)',
  'bashSecurity.braceExpansion':
    'Command contains brace expansion that could alter command parsing',
  'bashSecurity.noBraceExpansion': 'No brace expansion detected',
  'bashSecurity.unicodeWhitespace':
    'Command contains Unicode whitespace characters that could cause parsing inconsistencies',
  'bashSecurity.noUnicodeWhitespace': 'No Unicode whitespace',
  'bashSecurity.midWordHash':
    'Command contains mid-word # which is parsed differently by shell-quote vs bash',
  'bashSecurity.noMidWordHash': 'No mid-word hash',
  'bashSecurity.treeSitterAuthoritative': 'Tree-sitter quote context is authoritative',
  'bashSecurity.commentQuoteDesync':
    'Command contains quote characters inside a # comment which can desync quote tracking',
  'bashSecurity.noCommentQuoteDesync': 'No comment quote desync',
  'bashSecurity.noNewlineOrHash': 'No newline or no hash',
  'bashSecurity.quotedNewlineHash':
    'Command contains a quoted newline followed by a #-prefixed line, which can hide arguments from line-based permission checks',
  'bashSecurity.noQuotedNewlineHash': 'No quoted newline-hash pattern',
  'bashSecurity.zshDangerousCommand':
    "Command uses Zsh-specific '{baseCmd}' which can bypass security checks",
  'bashSecurity.fcEditor': "Command uses 'fc -e' which can execute arbitrary commands via editor",
  'bashSecurity.noZshDangerousCommands': 'No Zsh dangerous commands',
  'bashSecurity.controlCharacters':
    'Command contains non-printable control characters that could be used to bypass security checks',
  'bashSecurity.singleQuotedBackslash':
    'Command contains single-quoted backslash pattern that could bypass security checks',
  'bashSecurity.allChecksPassed': 'Command passed all security checks',

  // Command descriptions (slash command popup list)
  'commands.addDir': 'Add a new working directory',
  'commands.advisor': 'Configure the advisor model',
  'commands.agents': 'Manage agent configurations',
  'commands.branch': 'Create a branch of the current conversation at this point',
  'commands.btw': 'Ask a quick side question without interrupting the main conversation',
  'commands.chrome': 'Claude in Chrome (Beta) settings',
  'commands.clear': 'Clear conversation history and free up context',
  'commands.color': 'Set the prompt bar color for this session',
  'commands.compact': 'Clear conversation history but keep a summary in context',
  'commands.config': 'Open config panel',
  'commands.copy': "Copy Zy's last response to clipboard",
  'commands.desktop': 'Continue the current session in Zy Desktop',
  'commands.context': 'Visualize current context usage as a colored grid',
  'commands.contextNonInteractive': 'Show current context usage',
  'commands.cost': 'Show the total cost and duration of the current session',
  'commands.diff': 'View uncommitted changes and per-turn diffs',
  'commands.doctor': 'Diagnose and verify your ZY Code installation and settings',
  'commands.effort': 'Set effort level for model usage',
  'commands.exit': 'Exit the REPL',
  'commands.files': 'List all files currently in context',
  'commands.help': 'Show help and available commands',
  'commands.ide': 'Manage IDE integrations and show status',
  'commands.init': 'Initialize a new ZY.md file with codebase documentation',
  'commands.keybindings': 'Open or create your keybindings configuration file',
  'commands.installGitHubApp': 'Set up ZY GitHub Actions for a repository',
  'commands.installSlackApp': 'Install the ZY Slack app',
  'commands.mcp': 'Manage MCP servers',
  'commands.memory': 'Edit ZY memory files',
  'commands.mobile': 'Show QR code to download the ZY mobile app',
  'commands.model': 'Set the AI model for ZY Code',
  'commands.outputStyle': 'Deprecated: use /config to change output style',
  'commands.remoteEnv': 'Configure the default remote environment for teleport sessions',
  'commands.plugin': 'Manage ZY Code plugins',
  'commands.prComments': 'Get comments from a GitHub pull request',
  'commands.releaseNotes': 'View release notes',
  'commands.reloadPlugins': 'Activate pending plugin changes in the current session',
  'commands.rename': 'Rename the current conversation',
  'commands.resume': 'Resume a previous conversation',

  // Doctor screen
  'doctor.dismissed': 'ZY Code Doctor dismissed',
  'doctor.checking': 'Checking installation status…',
  'doctor.title': 'Doctor',
  'doctor.currentlyRunning': 'Currently running:',
  'doctor.path': 'Path',
  'doctor.invoked': 'Invoked',
  'doctor.configInstallMethod': 'Config install method',
  'doctor.searchOk': 'working',
  'doctor.searchNotWorking': 'not working',
  'doctor.recommendation': 'Recommendation',
  'doctor.warningMultipleInstallations': '⚠ Warning: multiple installations detected',
  'doctor.updates': 'Updates',
  'doctor.autoUpdates': 'Auto-updates',
  'doctor.managedByPackageManager': 'Managed by package manager',
  'doctor.updatePermissions': 'Update permissions',
  'doctor.yes': 'yes',
  'doctor.noRequiresSudo': 'no (requires sudo)',
  'doctor.autoUpdateChannel': 'Auto-update channel',
  'doctor.failedToFetchVersions': 'failed to fetch versions',
  'doctor.stableVersion': 'Stable',
  'doctor.latestVersion': 'Latest',
  'doctor.versionLocks': 'Version Locks',
  'doctor.noActiveLocks': 'No active version locks',
  'doctor.staleLocks': 'stale lock(s)',
  'doctor.cleanedStaleLocks': 'Cleaned',
  'doctor.running': 'running',
  'doctor.stale': 'stale',
  'doctor.agentParseErrors': 'Agent Parse Errors',
  'doctor.failedToParse': 'Failed to parse',
  'doctor.agentFiles': 'agent file(s)',
  'doctor.pluginErrors': 'Plugin Errors',
  'doctor.pluginErrorsDetected': 'Detected',
  'doctor.pluginErrorCount': 'plugin error(s)',
  'doctor.unreachableRules': 'Unreachable Permission Rules',
  'doctor.contextWarnings': 'Context Usage Warnings',
  'doctor.invalidSettings': 'Invalid Settings',
  'doctor.environmentVariables': 'Environment Variables',
  'doctor.packageManager': 'Package manager:',
  'doctor.warning': 'Warning:',
  'doctor.fix': 'Fix:',
  'doctor.topContributors': 'Top contributors:',
  'doctor.mcpServers': 'MCP servers:',
  'doctor.searchLabel': 'Search',
  'doctor.bundled': 'bundled',
  'doctor.vendor': 'vendor',
  'doctor.system': 'system',
  'doctor.unknownSource': 'unknown',

  // Resume Conversation screen
  'resume.loading': 'Loading conversations…',
  'resume.resuming': 'Resuming conversation…',
  'resume.noConversations': 'No conversations found to resume.',
  'resume.exitHint': 'Press Ctrl+C to exit and start a new conversation.',
  'resume.crossProject': 'This conversation is from a different directory.',
  'resume.crossProjectCommand': 'To resume, run:',
  'resume.commandCopied': 'Command copied to clipboard',

  // Tool Config
  'toolConfig.getting': 'Getting {setting}',
  'toolConfig.settingTo': 'Setting {setting} to {value}',
  'toolConfig.failed': 'Failed: {error}',
  'toolConfig.setValue': 'Set {setting} to {value}',
  'toolConfig.changeRejected': 'Config change rejected',

  // Tool Enter Plan Mode
  'toolEnterPlanMode.entered': 'Entered plan mode',
  'toolEnterPlanMode.exploring': 'ZY is now exploring and designing an implementation approach.',
  'toolEnterPlanMode.declined': 'User declined to enter plan mode',

  // Tool Enter Worktree
  'toolEnterWorktree.creating': 'Creating worktree…',
  'toolEnterWorktree.switched': 'Switched to worktree on branch {branch}',

  // Tool Schedule Cron
  'toolScheduleCron.scheduled': 'Scheduled',
  'toolScheduleCron.cancelled': 'Cancelled',
  'toolScheduleCron.noJobs': 'No scheduled jobs',

  // Tool Brief
  'toolBrief.image': '[image]',
  'toolBrief.file': '[file]',

  // Tool Remote Trigger
  'toolRemoteTrigger.lines': 'lines',

  // Tool Team Create
  'toolTeamCreate.createTeam': 'create team:',

  // Tool Team Delete
  'toolTeamDelete.cleanupTeam': 'cleanup team:',

  // Tool Send Message
  'toolSendMessage.approvePlan': 'approve plan from: {from}',
  'toolSendMessage.rejectPlan': 'reject plan from: {from}',

  'commands.session': 'Show remote session URL and QR code',
  'commands.skills': 'List available skills',
  'commands.simplify':
    'Review changed code for reuse, quality, and efficiency, then fix any issues found.',
  'commands.stats': 'Show your ZY Code usage statistics and activity',
  'commands.status':
    'Show ZY Code status including version, model, account, API connectivity, and tool statuses',
  'commands.statusline': 'Toggle the built-in status bar at the bottom of the screen',
  'commands.stickers': 'Order ZY Code stickers',
  'commands.tag': 'Toggle a searchable tag on the current session',
  'commands.theme': 'Change the theme',
  'commands.feedback': 'Submit feedback about ZY Code',
  'commands.review': 'Review a pull request',
  'commands.ultrareview': 'Finds and verifies bugs in your branch. Runs in ZY Code on the web.',
  'commands.rewind': 'Restore the code and/or conversation to a previous point',
  'commands.securityReview':
    'Complete a security review of the pending changes on the current branch',
  'commands.terminalSetup': 'Set up key bindings for newlines in your terminal',
  'commands.upgrade': 'Upgrade to Max for higher rate limits and more Opus',
  'commands.rateLimitOptions': 'Show options when rate limit is reached',
  'commands.usage': 'Show plan usage limits',
  'commands.insights': 'Generate a report analyzing your ZY Code sessions',
  'commands.vim': 'Toggle between Vim and Normal editing modes',
  'commands.thinkback': 'Your 2025 ZY Code Year in Review',
  'commands.thinkbackPlay': 'Play the thinkback animation',
  'commands.permissions': 'Manage allow & deny tool permission rules',
  'commands.plan': 'Enable plan mode or view the current session plan',
  'commands.hooks': 'View hook configurations for tool events',
  'commands.export': 'Export the current conversation to a file or clipboard',
  'commands.sandbox': 'Configure code execution sandbox',
  'commands.logout': 'Sign out from your account',
  'commands.login': 'Sign in with your account',
  'commands.batch':
    'Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree agents that each open a PR.',
  'commands.batch.whenToUse':
    'Use when the user wants to make a sweeping, mechanical change across many files (migrations, refactors, bulk renames) that can be decomposed into independent parallel units.',
  'commands.batch.notAGitRepo':
    'This is not a git repository. The `/batch` command requires a git repo because it spawns agents in isolated git worktrees and creates PRs from each. Initialize a repo first, or run this from inside an existing one.',
  'commands.batch.missingInstruction':
    'Provide an instruction describing the batch change you want to make.\n\nExamples:\n  /batch migrate from react to vue\n  /batch replace all uses of lodash with native equivalents\n  /batch add type annotations to all untyped function parameters',
  'commands.tasks': 'List and manage background tasks',
  'commands.commit': 'Create a git commit',
  'commands.commitPushPr': 'Commit, push, and open a PR',
  'commands.initVerifiers': 'Create verifier skill(s) for automated verification of code changes',
  'commands.version': 'Print the version this session is running',
  'commands.bridgeKick': 'Inject bridge failure states for debugging',
  'commands.heapdump': 'Dump the JS heap to ~/Desktop',
  'commands.remoteSetup': 'Configure remote environment setup',
  'commands.updateConfig':
    'Configure the ZY Code harness via settings.json. Set up automated behaviors with hooks, manage permissions, env vars, plugins, and MCP servers.',
  'commands.keybindingsHelp':
    'Customize keyboard shortcuts, rebind keys, add chord bindings, or modify ~/.zy/keybindings.json.',
  'commands.claudeInChrome':
    'Automates your Chrome browser to interact with web pages — clicking, filling forms, screenshots, and more.',
  'commands.claudeInChrome.whenToUse':
    'When the user wants to interact with web pages, automate browser tasks, or perform browser-based actions.',
  'commands.zyApi':
    'Build apps with the Zy API or Anthropic SDK. Trigger when code imports anthropic SDK or user asks about Zy API.',
  'commands.debug': 'Enable debug logging for this session and help diagnose issues.',
  'commands.schedule':
    'Create, update, list, or run scheduled remote agents that execute on a cron schedule.',
  'commands.schedule.whenToUse':
    'When the user wants to schedule a recurring remote agent, set up automated tasks, or manage scheduled agents.',
  'commands.schedule.authRequired':
    'You need to authenticate with a zy.ai account first. API accounts are not supported. Run /login, then try /schedule again.',
  'commands.schedule.connectionError':
    "We're having trouble connecting with your remote zy.ai account to set up a scheduled task. Please try /schedule again in a few minutes.",
  'commands.schedule.noEnvironments':
    'No remote environments found, and we could not create one automatically. Visit https://zy.ai/code to set one up, then run /schedule again.',
  'commands.schedule.noConnectors':
    'No connected MCP connectors found. The user may need to connect servers at https://zy.ai/settings/connectors',
  'commands.loop':
    'Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo, defaults to 10m).',
  'commands.loop.whenToUse':
    'When the user wants to set up a recurring task, poll for status, or run something repeatedly on an interval.',
  'commands.source.bundled': 'bundled',
  'commands.source.workflow': 'workflow',
  'commands.source.plugin': 'plugin',
  'planMode.noPlanFound': 'No plan found. Please write your plan to the plan file first.',

  // File tool error messages
  'fileEdit.mustReadFirst': 'File must be read first',
  'fileWrite.planToPreview': '/plan to preview',
  'fileWrite.planToEdit': '/plan to edit',
  'fileWrite.wrote': 'Wrote',
  'fileWrite.linesTo': 'lines to',
  'grep.fileNotFound': 'File not found',
  'grep.errorSearching': 'Error searching files',
  'glob.fileNotFound': 'File not found',
  'glob.errorSearching': 'Error searching files',

  // Grep tool labels
  'grep.found': 'Found',
  'grep.across': 'across',
  'grep.lines_one': 'line',
  'grep.lines_other': 'lines',
  'grep.matches_one': 'match',
  'grep.matches_other': 'matches',
  'grep.files_one': 'file',
  'grep.files_other': 'files',

  // Glob tool labels
  'glob.search': 'Search',

  // Skill tool messages
  'skill.initializing': 'Initializing…',
  'skill.done': 'Done',
  'skill.successfullyLoaded': 'Successfully loaded skill',
  'skill.toolAllowed': '{count} {unit} allowed',
  'skill.toolAllowed_one': 'tool',
  'skill.toolAllowed_other': 'tools',
  'skill.moreToolUse': '+{count} more tool {unit}',
  'skill.moreToolUse_one': 'use',
  'skill.moreToolUse_other': 'uses',

  // MCP tool messages
  'mcp.processing': 'Processing… {progress}',
  'mcp.sentMessageTo': 'Sent a message to',
  'mcp.image': '[Image]',
  'mcp.noContent': '(No content)',
  'mcp.largeResponseWarning':
    '{warning} Large MCP response (~{tokens} tokens), this can fill up context quickly',

  // Read MCP resource messages
  'readMcpResource.readFromServer': 'Read resource "{uri}" from server "{server}"',
  'readMcpResource.noContent': '(No content)',

  // List MCP resources messages
  'listMcpResources.listFromServer': 'List MCP resources from server "{server}"',
  'listMcpResources.listAll': 'List all MCP resources',
  'listMcpResources.noResourcesFound': '(No resources found)',

  // Web fetch tool messages
  'webFetch.fetching': 'Fetching…',
  'webFetch.received': 'Received',
  'webFetch.domainBlocked': 'ZY Code is unable to fetch from {domain}',
  'webFetch.domainCheckFailed':
    'Unable to verify if domain {domain} is safe to fetch. This may be due to network restrictions or enterprise security policies blocking zy.ai.',
  'webFetch.egressBlocked': 'Access to {domain} is blocked by the network egress proxy.',
  'webFetch.tooManyRedirects': 'Too many redirects (exceeded {maxRedirects})',
  'webFetch.redirectMissingLocation': 'Redirect missing Location header',
  'webFetch.invalidUrl': 'Invalid URL',
  'webFetch.noResponseFromModel': 'No response from model',

  // Web search tool messages
  'webSearch.searching': 'Searching:',
  'webSearch.found': 'Found',
  'webSearch.resultsFor': 'results for',
  'webSearch.did': 'Did',
  'webSearch.search': '{count} {unit} found in {time}',
  'webSearch.search_one': 'result',
  'webSearch.search_other': 'results',
  'webSearch.seconds': '{count}s',
  'webSearch.milliseconds': '{count}ms',
  'webSearch.completed_search': 'Completed search',

  // Exit plan mode messages
  'exitPlanMode.exitedPlanMode': 'Exited plan mode',
  'exitPlanMode.planSubmitted': 'Plan submitted for team lead approval',
  'exitPlanMode.planFile': 'Plan file: {path}',
  'exitPlanMode.waitingForApproval': 'Waiting for team lead to review and approve...',
  'exitPlanMode.userApprovedPlan': "User approved ZY's plan",
  'exitPlanMode.planSavedTo': 'Plan saved to: {path} · /plan to edit',

  // Exit worktree messages
  'exitWorktree.exiting': 'Exiting worktree…',
  'exitWorktree.keptWorktree': 'Kept worktree',
  'exitWorktree.removedWorktree': 'Removed worktree',
  'exitWorktree.branch': 'branch',
  'exitWorktree.returnedTo': 'Returned to',

  // Task stop messages
  'taskStop.stopped': 'stopped',

  // Notebook edit messages
  'notebook.errorEditing': 'Error editing notebook',

  // PowerShell tool messages
  'powershell.imageDetected': '[Image data detected and sent to ZY]',
  'powershell.runningInBackground': 'Running in the background',
  'powershell.manage': 'manage',
  'powershell.interrupted': 'Interrupted',
  'powershell.noOutput': '(No output)',

  // LSP tool messages
  'lsp.operationFailed': 'LSP operation failed',
  'lsp.search': 'LSP',
  'lsp.found': 'Found',
  'lsp.across': 'across',
  'lsp.hoverAvailable': 'Hover info available',
  'lsp.files': 'files',
  'lsp.result_one': 'result',
  'lsp.result_other': 'results',

  // File edit tool message
  'fileEdit.addedLine': 'Added {count} line',
  'fileEdit.addedLines': 'Added {count} lines',
  'fileEdit.removedLine': 'Removed {count} line',
  'fileEdit.removedLines': 'removed {count} lines',
  'fileEdit.removedLineOnly': 'Removed {count} line',
  'fileEdit.removedLinesOnly': 'Removed {count} lines',
  'fileEdit.update': 'Update',
  'fileEdit.create': 'Create',

  // Cost tracker summary
  'costTracker.totalCost': 'Total cost',
  'costTracker.totalDurationApi': 'Total duration (API)',
  'costTracker.totalDurationWall': 'Total duration (wall)',
  'costTracker.totalCodeChanges': 'Total code changes',
  'costTracker.lineAdded': '{count} line added',
  'costTracker.linesAdded': '{count} lines added',
  'costTracker.lineRemoved': '{count} line removed',
  'costTracker.linesRemoved': '{count} lines removed',
  'costTracker.costsMayBeInaccurate': '(costs may be inaccurate due to usage of unknown models)',

  // Files API
  'filesApi.download.fileNotFound': 'File not found: {fileId}',
  'filesApi.download.authFailed': 'Authentication failed: invalid or missing API key',
  'filesApi.download.accessDenied': 'Access denied to file: {fileId}',
  'filesApi.list.authFailed': 'Authentication failed: invalid or missing API key',
  'filesApi.list.accessDenied': 'Access denied to list files',
  'filesApi.upload.authFailed': 'Authentication failed: invalid or missing API key',
  'filesApi.upload.accessDenied': 'Access denied for upload',
  'filesApi.upload.fileTooLarge': 'File too large for upload',
  'filesApi.upload.canceled': 'Upload canceled',
  'filesApi.upload.noFileId': 'Upload succeeded but no file ID returned',
  'filesApi.upload.exceedsMaxSize':
    'File exceeds maximum size of {maxBytes} bytes (actual: {actualBytes})',
  'filesApi.retry.exhausted': '{lastError} after {maxRetries} attempts',
  'filesApi.path.invalid':
    'Invalid file path: {relativePath}. Path must not traverse above workspace',
  'filesApi.spec.invalid': 'Invalid file spec: {spec}. Both file_id and path are required',

  // Error utils
  'errorUtils.ssl.hint':
    'SSL certificate error ({code}). If you are behind a corporate proxy or TLS-intercepting firewall, set NODE_EXTRA_CA_CERTS to your CA bundle path, or ask IT to allowlist *.zy.ai. Run /doctor for details.',
  'errorUtils.ssl.certVerificationFailed':
    'Unable to connect to API: SSL certificate verification failed. Check your proxy or corporate SSL certificates',
  'errorUtils.ssl.certExpired': 'Unable to connect to API: SSL certificate has expired',
  'errorUtils.ssl.certRevoked': 'Unable to connect to API: SSL certificate has been revoked',
  'errorUtils.ssl.selfSigned':
    'Unable to connect to API: Self-signed certificate detected. Check your proxy or corporate SSL certificates',
  'errorUtils.ssl.hostnameMismatch': 'Unable to connect to API: SSL certificate hostname mismatch',
  'errorUtils.ssl.certNotYetValid': 'Unable to connect to API: SSL certificate is not yet valid',
  'errorUtils.ssl.genericError': 'Unable to connect to API: SSL error ({code})',
  'errorUtils.connection.timeout':
    'Request timed out. Check your internet connection and proxy settings',
  'errorUtils.connection.failed': 'Unable to connect to API. Check your internet connection',
  'errorUtils.connection.withCode': 'Unable to connect to API ({code})',
  'errorUtils.api.errorWithStatus': 'API error (status {status})',

  // Setup
  'setup.errorNodeVersion': 'Error: ZY Code requires Node.js version 18 or higher.',
  'setup.iTerm2Restored':
    'Detected an interrupted iTerm2 setup. Your original settings have been restored. You can re-run /terminal-setup at any time to enable Option+Enter.',
  'setup.iTerm2RestoreFailed':
    'Failed to restore iTerm2 settings. Please manually restore from backup at: {backupPath}',
  'setup.terminalRestored':
    'Detected an interrupted Terminal.app setup. Your original settings have been restored. You can re-run /terminal-setup at any time to enable Option+Enter.',
  'setup.terminalRestoreFailed':
    'Failed to restore Terminal.app settings. Please manually restore from backup at: {backupPath}',
  'setup.errorWorktreeNotGitRepo':
    'Error: Can only use --worktree in a git repository. Current directory ({cwd}) is not a git repo.',
  'setup.errorCannotDetermineGitRoot': 'Error: Could not determine the main git repository root.',
  'setup.errorCreatingWorktree': 'Error creating worktree: {error}',
  'setup.tmuxSessionCreated': 'Created tmux session: {sessionName}. Attach with: {attachCmd}',
  'setup.tmuxSessionCreateFailed': 'Warning: Failed to create tmux session: {error}',
  'setup.errorRootSudoNotAllowed':
    '--dangerously-skip-permissions cannot be used with root/sudo. Run as a regular user instead.',
  'setup.errorNotSandboxed':
    '--dangerously-skip-permissions can only be used in Docker/sandbox environments (isDocker={isDocker}, isBubblewrap={isBubblewrap}, isSandbox={isSandbox}, hasInternet={hasInternet})',

  // Cost tracker
  'costTracker.usageEmpty': 'Usage: 0 input, 0 output (cost tracking not yet available)',
  'costTracker.usageByModel': 'Usage by model:',
  'costTracker.input': 'input',
  'costTracker.output': 'output',
  'costTracker.cacheRead': 'cache read',
  'costTracker.cacheWrite': 'cache write',
  'costTracker.webSearch': 'web search',
  'plugins.common.invalidVersion': 'Version must be one of: {valid}',
  'plugins.common.invalidScope': 'Invalid scope "{scope}". Valid scopes: {valid}',
  'plugins.disable.allWithPlugin': 'Cannot use --all with a specific plugin',
  'plugins.disable.specifyPlugin':
    'Please specify a plugin name or use --all to disable all plugins',
  'plugins.disable.scopeWithAll': 'Cannot use --scope with --all',

  // Background tasks list dialog
  'backgroundTasks.title': 'Background Tasks',
  'backgroundTasks.noTasks': 'No running tasks',
  'backgroundTasks.dismissed': 'Background tasks dialog dismissed',
  'backgroundTasks.agents': 'Agents',
  'backgroundTasks.shells': 'Shells',
  'backgroundTasks.monitors': 'Monitors',
  'backgroundTasks.remoteAgents': 'Remote Agents',
  'backgroundTasks.localAgents': 'Local Agents',
  'backgroundTasks.workflows': 'Workflows',
  'backgroundTasks.team': 'Team',
  'backgroundTasks.activeShells': 'Active Shells',
  'backgroundTasks.activeAgents': 'Active Agents',
  'backgroundTasks.activeShell': 'Active Shell',
  'backgroundTasks.activeAgent': 'Active Agent',
  'backgroundTasks.agent': 'agent(s)',
  'backgroundTasks.agentSingular': 'agent',
  'backgroundTasks.pressAgainToExit': 'Press {key} again to exit',
  'backgroundTasks.action.select': 'Select',
  'backgroundTasks.action.view': 'View',
  'backgroundTasks.action.foreground': 'Foreground',
  'backgroundTasks.action.stop': 'Stop',
  'backgroundTasks.action.stopAll': 'Stop all agents',
  'backgroundTasks.action.close': 'Close',

  // Background tasks detail dialogs
  'backgroundTasks.monitorDetails': 'Monitor details',
  'backgroundTasks.shellDetails': 'Shell details',
  'backgroundTasks.status': 'Status',
  'backgroundTasks.runtime': 'Runtime',
  'backgroundTasks.script': 'Script',
  'backgroundTasks.command': 'Command',
  'backgroundTasks.output': 'Output',
  'backgroundTasks.loadingOutput': 'Loading output…',
  'backgroundTasks.noOutputAvailable': 'No output available',
  'backgroundTasks.showingLines': 'Showing {count} lines',
  'backgroundTasks.ofFileSize': ' of {size}',
  'backgroundTasks.memoryConsolidation': 'Memory consolidation',
  'backgroundTasks.running': 'running',
  'backgroundTasks.starting': 'Starting…',
  'backgroundTasks.noTextOutput': '(no text output)',
  'backgroundTasks.earlierTurns_one': 'earlier turn',
  'backgroundTasks.earlierTurns_other': 'earlier turns',
  'backgroundTasks.reviewing': 'reviewing {count} {unit}',
  'backgroundTasks.touched': 'touched',
  'backgroundTasks.asyncAgent': 'Async agent',
  'backgroundTasks.completed': 'Completed',
  'backgroundTasks.failed': 'Failed',
  'backgroundTasks.stopped': 'Stopped',
  'backgroundTasks.progress': 'Progress',
  'backgroundTasks.prompt': 'Prompt',
  'backgroundTasks.error': 'Error',
  'backgroundTasks.toolSingular': 'tool',
  'backgroundTasks.toolPlural': 'tools',
  'backgroundTasks.reviewPlanOnWeb': 'Review the plan in ZY Code on the web',
  'backgroundTasks.answerInBrowser': 'Answer in browser',
  'backgroundTasks.inputRequired': 'input required',
  'backgroundTasks.ready': 'ready',
  'backgroundTasks.waiting': 'waiting',
  'backgroundTasks.done': 'Done',
  'backgroundTasks.stageFind': 'Find',
  'backgroundTasks.stageVerify': 'Verify',
  'backgroundTasks.stageDedupe': 'Dedupe',
  'backgroundTasks.stageSetup': 'Setup',
  'backgroundTasks.settingUp': 'setting up',
  'backgroundTasks.stopUltraplan': 'Stop ultraplan?',
  'backgroundTasks.stopUltraplanConfirm': 'This will terminate the ZY Code on the web session.',
  'backgroundTasks.terminateSession': 'Terminate session',
  'backgroundTasks.back': 'Back',
  'backgroundTasks.working': 'working',
  'backgroundTasks.reviewOnWeb': 'Review in ZY Code on the web',
  'backgroundTasks.stopUltraplanLabel': 'Stop ultraplan',
  'backgroundTasks.stopUltrareview': 'Stop ultrareview?',
  'backgroundTasks.stopUltrareviewConfirm':
    'This archives the remote session and stops local tracking. The review will not complete and any findings so far are discarded.',
  'backgroundTasks.stopUltrareviewLabel': 'Stop ultrareview',
  'backgroundTasks.openOnWeb': 'Open in ZY Code on the web',
  'backgroundTasks.dismiss': 'Dismiss',
  'backgroundTasks.remoteSessionDetails': 'Remote session details',
  'backgroundTasks.titleLabel': 'Title',
  'backgroundTasks.sessionUrl': 'Session URL',
  'backgroundTasks.recentMessages': 'Recent messages',
  'backgroundTasks.showingLastMessages': 'Showing last {shown} of {total} messages',
  'backgroundTasks.teleportFailed': 'Teleport failed: {error}',
  'backgroundTasks.teleporting': 'Teleporting to session…',
  'backgroundTasks.unread': ', unread',

  // Thinking toggle
  'thinkingToggle.title': 'Toggle thinking mode',
  'thinkingToggle.hint': 'Enable or disable thinking for this session.',
  'thinkingToggle.enabled': 'Enabled',
  'thinkingToggle.enabledDesc': 'Zy will think before responding',
  'thinkingToggle.disabled': 'Disabled',
  'thinkingToggle.disabledDesc': 'Zy will respond without extended thinking',
  'thinkingToggle.midConversationWarning':
    'Changing thinking mode mid-conversation will increase latency and may reduce quality. For best results, set this at the start of a session.',
  'thinkingToggle.confirmProceed': 'Do you want to proceed?',
  'thinkingToggle.pressAgainToExit': 'Press {key} again to exit',

  // Notifications
  'notif.pluginUpdatedSingular': 'Plugin updated: {names}',
  'notif.pluginUpdatedPlural': 'Plugins updated: {names}',
  'notif.reloadPlugins': ' · Run /reload-plugins to apply',
  'notif.mcpServerFailed': '{count} MCP server failed',
  'notif.mcpServersFailed': '{count} MCP servers failed',
  'notif.zyaiConnectorUnavailable': '{count} zy.ai connector unavailable',
  'notif.zyaiConnectorsUnavailable': '{count} zy.ai connectors unavailable',
  'notif.mcpServerNeedsAuth': '{count} MCP server needs auth',
  'notif.mcpServersNeedAuth': '{count} MCP servers need auth',
  'notif.zyaiConnectorNeedsAuth': '{count} zy.ai connector needs auth',
  'notif.zyaiConnectorsNeedAuth': '{count} zy.ai connectors need auth',
  'notif.chromeNotDetected': 'Chrome extension not detected · https://zy.ai/chrome to install',
  'notif.chromeEnabled': 'Claude in Chrome enabled · /chrome',
  'notif.npmDeprecation':
    'ZY Code has switched from npm to native installer. Run `zy install` for more options.',
  'notif.deniedByAutoMode': '{tool} denied by auto mode',
  'notif.remoteControlFailed': 'Remote Control failed',

  // Output style picker
  'outputStyle.title': 'Preferred output style',
  'outputStyle.hint': 'This changes how ZY Code communicates with you',
  'outputStyle.loading': 'Loading output styles…',

  // Auto mode opt-in dialog
  'autoMode.title': 'Enable auto mode?',

  // API key approval
  'apiKey.detectedTitle': 'Detected an API key in your environment',
  'apiKey.useThisKey': 'Do you want to use this API key?',

  // IDE auto-connect dialogs
  'ide.autoConnectTitle': 'Do you wish to enable auto-connect to IDE?',
  'ide.autoConnectHint': 'You can also configure this in /config or with the --ide flag',
  'ide.disableAutoConnectTitle': 'Do you wish to disable auto-connect to IDE?',
  'ide.disableAutoConnectHint': 'You can also configure this in /config',

  // IDE command
  'ide.selectTitle': 'Select IDE',
  'ide.selectSubtitle': 'Connect to an IDE for integrated development features.',
  'ide.none': 'None',
  'ide.vscodeSingleInstance':
    'Note: Only one ZY Code instance can be connected to VS Code at a time.',
  'ide.autoConnectTip': 'Tip: You can enable auto-connect to IDE in /config or with the --ide flag',
  'ide.noAvailable':
    'No available IDEs detected. Make sure your IDE has the ZY Code extension or plugin installed and is running.',
  'ide.noAvailableJetBrains':
    'No available IDEs detected. Please install the plugin and restart your IDE:\nhttps://docs.zy.com/s/zy-code-jetbrains',
  'ide.unavailableCount':
    'Found {count} other running IDE(s). However, their workspace/project directories do not match the current cwd.',
  'ide.selectToOpen': 'Select an IDE to open the project',
  'ide.selectToInstall': 'Select IDE to install extension',
  'ide.noIdeDetected': 'No IDEs with ZY Code extension detected.',
  'ide.noIdeSelected': 'No IDE selected.',
  'ide.selectionCancelled': 'IDE selection cancelled',
  'ide.openedIn': 'Opened {location} in {name}',
  'ide.openFailed': 'Failed to open in {name}. Try opening manually: {path}',
  'ide.openManually': 'Please open the {location} manually in {name}: {path}',
  'ide.exitedWithoutOpening': 'Exited without opening IDE',
  'ide.connected': 'Connected to {name}.',
  'ide.connectFailed': 'Failed to connect to {name}.',
  'ide.connectionTimeout': 'Connection to {name} timed out.',
  'ide.errorConnecting': 'Error connecting to IDE.',
  'ide.disconnected': 'Disconnected from {name}.',
  'ide.connecting': 'Connecting to {name}…',
  'ide.worktree': 'worktree',
  'ide.project': 'project',
  'ide.installedPlugin':
    'Installed plugin to {name}\nPlease **restart your IDE** completely for it to take effect',
  'ide.installedExtension': 'Installed extension to {name}',

  // Channel downgrade dialog
  'channel.downgradeTitle': 'Switch to Stable Channel',
  'channel.downgradeDescription':
    "The stable channel may have an older version than what you're currently running ({currentVersion}).",
  'channel.howToHandle': 'How would you like to handle this?',
  'channel.allowDowngrade': 'Allow possible downgrade to stable version',
  'channel.stayOnCurrent': 'Stay on current version ({currentVersion}) until stable catches up',

  // Export dialog
  'export.title': 'Export Conversation',
  'export.subtitle': 'Select export method:',
  'export.copyToClipboard': 'Copy to clipboard',
  'export.copyToClipboardDesc': 'Copy the conversation to your system clipboard',
  'export.saveToFile': 'Save to file',
  'export.saveToFileDesc': 'Save the conversation to a file in the current directory',
  'export.enterFilename': 'Enter filename:',
  'export.successClipboard': 'Conversation copied to clipboard',
  'export.successFile': 'Conversation exported to: {filepath}',
  'export.failedFile': 'Failed to export conversation: {error}',
  'export.cancelled': 'Export cancelled',
  'export.goBack': 'go back',
  'export.cancelAction': 'cancel',
  'export.save': 'save',
  'export.pressAgainToExit': 'Press {key} again to exit',

  // Fullscreen layout pill
  'fullscreen.newMessages': '{count} new {unit}',
  'fullscreen.newMessageUnit_one': 'message',
  'fullscreen.newMessageUnit_other': 'messages',
  'fullscreen.jumpToBottom': 'Jump to bottom',

  // Status line
  'status.cwd': 'Working directory',
  'statusLine.enabled': 'Status bar enabled',
  'statusLine.disabled': 'Status bar disabled',

  // Exit flow goodbye messages
  'exitFlow.goodbye': 'Goodbye!',
  'exitFlow.seeYa': 'See ya!',
  'exitFlow.bye': 'Bye!',
  'exitFlow.catchYouLater': 'Catch you later!',

  // Feedback / Bug report dialog
  'feedback.title': 'Submit Feedback / Bug Report',
  'feedback.describeIssue': 'Describe the issue below:',
  'feedback.editAndRetry': 'Edit and press Enter to retry, or Esc to cancel',
  'feedback.reportIncludes': 'This report will include:',
  'feedback.reportDescription': '- Your feedback / bug description: ',
  'feedback.reportEnvironment': '- Environment info: ',
  'feedback.reportGit': '- Git repo metadata: ',
  'feedback.reportTranscript': '- Current session transcript',
  'feedback.reportUsage':
    "We will use your feedback to debug related issues or to improve ZY Code's functionality (eg. to reduce the risk of bugs occurring in the future).",
  'feedback.pressEnterToSubmit': 'Press Enter to confirm and submit.',
  'feedback.submitting': 'Submitting report…',
  'feedback.thankYou': 'Thank you for your report!',
  'feedback.feedbackId': 'Feedback ID: {feedbackId}',
  'feedback.openGitHubOrClose':
    'Press Enter to open your browser and draft a GitHub issue, or any other key to close.',
  'feedback.errorZdrOrg':
    'Feedback collection is not available for organizations with custom data retention policies.',
  'feedback.errorGeneric': 'Could not submit feedback. Please try again later.',
  'feedback.submitted': 'Feedback / bug report submitted',
  'feedback.errorSubmitting': 'Error submitting feedback / bug report',
  'feedback.cancelled': 'Feedback / bug report cancelled',
  'feedback.cancelledShort': 'Feedback cancelled',
  'feedback.continueAction': 'continue',
  'feedback.submitAction': 'submit',
  'feedback.cancelAction': 'cancel',

  // Permission rules UI
  'permissionRules.addDirectoryToWorkspace': 'Add directory to workspace',
  'permissionRules.yesForThisSession': 'Yes, for this session',
  'permissionRules.yesAndRememberDirectory': 'Yes, and remember this directory',
  'permissionRules.workspacePermissionDescription':
    'ZY Code will be able to read files in this directory and make edits when auto-accept edits is on.',
  'permissionRules.enterDirectoryPath': 'Enter the path to the directory:',
  'permissionRules.directoryPathPlaceholder': 'Directory path…',
  'permissionRules.removeDirectoryFromWorkspace': 'Remove directory from workspace?',
  'permissionRules.directoryRemovedWarning':
    'ZY Code will no longer have access to files in this directory.',
  'permissionRules.fromSource': 'From {source}',
  'permissionRules.ruleDetails': 'Rule details',
  'permissionRules.managedByPolicy':
    'This rule is configured by managed settings and cannot be modified.\nContact your system administrator for more information.',
  'permissionRules.allowedToolsSubtitle': "ZY Code won't ask before using allowed tools.",
  'permissionRules.askToolsSubtitle':
    'ZY Code will always ask for confirmation before using these tools.',
  'permissionRules.deniedToolsSubtitle': 'ZY Code will always reject requests to use denied tools.',
  'permissionRules.addNewRule': 'Add a new rule…',
  'permissionRules.recentlyDenied': 'Recently denied',
  'permissionRules.allowTab': 'Allow',
  'permissionRules.askTab': 'Ask',
  'permissionRules.denyTab': 'Deny',
  'permissionRules.workspaceTab': 'Workspace',
  'permissionRules.workspaceDescription':
    'ZY Code can read files in the workspace, and make edits when auto-accept edits is on.',
  'permissionRules.originalWorkingDirectory': 'Original working directory',
  'permissionRules.addDirectoryEllipsis': 'Add directory…',
  'permissionRules.workspaceDialogDismissed': 'Workspace dialog dismissed',
  'permissionRules.pressAgainToExit': 'Press {keyName} again to exit',
  'permissionRules.escToCancel': 'Esc to cancel',
  'permissionRules.enterSubmitEscCancel': 'Enter to submit · Esc to cancel',
  'permissionRules.projectSettingsLocal': 'Project settings (local)',
  'permissionRules.projectSettings': 'Project settings',
  'permissionRules.userSettings': 'User settings',
  'permissionRules.savedIn': 'Saved in {path}',
  'permissionRules.checkedInAt': 'Checked in at {path}',
  'permissionRules.savedInAtUser': 'Saved in at ~/.zy/settings.json',
  'permissionRules.addPermissionRuleTitle': 'Add {behavior} permission {ruleCount}',
  'permissionRules.whereSaveSingleRule': 'Where should this rule be saved?',
  'permissionRules.whereSaveMultipleRules': 'Where should these rules be saved?',
  'permissionRules.addPermissionRuleHeader': 'Add {behavior} permission rule',
  'permissionRules.permissionRulesDescription':
    'Permission rules are a tool name, optionally followed by a specifier in parentheses.',
  'permissionRules.enterPermissionRulePlaceholder': 'Enter permission rule…',
  'permissionRules.toolUse': 'Tool use',
  'permissionRules.networkRequestOutsideSandbox': 'Network request outside of sandbox',
  'permissionRules.hostLabel': 'Host:',
  'permissionRules.reviewYourAnswers': 'Review your answers',
  'permissionRules.notAnsweredAllQuestions': 'You have not answered all questions',
  'permissionRules.questionLabel': 'Question',
  'permissionRules.readyToSubmitAnswers': 'Ready to submit your answers?',
  'permissionRules.submitAnswers': 'Submit answers',
  'permissionRules.cancel': 'Cancel',
  'permissionRules.noPreviewAvailable': 'No preview available',
  'permissionRules.notesLabel': 'Notes:',
  'permissionRules.addNotesPlaceholder': 'Add notes on this design…',
  'permissionRules.pressNToAddNotes': 'press n to add notes',
  'permissionRules.chatAboutThis': 'Chat about this',
  'permissionRules.skipInterviewAndPlan': 'Skip interview and plan immediately',
  'permissionRules.enterToSelect': 'Enter to select',
  'permissionRules.arrowToNavigate': 'to navigate',
  'permissionRules.nToAddNotes': 'n to add notes',
  'permissionRules.tabToSwitchQuestions': 'Tab to switch questions',
  'permissionRules.ctrlGToEditIn': 'ctrl+g to edit in {editorName}',
  'permissionRules.escToCancelHint': 'Esc to cancel',
  'permissionRules.noRecentDenials':
    'No recent denials. Commands denied by the auto mode classifier will appear here.',
  'permissionRules.retrySuffix': ' (retry)',
  'permissionRules.recentlyDeniedDescription':
    'Commands recently denied by the auto mode classifier.',

  // Computer Use Approval
  'computerUse.needsMacOSPermissions': 'Computer Use needs macOS permissions',
  'computerUse.openSystemSettingsAccessibility': 'Open System Settings → Accessibility',
  'computerUse.openSystemSettingsScreenRecording': 'Open System Settings → Screen Recording',
  'computerUse.tryAgain': 'Try again',
  'computerUse.accessibilityLabel': 'Accessibility:',
  'computerUse.screenRecordingLabel': 'Screen Recording:',
  'computerUse.granted': 'granted',
  'computerUse.notGranted': 'not granted',
  'computerUse.grantMissingPermissions':
    'Grant the missing permissions in System Settings, then select "Try again". macOS may require you to restart ZY Code after granting Screen Recording.',
  'computerUse.wantsToControlApps': 'Computer Use wants to control these apps',
  'computerUse.equivalentToShellAccess': 'equivalent to shell access',
  'computerUse.canReadWriteAnyFile': 'can read/write any file',
  'computerUse.canChangeSystemSettings': 'can change system settings',
  'computerUse.allowForThisSession': 'Allow for this session ({count} {app})',
  'computerUse.denyAndTellZy': 'Deny, and tell Zy what to do differently (esc)',
  'computerUse.notInstalled': 'not installed',
  'computerUse.alreadyGranted': 'already granted',
  'computerUse.alsoRequested': 'Also requested:',
  'computerUse.otherAppsHidden': '{count} other {app} will be hidden while Zy works.',

  // Permission decision debug info
  'permissionDebug.behavior': 'Behavior',
  'permissionDebug.message': 'Message',
  'permissionDebug.reason': 'Reason',
  'permissionDebug.suggestions': 'Suggestions',
  'permissionDebug.suggestion': 'Suggestion',
  'permissionDebug.none': 'None',
  'permissionDebug.rules': 'Rules',
  'permissionDebug.directories': 'Directories',
  'permissionDebug.mode': 'Mode',
  'permissionDebug.unreachableRules': 'Unreachable Rules ({count})',
  'permissionDebug.requiresBypassSandbox': 'Requires permission to bypass sandbox',
  'permissionDebug.suggestedRules': 'Suggested rules:',
  'permissionDebug.fix': 'Fix: ',

  // MCP reconnect
  'mcp.reconnectingTo': 'Reconnecting to {serverName}',
  'mcp.establishingConnection': 'Establishing connection to MCP server',
  'mcp.failedToReconnect': 'Failed to reconnect to {serverName}',
  'mcp.serverNotFound': 'MCP server "{serverName}" not found',
  'mcp.requiresAuthentication': '{serverName} requires authentication',
  'mcp.requiresAuthenticationHelp':
    '{serverName} requires authentication. Use /mcp to authenticate.',
  'mcp.reconnectError': 'Error: {error}',

  // MCP parsing warnings
  'mcp.configDiagnostics': 'MCP Config Diagnostics',
  'mcp.configDiagnosticsHelp': 'For help configuring MCP servers, see:',
  'mcp.errorLabel': '[Error]',
  'mcp.warningLabel': '[Warning]',
  'mcp.failedToParse': 'Failed to parse',
  'mcp.containsWarnings': 'Contains warnings',
  'mcp.locationLabel': 'Location:',

  // MCP tool detail
  'mcp.failedToLoadDescription': 'Failed to load description',
  'mcp.toolNameLabel': 'Tool name:',
  'mcp.fullNameLabel': 'Full name:',
  'mcp.descriptionLabel': 'Description:',
  'mcp.parametersLabel': 'Parameters:',
  'mcp.required': 'required',
  'mcp.goBack': 'go back',
  'mcp.readOnly': 'read-only',
  'mcp.destructive': 'destructive',
  'mcp.openWorld': 'open-world',

  // MCP remote server menu
  'mcp.serverTitle': '{serverName} MCP Server',
  'mcp.statusLabel': 'Status:',
  'mcp.disabled': 'disabled',
  'mcp.connected': 'connected',
  'mcp.connecting': 'connecting…',
  'mcp.needsAuthentication': 'needs authentication',
  'mcp.failed': 'failed',
  'mcp.authLabel': 'Auth:',
  'mcp.authenticated': 'authenticated',
  'mcp.notAuthenticated': 'not authenticated',
  'mcp.urlLabel': 'URL:',
  'mcp.configLocationLabel': 'Config location:',
  'mcp.toolsLabel': 'Tools:',
  'mcp.toolsCount': '{count} tools',
  'mcp.errorLabelMenu': 'Error:',
  'mcp.enable': 'Enable',
  'mcp.viewTools': 'View tools',
  'mcp.clearAuthentication': 'Clear authentication',
  'mcp.authenticate': 'Authenticate',
  'mcp.reauthenticate': 'Re-authenticate',
  'mcp.reconnect': 'Reconnect',
  'mcp.disable': 'Disable',
  'mcp.back': 'Back',
  'mcp.authenticatingWith': 'Authenticating with {serverName}…',
  'mcp.authViaIdentityProvider': 'Authenticating via your identity provider',
  'mcp.browserWillOpen': 'A browser window will open for authentication',
  'mcp.copyUrlManually': "If your browser doesn't open automatically, copy this URL manually",
  'mcp.copied': 'Copied!',
  'mcp.pasteUrlFromBrowser':
    "If the redirect page shows a connection error, paste the URL from your browser's address bar:",
  'mcp.returnAfterAuth': 'Return here after authenticating in your browser. Press Esc to go back.',
  'mcp.pressEnterAfterAuth': 'Press Enter after authenticating in your browser.',
  'mcp.pressEnterWhenDone': 'Press Enter when done.',
  'mcp.pressEnterToOpenBrowser': 'Press Enter to open the browser.',
  'mcp.clearAuthTitle': 'Clear authentication for {serverName}',
  'mcp.findServerAndDisconnect': 'Find the MCP server in the browser and click "Disconnect".',
  'mcp.willOpenZyAi':
    'This will open zy.ai in the browser. Find the MCP server in the list and click "Disconnect".',
  'mcp.connectingTo': 'Connecting to {serverName}…',
  'mcp.mayTakeAMoment': 'This may take a few moments.',
  'mcp.authSuccessfulReconnected': 'Authentication successful. Reconnected to {serverName}.',
  'mcp.authSuccessfulConnected': 'Authentication successful. Connected to {serverName}.',
  'mcp.authSuccessfulNeedsAuth':
    'Authentication successful, but server still requires authentication. You may need to manually restart ZY Code.',
  'mcp.authSuccessfulReconnectFailed':
    'Authentication successful, but server reconnection failed. You may need to manually restart ZY Code for the changes to take effect.',
  'mcp.authCleared': 'Authentication cleared for {serverName}.',
  'mcp.disconnectedFrom': 'Disconnected from {serverName}.',
  'mcp.failedToToggle': "Failed to {action} MCP server '{serverName}': {error}",

  // MCP List Panel
  'mcp.manageServers': 'Manage MCP Servers',
  'mcp.dialogDismissed': 'MCP settings dialog dismissed',
  'mcp.toolsFor': 'Tools for {serverName}',
  'mcp.noToolsAvailable': 'No tools available',
  'mcp.projectMCPs': 'Project MCPs',
  'mcp.userMCPs': 'User MCPs',
  'mcp.localMCPs': 'Local MCPs',
  'mcp.enterpriseMCPs': 'Enterprise MCPs',
  'mcp.builtInMCPs': 'Built-in MCPs',
  'mcp.alwaysAvailable': 'always available',
  'mcp.agentMCPs': 'Agent MCPs',
  'mcp.agentOnly': 'agent-only',
  'mcp.mayNeedAuth': 'may need auth',
  'mcp.notConnectedAgentOnly': 'Not connected (agent-only)',
  'mcp.reconnectingWithProgress': 'reconnecting ({current}/{max})',
  'mcp.errorLogsInline': 'Run with --debug for error logs',
  'mcp.runDebugForLogs': 'Run with --debug for error logs',
  'mcp.forHelp': 'for help',

  // MCP Stdio Server Menu
  'mcp.commandLabel': 'Command:',
  'mcp.argsLabel': 'Args:',
  'mcp.restartingMCPProcess': 'Restarting MCP process…',

  // MCP Agent Server Menu
  'mcp.agentServerTitle': '{serverName} Agent MCP Server',
  'mcp.agentOnlyConnects': 'This server will only connect when the agent runs.',
  'mcp.mayNeedAuthentication': 'May need authentication',
  'mcp.typeLabel': 'Type:',
  'mcp.usedByLabel': 'Used by:',

  // MCP Capabilities Section
  'mcp.capabilitiesLabel': 'Capabilities:',
  'mcp.capabilitiesNone': 'none',
  'mcp.capabilityTools': 'tools',
  'mcp.capabilityResources': 'resources',
  'mcp.capabilityPrompts': 'prompts',

  // MCP Reconnect
  'mcp.successfullyReconnected': 'Successfully reconnected to {serverName}',
  'mcp.requiresAuthUseMcp': '{serverName} requires authentication. Use /mcp to authenticate.',
  'mcp.failedToReconnectShort': 'Failed to reconnect to {serverName}',
  'mcp.reconnectToFailed': 'Failed to reconnect to {serverName}',
  'mcp.errorGeneric': 'Error: {error}',

  // MCP reconnect helpers
  'mcp.reconnectedTo': 'Reconnected to {serverName}.',
  'mcp.requiresAuthOption': "{serverName} requires authentication. Use the 'Authenticate' option.",
  'mcp.failedToReconnectTo': 'Failed to reconnect to {serverName}.',
  'mcp.unknownReconnectResult': 'Unknown result when reconnecting to {serverName}.',
  'mcp.errorReconnecting': 'Error reconnecting to {serverName}: {error}',

  // MCP Settings
  'mcp.noServersConfigured':
    'No MCP servers configured. Please run /doctor if this is unexpected. Otherwise, run `zy mcp --help` or visit https://code.zy.com/docs/en/mcp to learn more.',

  // Web Browser
  'webBrowser.title': 'Web Browser',
  'webBrowser.urlPlaceholder': 'Enter URL…',
  'webBrowser.open': 'Open',
  'webBrowser.navigate': 'Navigate',
  'webBrowser.back': 'Back',
  'webBrowser.forward': 'Forward',
  'webBrowser.reload': 'Reload',
  'webBrowser.loading': 'Loading…',
  'webBrowser.error': 'Error loading page',

  // Elicitation dialog
  'elicitation.requestsYourInput': 'MCP server "{serverName}" requests your input',
  'elicitation.wantsToOpenUrl': 'MCP server "{serverName}" wants to open a URL',
  'elicitation.waitingForCompletion': 'MCP server "{serverName}" — waiting for completion',
  'elicitation.accept': 'Accept',
  'elicitation.decline': 'Decline',
  'elicitation.reopenUrl': 'Reopen URL',
  'elicitation.cancel': 'Cancel',
  'elicitation.continueWithoutWaiting': 'Continue without waiting',
  'elicitation.waitingForServer': 'Waiting for the server to confirm completion…',
  'elicitation.typeSomething': 'Type something…',
  'elicitation.notSet': 'not set',
  'elicitation.moreAbove': '{count} more above',
  'elicitation.moreBelow': '{count} more below',
  'elicitation.unset': 'unset',
  'elicitation.toggle': 'toggle',
  'elicitation.select': 'select',
  'elicitation.expand': 'expand',
  'elicitation.switch': 'switch',
  'elicitation.fieldRequired': 'This field is required',
  'elicitation.selectAtLeast': 'Select at least {min} {unit}',
  'elicitation.selectAtMost': 'Select at most {max} {unit}',

  // Common (additional for agents)
  'common.goBack': 'go back',
  'common.enterText': 'enter text',
  'common.continue': 'continue',
  'common.openInEditor': 'open in editor',
  'common.toggleSelection': 'toggle selection',
  'common.submit': 'submit',
  'common.save': 'save',
  'common.editInEditor': 'edit in your editor',

  // Agent UI
  'agents.createNewAgent': 'Create new agent',
  'agents.builtInAgents': 'Built-in agents',
  'agents.builtInAgentsDesc': 'Built-in agents are provided by default and cannot be modified.',
  'agents.builtInAlwaysAvailable': '(always available)',
  'agents.noAgentsFound': 'No agents found',
  'agents.noAgentsHelpLine1':
    'No agents found. Create specialized subagents that Zy can delegate to.',
  'agents.noAgentsHelpLine2':
    'Each subagent has its own context window, custom system prompt, and specific tools.',
  'agents.noAgentsTryCreating':
    'Try creating: Code Reviewer, Code Simplifier, Security Reviewer, Tech Lead, or UX Reviewer.',
  'agents.agentsCount': '{count} agents',
  'agents.shadowedBy': 'shadowed by {source}',
  'agents.memoryLabel': '{memory} memory',
  'agents.viewAgent': 'View agent',
  'agents.editAgent': 'Edit agent',
  'agents.deleteAgent': 'Delete agent',
  'agents.back': 'Back',
  'agents.deleteConfirmTitle': 'Delete agent',
  'agents.deleteConfirmQuestion': 'Are you sure you want to delete the agent {name}?',
  'agents.deleteYes': 'Yes, delete',
  'agents.deleteNo': 'No, cancel',
  'agents.pressEnterEscBack': 'Press Enter or Esc to go back',
  'agents.navInstructions': 'Press ↑↓ to navigate, Enter to select, Esc to cancel',
  'agents.editAgentTitle': 'Edit agent: {name}',
  'agents.changes': 'Agent changes:\n{changes}',
  'agents.dialogDismissed': 'Agents dialog dismissed',
  'agents.deletedAgent': 'Deleted agent: {name}',
  'agents.createdAgent': 'Created agent: {name}',
  'agents.createdAgentAndOpened':
    'Created agent: {name} and opened in editor. If you made edits, restart to load the latest version.',
  'agents.updatedAgent': 'Updated agent: {name}',
  'agents.openedInEditor':
    'Opened {name} in editor. If you made edits, restart to load the latest version.',
  'agents.failedToSave': 'Failed to save agent',

  // Agent Editor
  'agents.editor.source': 'Source: {source}',
  'agents.editor.openInEditor': 'Open in editor',
  'agents.editor.editTools': 'Edit tools',
  'agents.editor.editModel': 'Edit model',
  'agents.editor.editColor': 'Edit color',

  // Agent Validation
  'agents.validation.typeRequired': 'Agent type is required',
  'agents.validation.typeFormat':
    'Agent type must start and end with alphanumeric characters and contain only letters, numbers, and hyphens',
  'agents.validation.typeMinLength': 'Agent type must be at least 3 characters long',
  'agents.validation.typeMaxLength': 'Agent type must be less than 50 characters',
  'agents.validation.typeDuplicate': 'Agent type "{name}" already exists in {source}',
  'agents.validation.descriptionRequired': 'Description (description) is required',
  'agents.validation.descriptionTooShort':
    'Description should be more descriptive (at least 10 characters)',
  'agents.validation.descriptionTooLong': 'Description is very long (over 5000 characters)',
  'agents.validation.toolsInvalid': 'Tools must be an array',
  'agents.validation.toolsAllWarning': 'Agent has access to all tools',
  'agents.validation.toolsNoneWarning':
    'No tools selected - agent will have very limited capabilities',
  'agents.validation.toolsInvalidList': 'Invalid tools: {tools}',
  'agents.validation.promptRequired': 'System prompt is required',
  'agents.validation.promptTooShort': 'System prompt is too short (minimum 20 characters)',
  'agents.validation.promptTooLong': 'System prompt is very long (over 10,000 characters)',

  // Tool Selector
  'agents.toolSelector.continue': 'Continue',
  'agents.toolSelector.allTools': 'All tools',
  'agents.toolSelector.readOnlyTools': 'Read-only tools',
  'agents.toolSelector.editTools': 'Edit tools',
  'agents.toolSelector.executionTools': 'Execution tools',
  'agents.toolSelector.mcpTools': 'MCP tools',
  'agents.toolSelector.otherTools': 'Other tools',
  'agents.toolSelector.showAdvanced': 'Show advanced options',
  'agents.toolSelector.hideAdvanced': 'Hide advanced options',
  'agents.toolSelector.mcpServersHeader': 'MCP Servers:',
  'agents.toolSelector.individualToolsHeader': 'Individual Tools:',
  'agents.toolSelector.toolCount_one': 'tool',
  'agents.toolSelector.toolCount_other': 'tools',
  'agents.toolSelector.allSelected': 'All tools selected',
  'agents.toolSelector.selectedCount': '{selected} of {total} tools selected',

  // Wizard
  'wizard.createAgentTitle': 'Create new agent',
  'wizard.creationMethod': 'Creation method',
  'wizard.generateWithZy': 'Generate with Zy (recommended)',
  'wizard.manualConfig': 'Manual configuration',
  'wizard.chooseLocation': 'Choose location',
  'wizard.locationProject': 'Project (.zy/agents/)',
  'wizard.locationPersonal': 'Personal (~/.zy/agents/)',
  'wizard.agentType': 'Agent type (identifier)',
  'wizard.enterIdentifier': 'Enter a unique identifier for your agent:',
  'wizard.agentTypePlaceholder': 'e.g., test-runner, tech-lead, etc',
  'wizard.systemPrompt': 'System prompt',
  'wizard.enterSystemPrompt': 'Enter the system prompt for your agent:',
  'wizard.promptBeComprehensive': 'Be comprehensive for best results',
  'wizard.promptPlaceholder': 'You are a helpful code reviewer who...',
  'wizard.promptRequired': 'System prompt is required',
  'wizard.description': 'Description (tell Zy when to use this agent)',
  'wizard.whenUseAgent': 'When should Zy use this agent?',
  'wizard.descriptionPlaceholder': "e.g., use this agent after you're done writing code...",
  'wizard.descriptionRequired': 'Description is required',
  'wizard.selectTools': 'Select tools',
  'wizard.selectModel': 'Select model',
  'wizard.chooseColor': 'Choose background color',
  'wizard.configureMemory': 'Configure agent memory',
  'wizard.memoryUserScope': 'User scope (~/.zy/agent-memory/) (Recommended)',
  'wizard.memoryUserScopeRec': 'User scope (~/.zy/agent-memory/) (Recommended)',
  'wizard.memoryUserScopePlain': 'User scope (~/.zy/agent-memory/)',
  'wizard.memoryProjectScope': 'Project scope (.zy/agent-memory/) (Recommended)',
  'wizard.memoryProjectScopeRec': 'Project scope (.zy/agent-memory/) (Recommended)',
  'wizard.memoryProjectScopePlain': 'Project scope (.zy/agent-memory/)',
  'wizard.memoryNone': 'None (no persistent memory)',
  'wizard.memoryLocalScope': 'Local scope (.zy/agent-memory-local/)',
  'wizard.confirmAndSave': 'Confirm and save',
  'wizard.pressSaveOrEnter': 'Press s or Enter to save, e to save and edit',
  'wizard.agentName': 'Name',
  'wizard.agentLocation': 'Location',
  'wizard.agentTools': 'Tools',
  'wizard.agentModel': 'Model',
  'wizard.agentMemory': 'Memory',
  'wizard.agentDescription': 'Description (tells Zy when to use this agent):',
  'wizard.agentSystemPrompt': 'System prompt:',
  'wizard.warnings': 'Warnings:',
  'wizard.errors': 'Errors:',
  'wizard.allTools': 'All tools',
  'wizard.none': 'None',
  'wizard.generateSubtitle':
    'Describe what this agent should do and when it should be used (be comprehensive for best results)',
  'wizard.generatingAgent': ' Generating agent from description...',
  'wizard.generationCancelled': 'Generation cancelled',
  'wizard.pleaseDescribe': 'Please describe what the agent should do',
  'wizard.failedToGenerate': 'Failed to generate agent',

  // Prompt input
  'promptInput.stashed': 'Stashed (auto-restores after submit)',
  'promptInput.sandboxBlocked_one':
    'Sandbox blocked {count} operation · {shortcut} for details · /sandbox to disable',
  'promptInput.sandboxBlocked_other':
    'Sandbox blocked {count} operations · {shortcut} for details · /sandbox to disable',
  'promptInput.moreTasksCompleted': '+{count} more tasks completed',
  'promptInput.remoteControlReconnecting': 'Remote Control reconnecting',
  'promptInput.enterToView': ' · Enter to view',
  'promptInput.effortSetHigh': 'Effort set to high for this turn',
  'promptInput.ultraplanLaunch':
    'This prompt will launch an ultraplan session in ZY Code on the web',
  'promptInput.ultrareviewRun':
    'Run /ultrareview after Zy finishes to review these changes in the cloud',
  'promptInput.sentTo': 'Sent to @{recipientName}',
  'promptInput.noImageClipboardSSH': "No image found in clipboard. You're SSH'd; try scp?",
  'promptInput.noImageClipboard': 'No image found in clipboard. Use {shortcut} to paste images.',
  'promptInput.optionMetaHint':
    'To enable {shortcut}, set Option as Meta in {terminalName} preferences (⌘,)',
  'promptInput.optionMetaHintSetup': 'To enable {shortcut}, run /terminal-setup',
  'promptInput.stashTip': 'Tip: {shortcut} to stash',
  'promptInput.editIn': 'edit in {editorName}',
  'promptInput.modelSetTo': 'Model set to {model}',
  'promptInput.billedAsExtra': ' · Billed as extra usage',
  'promptInput.thinkingOn': 'Thinking on',
  'promptInput.thinkingOff': 'Thinking off',
  'promptInput.externalEditorFailed': 'External editor failed: {error}',
  'promptInput.waitingForPermission': 'Waiting for permission…',
  'promptInput.saveAndClose': 'Save and close editor to continue…',

  // Voice mode
  'voice.listening': 'listening…',
  'voice.keepHolding': 'keep holding…',
  'voice.processing': 'Voice: processing…',

  // Logo / Welcome
  'logo.helloReadyToBuild': 'Hello, ready to build?',
  'logo.debugModeEnabled': 'Debug mode enabled',
  'logo.loggingTo': 'Logging to: {path}',
  'logo.stderr': 'stderr',
  'logo.sandboxEnabled': 'Your bash commands will be sandboxed. Disable with /sandbox.',
  'logo.useIssue': 'Use /issue to report model behavior issues',
  'logo.innerOnlyLogs': '[INNER-ONLY] Logs:',
  'logo.apiCalls': 'API calls: {path}',
  'logo.debugLogs': 'Debug logs: {path}',
  'logo.startupPerf': 'Startup Perf: {path}',
  'logo.tmuxSession': 'tmux session: {sessionName}',
  'logo.detachHint': 'Detach: {prefix} d',
  'logo.detachHintDouble': 'Detach: {prefix} {prefix} d (press prefix twice - Zy uses {prefix})',
  'logo.messageFromOrg': 'Message from {orgName}:',
  'logo.apiCallsOnlyPath': '[ANT-ONLY] API calls: {path}',

  // Channels notice
  'channels.ignored': '{flag} ignored ({list})',
  'channels.notAvailable': 'Channels are not currently available',
  'channels.requireAuth': 'Channels require zy.ai authentication · run /login, then restart',
  'channels.blockedByPolicy': '{flag} blocked by org policy ({list})',
  'channels.messagesDropped': 'Inbound messages will be silently dropped',
  'channels.enablePolicy':
    'Have an administrator set channelsEnabled: true in managed settings to enable',
  'channels.listening': 'Listening for channel messages from: {list}',
  'channels.experimental':
    'Experimental · inbound messages will be pushed into this session, this carries prompt injection risks. Restart ZY Code without {flag} to disable.',
  'channels.noMcpServer': 'no MCP server configured with that name',
  'channels.serverNeedsDev': 'server: entries need --dangerously-load-development-channels',
  'channels.pluginNotInstalled': 'plugin not installed',
  'channels.notOnOrgList': "not on your org's approved channels list",
  'channels.notOnAllowlist': 'not on the approved channels allowlist',

  // Voice mode notice
  'voiceMode.available': ' Voice mode is now available · /voice to enable',

  // Model picker
  'modelPicker.selectModel': 'Select model',
  'modelPicker.description':
    'Switch between Zy models. Applies to this session and future ZY Code sessions. For other/previous model names, specify with --model.',
  'modelPicker.currentlyUsing':
    'Currently using {model} for this session (set by plan mode). Selecting a model will undo this.',
  'modelPicker.currentModel': 'Current model',
  'modelPicker.andMore': 'and {count} more…',
  'modelPicker.effortLabel': '{effort} effort',
  'modelPicker.effortDefault': ' (default)',
  'modelPicker.adjustHint': '← → to adjust',
  'modelPicker.effortNotSupported': 'Effort not supported',
  'modelPicker.effortNotSupportedFor': ' for {modelName}',
  'modelPicker.pressAgainToExit': 'Press {key} again to exit',

  // Language picker
  'languagePicker.enterLanguage': 'Enter your preferred response and voice language:',
  'languagePicker.placeholder': 'e.g., Japanese, 日本語, Español{ellipsis}',
  'languagePicker.defaultHint': 'Leave empty for default (English)',

  // 语言自称（endonym），用于 prompt 中展示语言本地化名称，如 "Chinese（中文）"
  'languageName.English': 'English',
  'languageName.Chinese': '中文',
  'languageName.Japanese': '日本語',
  'languageName.Spanish': 'Español',
  'languageName.French': 'Français',
  'languageName.German': 'Deutsch',
  'languageName.Korean': '한국어',

  // Memory usage
  'memory.highUsage': 'High memory usage ({size}) · /heapdump',

  // Effort indicator
  'effort.levelWithShortcut': '{level} · /effort',

  // Teleport
  'teleport.loginTitle': 'Log in to Zy',
  'teleport.requiresAccount': 'Teleport requires a Zy.ai account.',
  'teleport.subscriptionInfo': 'Your Zy Pro/Max subscription will be used by ZY Code.',
  'teleport.loginWithZy': 'Login with Zy account',
  'teleport.exit': 'Exit',
  'teleport.validatingSession': 'Validating session',
  'teleport.fetchingSessionLogs': 'Fetching session logs',
  'teleport.gettingBranchInfo': 'Getting branch info',
  'teleport.checkingOutBranch': 'Checking out branch',
  'teleport.teleportingSession': 'Teleporting session…',
  'teleport.getGitStatusFailed': 'Failed to get changed files',
  'teleport.stashFailed': 'Failed to stash changes',
  'teleport.checkingGitStatus': 'Checking git status',
  'teleport.errorPrefix': 'Error: {error}',
  'teleport.pressEscapeToCancel': 'Press Escape to cancel',
  'teleport.workingDirHasChanges': 'Working Directory Has Changes',
  'teleport.willSwitchBranches':
    'Teleport will switch git branches. The following changes were found:',
  'teleport.filesChanged': '{count} files changed',
  'teleport.noChangesDetected': 'No changes detected',
  'teleport.stashAndContinue': 'Would you like to stash these changes and continue with teleport?',
  'teleport.stashingChanges': 'Stashing changes...',
  'teleport.stashChangesAndContinue': 'Stash changes and continue',
  'teleport.repoMismatchTitle': 'Teleport to Repo',
  'teleport.openInRepo': 'Open ZY Code in {repo}:',
  'teleport.validatingRepo': 'Validating repository…',
  'teleport.runFromCheckout': 'Run zy --teleport from a checkout of {repo}',
  'teleport.pathNoLongerValid':
    '{path} no longer contains the correct repository. Select another path.',
  'teleport.usePath': 'Use {path}',
  'teleport.cancel': 'Cancel',

  // Worktree
  'worktree.exitingSession': 'Exiting worktree session',
  'worktree.noActiveSession': 'No active worktree session found',
  'worktree.keepingWorktree': 'Keeping worktree…',
  'worktree.removingWorktree': 'Removing worktree…',
  'worktree.subtitleBoth':
    'You have {fileCount} uncommitted {fileLabel} and {commitCount} {commitLabel} on {branch}. All will be lost if you remove.',
  'worktree.subtitleFiles':
    'You have {fileCount} uncommitted {fileLabel}. These will be lost if you remove the worktree.',
  'worktree.subtitleCommits':
    'You have {commitCount} {commitLabel} on {branch}. The branch will be deleted if you remove the worktree.',
  'worktree.subtitleNone':
    'You are working in a worktree. Keep it to continue working there, or remove it to clean up.',
  'worktree.removeDescription': 'All changes and commits will be lost.',
  'worktree.removeDescriptionClean': 'Clean up the worktree directory.',
  'worktree.keepWorktreeAndTmux': 'Keep worktree and tmux session',
  'worktree.keepWorktreeAndTmuxDesc': 'Stays at {path}. Reattach with: tmux attach -t {tmux}',
  'worktree.keepWorktreeKillTmux': 'Keep worktree, kill tmux session',
  'worktree.keepWorktreeKillTmuxDesc': 'Keeps worktree at {path}, terminates tmux session.',
  'worktree.removeWorktreeAndTmux': 'Remove worktree and tmux session',
  'worktree.keepWorktree': 'Keep worktree',
  'worktree.keepWorktreeDesc': 'Stays at {path}',
  'worktree.removeWorktree': 'Remove worktree',
  'worktree.removedNoChanges': 'Worktree removed (no changes)',
  'worktree.cleanupFailed': 'Worktree cleanup failed, exiting anyway',
  'worktree.keptWithPath': 'Worktree kept. Your work is saved at {path} on branch {branch}.',
  'worktree.keptWithPathAndTmux':
    'Worktree kept. Your work is saved at {path} on branch {branch}. Reattach to tmux session with: tmux attach -t {tmux}',
  'worktree.keptWithPathTmuxKilled':
    'Worktree kept at {path} on branch {branch}. Tmux session terminated.',
  'worktree.removedWithCommitsAndChanges':
    'Worktree removed. {commitCount} {commitLabel} and uncommitted changes were discarded.{tmuxNote}',
  'worktree.removedWithCommits':
    'Worktree removed. {commitCount} {commitLabel} on {branch} {wasWere} discarded.{tmuxNote}',
  'worktree.removedWithChanges': 'Worktree removed. Uncommitted changes were discarded.{tmuxNote}',
  'worktree.removed': 'Worktree removed.{tmuxNote}',
  'worktree.tmuxTerminated': ' Tmux session terminated.',
  'worktree.was': 'was',
  'worktree.were': 'were',
  'worktree.file_one': 'file',
  'worktree.file_other': 'files',
  'worktree.commit_one': 'commit',
  'worktree.commit_other': 'commits',

  // Remote callout
  'remoteCallout.title': 'Remote Control',
  'remoteCallout.enableLabel': 'Enable Remote Control for this session',
  'remoteCallout.enableDesc': 'Opens a secure connection to zy.ai.',
  'remoteCallout.dismissLabel': 'Never mind',
  'remoteCallout.dismissDesc': 'You can always enable it later with /remote-control.',
  'remoteCallout.description':
    'Remote Control lets you access this CLI session from the web (zy.ai/code) or the Zy app, so you can pick up where you left off on any device.',
  'remoteCallout.disconnectInfo':
    'You can disconnect remote access anytime by running /remote-control again.',

  // MCP desktop import
  'mcp.importDesktopTitle': 'Import MCP Servers from Zy Desktop',
  'mcp.importDesktopSubtitle': 'Found {count} MCP {unit} in Zy Desktop.',
  'mcp.importServer_one': 'server',
  'mcp.importServer_other': 'servers',
  'mcp.importAlreadyExists': ' (already exists)',
  'mcp.importCollisionNote':
    'Note: Some servers already exist with the same name. If selected, they will be imported with a numbered suffix.',
  'mcp.importSelectServers': 'Please select the servers you want to import:',
  'mcp.importSuccess': 'Successfully imported {count} MCP {unit} to {scope} config.',
  'mcp.importNoneImported': 'No servers were imported.',

  // Settings
  'settings.errorTitle': 'Settings Error',
  'settings.filesSkippedWarning':
    'Files with errors are skipped entirely, not just the invalid settings.',
  'settings.exitAndFix': 'Exit and fix manually',
  'settings.continueWithout': 'Continue without these settings',

  // Global search
  'globalSearch.title': 'Global Search',
  'globalSearch.placeholder': 'Type to search…',
  'globalSearch.searching': 'Searching…',
  'globalSearch.noMatches': 'No matches',
  'globalSearch.typeToSearch': 'Type to search…',
  'globalSearch.openInEditor': 'open in editor',
  'globalSearch.insertPath': 'insert path',
  'globalSearch.mention': 'mention',
  'globalSearch.previewUnavailable': '(preview unavailable)',
  'globalSearch.loading': 'Loading…',
  'globalSearch.matches_one': '{count} match',
  'globalSearch.matches_other': '{count} matches',
  'globalSearch.matchesTruncated': '+',

  // History search
  'historySearch.title': 'Search prompts',
  'historySearch.placeholder': 'Filter history…',
  'historySearch.loading': 'Loading…',
  'historySearch.noMatching': 'No matching prompts',
  'historySearch.noHistory': 'No history yet',
  'historySearch.moreLines': '… +{count} more lines',
  'historySearch.selectAction': 'use',

  // Desktop upsell
  'desktop.tryTitle': 'Try ZY Code Desktop',
  'desktop.openDesktop': 'Open in ZY Code Desktop',
  'desktop.notNow': 'Not now',
  'desktop.dontAskAgain': "Don't ask again",
  'desktop.description':
    'Same ZY Code with visual diffs, live app preview, parallel sessions, and more.',

  // Workflow
  'workflow.selectTitle': 'Select GitHub workflows to install',
  'workflow.subtitle': "We'll create a workflow file in your repository for each one you select.",
  'workflow.moreExamples': 'More workflow examples (issue triage, CI fixes, etc.) at:',
  'workflow.selectAtLeastOne': 'You must select at least one workflow to continue',

  // ZY.md external includes
  'zyMd.allowExternalTitle': 'Allow external ZY.md file imports?',
  'zyMd.importsOutsideWarning':
    "This project's ZY.md imports files outside the current working directory. Never allow this for third-party repositories.",
  'zyMd.externalImports': 'External imports:',
  'zyMd.securityWarning':
    'Important: Only use ZY Code with files you trust. Accessing untrusted files may pose security risks',
  'zyMd.yesAllow': 'Yes, allow external imports',
  'zyMd.noDisable': 'No, disable external imports',

  // Plugin hint
  'pluginHint.title': 'Plugin Recommendation',
  'pluginHint.suggestsInstalling': 'The {command} command suggests installing a plugin.',
  'pluginHint.pluginLabel': 'Plugin:',
  'pluginHint.marketplaceLabel': 'Marketplace:',
  'pluginHint.wouldYouInstall': 'Would you like to install it?',

  // Desktop handoff
  'desktopHandoff.unknownError': 'Unknown error',
  'desktopHandoff.startingDownload':
    "Starting download. Re-run /desktop once you've installed the app.\nLearn more at {url}",
  'desktopHandoff.desktopRequired': 'The desktop app is required for /desktop. Learn more at {url}',
  'desktopHandoff.notInstalled': 'Zy Desktop is not installed.',
  'desktopHandoff.needsUpdate':
    'Zy Desktop needs to be updated (found v{version}, need v1.1.2396+).',
  'desktopHandoff.openFailed': 'Failed to open Zy Desktop',
  'desktopHandoff.sessionTransferred': 'Session transferred to Zy Desktop',
  'desktopHandoff.errorLabel': 'Error: {error}',
  'desktopHandoff.pressAnyKey': 'Press any key to continue…',
  'desktopHandoff.downloadNow': 'Download now? (y/n)',
  'desktopHandoff.checking': 'Checking for Zy Desktop…',
  'desktopHandoff.savingSession': 'Saving session…',
  'desktopHandoff.opening': 'Opening Zy Desktop…',
  'desktopHandoff.openingInDesktop': 'Opening in Zy Desktop…',

  // Remote environment dialog
  'remoteEnv.title': 'Select Remote Environment',
  'remoteEnv.configHint': 'Configure environments at: https://zy.ai/code',
  'remoteEnv.loading': 'Loading environments…',
  'remoteEnv.errorLabel': 'Error: {error}',
  'remoteEnv.noEnvironments': 'No remote environments available.',
  'remoteEnv.currentlyUsing': 'Currently using',
  'remoteEnv.fromSettings': '(from {source} settings)',
  'remoteEnv.select': 'select',
  'remoteEnv.cancel': 'cancel',
  'remoteEnv.updating': 'Updating…',

  // Transcript share prompt
  'transcriptShare.title': 'Can ZY look at your session transcript to help us improve ZY Code?',
  'transcriptShare.learnMore':
    'Learn more: https://code.zy.com/docs/en/data-usage#session-quality-surveys',
  'transcriptShare.yes': 'Yes',
  'transcriptShare.no': 'No',
  'transcriptShare.dontAskAgain': "Don't ask again",

  // Feedback survey
  'feedbackSurvey.defaultMessage': 'How is Zy doing this session? (optional)',
  'feedbackSurvey.bad': 'Bad',
  'feedbackSurvey.fine': 'Fine',
  'feedbackSurvey.good': 'Good',
  'feedbackSurvey.dismiss': 'Dismiss',
  'feedbackSurvey.thanksTranscript': 'Thanks for sharing your transcript!',
  'feedbackSurvey.sharingTranscript': 'Sharing transcript…',
  'feedbackSurvey.thanksFeedback': 'Thanks for the feedback!',
  'feedbackSurvey.tellUsWhatWentWell': '(Optional) Press [1] to tell us what went well · {command}',
  'feedbackSurvey.useIssueToReport': 'Use /issue to report model behavior issues.',
  'feedbackSurvey.useCommandToShare': 'Use {command} to share detailed feedback anytime.',

  // Memory usage indicator
  'memoryUsage.high': 'High memory usage ({size}) · /heapdump',

  // Keybinding warnings
  'keybindingWarnings.title': 'Keybinding Configuration Issues',
  'keybindingWarnings.location': 'Location',
  'keybindingWarnings.error': 'Error',
  'keybindingWarnings.warning': 'Warning',

  // Validation errors list
  'validationErrors.fileNotSpecified': '(file not specified)',
  'validationErrors.learnMore': 'Learn more: {link}',

  // Diagnostics display
  'diagnostics.foundIssues': 'Found {count} new diagnostic {issueLabel} in {fileCount} {fileLabel}',
  'diagnostics.issue_one': 'issue',
  'diagnostics.issue_other': 'issues',
  'diagnostics.file_one': 'file',
  'diagnostics.file_other': 'files',
  'diagnostics.line': 'Line',

  // Context suggestions
  'contextSuggestions.title': 'Suggestions',
  'contextSuggestions.save': 'save ~{tokens}',

  // Context visualization
  'contextVis.title': 'Context Usage',
  'contextVis.freeSpace': 'Free space',
  'contextVis.autocompactBuffer': 'Autocompact buffer',
  'contextVis.estimatedUsage': 'Estimated usage by category',
  'contextVis.memoryFiles': 'Memory files',
  'contextVis.mcpTools': 'MCP tools',
  'contextVis.mcpLoadedOnDemand': ' (loaded on-demand)',
  'contextVis.loaded': 'Loaded',
  'contextVis.available': 'Available',
  'contextVis.customAgents': 'Custom agents',
  'contextVis.skills': 'Skills',
  'contextVis.collapseSummarized': '{count} {spanLabel} summarized ({msgCount} msgs)',
  'contextVis.collapseStaged': '{count} staged',
  'contextVis.span_one': 'span',
  'contextVis.span_other': 'spans',
  'contextVis.waitingForTrigger': 'waiting for first trigger',
  'contextVis.nothingStaged': '{count} {spawnLabel}, nothing staged yet',
  'contextVis.spawn_one': 'spawn',
  'contextVis.spawn_other': 'spawns',
  'contextVis.collapseErrors': 'Collapse errors: {errors}/{spawns} spawns failed',
  'contextVis.lastError': ' (last: {error})',
  'contextVis.collapseIdle': 'Collapse idle: {count} consecutive empty runs',
  'contextVis.contextStrategy': 'Context strategy: collapse ({summary})',

  // Coordinator agent status
  'coordinator.main': 'main',
  'coordinator.tokens': ' · {arrow} {count} tokens',
  'coordinator.queued': ' · {count} queued',
  'coordinator.xToStop': ' · x to stop',
  'coordinator.xToClear': ' · x to clear',

  // Agent progress line
  'agentProgress.initializing': 'Initializing…',
  'agentProgress.runningBackground': 'Running in the background',
  'agentProgress.done': 'Done',
  'agentProgress.toolUse_one': 'tool use',
  'agentProgress.toolUse_other': 'tool uses',

  // Compact summary
  'compactSummary.summarizedConversation': 'Summarized conversation',
  'compactSummary.summarizedMessages': 'Summarized {count} messages',
  'compactSummary.upToPoint': 'up to this point',
  'compactSummary.fromPoint': 'from this point',
  'compactSummary.contextLabel': 'Context',
  'compactSummary.expandHistory': 'expand history',
  'compactSummary.expand': 'expand',
  'compactSummary.title': 'Compact summary',

  // Session preview
  'sessionPreview.loading': 'Loading session…',
  'sessionPreview.cancel': 'cancel',
  'sessionPreview.messages': '{count} messages',
  'sessionPreview.resume': 'resume',

  // Sandbox violation
  'sandboxViolation.blockedOperations': 'Sandbox blocked {count} total {operationLabel}',
  'sandboxViolation.operation_one': 'operation',
  'sandboxViolation.operation_other': 'operations',
  'sandboxViolation.showingLast': '… showing last {shown} of {total}',

  // Teammate view header
  'teammateView.viewing': 'Viewing',
  'teammateView.return': 'return',

  // Notebook edit rejected
  'notebookEdit.rejectedDelete': 'User rejected delete',
  'notebookEdit.rejectedEditCell': 'User rejected {mode} cell in',
  'notebookEdit.atCell': 'at cell {cellId}',
  'notebookEdit.updatedCell': 'Updated cell {cellId}:',

  // File edit rejected
  'fileEdit.rejectedWrite': 'User rejected write to',
  'fileEdit.rejectedUpdate': 'User rejected update to',
  'fileEdit.noContent': '(No content)',
  'fileEdit.plusLines': '… +{count} lines',

  // Diff dialog
  'diffDialog.file': 'file',
  'diffDialog.files': 'files',
  'diffDialog.changed': 'changed',
  'diffDialog.turn': 'Turn',
  'diffDialog.uncommittedChanges': 'Uncommitted changes',
  'diffDialog.gitDiffHead': '(git diff HEAD)',
  'diffDialog.current': 'Current',
  'diffDialog.loadingDiff': 'Loading diff…',
  'diffDialog.noFileChangesInTurn': 'No file changes in this turn',
  'diffDialog.tooManyFilesToDisplay': 'Too many files to display details',
  'diffDialog.workingTreeIsClean': 'Working tree is clean',
  'diffDialog.pressAgainToExit': 'Press {keyName} again to exit',
  'diffDialog.sourceNav': '←/→ source',
  'diffDialog.select': '↑/↓ select',
  'diffDialog.enterView': 'Enter view',
  'diffDialog.close': 'close',
  'diffDialog.back': '← back',

  // Onboarding extras (fallback defaults)
  'onboarding.modelNameLabel': 'Model name',
  'onboarding.modelNamePlaceholder': 'e.g. qwen-max, qwen3.6-plus...',
  'onboarding.baseUrlLabel': 'Base URL',
  'onboarding.defaultApiKeyLabel': 'API Key',

  // Message selector
  'messageSelector.rewindTitle': 'Rewind',
  'messageSelector.errorPrefix': 'Error:',
  'messageSelector.nothingToRewind': 'Nothing to rewind to yet.',
  'messageSelector.confirmRestore':
    'Confirm you want to restore {what} to the point before you sent this message:',
  'messageSelector.conversation': 'the conversation ',
  'messageSelector.summarizing': 'Summarizing…',
  'messageSelector.rewindNoBashFiles':
    'Rewinding does not affect files edited manually or via bash.',
  'messageSelector.restoreCodeOrConversation':
    'Restore the code and/or conversation to the point before…',
  'messageSelector.restoreAndFork': 'Restore and fork the conversation to the point before…',
  'messageSelector.noCodeChanges': 'No code changes',
  'messageSelector.noCodeRestore': 'No code restore',
  'messageSelector.pressAgainToExit': 'Press {keyName} again to exit',
  'messageSelector.enterToContinue': 'Enter to continue ·',
  'messageSelector.escToExit': 'Esc to exit',
  'messageSelector.messageNotFound': 'Message not found.',
  'messageSelector.codeUnchanged': 'The code will be unchanged.',
  'messageSelector.codeNotChanged': 'The code has not changed (nothing will be restored).',
  'messageSelector.fileAndOtherFiles': '{file1} and {count} other files',
  'messageSelector.codeWillBeRestored': 'The code will be restored',
  'messageSelector.inFiles': 'in {fileLabel}.',
  'messageSelector.currentLabel': '(current)',
  'messageSelector.emptyMessage': '((empty message))',
  'messageSelector.messagesAfterSummarized': 'Messages after this point will be summarized.',
  'messageSelector.precedingMessagesSummarized':
    'Preceding messages will be summarized. This and subsequent messages will remain unchanged — you will stay at the end of the conversation.',
  'messageSelector.conversationWillBeForked': 'The conversation will be forked.',
  'messageSelector.conversationUnchanged': 'The conversation will be unchanged.',

  // Cost threshold dialog

  // Invalid config dialog (body)
  'invalidConfig.title': 'Configuration Error',
  'invalidConfig.body': 'The configuration file at {filePath} contains invalid JSON.',
  'invalidConfig.prompt': 'Select an option:',
  'invalidConfig.exit': 'Exit and fix manually',
  'invalidConfig.reset': 'Reset to default configuration',

  // LSP recommendation
  'lsp.title': 'LSP Plugin Recommendation',
  'lsp.yesInstallPlugin': 'Yes, install {pluginName}',
  'lsp.noNotNow': 'No, not now',
  'lsp.neverForPlugin': 'Never for {pluginName}',
  'lsp.disableAllRecommendations': 'Disable all LSP recommendations',
  'lsp.intelligenceDesc': 'LSP provides code intelligence like go-to-definition and error checking',
  'lsp.pluginLabel': 'Plugin:',
  'lsp.triggeredBy': 'Triggered by:',
  'lsp.fileExtension': '{fileExtension} files',
  'lsp.wouldYouInstall': 'Would you like to install this LSP plugin?',

  // Plan approval messages
  'planApproval.requestFrom': 'Plan Approval Request from {from}',
  'planApproval.planFile': 'Plan file: {filePath}',
  'planApproval.approvedBy': '✓ Plan Approved by {senderName}',
  'planApproval.proceedWithImplementation':
    'You can now proceed with implementation. Your plan mode restrictions have been lifted.',
  'planApproval.rejectedBy': '✗ Plan Rejected by {senderName}',
  'planApproval.feedbackLabel': 'Feedback:',
  'planApproval.reviseAndCallAgain':
    'Please revise your plan based on the feedback and call ExitPlanMode again.',
  'planApproval.summaryRequestFrom': '[Plan Approval Request from {from}]',
  'planApproval.summaryApproved': '[Plan Approved] You can now proceed with implementation',
  'planApproval.summaryRejected': '[Plan Rejected] {feedback}',
  'planApproval.revisePlanFallback': 'Please revise your plan',

  // OAuth
  'oauth.selectLoginMethod': 'Select login method:',
  'oauth.introMessage':
    'ZY Code can be used with your Zy subscription or billed based on API usage through your Console account.',
  'oauth.zyaiOptionLabel': 'Zy account with subscription ·',
  'oauth.zyaiOptionDesc': 'Pro, Max, Team, or Enterprise',
  'oauth.consoleOptionLabel': 'API account ·',
  'oauth.consoleOptionDesc': 'API usage billing',
  'oauth.platformOptionLabel': '3rd-party platform ·',
  'oauth.platformOptionDesc': 'Amazon Bedrock, Microsoft Foundry, or Vertex AI',
  'oauth.usingThirdPartyPlatforms': 'Using Third-Party Platforms',
  'oauth.thirdPartyPlatformsDesc':
    'You can use ZY Code with Amazon Bedrock, Microsoft Foundry, or Google Vertex AI.',
  'oauth.thirdPartyPlatformsEnterpriseHint':
    'These options are typically used for enterprise deployments.',
  'oauth.documentation': 'Documentation',
  'oauth.pressEnterToGoBack': 'Press Enter to go back',
  'oauth.openingBrowserToSignIn': 'Opening browser to sign in…',
  'oauth.browserNotOpened': "Browser didn't open? Use the url below to sign in",
  'oauth.copiedLabel': '(Copied!)',
  'oauth.tokenCreatedSuccess': '✓ Long-lived authentication token created successfully!',
  'oauth.yourTokenLabel': 'Your OAuth token (valid for 1 year):',
  'oauth.storeTokenSecurely': "Store this token securely. You won't be able to see it again.",
  'oauth.useTokenBySetting': 'Use this token by setting: export ZY_CODE_OAUTH_TOKEN=<token>',
  'oauth.creatingApiKey': 'Creating API key for ZY Code…',
  'oauth.retrying': 'Retrying…',
  'oauth.loggedInAs': 'Logged in as',
  'oauth.loginSuccessful': 'Login successful. Press Enter to continue…',
  'oauth.errorPrefix': 'OAuth error:',
  'oauth.pressEnterToRetry': 'Press Enter to retry.',
  'oauth.bedrockLabel': 'Amazon Bedrock',
  'oauth.foundryLabel': 'Microsoft Foundry',
  'oauth.vertexLabel': 'Vertex AI',
  'oauth.invalidCode': 'Invalid code. Please make sure the full code was copied',
  'oauth.pasteCodePrompt': 'Paste code here if prompted',

  // Settings (additional)
  'settings.searchSettings': 'Search settings…',
  'settings.noSettingsMatch': 'No settings match "{searchQuery}"',
  'settings.moreAbove': '{count} more above',
  'settings.moreBelow': '{count} more below',
  'settings.typeToFilter': 'Type to filter',
  'settings.languageLabel': 'Language',
  'settings.defaultEnglish': 'Default (English)',
  'settings.modelLabel': 'Model',
  'settings.defaultRecommended': 'Default (recommended)',
  'settings.autoCompact': 'Auto-compact',
  'settings.showTips': 'Show tips',
  'settings.reduceMotion': 'Reduce motion',
  'settings.thinkingMode': 'Thinking mode',
  'settings.promptSuggestions': 'Prompt suggestions',
  'settings.speculativeExecution': 'Speculative execution',
  'settings.rewindCode': 'Rewind code (checkpoints)',
  'settings.verboseOutput': 'Verbose output',
  'settings.terminalProgressBar': 'Terminal progress bar',
  'settings.showStatusInTerminalTab': 'Show status in terminal tab',
  'settings.showTurnDuration': 'Show turn duration',
  'settings.defaultPermissionMode': 'Default permission mode',
  'settings.useAutoModeDuringPlan': 'Use auto mode during plan',
  'settings.respectGitignore': 'Respect .gitignore in file picker',
  'settings.alwaysCopyFullResponse': 'Always copy full response (skip /copy picker)',
  'settings.copyOnSelect': 'Copy on select',
  'settings.autoUpdateChannel': 'Auto-update channel',
  'settings.theme': 'Theme',
  'settings.pushWhenIdle': 'Push when idle',
  'settings.pushWhenInputNeeded': 'Push when input needed',
  'settings.pushWhenZyDecides': 'Push when Zy decides',
  'settings.outputStyle': 'Output style',
  'settings.whatYouSeeByDefault': 'What you see by default',
  'settings.editorMode': 'Editor mode',
  'settings.showPrStatusFooter': 'Show PR status footer',
  'settings.diffTool': 'Diff tool',
  'settings.autoConnectIde': 'Auto-connect to IDE (external terminal)',
  'settings.autoInstallIdeExtension': 'Auto-install IDE extension',
  'settings.claudeInChromeEnabled': 'Claude in Chrome enabled by default',
  'settings.defaultTeammateModel': 'Default teammate model',
  'settings.enableRemoteControl': 'Enable Remote Control for all sessions',
  'settings.externalClaudeMdIncludes': 'External ZY.md includes',
  'settings.enableWithLatestChannel': 'Enable with latest channel',
  'settings.enableWithStableChannel': 'Enable with stable channel',
  'settings.missingStandardModel':
    'Standard model is not configured. Use /config or edit settings.json to set models.standard.',

  // Tag command
  'tag.removeTitle': 'Remove tag?',
  'tag.currentTag': 'Current tag: #{tagName}',
  'tag.removeDesc': 'This will remove the tag from the current session.',
  'tag.yesRemove': 'Yes, remove tag',
  'tag.noKeep': 'No, keep tag',
  'tag.noActiveSession': 'No active session to tag',
  'tag.emptyName': 'Tag name cannot be empty',
  'tag.sessionTagged': 'Tagged session with #{tagName}',
  'tag.tagRemoved': 'Removed tag #{tagName}',
  'tag.tagKept': 'Kept tag #{tagName}',
  'tag.usage':
    'Usage: /tag <tag-name>\n\nToggle a searchable tag on the current session.\nRun the same command again to remove the tag.\nTags are displayed after the branch name in /resume and can be searched with /.\n\nExamples:\n  /tag bugfix        # Add tag\n  /tag bugfix        # Remove tag (toggle)\n  /tag feature-auth\n  /tag wip',

  // Login command
  'login.title': 'Login',
  'login.pressAgainExit': 'Press {keyName} again to exit',
  'login.successful': 'Login successful',
  'login.interrupted': 'Login interrupted',

  // Memory command
  'memory.title': 'Memory',
  'memory.learnMore': 'Learn more: {link}',
  'memory.openedAt': 'Opened memory file at {path}',
  'memory.editorHint':
    'To use a different editor, set the $EDITOR or $VISUAL environment variable.',
  'memory.usingEditor': 'Using {editorSource}="{editorValue}".',
  'memory.usingEditorHint':
    'Using {editorSource}="{editorValue}". To change editor, set $EDITOR or $VISUAL environment variable.',
  'memory.openError': 'Error opening memory file: {error}',
  'memory.cancelled': 'Cancelled memory editing',

  // Copy command
  'copy.fullResponse': 'Full response',
  'copy.alwaysCopy': 'Always copy full response',
  'copy.alwaysCopyDesc': 'Skip this picker in the future (revert via /config)',
  'copy.selectContent': 'Select content to copy:',
  'copy.copiedToClipboard': 'Copied to clipboard ({charCount} characters, {lineCount} lines)',
  'copy.alsoWritten': 'Also written to {filePath}',
  'copy.preferenceSaved': 'Preference saved. Use /config to change copyFullResponse',
  'copy.writtenTo': 'Written to {filePath}',
  'copy.writeFailed': 'Failed to write file: {error}',
  'copy.cancelled': 'Copy cancelled',
  'copy.noAssistantMessage': 'No assistant message to copy',
  'copy.usage': 'Usage: /copy [N] where N is 1 (latest), 2, 3, … Got: {arg}',
  'copy.onlyMessages': 'Only {count} assistant {messageLabel} available to copy',
  'copy.message_one': 'message',
  'copy.message_other': 'messages',
  'copy.charsLines': '{charCount} chars, {lineCount} lines',
  'copy.lines': '{count} lines',

  // Stats
  'stats.loading': 'Loading your ZY Code stats…',
  'stats.loadingFiltered': 'Loading stats…',
  'stats.loadError': 'Failed to load stats: {message}',
  'stats.empty': 'No stats available yet. Start using ZY Code!',
  'stats.footer': 'Esc to cancel · r to cycle dates · ctrl+s to copy',
  'stats.copying': 'copying…',
  'stats.copied': 'copied!',
  'stats.copyFailed': 'copy failed',
  'stats.last7Days': 'Last 7 days',
  'stats.last30Days': 'Last 30 days',
  'stats.allTime': 'All time',
  'stats.overview': 'Overview',
  'stats.models': 'Models',
  'stats.favoriteModel': 'Favorite model',
  'stats.totalTokens': 'Total tokens',
  'stats.sessions': 'Sessions',
  'stats.longestSession': 'Longest session',
  'stats.activeDays': 'Active days',
  'stats.longestStreak': 'Longest streak',
  'stats.mostActiveDay': 'Most active day',
  'stats.currentStreak': 'Current streak',
  'stats.speculationSaved': 'Speculation saved',
  'stats.shotDistribution': 'Shot distribution',
  'stats.avgPerSession': 'Avg/session',
  'stats.peakHour': 'Peak hour',
  'stats.day': 'day',
  'stats.days': 'days',
  'stats.noModelData': 'No model usage data available',
  'stats.tokensPerDay': 'Tokens per Day',
  'stats.modelScrollHint': 'models (↑↓ to scroll)',
  'stats.screenshotDateRange': 'Stats from the last {n} days',
  'stats.screenshotSummary': 'Favorite: {model} · Total: {tokens} tokens',
  'stats.factTokensMore': "You've used ~{n}x more tokens than {book}",
  'stats.factTokensSame': "You've used the same number of tokens as {book}",
  'stats.factSessionLonger': 'Your longest session is ~{n}x longer than {comparison}',
  'stats.inOut': 'In: {in} · Out: {out}',
  'stats.notAvailable': 'N/A',
}
