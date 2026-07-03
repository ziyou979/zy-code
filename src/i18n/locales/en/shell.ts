import type { TranslationResource } from '../resourceTypes.js'

export const enShell: TranslationResource = {
  'bash.done': 'Done',
  'bash.imageDetected': '[Image data detected and sent to ZY]',
  'bash.noOutput': '(No output)',
  'bash.permission.allowedByPromptRule': 'Allowed by prompt rule: "{rule}"',
  'bash.permission.cdAndGit':
    'Compound commands with cd and git require approval to prevent bare repository attacks',
  'bash.permission.dangerousOperationOnPath':
    'Dangerous {command} operation on critical path: {path}',
  'bash.permission.deniedByPromptRule': 'Denied by Bash prompt rule: "{rule}"',
  'bash.permission.malformedSyntax':
    'Command contains malformed syntax that cannot be parsed: {error}',
  'bash.permission.multipleCd':
    'Multiple directory changes in one command require approval for clarity',
  'bash.permission.noPipes': 'No pipes found in command',
  'bash.permission.parseFailed': 'Failed to parse command',
  'bash.permission.patternsRequireApproval': 'Command contains patterns that require approval',
  'bash.permission.processSubstitution': 'Process substitution requires manual approval',
  'bash.permission.processSubstitutionFull':
    'Process substitution ({pattern}) can execute arbitrary commands and requires manual approval',
  'bash.permission.readOnlyAllowed': 'Read-only command is allowed',
  'bash.permission.requiredByPromptRule': 'Required by Bash prompt rule: "{rule}"',
  'bash.permission.requiresApproval': 'This command requires approval',
  'bash.permission.requiresSandboxBypass': 'Requires permission to bypass sandbox',
  'bash.permission.sandboxAutoAllow':
    'Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)',
  'bash.permission.securityPatterns':
    'This command contains patterns that could pose security risks and requires approval',
  'bash.permission.shellExpansionInPaths':
    'Shell expansion syntax in paths requires manual approval',
  'bash.permission.shellExpansionInPathsFull':
    'Shell expansion syntax in paths requires manual approval',
  'bash.permission.shellOperators':
    'This command uses shell operators that require approval for safety',
  'bash.permission.tooManySubcommands':
    'Command splits into {count} subcommands, too many to safety-check individually',
  'bash.runInBackground': 'run in background',
  'bash.running': 'Running…',
  'bash.runningActivity': 'Running {desc}',
  'bash.runningCommand': 'Running command',
  'bash.runningInBackground': 'Running in the background',
  'bash.sedDangerousOperations':
    'sed command contains operations that require explicit approval (e.g., write commands, execute commands)',
  'bash.sedNoDangerousOperations': 'No dangerous sed operations detected',
  'bash.sedRequiresApproval':
    'sed command requires approval (contains potentially dangerous operations)',
  'bash.waiting': 'Waiting…',
  'computerUse.accessibilityLabel': 'Accessibility:',
  'computerUse.allowForThisSession': 'Allow for this session ({count} {app})',
  'computerUse.alreadyGranted': 'already granted',
  'computerUse.alsoRequested': 'Also requested:',
  'computerUse.canChangeSystemSettings': 'can change system settings',
  'computerUse.canReadWriteAnyFile': 'can read/write any file',
  'computerUse.denyAndTellZy': 'Deny, and tell Zy what to do differently (esc)',
  'computerUse.equivalentToShellAccess': 'equivalent to shell access',
  'computerUse.granted': 'granted',
  'computerUse.grantMissingPermissions':
    'Grant the missing permissions in System Settings, then select "Try again". macOS may require you to restart ZY Code after granting Screen Recording.',
  'computerUse.needsMacOSPermissions': 'Computer Use needs macOS permissions',
  'computerUse.notGranted': 'not granted',
  'computerUse.notInstalled': 'not installed',
  'computerUse.openSystemSettingsAccessibility': 'Open System Settings \u2192\uFE0E Accessibility',
  'computerUse.openSystemSettingsScreenRecording':
    'Open System Settings \u2192\uFE0E Screen Recording',
  'computerUse.otherAppsHidden': '{count} other {app} will be hidden while Zy works.',
  'computerUse.screenRecordingLabel': 'Screen Recording:',
  'computerUse.tryAgain': 'Try again',
  'computerUse.wantsToControlApps': 'Computer Use wants to control these apps',
  'exitWorktree.branch': 'branch',
  'exitWorktree.exiting': 'Exiting worktree…',
  'exitWorktree.keptWorktree': 'Kept worktree',
  'exitWorktree.removedWorktree': 'Removed worktree',
  'exitWorktree.returnedTo': 'Returned to',
}
