import chalk from 'chalk'
import { toString as qrToString } from 'qrcode'
import {
  BRIDGE_FAILED_INDICATOR,
  BRIDGE_READY_INDICATOR,
  BRIDGE_SPINNER_FRAMES,
} from '../constants/figures.js'
import { stringWidth } from '../ink/stringWidth.js'
import { logForDebugging } from '../services/infra/debug.js'
import { isInternalBuild } from '../services/infra/envUtils.js'
import {
  buildActiveFooterText,
  buildIdleFooterText,
  buildWireConnectUrl,
  buildWireSessionUrl,
  FAILED_FOOTER_TEXT,
  formatDuration,
  type StatusState,
  TOOL_DISPLAY_EXPIRY_MS,
  timestamp,
  truncatePrompt,
  wrapWithOsc8Link,
} from './bridgeStatusUtil.js'
import type { SessionActivity, SpawnMode, WireConfig, WireLogger } from './types.js'
const QR_OPTIONS = {
  type: 'utf8' as const,
  errorCorrectionLevel: 'L' as const,
  small: true,
}

/** 生成二维码并按行返回。 */
async function generateQr(url: string): Promise<string[]> {
  const qr = await qrToString(url, QR_OPTIONS)
  return qr.split('\n').filter((line: string) => line.length > 0)
}

