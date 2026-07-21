import { homedir } from 'node:os'
import {
  buildComputerUseTools,
  // @ts-expect-error
  createComputerUseMcpServer,
} from '@ant/computer-use-mcp'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { shutdownDatadog } from '../analytics/datadog.js'
import { initializeAnalyticsSink } from '../analytics/sink.js'
import { shutdownZyEventLogging } from '../analytics/zyEventLogger.js'
import { enableConfigs } from '../config/config.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { filterAppsForDescription } from './appNames.js'
import { getChicagoCoordinateMode } from './gates.js'
import { getComputerUseHostAdapter } from './hostAdapter.js'

const APP_ENUM_TIMEOUT_MS = 1000

/**
 * 枚举已安装应用，带超时。失败时软处理 —— 如果 Spotlight 响应慢或
 * zy-swift 抛异常，工具描述中将省略应用列表。无论如何在调用时进行解析；
 * 模型只是得不到提示。
 */
async function tryGetInstalledAppNames(): Promise<string[] | undefined> {
  const adapter = getComputerUseHostAdapter()
  const enumP = adapter.executor.listInstalledApps()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutP = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, APP_ENUM_TIMEOUT_MS, undefined)
  })
  const installed = await Promise.race([enumP, timeoutP])
    .catch(() => undefined)
    .finally(() => clearTimeout(timer))
  if (!installed) {
    // 枚举仍在后台继续运行 —— 吞掉延迟的 rejection。
    void enumP.catch(() => {})
    logForDebugging(
      `[Computer Use MCP] app enumeration exceeded ${APP_ENUM_TIMEOUT_MS}ms or failed; tool description omits list`,
    )
    return undefined
  }
  return filterAppsForDescription(installed, homedir())
}

/**
 * 构建进程内 MCP 服务器。委托给包内的 `createComputerUseMcpServer` 获取 Server
 * 对象和桩 CallTool 处理器，然后替换 ListTools 处理器为包含已安装应用名称的版本
 * （写入 `request_access` 描述中）。包的工厂不接受 `installedAppNames`，Cowork
 * 在 serverDef.ts 中出于同样原因自行构建工具数组。
 *
 * 异步执行以避免 1s 应用枚举超时阻塞启动 —— 在 `client.ts` 首次 CU 连接时
 * 通过 `await import()` 调用，而非 `main.tsx`。
 *
 * 实际调度仍通过 `wrapper.tsx` 的 `.call()` 覆盖；此服务器仅用于响应 ListTools。
 */
export async function createComputerUseMcpServerForCli(): Promise<
  ReturnType<typeof createComputerUseMcpServer>
> {
  const adapter = getComputerUseHostAdapter()
  const coordinateMode = getChicagoCoordinateMode()
  const server = createComputerUseMcpServer(adapter, coordinateMode)

  const installedAppNames = await tryGetInstalledAppNames()
  const tools = buildComputerUseTools(
    adapter.executor.capabilities,
    coordinateMode,
    installedAppNames,
  )
  server.setRequestHandler(ListToolsRequestSchema, async () =>
    adapter.isDisabled() ? { tools: [] } : { tools },
  )

  return server
}

/**
 * `--computer-use-mcp` 的子进程入口。对应 `runClaudeInChromeMcpServer` ——
 * stdio 传输，stdin 关闭时退出，退出前刷新分析数据。
 */
export async function runComputerUseMcpServer(): Promise<void> {
  enableConfigs()
  initializeAnalyticsSink()

  const server = await createComputerUseMcpServerForCli()
  const transport = new StdioServerTransport()

  let exiting = false
  const shutdownAndExit = async (): Promise<void> => {
    if (exiting) {
      return
    }
    exiting = true
    await Promise.all([shutdownZyEventLogging(), shutdownDatadog()])
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  }
  process.stdin.on('end', () => void shutdownAndExit())
  process.stdin.on('error', () => void shutdownAndExit())

  logForDebugging('[Computer Use MCP] Starting MCP server')
  await server.connect(transport)
  logForDebugging('[Computer Use MCP] MCP server started')
}
