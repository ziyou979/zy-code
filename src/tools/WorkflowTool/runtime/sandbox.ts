import { createContext, Script } from 'node:vm'
import type { ToolUseContext } from '../../../tools/Tool.js'
import { createAgentFunction, type WorkflowAgentContext } from './agentApi.js'
import type { MutableWorkflowBudget } from './budget.js'
import type { WorkflowSemaphore } from './concurrency.js'
import { parallel, pipeline } from './orchestration.js'
import type { ProgressContext } from './progress.js'
import { createLogFunction, createPhaseFunction } from './progress.js'

const MAX_SCRIPT_BYTES = 524288

export interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
}

export interface WorkflowRunResult {
  returnValue: unknown
  agentCount: number
}

export class WorkflowScriptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowScriptError'
  }
}

export function parseMeta(source: string): WorkflowMeta {
  const metaMatch = source.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\n\})/)
  if (!metaMatch) {
    throw new WorkflowScriptError(
      'Script must begin with `export const meta = {...}` (a pure object literal).',
    )
  }

  let meta: WorkflowMeta
  try {
    // Pure literal constraint: evaluate as expression (no variables/functions)
    const evalScript = new Script(`(${metaMatch[1]})`, { filename: 'meta-parse' })
    meta = evalScript.runInNewContext({})
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new WorkflowScriptError(
      `Failed to parse meta: ${msg}. The meta object must be a pure literal (no variables, function calls, spreads, or template interpolation).`,
    )
  }

  if (!meta.name || typeof meta.name !== 'string') {
    throw new WorkflowScriptError('meta.name is required and must be a string.')
  }
  if (!meta.description || typeof meta.description !== 'string') {
    throw new WorkflowScriptError('meta.description is required and must be a string.')
  }

  return meta
}

export function validateScript(source: string): void {
  if (Buffer.byteLength(source) > MAX_SCRIPT_BYTES) {
    throw new WorkflowScriptError(`Script exceeds maximum size (${MAX_SCRIPT_BYTES} bytes).`)
  }
}

export interface SandboxOptions {
  source: string
  args: unknown
  toolUseContext: ToolUseContext
  semaphore: WorkflowSemaphore
  budget: MutableWorkflowBudget
  progressCtx: ProgressContext
  abortSignal: AbortSignal
  nestingDepth?: number
  resolveWorkflow?: (name: string) => { source: string; filePath: string } | undefined
  journal?: import('./journal.js').WorkflowJournal
  journalIndex?: import('./journal.js').JournalIndex
}

export async function executeWorkflowScript(opts: SandboxOptions): Promise<WorkflowRunResult> {
  const {
    source,
    args,
    semaphore,
    budget,
    progressCtx,
    abortSignal,
    toolUseContext,
    nestingDepth = 0,
    resolveWorkflow,
    journal,
    journalIndex,
  } = opts

  validateScript(source)

  // 从源码中去除 meta 声明，只保留执行体
  const bodySource = source.replace(
    /export\s+const\s+meta\s*=\s*\{[\s\S]*?\n\}/,
    '// meta stripped',
  )

  // 包裹在 async IIFE 中以支持顶层 await
  const wrappedSource = `(async () => {\n${bodySource}\n})()`

  const agentCtx: WorkflowAgentContext = {
    toolUseContext,
    journal,
    journalIndex,
    semaphore,
    budget,
    progressCtx,
    abortSignal,
  }

  const agentFn = createAgentFunction(agentCtx)
  const phaseFn = createPhaseFunction(progressCtx)
  const logFn = createLogFunction(progressCtx)

  const pipelineFn = <T>(
    items: T[],
    ...stages: Array<(prevResult: unknown, originalItem: T, index: number) => unknown>
  ) => pipeline(items, semaphore, ...stages)
  const parallelFn = (thunks: Array<() => Promise<unknown>>) => parallel(thunks, semaphore)

  const workflowFn = async (
    nameOrRef: string | { scriptPath: string },
    childArgs?: unknown,
  ): Promise<unknown> => {
    if (nestingDepth >= 1) {
      throw new Error(
        'workflow() nesting is limited to one level. A child workflow cannot call workflow() again.',
      )
    }

    let childSource: string
    if (typeof nameOrRef === 'string') {
      if (!resolveWorkflow) {
        throw new Error(`Named workflow "${nameOrRef}" not found. Workflow loader not available.`)
      }
      const resolved = resolveWorkflow(nameOrRef)
      if (!resolved) {
        throw new Error(`Named workflow "${nameOrRef}" not found.`)
      }
      childSource = resolved.source
    } else if (nameOrRef && typeof nameOrRef === 'object' && 'scriptPath' in nameOrRef) {
      const { readFileSync } = await import('node:fs')
      try {
        childSource = readFileSync(nameOrRef.scriptPath, 'utf-8')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`Cannot read workflow script at ${nameOrRef.scriptPath}: ${msg}`)
      }
    } else {
      throw new Error('workflow() requires a name string or {scriptPath: string}.')
    }

    const childResult = await executeWorkflowScript({
      ...opts,
      source: childSource,
      args: childArgs,
      nestingDepth: nestingDepth + 1,
    })
    return childResult.returnValue
  }

  const blockedDate = new Proxy(Date, {
    construct(_target, argArray) {
      if (argArray.length === 0) {
        throw new Error(
          'new Date() without arguments is not allowed in workflow scripts (breaks resume). Pass a timestamp via args.',
        )
      }
      return new Date(...(argArray as ConstructorParameters<typeof Date>))
    },
  })

  const blockedMath: Record<string, unknown> = { ...Math }
  delete blockedMath.random
  Object.defineProperty(blockedMath, 'random', {
    get() {
      throw new Error(
        'Math.random() is not allowed in workflow scripts (breaks resume). Use index-based variation instead.',
      )
    },
  })

  const sandboxGlobals: Record<string, unknown> = {
    // 注入的运行时 API
    agent: agentFn,
    pipeline: pipelineFn,
    parallel: parallelFn,
    phase: phaseFn,
    log: logFn,
    args,
    budget: {
      get total() {
        return budget.total
      },
      spent: () => budget.spent(),
      remaining: () => budget.remaining(),
    },
    workflow: workflowFn,

    // 允许的内置对象
    Promise,
    Array,
    Object,
    Map,
    Set,
    WeakMap,
    WeakSet,
    JSON,
    String,
    Number,
    Boolean,
    Error,
    TypeError,
    RangeError,
    RegExp,
    Symbol,
    Math: blockedMath,
    Date: blockedDate,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURI,
    encodeURIComponent,
    decodeURI,
    decodeURIComponent,
    console: {
      log: logFn,
      warn: logFn,
      error: logFn,
    },
    undefined,
    null: null,
    Infinity,
    NaN,
  }

  const context = createContext(sandboxGlobals, {
    name: 'workflow-sandbox',
  })

  const script = new Script(wrappedSource, {
    filename: 'workflow-script.js',
  })

  const returnValue = await script.runInContext(context, {
    timeout: 600000, // 10 minute wall-clock timeout for script itself
  })

  return {
    returnValue,
    agentCount: semaphore.getAgentCount(),
  }
}
