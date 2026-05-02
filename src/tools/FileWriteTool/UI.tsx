import type { ToolResultBlock } from '../../types/llm.js'
type StructuredPatchHunk = any
import { isAbsolute, relative, resolve } from 'path'
import * as React from 'react'
import { Suspense, use, useState } from 'react'
import { MessageResponse } from 'src/components/MessageResponse.js'
import { extractTag } from 'src/utils/messages.js'
import { tSync } from '../../i18n/index.js'
import { CtrlOToExpand } from '../../components/CtrlOToExpand.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { FileEditToolUpdatedMessage } from '../../components/FileEditToolUpdatedMessage.js'
import { FileEditToolUseRejectedMessage } from '../../components/FileEditToolUseRejectedMessage.js'
import { FilePathLink } from '../../components/FilePathLink.js'
import { HighlightedCode } from '../../components/HighlightedCode.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import type { ToolProgressData } from '../../Tool.js'
import type { ProgressMessage } from '../../types/message.js'
import { getCwd } from '../../utils/cwd.js'
import { getPatchForDisplay } from '../../utils/diff.js'
import { getDisplayPath } from '../../utils/file.js'
import { logError } from '../../utils/log.js'
import { getPlansDirectory } from '../../utils/plans.js'
import { openForScan, readCapped } from '../../utils/readEditContext.js'
import type { Output } from './FileWriteTool.js'
const MAX_LINES_TO_RENDER = 10
// 模型输出始终使用 \n，与平台无关，因此始终按 \n 分割。
// Windows 上 os.EOL 为 \r\n，这会导致所有文件的 numLines=1。
const EOL = '\n'

/**
 * 统计文件内容中的可见行数。尾随换行符被视为行终止符（而非新的空行），与编辑器行号一致。
 */
export function countLines(content: string): number {
  const parts = content.split(EOL)
  return content.endsWith(EOL) ? parts.length - 1 : parts.length
}
function FileWriteToolCreatedMessage({ filePath, content, verbose }) {
  const { columns } = useTerminalSize()
  const contentWithFallback = content || tSync('fileWrite.noContent')
  const numLines = countLines(content)
  const plusLines = numLines - MAX_LINES_TO_RENDER
  const displayPath = verbose ? filePath : relative(getCwd(), filePath)
  const displayContent = verbose
    ? contentWithFallback
    : contentWithFallback.split('\n').slice(0, MAX_LINES_TO_RENDER).join('\n')
  return (
    <MessageResponse>
      <Box flexDirection="column">
        {
          <Text>
            {tSync('fileWrite.wrote')} {<Text bold={true}>{numLines}</Text>}{' '}
            {tSync('fileWrite.linesTo')} {<Text bold={true}>{displayPath}</Text>}
          </Text>
        }
        {
          <Box flexDirection="column">
            <HighlightedCode code={displayContent} filePath={filePath} width={columns - 12} />
          </Box>
        }
        {!verbose && plusLines > 0 && (
          <Text dimColor={true}>
            …{' '}
            {tSync('fileWrite.plusLines', {
              count: plusLines,
              unit: tSync(
                plusLines === 1 ? 'fileWrite.plusLines_one' : 'fileWrite.plusLines_other',
              ),
            })}{' '}
            {numLines > 0 && <CtrlOToExpand />}
          </Text>
        )}
      </Box>
    </MessageResponse>
  )
}
export function userFacingName(
  input:
    | Partial<{
        file_path: string
        content: string
      }>
    | undefined,
): string {
  if (input?.file_path?.startsWith(getPlansDirectory())) {
    return tSync('fileWrite.updatedPlan')
  }
  return tSync('fileWrite.write')
}

