import React from 'react'
import { tSync } from 'src/i18n/index.js'
import { Box, Text } from '../../ink.js'
import { Byline } from '../design-system/Byline.js'
type Props = {
  serverToolsCount: number
  serverPromptsCount: number
  serverResourcesCount: number
}
export function CapabilitiesSection({
  serverToolsCount,
  serverPromptsCount,
  serverResourcesCount,
}: Props) {
  const capabilities = []
  if (serverToolsCount > 0) {
    capabilities.push(tSync('mcp.capabilityTools'))
  }
  if (serverResourcesCount > 0) {
    capabilities.push(tSync('mcp.capabilityResources'))
  }
  if (serverPromptsCount > 0) {
    capabilities.push(tSync('mcp.capabilityPrompts'))
  }
  return (
    <Box>
      {<Text bold={true}>{tSync('mcp.capabilitiesLabel')}</Text>}
      <Text color="text">
        {capabilities.length > 0 ? <Byline>{capabilities}</Byline> : tSync('mcp.capabilitiesNone')}
      </Text>
    </Box>
  )
}
