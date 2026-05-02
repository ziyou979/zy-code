import type { TextBlock } from '../../types/llm.js'
import figures from 'figures'
import * as React from 'react'
import { COMMAND_MESSAGE_TAG } from '../../constants/xml.js'
import { Box, Text } from '../../ink.js'
import { extractTag } from '../../utils/messages.js'
type Props = {
  addMargin: boolean
  param: TextBlock
}
export function UserCommandMessage({ addMargin, param: t1 }: Props) {
  const { text } = t1
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
            {<Text color="subtle">{figures.pointer} </Text>}
            <Text color="text">Skill({commandMessage})</Text>
          </Text>
        }
      </Box>
    )
  }
  const t4 = [commandMessage, args].filter(Boolean)
  const content = `/${t4.join(' ')}`
  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      backgroundColor="userMessageBackground"
      paddingRight={1}
    >
      {
        <Text>
          {<Text color="subtle">{figures.pointer} </Text>}
          <Text color="text">{content}</Text>
        </Text>
      }
    </Box>
  )
}
