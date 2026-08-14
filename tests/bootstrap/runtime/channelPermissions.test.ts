import { afterEach, describe, expect, test } from 'bun:test'
import {
  getChannelPermissionCallbacks,
  setChannelPermissionCallbacks,
} from '../../../src/bootstrap/runtime/runtimeContext.js'
import type { ChannelPermissionCallbacks } from '../../../src/services/mcp/channelPermissions.js'

describe('channel permission runtime context', () => {
  afterEach(() => setChannelPermissionCallbacks(undefined))

  test('发布和清除回调时不依赖 AppState', () => {
    const callbacks = {} as ChannelPermissionCallbacks

    setChannelPermissionCallbacks(callbacks)
    expect(getChannelPermissionCallbacks()).toBe(callbacks)

    setChannelPermissionCallbacks(undefined)
    expect(getChannelPermissionCallbacks()).toBeUndefined()
  })
})
