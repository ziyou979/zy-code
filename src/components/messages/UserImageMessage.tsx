import { pathToFileURL } from 'node:url'
import Link from '../../ink/components/Link.js'
import { supportsHyperlinks } from '../../ink/supports-hyperlinks.js'
import { Box, Text } from '../../ink/index.js'
import { getStoredImagePath } from '../../utils/imageStore.js'
import { renderInlineImageFromFile } from '../../services/shell/terminalImage.js'
import { MessageResponse } from '../MessageResponse.js'

type Props = {
  imageId?: number
  addMargin?: boolean
}

/**
 * Renders an image attachment in user messages.
 * Shows inline image (iTerm2 OSC 1337) if supported,
 * falls back to a clickable hyperlink or plain text label.
 * Uses MessageResponse styling to appear connected to the message above,
 * unless addMargin is true (image starts a new user turn without text).
 */
export function UserImageMessage({ imageId, addMargin }: Props) {
  const label = imageId ? `[Image #${imageId}]` : '[Image]'
  const imagePath = imageId ? getStoredImagePath(imageId) : null

  if (imagePath) {
    const inline = renderInlineImageFromFile(imagePath)
    if (inline) {
      const content = <Text>{inline}</Text>
      if (addMargin) {
        return <Box marginTop={1}>{content}</Box>
      }
      return <MessageResponse>{content}</MessageResponse>
    }
  }

  const content =
    imagePath && supportsHyperlinks() ? (
      <Link url={pathToFileURL(imagePath).href}>
        <Text>{label}</Text>
      </Link>
    ) : (
      <Text>{label}</Text>
    )
  if (addMargin) {
    return <Box marginTop={1}>{content}</Box>
  }
  return <MessageResponse>{content}</MessageResponse>
}
