import {
  expandPastedTextRefs,
  getPastedTextRefNumLines,
  parseReferences,
} from 'src/services/session-storage/history.js'
import type { PastedContent } from 'src/services/config/config.js'

const TRUNCATION_THRESHOLD = 10000 // Characters before we truncate
const PREVIEW_LENGTH = 1000 // Characters to show at start and end

/**
 * 查找 pastedContents 中内容完全相同的文本粘贴 id（对齐 CC 2.1.207：
 * 再次粘贴相同长文本时展开已有 placeholder，而非新建第二条）。
 */
export function findExistingPastedTextId(
  text: string,
  pastedContents: Record<number, PastedContent>,
): number | undefined {
  for (const content of Object.values(pastedContents)) {
    if (content.type === 'text' && content.content === text) {
      return content.id
    }
  }
  return undefined
}

/**
 * 若 input 中已有指定 pasteId 的折叠引用，将其全部展开为 fullText。
 * 返回 null 表示 input 中不存在该 id 的 placeholder。
 */
export function expandExistingPasteRefsInInput(
  input: string,
  pasteId: number,
  fullText: string,
): string | null {
  const refs = parseReferences(input).filter((r) => r.id === pasteId)
  if (refs.length === 0) {
    return null
  }
  // 用单条记录驱动 expandPastedTextRefs，只展开匹配 id
  return expandPastedTextRefs(input, {
    [pasteId]: { id: pasteId, type: 'text', content: fullText },
  })
}

type TruncatedMessage = {
  truncatedText: string
  placeholderContent: string
}

/**
 * Determines whether the input text should be truncated. If so, it adds a
 * truncated text placeholder and neturns
 *
 * @param text The input text
 * @param nextPasteId The reference id to use
 * @returns The new text to display and separate placeholder content if applicable.
 */
export function maybeTruncateMessageForInput(text: string, nextPasteId: number): TruncatedMessage {
  // If the text is short enough, return it as-is
  if (text.length <= TRUNCATION_THRESHOLD) {
    return {
      truncatedText: text,
      placeholderContent: '',
    }
  }

  // Calculate how much text to keep from start and end
  const startLength = Math.floor(PREVIEW_LENGTH / 2)
  const endLength = Math.floor(PREVIEW_LENGTH / 2)

  // Extract the portions we'll keep
  const startText = text.slice(0, startLength)
  const endText = text.slice(-endLength)

  // Calculate the number of lines that will be truncated
  const placeholderContent = text.slice(startLength, -endLength)
  const truncatedLines = getPastedTextRefNumLines(placeholderContent)

  // Create a placeholder reference similar to pasted text
  const placeholderId = nextPasteId
  const placeholderRef = formatTruncatedTextRef(placeholderId, truncatedLines)

  // Combine the parts with the placeholder
  const truncatedText = startText + placeholderRef + endText

  return {
    truncatedText,
    placeholderContent,
  }
}

function formatTruncatedTextRef(id: number, numLines: number): string {
  return `[...Truncated text #${id} +${numLines} lines...]`
}

export function maybeTruncateInput(
  input: string,
  pastedContents: Record<number, PastedContent>,
): { newInput: string; newPastedContents: Record<number, PastedContent> } {
  // Get the next available ID for the truncated content
  const existingIds = Object.keys(pastedContents).map(Number)
  const nextPasteId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1

  // Apply truncation
  const { truncatedText, placeholderContent } = maybeTruncateMessageForInput(input, nextPasteId)

  if (!placeholderContent) {
    return { newInput: input, newPastedContents: pastedContents }
  }

  return {
    newInput: truncatedText,
    newPastedContents: {
      ...pastedContents,
      [nextPasteId]: {
        id: nextPasteId,
        type: 'text',
        content: placeholderContent,
      },
    },
  }
}
