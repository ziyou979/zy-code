import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import type { Command } from '../commands/index.js'
import { getMainLoopModel } from '../services/model/model.js'
import { getBuiltinPluginSkillCommands } from '../services/plugins/builtinRegistry.js'
import {
  findToolByName,
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from '../tools/tool.js'
import { getTools } from '../tools/tools.js'
import { createAbortController } from '../utils/abortController.js'
import { createFileStateCacheWithSizeLimit } from '../services/file-persistence/fileStateCache.js'
import { logError } from '../services/infra/log.js'
import { createAssistantMessage } from '../services/messages/./constructors.js'
import { hasPermissionsToUseTool } from '../services/permissions/permissions.js'
import { setCwd } from '../services/shell/shell.js'
import { jsonStringify } from '../services/infra/slowOperations.js'
import { getErrorParts } from '../services/tool-runtime/toolErrors.js'
import { zodToJsonSchema } from '../services/api/zodToJsonSchema.js'

type ToolInput = Tool['inputSchema']
type ToolOutput = Tool['outputSchema']

/**
 * MCP 暴露的 slash 命令（当前仅 /review）。
 * 惰性获取：/review 现由内置插件 review@builtin 提供，
 * 需在 initBuiltinPlugins() 之后调用才能拿到命令。
 */
function getMCPCommands(): Command[] {
  const review = getBuiltinPluginSkillCommands().find((c) => c.name === 'review')
  return review ? [review] : []
}

export async function startMCPServer(cwd: string, debug: boolean, verbose: boolean): Promise<void> {
  // 使用有限大小的 LRU 缓存 readFileState，防止内存无限增长
  // 100 个文件和 25MB 限制对于 MCP 服务器操作应该足够
  const READ_FILE_STATE_CACHE_SIZE = 100
  const readFileStateCache = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
  setCwd(cwd)
  const server = new Server(
    {
      name: 'zy/tengu',
      version: MACRO.VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
    // TODO: Also re-expose any MCP tools
    const toolPermissionContext = getEmptyToolPermissionContext()
    const tools = getTools(toolPermissionContext)
    return {
      tools: await Promise.all(
        tools.map(async (tool) => {
          let outputSchema: ToolOutput | undefined
          if (tool.outputSchema) {
            const convertedSchema = zodToJsonSchema(tool.outputSchema)
            // MCP SDK 要求 outputSchema 在根级别具有 type: "object"
            // 跳过根级别为 anyOf/oneOf 的 schema（来自 z.union、z.discriminatedUnion 等）
            // See: https://github.com/anthropics/zy-code/issues/8014
            if (
              typeof convertedSchema === 'object' &&
              convertedSchema !== null &&
              'type' in convertedSchema &&
              convertedSchema.type === 'object'
            ) {
              outputSchema = convertedSchema as ToolOutput
            }
          }
          return {
            ...tool,
            description: await tool.prompt({
              getToolPermissionContext: async () => toolPermissionContext,
              tools,
              agents: [],
            }),
            inputSchema: zodToJsonSchema(tool.inputSchema) as ToolInput,
            outputSchema,
          }
        }),
      ),
    }
  })

  server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params: { name, arguments: args } }): Promise<CallToolResult> => {
      const toolPermissionContext = getEmptyToolPermissionContext()
      // TODO: Also re-expose any MCP tools
      const tools = getTools(toolPermissionContext)
      const tool = findToolByName(tools, name)
      if (!tool) {
        throw new Error(`Tool ${name} not found`)
      }

      // 假设 MCP 服务器不会从工具调用参数之外单独读取消息
      const toolUseContext: ToolUseContext = {
        abortController: createAbortController(),
        options: {
          commands: getMCPCommands(),
          tools,
          mainLoopModel: getMainLoopModel()!,
          thinkingConfig: { type: 'disabled' },
          mcpClients: [],
          mcpResources: {},
          isNonInteractiveSession: true,
          debug,
          verbose,
          agentDefinitions: { activeAgents: [], allAgents: [] },
        },
        getAppState: () => getDefaultAppState(),
        setAppState: () => {},
        messages: [],
        readFileState: readFileStateCache,
        setInProgressToolUseIDs: () => {},
        setResponseLength: () => {},
        updateFileHistoryState: () => {},
        updateAttributionState: () => {},
      }

      // TODO: validate input types with zod
      try {
        if (!tool.isEnabled()) {
          throw new Error(`Tool ${name} is not enabled`)
        }
        const validationResult = await tool.validateInput?.((args as never) ?? {}, toolUseContext)
        if (validationResult && !validationResult.result) {
          throw new Error(
            `Tool ${name} input is invalid: ${(validationResult as unknown as { message: string }).message}`,
          )
        }
        const finalResult = await tool.call(
          (args ?? {}) as never,
          toolUseContext,
          hasPermissionsToUseTool,
          createAssistantMessage({
            content: [],
          }),
        )

        return {
          content: [
            {
              type: 'text' as const,
              text: typeof finalResult === 'string' ? finalResult : jsonStringify(finalResult.data),
            },
          ],
        }
      } catch (error) {
        logError(error)

        const parts = error instanceof Error ? getErrorParts(error) : [String(error)]
        const errorText = parts.filter(Boolean).join('\n').trim() || 'Error'

        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: errorText,
            },
          ],
        }
      }
    },
  )

  async function runServer() {
    const transport = new StdioServerTransport()
    await server.connect(transport)
  }

  return await runServer()
}
