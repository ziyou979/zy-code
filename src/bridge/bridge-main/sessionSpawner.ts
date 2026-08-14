import { isInBundledMode } from '../../services/environment/bundledMode.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../services/infra/log.js'
import type { SessionHandle, SessionSpawner, SessionSpawnOpts } from '../types.js'

/**
 * 返回启动 zy 子进程时必须放在 CLI 参数之前的参数。对于编译后的二进制，process.execPath
 * 就是 zy 本身，参数可直接传入；通过 npm 安装时由 node 运行 cli.js，process.execPath 指向
 * node 运行时，因而必须把脚本路径作为子进程的第一个参数。否则 node 会把 --sdk-url 当作
 * 自身选项，并以 "bad option: --sdk-url" 退出。参见 anthropics/zy-code#28334。
 */
export function spawnScriptArgs(): string[] {
  if (isInBundledMode() || !process.argv[1]) {
    return []
  }
  return [process.argv[1]]
}

/** 尝试启动会话；spawn 抛出异常时返回错误字符串。 */
export function safeSpawn(
  spawner: SessionSpawner,
  opts: SessionSpawnOpts,
  dir: string,
): SessionHandle | string {
  try {
    return spawner.spawn(opts, dir)
  } catch (err) {
    const errMsg = errorMessage(err)
    logError(new Error(`Session spawn failed: ${errMsg}`))
    return errMsg
  }
}
