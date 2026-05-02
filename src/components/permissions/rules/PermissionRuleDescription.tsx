import * as React from 'react'
import { Text } from '../../../ink.js'
import { BashTool } from '../../../tools/BashTool/BashTool.js'
import type { PermissionRuleValue } from '../../../utils/permissions/PermissionRule.js'
type RuleSubtitleProps = {
  ruleValue: PermissionRuleValue
}
export function PermissionRuleDescription({ ruleValue }: RuleSubtitleProps) {
  switch (ruleValue.toolName) {
    case BashTool.name: {
      if (ruleValue.ruleContent) {
        if (ruleValue.ruleContent.endsWith(':*')) {
          let t1
          t1 = ruleValue.ruleContent.slice(0, -2)
          let t2
          t2 = (
            <Text dimColor={true}>
              Any Bash command starting with <Text bold={true}>{t1}</Text>
            </Text>
          )
          return t2
        } else {
          let t1
          t1 = (
            <Text dimColor={true}>
              The Bash command <Text bold={true}>{ruleValue.ruleContent}</Text>
            </Text>
          )
          return t1
        }
      } else {
        let t1
        t1 = <Text dimColor={true}>Any Bash command</Text>
        return t1
      }
    }
    default: {
      if (!ruleValue.ruleContent) {
        let t1
        t1 = (
          <Text dimColor={true}>
            Any use of the <Text bold={true}>{ruleValue.toolName}</Text> tool
          </Text>
        )
        return t1
      } else {
        return null
      }
    }
  }
}
