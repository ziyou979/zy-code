import { POINTER } from '../../constants/figures.js'
import { COMMAND_MESSAGE_TAG } from '../../constants/xml.js'
import { Box, Text } from '../../ink/index.js'
import type { TextBlock } from '../../types/llm.js'
import { extractTag } from '../../services/messages/./predicates.js'

type Props = {
  addMargin: boolean
  param: TextBlock
}
export function UserCommandMessage({ addMargin, param: textBlock }: Props) {
  const { text } = textBlock
  const commandMessage = extractTag(text, COMMAND_MESSAGE_TAG)
  const args = extractTag(text, 'command-args')
  const isSkillFormat = extractTag(text, 'skill-format') === 'true'
  if (!commandMessage) {
    return null
  }
  if (isSkillFormat) {
    return (
      <Box
        flexDirection="column"
        marginTop={addMargin ? 1 : 0}
        backgroundColor="userMessageBackground"
        paddingRight={1}
      >
        {
          <Text>
            {<Text color="subtle">{POINTER} </Text>}
            <Text color="text">Skill({commandMessage})</Text>
          </Text>
        }
      </Box>
    )
  }
  const commandParts = [commandMessage, args].filter(Boolean)
  const content = `/${commandParts.join(' ')}`
  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      backgroundColor="userMessageBackground"
      paddingRight={1}
    >
      {
        <Text>
          {<Text color="subtle">{POINTER} </Text>}
          <Text color="text">{content}</Text>
        </Text>
      }
    </Box>
  )
}
