import { Command, Option } from '@commander-js/extra-typings'

// 注：所有 helper 用宽松类型，因为 @commander-js/extra-typings 的
// 链式扩展无法跨函数边界保留 —— 下游 .action(options) 由原 main.tsx
// 中的 `options as { ... }` 守卫负责窄化。

/**
 * 调试/日志相关选项：-d/--debug、--debug-to-stderr、--debug-file、--verbose、--mcp-debug。
 */
// biome-ignore lint/suspicious/noExplicitAny: 链式扩展跨函数边界不可保留
export function applyDebugOptions(cmd: Command<any, any>): Command<any, any> {
  return cmd
    .option(
      '-d, --debug [filter]',
      'Enable debug mode with optional category filtering (e.g., "api,hooks" or "!1p,!file")',
      (_value: string | true) => {
        // 如果提供了值，它将是过滤字符串
        // 如果没有提供但标志存在，值将为 true
        // 实际的过滤由 debug.ts 通过解析 process.argv 处理
        return true
      },
    )
    .addOption(
      new Option('--debug-to-stderr', 'Enable debug mode (to stderr)')
        .argParser(Boolean)
        .hideHelp(),
    )
    .option(
      '--debug-file <path>',
      'Write debug logs to a specific file path (implicitly enables debug mode)',
      () => true,
    )
    .option('--verbose', 'Override verbose mode setting from config', () => true)
    .option(
      '--mcp-debug',
      '[DEPRECATED. Use --debug instead] Enable MCP debug mode (shows MCP server errors)',
      () => true,
    )
}

/**
 * 进程生命周期 hook：--init、--init-only、--maintenance。皆为隐藏选项。
 */
// biome-ignore lint/suspicious/noExplicitAny: 同上
export function applyLifecycleOptions(cmd: Command<any, any>): Command<any, any> {
  return cmd
    .addOption(new Option('--init', 'Run Setup hooks with init trigger, then continue').hideHelp())
    .addOption(
      new Option('--init-only', 'Run Setup and SessionStart:startup hooks, then exit').hideHelp(),
    )
    .addOption(
      new Option(
        '--maintenance',
        'Run Setup hooks with maintenance trigger, then continue',
      ).hideHelp(),
    )
}

/**
 * 输出/输入格式 + print 模式：-p/--print、--bare、--output-format、--json-schema、
 * --include-hook-events、--include-partial-messages、--input-format、--replay-user-messages、
 * --enable-auth-status。
 */
// biome-ignore lint/suspicious/noExplicitAny: 同上
export function applyPrintOptions(cmd: Command<any, any>): Command<any, any> {
  return cmd
    .option(
      '-p, --print',
      'Print response and exit (useful for pipes). Note: The workspace trust dialog is skipped when ZY is run with the -p mode. Only use this flag in directories you trust.',
      () => true,
    )
    .option(
      '--bare',
      'Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and AGENTS.md auto-discovery. Sets ZY_CODE_SIMPLE=1. Auth is strictly ZY_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read). 3P providers (Bedrock/Vertex/Foundry) use their own credentials. Skills still resolve via /skill-name. Explicitly provide context via: --system-prompt[-file], --append-system-prompt[-file], --add-dir (AGENTS.md dirs), --mcp-config, --settings, --agents, --plugin-dir.',
      () => true,
    )
    .addOption(
      new Option(
        '--output-format <format>',
        'Output format (only works with --print): "text" (default), "json" (single result), or "stream-json" (realtime streaming)',
      ).choices(['text', 'json', 'stream-json']),
    )
    .addOption(
      new Option(
        '--json-schema <schema>',
        'JSON Schema for structured output validation. ' +
          'Example: {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}',
      ).argParser(String),
    )
    .option(
      '--include-hook-events',
      'Include all hook lifecycle events in the output stream (only works with --output-format=stream-json)',
      () => true,
    )
    .option(
      '--include-partial-messages',
      'Include partial message chunks as they arrive (only works with --print and --output-format=stream-json)',
      () => true,
    )
    .addOption(
      new Option(
        '--input-format <format>',
        'Input format (only works with --print): "text" (default), or "stream-json" (realtime streaming input)',
      ).choices(['text', 'stream-json']),
    )
    .option(
      '--replay-user-messages',
      'Re-emit user messages from stdin back on stdout for acknowledgment (only works with --input-format=stream-json and --output-format=stream-json)',
      () => true,
    )
    .addOption(
      new Option('--enable-auth-status', 'Enable auth status messages in SDK mode')
        .default(false)
        .hideHelp(),
    )
}
