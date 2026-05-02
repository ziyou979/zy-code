/**
 * ANT-only CLI handlers
 */

export async function logHandler(logId: string | number | undefined): Promise<void> {
  throw new Error('logHandler not implemented')
}

export async function errorHandler(number: number | undefined): Promise<void> {
  throw new Error('errorHandler not implemented')
}

export async function exportHandler(source: string, outputFile: string): Promise<void> {
  throw new Error('exportHandler not implemented')
}

export async function taskCreateHandler(subject: string, opts: any): Promise<void> {
  throw new Error('taskCreateHandler not implemented')
}

export async function taskListHandler(opts: any): Promise<void> {
  throw new Error('taskListHandler not implemented')
}

export async function taskGetHandler(id: string, opts: any): Promise<void> {
  throw new Error('taskGetHandler not implemented')
}

export async function taskUpdateHandler(id: string, opts: any): Promise<void> {
  throw new Error('taskUpdateHandler not implemented')
}

export async function taskDirHandler(opts: any): Promise<void> {
  throw new Error('taskDirHandler not implemented')
}

export async function completionHandler(shell: string, opts: any, program: any): Promise<void> {
  throw new Error('completionHandler not implemented')
}
