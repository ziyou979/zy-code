/**
 * CCR upstreamproxy——容器侧装配。
 *
 * 在已配置 upstreamproxy 的 CCR 会话容器中运行时，本模块会：
 *   1. 从 /run/ccr/session_token 读取会话 token
 *   2. 设置 prctl(PR_SET_DUMPABLE, 0)，阻止相同 UID 通过 ptrace 读取 heap
 *   3. 下载 upstreamproxy CA 证书并与系统 bundle 合并，使 curl/gh/python 信任 MITM proxy
 *   4. 启动本地 CONNECT→WebSocket relay（参见 relay.ts）
 *   5. 删除 token 文件；token 只留在 heap 中，agent loop 无法看到文件。必须等 relay
 *      确认启动后才删除，以便 supervisor 重启时能够重试
 *   6. 为所有 agent 子进程提供 HTTPS_PROXY / SSL_CERT_FILE 环境变量
 *
 * 每一步均采用 fail-open：任何错误都会记录警告并禁用 proxy。
 * proxy 配置故障不得破坏原本可以正常工作的会话。
 *
 * 设计文档：api-go/ccr/docs/plans/CCR_AUTH_DESIGN.md 的“Week-1 pilot scope”章节。
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerCleanup } from '../services/cleanup/cleanupRegistry.js'
import { logForDebugging } from '../services/infra/debug.js'
import { isEnvTruthy } from '../services/infra/envUtils.js'
import { isENOENT } from '../utils/errors.js'
import { startUpstreamProxyRelay } from './relay.js'

export const SESSION_TOKEN_PATH = '/run/ccr/session_token'
const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'

// 代理不应拦截的主机列表。涵盖回环地址、RFC1918 私有地址、IMDS
// 范围，以及 CCR 容器已经直接访问的包注册表和 GitHub。
// 与 airlock/scripts/sandbox-shell-ccr.sh 保持一致。
const NO_PROXY_LIST = [
  'localhost',
  '127.0.0.1',
  '::1',
  '169.254.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  // Anthropic API：任何上游路由都不会匹配，且 MITM 会破坏
  // 非 Bun 运行时（Python httpx/certifi 不信任伪造的 CA）。
  // 三种形式是因为不同运行时的 NO_PROXY 解析方式不同：
  //   *.anthropic.com  — Bun、curl、Go（glob 匹配）
  //   .anthropic.com   — Python urllib/httpx（后缀匹配，会去除前导点）
  //   anthropic.com    — 顶点域名后备
  'anthropic.com',
  '.anthropic.com',
  '*.anthropic.com',
  'github.com',
  'api.github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'index.crates.io',
  'proxy.golang.org',
].join(',')

type UpstreamProxyState = {
  enabled: boolean
  port?: number
  caBundlePath?: string
}

let state: UpstreamProxyState = { enabled: false }

/**
 * 初始化 upstreamproxy，由 init.ts 调用一次。功能关闭或 token 文件不存在时也可安全调用，
 * 此时返回 {enabled: false}。
 *
 * 可覆盖路径仅供测试使用，生产环境使用默认值。
 */
