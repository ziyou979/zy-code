import { getInitialSettings } from '../../services/settings/settings.js'
import { isBashAvailable } from './shellToolUtils.js'

/**
 * Resolve the default shell for input-box `!` commands.
 *
 * 显式设置优先；Windows 没有可用 Bash 时自动回退到 PowerShell。
 */
export function resolveDefaultShell(): 'bash' | 'powershell' {
  return getInitialSettings().defaultShell ?? (isBashAvailable() ? 'bash' : 'powershell')
}
