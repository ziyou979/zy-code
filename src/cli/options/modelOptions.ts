import { Command, InvalidArgumentError, Option } from '@commander-js/extra-typings'

/**
 * 模型/agent 相关选项：--model、--effort、--agent、--betas、--fallback-model、--workload（隐藏）。
 */
// biome-ignore lint/suspicious/noExplicitAny: 链式扩展跨函数边界不可保留
export function applyModelOptions(cmd: Command<any, any>): Command<any, any> {
  return (
    cmd
      // @[MODEL LAUNCH]: Update the example model ID in the --model help text.
      .option(
        '--model <model>',
        `Model for the current session. Specify a model (e.g. 'qwen3.6-plus').`,
      )
      .addOption(
        new Option(
          '--effort <level>',
          `Effort level for the current session (low, medium, high, max)`,
        ).argParser((rawValue: string) => {
          const value = rawValue.toLowerCase()
          const allowed = ['low', 'medium', 'high', 'max']
          if (!allowed.includes(value)) {
            throw new InvalidArgumentError(`It must be one of: ${allowed.join(', ')}`)
          }
          return value
        }),
      )
      .option('--agent <agent>', `Agent for the current session. Overrides the 'agent' setting.`)
      .option('--betas <betas...>', 'Beta headers to include in API requests (API key users only)')
      .option(
        '--fallback-model <model>',
        'Enable automatic fallback to specified model when default model is overloaded (only works with --print)',
      )
      .addOption(
        new Option(
          '--workload <tag>',
          'Workload tag for billing-header attribution (cc_workload). Process-scoped; set by SDK daemon callers that spawn subprocesses for cron work. (only works with --print)',
        ).hideHelp(),
      )
  )
}

/**
 * Thinking + 限额（max-* 系列）：--thinking、--max-thinking-tokens、--max-turns、
 * --max-budget-usd、--task-budget。除 --max-budget-usd 外均为隐藏。
 */
// biome-ignore lint/suspicious/noExplicitAny: 同上
export function applyThinkingAndLimitOptions(cmd: Command<any, any>): Command<any, any> {
  return cmd
    .addOption(
      new Option('--thinking <mode>', 'Thinking mode: enabled (equivalent to adaptive), disabled')
        .choices(['enabled', 'adaptive', 'disabled'])
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--max-thinking-tokens <tokens>',
        '[DEPRECATED. Use --thinking instead for newer models] Maximum number of thinking tokens (only works with --print)',
      )
        .argParser(Number)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--max-turns <turns>',
        'Maximum number of agentic turns in non-interactive mode. This will early exit the conversation after the specified number of turns. (only works with --print)',
      )
        .argParser(Number)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--max-budget-usd <amount>',
        'Maximum dollar amount to spend on API calls (only works with --print)',
      ).argParser((value) => {
        const amount = Number(value)
        if (Number.isNaN(amount) || amount <= 0) {
          throw new Error('--max-budget-usd must be a positive number greater than 0')
        }
        return amount
      }),
    )
    .addOption(
      new Option(
        '--task-budget <tokens>',
        'API-side task budget in tokens (output_config.task_budget)',
      )
        .argParser((value) => {
          const tokens = Number(value)
          if (Number.isNaN(tokens) || tokens <= 0 || !Number.isInteger(tokens)) {
            throw new Error('--task-budget must be a positive integer')
          }
          return tokens
        })
        .hideHelp(),
    )
}
