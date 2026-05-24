import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { truncate } from '../../utils/format.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { formatModelAndProvider, getLogoDisplayData, truncatePath } from '../../utils/logoUtils.js'
import { renderModelSetting } from '../../services/model/model.js'
import { OffscreenFreeze } from '../OffscreenFreeze.js'
import { AnimatedZy } from './AnimatedZy.js'
import { Zy } from './Zy.js'
export function CondensedLogo() {
  const { columns } = useTerminalSize()
  const agent = useAppState((s) => s.agent)
  const model = useMainLoopModel()
  const modelDisplayName = renderModelSetting(model)
  const { version, cwd, providerName, agentName: agentNameFromSettings } = getLogoDisplayData()
  const agentName = agent ?? agentNameFromSettings
  const textWidth = Math.max(columns - 15, 20)
  const truncatedVersion = truncate(version, Math.max(textWidth - 13, 6))
  const { shouldSplit, truncatedModel, truncatedProvider } = formatModelAndProvider(
    modelDisplayName,
    providerName,
    textWidth,
  )
  const cwdAvailableWidth = agentName ? textWidth - 1 - stringWidth(agentName) - 3 : textWidth
  const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10))
  const logoElement = isFullscreenEnvEnabled() ? <AnimatedZy /> : <Zy />
  return (
    <OffscreenFreeze>
      <Box flexDirection="row" gap={2} alignItems="center">
        {logoElement}
        <Box flexDirection="column">
          {
            <Text>
              {<Text bold={true}>ZY Code</Text>} <Text dimColor={true}>v{truncatedVersion}</Text>
            </Text>
          }
          {shouldSplit ? (
            <>
              <Text dimColor={true}>{truncatedModel}</Text>
              <Text dimColor={true}>{truncatedProvider}</Text>
            </>
          ) : (
            <Text dimColor={true}>
              {truncatedModel} · {truncatedProvider}
            </Text>
          )}
          {
            <Text dimColor={true}>
              {agentName ? `@${agentName} · ${truncatedCwd}` : truncatedCwd}
            </Text>
          }
        </Box>
      </Box>
    </OffscreenFreeze>
  )
}
