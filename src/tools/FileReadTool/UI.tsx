import * as React from 'react'
import { extractTag } from 'src/services/messages/predicates.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { FilePathLink } from '../../components/FilePathLink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { tSync } from '../../i18n/index.js'
import { Text } from '../../ink.js'
import { getTaskOutputDir } from '../../services/task-runtime/diskOutput.js'
import type { ToolResultBlock } from '../../types/llm.js'
import { FILE_NOT_FOUND_CWD_NOTE, getDisplayPath } from '../../utils/file.js'
import { formatFileSize } from '../../utils/format.js'
import { getPlansDirectory } from '../../utils/plans.js'
import type { Input, Output } from './FileReadTool.js'

/**
 * 检查文件路径是否为代理输出文件并提取任务 ID。代理输出文件遵循模式：{projectTempDir}/tasks/{taskId}.output
 */
function getAgentOutputTaskId(filePath: string): string | null {
  const prefix = `${getTaskOutputDir()}/`
  const suffix = '.output'
  if (filePath.startsWith(prefix) && filePath.endsWith(suffix)) {
    const taskId = filePath.slice(prefix.length, -suffix.length)
    // 校验是否符合任务 ID 格式（字母数字，合理长度）
    if (taskId.length > 0 && taskId.length <= 20 && /^[a-zA-Z0-9_-]+$/.test(taskId)) {
      return taskId
    }
  }
  return null
}
export function renderToolUseMessage(
  { file_path, offset, limit, pages }: Partial<Input>,
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode {
  if (!file_path) {
    return null
  }

  // 对于代理输出文件，返回空字符串以不显示括号
  // 任务 ID 由 AssistantToolUseMessage 单独显示
  if (getAgentOutputTaskId(file_path)) {
    return ''
  }
  const displayPath = verbose ? file_path : getDisplayPath(file_path)
  if (pages) {
    return (
      <>
        <FilePathLink filePath={file_path}>{displayPath}</FilePathLink>
        {` · pages ${pages}`}
      </>
    )
  }
  if (verbose && (offset || limit)) {
    const startLine = offset ?? 1
    const lineRange = limit
      ? `lines ${startLine}-${startLine + limit - 1}`
      : `from line ${startLine}`
    return (
      <>
        <FilePathLink filePath={file_path}>{displayPath}</FilePathLink>
        {` · ${lineRange}`}
      </>
    )
  }
  return <FilePathLink filePath={file_path}>{displayPath}</FilePathLink>
}
export function renderToolUseTag({ file_path }: Partial<Input>): React.ReactNode {
  const agentTaskId = file_path ? getAgentOutputTaskId(file_path) : null

  // 读取代理输出时，为 Read 工具显示代理任务 ID
  if (!agentTaskId) {
    return null
  }
  return <Text dimColor> {agentTaskId}</Text>
}
export function renderToolResultMessage(output: Output): React.ReactNode {
  // TODO: 递归渲染
  switch (output.type) {
    case 'image': {
      const { originalSize } = output.file
      const formattedSize = formatFileSize(originalSize)
      return (
        <MessageResponse height={1}>
          <Text>{tSync('fileRead.readImage', { size: formattedSize })}</Text>
        </MessageResponse>
      )
    }
    case 'notebook': {
      const { cells } = output.file
      if (!cells || cells.length < 1) {
        return <Text color="error">{tSync('fileRead.noCellsFound')}</Text>
      }
      return (
        <MessageResponse height={1}>
          <Text>{tSync('fileRead.readCells', { count: cells.length })}</Text>
        </MessageResponse>
      )
    }
    case 'pdf': {
      const { originalSize } = output.file
      const formattedSize = formatFileSize(originalSize)
      return (
        <MessageResponse height={1}>
          <Text>{tSync('fileRead.readPdf', { size: formattedSize })}</Text>
        </MessageResponse>
      )
    }
    case 'parts': {
      return (
        <MessageResponse height={1}>
          <Text>
            {tSync('fileRead.read')} <Text bold>{output.file.count}</Text>{' '}
            {tSync(output.file.count === 1 ? 'fileRead.readPages_one' : 'fileRead.readPages_other')}{' '}
            ({formatFileSize(output.file.originalSize)})
          </Text>
        </MessageResponse>
      )
    }
    case 'text': {
      const { numLines } = output.file
      return (
        <MessageResponse height={1}>
          <Text>
            {tSync('fileRead.read')} <Text bold>{numLines}</Text>{' '}
            {tSync(numLines === 1 ? 'fileRead.readLines_one' : 'fileRead.readLines_other')}
          </Text>
        </MessageResponse>
      )
    }
    case 'file_unchanged': {
      return (
        <MessageResponse height={1}>
          <Text dimColor>{tSync('fileRead.unchanged')}</Text>
        </MessageResponse>
      )
    }
  }
}
export function renderToolUseErrorMessage(
  result: ToolResultBlock['content'],
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode {
  if (!verbose && typeof result === 'string') {
    // FileReadTool 从 call() 抛出错误，因此错误缺少 <tool_use_error> 包装 — 直接检查原始字符串中的 cwd 提示标记。
    if (result.includes(FILE_NOT_FOUND_CWD_NOTE)) {
      return (
        <MessageResponse>
          <Text color="error">{tSync('fileRead.notFound')}</Text>
        </MessageResponse>
      )
    }
    if (extractTag(result, 'tool_use_error')) {
      return (
        <MessageResponse>
          <Text color="error">{tSync('fileRead.errorReading')}</Text>
        </MessageResponse>
      )
    }
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
export function userFacingName(input: Partial<Input> | undefined): string {
  if (input?.file_path?.startsWith(getPlansDirectory())) {
    return tSync('fileRead.readingPlan')
  }
  if (input?.file_path && getAgentOutputTaskId(input.file_path)) {
    return tSync('fileRead.readAgentOutput')
  }
  return tSync('fileRead.read')
}
export function getToolUseSummary(input: Partial<Input> | undefined): string | null {
  if (!input?.file_path) {
    return null
  }
  // 对于代理输出文件，仅显示任务 ID
  const agentTaskId = getAgentOutputTaskId(input.file_path)
  if (agentTaskId) {
    return agentTaskId
  }
  return getDisplayPath(input.file_path)
}
