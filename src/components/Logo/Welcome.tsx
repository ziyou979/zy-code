import { Box, Text, useTheme } from 'src/ink/index.js'
import { env } from '../../services/environment/env.js'

const WELCOME_V2_WIDTH = 58

/**
 * Unified welcome pattern — Claude Code style with nebula clouds, ZY block text, and jellyfish mascot.
 */
function WelcomeContent({ separator }: { separator: string }) {
  // ZY block text (15 chars wide)
  const zy1 = '███████  ██  ██' // 15
  const zy2 = '      ██   ████' // 15
  const zy3 = '   ███      ██' // 14
  const zy4 = '  ██       ██' // 13
  const zy5 = '███████    ██' // 13

  return (
    <Box width={WELCOME_V2_WIDTH} flexDirection="column">
      <Text>
        <Text color="zy">{'Hello, ready to build?'} </Text>
        <Text dimColor={true}>v{MACRO.VERSION}</Text>
      </Text>
      <Text>{separator}</Text>
      <Text>{'                                                          '}</Text>
      <Text>
        {'       '}
        <Text bold={true}>*</Text>
        {`        ░░░░░░${' '.repeat(36)}`}
      </Text>
      <Text>{`    ░░░░░░░░░░${' '.repeat(22)}███▓▓░░░░░░${' '.repeat(11)}`}</Text>
      <Text>
        {'   ░░░░░░░░░░░░░░░░░░      *        '}
        <Text dimColor={true}>{`███▓▓░${' '.repeat(16)}`}</Text>
      </Text>
      <Text>{'                                                          '}</Text>
      <Text>
        {' '.repeat(21)}
        <Text color="clawd_body">{zy1}</Text>
        {' '.repeat(22)}
      </Text>
      <Text>
        {' '.repeat(21)}
        <Text color="clawd_body">{zy2}</Text>
        {' '.repeat(22)}
      </Text>
      <Text>
        {' '.repeat(21)}
        <Text color="clawd_body">{zy3}</Text>
        {' '.repeat(23)}
      </Text>
      <Text>
        {' '.repeat(21)}
        <Text color="clawd_body">{zy4}</Text>
        {' '.repeat(24)}
      </Text>
      <Text>
        {' '.repeat(21)}
        <Text color="clawd_body">{zy5}</Text>
        {' '.repeat(24)}
      </Text>
      <Text>{'                                                          '}</Text>
      <Text>
        {' '.repeat(10)}
        <Text color="clawd_body">{'  ▄▀▀▀▀▀▀▀▄  '}</Text>
        {' '.repeat(24)}
        <Text dimColor={true}>*</Text>
        {' '.repeat(9)}
      </Text>
      <Text>
        {' '.repeat(10)}
        <Text color="clawd_body">{' █  ●   ●  █ '}</Text>
        {' '.repeat(34)}
      </Text>
      <Text>
        {' '.repeat(10)}
        <Text color="clawd_body">{'  █  ▀▀▀  █  '}</Text>
        {' '.repeat(34)}
      </Text>
      <Text>
        {' '.repeat(10)}
        <Text color="clawd_body">{'  ▀▄     ▄▀  '}</Text>
        {' '.repeat(18)}
        <Text bold={true}>*</Text>
        {' '.repeat(15)}
      </Text>
      <Text>
        {' '.repeat(10)}
        <Text color="clawd_body">{'   ▀▄▀▀▀▄▀   '}</Text>
        {' '.repeat(34)}
      </Text>
      <Text>{'                                                          '}</Text>
      <Text>{separator}</Text>
    </Box>
  )
}

export function Welcome() {
  const [theme] = useTheme()
  const isLight = ['light', 'light-daltonized', 'light-ansi'].includes(theme)
  const separator = isLight
    ? '──────────────────────────────────────────────────────────'
    : '……………………………………………………………………………………………………'

  if (env.terminal === 'Apple_Terminal') {
    return <AppleTerminalWelcome theme={theme} welcomeMessage="Hello, ready to build?" />
  }

  return <WelcomeContent separator={separator} />
}

type AppleTerminalWelcomeProps = {
  theme: string
  welcomeMessage: string
}

function AppleTerminalWelcome({ theme, welcomeMessage }: AppleTerminalWelcomeProps) {
  const isLightTheme = ['light', 'light-daltonized', 'light-ansi'].includes(theme)
  const separator = isLightTheme
    ? '──────────────────────────────────────────────────────────'
    : '……………………………………………………………………………………………………'

  return <WelcomeContent separator={separator} />
}
