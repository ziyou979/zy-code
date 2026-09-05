import { join } from 'node:path'
import React from 'react'
import { ExportDialog } from '../../components/ExportDialog.js'
import type { ToolUseContext } from '../../tools/tool.js'
import type { LocalJSXCommandOnDone } from '../types.js'
import type { Message } from '../../types/message.js'
import { getCwd } from '../../services/environment/cwd.js'
import { renderMessagesToPlainText } from '../../components/Runtime/ExportRenderer.js'
import { writeFileSync_DEPRECATED } from '../../services/infra/slowOperations.js'
import { formatFileTimestamp } from '../../utils/formatTimestamp.js'

// 文件名时间戳收敛到 utils/formatTimestamp.ts
const formatTimestamp = (date: Date): string => formatFileTimestamp(date)
export function extractFirstPrompt(messages: Message[]): string {
  const firstUserMessage = messages.find((msg) => msg.type === 'user')
  if (!firstUserMessage || firstUserMessage.type !== 'user') {
    return ''
  }
  const content = firstUserMessage.message?.content
  let result = ''
  if (Array.isArray(content)) {
    const textContent = content.find((item) => item.type === 'text')
    if (textContent && 'text' in textContent) {
      result = textContent.text.trim()
    }
  }

  // Take first line only and limit length
  result = result.split('\n')[0] || ''
  if (result.length > 50) {
    result = `${result.substring(0, 49)}…`
  }
  return result
}
export function sanitizeFilename(text: string): string {
  // Replace special characters with hyphens
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .replace(/^-|-$/g, '') // Remove leading/trailing hyphens
}
async function exportWithReactRenderer(context: ToolUseContext): Promise<string> {
  const tools = context.options.tools || []
  return renderMessagesToPlainText(context.messages, tools)
}
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext,
  args: string,
): Promise<React.ReactNode> {
  // Render the conversation content
  const content = await exportWithReactRenderer(context)

  // If args are provided, write directly to file and skip dialog
  const filename = args.trim()
  if (filename) {
    const finalFilename = filename.endsWith('.txt')
      ? filename
      : `${filename.replace(/\.[^.]+$/, '')}.txt`
    const filepath = join(getCwd(), finalFilename)
    try {
      writeFileSync_DEPRECATED(filepath, content, {
        encoding: 'utf-8',
        flush: true,
      })
      onDone(`Conversation exported to: ${filepath}`)
      return null
    } catch (error) {
      onDone(
        `Failed to export conversation: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
      return null
    }
  }

  // Generate default filename from first prompt or timestamp
  const firstPrompt = extractFirstPrompt(context.messages)
  const timestamp = formatTimestamp(new Date())
  let defaultFilename: string
  if (firstPrompt) {
    const sanitized = sanitizeFilename(firstPrompt)
    defaultFilename = sanitized ? `${timestamp}-${sanitized}.txt` : `conversation-${timestamp}.txt`
  } else {
    defaultFilename = `conversation-${timestamp}.txt`
  }

  // Return the dialog component when no args provided
  return (
    <ExportDialog
      content={content}
      defaultFilename={defaultFilename}
      onDone={(result) => {
        onDone(result.message)
      }}
    />
  )
}
