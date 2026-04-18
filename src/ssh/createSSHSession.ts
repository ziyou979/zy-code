/**
 * SSH Session types and creation functions
 */

export interface SSHSession {
  remoteCwd: string;
  proc: any;
  proxy: any;
  createManager(handlers: any): any;
  getStderrTail(): string;
  [key: string]: unknown;
}

export class SSHSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSHSessionError';
  }
}

export async function createSSHSession(options: any, callbacks?: any): Promise<SSHSession> {
  throw new Error('createSSHSession not implemented');
}

export async function createLocalSSHSession(options: any): Promise<SSHSession> {
  throw new Error('createLocalSSHSession not implemented');
}
