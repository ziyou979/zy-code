import type { Command } from '@commander-js/extra-typings'
import { getBaseRenderOptions } from '../../utils/renderOptions.js'
import { createSortedHelpConfig } from '../options/sortedHelp.js'

/**
 * 注册认证相关命令：auth login / status / logout，以及与之关联的 setup-token。
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
    .description('Sign in to your account')
    .option('--email <email>', 'Pre-populate email address on the login page')
    .option('--sso', 'Force SSO login flow')
    .option('--console', 'Use Console (API usage billing) instead of Zy subscription')
    .option('--zyai', 'Use Zy subscription (default)')
    .action(
      async ({
        email,
        sso,
        console: useConsole,
        zyai,
      }: {
        email?: string
        sso?: boolean
        console?: boolean
        zyai?: boolean
      }) => {
        const { authLogin } = await import('../handlers/auth.js')
        await authLogin({
          email,
          sso,
          console: useConsole,
          zyai,
        })
      },
    )
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

  // zy setup-token
  program
    .command('setup-token')
    .description('Set up a long-lived authentication token (requires ZY subscription)')
    .action(async () => {
      const [{ setupTokenHandler }, { createRoot }] = await Promise.all([
        import('../handlers/util.js'),
        import('../../ink.js'),
      ])
      const root = await createRoot(getBaseRenderOptions(false))
      await setupTokenHandler(root)
    })
}
