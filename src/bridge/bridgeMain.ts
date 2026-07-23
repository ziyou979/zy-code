/**
 * bridgeMain.ts 的稳定公开入口。
 * 具体职责已拆分到同名子目录，调用方无需感知内部模块布局。
 */
export { bridgeMain } from './bridge-main/headless.js'
export { isConnectionError } from './bridge-main/cli.js'
export { isServerError } from './bridge-main/cli.js'
export { parseArgs } from './bridge-main/cli.js'
export { runWireHeadless } from './bridge-main/headless.js'
export { runWireLoop } from './bridge-main/wireLoop.js'
export { WireHeadlessPermanentError } from './bridge-main/headless.js'
export type { BackoffConfig } from './bridge-main/wirePollingPolicy.js'
export type { HeadlessWireOpts } from './bridge-main/headless.js'
export type { ParsedArgs } from './bridge-main/cli.js'
