/**
 * ANT-only CLI handlers
 */

export async function logHandler(_logId: string | number | undefined): Promise<void> {
  throw new Error('logHandler not implemented')
}

export async function errorHandler(_number: number | undefined): Promise<void> {
  throw new Error('errorHandler not implemented')
}

export async function exportHandler(_source: string, _outputFile: string): Promise<void> {
  throw new Error('exportHandler not implemented')
}

// biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
export async function taskCreateHandler(_subject: string, _opts: any): Promise<void> {
  throw new Error('taskCreateHandler not implemented')
}

// biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
export async function taskListHandler(_opts: any): Promise<void> {
  throw new Error('taskListHandler not implemented')
}

// biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
export async function taskGetHandler(_id: string, _opts: any): Promise<void> {
  throw new Error('taskGetHandler not implemented')
}

// biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
export async function taskUpdateHandler(_id: string, _opts: any): Promise<void> {
  throw new Error('taskUpdateHandler not implemented')
}

// biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
export async function taskDirHandler(_opts: any): Promise<void> {
  throw new Error('taskDirHandler not implemented')
}

// biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
export async function completionHandler(_shell: string, _opts: any, _program: any): Promise<void> {
  throw new Error('completionHandler not implemented')
}
