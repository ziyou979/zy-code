/** 图像在原始内容与终端显示之间的尺寸映射。 */
export type ImageDimensions = {
  originalWidth?: number
  originalHeight?: number
  displayWidth?: number
  displayHeight?: number
}

/** 文本输入框中暂存的文本或图像内容。 */
export type PastedContent = {
  id: number
  type: 'text' | 'image'
  content: string
  mediaType?: string
  filename?: string
  dimensions?: ImageDimensions
  sourcePath?: string
}

/** 可恢复的结构化输入历史。 */
export interface HistoryEntry {
  display: string
  pastedContents: Record<number, PastedContent>
}