export function createWireLogger(options: {
  verbose: boolean
  write?: (s: string) => void
}): WireLogger {
  const write = options.write ?? ((s: string) => process.stdout.write(s))
  const verbose = options.verbose

  // 状态展示状态机
  let currentState: StatusState = 'idle'
  let currentStateText = 'Ready'
  let repoName = ''
  let branch = ''
  let debugLogPath = ''

  // 连接 URL，由 printBanner 使用 staging/prod 对应的正确 base 构造
  let connectUrl = ''
  let cachedIngressUrl = ''
  let cachedEnvironmentId = ''
  let activeSessionUrl: string | null = null

  // 当前 URL 对应的二维码文本行
  let qrLines: string[] = []
  let qrVisible = false

  // 第二行状态中展示的工具活动
  let lastToolSummary: string | null = null
  let lastToolTime = 0

  // 会话数量指示器，仅在多会话模式下显示
  let sessionActive = 0
  let sessionMax = 1
  // 会话数量行显示的启动模式，同时控制是否显示 `w` 提示
  let spawnModeDisplay: 'same-dir' | 'worktree' | null = null
  let spawnMode: SpawnMode = 'single-session'

  // 多会话项目列表中各会话的展示信息，以兼容 sessionId 为 key
  const sessionDisplayInfo = new Map<
    string,
    { title?: string; url: string; activity?: SessionActivity }
  >()

  // 连接中 spinner 的状态
  let connectingTimer: ReturnType<typeof setInterval> | null = null
  let connectingTick = 0

  /**
   * 计算字符串实际占用的终端行数，并考虑自动换行。每个 `\n` 占一行，宽于终端的内容还会
   * 折行占用额外行。
   */
  function _countVisualLines(text: string): number {
    // eslint-disable-next-line custom-rules/prefer-use-terminal-size
    const cols = process.stdout.columns || 80 // 非 React CLI context
    let count = 0
    // 按换行符拆分为逻辑行
    for (const logical of text.split('\n')) {
      if (logical.length === 0) {
        // 连续 \n 之间的空片段计为一行
        count++
        continue
      }
      const width = stringWidth(logical)
      count += Math.max(1, Math.ceil(width / cols))
    }
    // "line\n" 末尾的 \n 会产生空的最后一项，但光标只是停在下一行开头，并未占用新的可视行，
    // 因此不计入。
    if (text.endsWith('\n')) {
      count--
    }
    return count
  }

  /** 写入状态行。 */
  function writeStatus(text: string): void {
    write(text)
  }

  /** 清除当前显示的所有状态行。 */
  function clearStatusLines(): void {
    write('\x1b[J') // 从光标位置清除到屏幕末尾
  }

  /** 输出永久日志行；先清除状态展示，随后由下一次渲染恢复。 */
  function printLog(line: string): void {
    clearStatusLines()
    write(line)
  }

  /** 根据给定 URL 重新生成二维码。 */
  function regenerateQr(url: string): void {
    generateQr(url)
      .then((lines) => {
        qrLines = lines
        renderStatusLine()
      })
      .catch((e) => {
        logForDebugging(`QR code generation failed: ${e}`, { level: 'error' })
      })
  }

  /** 渲染连接中的 spinner 行，在首次 updateIdleStatus 前显示。 */
  function renderConnectingLine(): void {
    clearStatusLines()

    const frame = BRIDGE_SPINNER_FRAMES[connectingTick % BRIDGE_SPINNER_FRAMES.length]!
    let suffix = ''
    if (repoName) {
      suffix += chalk.dim(' \u00b7 ') + chalk.dim(repoName)
    }
    if (branch) {
      suffix += chalk.dim(' \u00b7 ') + chalk.dim(branch)
    }
    writeStatus(`${chalk.yellow(frame)} ${chalk.yellow('Connecting')}${suffix}\n`)
  }

  /** 启动连接中的 spinner，首次 updateIdleStatus() 会将其停止。 */
  function startConnecting(): void {
    stopConnecting()
    renderConnectingLine()
    connectingTimer = setInterval(() => {
      connectingTick++
      renderConnectingLine()
    }, 150)
  }

  /** 停止连接中的 spinner。 */
  function stopConnecting(): void {
    if (connectingTimer) {
      clearInterval(connectingTimer)
      connectingTimer = null
    }
  }

  /** 根据当前状态渲染并写入状态行。 */
  function renderStatusLine(): void {
    if (currentState === 'reconnecting' || currentState === 'failed') {
      // 这些状态分别由 updateReconnectingStatus / updateFailedStatus 处理。清除前直接返回，
      // 避免 toggleQr、setSpawnModeDisplay 等调用方在这些状态下清空展示。
      return
    }

    clearStatusLines()

    const isIdle = currentState === 'idle'

    // 状态行上方的二维码
    if (qrVisible) {
      for (const line of qrLines) {
        writeStatus(`${chalk.dim(line)}\n`)
      }
    }

    // 根据状态确定指示符与颜色
    const indicator = BRIDGE_READY_INDICATOR
    const indicatorColor = isIdle ? chalk.green : chalk.cyan
    const baseColor = isIdle ? chalk.green : chalk.cyan
    const stateText = baseColor(currentStateText)

    // 用 repo 与 branch 构造后缀
    let suffix = ''
    if (repoName) {
      suffix += chalk.dim(' \u00b7 ') + chalk.dim(repoName)
    }
    // worktree 模式下每个会话都有自己的 branch，显示 bridge 所在 branch 会产生误导。
    if (branch && spawnMode !== 'worktree') {
      suffix += chalk.dim(' \u00b7 ') + chalk.dim(branch)
    }

    if (isInternalBuild() && debugLogPath) {
      writeStatus(`${chalk.yellow('[INNER-ONLY] Logs:')} ${chalk.dim(debugLogPath)}\n`)
    }
    writeStatus(`${indicatorColor(indicator)} ${stateText}${suffix}\n`)

    // 会话数量及各会话列表，仅用于多会话模式
    if (sessionMax > 1) {
      const modeHint =
        spawnMode === 'worktree'
          ? 'New sessions will be created in an isolated worktree'
          : 'New sessions will be created in the current directory'
      writeStatus(
        `    ${chalk.dim(`Capacity: ${sessionActive}/${sessionMax} \u00b7 ${modeHint}`)}\n`,
      )
      for (const [, info] of sessionDisplayInfo) {
        const titleText = info.title ? truncatePrompt(info.title, 35) : chalk.dim('Attached')
        const titleLinked = wrapWithOsc8Link(titleText, info.url)
        const act = info.activity
        const showAct = act && act.type !== 'result' && act.type !== 'error'
        const actText = showAct ? chalk.dim(` ${truncatePrompt(act.summary, 40)}`) : ''
        writeStatus(`    ${titleLinked}${actText}
`)
      }
    }

    // 只有一个槽位的启动模式或真正单会话模式所用的模式行
    if (sessionMax === 1) {
      const modeText =
        spawnMode === 'single-session'
          ? 'Single session \u00b7 exits when complete'
          : spawnMode === 'worktree'
            ? `Capacity: ${sessionActive}/1 \u00b7 New sessions will be created in an isolated worktree`
            : `Capacity: ${sessionActive}/1 \u00b7 New sessions will be created in the current directory`
      writeStatus(`    ${chalk.dim(modeText)}\n`)
    }

    // 单会话模式的工具活动行
    if (
      sessionMax === 1 &&
      !isIdle &&
      lastToolSummary &&
      Date.now() - lastToolTime < TOOL_DISPLAY_EXPIRY_MS
    ) {
      writeStatus(`  ${chalk.dim(truncatePrompt(lastToolSummary, 60))}\n`)
    }

    // footer 前的空行分隔符
    const url = activeSessionUrl ?? connectUrl
    if (url) {
      writeStatus('\n')
      const footerText = isIdle ? buildIdleFooterText(url) : buildActiveFooterText(url)
      const qrHint = qrVisible
        ? chalk.dim.italic('space to hide QR code')
        : chalk.dim.italic('space to show QR code')
      const toggleHint = spawnModeDisplay ? chalk.dim.italic(' \u00b7 w to toggle spawn mode') : ''
      writeStatus(`${chalk.dim(footerText)}\n`)
      writeStatus(`${qrHint}${toggleHint}\n`)
    }
  }

  return {
    printBanner(config: WireConfig, environmentId: string): void {
      cachedIngressUrl = config.sessionIngressUrl
      cachedEnvironmentId = environmentId
      connectUrl = buildWireConnectUrl(environmentId, cachedIngressUrl)
      regenerateQr(connectUrl)

      if (verbose) {
        write(`${chalk.dim(`Remote Control`)} v${MACRO.VERSION}\n`)
      }
      if (verbose) {
        if (config.spawnMode !== 'single-session') {
          write(`${chalk.dim(`Spawn mode: `)}${config.spawnMode}\n`)
          write(`${chalk.dim(`Max concurrent sessions: `)}${config.maxSessions}\n`)
        }
        write(`${chalk.dim(`Environment ID: `)}${environmentId}\n`)
      }
      if (config.sandbox) {
        write(`${chalk.dim(`Sandbox: `)}${chalk.green('Enabled')}\n`)
      }
      write('\n')

      // 启动连接中的 spinner，首次 updateIdleStatus() 会停止它
      startConnecting()
    },

    logSessionStart(sessionId: string, prompt: string): void {
      if (verbose) {
        const short = truncatePrompt(prompt, 80)
        printLog(
          chalk.dim(`[${timestamp()}]`) +
            ` Session started: ${chalk.white(`"${short}"`)} (${chalk.dim(sessionId)})\n`,
        )
      }
    },

    logSessionComplete(sessionId: string, durationMs: number): void {
      printLog(
        chalk.dim(`[${timestamp()}]`) +
          ` Session ${chalk.green('completed')} (${formatDuration(durationMs)}) ${chalk.dim(sessionId)}\n`,
      )
    },

    logSessionFailed(sessionId: string, error: string): void {
      printLog(
        chalk.dim(`[${timestamp()}]`) +
          ` Session ${chalk.red('failed')}: ${error} ${chalk.dim(sessionId)}\n`,
      )
    },

    logStatus(message: string): void {
      printLog(`${chalk.dim(`[${timestamp()}]`)} ${message}\n`)
    },

    logVerbose(message: string): void {
      if (verbose) {
        printLog(`${chalk.dim(`[${timestamp()}] ${message}`)}\n`)
      }
    },

    logError(message: string): void {
      printLog(`${chalk.red(`[${timestamp()}] Error: ${message}`)}\n`)
    },

    logReconnected(disconnectedMs: number): void {
      printLog(
        chalk.dim(`[${timestamp()}]`) +
          ` ${chalk.green('Reconnected')} after ${formatDuration(disconnectedMs)}\n`,
      )
    },

    setRepoInfo(repo: string, branchName: string): void {
      repoName = repo
      branch = branchName
    },

    setDebugLogPath(path: string): void {
      debugLogPath = path
    },

    updateIdleStatus(): void {
      stopConnecting()

      currentState = 'idle'
      currentStateText = 'Ready'
      lastToolSummary = null
      lastToolTime = 0
      activeSessionUrl = null
      regenerateQr(connectUrl)
      renderStatusLine()
    },

    setAttached(sessionId: string): void {
      stopConnecting()
      currentState = 'attached'
      currentStateText = 'Connected'
      lastToolSummary = null
      lastToolTime = 0
      // 多会话模式下 footer 与二维码继续使用环境连接 URL，以便用户启动更多会话；各会话链接
      // 位于项目列表中。
      if (sessionMax <= 1) {
        activeSessionUrl = buildWireSessionUrl(sessionId, cachedEnvironmentId, cachedIngressUrl)
        regenerateQr(activeSessionUrl)
      }
      renderStatusLine()
    },

    updateReconnectingStatus(delayStr: string, elapsedStr: string): void {
      stopConnecting()
      clearStatusLines()
      currentState = 'reconnecting'

      // 状态行上方的二维码
      if (qrVisible) {
        for (const line of qrLines) {
          writeStatus(`${chalk.dim(line)}\n`)
        }
      }

      const frame = BRIDGE_SPINNER_FRAMES[connectingTick % BRIDGE_SPINNER_FRAMES.length]!
      connectingTick++
      writeStatus(
        `${chalk.yellow(frame)} ${chalk.yellow('Reconnecting')} ${chalk.dim('\u00b7')} ${chalk.dim(`retrying in ${delayStr}`)} ${chalk.dim('\u00b7')} ${chalk.dim(`disconnected ${elapsedStr}`)}\n`,
      )
    },

    updateFailedStatus(error: string): void {
      stopConnecting()
      clearStatusLines()
      currentState = 'failed'

      let suffix = ''
      if (repoName) {
        suffix += chalk.dim(' \u00b7 ') + chalk.dim(repoName)
      }
      if (branch) {
        suffix += chalk.dim(' \u00b7 ') + chalk.dim(branch)
      }

      writeStatus(
        `${chalk.red(BRIDGE_FAILED_INDICATOR)} ${chalk.red('Remote Control Failed')}${suffix}\n`,
      )
      writeStatus(`${chalk.dim(FAILED_FOOTER_TEXT)}\n`)

      if (error) {
        writeStatus(`${chalk.red(error)}\n`)
      }
    },

    updateSessionStatus(
      _sessionId: string,
      _elapsed: string,
      activity: SessionActivity,
      _trail: string[],
    ): void {
      // 缓存工具活动，供第二行状态展示
      if (activity.type === 'tool_start') {
        lastToolSummary = activity.summary
        lastToolTime = Date.now()
      }
      renderStatusLine()
    },

    clearStatus(): void {
      stopConnecting()
      clearStatusLines()
    },

    toggleQr(): void {
      qrVisible = !qrVisible
      renderStatusLine()
    },

    updateSessionCount(active: number, max: number, mode: SpawnMode): void {
      if (sessionActive === active && sessionMax === max && spawnMode === mode) {
        return
      }
      sessionActive = active
      sessionMax = max
      spawnMode = mode
      // 此处不重新渲染；状态 ticker 会按自身节奏调用 renderStatusLine，下一个 tick 会读取新值。
    },

    setSpawnModeDisplay(mode: 'same-dir' | 'worktree' | null): void {
      if (spawnModeDisplay === mode) {
        return
      }
      spawnModeDisplay = mode
      // 同时同步 #21118 新增的 spawnMode，使下次渲染显示正确的模式提示与 branch 可见性。
      // 此处不渲染，与 updateSessionCount 一致：初始设置时在 printBanner 前调用，之后由 `w`
      // handler 调用并紧接着执行 refreshDisplay。
      if (mode) {
        spawnMode = mode
      }
    },

    addSession(sessionId: string, url: string): void {
      sessionDisplayInfo.set(sessionId, { url })
    },

    updateSessionActivity(sessionId: string, activity: SessionActivity): void {
      const info = sessionDisplayInfo.get(sessionId)
      if (!info) {
        return
      }
      info.activity = activity
    },

    setSessionTitle(sessionId: string, title: string): void {
      const info = sessionDisplayInfo.get(sessionId)
      if (!info) {
        return
      }
      info.title = title
      // 防止 reconnecting/failed 状态下渲染；renderStatusLine 会先清除再提前返回，从而擦掉
      // spinner 或错误信息。
      if (currentState === 'reconnecting' || currentState === 'failed') {
        return
      }
      if (sessionMax === 1) {
        // 单会话模式下也在主状态行显示标题。
        currentState = 'titled'
        currentStateText = truncatePrompt(title, 40)
      }
      renderStatusLine()
    },

    removeSession(sessionId: string): void {
      sessionDisplayInfo.delete(sessionId)
    },

    refreshDisplay(): void {
      // reconnecting/failed 状态下跳过；renderStatusLine 会先清除再提前返回，从而擦掉 spinner
      // 或错误信息。
      if (currentState === 'reconnecting' || currentState === 'failed') {
        return
      }
      renderStatusLine()
    },
  }
}
