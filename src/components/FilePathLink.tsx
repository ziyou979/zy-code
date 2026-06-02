import { pathToFileURL } from 'node:url'
import React from 'react'
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
