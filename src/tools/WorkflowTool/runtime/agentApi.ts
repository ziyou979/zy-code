import { updateTaskState } from '../../../services/task/framework.js'
import type { ToolUseContext } from '../../../Tool.js'
import type { LocalWorkflowTaskState } from '../../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { MutableWorkflowBudget } from './budget.js'
import type { WorkflowSemaphore } from './concurrency.js'
import { computeAgentKey, type JournalIndex, type WorkflowJournal } from './journal.js'
import type { ProgressContext } from './progress.js'

export interface AgentOpts {
  label?: string
  phase?: string
  schema?: object
  model?: string
  isolation?: 'worktree'
  agentType?: string
}

export interface WorkflowAgentContext {
  toolUseContext: ToolUseContext
  semaphore: WorkflowSemaphore
  budget: MutableWorkflowBudget
  progressCtx: ProgressContext
  abortSignal: AbortSignal
  journal?: WorkflowJournal
  journalIndex?: JournalIndex
}

/**
 * 创建 agent() 函数，支持 journal 缓存命中。
 * chainKey 是链式盐，第一次 miss 后所有后续调用都走真实执行。
 */
export function createAgentFunction(ctx: WorkflowAgentContext) {
  let chainKey = ''
  let hasMissed = false

  return async function agent(prompt: string, opts?: AgentOpts): Promise<any> {
    if (ctx.abortSignal.aborted) {
      return null
    }

    ctx.budget.checkBudget()

    // 计算缓存键
    const currentKey = ctx.journal ? computeAgentKey(prompt, opts as any, chainKey) : ''
    if (ctx.journal) {
      chainKey = currentKey
    }

    // 尝试缓存命中（未 miss 且有索引时）
    if (ctx.journal && ctx.journalIndex && !hasMissed) {
      const cached = ctx.journalIndex.results.get(currentKey)
      if (cached !== undefined) {
        // 命中：直接返回缓存结果，不消耗 semaphore 槽位
        updateTaskState<LocalWorkflowTaskState>(
          ctx.progressCtx.taskId,
          ctx.progressCtx.setAppState,
          (state) => ({
            ...state,
            agentCount: (state.agentCount ?? 0) + 1,
            ...(opts?.phase ? { currentPhase: opts.phase } : {}),
          }),
        )
        return cached.result
      }
      // 首次 miss：后续所有调用都走真实路径
      hasMissed = true
    }

    await ctx.semaphore.acquire()
    try {
      updateTaskState<LocalWorkflowTaskState>(
        ctx.progressCtx.taskId,
        ctx.progressCtx.setAppState,
        (state) => ({
          ...state,
          agentCount: (state.agentCount ?? 0) + 1,
          ...(opts?.phase ? { currentPhase: opts.phase } : {}),
        }),
      )

      // 记录 started
      if (ctx.journal) {
        void ctx.journal.appendStarted(currentKey, ctx.progressCtx.taskId)
      }

      const result = await runWorkflowAgent(prompt, opts, ctx)

      // 记录 result
      if (ctx.journal && result !== null) {
        void ctx.journal.appendResult(currentKey, ctx.progressCtx.taskId, result)
      }

      return result
    } catch (err: any) {
      if (err?.name === 'AbortError' || ctx.abortSignal.aborted) {
        return null
      }
      throw err
    } finally {
      ctx.semaphore.release()
    }
  }
}

function buildSchemaPromptSuffix(schema: object): string {
  const schemaStr = JSON.stringify(schema, null, 2)
  return `\n\n---\nIMPORTANT: Your final response MUST be a single valid JSON object matching this schema. Output ONLY the JSON — no markdown fences, no explanation before or after.\n\nJSON Schema:\n${schemaStr}`
}

function parseStructuredOutput(rawResult: any, _schema: object): any {
  const text = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult)

  // 尝试从响应中提取 JSON
  let jsonStr = text.trim()

  // 去除 markdown 代码围栏
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!.trim()
  }

  // 找到首个 { 或 [ 作为 JSON 起点
  const startObj = jsonStr.indexOf('{')
  const startArr = jsonStr.indexOf('[')
  const start =
    startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr)
  if (start > 0) {
    jsonStr = jsonStr.slice(start)
  }

  try {
    return JSON.parse(jsonStr)
  } catch {
    // 解析失败时返回原始文本
    return rawResult
  }
}

async function runWorkflowAgent(
  prompt: string,
  opts: AgentOpts | undefined,
  ctx: WorkflowAgentContext,
): Promise<any> {
  const { AgentTool } = await import('../../AgentTool/AgentTool.js')

  let effectivePrompt = prompt
  if (opts?.schema) {
    effectivePrompt = prompt + buildSchemaPromptSuffix(opts.schema)
  }

  const input = {
    prompt: effectivePrompt,
    description: opts?.label ?? prompt.slice(0, 80),
    run_in_background: false as const,
    ...(opts?.model && { model: opts.model }),
    ...(opts?.agentType && { subagent_type: opts.agentType }),
    ...(opts?.isolation && { isolation: opts.isolation }),
  }

  const canUseTool = async () => ({ allowed: true as const })

  const result = await AgentTool.call(input as any, ctx.toolUseContext, canUseTool as any, undefined)

  if (!result?.data) {
    return null
  }

  const data = result.data as any
  let rawResult: any
  if (typeof data === 'string') {
    rawResult = data
  } else if (data.result) {
    rawResult = data.result
  } else if (data.output) {
    rawResult = data.output
  } else {
    rawResult = data
  }

  // 有 schema 时解析结构化输出
  if (opts?.schema && rawResult) {
    return parseStructuredOutput(rawResult, opts.schema)
  }

  return rawResult
}
