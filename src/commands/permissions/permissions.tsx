import { PermissionRuleList } from '../../components/permissions/rules/PermissionRuleList.js'
import type { LocalJSXCommandCall } from '../types.js'
import { createPermissionRetryMessage } from '../../services/messages/index.js'
export const call: LocalJSXCommandCall = async (onDone, context) => {
  return (
    <PermissionRuleList
      onExit={onDone}
      onRetryDenials={(commands) => {
        context.setMessages((prev) => [...prev, createPermissionRetryMessage(commands)])
      }}
    />
  )
}
