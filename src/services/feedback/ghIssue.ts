import { getGhAuthStatus } from '../github/ghAuthStatus.js'
import { execFileNoThrow } from '../shell/execFileNoThrow.js'
import { FEEDBACK_ISSUE_LABELS, FEEDBACK_REPO } from './githubIssue.js'
import { redactSensitiveInfo } from '../../utils/redactSensitiveInfo.js'

type ExecResult = { stdout: string; stderr: string; code: number; error?: string }
type ExecFn = (file: string, args: string[], input: string) => Promise<ExecResult>

const GH_CREATE_TIMEOUT_MS = 60_000

const defaultExec: ExecFn = (file, args, input) =>
  execFileNoThrow(file, args, {
    timeout: GH_CREATE_TIMEOUT_MS,
    preserveOutputOnError: true,
    useCwd: true,
    input,
  })

/**
 * gh 是否已安装且已登录。复用 getGhAuthStatus：它用 `gh auth token`（只读本地配置/钥匙串），
 * 而不是会请求 GitHub API 的 `gh auth status`，所以打开 /feedback 时不产生网络请求。
 */
export async function isGhReady(): Promise<boolean> {
  try {
    return (await getGhAuthStatus()) === 'authenticated'
  } catch {
    return false
  }
}

export function buildGhIssueArgs(title: string, withLabels: boolean): string[] {
  const args = [
    'issue',
    'create',
    '--repo',
    FEEDBACK_REPO,
    '--title',
    redactSensitiveInfo(title),
    '--body-file',
    '-',
  ]
  if (withLabels) {
    args.push('--label', FEEDBACK_ISSUE_LABELS.join(','))
  }
  return args
}

function extractIssueUrl(stdout: string): string | null {
  const match = stdout.match(/https:\/\/github\.com\/\S+\/issues\/\d+/)
  return match ? match[0] : null
}

export type GhCreateResult = { ok: true; url: string } | { ok: false; error: string }

/**
 * 用 `gh issue create --repo ziyou979/zy-code` 直接提交（正文走 stdin，已脱敏）。
 * 仓库里不存在某个 label、或当前用户无权打 label 时 gh 会失败，此时去掉 label 重试一次。
 */
export async function createIssueWithGh(
  title: string,
  body: string,
  exec: ExecFn = defaultExec,
): Promise<GhCreateResult> {
  const safeBody = redactSensitiveInfo(body)
  let result = await exec('gh', buildGhIssueArgs(title, true), safeBody)
  if (result.code !== 0 && /label/i.test(result.stderr)) {
    result = await exec('gh', buildGhIssueArgs(title, false), safeBody)
  }
  if (result.code === 0) {
    const url = extractIssueUrl(result.stdout)
    if (url) {
      return { ok: true, url }
    }
  }
  const error = (result.stderr || result.error || result.stdout || `exit ${result.code}`).trim()
  return { ok: false, error: redactSensitiveInfo(error).slice(0, 500) }
}
