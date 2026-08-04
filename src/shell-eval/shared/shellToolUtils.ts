import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../services/infra/envUtils.js'
import { getPlatform } from '../../services/shell/platform.js'
import { whichSync } from '../../services/shell/which.js'

export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME, POWERSHELL_TOOL_NAME]

/**
 * Runtime gate for PowerShellTool. Windows defaults on and supports an
 * explicit env opt-out; non-Windows requires explicit opt-in.
 *
 * Used by tools.ts (tool-list visibility), processBashCommand (! routing),
 * and promptShellExecution (skill frontmatter routing) so the gate is
 * consistent across all paths that invoke PowerShellTool.call().
 */
let cachedBashAvailable: boolean | undefined

export function isBashAvailable(): boolean {
  if (cachedBashAvailable !== undefined) {
    return cachedBashAvailable
  }
  const direct = whichSync('bash')
  const gitPath = getPlatform() === 'windows' ? whichSync('git') : null
  const gitBash = gitPath ? resolve(gitPath, '..', '..', 'bin', 'bash.exe') : null
  const candidates = [direct, gitBash].filter((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate)),
  )
  cachedBashAvailable = candidates.some((candidate) => {
    try {
      execFileSync(candidate, ['--version'], { timeout: 3000, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })
  return cachedBashAvailable
}

export function isPowerShellToolEnabled(): boolean {
  const configured = process.env.ZY_CODE_USE_POWERSHELL_TOOL
  if (getPlatform() !== 'windows') {
    return isEnvTruthy(configured)
  }
  if (isEnvDefinedFalsy(configured)) {
    return false
  }
  if (isEnvTruthy(configured)) {
    return true
  }
  return true
}
