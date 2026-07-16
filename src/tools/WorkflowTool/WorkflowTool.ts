import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { getOriginalCwd, getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import { tSync } from '../../i18n/index.js'
import { buildTool, type ToolDef, type ToolUseContext } from '../../tools/Tool.js'
import type { SetAppState } from '../../tasks/Task.js'
import {
  completeWorkflowTask,
  failWorkflowTask,
  registerWorkflowTask,
} from '../../tasks/local-workflow-task/localWorkflowTask.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getProjectDir } from '../../services/sessionStorage.js'
import { WORKFLOW_WIRE_NAME } from './constants.js'
import { resolveWorkflow } from './loader.js'
import { getWorkflowPrompt } from './prompt.js'
import { MutableWorkflowBudget } from './runtime/budget.js'
import { WorkflowSemaphore } from './runtime/concurrency.js'
import { WorkflowJournal } from './runtime/journal.js'
import { executeWorkflowScript, parseMeta, WorkflowScriptError } from './runtime/sandbox.js'

type InputSchema = ReturnType<typeof inputSchema>
type Output = {
  status: string
  message?: string
  taskId?: string
  runId?: string
  scriptPath?: string
}

const inputSchema = lazySchema(() =>
  z.object({
    script: z.string().max(524288).optional().describe('Self-contained workflow script.'),
    scriptPath: z.string().optional().describe('Path to a workflow script file on disk.'),
    name: z.string().optional().describe('Name of a predefined workflow.'),
    args: z
      .any()
      .optional()
      .describe('Optional input value exposed to the script as the global `args`.'),
    resumeFromRunId: z
      .string()
      .regex(/^wf_[a-z0-9-]{6,}$/)
      .optional()
      .describe('Run ID of a prior Workflow invocation to resume from.'),
    title: z
      .string()
      .optional()
      .describe('Ignored — set the workflow title in the script meta block.'),
    description: z
      .string()
      .optional()
      .describe('Ignored — set the workflow description in the script meta block.'),
    workflowSize: z
      .enum(['small', 'medium', 'large'])
      .optional()
      .describe('Advisory size guideline for dynamic workflow scaling.'),
  }),
)

function getWorkflowsDir(): string {
  const sessionDir = join(getProjectDir(getOriginalCwd()), getSessionId())
  const dir = join(sessionDir, 'workflows')
  mkdirSync(dir, { recursive: true })
  return dir
}

function persistScript(source: string, name: string): string {
  const dir = getWorkflowsDir()
  const filename = `${name}-${Date.now()}.js`
  const filepath = join(dir, filename)
  writeFileSync(filepath, source, 'utf-8')
  return filepath
}

function loadScript(scriptPath: string): string {
  try {
    return readFileSync(scriptPath, 'utf-8')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new WorkflowScriptError(`Cannot read script at ${scriptPath}: ${msg}`)
  }
}

export const WorkflowTool = buildTool({
  name: WORKFLOW_WIRE_NAME,
  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async call(input, context) {
    const { script, scriptPath, name, args, resumeFromRunId } = input

    // 准入校验：旧 run 还在跑时拒绝 resume
    if (resumeFromRunId) {
      const appState = context.getAppState()
      const tasks = appState.tasks ?? {}
      for (const [tid, task] of Object.entries(tasks)) {
        if (
          task.type === 'local_workflow' &&
          task.status === 'running' &&
          task.workflowId === resumeFromRunId
        ) {
          return {
            data: {
              status: 'error',
              message: tSync('workflow.error.resumeStillRunning', {
                runId: resumeFromRunId,
                taskId: tid,
              }),
            } satisfies Output,
          }
        }
      }
    }

    // 校验：必须且只能提供一个脚本来源
    const sources = [script, scriptPath, name].filter(Boolean)
    if (sources.length === 0) {
      return {
        data: { status: 'error', message: tSync('workflow.error.inputRequired') } satisfies Output,
      }
    }
    if (sources.length > 1) {
      return {
        data: { status: 'error', message: tSync('workflow.error.inputExclusive') } satisfies Output,
      }
    }

    // 解析脚本来源
    let source: string
    let resolvedPath: string | undefined

    if (script) {
      source = script
    } else if (scriptPath) {
      source = loadScript(scriptPath)
      resolvedPath = scriptPath
    } else {
      const resolved = resolveWorkflow(name!)
      if (!resolved) {
        return {
          data: {
            status: 'error',
            message: tSync('workflow.error.namedNotFound', { name: name! }),
          } satisfies Output,
        }
      }
      source = readFileSync(resolved.filePath, 'utf-8')
      resolvedPath = resolved.filePath
    }

    // 解析并校验 meta
    let meta
    try {
      meta = parseMeta(source)
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return {
        data: { status: 'error', message: errMsg } satisfies Output,
      }
    }

    // 持久化脚本到 session 目录
    if (!resolvedPath) {
      resolvedPath = persistScript(source, meta.name)
    }

    // 注册后台任务
    const setAppState = context.setAppStateForTasks ?? context.setAppState

    // resume 时复用 runId，否则生成新的
    const runId = resumeFromRunId ?? `wf_${crypto.randomUUID().slice(0, 12)}`

    // resume 时清理旧的已完成 task 条目
    if (resumeFromRunId) {
      setAppState((prev) => {
        const tasks = { ...prev.tasks }
        for (const [tid, task] of Object.entries(tasks)) {
          if (
            task.type === 'local_workflow' &&
            task.workflowId === resumeFromRunId &&
            task.status !== 'running'
          ) {
            delete tasks[tid]
          }
        }
        return { ...prev, tasks }
      })
    }

    const { taskId, outputFile } = await registerWorkflowTask(setAppState, {
      description: meta.description,
      workflowName: meta.name,
      scriptPath: resolvedPath,
      toolUseId: undefined,
      phases: meta.phases,
      workflowId: runId,
    })

    // 创建 journal（无论是否 resume 都打开；resume 时 load 会命中已有缓存）
    const journal = new WorkflowJournal(runId)

    // 异步执行（fire-and-forget），完成后通过 task-notification 通知 LLM
    void executeWorkflowAsync(
      source,
      args,
      context,
      taskId,
      outputFile,
      setAppState,
      meta,
      journal,
      input.workflowSize,
    )

    return {
      data: {
        status: 'launched',
        taskId,
        runId,
        scriptPath: resolvedPath,
        message: tSync('workflow.launched', { name: meta.name }),
      } satisfies Output,
    }
  },

  async description() {
    return 'Execute a workflow script that orchestrates multiple subagents deterministically.'
  },

  isEnabled() {
    return true
  },

  isConcurrencySafe() {
    return true
  },

  isReadOnly() {
    return false
  },

  async checkPermissions() {
    return { behavior: 'allow' as const }
  },

  async prompt() {
    return getWorkflowPrompt(true)
  },

  userFacingName() {
    return 'Workflow'
  },

  renderToolUseMessage(_input) {
    return null
  },

  mapToolResultToToolResultBlock(content, toolUseID) {
    return {
      type: 'tool_result',
      toolCallId: toolUseID,
      content: [{ type: 'text', text: JSON.stringify(content) }],
    }
  },

  toAutoClassifierInput(input) {
    return input
  },

  maxResultSizeChars: 50000,
} satisfies ToolDef<InputSchema, Output>)

async function executeWorkflowAsync(
  source: string,
  args: unknown,
  toolUseContext: ToolUseContext,
  taskId: string,
  outputFile: string,
  setAppState: SetAppState,
  _meta: { name: string; description: string },
  journal: WorkflowJournal,
  workflowSize?: 'small' | 'medium' | 'large' | null,
): Promise<void> {
  const abortController = new AbortController()
  const semaphore = new WorkflowSemaphore(abortController.signal, workflowSize)
  const budget = new MutableWorkflowBudget(null)

  // 加载 journal 索引（resume 时会命中已有缓存）
  const journalIndex = await journal.load()

  const progressCtx = { taskId, setAppState, outputFile }

  const resolveWorkflowForNesting = (name: string) => {
    const def = resolveWorkflow(name)
    if (!def) {
      return undefined
    }
    return { source: readFileSync(def.filePath, 'utf-8'), filePath: def.filePath }
  }

  try {
    const result = await executeWorkflowScript({
      source,
      args,
      toolUseContext,
      semaphore,
      budget,
      progressCtx,
      abortSignal: abortController.signal,
      nestingDepth: 0,
      resolveWorkflow: resolveWorkflowForNesting,
      journal,
      journalIndex,
    })

    const summary = result.returnValue
      ? tSync('workflow.completedWithResult', {
          count: String(result.agentCount),
          result: JSON.stringify(result.returnValue).slice(0, 500),
        })
      : tSync('workflow.completed', { count: String(result.agentCount) })

    completeWorkflowTask(taskId, setAppState, summary)
  } catch (err: unknown) {
    const errorMsg =
      err instanceof WorkflowScriptError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Unknown error'
    failWorkflowTask(taskId, setAppState, errorMsg)
  }
}

// 插件化注册
import { toolRegistry } from '../registry.js'

toolRegistry.register(WorkflowTool)
