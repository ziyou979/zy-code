import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import type { ToolUseContext } from '../../Tool.js'
import { spawnShellTask } from '../../tasks/LocalShellTask/LocalShellTask.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { exec } from '../../utils/Shell.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { logForDebugging } from '../../utils/debug.js'
import { DESCRIPTION, MONITOR_TOOL_NAME, PROMPT } from './prompt.js'
import { toolRegistry } from '../registry.js'

// --- 速率限制常量 ---
/** 令牌桶容量 */
const TOKEN_BUCKET_CAPACITY = 10
/** 令牌补充间隔（毫秒）：每 2 秒补 1 token */
const TOKEN_REFILL_INTERVAL_MS = 2000
/** 超限持续此时间后自动停止（毫秒） */
const RATE_LIMIT_KILL_TIMEOUT_MS = 30_000
/** 合批窗口（毫秒）：200ms 内的多行合并为一条通知 */
const BATCH_WINDOW_MS = 200
/** 单行最大字符数 */
const MAX_LINE_LENGTH = 500
/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 300_000
/** 最大超时（毫秒） */
const MAX_TIMEOUT_MS = 3_600_000
/** 最小超时（毫秒） */
const MIN_TIMEOUT_MS = 1_000

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .describe('Shell command or script. Each stdout line is an event; exit ends the watch.'),
    description: z
      .string()
      .describe(
        'Short human-readable description of what you are monitoring (shown in notifications).',
      ),
    timeout_ms: z
      .number()
      .default(DEFAULT_TIMEOUT_MS)
      .describe(
        `Kill the monitor after this deadline. Default ${DEFAULT_TIMEOUT_MS}ms, max ${MAX_TIMEOUT_MS}ms. Ignored when persistent is true.`,
      ),
    persistent: z
      .boolean()
      .default(false)
      .describe(
        'Run for the lifetime of the session (no timeout). Use for session-length watches like PR monitoring or log tails. Stop with TaskStop.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    taskId: z.string(),
    description: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

/**
 * 令牌桶速率限制器，用于控制通知投递速率。
 */
class TokenBucket {
  private tokens: number
  private readonly capacity: number
  private refillTimer: ReturnType<typeof setInterval> | null = null

  constructor(capacity: number, refillIntervalMs: number) {
    this.capacity = capacity
    this.tokens = capacity
    this.refillTimer = setInterval(() => {
      if (this.tokens < this.capacity) {
        this.tokens++
      }
    }, refillIntervalMs)
  }

  /** 尝试消耗一个 token，返回是否成功 */
  tryConsume(): boolean {
    if (this.tokens > 0) {
      this.tokens--
      return true
    }
    return false
  }

  dispose(): void {
    if (this.refillTimer) {
      clearInterval(this.refillTimer)
      this.refillTimer = null
    }
  }
}

export const MonitorTool = buildTool({
  name: MONITOR_TOOL_NAME,
  searchHint: 'start a background monitor that streams events from a script',
  maxResultSizeChars: 10_000,
  shouldDefer: true,

  async description() {
    return DESCRIPTION
  },

  async prompt() {
    return PROMPT
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  userFacingName() {
    return 'Monitor'
  },

  isEnabled() {
    return true
  },

  async checkPermissions(input) {
    // Monitor 使用与 Bash 相同的权限模型：用户需授权命令执行
    return {
      behavior: 'ask' as const,
      message: `Run monitor: ${input.command}`,
      updatedInput: input,
    }
  },

  renderToolUseMessage() {
    return null
  },

  renderToolResultMessage() {
    return null
  },

  mapToolResultToToolResultBlock(result: Output, toolUseID: string) {
    return {
      type: 'tool_result' as const,
      toolCallId: toolUseID,
      content: `Monitor started: "${result.description}" (task ${result.taskId}). Events will arrive as notifications.`,
    }
  },

  async call(
    input: { command: string; description: string; timeout_ms: number; persistent: boolean },
    context: ToolUseContext,
  ): Promise<{ data: Output }> {
    const { command, description, persistent } = input
    const timeoutMs = persistent
      ? MAX_TIMEOUT_MS * 24 // persistent 模式下设置极大超时（24 小时）
      : Math.max(MIN_TIMEOUT_MS, Math.min(input.timeout_ms, MAX_TIMEOUT_MS))

    const abortController = new AbortController()
    const { setAppState } = context

    // --- 合批 + 速率限制 stdout 投递 ---
    const bucket = new TokenBucket(TOKEN_BUCKET_CAPACITY, TOKEN_REFILL_INTERVAL_MS)
    let batchBuffer: string[] = []
    let batchTimer: ReturnType<typeof setTimeout> | null = null
    let rateLimitedSince: number | null = null
    let suppressedCount = 0
    let stopped = false
    let shellCommand: Awaited<ReturnType<typeof exec>> | null = null

    const stopMonitor = (): void => {
      if (stopped) return
      stopped = true
      bucket.dispose()
      if (batchTimer) {
        clearTimeout(batchTimer)
        batchTimer = null
      }
      shellCommand?.kill()
    }

    /** 将合批缓冲区作为一条通知发出 */
    const flushBatch = (): void => {
      if (batchBuffer.length === 0 || stopped) return

      if (bucket.tryConsume()) {
        // 令牌桶允许：发送通知
        rateLimitedSince = null
        const lines = batchBuffer.join('\n')
        batchBuffer = []
        enqueuePendingNotification({
          value: `[Monitor: ${description}] ${lines}`,
          mode: 'task-notification',
        })
      } else {
        // 令牌桶耗尽：抑制通知
        suppressedCount += batchBuffer.length
        batchBuffer = []
        if (rateLimitedSince === null) {
          rateLimitedSince = Date.now()
        } else if (Date.now() - rateLimitedSince > RATE_LIMIT_KILL_TIMEOUT_MS) {
          // 超限持续 30s → 自动停止
          enqueuePendingNotification({
            value: `[Monitor: ${description}] Monitor stopped — too many events (${suppressedCount} suppressed in last 30s). Restart with a tighter filter.`,
            mode: 'task-notification',
          })
          stopMonitor()
        }
      }
    }

    /** stdout 数据回调：逐行拆分 → 合批窗口 → 速率限制 → 通知投递 */
    const onStdout = (data: string): void => {
      if (stopped) return
      const lines = data.split('\n').filter((line) => line.length > 0)
      for (const rawLine of lines) {
        // 单行截断
        const line =
          rawLine.length > MAX_LINE_LENGTH
            ? rawLine.slice(0, MAX_LINE_LENGTH) + '...(truncated)'
            : rawLine
        batchBuffer.push(line)
      }
      // 200ms 合批窗口
      if (!batchTimer) {
        batchTimer = setTimeout(() => {
          batchTimer = null
          flushBatch()
        }, BATCH_WINDOW_MS)
      }
    }

    // --- 启动子进程 ---
    shellCommand = await exec(command, abortController.signal, 'bash', {
      timeout: timeoutMs,
      onStdout,
    })

    // --- 注册为后台任务（kind: 'monitor'） ---
    const handle = await spawnShellTask(
      {
        command,
        description,
        shellCommand,
        toolUseId: undefined,
        agentId: context.agentId,
        kind: 'monitor',
      },
      {
        abortController,
        getAppState: context.getAppState,
        setAppState,
      },
    )

    logForDebugging(
      `[MonitorTool] Started monitor "${description}" (task ${handle.taskId}), timeout=${persistent ? 'persistent' : timeoutMs + 'ms'}`,
    )

    // 进程退出时清理
    void shellCommand.result.then(() => {
      bucket.dispose()
      if (batchTimer) {
        clearTimeout(batchTimer)
        batchTimer = null
      }
      // 最后一次 flush
      if (batchBuffer.length > 0) {
        const remaining = batchBuffer.join('\n')
        batchBuffer = []
        enqueuePendingNotification({
          value: `[Monitor: ${description}] ${remaining}`,
          mode: 'task-notification',
        })
      }
    })

    return {
      data: {
        taskId: handle.taskId,
        description,
      },
    }
  },
})

// 自注册到工具注册表
toolRegistry.register(MonitorTool)
