import { Box, Text } from 'src/ink/index.js'
import {
  AGENT_COLOR_TO_THEME_COLOR,
  AGENT_COLORS,
  type AgentColorName,
} from 'src/tools/AgentTool/agentColorManager.js'
import type { PromptInputMode } from 'src/types/textInputTypes.js'
import { getTeammateColor } from 'src/utils/teammate.js'
import type { Theme } from 'src/utils/theme.js'
import { POINTER } from '../../constants/figures.js'
import { isAgentSwarmsEnabled } from '../../services/swarm/agentSwarmsEnabled.js'

type Props = {
  mode: PromptInputMode
  isLoading: boolean
  viewingAgentName?: string
  viewingAgentColor?: AgentColorName
}

/**
 * Gets the theme color key for the teammate's assigned color.
 * Returns undefined if not a teammate or if the color is invalid.
 */
function getTeammateThemeColor(): keyof Theme | undefined {
  if (!isAgentSwarmsEnabled()) {
    return undefined
  }
  const colorName = getTeammateColor()
  if (!colorName) {
    return undefined
  }
  if (AGENT_COLORS.includes(colorName as AgentColorName)) {
    return AGENT_COLOR_TO_THEME_COLOR[colorName as AgentColorName]
  }
  return undefined
}
type PromptCharProps = {
  isLoading: boolean
  // Dead code elimination: parameter named themeColor to avoid "teammate" string in external builds
  themeColor?: keyof Theme
}

/**
 * Renders the prompt character (❯).
 * Teammate color overrides the default color when set.
 */
function PromptChar({ isLoading, themeColor }: PromptCharProps) {
  const teammateColor = themeColor
  const color = teammateColor ?? (false ? 'subtle' : undefined)
  return (
    <Text color={color} dimColor={isLoading}>
      {POINTER} 
    </Text>
  )
}
export function PromptInputModeIndicator({
  mode,
  isLoading,
  viewingAgentName,
  viewingAgentColor,
}: Props) {
  const teammateColor = getTeammateThemeColor()
  const viewedTeammateThemeColor = viewingAgentColor
    ? AGENT_COLOR_TO_THEME_COLOR[viewingAgentColor]
    : undefined
  return (
    <Box
      alignItems="flex-start"
      alignSelf="flex-start"
      flexWrap="nowrap"
      justifyContent="flex-start"
    >
      {viewingAgentName ? (
        <PromptChar isLoading={isLoading} themeColor={viewedTeammateThemeColor} />
      ) : mode === 'bash' ? (
        <Text color="bashBorder" dimColor={isLoading}>
          ! 
        </Text>
      ) : (
        <PromptChar
          isLoading={isLoading}
          themeColor={isAgentSwarmsEnabled() ? teammateColor : undefined}
        />
      )}
    </Box>
  )
}
