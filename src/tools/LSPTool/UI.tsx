import React from 'react'
import { CtrlOToExpand } from '../../components/CtrlOToExpand.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import type { ToolResultBlock } from '../../types/llm.js'
import { getDisplayPath } from '../../utils/file.js'
import { extractTag } from '../../services/messages/./predicates.js'
import type { Input, Output } from './LSPTool.js'
import { getSymbolAtPosition } from './symbolContext.js'

// 操作特定标签的查找映射
const OPERATION_LABELS: Record<
  Input['operation'],
  {
    singular: string
    plural: string
    special?: string
  }
> = {
  goToDefinition: {
    singular: 'definition',
    plural: 'definitions',
  },
  findReferences: {
    singular: 'reference',
    plural: 'references',
  },
  documentSymbol: {
    singular: 'symbol',
    plural: 'symbols',
  },
  workspaceSymbol: {
    singular: 'symbol',
    plural: 'symbols',
  },
  hover: {
    singular: 'hover info',
    plural: 'hover info',
    special: 'available',
  },
  goToImplementation: {
    singular: 'implementation',
    plural: 'implementations',
  },
  prepareCallHierarchy: {
    singular: 'call item',
    plural: 'call items',
  },
  incomingCalls: {
    singular: 'caller',
    plural: 'callers',
  },
  outgoingCalls: {
    singular: 'callee',
    plural: 'callees',
  },
}

/**
 * 用于 LSP 结果摘要的可复用组件，支持折叠/展开视图
 */
function LSPResultSummary({
  operation,
  resultCount,
  fileCount,
  content,
  verbose,
}: {
  operation: keyof typeof OPERATION_LABELS
  resultCount: number
  fileCount: number
  content: string
  verbose: boolean
}) {
  const labelConfig = OPERATION_LABELS[operation] || {
    singular: tSync('lsp.result_one'),
    plural: tSync('lsp.result_other'),
  }
  const countLabel = resultCount === 1 ? labelConfig.singular : labelConfig.plural
  const primaryText =
    operation === 'hover' && resultCount > 0 && labelConfig.special ? (
      <Text>{tSync('lsp.hoverAvailable')}</Text>
    ) : (
      <Text>
        {tSync('lsp.found')} <Text bold={true}>{resultCount} </Text>
        {countLabel}
      </Text>
    )
  const secondaryText =
    fileCount > 1 ? (
      <Text>
        {' '}
        {tSync('lsp.across')} <Text bold={true}>{fileCount} </Text>
        {tSync('lsp.files')}
      </Text>
    ) : null
  if (verbose) {
    return (
      <Box flexDirection="column">
        {
          <Box flexDirection="row">
            <Text>
              {<Text dimColor={true}>  ⎿  </Text>}
              {primaryText}
              {secondaryText}
            </Text>
          </Box>
        }
        {
          <Box marginLeft={5}>
            <Text>{content}</Text>
          </Box>
        }
      </Box>
    )
  }
  return (
    <MessageResponse height={1}>
      <Text>
        {primaryText}
        {secondaryText} {resultCount > 0 && <CtrlOToExpand />}
      </Text>
    </MessageResponse>
  )
}
export function userFacingName(): string {
  return tSync('lsp.search')
}
export function renderToolUseMessage(
  input: Partial<Input>,
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode {
  if (!input.operation) {
    return null
  }
  const parts: string[] = []

  // 对于基于位置的操作（goToDefinition、findReferences、hover、goToImplementation），显示该位置的符号以提供更好的上下文
  if (
    (input.operation === 'goToDefinition' ||
      input.operation === 'findReferences' ||
      input.operation === 'hover' ||
      input.operation === 'goToImplementation') &&
    input.filePath &&
    input.line !== undefined &&
    input.character !== undefined
  ) {
    // 从基于 1 的索引（用户输入）转换为基于 0 的索引（内部文件读取）
    const symbol = getSymbolAtPosition(input.filePath, input.line - 1, input.character - 1)
    const displayPath = verbose ? input.filePath : getDisplayPath(input.filePath)
    if (symbol) {
      parts.push(`operation: "${input.operation}"`)
      parts.push(`symbol: "${symbol}"`)
      parts.push(`in: "${displayPath}"`)
    } else {
      parts.push(`operation: "${input.operation}"`)
      parts.push(`file: "${displayPath}"`)
      parts.push(`position: ${input.line}:${input.character}`)
    }
    return parts.join(', ')
  }

  // 对于其他操作（documentSymbol、workspaceSymbol），显示操作和文件，不显示位置详情
  parts.push(`operation: "${input.operation}"`)
  if (input.filePath) {
    const displayPath = verbose ? input.filePath : getDisplayPath(input.filePath)
    parts.push(`file: "${displayPath}"`)
  }
  return parts.join(', ')
}
export function renderToolUseErrorMessage(
  result: ToolResultBlock['content'],
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode {
  if (!verbose && typeof result === 'string' && extractTag(result, 'tool_use_error')) {
    return (
      <MessageResponse>
        <Text color="error">{tSync('lsp.operationFailed')}</Text>
      </MessageResponse>
    )
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown[],
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode {
  // Use collapsed/expanded view if we have count information
  if (output.resultCount !== undefined && output.fileCount !== undefined) {
    return (
      <LSPResultSummary
        operation={output.operation}
        resultCount={output.resultCount}
        fileCount={output.fileCount}
        content={output.result}
        verbose={verbose}
      />
    )
  }

  // 计数不可用时的错误情况回退（例如 LSP 服务器初始化失败、请求错误）
  return (
    <MessageResponse>
      <Text>{output.result}</Text>
    </MessageResponse>
  )
}
