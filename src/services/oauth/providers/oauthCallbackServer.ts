// 本地 OAuth 回调：校验路径与 state 后取授权码；端口不可用时 waitForCode 为 null，由手动粘贴兜底
import { tSync } from '../../../i18n/index.js'
import { oauthErrorHtml, oauthSuccessHtml } from './oauthPage.js'

export type OAuthCallbackMessages = {
  routeNotFound: string
  stateMismatch: string
  missingCode: string
  completed: string
  internalError: string
}

export type OAuthCallbackServer<T> = {
  close: () => void
  cancelWait: () => void
  waitForCode: () => Promise<T | null>
}

export function getOAuthCallbackHost(): string {
  return process.env.ZY_CODE_OAUTH_CALLBACK_HOST || '127.0.0.1'
}

export async function fetchWithLoginCancellation(
  input: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw new Error(tSync('oauth.loginCancelled'))
    }
    throw error
  }
}

/** @param accept 由授权码与回调参数构造结果；抛出 Error 时以其消息返回 400 */
export function startOAuthCallbackServer<T>(options: {
  port: number
  path: string
  state: string
  messages: OAuthCallbackMessages
  accept: (code: string, params: URLSearchParams) => T
}): Promise<OAuthCallbackServer<T>> {
  const http = require('node:http') as typeof import('node:http')
  const { messages } = options

  let settleWait: ((value: T | null) => void) | undefined
  const waitForCodePromise = new Promise<T | null>((resolve) => {
    let settled = false
    settleWait = (value) => {
      if (settled) {
        return
      }
      settled = true
      resolve(value)
    }
  })

  const server = http.createServer((req, res) => {
    const respond = (statusCode: number, html: string) => {
      res.statusCode = statusCode
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(html)
    }
    try {
      const url = new URL(req.url || '', 'http://localhost')
      if (url.pathname !== options.path) {
        respond(404, oauthErrorHtml(messages.routeNotFound))
        return
      }
      if (url.searchParams.get('state') !== options.state) {
        respond(400, oauthErrorHtml(messages.stateMismatch))
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        respond(400, oauthErrorHtml(messages.missingCode))
        return
      }
      let result: T
      try {
        result = options.accept(code, url.searchParams)
      } catch (error) {
        respond(
          400,
          oauthErrorHtml(error instanceof Error ? error.message : messages.internalError),
        )
        return
      }
      respond(200, oauthSuccessHtml(messages.completed))
      settleWait?.(result)
    } catch {
      respond(500, oauthErrorHtml(messages.internalError))
    }
  })

  return new Promise((resolve) => {
    server
      .listen(options.port, getOAuthCallbackHost(), () => {
        resolve({
          close: () => {
            server.close()
            // 浏览器预建的备用连接可能把下一次登录的回调送到本进程
            server.closeAllConnections?.()
          },
          cancelWait: () => settleWait?.(null),
          waitForCode: () => waitForCodePromise,
        })
      })
      .on('error', () => {
        settleWait?.(null)
        resolve({
          close: () => {
            try {
              server.close()
            } catch {
              // 忽略
            }
          },
          cancelWait: () => {},
          waitForCode: async () => null,
        })
      })
  })
}
