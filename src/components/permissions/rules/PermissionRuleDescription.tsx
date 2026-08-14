import { Text } from '../../../ink/index.js'
import { BashTool } from '../../../tools/BashTool/BashTool.js'
import type { PermissionRuleValue } from 'src/types/permissions.js'

type RuleSubtitleProps = {
  ruleValue: PermissionRuleValue
}
export function PermissionRuleDescription({ ruleValue }: RuleSubtitleProps) {
  switch (ruleValue.toolName) {
    case BashTool.name: {
      if (ruleValue.ruleContent) {
        if (ruleValue.ruleContent.endsWith(':*')) {
          const commandPrefix = ruleValue.ruleContent.slice(0, -2)
          return (
            <Text dimColor={true}>
              Any Bash command starting with <Text bold={true}>{commandPrefix}</Text>
            </Text>
          )
        } else {
          return (
            <Text dimColor={true}>
              The Bash command <Text bold={true}>{ruleValue.ruleContent}</Text>
            </Text>
          )
        }
      } else {
        return <Text dimColor={true}>Any Bash command</Text>
      }
    }
    default: {
      if (!ruleValue.ruleContent) {
        return (
          <Text dimColor={true}>
            Any use of the <Text bold={true}>{ruleValue.toolName}</Text> tool
          </Text>
        )
      } else {
        return null
      }
    }
  }
}