/** 控制全屏点击展开。只有 `create` 会截断（至 MAX_LINES_TO_RENDER）；`update` 无论 verbose 如何都渲染完整 diff。在悬停/滚动时对每个可见消息调用，因此找到第 (MAX+1) 行后即提前退出，而不是拆分整个（可能很大的）内容。 */
export function isResultTruncated({ type, content }: Output): boolean {
  if (type !== 'create') return false
  let pos = 0
  for (let i = 0; i < MAX_LINES_TO_RENDER; i++) {
    pos = content.indexOf(EOL, pos)
    if (pos === -1) return false
    pos++
  }
  // countLines treats a trailing EOL as a terminator, not a new line
  return pos < content.length
}
export function getToolUseSummary(
  input:
    | Partial<{
        file_path: string
        content: string
      }>
    | undefined,
): string | null {
  if (!input?.file_path) {
    return null
  }
  return getDisplayPath(input.file_path)
}
export function renderToolUseMessage(
  input: Partial<{
    file_path: string
    content: string
  }>,
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode {
  if (!input.file_path) {
    return null
  }
  // 对于 Plan 文件，路径已包含在 userFacingName 中
  if (input.file_path.startsWith(getPlansDirectory())) {
    return ''
  }
  return (
    <FilePathLink filePath={input.file_path}>
      {verbose ? input.file_path : getDisplayPath(input.file_path)}
    </FilePathLink>
  )
}
export function renderToolUseRejectedMessage(
  {
    file_path,
    content,
  }: {
    file_path: string
    content: string
  },
  {
    style,
    verbose,
  }: {
    style?: 'condensed'
    verbose: boolean
  },
): React.ReactNode {
  return (
    <WriteRejectionDiff filePath={file_path} content={content} style={style} verbose={verbose} />
  )
}
type RejectionDiffData =
  | {
      type: 'create'
    }
  | {
      type: 'update'
      patch: StructuredPatchHunk[]
      oldContent: string
    }
  | {
      type: 'error'
    }
function WriteRejectionDiff({ filePath, content, style, verbose }) {
  const [dataPromise] = useState(() => loadRejectionDiff(filePath, content))
  const firstLine = content.split('\n')[0] ?? null
  const createFallback = (
    <FileEditToolUseRejectedMessage
      file_path={filePath}
      operation="write"
      content={content}
      firstLine={firstLine}
      verbose={verbose}
    />
  )
  return (
    <Suspense fallback={createFallback}>
      {
        <WriteRejectionBody
          promise={dataPromise}
          filePath={filePath}
          firstLine={firstLine}
          createFallback={createFallback}
          style={style}
          verbose={verbose}
        />
      }
    </Suspense>
  )
}
function WriteRejectionBody({ promise, filePath, firstLine, createFallback, style, verbose }) {
  const data: any = use(promise)
  if (data.type === 'create') {
    return createFallback
  }
  if (data.type === 'error') {
    return (
      <MessageResponse>
        <Text>{tSync('fileWrite.noChanges')}</Text>
      </MessageResponse>
    )
  }
  return (
    <FileEditToolUseRejectedMessage
      file_path={filePath}
      operation="update"
      patch={data.patch}
      firstLine={firstLine}
      fileContent={data.oldContent}
      style={style}
      verbose={verbose}
    />
  )
}
async function loadRejectionDiff(filePath: string, content: string): Promise<RejectionDiffData> {
  try {
    const fullFilePath = isAbsolute(filePath) ? filePath : resolve(getCwd(), filePath)
    const handle = await openForScan(fullFilePath)
    if (handle === null)
      return {
        type: 'create',
      }
    let oldContent: string | null
    try {
      oldContent = await readCapped(handle)
    } finally {
      await handle.close()
    }
    // 文件超过 MAX_SCAN_BYTES — 回退到创建视图，避免对多 GB 文件做 diff 导致内存溢出。
    if (oldContent === null)
      return {
        type: 'create',
      }
    const patch = getPatchForDisplay({
      filePath,
      fileContents: oldContent,
      edits: [
        {
          old_string: oldContent,
          new_string: content,
          replace_all: false,
        },
      ],
    })
    return {
      type: 'update',
      patch,
      oldContent,
    }
  } catch (e) {
    // 用户可能在显示 diff 时手动应用了更改。
    logError(e as Error)
    return {
      type: 'error',
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
  if (!verbose && typeof result === 'string' && extractTag(result, 'tool_use_error')) {
    return (
      <MessageResponse>
        <Text color="error">{tSync('fileWrite.errorWriting')}</Text>
      </MessageResponse>
    )
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
export function renderToolResultMessage(
  { filePath, content, structuredPatch, type, originalFile }: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  {
    style,
    verbose,
  }: {
    style?: 'condensed'
    verbose: boolean
  },
): React.ReactNode {
  switch (type) {
    case 'create': {
      const isPlanFile = filePath.startsWith(getPlansDirectory())

      // 计划文件：反转压缩行为
      // - 常规模式：仅显示提示（用户可以输入 /plan 查看完整内容）
      // - 压缩模式（子代理视图）：显示完整内容
      if (isPlanFile && !verbose) {
        if (style !== 'condensed') {
          return (
            <MessageResponse>
              <Text dimColor>{tSync('fileWrite.planToPreview')}</Text>
            </MessageResponse>
          )
        }
      } else if (style === 'condensed' && !verbose) {
        const numLines = countLines(content)
        return (
          <Text>
            {tSync('fileWrite.wrote')} <Text bold>{numLines}</Text> {tSync('fileWrite.linesTo')}{' '}
            <Text bold>{relative(getCwd(), filePath)}</Text>
          </Text>
        )
      }
      return <FileWriteToolCreatedMessage filePath={filePath} content={content} verbose={verbose} />
    }
    case 'update': {
      const isPlanFile = filePath.startsWith(getPlansDirectory())
      return (
        <FileEditToolUpdatedMessage
          filePath={filePath}
          structuredPatch={structuredPatch}
          firstLine={content.split('\n')[0] ?? null}
          fileContent={originalFile ?? undefined}
          style={style}
          verbose={verbose}
          previewHint={isPlanFile ? tSync('fileWrite.planToPreview') : undefined}
        />
      )
    }
  }
}
