/**
 * 通过 /env 设置的会话级环境变量。
 * 仅通过 bash provider 的环境覆盖应用于启动的子进程，不影响 REPL 进程本身。
 */
const sessionEnvVars = new Map<string, string>()

export function getSessionEnvVars(): ReadonlyMap<string, string> {
  return sessionEnvVars
}

export function setSessionEnvVar(name: string, value: string): void {
  sessionEnvVars.set(name, value)
}

export function deleteSessionEnvVar(name: string): void {
  sessionEnvVars.delete(name)
}

export function clearSessionEnvVars(): void {
  sessionEnvVars.clear()
}
