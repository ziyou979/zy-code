import type { Command } from '@commander-js/extra-typings'
import { isInternalBuild } from '../../utils/envUtils.js'
import { TASK_STATUSES } from '../../services/tasks-service/tasks.js'
import { validateUuid } from '../../utils/uuid.js'
/**
 * 注册 ant 内部专用命令组：log / error / export / task / completion。
 * 整组在 isInternalBuild() 为假时不注册。
 */
// biome-ignore lint/suspicious/noExplicitAny: program 类型链跨函数边界不可保留
export function registerAntCommands(program: Command<any, any, any>): void {
  if (!isInternalBuild()) {
    return
  }

  const validateLogId = (value: string) => {
    const maybeSessionId = validateUuid(value)
    if (maybeSessionId) {
      return maybeSessionId
    }
    return Number(value)
  }

  // zy log
  program
    .command('log')
    .description('[INNER-ONLY] Manage conversation logs.')
    .argument(
      '[number|sessionId]',
      'A number (0, 1, 2, etc.) to display a specific log, or the sesssion ID (uuid) of a log',
      validateLogId,
    )
    .action(async (logId: string | number | undefined) => {
      const { logHandler } = await import('../handlers/ant.js')
      await logHandler(logId)
    })

  // zy error
  program
    .command('error')
    .description(
      '[INNER-ONLY] View error logs. Optionally provide a number (0, -1, -2, etc.) to display a specific log.',
    )
    .argument('[number]', 'A number (0, 1, 2, etc.) to display a specific log', parseInt)
    .action(async (number: number | undefined) => {
      const { errorHandler } = await import('../handlers/ant.js')
      await errorHandler(number)
    })

  // zy export
  program
    .command('export')
    .description('[INNER-ONLY] Export a conversation to a text file.')
    .usage('<source> <outputFile>')
    .argument('<source>', 'Session ID, log index (0, 1, 2...), or path to a .json/.jsonl log file')
    .argument('<outputFile>', 'Output file path for the exported text')
    .addHelpText(
      'after',
      `
Examples:
  $ zy export 0 conversation.txt                Export conversation at log index 0
  $ zy export <uuid> conversation.txt           Export conversation by session ID
  $ zy export input.json output.txt             Render JSON log file to text
  $ zy export <uuid>.jsonl output.txt           Render JSONL session file to text`,
    )
    .action(async (source: string, outputFile: string) => {
      const { exportHandler } = await import('../handlers/ant.js')
      await exportHandler(source, outputFile)
    })

  // zy task <create|list|get|update|dir>
  const taskCmd = program.command('task').description('[INNER-ONLY] Manage task list tasks')
  taskCmd
    .command('create <subject>')
    .description('Create a new task')
    .option('-d, --description <text>', 'Task description')
    .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
    .action(
      async (
        subject: string,
        opts: {
          description?: string
          list?: string
        },
      ) => {
        const { taskCreateHandler } = await import('../handlers/ant.js')
        await taskCreateHandler(subject, opts)
      },
    )
  taskCmd
    .command('list')
    .description('List all tasks')
    .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
    .option('--pending', 'Show only pending tasks')
    .option('--json', 'Output as JSON')
    .action(async (opts: { list?: string; pending?: boolean; json?: boolean }) => {
      const { taskListHandler } = await import('../handlers/ant.js')
      await taskListHandler(opts)
    })
  taskCmd
    .command('get <id>')
    .description('Get details of a task')
    .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
    .action(
      async (
        id: string,
        opts: {
          list?: string
        },
      ) => {
        const { taskGetHandler } = await import('../handlers/ant.js')
        await taskGetHandler(id, opts)
      },
    )
  taskCmd
    .command('update <id>')
    .description('Update a task')
    .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
    .option('-s, --status <status>', `Set status (${TASK_STATUSES.join(', ')})`)
    .option('--subject <text>', 'Update subject')
    .option('-d, --description <text>', 'Update description')
    .option('--owner <agentId>', 'Set owner')
    .option('--clear-owner', 'Clear owner')
    .action(
      async (
        id: string,
        opts: {
          list?: string
          status?: string
          subject?: string
          description?: string
          owner?: string
          clearOwner?: boolean
        },
      ) => {
        const { taskUpdateHandler } = await import('../handlers/ant.js')
        await taskUpdateHandler(id, opts)
      },
    )
  taskCmd
    .command('dir')
    .description('Show the tasks directory path')
    .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
    .action(async (opts: { list?: string }) => {
      const { taskDirHandler } = await import('../handlers/ant.js')
      await taskDirHandler(opts)
    })

  // zy completion <shell>
  program
    .command('completion <shell>', {
      hidden: true,
    })
    .description('Generate shell completion script (bash, zsh, or fish)')
    .option('--output <file>', 'Write completion script directly to a file instead of stdout')
    .action(
      async (
        shell: string,
        opts: {
          output?: string
        },
      ) => {
        const { completionHandler } = await import('../handlers/ant.js')
        await completionHandler(shell, opts, program)
      },
    )
}
