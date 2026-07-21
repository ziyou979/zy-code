import { homedir } from 'node:os'
import { relative } from 'node:path'
import { Box, Text } from '../../ink/index.js'
import { getCwd } from '../../services/environment/cwd.js'
export function getRelativeMemoryPath(path: string): string {
  const homeDir = homedir()
  const cwd = getCwd()

  // 计算相对路径
  const relativeToHome = path.startsWith(homeDir) ? `~${path.slice(homeDir.length)}` : null
  const relativeToCwd = path.startsWith(cwd) ? `./${relative(cwd, path)}` : null

  // 返回较短的路径，如果都不适用则返回绝对路径
  if (relativeToHome && relativeToCwd) {
    return relativeToHome.length <= relativeToCwd.length ? relativeToHome : relativeToCwd
  }
  return relativeToHome || relativeToCwd || path
}
export function MemoryUpdateNotification({ memoryPath }: { memoryPath: string }) {
  const displayPath = getRelativeMemoryPath(memoryPath)
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text color="text">Memory updated in {displayPath} · /memory to edit</Text>
    </Box>
  )
}
