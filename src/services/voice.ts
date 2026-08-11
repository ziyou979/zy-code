// 语音服务：按住说话语音输入的音频录制。
//
// 录制在 macOS、Linux、Windows 上使用原生音频捕获 (cpal) 实现进程内麦克风访问。
// 若原生模块不可用，Linux 下回退到 SoX `rec` 或 arecord (ALSA)。

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { logForDebugging } from '../services/infra/debug.js'
import { isEnvTruthy, isRunningOnHomespace } from '../services/infra/envUtils.js'
import { logError } from '../services/infra/log.js'
import { getPlatform } from './shell/platform.js'

// 惰性加载原生音频模块。audio-capture.node 链接
// CoreAudio.framework + AudioUnit.framework；dlopen 是同步的且
// 会阻塞事件循环 ~1s 预热，冷启动 coreaudiod 时长达 ~8s
// (唤醒后、启动后)。在首次语音按键时加载 —— 不预加载，
// 因为无法让 dlopen 非阻塞，启动冻结比首次按键延迟更糟。
// @ts-expect-error
type AudioNapi = typeof import('audio-capture-napi')
let audioNapi: AudioNapi | null = null
let audioNapiPromise: Promise<AudioNapi> | null = null

function loadAudioNapi(): Promise<AudioNapi> {
  audioNapiPromise ??= (async () => {
    const startTime = Date.now()
    // @ts-expect-error
    const mod = await import('audio-capture-napi')
    // vendor/audio-capture-src/index.ts 将 require(...node) 推迟到
    // 首次函数调用 —— 这里触发它以使计时反映真实开销。
    mod.isNativeAudioAvailable()
    audioNapi = mod
    logForDebugging(`[voice] audio-capture-napi loaded in ${Date.now() - startTime}ms`)
    return mod
  })()
  return audioNapiPromise
}

// ─── Constants ───────────────────────────────────────────────────────

const RECORDING_SAMPLE_RATE = 16000
const RECORDING_CHANNELS = 1

// SoX 静音检测：在此静音时长后停止
const SILENCE_DURATION_SECS = '2.0'
const SILENCE_THRESHOLD = '3%'

// ─── Dependency check ────────────────────────────────────────────────

function hasCommand(cmd: string): boolean {
  // 直接生成目标命令而不用 `which cmd`。在 Termux/Android 上
  // `which` 是 shell 内置 —— 外部二进制不存在或
  // 被内核阻塞 (EPERM)（从 Node 生成时）。仅在非 Windows 上到达
  // 非 Windows (win32 从所有调用者提前返回)，无 PATHEXT 问题。
  // result.error 仅在生成本身失败 (ENOENT/EACCES) 时设置；退出
  // 码无关 —— 无法识别的 --version 仍意味着命令存在。
  const result = spawnSync(cmd, ['--version'], {
    stdio: 'ignore',
    timeout: 3000,
  })
  return result.error === undefined
}

// 探测 arecord 能否真正打开捕获设备。hasCommand()
// 仅检查 PATH；在 WSL1/Win10-WSL2/无头 Linux 上二进制存在
// 但 open() 失败，因为没有 ALSA 卡且无 PulseAudio
// 服务器。在 WSL2+WSLg (Win11) 上，PulseAudio 通过 RDP 管道工作，arecord
// 成功。我们用与 startArecordRecording() 相同的参数生成并竞争
// 短计时器：若进程在 150ms 后仍存活则打开了设备；若提前退出则 stderr 告知原因。
// 记忆化 —— 音频设备可用性会话中不变，每次语音按键通过 checkRecordingAvailability() 调用。
type ArecordProbeResult = { ok: boolean; stderr: string }
let arecordProbe: Promise<ArecordProbeResult> | null = null

