import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tSync } from '../../i18n/index.js'
import { getProjectRoot } from 'src/bootstrap/runtime/runtimeContext.js'
import { buildMemoryPrompt, ensureMemoryDirExists } from '../../memdir/memdir.js'
import { getMemoryBaseDir } from '../../memdir/paths.js'
import { getCwd } from '../../services/environment/cwd.js'
import { findCanonicalGitRoot } from '../../services/infra/git.js'
import { sanitizePath } from '../../utils/path.js'

// agent 持久记忆的 scope：'user' (~/.zy/agent-memory/)、'project' (.zy/agent-memory/) 或 'local' (.zy/agent-memory-local/)
export type AgentMemoryScope = 'user' | 'project' | 'local'

/**
 * 清理 agent 类型名，使其可用作目录名。
 * 将冒号替换为连字符；冒号在 Windows 中非法，但会用于 "my-plugin:my-agent" 这类
 * 带 plugin 命名空间的 agent 类型。
 */
function sanitizeAgentTypeForPath(agentType: string): string {
  return agentType.replace(/:/g, '-')
}

/**
 * 返回项目专属且不提交到 VCS 的本地 agent 记忆目录。
 * 设置 ZY_CODE_REMOTE_MEMORY_DIR 时，按项目命名空间持久化到挂载点；
 * 否则使用 <cwd>/.zy/agent-memory-local/<agentType>/。
 */
function getLocalAgentMemoryDir(dirName: string): string {
  if (process.env.ZY_CODE_REMOTE_MEMORY_DIR) {
    return (
      join(
        process.env.ZY_CODE_REMOTE_MEMORY_DIR,
        'projects',
        sanitizePath(findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot()),
        'agent-memory-local',
        dirName,
      ) + sep
    )
  }
  return join(getCwd(), '.zy', 'agent-memory-local', dirName) + sep
}

/**
 * 返回指定 agent 类型和 scope 的记忆目录。
 * - 'user' scope：<memoryBase>/agent-memory/<agentType>/
 * - 'project' scope：<cwd>/.zy/agent-memory/<agentType>/
 * - 'local' scope：参见 getLocalAgentMemoryDir()
 */
export function getAgentMemoryDir(agentType: string, scope: AgentMemoryScope): string {
  const dirName = sanitizeAgentTypeForPath(agentType)
  switch (scope) {
    case 'project':
      return join(getCwd(), '.zy', 'agent-memory', dirName) + sep
    case 'local':
      return getLocalAgentMemoryDir(dirName)
    case 'user':
      return join(getMemoryBaseDir(), 'agent-memory', dirName) + sep
  }
}

// 检查文件是否位于任意 scope 的 agent 记忆目录中。
export function isAgentMemoryPath(absolutePath: string): boolean {
  const memoryBase = getMemoryBaseDir()
  const isWithin = (root: string): boolean => {
    const relativePath = relative(resolve(root), resolve(absolutePath))
    return (
      relativePath !== '' &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath)
    )
  }

  // User scope：检查记忆根目录（可能是自定义目录或配置主目录）
  if (isWithin(join(memoryBase, 'agent-memory'))) {
    return true
  }

  // Project scope：始终基于 cwd，不重定向
  if (isWithin(join(getCwd(), '.zy', 'agent-memory'))) {
    return true
  }

  // Local scope：设置 ZY_CODE_REMOTE_MEMORY_DIR 时持久化到挂载点，否则基于 cwd
  if (process.env.ZY_CODE_REMOTE_MEMORY_DIR) {
    const projectLocalRoot = join(
      process.env.ZY_CODE_REMOTE_MEMORY_DIR,
      'projects',
      sanitizePath(findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot()),
      'agent-memory-local',
    )
    if (isWithin(projectLocalRoot)) {
      return true
    }
  } else if (isWithin(join(getCwd(), '.zy', 'agent-memory-local'))) {
    return true
  }

  return false
}

/**
 * 返回指定 agent 类型和 scope 的记忆文件路径。
 */
export function getAgentMemoryEntrypoint(agentType: string, scope: AgentMemoryScope): string {
  return join(getAgentMemoryDir(agentType, scope), 'MEMORY.md')
}

export function getMemoryScopeDisplay(memory: AgentMemoryScope | undefined): string {
  switch (memory) {
    case 'user':
      return tSync('agentMemory.userDir', { path: join(getMemoryBaseDir(), 'agent-memory') })
    case 'project':
      return tSync('agentMemory.projectDir')
    case 'local':
      return tSync('agentMemory.localDir', { path: getLocalAgentMemoryDir('...') })
    default:
      return tSync('agentMemory.none')
  }
}

/**
 * 为已启用记忆的 agent 加载持久记忆。
 * 必要时创建记忆目录，并返回包含记忆内容的 prompt。
 *
 * @param agentType agent 类型名（用作目录名）
 * @param scope 'user' 表示 ~/.zy/agent-memory/，'project' 表示 .zy/agent-memory/
 */
export function loadAgentMemoryPrompt(agentType: string, scope: AgentMemoryScope): string {
  let scopeNote: string
  switch (scope) {
    case 'user':
      scopeNote =
        '- Since this memory is user-scope, keep learnings general since they apply across all projects'
      break
    case 'project':
      scopeNote =
        '- Since this memory is project-scope and shared with your team via version control, tailor your memories to this project'
      break
    case 'local':
      scopeNote =
        '- Since this memory is local-scope (not checked into version control), tailor your memories to this project and machine'
      break
  }

  const memoryDir = getAgentMemoryDir(agentType, scope)

  // 只发不等：此逻辑在创建 agent 时从同步 getSystemPrompt() 回调内执行。
  // 该回调由 AgentDetail.tsx 的 React render 调用，因此不能改为异步。新 agent 要等完成一次
  // API 往返后才会尝试 Write，届时 mkdir 应已完成；即使未完成，FileWriteTool 也会自行创建父目录。
  void ensureMemoryDirExists(memoryDir)

  const coworkExtraGuidelines = process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
  return buildMemoryPrompt({
    displayName: 'Persistent Agent Memory',
    memoryDir,
    extraGuidelines:
      coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
        ? [scopeNote, coworkExtraGuidelines]
        : [scopeNote],
  })
}
