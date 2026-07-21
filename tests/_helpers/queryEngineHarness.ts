// 测试 harness：在 mock 掉重依赖后驱动 QueryEngine.submitMessage，
// 收集其 yield 出的 WireMessage 序列。
//
// 设计：
// - mock `./query.js` 的 query()，喂入脚本化的 Message 序列（由 _script 控制）
// - mock processUserInput / fetchSystemPromptParts / session-storage 写盘 /
//   斜杠命令&插件加载，避免真实磁盘/网络/API
// - 其余（normalizeMessage / isResultSuccessful / buildSystemInitMessage /
//   pruneCompletedTurnArtifacts / cost-tracker）保留真实实现——它们正是
//   要断言的产物或纯函数
//
// 用法：beforeEach(installQueryEngineMocks)、afterEach(() => mock.restore())，
// 测试体内 await runEngine(scriptedMessages, opts)。

import { mock } from 'bun:test'
import type { WireMessage } from '../../src/types/index.js'
import type { Message } from '../../src/types/message.js'

// 由 runEngine 在每次调用前设置，被 fake query() 读取。
let _script: Message[] = []
let _processResult: {
  messages: Message[]
  shouldQuery: boolean
  allowedTools: string[]
  model: string | undefined
  resultText: string | undefined
} = {
  messages: [],
  shouldQuery: true,
  allowedTools: [],
  model: undefined,
  resultText: undefined,
}

/**
 * 注册所有 mock。每个 mock 先 import 真实模块再 spread 覆盖单个导出，
 * 以免破坏被测导入图中用到的其他导出。必须在动态 import QueryEngine 之前调用。
 */
export async function installQueryEngineMocks(): Promise<void> {
  // bun test（非 bundle）下 bun:bundle 无法解析；feature() 用于死代码消除。
  mock.module('bun:bundle', () => ({ feature: () => false }))

  const queryContext = await import('../../src/services/query/queryContext.js')
  mock.module('src/services/query/queryContext.js', () => ({
    ...queryContext,
    fetchSystemPromptParts: async () => ({
      defaultSystemPrompt: [],
      userContext: {},
      systemContext: {},
    }),
  }))

  const processUserInputMod = await import(
    '../../src/services/process-user-input/processUserInput.js'
  )
  mock.module('src/services/process-user-input/processUserInput.js', () => ({
    ...processUserInputMod,
    processUserInput: async () => _processResult,
  }))

  const queryMod = await import('../../src/query/index.js')
  mock.module('src/query/index.js', () => ({
    ...queryMod,
    // eslint-disable-next-line require-yield
    query: async function* fakeQuery() {
      for (const m of _script) {
        yield m
      }
      return { kind: 'done' } as never
    },
  }))

  const sessionStorage = await import('../../src/services/sessionStorage.js')
  mock.module('src/services/sessionStorage.js', () => ({
    ...sessionStorage,
    recordTranscript: async () => {},
    flushSessionStorage: async () => {},
  }))

  const commands = await import('../../src/commands/index.js')
  mock.module('src/commands/index.js', () => ({
    ...commands,
    getSlashCommandToolSkills: async () => [],
  }))

  const pluginLoader = await import('../../src/services/plugins/pluginLoader.js')
  mock.module('src/services/plugins/pluginLoader.js', () => ({
    ...pluginLoader,
    loadAllPluginsCacheOnly: async () => ({ enabled: [], disabled: [], commands: [], errors: [] }),
  }))

  // buildSystemInitMessage 引用了 build-time 宏 MACRO.VERSION，bun test 下不可用；
  // 用一条极简 init 消息替代（测试断言会忽略 subtype==='init'）。sdkCompatToolName 保留真实实现。
  const systemInit = await import('../../src/services/messages/systemInit.js')
  mock.module('src/services/messages/systemInit.js', () => ({
    ...systemInit,
    buildSystemInitMessage: () => ({
      type: 'system',
      subtype: 'init',
      session_id: '',
      uuid: 'init',
    }),
  }))
}

export type RunEngineOptions = {
  /** processUserInput 的返回（默认：单条 user 消息、shouldQuery=true）。 */
  processResult?: Partial<typeof _processResult>
  /** 透传给 QueryEngineConfig 的覆盖项（maxBudgetUsd / jsonSchema / replayUserMessages 等）。 */
  config?: Record<string, unknown>
}

export type RunEngineResult = {
  /** submitMessage yield 出的全部 WireMessage（含首条 system_init）。 */
  wire: WireMessage[]
  /** 终态 result 消息（最后一条 type==='result'）。 */
  result: Extract<WireMessage, { type: 'result' }> | undefined
  /** 引擎实例（用于断言 getMessages() 等）。 */
  engine: { getMessages(): readonly Message[] }
}

const defaultUserMessage = (): Message =>
  ({
    type: 'user',
    uuid: 'prompt-uuid',
    timestamp: '2024-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  }) as unknown as Message

/**
 * 设置脚本、构造最小 QueryEngineConfig、运行一个 turn、收集 WireMessage。
 */
export async function runEngine(
  scriptedMessages: Message[],
  opts: RunEngineOptions = {},
): Promise<RunEngineResult> {
  _script = scriptedMessages
  _processResult = {
    messages: [defaultUserMessage()],
    shouldQuery: true,
    allowedTools: [],
    model: undefined,
    resultText: undefined,
    ...opts.processResult,
  }

  const { QueryEngine } = await import('../../src/query/queryEngine.js')

  let appState: Record<string, unknown> = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map<string, unknown>(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
    },
    fileHistory: {},
    attribution: {},
  }

  const config = {
    cwd: process.cwd(),
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    getAppState: () => appState,
    setAppState: (f: (prev: Record<string, unknown>) => Record<string, unknown>) => {
      appState = f(appState)
    },
    readFileCache: {} as unknown,
    // 绕过 getMainLoopModel()（读 session/config）与 thinking 默认推断
    userSpecifiedModel: 'claude-test',
    thinkingConfig: { type: 'disabled' as const },
    ...opts.config,
  }

  // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造，QueryEngineConfig 字段过多
  const engine = new QueryEngine(config as any)

  const wire: WireMessage[] = []
  for await (const msg of engine.submitMessage('hi')) {
    wire.push(msg)
  }

  const result = [...wire].reverse().find((m) => m.type === 'result') as
    | Extract<WireMessage, { type: 'result' }>
    | undefined

  return { wire, result, engine }
}
