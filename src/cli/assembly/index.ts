// 装配阶段聚合导出。
// 新增 mode 模块时记得同步追加 export，rootAction 只从这里取分派函数。

export { runDirectConnectMode } from './directConnectMode.js'
export { runInteractiveMode } from './interactiveMode.js'
export { launchRemoteSessionRepl } from './remoteSession.js'
export { dispatchResumeMode } from './resumeDispatch.js'
export { launchResumedSessionRepl } from './resumedSession.js'
export { runSshMode } from './sshMode.js'
export type {
  AssemblyAppProps,
  AssemblyContext,
  RenderAndRun,
  SessionConfig,
} from './types.js'
