import type { StructuredPatchHunk } from 'diff'
import * as React from 'react'
import { Suspense, use, useState } from 'react'
import { FileEditToolUseRejectedMessage } from 'src/components/FileEditToolUseRejectedMessage.js'
import { MessageResponse } from 'src/components/MessageResponse.js'
import { extractTag } from 'src/services/messages/predicates.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { FileEditToolUpdatedMessage } from '../../components/FileEditToolUpdatedMessage.js'
import { FilePathLink } from '../../components/FilePathLink.js'
import { tSync } from '../../i18n/index.js'
import { Text } from '../../ink/index.js'
import type { Tools } from '../../tools/tool.js'
import type { ToolResultBlock } from '../../types/llm.js'
import type { Message, ProgressMessage } from '../../types/message.js'
import { adjustHunkLineNumbers, CONTEXT_LINES } from '../../utils/diff.js'
import { FILE_NOT_FOUND_CWD_NOTE, getDisplayPath } from '../../utils/file.js'
import { logError } from '../../utils/log.js'
import { getPlansDirectory } from '../../utils/plans.js'
import { readEditContext } from '../../utils/readEditContext.js'
import { firstLineOf } from '../../utils/stringUtils.js'
import type { ThemeName } from '../../utils/theme.js'
import type { FileEditOutput } from './types.js'
import { findActualString, getPatchForEdit, preserveQuoteStyle } from './utils.js'
export function userFacingName(
  input:
    | Partial<{
        file_path: string
        old_string: string
        new_string: string
        replace_all: boolean
        edits: unknown[]
      }>
    | undefined,
): string {
  if (!input) {
    return tSync('fileEdit.update')
  }
  if (input.file_path?.startsWith(getPlansDirectory())) {
    return tSync('fileWrite.updatedPlan')
  }
  // Hashline edits always modify an existing file (line-ref based)
  if (input.edits != null) {
    return tSync('fileEdit.update')
  }
  if (input.old_string === '') {
    return tSync('fileEdit.create')
  }
  return tSync('fileEdit.update')
}
export function getToolUseSummary(
  input:
    | Partial<{
        file_path: string
        old_string: string
        new_string: string
        replace_all: boolean
      }>
    | undefined,
): string | null {
  if (!input?.file_path) {
    return null
  }
  return getDisplayPath(input.file_path)
}
export function renderToolUseMessage(
  {
    file_path,
  }: {
    file_path?: string
  },
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode {
  if (!file_path) {
    return null
  }
  // 对于 Plan 文件，路径已包含在 userFacingName 中
  if (file_path.startsWith(getPlansDirectory())) {
    return ''
  }
  return (
    <FilePathLink filePath={file_path}>
      {verbose ? file_path : getDisplayPath(file_path)}
    </FilePathLink>
  )
}
export function renderToolResultMessage(
  { filePath, structuredPatch, originalFile }: FileEditOutput,
  _progressMessagesForMessage: ProgressMessage[],
  {
    style,
    verbose,
  }: {
    style?: 'condensed'
    verbose: boolean
  },
): React.ReactNode {
  // For plan files, show /plan hint above the diff
  const isPlanFile = filePath.startsWith(getPlansDirectory())
  return (
    <FileEditToolUpdatedMessage
      filePath={filePath}
      structuredPatch={structuredPatch}
      firstLine={originalFile.split('\n')[0] ?? null}
      fileContent={originalFile}
      style={style}
      verbose={verbose}
      previewHint={isPlanFile ? tSync('fileWrite.planHint') : undefined}
    />
  )
}
export function renderToolUseRejectedMessage(
  input: {
    file_path: string
    old_string?: string
    new_string?: string
    replace_all?: boolean
    edits?: unknown[]
  },
  options: {
    columns: number
    messages: Message[]
    progressMessagesForMessage: ProgressMessage[]
    style?: 'condensed'
    theme: ThemeName
    tools: Tools
    verbose: boolean
  },
): React.ReactElement {
  const { style, verbose } = options
  const filePath = input.file_path
  const oldString = input.old_string ?? ''
  const newString = input.new_string ?? ''
  const replaceAll = input.replace_all ?? false

  // 防御性处理：如果输入结构不符合预期，显示简单的拒绝消息
  if ('edits' in input && input.edits != null) {
    return (
      <FileEditToolUseRejectedMessage
        file_path={filePath}
        operation="update"
        firstLine={null}
        verbose={verbose}
      />
    )
  }
  const isNewFile = oldString === ''

  // 对于新文件创建，显示内容预览而非 diff
  if (isNewFile) {
    return (
      <FileEditToolUseRejectedMessage
        file_path={filePath}
        operation="write"
        content={newString}
        firstLine={firstLineOf(newString)}
        verbose={verbose}
      />
    )
  }
  return (
    <EditRejectionDiff
      filePath={filePath}
      oldString={oldString}
      newString={newString}
      replaceAll={replaceAll}
      style={style}
      verbose={verbose}
    />
  )
}
export function renderToolUseErrorMessage(
  result: ToolResultBlock['content'],
  options: {
    progressMessagesForMessage: ProgressMessage[]
    tools: Tools
    verbose: boolean
  },
): React.ReactElement {
  const { verbose } = options
  if (!verbose && typeof result === 'string' && extractTag(result, 'tool_use_error')) {
    const errorMessage = extractTag(result, 'tool_use_error')
    // 为预期行为显示更友好的提示
    if (errorMessage?.includes('File has not been read yet')) {
      return (
        <MessageResponse>
          <Text dimColor>{tSync('fileEdit.mustReadFirst')}</Text>
        </MessageResponse>
      )
    }
    if (errorMessage?.includes(FILE_NOT_FOUND_CWD_NOTE)) {
      return (
        <MessageResponse>
          <Text color="error">{tSync('fileEdit.fileNotFound')}</Text>
        </MessageResponse>
      )
    }
    return (
      <MessageResponse>
        <Text color="error">{tSync('fileEdit.errorEditing')}</Text>
      </MessageResponse>
    )
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
type RejectionDiffData = {
  patch: StructuredPatchHunk[]
  firstLine: string | null
  fileContent: string | undefined
}
function EditRejectionDiff({
  filePath,
  oldString,
  newString,
  replaceAll,
  style,
  verbose,
}: {
  filePath: string
  oldString: string
  newString: string
  replaceAll: boolean
  style?: 'condensed'
  verbose: boolean
}) {
  const [dataPromise] = useState(() =>
    loadRejectionDiff(filePath, oldString, newString, replaceAll),
  )
  return (
    <Suspense
      fallback={
        <FileEditToolUseRejectedMessage
          file_path={filePath}
          operation="update"
          firstLine={null}
          verbose={verbose}
        />
      }
    >
      {
        <EditRejectionBody
          promise={dataPromise}
          filePath={filePath}
          style={style}
          verbose={verbose}
        />
      }
    </Suspense>
  )
}
function EditRejectionBody({
  promise,
  filePath,
  style,
  verbose,
}: {
  promise: Promise<RejectionDiffData>
  filePath: string
  style?: 'condensed'
  verbose: boolean
}) {
  // biome-ignore lint/suspicious/noExplicitAny: React.use 对 Promise 的类型推断不完整
  const data = use(promise as Promise<any>) as RejectionDiffData
  return (
    <FileEditToolUseRejectedMessage
      file_path={filePath}
      operation="update"
      patch={data.patch}
      firstLine={data.firstLine}
      fileContent={data.fileContent}
      style={style}
      verbose={verbose}
    />
  )
}
async function loadRejectionDiff(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Promise<RejectionDiffData> {
  try {
    // 分块读取 — 围绕首次匹配的上下文窗口。replaceAll 仍然通过 getPatchForEdit 显示窗口内的匹配项；我们允许丢失所有匹配的视图以保持读取有界。
    const ctx = await readEditContext(filePath, oldString, CONTEXT_LINES)
    if (ctx === null || ctx.truncated || ctx.content === '') {
      // ENOENT / 未找到 / 被截断 — 仅对工具输入做 diff。
      const { patch } = getPatchForEdit({
        filePath,
        fileContents: oldString,
        oldString,
        newString,
      })
      return {
        patch,
        firstLine: null,
        fileContent: undefined,
      }
    }
    const actualOld = findActualString(ctx.content, oldString) || oldString
    const actualNew = preserveQuoteStyle(oldString, actualOld, newString)
    const { patch } = getPatchForEdit({
      filePath,
      fileContents: ctx.content,
      oldString: actualOld,
      newString: actualNew,
      replaceAll,
    })
    return {
      patch: adjustHunkLineNumbers(patch, ctx.lineOffset - 1),
      firstLine: ctx.lineOffset === 1 ? firstLineOf(ctx.content) : null,
      fileContent: ctx.content,
    }
  } catch (e) {
    // 用户可能在显示 diff 时手动应用了更改。
    logError(e as Error)
    return {
      patch: [],
      firstLine: null,
      fileContent: undefined,
    }
  }
}
