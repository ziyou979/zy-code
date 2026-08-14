// 用于在消息中标记 skill/command 元数据的 XML tag 名称。
export const COMMAND_NAME_TAG = 'command-name'
export const COMMAND_MESSAGE_TAG = 'command-message'
export const COMMAND_ARGS_TAG = 'command-args'

// 用户消息中终端/bash 命令输入输出使用的 XML tag 名称。
// 它们包裹的是终端活动内容，而不是真实的用户 prompt。
export const BASH_INPUT_TAG = 'bash-input'
export const BASH_STDOUT_TAG = 'bash-stdout'
export const BASH_STDERR_TAG = 'bash-stderr'
export const LOCAL_COMMAND_STDOUT_TAG = 'local-command-stdout'
export const LOCAL_COMMAND_STDERR_TAG = 'local-command-stderr'
export const LOCAL_COMMAND_CAVEAT_TAG = 'local-command-caveat'

// 所有表示消息属于终端输出而非用户 prompt 的终端相关 tag。
export const TERMINAL_OUTPUT_TAGS = [
  BASH_INPUT_TAG,
  BASH_STDOUT_TAG,
  BASH_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
] as const

export const TICK_TAG = 'tick'

// 任务通知（后台任务完成）使用的 XML tag 名称。
export const TASK_NOTIFICATION_TAG = 'task-notification'
export const TASK_ID_TAG = 'task-id'
export const TOOL_USE_ID_TAG = 'tool-use-id'
export const TASK_TYPE_TAG = 'task-type'
export const OUTPUT_FILE_TAG = 'output-file'
export const STATUS_TAG = 'status'
export const SUMMARY_TAG = 'summary'
export const REASON_TAG = 'reason'
export const WORKTREE_TAG = 'worktree'
export const WORKTREE_PATH_TAG = 'worktreePath'
export const WORKTREE_BRANCH_TAG = 'worktreeBranch'

// ultraplan 模式（远程并行规划会话）使用的 XML tag 名称。
export const ULTRAPLAN_TAG = 'ultraplan'

// 远程 /review 结果（传送过来的审查会话输出）使用的 XML tag 名称。
// 远程会话用此 tag 包裹最终审查结果，本地轮询器再将其提取出来。
export const REMOTE_REVIEW_TAG = 'remote-review'

// run_hunt.sh 的心跳约每 10 秒在此 tag 内回显 orchestrator 的 progress.json。
// 本地轮询器解析最新内容，用于任务状态行。
export const REMOTE_REVIEW_PROGRESS_TAG = 'remote-review-progress'

// teammate 消息（swarm agent 间通信）使用的 XML tag 名称。
export const TEAMMATE_MESSAGE_TAG = 'teammate-message'

// 外部 channel 消息使用的 XML tag 名称。
export const CHANNEL_MESSAGE_TAG = 'channel-message'
export const CHANNEL_TAG = 'channel'

// 跨会话 UDS 消息（另一个 ZY 会话的收件箱）使用的 XML tag 名称。
export const CROSS_SESSION_MESSAGE_TAG = 'cross-session-message'

// 包裹 fork 子会话首条消息中规则/格式模板的 XML tag。
// transcript 渲染器据此折叠模板，只展示指令。
export const FORK_BOILERPLATE_TAG = 'fork-boilerplate'
// 指令文本前的前缀，渲染器会将其移除。必须在生成端 buildChildMessage 与
// 解析端 UserForkBoilerplateMessage 之间保持同步。
export const FORK_DIRECTIVE_PREFIX = 'Your directive: '

// 请求帮助的 slash command 通用参数模式。
export const COMMON_HELP_ARGS = ['help', '-h', '--help']

// 请求当前状态/信息的 slash command 通用参数模式。
export const COMMON_INFO_ARGS = [
  'list',
  'show',
  'display',
  'current',
  'view',
  'get',
  'check',
  'describe',
  'print',
  'version',
  'about',
  'status',
  '?',
]
