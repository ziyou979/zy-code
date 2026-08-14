/**
 * SSH 会话类型与创建函数。
 */

export interface SSHSession {
  remoteCwd: string
  // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  proc: any
  // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  proxy: any
  // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  createManager(handlers: any): any
  getStderrTail(): string
  [key: string]: unknown
}

export class SSHSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SSHSessionError'
  }
}

// biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
export async function createSSHSession(_options: any, _callbacks?: any): Promise<SSHSession> {
  throw new Error('createSSHSession not implemented')
}

// biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
export async function createLocalSSHSession(_options: any): Promise<SSHSession> {
  throw new Error('createLocalSSHSession not implemented')
}
