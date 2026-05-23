import { Command } from '@commander-js/extra-typings'

/**
 * Tools/MCP/plugins/agents/settings 相关：
 * --allowed-tools、--tools、--disallowed-tools、--mcp-config、--strict-mcp-config、
 * --add-dir、--settings、--setting-sources、--plugin-dir、--agents、--disable-slash-commands、
 * --chrome / --no-chrome、--ide、--file、--session-id、-n/--name。
 */
// biome-ignore lint/suspicious/noExplicitAny: 链式扩展跨函数边界不可保留
export function applyToolsAndMcpOptions(cmd: Command<any, any>): Command<any, any> {
  return (
    cmd
      .option(
        '--allowedTools, --allowed-tools <tools...>',
        'Comma or space-separated list of tool names to allow (e.g. "Bash(git:*) Edit")',
      )
      .option(
        '--tools <tools...>',
        'Specify the list of available tools from the built-in set. Use "" to disable all tools, "default" to use all tools, or specify tool names (e.g. "Bash,Edit,Read").',
      )
      .option(
        '--disallowedTools, --disallowed-tools <tools...>',
        'Comma or space-separated list of tool names to deny (e.g. "Bash(git:*) Edit")',
      )
      .option(
        '--mcp-config <configs...>',
        'Load MCP servers from JSON files or strings (space-separated)',
      )
      .option(
        '--strict-mcp-config',
        'Only use MCP servers from --mcp-config, ignoring all other MCP configurations',
        () => true,
      )
      .option(
        '--settings <file-or-json>',
        'Path to a settings JSON file or a JSON string to load additional settings from',
      )
      .option(
        '--setting-sources <sources>',
        'Comma-separated list of setting sources to load (user, project, local).',
      )
      .option('--add-dir <directories...>', 'Additional directories to allow tool access to')
      // gh-33508：<paths...>（可变参数）消费直到下一个
      // --flag。`zy --plugin-dir /path mcp add --transport http` 吞掉了
      // `mcp` 和 `add` 作为 paths，然后因为 --transport 作为未知
      // 顶级选项而报错。单值 + collect 累加器意味着每个
      // --plugin-dir 只接受一个参数；重复标志用于多个目录。
      .option(
        '--plugin-dir <path>',
        'Load plugins from a directory for this session only (repeatable: --plugin-dir A --plugin-dir B)',
        (val: string, prev: string[]) => [...prev, val],
        [] as string[],
      )
      .option(
        '--agents <json>',
        'JSON object defining custom agents (e.g. \'{"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer"}}\')',
      )
      .option('--disable-slash-commands', 'Disable all skills', () => true)
      .option('--chrome', 'Enable ZY in Chrome integration')
      .option('--no-chrome', 'Disable ZY in Chrome integration')
      .option(
        '--ide',
        'Automatically connect to IDE on startup if exactly one valid IDE is available',
        () => true,
      )
      .option(
        '--file <specs...>',
        'File resources to download at startup. Format: file_id:relative_path (e.g., --file file_abc:doc.txt file_def:img.png)',
      )
      .option(
        '--session-id <uuid>',
        'Use a specific session ID for the conversation (must be a valid UUID)',
      )
      .option(
        '-n, --name <name>',
        'Set a display name for this session (shown in /resume and terminal title)',
      )
  )
}
