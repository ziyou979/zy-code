// ─── URL 规范化 ─────────────────────────────────────────

/**
 * 将 git remote URL 规范化为用于哈希的标准格式。
 * 将 SSH 和 HTTPS URL 转换为相同格式：host/owner/repo（小写，无 .git）
 *
 * 示例：
 * - git@github.com:owner/repo.git -> github.com/owner/repo
 * - https://github.com/owner/repo.git -> github.com/owner/repo
 * - ssh://git@github.com/owner/repo -> github.com/owner/repo
 * - http://local_proxy@127.0.0.1:16583/git/owner/repo -> github.com/owner/repo
 */
export function normalizeGitRemoteUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) {
    return null
  }

  // 处理 SSH 格式：git@host:owner/repo.git
  const sshMatch = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (sshMatch?.[1] && sshMatch[2]) {
    return `${sshMatch[1]}/${sshMatch[2]}`.toLowerCase()
  }

  // 处理 HTTPS/SSH URL 格式：https://host/owner/repo.git 或 ssh://git@host/owner/repo
  const urlMatch = trimmed.match(/^(?:https?|ssh):\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/)
  if (urlMatch?.[1] && urlMatch[2]) {
    const host = urlMatch[1]
    const path = urlMatch[2]

    // CCR git 代理 URL 使用以下格式：
    //   旧版：http://...@127.0.0.1:PORT/git/owner/repo       （假定为 github.com）
    //   GHE：http://...@127.0.0.1:PORT/git/ghe.host/owner/repo（主机名编码在路径中）
    // 去除 /git/ 前缀。如果第一个路径段包含点号，则为主机名
    //（GitHub 组织名不能包含点号）。否则假定为 github.com。
    if (isLocalHost(host) && path.startsWith('git/')) {
      const proxyPath = path.slice(4) // 移除 "git/" 前缀
      const segments = proxyPath.split('/')
      // 3+ 段且第一段包含点号 → host/owner/repo（GHE 格式）
      if (segments.length >= 3 && segments[0]!.includes('.')) {
        return proxyPath.toLowerCase()
      }
      // 2 段 → owner/repo（旧版格式，假定为 github.com）
      return `github.com/${proxyPath}`.toLowerCase()
    }

    return `${host}/${path}`.toLowerCase()
  }

  return null
}

function isLocalHost(host: string): boolean {
  const hostWithoutPort = host.split(':')[0] ?? ''
  return hostWithoutPort === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostWithoutPort)
}

// ─── 类型定义 ───────────────────────────────────────────

export type GitFileStatus = {
  tracked: string[]
  untracked: string[]
}

export type GitRepoState = {
  commitHash: string
  branchName: string
  remoteUrl: string | null
  isHeadOnRemote: boolean
  isClean: boolean
  worktreeCount: number
}

/**
 * 用于 issue 提交的保留 git 状态。
 * 使用远程基准（如 origin/main），该分支很少被 force-push，
 * 不像本地提交在 force push 后会被 GC 回收。
 */
export type PreservedGitState = {
  /** 与远程分支的 merge-base SHA */
  remote_base_sha: string | null
  /** 使用的远程分支（如 "origin/main"） */
  remote_base: string | null
  /** 从 merge-base 到当前状态的 patch（包含未提交的变更） */
  patch: string
  /** 未跟踪文件及其内容 */
  untracked_files: Array<{ path: string; content: string }>
  /** merge-base 与 HEAD 之间已提交变更的 git format-patch 输出。 */
  format_patch: string | null
  /** 当前 HEAD SHA（特性分支的顶端） */
  head_sha: string | null
  /** 当前分支名（如 "feat/my-feature"） */
  branch_name: string | null
}
