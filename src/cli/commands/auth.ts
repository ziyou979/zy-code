import type { Command } from '@commander-js/extra-typings'
import { createSortedHelpConfig } from '../options/sortedHelp.js'

/**
 * 注册认证相关命令：auth login / status / logout。
 */
// biome-ignore lint/suspicious/noExplicitAny: program 类型链跨函数边界不可保留
export function registerAuthCommands(program: Command<any, any, any>): void {
  // zy auth
  const auth = program
    .command('auth')
    .description('Manage authentication')
    .configureHelp(createSortedHelpConfig())
  auth
    .command('login')
    .description('Sign in with an OAuth provider')
    .option(
      '--provider <provider>',
      'Login with a specific OAuth provider (anthropic, openai-codex, github-copilot, xai-oauth)',
    )
    .action(async ({ provider }: { provider?: string }) => {
      const { authLogin } = await import('../handlers/auth.js')
      await authLogin({ provider })
    })
  auth
    .command('status')
    .description('Show authentication status')
    .option('--json', 'Output as JSON (default)')
    .option('--text', 'Output as human-readable text')
    .action(async (opts: { json?: boolean; text?: boolean }) => {
      const { authStatus } = await import('../handlers/auth.js')
      await authStatus(opts)
    })
  auth
    .command('logout')
    .description('Log out from your account')
    .action(async () => {
      const { authLogout } = await import('../handlers/auth.js')
      await authLogout()
    })
}
