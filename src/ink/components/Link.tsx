import type { ReactNode } from 'react'
import { supportsHyperlinks } from '../supports-hyperlinks.js'
import Text from './Text.js'
export type Props = {
  readonly children?: ReactNode
  readonly url: string
  readonly fallback?: ReactNode
}
export default function Link({ children, url, fallback }: Props) {
  const content = children ?? url
  if (supportsHyperlinks()) {
    return (
      <Text>
        {/* @ts-ignore */}
        <ink-link href={url}>{content}</ink-link>
      </Text>
    )
  }
  return <Text>{fallback ?? content}</Text>
}