export async function initUpstreamProxy(opts?: {
  tokenPath?: string
  systemCaPath?: string
  caBundlePath?: string
  ccrBaseUrl?: string
}): Promise<UpstreamProxyState> {
  if (!isEnvTruthy(process.env.ZY_CODE_REMOTE)) {
    return state
  }
  // CCR 在已有 GrowthBook 缓存的服务端评估 ccr_upstream_proxy_enabled，并通过
  // StartupContext.EnvironmentVariables 注入此环境变量。每个 CCR 会话都是没有 GB
  // 缓存的新容器，因此在客户端检查 GB 始终只能得到默认值 false。
  if (!isEnvTruthy(process.env.CCR_UPSTREAM_PROXY_ENABLED)) {
    return state
  }

  const sessionId = process.env.ZY_CODE_REMOTE_SESSION_ID
  if (!sessionId) {
    logForDebugging('[upstreamproxy] ZY_CODE_REMOTE_SESSION_ID unset; proxy disabled', {
      level: 'warn',
    })
    return state
  }

  const tokenPath = opts?.tokenPath ?? SESSION_TOKEN_PATH
  const token = await readToken(tokenPath)
  if (!token) {
    logForDebugging('[upstreamproxy] no session token file; proxy disabled')
    return state
  }

  setNonDumpable()

  // CCR 通过 StartupContext（sessionExecutor.ts / sessionHandler.ts）注入
  // ZY_CODE_BASE_URL。这里不能使用 getOauthConfig()：它依赖 USER_TYPE 与
  // USE_{LOCAL,STAGING}_OAUTH，而容器不会设置这些值，导致它总是返回生产 URL，
  // 进而使 CA 请求得到 404。
  const baseUrl = opts?.ccrBaseUrl ?? process.env.ZY_CODE_BASE_URL ?? 'https://api.anthropic.com'
  const caBundlePath = opts?.caBundlePath ?? join(homedir(), '.ccr', 'ca-bundle.crt')

  const caOk = await downloadCaBundle(baseUrl, opts?.systemCaPath ?? SYSTEM_CA_BUNDLE, caBundlePath)
  if (!caOk) {
    return state
  }

  try {
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/v1/code/upstreamproxy/ws`
    const relay = await startUpstreamProxyRelay({ wsUrl, sessionId, token })
    registerCleanup(async () => relay.stop())
    state = { enabled: true, port: relay.port, caBundlePath }
    logForDebugging(`[upstreamproxy] enabled on 127.0.0.1:${relay.port}`)
    // 只有 listener 启动后才能删除文件：若 CA 下载或 listen() 失败，token 仍留在磁盘，
    // supervisor 重启后便可重试。
    await unlink(tokenPath).catch(() => {
      logForDebugging('[upstreamproxy] token file unlink failed', {
        level: 'warn',
      })
    })
  } catch (err) {
    logForDebugging(
      `[upstreamproxy] relay start failed: ${err instanceof Error ? err.message : String(err)}; proxy disabled`,
      { level: 'warn' },
    )
  }

  return state
}

/**
 * 合并到每个 agent 子进程的环境变量；proxy 禁用时为空。
 * 由 subprocessEnv() 调用，使 Bash/MCP/LSP/Hook 都继承同一配置。
 */
export function getUpstreamProxyEnv(): Record<string, string> {
  if (!state.enabled || !state.port || !state.caBundlePath) {
    // CLI 子进程无法重新初始化 relay，因为父进程已删除 token 文件；但父进程 relay
    // 仍在运行，可通过 127.0.0.1:<port> 访问。若继承了父进程的 proxy 变量
    //（HTTPS_PROXY 与 SSL_CERT_FILE 均存在），则继续传递，使子进程也通过父 relay 路由。
    if (process.env.HTTPS_PROXY && process.env.SSL_CERT_FILE) {
      const inherited: Record<string, string> = {}
      for (const key of [
        'HTTPS_PROXY',
        'https_proxy',
        'NO_PROXY',
        'no_proxy',
        'SSL_CERT_FILE',
        'NODE_EXTRA_CA_CERTS',
        'REQUESTS_CA_BUNDLE',
        'CURL_CA_BUNDLE',
      ]) {
        if (process.env[key]) {
          inherited[key] = process.env[key]
        }
      }
      return inherited
    }
    return {}
  }
  const proxyUrl = `http://127.0.0.1:${state.port}`
  // 仅代理 HTTPS：relay 只处理 CONNECT。普通 HTTP 没有可注入的凭据，
  // 经 relay 路由只会收到 405 并破坏请求。
  return {
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: NO_PROXY_LIST,
    no_proxy: NO_PROXY_LIST,
    SSL_CERT_FILE: state.caBundlePath,
    NODE_EXTRA_CA_CERTS: state.caBundlePath,
    REQUESTS_CA_BUNDLE: state.caBundlePath,
    CURL_CA_BUNDLE: state.caBundlePath,
  }
}

/** 仅供测试：在测试用例之间重置模块状态。 */
export function resetUpstreamProxyForTests(): void {
  state = { enabled: false }
}

async function readToken(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf8')
    return raw.trim() || null
  } catch (err) {
    if (isENOENT(err)) {
      return null
    }
    logForDebugging(
      `[upstreamproxy] token read failed: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    return null
  }
}

/**
 * 通过 libc FFI 调用 prctl(PR_SET_DUMPABLE, 0)，阻止相同 UID ptrace 此进程，
 * 使 prompt 注入的 `gdb -p $PPID` 无法从 heap 抓取 token。
 * 仅适用于 Linux，其他平台静默跳过。
 */
function setNonDumpable(): void {
  if (process.platform !== 'linux' || typeof Bun === 'undefined') {
    return
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffi = require('bun:ffi') as typeof import('bun:ffi')
    const lib = ffi.dlopen('libc.so.6', {
      prctl: {
        args: ['int', 'u64', 'u64', 'u64', 'u64'],
        returns: 'int',
      },
    } as const)
    const PR_SET_DUMPABLE = 4
    const rc = lib.symbols.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n)
    if (rc !== 0) {
      logForDebugging('[upstreamproxy] prctl(PR_SET_DUMPABLE,0) returned nonzero', {
        level: 'warn',
      })
    }
  } catch (err) {
    logForDebugging(
      `[upstreamproxy] prctl unavailable: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
  }
}

async function downloadCaBundle(
  baseUrl: string,
  systemCaPath: string,
  outPath: string,
): Promise<boolean> {
  try {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const resp = await fetch(`${baseUrl}/v1/code/upstreamproxy/ca-cert`, {
      // Bun 的 fetch 默认不超时；挂起的 endpoint 会永久阻塞 CLI 启动。
      // 对较小的 PEM 而言，5 秒已足够宽裕。
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) {
      logForDebugging(`[upstreamproxy] ca-cert fetch ${resp.status}; proxy disabled`, {
        level: 'warn',
      })
      return false
    }
    const ccrCa = await resp.text()
    const systemCa = await readFile(systemCaPath, 'utf8').catch(() => '')
    await mkdir(join(outPath, '..'), { recursive: true })
    await writeFile(outPath, `${systemCa}\n${ccrCa}`, 'utf8')
    return true
  } catch (err) {
    logForDebugging(
      `[upstreamproxy] ca-cert download failed: ${err instanceof Error ? err.message : String(err)}; proxy disabled`,
      { level: 'warn' },
    )
    return false
  }
}
