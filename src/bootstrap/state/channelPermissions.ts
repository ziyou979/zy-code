import type { ChannelPermissionCallbacks } from '../../services/mcp/channelPermissions.js'

// Channel 权限回调属于运行时能力，不进入可序列化的 AppState。
let callbacks: ChannelPermissionCallbacks | undefined

export function getChannelPermissionCallbacks(): ChannelPermissionCallbacks | undefined {
  return callbacks
}

export function setChannelPermissionCallbacks(next: ChannelPermissionCallbacks | undefined): void {
  callbacks = next
}