function probeArecord(): Promise<ArecordProbeResult> {
  arecordProbe ??= new Promise((resolve) => {
    const child = spawn(
      'arecord',
      [
        '-f',
        'S16_LE',
        '-r',
        String(RECORDING_SAMPLE_RATE),
        '-c',
        String(RECORDING_CHANNELS),
        '-t',
        'raw',
        '/dev/null',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const timer = setTimeout(
      (c: ChildProcess, r: (v: ArecordProbeResult) => void) => {
        c.kill('SIGTERM')
        r({ ok: true, stderr: '' })
      },
      150,
      child,
      resolve,
    )
    child.once('close', (code) => {
      clearTimeout(timer)
      // SIGTERM 关闭 (code=null) 在计时器触发后已解析。
      // 早期以 code=0 关闭不寻常 (arecord 不应自行退出)
      // 但视为 ok。
      void resolve({ ok: code === 0, stderr: stderr.trim() })
    })
    child.once('error', () => {
      clearTimeout(timer)
      void resolve({ ok: false, stderr: 'arecord: command not found' })
    })
  })
  return arecordProbe
}

export function _resetArecordProbeForTesting(): void {
  arecordProbe = null
}

// cpal 的 ALSA 后端在找不到声卡时写入我们的进程 stderr
// (它在进程内运行 —— 无子进程管道捕获)。下面的生成回退
// 正确管道 stderr，所以当 ALSA 无设备可开时跳过原生。
// 记忆化：声卡存在性会话中不变。
let linuxAlsaCardsMemo: Promise<boolean> | null = null

function linuxHasAlsaCards(): Promise<boolean> {
  linuxAlsaCardsMemo ??= readFile('/proc/asound/cards', 'utf8').then(
    (cards) => {
      const c = cards.trim()
      return c !== '' && !c.includes('no soundcards')
    },
    () => false,
  )
  return linuxAlsaCardsMemo
}

export function _resetAlsaCardsForTesting(): void {
  linuxAlsaCardsMemo = null
}

type PackageManagerInfo = {
  cmd: string
  args: string[]
  displayCommand: string
}

function detectPackageManager(): PackageManagerInfo | null {
  if (process.platform === 'darwin') {
    if (hasCommand('brew')) {
      return {
        cmd: 'brew',
        args: ['install', 'sox'],
        displayCommand: 'brew install sox',
      }
    }
    return null
  }

  if (process.platform === 'linux') {
    if (hasCommand('apt-get')) {
      return {
        cmd: 'sudo',
        args: ['apt-get', 'install', '-y', 'sox'],
        displayCommand: 'sudo apt-get install sox',
      }
    }
    if (hasCommand('dnf')) {
      return {
        cmd: 'sudo',
        args: ['dnf', 'install', '-y', 'sox'],
        displayCommand: 'sudo dnf install sox',
      }
    }
    if (hasCommand('pacman')) {
      return {
        cmd: 'sudo',
        args: ['pacman', '-S', '--noconfirm', 'sox'],
        displayCommand: 'sudo pacman -S sox',
      }
    }
  }

  return null
}

export async function checkVoiceDependencies(): Promise<{
  available: boolean
  missing: string[]
  installCommand: string | null
}> {
  // 原生音频模块 (cpal) 在 macOS、Linux、Windows 上处理一切
  const napi = await loadAudioNapi()
  if (napi.isNativeAudioAvailable()) {
    return { available: true, missing: [], installCommand: null }
  }

  // Windows 无支持的回退 —— 必须有原生模块
  if (process.platform === 'win32') {
    return {
      available: false,
      missing: ['Voice mode requires the native audio module (not loaded)'],
      installCommand: null,
    }
  }

  // Linux 上，arecord (ALSA utils) 是有效的回退录制后端
  if (process.platform === 'linux' && hasCommand('arecord')) {
    return { available: true, missing: [], installCommand: null }
  }

  const missing: string[] = []

  if (!hasCommand('rec')) {
    missing.push('sox (rec command)')
  }

  const pm = missing.length > 0 ? detectPackageManager() : null
  return {
    available: missing.length === 0,
    missing,
    installCommand: pm?.displayCommand ?? null,
  }
}

// ─── Recording availability ──────────────────────────────────────────

export type RecordingAvailability = {
  available: boolean
  reason: string | null
}

// 通过完整回退链 (原生 → arecord → SoX) 探测录制，验证至少有一个后端可录制。
// macOS 上这也会在首次使用时触发 TCC 权限对话框。我们信任探测结果
// 而非 TCC 状态 API，后者对临时签名或跨架构二进制 (如 x64-on-arm64)
// 可能不可靠。
export async function requestMicrophonePermission(): Promise<boolean> {
  const napi = await loadAudioNapi()
  if (!napi.isNativeAudioAvailable()) {
    return true // non-native platforms skip this check
  }

  const started = await startRecording(
    (_chunk) => {}, // discard audio data — this is a permission probe only
    () => {}, // ignore silence-detection end signal
    { silenceDetection: false },
  )
  if (started) {
    stopRecording()
    return true
  }
  return false
}

export async function checkRecordingAvailability(): Promise<RecordingAvailability> {
  // 远程环境无本地麦克风
  if (isRunningOnHomespace() || isEnvTruthy(process.env.ZY_CODE_REMOTE)) {
    return {
      available: false,
      reason:
        'Voice mode requires microphone access, but no audio device is available in this environment.\n\nTo use voice mode, run ZY Code locally instead.',
    }
  }

  // 原生音频模块 (cpal) 在 macOS、Linux、Windows 上处理一切
  const napi = await loadAudioNapi()
  if (napi.isNativeAudioAvailable()) {
    return { available: true, reason: null }
  }

  // Windows 无支持的回退
  if (process.platform === 'win32') {
    return {
      available: false,
      reason: 'Voice recording requires the native audio module, which could not be loaded.',
    }
  }

  const wslNoAudioReason =
    'Voice mode could not access an audio device in WSL.\n\nWSL2 with WSLg (Windows 11) providesaudio via PulseAudio — if you are on Windows 10 or WSL1, run ZY Code in native Windows instead.'

  // Linux (含 WSL) 上探测 arecord。hasCommand() 不足：
  // 二进制可能存在但设备 open() 失败 (WSL1、Win10-WSL2、
  // 无头 Linux)。WSL2+WSLg (Win11 默认) 通过 PulseAudio RDP
  // 管道工作 —— cpal 失败 (无 /proc/asound/cards) 但 arecord 成功。
  if (process.platform === 'linux' && hasCommand('arecord')) {
    const probe = await probeArecord()
    if (probe.ok) {
      return { available: true, reason: null }
    }
    if (getPlatform() === 'wsl') {
      return { available: false, reason: wslNoAudioReason }
    }
    logForDebugging(`[voice] arecord probe failed: ${probe.stderr}`)
    // 回退到 SoX
  }

  // 回退：检查 SoX
  if (!hasCommand('rec')) {
    // 无 arecord 且无 SoX 的 WSL：下面的通用"安装 SoX"
    // 提示在 WSL1/Win10 (完全无音频设备) 上有误导性，
    // 但在 WSL2+WSLg (SoX 通过 PulseAudio 工作) 上正确。由于无后端探测无法区分
    // 区分 WSLg 与否，显示 WSLg 指引
    // 它既指引 WSL1 用户去原生 Windows，又告诉 WSLg
    // 用户其设置应可工作 (可安装 sox 或 alsa-utils)。
    // 已知缺口：有 SoX 但无 arecord 的 WSL 会跳过此分支和上方探测 ——
    // 上方探测 —— hasCommand('rec') 同样会欺骗。我们乐观信任它
    // (WSLg+SoX 应可用) 而非 probeSox()，针对近零人口
    // (WSL1 × 最小发行版 × SoX-but-not-alsa-utils)。
    if (getPlatform() === 'wsl') {
      return { available: false, reason: wslNoAudioReason }
    }
    const pm = detectPackageManager()
    return {
      available: false,
      reason: pm
        ? `Voice mode requires SoX for audio recording. Install it with: ${pm.displayCommand}`
        : 'Voice mode requires SoX for audio recording. Install SoX manually:\n  macOS: brew install sox\n  Ubuntu/Debian: sudo apt-get install sox\n  Fedora: sudo dnf install sox',
    }
  }

  return { available: true, reason: null }
}

// ─── Recording (native audio on macOS/Linux/Windows, SoX/arecord fallback on Linux) ─────────────

let activeRecorder: ChildProcess | null = null
let nativeRecordingActive = false

export async function startRecording(
  onData: (chunk: Buffer) => void,
  onEnd: () => void,
  options?: { silenceDetection?: boolean },
): Promise<boolean> {
  logForDebugging(`[voice] startRecording called, platform=${process.platform}`)

  // 优先尝试原生音频模块 (macOS、Linux、Windows 通过 cpal)
  const napi = await loadAudioNapi()
  const nativeAvailable =
    napi.isNativeAudioAvailable() && (process.platform !== 'linux' || (await linuxHasAlsaCards()))
  const useSilenceDetection = options?.silenceDetection !== false
  if (nativeAvailable) {
    // 确保任何之前的录制完全停止
    if (nativeRecordingActive || napi.isNativeRecordingActive()) {
      napi.stopNativeRecording()
      nativeRecordingActive = false
    }
    const started = napi.startNativeRecording(
      (data: Buffer) => {
        onData(data)
      },
      () => {
        if (useSilenceDetection) {
          nativeRecordingActive = false
          onEnd()
        }
        // 按住说话模式下，忽略原生模块的静音触发
        // onEnd。录制持续到调用者显式调用
        // stopRecording() (如用户按 Ctrl+X)。
      },
    )
    if (started) {
      nativeRecordingActive = true
      return true
    }
    // 原生录制失败 —— 回退到平台回退方案
  }

  // Windows 无支持的回退
  if (process.platform === 'win32') {
    logForDebugging('[voice] Windows native recording unavailable, no fallback')
    return false
  }

  // Linux 上，先尝试 arecord (ALSA utils) 再尝试 SoX。查阅探测结果以便
  // 后端选择与 checkRecordingAvailability() 一致 —— 否则
  // 在同时装有 alsa-utils 和 SoX 的无头 Linux 上，可用性
  // 检查会回退到 SoX (probe.ok=false、非 WSL) 但此路径
  // 仍会选中损坏的 arecord。探测已记忆化；零延迟。
  if (process.platform === 'linux' && hasCommand('arecord') && (await probeArecord()).ok) {
    return startArecordRecording(onData, onEnd)
  }

  // 回退：SoX rec (Linux，或原生模块不可用时的 macOS)
  return startSoxRecording(onData, onEnd, options)
}

function startSoxRecording(
  onData: (chunk: Buffer) => void,
  onEnd: () => void,
  options?: { silenceDetection?: boolean },
): boolean {
  const useSilenceDetection = options?.silenceDetection !== false

  // 录制原始 PCM：16 kHz、16 位有符号、单声道，输出到 stdout。
  // --buffer 1024 强制 SoX 以小块刷新音频，而不是
  // 在内部缓冲区累积数据。没有此选项，SoX 通过管道时可能
  // 在写入 stdout 前缓冲数秒音频，
  // 导致零数据流直到进程退出。
  const args = [
    '-q', // quiet
    '--buffer',
    '1024',
    '-t',
    'raw',
    '-r',
    String(RECORDING_SAMPLE_RATE),
    '-e',
    'signed',
    '-b',
    '16',
    '-c',
    String(RECORDING_CHANNELS),
    '-', // stdout
  ]

  // 添加静音检测滤波器 (静音时自动停止)。
  // 按住说话模式下省略，由用户手动控制开始/停止。
  if (useSilenceDetection) {
    args.push(
      'silence', // start/stop on silence
      '1',
      '0.1',
      SILENCE_THRESHOLD,
      '1',
      SILENCE_DURATION_SECS,
      SILENCE_THRESHOLD,
    )
  }

  const child = spawn('rec', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  activeRecorder = child

  child.stdout?.on('data', (chunk: Buffer) => {
    onData(chunk)
  })

  // 消费 stderr 以防止背压
  child.stderr?.on('data', () => {})

  child.on('close', () => {
    activeRecorder = null
    onEnd()
  })

  child.on('error', (err) => {
    logError(err)
    activeRecorder = null
    onEnd()
  })

  return true
}

function startArecordRecording(onData: (chunk: Buffer) => void, onEnd: () => void): boolean {
  // 录制原始 PCM：16 kHz、16 位有符号小端序、单声道，输出到 stdout。
  // arecord 不支持内置静音检测，因此此后端
  // is best suited for push-to-talk (silenceDetection: false).
  const args = [
    '-f',
    'S16_LE', // signed 16-bit little-endian
    '-r',
    String(RECORDING_SAMPLE_RATE),
    '-c',
    String(RECORDING_CHANNELS),
    '-t',
    'raw', // raw PCM, no WAV header
    '-q', // quiet — no progress output
    '-', // write to stdout
  ]

  const child = spawn('arecord', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  activeRecorder = child

  child.stdout?.on('data', (chunk: Buffer) => {
    onData(chunk)
  })

  // 消费 stderr 以防止背压
  child.stderr?.on('data', () => {})

  child.on('close', () => {
    activeRecorder = null
    onEnd()
  })

  child.on('error', (err) => {
    logError(err)
    activeRecorder = null
    onEnd()
  })

  return true
}

export function stopRecording(): void {
  if (nativeRecordingActive && audioNapi) {
    audioNapi.stopNativeRecording()
    nativeRecordingActive = false
    return
  }
  if (activeRecorder) {
    activeRecorder.kill('SIGTERM')
    activeRecorder = null
  }
}
