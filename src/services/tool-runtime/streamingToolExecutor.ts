import type { UUID } from 'node:crypto'
import { createUserMessage } from 'src/services/messages/constructors.js'
import { REJECT_MESSAGE } from 'src/services/messages/constants.js'
import { withMemoryCorrectionHint } from 'src/services/messages/predicates.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { findToolByName, type Tools, type ToolUseContext } from '../../tool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import type { ToolCallBlock } from '../../types/llm.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { runToolUse } from './toolExecution.js'

type MessageUpdate = {
  message?: Message
  newContext?: ToolUseContext
}

type ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded'

type TrackedTool = {
  id: string
  block: ToolCallBlock
  assistantMessage: AssistantMessage
  status: ToolStatus
  isConcurrencySafe: boolean
  promise?: Promise<void>
  results?: Message[]
  // 进度消息单独保存并立即产出
  pendingProgress: Message[]
  contextModifiers?: Array<(context: ToolUseContext) => ToolUseContext>
}

/**
 * 在工具流式流入时按并发控制执行。
 * - 并发安全的工具可与其他并发安全工具并行执行
 * - 非并发工具必须独占执行（独占访问）
 * - 结果被缓存，并按工具接收顺序发出
 */
export class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private toolUseContext: ToolUseContext
  private hasErrored = false
  private erroredToolDescription = ''
  // toolUseContext.abortController 的子 controller。在 Bash 工具出错时触发，
  // 以便兄弟子进程立即被杀死，而不是运行到完成。
  // abort 该 controller 并不会 abort 父者 —— query.ts 不会结束本轮。
  private siblingAbortController: AbortController
  private discarded = false
  // 在进度可用时唤醒 getRemainingResults 的信号
  private progressAvailableResolve?: () => void

  constructor(
    private readonly toolDefinitions: Tools,
    private readonly canUseTool: CanUseToolFn,
    toolUseContext: ToolUseContext,
  ) {
    this.toolUseContext = toolUseContext
    this.siblingAbortController = createChildAbortController(toolUseContext.abortController)
  }

  /**
   * 丢弃所有排队中及执行中的工具。在流式回退（streaming fallback）发生、
   * 并需要放弃失败尝试的结果时调用。
   * 排队中的工具不会启动，执行中的工具会收到合成错误。
   */
  discard(): void {
    this.discarded = true
  }

  /**
   * 将工具加入执行队列。若条件允许则立即开始执行。
   */
  addTool(block: ToolCallBlock, assistantMessage: AssistantMessage): void {
    const toolDefinition = findToolByName(this.toolDefinitions, block.name)
    if (!toolDefinition) {
      this.tools.push({
        id: block.id,
        block,
        assistantMessage,
        status: 'completed',
        isConcurrencySafe: true,
        pendingProgress: [],
        results: [
          createUserMessage({
            content: [
              {
                type: 'tool_result',
                content: `<tool_use_error>Error: No such tool available: ${block.name}</tool_use_error>`,
                isError: true,
                toolCallId: block.id,
              },
            ],
            toolUseResult: `Error: No such tool available: ${block.name}`,
            sourceToolAssistantUUID: assistantMessage.uuid as UUID,
          }),
        ],
      })
      return
    }

    const parsedInput = toolDefinition.inputSchema.safeParse(block.input)
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(toolDefinition.isConcurrencySafe(parsedInput.data))
          } catch {
            return false
          }
        })()
      : false
    this.tools.push({
      id: block.id,
      block,
      assistantMessage,
      status: 'queued',
      isConcurrencySafe,
      pendingProgress: [],
    })

    void this.processQueue()
  }

  /**
   * 根据当前并发状态判断工具是否可以执行
   */
  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executingTools = this.tools.filter((t) => t.status === 'executing')
    return (
      executingTools.length === 0 ||
      (isConcurrencySafe && executingTools.every((t) => t.isConcurrencySafe))
    )
  }

  /**
   * 处理队列，在并发条件满足时启动工具
   */
  private async processQueue(): Promise<void> {
    for (const tool of this.tools) {
      if (tool.status !== 'queued') {
        continue
      }

      if (this.canExecuteTool(tool.isConcurrencySafe)) {
        await this.executeTool(tool)
      } else {
        // 当前还不能执行这个工具；由于需保证非并发工具的执行顺序，这里直接停止
        if (!tool.isConcurrencySafe) {
          break
        }
      }
    }
  }

  private createSyntheticErrorMessage(
    toolUseId: string,
    reason: 'sibling_error' | 'user_interrupted' | 'streaming_fallback',
    assistantMessage: AssistantMessage,
  ): Message {
    // 对于用户中断（按 ESC 拒绝），使用 REJECT_MESSAGE，让 UI 显示
    // "User rejected edit" 而不是 "Error editing file"
    if (reason === 'user_interrupted') {
      return createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: withMemoryCorrectionHint(REJECT_MESSAGE),
            isError: true,
            toolCallId: toolUseId,
          },
        ],
        toolUseResult: 'User rejected tool use',
        // biome-ignore lint/suspicious/noExplicitAny: 服务层类型适配
        sourceToolAssistantUUID: assistantMessage.uuid as UUID,
      })
    }
    if (reason === 'streaming_fallback') {
      return createUserMessage({
        content: [
          {
            type: 'tool_result',
            content:
              '<tool_use_error>Error: Streaming fallback - tool execution discarded</tool_use_error>',
            isError: true,
            toolCallId: toolUseId,
          },
        ],
        toolUseResult: 'Streaming fallback - tool execution discarded',
        // biome-ignore lint/suspicious/noExplicitAny: 服务层类型适配
        sourceToolAssistantUUID: assistantMessage.uuid as UUID,
      })
    }
    const desc = this.erroredToolDescription
    const msg = desc
      ? `Cancelled: parallel tool call ${desc} errored`
      : 'Cancelled: parallel tool call errored'
    return createUserMessage({
      content: [
        {
          type: 'tool_result',
          content: `<tool_use_error>${msg}</tool_use_error>`,
          isError: true,
          toolCallId: toolUseId,
        },
      ],
      toolUseResult: msg,
      // biome-ignore lint/suspicious/noExplicitAny: 服务层类型适配
      sourceToolAssistantUUID: assistantMessage.uuid as UUID,
    })
  }

  /**
   * 判定工具应被取消的原因。
   */
  private getAbortReason(
    tool: TrackedTool,
  ): 'sibling_error' | 'user_interrupted' | 'streaming_fallback' | null {
    if (this.discarded) {
      return 'streaming_fallback'
    }
    if (this.hasErrored) {
      return 'sibling_error'
    }
    if (this.toolUseContext.abortController.signal.aborted) {
      // 'interrupt' 表示在工具运行期间用户输入了新消息。
      // 只取消 interruptBehavior 为 'cancel' 的工具；
      // 'block' 类工具不应走到这里（不会触发 abort）。
      if (this.toolUseContext.abortController.signal.reason === 'interrupt') {
        return this.getToolInterruptBehavior(tool) === 'cancel' ? 'user_interrupted' : null
      }
      return 'user_interrupted'
    }
    return null
  }

  private getToolInterruptBehavior(tool: TrackedTool): 'cancel' | 'block' {
    const definition = findToolByName(this.toolDefinitions, tool.block.name)
    if (!definition?.interruptBehavior) {
      return 'block'
    }
    try {
      return definition.interruptBehavior()
    } catch {
      return 'block'
    }
  }

  private getToolDescription(tool: TrackedTool): string {
    const input = tool.block.input as Record<string, unknown> | undefined
    const summary = input?.command ?? input?.file_path ?? input?.pattern ?? ''
    if (typeof summary === 'string' && summary.length > 0) {
      const truncated = summary.length > 40 ? `${summary.slice(0, 40)}\u2026` : summary
      return `${tool.block.name}(${truncated})`
    }
    return tool.block.name
  }

  private updateInterruptibleState(): void {
    const executing = this.tools.filter((t) => t.status === 'executing')
    this.toolUseContext.setHasInterruptibleToolInProgress?.(
      executing.length > 0 && executing.every((t) => this.getToolInterruptBehavior(t) === 'cancel'),
    )
  }

  /**
   * 执行工具并收集其结果
   */
  private async executeTool(tool: TrackedTool): Promise<void> {
    tool.status = 'executing'
    this.toolUseContext.setInProgressToolUseIDs((prev) => new Set(prev).add(tool.id))
    this.updateInterruptibleState()

    const messages: Message[] = []
    const contextModifiers: Array<(context: ToolUseContext) => ToolUseContext> = []

    const collectResults = async () => {
      // 如果已被 abort（因错误或用户），生成合成错误块而不是执行工具
      const initialAbortReason = this.getAbortReason(tool)
      if (initialAbortReason) {
        messages.push(
          this.createSyntheticErrorMessage(tool.id, initialAbortReason, tool.assistantMessage),
        )
        tool.results = messages
        tool.contextModifiers = contextModifiers
        tool.status = 'completed'
        this.updateInterruptibleState()
        return
      }

      // 每个工具的子 controller。让 siblingAbortController 能在 Bash 错误级联时杀死
      // 正在运行的子进程（Bash spawn 的进程会监听这个信号）。权限对话框拒绝也会
      // abort 该 controller（PermissionContext.ts 的 cancelAndAbort）—— 这个 abort 必须向上冒泡到
      // query controller，使查询循环在工具后的 abort 检查能结束本轮。如果不冒泡上去，
      // ExitPlanMode 的 "clear context + auto" 会发送 REJECT_MESSAGE 给模型而不是 abort
      // (#21056 回归)。
      const toolAbortController = createChildAbortController(this.siblingAbortController)
      toolAbortController.signal.addEventListener(
        'abort',
        () => {
          // 白名单：只有明确的 user-driven 中断 reason 才向上冒泡到 query 主 controller。
          // 历史上这里只排除了 'sibling_error'，但 createChildAbortController 内部
          // 用 WeakRef 传播 abort，当父 controller 已被 GC 时 reason 会变成 undefined，
          // 这种"幽灵 abort"也会通过原过滤器，导致 query.ts 在工具正常完成后
          // 误判主 controller 已 abort，静默结束 turn（UI 渲染 "弄好了/算完了" 但模型没回复）。
          // 现在反过来用白名单：只有明确表示"用户/hook 主动想终止 turn"的 reason
          // 才冒泡，其他（'sibling_error'、undefined、其他清理类 reason）一律忽略。
          const reason = toolAbortController.signal.reason
          const shouldBubble =
            reason === 'user_rejected_permission' ||
            reason === 'hook_interrupt' ||
            reason === 'interrupt' ||
            reason === 'sigint' ||
            reason === 'end_session'
          if (
            shouldBubble &&
            !this.toolUseContext.abortController.signal.aborted &&
            !this.discarded
          ) {
            this.toolUseContext.abortController.abort(reason)
          }
        },
        { once: true },
      )

      const generator = runToolUse(tool.block, tool.assistantMessage, this.canUseTool, {
        ...this.toolUseContext,
        abortController: toolAbortController,
      })

      // 跟踪当前工具是否产生了错误结果。
      // 防止该工具在自己就是错误源时变重复收到 “sibling error” 消息。
      let thisToolErrored = false

      for await (const update of generator) {
        // 检查是否被兄弟工具错误或用户中断所 abort。
        // 只有在当前工具未产生错误时才补上合成错误。
        const abortReason = this.getAbortReason(tool)
        if (abortReason && !thisToolErrored) {
          messages.push(
            this.createSyntheticErrorMessage(tool.id, abortReason, tool.assistantMessage),
          )
          break
        }

        const isErrorResult =
          update.message.type === 'user' &&
          Array.isArray(update.message.message.content) &&
          update.message.message.content.some((_) => _.type === 'tool_result' && _.isError === true)

        if (isErrorResult) {
          thisToolErrored = true
          // 只有 Bash 错误会取消兄弟。Bash 命令往往存在隐式的依赖链
          // （例如 mkdir 失败 → 后续命令没意义）。
          // Read/WebFetch 等是独立的 —— 一个失败不应击垮其他。
          if (tool.block.name === BASH_TOOL_NAME) {
            this.hasErrored = true
            this.erroredToolDescription = this.getToolDescription(tool)
            this.siblingAbortController.abort('sibling_error')
          }
        }

        if (update.message) {
          // 进度消息进入 pendingProgress 以便立即产出
          if (update.message.type === 'progress') {
            tool.pendingProgress.push(update.message)
            // 发出 “已有进度可用” 信号
            if (this.progressAvailableResolve) {
              this.progressAvailableResolve()
              this.progressAvailableResolve = undefined
            }
          } else {
            messages.push(update.message)
          }
        }
        if (update.contextModifier) {
          contextModifiers.push(update.contextModifier.modifyContext)
        }
      }
      tool.results = messages
      tool.contextModifiers = contextModifiers
      tool.status = 'completed'
      this.updateInterruptibleState()

      // 注：目前还不支持并发工具的 contextModifier。
      //       现在没有使用场景，但如果未来并发工具要用 contextModifier，
      //       需要在这里补上支持。
      if (!tool.isConcurrencySafe && contextModifiers.length > 0) {
        for (const modifier of contextModifiers) {
          this.toolUseContext = modifier(this.toolUseContext)
        }
      }
    }

    const promise = collectResults()
    tool.promise = promise

    // 完成后继续处理队列
    void promise.finally(() => {
      void this.processQueue()
    })
  }

  /**
   * 获取已完成但尚未产出的结果（非阻塞）。
   * 在必要时保持顺序。
   * 同时立即产出任何待发送的进度消息。
   */
  *getCompletedResults(): Generator<MessageUpdate, void> {
    if (this.discarded) {
      return
    }

    for (const tool of this.tools) {
      // 不论工具状态如何，总是立即产出待发送的进度消息
      while (tool.pendingProgress.length > 0) {
        const progressMessage = tool.pendingProgress.shift()!
        yield { message: progressMessage, newContext: this.toolUseContext }
      }

      if (tool.status === 'yielded') {
        continue
      }

      if (tool.status === 'completed' && tool.results) {
        tool.status = 'yielded'

        for (const message of tool.results) {
          yield { message, newContext: this.toolUseContext }
        }

        markToolUseAsComplete(this.toolUseContext, tool.id)
      } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
        break
      }
    }
  }

  /**
   * 检查是否有工具存在待发送的进度消息
   */
  private hasPendingProgress(): boolean {
    return this.tools.some((t) => t.pendingProgress.length > 0)
  }

  /**
   * 等待剩余工具完成，在完成时产出结果。
   * 同时在进度可用时产出进度消息。
   */
  async *getRemainingResults(): AsyncGenerator<MessageUpdate, void> {
    if (this.discarded) {
      return
    }

    while (this.hasUnfinishedTools()) {
      await this.processQueue()

      for (const result of this.getCompletedResults()) {
        yield result
      }

      // 如果还有执行中的工具但没有任何完成，等待任一完成
      // 或等到有进度可用
      if (this.hasExecutingTools() && !this.hasCompletedResults() && !this.hasPendingProgress()) {
        const executingPromises = this.tools
          .filter((t) => t.status === 'executing' && t.promise)
          .map((t) => t.promise!)

        // 同时等待 “进度可用”信号
        const progressPromise = new Promise<void>((resolve) => {
          this.progressAvailableResolve = resolve
        })

        if (executingPromises.length > 0) {
          await Promise.race([...executingPromises, progressPromise])
        }
      }
    }

    for (const result of this.getCompletedResults()) {
      yield result
    }
  }

  /**
   * 检查是否有已完成且等待产出的结果
   */
  private hasCompletedResults(): boolean {
    return this.tools.some((t) => t.status === 'completed')
  }

  /**
   * 检查是否还有正在执行的工具
   */
  private hasExecutingTools(): boolean {
    return this.tools.some((t) => t.status === 'executing')
  }

  /**
   * 检查是否还有未完成的工具
   */
  private hasUnfinishedTools(): boolean {
    return this.tools.some((t) => t.status !== 'yielded')
  }

  /**
   * 获取当前工具调用上下文（可能被 context modifier 修改过）
   */
  getUpdatedContext(): ToolUseContext {
    return this.toolUseContext
  }
}

function markToolUseAsComplete(toolUseContext: ToolUseContext, toolUseID: string) {
  toolUseContext.setInProgressToolUseIDs((prev) => {
    const next = new Set(prev)
    next.delete(toolUseID)
    return next
  })
}
