import React from 'react'
import { pathToFileURL } from 'url'
import { Ansi } from '../ink.js'
import Link from '../ink/components/Link.js'
type Props = {
  /** The absolute file path */
  filePath: string
  /** Optional display text (defaults to filePath) */
  children?: React.ReactNode
}

/**
 * Renders a file path as an OSC 8 hyperlink.
 * This helps terminals like iTerm correctly identify file paths
 * even when they appear inside parentheses or other text.
 */
export function FilePathLink({ filePath, children }: Props) {
  const fileUrl = pathToFileURL(filePath)
  return <Link url={fileUrl.href}>{children ?? filePath}</Link>
}

// 匹配文件路径 + 行号模式，如 src/foo.ts:123 或 /abs/path.go:10-20
const FILE_PATH_RE = /((?:(?:\.\.\/|\.\/|\/)?(?:[\w.-]+\/)*)[\w.-]+\.\w{1,10}):(\d+)(?:-(\d+))?/g

/** 将含文件路径引用的文本拆分为 Ansi/FilePathLink 混合节点 */
export function renderContentWithFileLinks(content: string, dimColor = false): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  FILE_PATH_RE.lastIndex = 0
  while ((match = FILE_PATH_RE.exec(content)) !== null) {
    // 渲染匹配前的纯文本
    if (match.index > lastIndex) {
      const before = content.slice(lastIndex, match.index)
      parts.push(
        <Ansi key={parts.length} dimColor={dimColor}>
          {before}
        </Ansi>,
      )
    }
    // 渲染文件路径 + 行号为可点击超链接
    const filePath = match[1]!
    const display = match[0]
    parts.push(
      <FilePathLink key={parts.length} filePath={filePath}>
        {display}
      </FilePathLink>,
    )
    lastIndex = match.index + display.length
  }

  // 渲染剩余部分
  if (lastIndex < content.length) {
    parts.push(
      <Ansi key={parts.length} dimColor={dimColor}>
        {content.slice(lastIndex)}
      </Ansi>,
    )
  }

  return parts
}
