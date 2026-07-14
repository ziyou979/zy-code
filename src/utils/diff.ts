import { type StructuredPatchHunk, structuredPatch } from 'diff'

import { logEvent } from 'src/services/analytics/index.js'
import { getLocCounter } from 'src/bootstrap/runtime/runtimeContext.js'
import { addToTotalLinesChanged } from '../cost-tracker.js'
import type { FileEdit } from '../tools/FileEditTool/types.js'
import { count } from './array.js'
import { convertLeadingTabsToSpaces } from './file.js'

export const CONTEXT_LINES = 3
export const DIFF_TIMEOUT_MS = 5_000

/**
 * 将 hunk 行号偏移指定量。当 getPatchForDisplay 接收的是文件的一个片段
 * （如 readEditContext）而非整个文件时使用——调用方传入 `ctx.lineOffset - 1`
 * 以将片段相对行号转换为文件相对行号。
 */
export function adjustHunkLineNumbers(
  hunks: StructuredPatchHunk[],
  offset: number,
): StructuredPatchHunk[] {
  if (offset === 0) {
    return hunks
  }
  return hunks.map((h) => ({
    ...h,
    oldStart: h.oldStart + offset,
    newStart: h.newStart + offset,
  }))
}

// 由于某些原因，& 符号会导致 diff 库产生混乱，所以我们先用 token 替换它，
// 在 diff 计算完成后再替换回来。
const AMPERSAND_TOKEN = '<<:AMPERSAND_TOKEN:>>'

const DOLLAR_TOKEN = '<<:DOLLAR_TOKEN:>>'

function escapeForDiff(s: string): string {
  return s.replaceAll('&', AMPERSAND_TOKEN).replaceAll('$', DOLLAR_TOKEN)
}

function unescapeFromDiff(s: string): string {
  return s.replaceAll(AMPERSAND_TOKEN, '&').replaceAll(DOLLAR_TOKEN, '$')
}

/**
 * 统计 patch 中新增和删除的行数，并更新总计
 * 对于新文件，将内容字符串作为第二个参数传入
 * @param patch diff hunk 数组
 * @param newFileContent 新文件的可选内容字符串
 */
export function countLinesChanged(patch: StructuredPatchHunk[], newFileContent?: string): void {
  let numAdditions = 0
  let numRemovals = 0

  if (patch.length === 0 && newFileContent) {
    // 对于新文件，将所有行计为新增
    numAdditions = newFileContent.split(/\r?\n/).length
  } else {
    numAdditions = patch.reduce(
      (acc, hunk) => acc + count(hunk.lines, (line: string) => line.startsWith('+')),
      0,
    )
    numRemovals = patch.reduce(
      (acc, hunk) => acc + count(hunk.lines, (line: string) => line.startsWith('-')),
      0,
    )
  }

  addToTotalLinesChanged(numAdditions, numRemovals)

  getLocCounter()?.add(numAdditions, { type: 'added' })
  getLocCounter()?.add(numRemovals, { type: 'removed' })

  logEvent('zy_file_changed', {
    lines_added: numAdditions,
    lines_removed: numRemovals,
  })
}

export function getPatchFromContents({
  filePath,
  oldContent,
  newContent,
  ignoreWhitespace = false,
  singleHunk = false,
}: {
  filePath: string
  oldContent: string
  newContent: string
  ignoreWhitespace?: boolean
  singleHunk?: boolean
}): StructuredPatchHunk[] {
  const result = structuredPatch(
    filePath,
    filePath,
    escapeForDiff(oldContent),
    escapeForDiff(newContent),
    undefined,
    undefined,
    {
      ignoreWhitespace,
      context: singleHunk ? 100_000 : CONTEXT_LINES,
      timeout: DIFF_TIMEOUT_MS,
    } as Record<string, unknown>,
  )
  if (!result) {
    return []
  }
  return result.hunks.map((hunk) => ({
    ...hunk,
    lines: hunk.lines.map(unescapeFromDiff),
  }))
}

/**
 * 获取应用编辑后用于展示的 patch
 * @param filePath 文件路径
 * @param fileContents 文件内容
 * @param edits 要应用于文件的编辑数组
 * @param ignoreWhitespace 是否忽略空白字符变更
 * @returns 表示 diff 的 hunk 数组
 *
 * 注意：此函数返回的 diff 会将所有前导 tab 渲染为空格以便展示
 */

export function getPatchForDisplay({
  filePath,
  fileContents,
  edits,
  ignoreWhitespace = false,
}: {
  filePath: string
  fileContents: string
  edits: FileEdit[]
  ignoreWhitespace?: boolean
}): StructuredPatchHunk[] {
  const preparedFileContents = escapeForDiff(convertLeadingTabsToSpaces(fileContents))
  const result = structuredPatch(
    filePath,
    filePath,
    preparedFileContents,
    edits.reduce((p, edit) => {
      const { old_string, new_string } = edit
      const replace_all = 'replace_all' in edit ? edit.replace_all : false
      const escapedOldString = escapeForDiff(convertLeadingTabsToSpaces(old_string))
      const escapedNewString = escapeForDiff(convertLeadingTabsToSpaces(new_string))

      if (replace_all) {
        return p.replaceAll(escapedOldString, () => escapedNewString)
      } else {
        return p.replace(escapedOldString, () => escapedNewString)
      }
    }, preparedFileContents),
    undefined,
    undefined,
    {
      context: CONTEXT_LINES,
      ignoreWhitespace,
      timeout: DIFF_TIMEOUT_MS,
    } as Record<string, unknown>,
  )
  if (!result) {
    return []
  }
  return result.hunks.map((hunk) => ({
    ...hunk,
    lines: hunk.lines.map(unescapeFromDiff),
  }))
}
