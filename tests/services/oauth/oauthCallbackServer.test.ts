import { describe, expect, mock, test } from 'bun:test'
import { createServer } from 'node:net'
import { tSync } from '../../../src/i18n/index.js'
import {
  fetchWithLoginCancellation,
  startOAuthCallbackServer,
} from '../../../src/services/oauth/providers/oauthCallbackServer.js'

const messages = {
  routeNotFound: 'not found',
  stateMismatch: 'wrong state',
  missingCode: 'missing code',
  completed: 'completed',
  internalError: 'internal error',
}

async function availablePort(): Promise<number> {
  const socket = createServer()
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', resolve)
  })
  const address = socket.address()
  if (!address || typeof address === 'string') {
    throw new Error('No bound port')
  }
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  )
  return address.port
}

describe('oauthCallbackServer', () => {
  test('校验路径、state 和授权码后才交付结果', async () => {
    const port = await availablePort()
    const accept = mock((code: string) => ({ code }))
    const server = await startOAuthCallbackServer({
      port,
      path: '/auth/callback',
      state: 'expected',
      messages,
      accept,
    })
    let settled = false
    void server.waitForCode().then(() => {
      settled = true
    })
    try {
      for (const [path, status] of [
        ['/elsewhere?state=expected&code=bad', 404],
        ['/auth/callback?state=wrong&code=bad', 400],
        ['/auth/callback?state=expected', 400],
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`)
        expect(response.status).toBe(status)
        await response.text()
        expect(settled).toBe(false)
      }
      expect(accept).not.toHaveBeenCalled()
      const response = await fetch(
        `http://127.0.0.1:${port}/auth/callback?state=expected&code=valid`,
      )
      expect(response.status).toBe(200)
      await response.text()
      expect(await server.waitForCode()).toEqual({ code: 'valid' })
      expect(accept).toHaveBeenCalledTimes(1)
    } finally {
      server.cancelWait()
      server.close()
    }
  })

  test('provider 校验拒绝 client ID 后仍可等待合法回调', async () => {
    const port = await availablePort()
    const server = await startOAuthCallbackServer({
      port,
      path: '/auth/callback',
      state: 'expected',
      messages,
      accept: (code, params) => {
        if (params.get('client_id') !== 'saved-client') {
          throw new Error('client mismatch')
        }
        return { code, clientId: params.get('client_id') }
      },
    })
    try {
      const rejected = await fetch(
        `http://127.0.0.1:${port}/auth/callback?state=expected&code=bad&client_id=other`,
      )
      expect(rejected.status).toBe(400)
      await rejected.text()
      const accepted = await fetch(
        `http://127.0.0.1:${port}/auth/callback?state=expected&code=good&client_id=saved-client`,
      )
      expect(accepted.status).toBe(200)
      await accepted.text()
      expect(await server.waitForCode()).toEqual({ code: 'good', clientId: 'saved-client' })
    } finally {
      server.cancelWait()
      server.close()
    }
  })

  test('端口被占用时返回手动输入兜底，取消等待只结算一次', async () => {
    const port = await availablePort()
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve))
    try {
      const fallback = await startOAuthCallbackServer({
        port,
        path: '/auth/callback',
        state: 's',
        messages,
        accept: (code) => code,
      })
      expect(await fallback.waitForCode()).toBeNull()
      fallback.close()
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
    const server = await startOAuthCallbackServer({
      port,
      path: '/auth/callback',
      state: 's',
      messages,
      accept: (code) => code,
    })
    try {
      server.cancelWait()
      server.cancelWait()
      expect(await server.waitForCode()).toBeNull()
    } finally {
      server.close()
    }
  })

  test('已取消请求保留本地化的登录取消语义', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchWithLoginCancellation('http://127.0.0.1:1', { signal: controller.signal }),
    ).rejects.toThrow(tSync('oauth.loginCancelled'))
  })
})
