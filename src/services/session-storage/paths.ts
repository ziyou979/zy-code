import { join } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
} from '../../bootstrap/runtime/runtimeContext.js'
import type { AgentId } from '../../types/ids.js'
import { getCwd } from '../environment/cwd.js'
import { getZyConfigHomeDir } from '../../services/infra/envUtils.js'
import { sanitizePath } from '../../utils/path.js'

export function getProjectsDir(): string {
  return join(getZyConfigHomeDir(), 'projects')
}

// 已记忆化：通过 hooks.ts createBaseHookInput 每轮调用 12+ 次
//（PostToolUse 路径，每轮 5 次）+ 各种 save* 函数。输入是 cwd 字符串；
// homedir/env/regex 在整个 session 中不变，因此对给定输入结果稳定。
// Worktree 切换只改变 key — 无需清除缓存。
export let getProjectDir: (projectDir: string) => string
getProjectDir = memoize((projectDir: string): string => {
  return join(getProjectsDir(), sanitizePath(projectDir))
})

export function getTranscriptPath(): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, `${getSessionId()}.jsonl`)
}

export function getTranscriptPathForSession(sessionId: string): string {
  // 请求当前 session 的 transcript 时，遵循 sessionProjectDir，
  // 与 getTranscriptPath() 保持一致。否则 hook 基于 originalCwd 计算
  // transcript_path，而实际文件被写入 sessionProjectDir（由
  // switchActiveSession 在 resume/branch 时设置）— 目录不同，hook 看到
  // MISSING (gh-30217)。CC-34 正是为防止这种漂移而将 sessionId +
  // sessionProjectDir 做成原子操作；只是这个函数之前没更新为读取两者。
  //
  // 其他 session ID 只能通过 originalCwd 猜测 — 不维护 sessionId→projectDir 映射。
  // 需要特定其他 session 路径的调用者应显式传入 fullPath。
  if (sessionId === getSessionId()) {
    return getTranscriptPath()
  }
  const projectDir = getProjectDir(getOriginalCwd())
  return join(projectDir, `${sessionId}.jsonl`)
}

// 会话级可变元数据 sidecar（custom-title / tag / last-prompt 等),与 .jsonl 同目录同名。
// 镜像 getAgentMetadataPath 的 .meta.json 约定。
export function getSessionMetadataPath(sessionId?: string): string {
  return getSessionMetadataPathFromTranscriptPath(
    getTranscriptPathForSession(sessionId ?? getSessionId()),
  )
}

export function getSessionMetadataPathFromTranscriptPath(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, '.meta.json')
}

// 50 MB — session JSONL 可增长到数 GB (inc-3930)。读取原始 transcript 的
// 调用者必须在超过此阈值时中止以避免 OOM。
export const MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024

// agentId → 子目录的内存映射，用于对相关子代理 transcript 分组
// （例如 workflow 运行写入 subagents/workflows/<runId>/）。
// 在代理运行之前填充；由 getAgentTranscriptPath 查询。
const agentTranscriptSubdirs = new Map<string, string>()

export function setAgentTranscriptSubdir(agentId: string, subdir: string): void {
  agentTranscriptSubdirs.set(agentId, subdir)
}

export function clearAgentTranscriptSubdir(agentId: string): void {
  agentTranscriptSubdirs.delete(agentId)
}

/**
 * 可能存放 agent transcript 的路径候选（去重）。
 * 冷恢复 / 进入 worktree 后，sessionProjectDir 与 originalCwd/cwd 的 project 目录
 * 可能短暂不一致；bootstrap 会依次尝试，避免 agent-view 空白（CC 2.1.207）。
 */
export function getAgentTranscriptPathCandidates(agentId: AgentId): string[] {
  const sessionId = getSessionId()
  const subdir = agentTranscriptSubdirs.get(agentId)
  const projectDirs = new Set<string>()
  projectDirs.add(getSessionProjectDir() ?? getProjectDir(getOriginalCwd()))
  try {
    projectDirs.add(getProjectDir(getOriginalCwd()))
  } catch {
    // ignore
  }
  try {
    projectDirs.add(getProjectDir(getCwd()))
  } catch {
    // ignore
  }
  const paths: string[] = []
  for (const projectDir of projectDirs) {
    const base = subdir
      ? join(projectDir, sessionId, 'subagents', subdir)
      : join(projectDir, sessionId, 'subagents')
    paths.push(join(base, `agent-${agentId}.jsonl`))
  }
  return paths
}

export function getAgentTranscriptPath(agentId: AgentId): string {
  // 与 getTranscriptPathForSession 相同的 sessionProjectDir 一致性 —
  // 子代理 transcript 位于 session 目录下，因此 session transcript
  // 在 sessionProjectDir 时，子代理 transcript 也在那里。
  // 首选路径 = 候选列表第一项（sessionProjectDir 优先）。
  return getAgentTranscriptPathCandidates(agentId)[0]!
}

export function getAgentMetadataPath(agentId: AgentId): string {
  return getAgentTranscriptPath(agentId).replace(/\.jsonl$/, '.meta.json')
}

export function getRemoteAgentsDir(): string {
  // 与 getAgentTranscriptPath 相同的 sessionProjectDir 回退 — 是项目目录
  //（含 .jsonl 的目录），而非 session 目录，因此需拼接 sessionId。
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, getSessionId(), 'remote-agents')
}

export function getRemoteAgentMetadataPath(taskId: string): string {
  return join(getRemoteAgentsDir(), `remote-agent-${taskId}.meta.json`)
}
