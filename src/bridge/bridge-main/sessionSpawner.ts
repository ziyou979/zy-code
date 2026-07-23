import { isInBundledMode } from '../../services/environment/bundledMode.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../services/infra/log.js'
import type { SessionHandle, SessionSpawner, SessionSpawnOpts } from '../types.js'

/**
 * Returns the args that must precede CLI flags when spawning a child zy
 * process. In compiled binaries, process.execPath is the zy binary itself
 * and args go directly to it. In npm installs (node running cli.js),
 * process.execPath is the node runtime — the child spawn must pass the script
 * path as the first arg, otherwise node interprets --sdk-url as a node option
 * and exits with "bad option: --sdk-url". See anthropics/zy-code#28334.
 */
export function spawnScriptArgs(): string[] {
  if (isInBundledMode() || !process.argv[1]) {
    return []
  }
  return [process.argv[1]]
}

/** Attempt to spawn a session; returns error string if spawn throws. */
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
