import type { Command } from '@commander-js/extra-typings'
import { isInternalBuild } from '../../utils/envUtils.js'
import { getBaseRenderOptions } from '../../utils/renderOptions.js'

/**
 * 注册公开实用命令：doctor、update/upgrade、install。
 * 以及 INNER-ONLY 的 up、rollback。
 */
// biome-ignore lint/suspicious/noExplicitAny: program 类型链跨函数边界不可保留
export function registerUtilCommands(program: Command<any, any, any>): void {
  // 医生命令 —— 检查安装健康状态
  program
    .command('doctor')
    .description(
      'Check the health of your ZY Code auto-updater. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.',
    )
    .action(async () => {
      const [{ doctorHandler }, { createRoot }] = await Promise.all([
        import('../handlers/util.js'),
        import('../../ink.js'),
      ])
      const root = await createRoot(getBaseRenderOptions(false))
      await doctorHandler(root)
    })

  // zy update
  //
  // 对于符合 SemVer 的版本控制带构建元数据（X.X.X+SHA）：
  // - 我们执行精确字符串比较（包括 SHA）以检测任何更改
  // - 这确保用户始终获得最新构建，即使只有 SHA 更改
  // - UI 显示两个版本包括构建元数据以便清晰
  program
    .command('update')
    .alias('upgrade')
    .description('Check for updates and install if available')
    .action(async () => {
      const { update } = await import('../update.js')
      await update()
    })

  // zy up — run the project's AGENTS.md "# zy up" setup instructions.
  if (isInternalBuild()) {
    program
      .command('up')
      .description(
        '[INNER-ONLY] Initialize or upgrade the local dev environment using the "# zy up" section of the nearest AGENTS.md',
      )
      .action(async () => {
        const { up } = await import('../up.js')
        await up()
      })
  }

  // zy rollback（仅限 ant）
  // 回滚到之前的版本
  if (isInternalBuild()) {
    program
      .command('rollback [target]')
      .description(
        '[INNER-ONLY] Roll back to a previous release\n\nExamples:\n  zy rollback                                    Go 1 version back from current\n  zy rollback 3                                  Go 3 versions back from current\n  zy rollback 2.0.73-dev.20251217.t190658        Roll back to a specific version',
      )
      .option('-l, --list', 'List recent published versions with ages')
      .option('--dry-run', 'Show what would be installed without installing')
      .option(
        '--safe',
        'Roll back to the server-pinned safe version (set by oncall during incidents)',
      )
      .action(
        async (
          target?: string,
          options?: {
            list?: boolean
            dryRun?: boolean
            safe?: boolean
          },
        ) => {
          const { rollback } = await import('../rollback.js')
          await rollback(target ?? '', options)
        },
      )
  }

  // zy install
  program
    .command('install [target]')
    .description(
      'Install ZY Code native build. Use [target] to specify version (stable, latest, or specific version)',
    )
    .option('--force', 'Force installation even if already installed')
    .action(
      async (
        target: string | undefined,
        options: {
          force?: boolean
        },
      ) => {
        const { installHandler } = await import('../handlers/util.js')
        await installHandler(target, options)
      },
    )
}
