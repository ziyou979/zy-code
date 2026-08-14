// 使用 Anthropic voice_stream STT 实现按住说话语音输入的 React hook。
//
// 按住 keybinding 录音，松开后停止并提交。自动重复 key event 会重置内部定时器；
// RELEASE_TIMEOUT_MS 内没有新按键时自动停止录音。使用原生 audio 模块（macOS）
// 或 SoX 录音，并调用 Anthropic voice_stream endpoint（conversation_engine）进行 STT。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSetVoiceState } from '../context/voice.js'
import { useTerminalFocus } from '../ink/hooks/useTerminalFocus.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { getVoiceKeyterms } from '../services/voiceKeyterms.js'
import {
  connectVoiceStream,
  type FinalizeSource,
  isVoiceStreamAvailable,
  type VoiceStreamConnection,
} from '../services/voiceStreamSTT.js'
import { logForDebugging } from '../services/infra/debug.js'
import { toError } from '../utils/errors.js'
import { getSystemLocaleLanguage } from '../utils/intl.js'
import { logError } from '../services/infra/log.js'
import { getInitialSettings } from '../services/settings/settings.js'
import { sleep } from '../utils/sleep.js'

// ─── Language normalization ─────────────────────────────────────────────

const DEFAULT_STT_LANGUAGE = 'en'

// 将英文和本地语言名称映射为 voice_stream Deepgram backend 支持的 BCP-47 code。
// key 必须为小写。
//
// 此列表必须是服务端 supported_language_codes allowlist 的子集
//（GrowthBook: speech_to_text_voice_stream_config）。若 CLI 发送服务端拒绝的 code，
// WebSocket 会以 1008 "Unsupported language" 关闭，导致语音失效。
// 不支持的语言回退到 DEFAULT_STT_LANGUAGE，使录音仍可使用。
const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  español: 'es',
  espanol: 'es',
  french: 'fr',
  français: 'fr',
  francais: 'fr',
  japanese: 'ja',
  日本語: 'ja',
  german: 'de',
  deutsch: 'de',
  portuguese: 'pt',
  português: 'pt',
  portugues: 'pt',
  italian: 'it',
  italiano: 'it',
  korean: 'ko',
  한국어: 'ko',
  hindi: 'hi',
  हिन्दी: 'hi',
  हिंदी: 'hi',
  indonesian: 'id',
  'bahasa indonesia': 'id',
  bahasa: 'id',
  russian: 'ru',
  русский: 'ru',
  polish: 'pl',
  polski: 'pl',
  turkish: 'tr',
  türkçe: 'tr',
  turkce: 'tr',
  dutch: 'nl',
  nederlands: 'nl',
  ukrainian: 'uk',
  українська: 'uk',
  greek: 'el',
  ελληνικά: 'el',
  czech: 'cs',
  čeština: 'cs',
  cestina: 'cs',
  danish: 'da',
  dansk: 'da',
  swedish: 'sv',
  svenska: 'sv',
  norwegian: 'no',
  norsk: 'no',
}

// GrowthBook speech_to_text_voice_stream_config allowlist 的子集。
// 发送不在服务端 allowlist 中的 code 会关闭连接。
const SUPPORTED_LANGUAGE_CODES = new Set([
  'en',
  'es',
  'fr',
  'ja',
  'de',
  'pt',
  'it',
  'ko',
  'hi',
  'id',
  'ru',
  'pl',
  'tr',
  'nl',
  'uk',
  'el',
  'cs',
  'da',
  'sv',
  'no',
])

// 将 settings.language 中的语言偏好字符串规范化为 voice_stream endpoint 支持的
// BCP-47 code。无法解析时返回默认语言；输入非空但不受支持时，将 fellBackFrom
// 设为原始输入，供调用方显示警告。
export function normalizeLanguageForSTT(language: string | undefined): {
  code: string
  fellBackFrom?: string
} {
  if (!language) {
    return { code: DEFAULT_STT_LANGUAGE }
  }
  const lower = language.toLowerCase().trim()
  if (!lower) {
    return { code: DEFAULT_STT_LANGUAGE }
  }
  if (SUPPORTED_LANGUAGE_CODES.has(lower)) {
    return { code: lower }
  }
  const fromName = LANGUAGE_NAME_TO_CODE[lower]
  if (fromName) {
    return { code: fromName }
  }
  const base = lower.split('-')[0]
  if (base && SUPPORTED_LANGUAGE_CODES.has(base)) {
    return { code: base }
  }
  return { code: DEFAULT_STT_LANGUAGE, fellBackFrom: language }
}

// 延迟加载 voice 模块。实际激活语音输入前不导入 voice.ts 及其原生
// audio-capture-napi 依赖。在 macOS 上加载原生 audio 模块可能触发 TCC 麦克风
// 权限提示，因此必须等到真正启用语音输入。
type VoiceModule = typeof import('../services/voice.js')
let voiceModule: VoiceModule | null = null

type VoiceState = 'idle' | 'recording' | 'processing'

type UseVoiceOptions = {
  onTranscript: (text: string) => void
  onError?: (message: string) => void
  enabled: boolean
  focusMode: boolean
}

type UseVoiceReturn = {
  state: VoiceState
  handleKeyEvent: (fallbackMs?: number) => void
}

// 用于判定按键已松开的自动重复 key event 间隔（毫秒）。终端通常每 30-80ms
// 自动重复一次，200ms 足以覆盖抖动，同时保持响应及时。
const RELEASE_TIMEOUT_MS = 200

// 未检测到自动重复时启动 release timer 的 fallback（毫秒）。macOS 默认按键重复延迟
// 约 500ms，600ms 留有余量；用户在重复开始前轻触并松开时，也能确保定时器启动并停止录音。
//
// modifier 组合键首次按下激活时，handleKeyEvent 在自动重复前的 t=0 调用，调用方应传入
// FIRST_PRESS_FALLBACK_MS。到下次按键的间隔是 OS 初始重复延迟，而非重复频率；
// macOS 将滑块设为 "Long" 时最长约 2 秒。
const REPEAT_FALLBACK_MS = 600
export const FIRST_PRESS_FALLBACK_MS = 2000

// focus 模式无语音时继续保留会话的时长（毫秒），超时后释放 WebSocket 连接。
// 下一次 blur → refocus 焦点周期会重新启用。
const FOCUS_SILENCE_TIMEOUT_MS = 5_000

// 录音波形可视化中显示的 bar 数量。
const AUDIO_LEVEL_BARS = 16

// 根据 16-bit signed PCM buffer 计算 RMS 振幅，并返回归一化到 0-1 的值。
// sqrt 曲线将较低音量展开到更大的视觉范围，使波形能利用全部 block 高度。
export function computeLevel(chunk: Buffer): number {
  const samples = chunk.length >> 1 // 16-bit = 2 bytes per sample
  if (samples === 0) {
    return 0
  }
  let sumSq = 0
  for (let i = 0; i < chunk.length - 1; i += 2) {
    // 读取 16-bit signed little-endian
    const sample = ((chunk[i]! | (chunk[i + 1]! << 8)) << 16) >> 16
    sumSq += sample * sample
  }
  const rms = Math.sqrt(sumSq / samples)
  const normalized = Math.min(rms / 2000, 1)
  return Math.sqrt(normalized)
}

export function useVoice({
  onTranscript,
  onError,
  enabled,
  focusMode,
}: UseVoiceOptions): UseVoiceReturn {
  const [state, setState] = useState<VoiceState>('idle')
  const stateRef = useRef<VoiceState>('idle')
  const connectionRef = useRef<VoiceStreamConnection | null>(null)
  const accumulatedRef = useRef('')
  const onTranscriptRef = useRef(onTranscript)
  const onErrorRef = useRef(onError)
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 录音期间看到第二次按键（自动重复）后为 true。OS 按键重复有约 500ms 延迟，
  // 首次按键是孤立事件；在自动重复开始前启动 release timer 会误判松开。
  const seenRepeatRef = useRef(false)
  const repeatFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 当前录音由终端焦点而非按键启动时为 true。焦点驱动会话在 blur 时结束，
  // 不根据按键松开结束。
  const focusTriggeredRef = useRef(false)
  // focus 模式长时间静默后关闭会话的定时器。
  const focusSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // focus 模式会话因静默关闭时设置，防止焦点 effect 立即重启；blur 时清除，
  // 使下一焦点周期能重新启用录音。
  const silenceTimedOutRef = useRef(false)
  const recordingStartRef = useRef(0)
  // 每次 startRecordingSession() 时递增。callback 捕获自己的 generation，
  // 若已有更新会话则退出，防止废弃会话中慢连接的僵尸 WS 在新会话途中覆盖 connectionRef。
  const sessionGenRef = useRef(0)
  // 本会话触发 early-error retry 时为 true，供 zy_voice_recording_completed analytics 事件使用。
  const retryUsedRef = useRef(false)
  // 保留本会话完整 audio，供 silent-drop replay。约 1% 会话会粘到故障 CE pod：
  // 接受 audio 却不返回 transcript。finalize() 以 no_data_timeout 完成且
  // hadAudioSignal=true 时，在新 WS 上重放一次 buffer。上限约 32KB/s × 60s ≈ 2MB。
  const fullAudioRef = useRef<Buffer[]>([])
  const silentDropRetriedRef = useRef(false)
  // 调度 early-error retry 时递增，每次 attemptConnect 捕获。onError 会吞掉旧 generation
  // 事件（连接 1 的尾随 close-error），但显示当前 generation 的真实失败。
  // 结构与 sessionGenRef 相同，只是低一层。
  const attemptGenRef = useRef(0)
  // focus 模式已刷新字符的累计数；每条 final transcript 会立即注入并重置 accumulatedRef。
  // completed 事件会将其加入 transcriptChars，避免成功转录的 focus 会话因
  // transcriptChars=0 被误判为 silent-drop。
  const focusFlushedCharsRef = useRef(0)
  // 至少收到一个有明显信号的 audio chunk 时为 true，用于区分
  //“麦克风静音/不可访问”和“未检测到语音”。
  const hasAudioSignalRef = useRef(false)
  // 当前会话 onReady 触发后为 true。与 cleanup() 会清空的 connectionRef 不同，
  // 它能跨过 effect 顺序竞态，例如 focus 模式录音中关闭 /voice 时 Effect 3 cleanup
  // 先于 Effect 2 finishRecording()。供 wsConnected analytics 维度和错误分支使用，
  // 在 startRecordingSession 中重置。
  const everConnectedRef = useRef(false)
  const audioLevelsRef = useRef<number[]>([])
  const isFocused = useTerminalFocus()
  const setVoiceState = useSetVoiceState()

  // 保持 callback ref 最新且不触发重渲染
  onTranscriptRef.current = onTranscript
  onErrorRef.current = onError

  function updateState(newState: VoiceState): void {
    stateRef.current = newState
    setState(newState)
    setVoiceState((prev) => {
      if (prev.voiceState === newState) {
        return prev
      }
      return { ...prev, voiceState: newState }
    })
  }

  const cleanup = useCallback((): void => {
    // 将所有进行中会话标为过期，包括主连接、replay 和 finishRecording continuation。
    // 否则 replay 窗口中禁用语音后，旧 replay 仍可能打开 WS、累积 transcript，
    // 并在语音关闭后注入。
    sessionGenRef.current++
    if (cleanupTimerRef.current) {
      clearTimeout(cleanupTimerRef.current)
      cleanupTimerRef.current = null
    }
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
    if (repeatFallbackTimerRef.current) {
      clearTimeout(repeatFallbackTimerRef.current)
      repeatFallbackTimerRef.current = null
    }
    if (focusSilenceTimerRef.current) {
      clearTimeout(focusSilenceTimerRef.current)
      focusSilenceTimerRef.current = null
    }
    silenceTimedOutRef.current = false
    voiceModule?.stopRecording()
    if (connectionRef.current) {
      connectionRef.current.close()
      connectionRef.current = null
    }
    accumulatedRef.current = ''
    audioLevelsRef.current = []
    fullAudioRef.current = []
    setVoiceState((prev) => {
      if (prev.voiceInterimTranscript === '' && !prev.voiceAudioLevels.length) {
        return prev
      }
      return { ...prev, voiceInterimTranscript: '', voiceAudioLevels: [] }
    })
  }, [setVoiceState])

  function finishRecording(): void {
    logForDebugging('[voice] finishRecording: stopping recording, transitioning to processing')
    // 会话结束时将所有进行中 attempt 标为过期，避免用户松键后连接 2 的迟到 onError
    // 与下方“检查网络”消息重复触发。
    attemptGenRef.current++
    // 清除前捕获 focusTriggered，作为事件维度供 BigQuery 过滤被动 focus 自动录音；
    // 用户聚焦但未说话时，环境噪声可能令 hadAudioSignal=true，形成假 silent-drop 特征。
    // focusFlushedCharsRef 修正有语音会话的字符数，focusTriggered 用于过滤无语音会话。
    const focusTriggered = focusTriggeredRef.current
    focusTriggeredRef.current = false
    updateState('processing')
    voiceModule?.stopRecording()
    // 在 finalize 往返前捕获时长，避免计入 WebSocket 等待时间，使轻触看起来超过 2 秒。
    // 所有 ref 值也在异步边界前捕获；等待期间按键可能启动新会话并重置这些 ref，
    // 再次造成原本要避免的 silent-drop 误报。
    const recordingDurationMs = Date.now() - recordingStartRef.current
    const hadAudioSignal = hasAudioSignalRef.current
    const retried = retryUsedRef.current
    const focusFlushedChars = focusFlushedCharsRef.current
    // wsConnected 区分“backend 收到 audio 但丢弃”和“WS handshake 从未完成”。
    // 后者的 audio 仍在 audioBuffer，未到达服务端，但环境噪声可能已令 hasAudioSignalRef=true。
    const wsConnected = everConnectedRef.current
    // 在 .then() 前捕获 generation。finalize 等待期间若启动新会话，continuation 运行时
    // sessionGenRef 已前进；若在 .then() 内捕获会拿到新会话 generation，使过期检查失效。
    const myGen = sessionGenRef.current
    const isStale = () => sessionGenRef.current !== myGen
    logForDebugging('[voice] Recording stopped')

    // 发送 finalize，并等待 WebSocket 关闭后再读取累计 transcript。
    // close handler 会把未报告的 interim text 提升为 final，因此必须等待其触发。
    const finalizePromise: Promise<FinalizeSource | undefined> = connectionRef.current
      ? connectionRef.current.finalize()
      : Promise.resolve(undefined)

    void finalizePromise
      .then(async (finalizeSource) => {
        if (isStale()) {
          return
        }
        // silent-drop replay：服务端已接受 audio、麦克风捕获到真实信号，但 finalize
        // 超时且 transcript 为空时，在新连接上重放一次 buffer。250ms backoff 可避开
        // 快速重连仍命中同一故障 pod 的竞态，与下方 early-error retry 间隔相同。
        if (
          finalizeSource === 'no_data_timeout' &&
          hadAudioSignal &&
          wsConnected &&
          !focusTriggered &&
          focusFlushedChars === 0 &&
          accumulatedRef.current.trim() === '' &&
          !silentDropRetriedRef.current &&
          fullAudioRef.current.length > 0
        ) {
          silentDropRetriedRef.current = true
          logForDebugging(
            `[voice] Silent-drop detected (no_data_timeout, ${String(fullAudioRef.current.length)} chunks); replaying on fresh connection`,
          )
          logEvent('zy_voice_silent_drop_replay', {
            recordingDurationMs,
            chunkCount: fullAudioRef.current.length,
          })
          if (connectionRef.current) {
            connectionRef.current.close()
            connectionRef.current = null
          }
          const replayBuffer = fullAudioRef.current
          await sleep(250)
          if (isStale()) {
            return
          }
          const stt = normalizeLanguageForSTT(getInitialSettings().language)
          const keyterms = await getVoiceKeyterms()
          if (isStale()) {
            return
          }
          await new Promise<void>((resolve) => {
            void connectVoiceStream(
              {
                onTranscript: (t, isFinal) => {
                  if (isStale()) {
                    return
                  }
                  if (isFinal && t.trim()) {
                    if (accumulatedRef.current) {
                      accumulatedRef.current += ' '
                    }
                    accumulatedRef.current += t.trim()
                  }
                },
                onError: () => resolve(),
                onClose: () => {},
                onReady: (conn) => {
                  if (isStale()) {
                    conn.close()
                    resolve()
                    return
                  }
                  connectionRef.current = conn
                  const SLICE = 32_000
                  let slice: Buffer[] = []
                  let bytes = 0
                  for (const c of replayBuffer) {
                    if (bytes > 0 && bytes + c.length > SLICE) {
                      conn.send(Buffer.concat(slice))
                      slice = []
                      bytes = 0
                    }
                    slice.push(c)
                    bytes += c.length
                  }
                  if (slice.length) {
                    conn.send(Buffer.concat(slice))
                  }
                  void conn.finalize().then(() => {
                    conn.close()
                    resolve()
                  })
                },
              },
              { language: stt.code, keyterms },
            ).then(
              (c) => {
                if (!c) {
                  resolve()
                }
              },
              () => resolve(),
            )
          })
          if (isStale()) {
            return
          }
        }
        fullAudioRef.current = []

        const text = accumulatedRef.current.trim()
        logForDebugging(
          `[voice] Final transcript assembled (${String(text.length)} chars): "${text.slice(0, 200)}"`,
        )

        // 跟踪 silent-drop 比率：transcriptChars=0、hadAudioSignal=true 且录音超过 2 秒，
        // 即 backend PR #287008 修复的问题。focusFlushedCharsRef 使 focus 模式字符数准确。
        //
        // NOTE：仅在 finishRecording() 路径触发。onError fallback 和 !conn（无 OAuth）
        // 会绕过，因此不能用 COUNT(completed)/COUNT(started) 计算成功率；
        // silent-drop 只以 completed 事件为分母，内部保持一致。
        logEvent('zy_voice_recording_completed', {
          transcriptChars: text.length + focusFlushedChars,
          recordingDurationMs,
          hadAudioSignal,
          retried,
          silentDropRetried: silentDropRetriedRef.current,
          wsConnected,
          focusTriggered,
        })

        if (connectionRef.current) {
          connectionRef.current.close()
          connectionRef.current = null
        }

        if (text) {
          logForDebugging(`[voice] Injecting transcript (${String(text.length)} chars)`)
          onTranscriptRef.current(text)
        } else if (focusFlushedChars === 0 && recordingDurationMs > 2000) {
          // 仅当 focus 模式也未刷新内容且录音超过 2 秒时警告空 transcript；
          // 短录音视为误触，静默返回 idle。
          if (!wsConnected) {
            // WS 从未连接表示 audio 未到达 backend，不是 silent drop，而是 OAuth 刷新慢、
            // 网络等连接失败。
            onErrorRef.current?.('Voice connection failed. Check your network and try again.')
          } else if (!hadAudioSignal) {
            // 区分静音麦克风（采集问题）和语音未识别。
            onErrorRef.current?.(
              'No audio detected from microphone. Check that the correct input device is selected and that ZY Code has microphone access.',
            )
          } else {
            onErrorRef.current?.('No speech detected.')
          }
        }

        accumulatedRef.current = ''
        setVoiceState((prev) => {
          if (prev.voiceInterimTranscript === '') {
            return prev
          }
          return { ...prev, voiceInterimTranscript: '' }
        })
        updateState('idle')
      })
      .catch((err) => {
        logError(toError(err))
        if (!isStale()) {
          updateState('idle')
        }
      })
  }

  // 启用语音后延迟导入 voice.ts，使用户按下语音键时 checkRecordingAvailability 等已就绪。
  // 不预加载原生模块：require('audio-capture.node') 会同步 dlopen CoreAudio/AudioUnit，
  // 阻塞 event loop 约 1-8 秒；setImmediate 只让出一 tick，随后仍会阻塞。
  // 改由首次语音按键承担 dlopen 成本。
  useEffect(() => {
    if (enabled && !voiceModule) {
      void import('../services/voice.js').then((mod) => {
        voiceModule = mod
      })
    }
  }, [enabled])

  // ── Focus silence timer ────────────────────────────────────────────
  // 启动或重置定时器，在无语音达到 FOCUS_SILENCE_TIMEOUT_MS 后关闭 focus 模式会话。
  // 会话开始及每次刷新 transcript 后调用。
  function armFocusSilenceTimer(): void {
    if (focusSilenceTimerRef.current) {
      clearTimeout(focusSilenceTimerRef.current)
    }
    focusSilenceTimerRef.current = setTimeout(
      (focusSilenceTimerRef, stateRef, focusTriggeredRef, silenceTimedOutRef, finishRecording) => {
        focusSilenceTimerRef.current = null
        if (stateRef.current === 'recording' && focusTriggeredRef.current) {
          logForDebugging('[voice] Focus silence timeout — tearing down session')
          silenceTimedOutRef.current = true
          finishRecording()
        }
      },
      FOCUS_SILENCE_TIMEOUT_MS,
      focusSilenceTimerRef,
      stateRef,
      focusTriggeredRef,
      silenceTimedOutRef,
      finishRecording,
    )
  }

  // ── Focus-driven recording ──────────────────────────────────────────
  // focus 模式下终端获得焦点时开始录音，失焦时停止，使语音输入可跟随窗口焦点。
  useEffect(() => {
    if (!enabled || !focusMode) {
      // 焦点驱动录音期间禁用 focus 模式时立即停止，避免持续到静默定时器触发。
      if (focusTriggeredRef.current && stateRef.current === 'recording') {
        logForDebugging('[voice] Focus mode disabled during recording, finishing')
        finishRecording()
      }
      return
    }
    let cancelled = false
    if (isFocused && stateRef.current === 'idle' && !silenceTimedOutRef.current) {
      const beginFocusRecording = (): void => {
        // await 期间 state 或 enabled/focusMode 可能变化，effect cleanup 也会设置 cancelled，
        // 因此重新检查条件。
        if (cancelled || stateRef.current !== 'idle' || silenceTimedOutRef.current) {
          return
        }
        logForDebugging('[voice] Focus gained, starting recording session')
        focusTriggeredRef.current = true
        void startRecordingSession()
        armFocusSilenceTimer()
      }
      if (voiceModule) {
        beginFocusRecording()
      } else {
        // voice 模块仍在加载；异步 import 从 cache 以 microtask 完成，等待后再启动录音会话。
        void import('../services/voice.js').then((mod) => {
          voiceModule = mod
          beginFocusRecording()
        })
      }
    } else if (!isFocused) {
      // blur 时清除静默超时 flag，使下一焦点周期重新启用录音。
      silenceTimedOutRef.current = false
      if (stateRef.current === 'recording') {
        logForDebugging('[voice] Focus lost, finishing recording')
        finishRecording()
      }
    }
    return () => {
      cancelled = true
    }
  }, [enabled, focusMode, isFocused, armFocusSilenceTimer, finishRecording, startRecordingSession])

  // ── Start a new recording session (voice_stream connect + audio) ──
  async function startRecordingSession(): Promise<void> {
    if (!voiceModule) {
      onErrorRef.current?.('Voice module not loaded yet. Try again in a moment.')
      return
    }

    // 在任何 await 前同步切换到 'recording'。调用方会在
    // `void startRecordingSession()` 后立即同步读取状态；若先 await，它们会看到旧 'idle'，
    // space-hold guard 会清除 isSpaceHoldActiveRef，导致空格自动重复泄漏到文本输入。
    // 另见下方 handleKeyEvent 的重入检查和 PR #20873 review。
    updateState('recording')
    recordingStartRef.current = Date.now()
    accumulatedRef.current = ''
    seenRepeatRef.current = false
    hasAudioSignalRef.current = false
    retryUsedRef.current = false
    silentDropRetriedRef.current = false
    fullAudioRef.current = []
    focusFlushedCharsRef.current = 0
    everConnectedRef.current = false
    const myGen = ++sessionGenRef.current

    // ── Pre-check: can we actually record audio? ──────────────
    const availability = await voiceModule.checkRecordingAvailability()
    if (!availability.available) {
      logForDebugging(`[voice] Recording not available: ${availability.reason ?? 'unknown'}`)
      onErrorRef.current?.(availability.reason ?? 'Audio recording is not available.')
      cleanup()
      updateState('idle')
      return
    }

    logForDebugging('[voice] Starting recording session, connecting voice stream')
    // 清除先前错误
    setVoiceState((prev) => {
      if (!prev.voiceError) {
        return prev
      }
      return { ...prev, voiceError: null }
    })

    // WebSocket 连接期间缓存 audio chunk；连接就绪并触发 onReady 后刷新缓存，
    // 后续 chunk 直接发送。
    const audioBuffer: Buffer[] = []

    // 立即开始录音，WebSocket 打开前先缓存 audio，消除等待 OAuth + WS 连接的 1-2 秒延迟。
    logForDebugging('[voice] startRecording: buffering audio while WebSocket connects')
    audioLevelsRef.current = []
    const started = await voiceModule.startRecording(
      (chunk: Buffer) => {
        // 复制到 fullAudioRef replay buffer；voiceStreamSTT 的 send() 会再次防御性复制，
        // audio 速率下开销可接受。focus 模式不缓存，因为 replay 受 !focusTriggered 门控，
        // 该 buffer 只会成为无用内存，10 分钟可达约 20MB。
        const owned = Buffer.from(chunk)
        if (!focusTriggeredRef.current) {
          fullAudioRef.current.push(owned)
        }
        if (connectionRef.current) {
          connectionRef.current.send(owned)
        } else {
          audioBuffer.push(owned)
        }
        // 更新录音可视化的 audio level histogram
        const level = computeLevel(chunk)
        if (!hasAudioSignalRef.current && level > 0.01) {
          hasAudioSignalRef.current = true
        }
        const levels = audioLevelsRef.current
        if (levels.length >= AUDIO_LEVEL_BARS) {
          levels.shift()
        }
        levels.push(level)
        // 复制数组，使 React 看到新引用
        const snapshot = [...levels]
        audioLevelsRef.current = snapshot
        setVoiceState((prev) => ({ ...prev, voiceAudioLevels: snapshot }))
      },
      () => {
        // 外部结束（如设备错误）按停止处理
        if (stateRef.current === 'recording') {
          finishRecording()
        }
      },
      { silenceDetection: false },
    )

    if (!started) {
      logError(new Error('[voice] Recording failed — no audio tool found'))
      onErrorRef.current?.(
        'Failed to start audio capture. Check that your microphone is accessible.',
      )
      cleanup()
      updateState('idle')
      setVoiceState((prev) => ({
        ...prev,
        voiceError: 'Recording failed — no audio tool found',
      }))
      return
    }

    const rawLanguage = getInitialSettings().language
    const stt = normalizeLanguageForSTT(rawLanguage)
    logEvent('zy_voice_recording_started', {
      focusTriggered: focusTriggeredRef.current,
      sttLanguage: stt.code as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      sttLanguageIsDefault: !rawLanguage?.trim(),
      sttLanguageFellBack: stt.fellBackFrom !== undefined,
      // 来自 Intl 的 ISO 639 subtag，属于有限集合且绝非用户文本。Intl 失败时为 undefined，
      // 从 payload 省略；结果已缓存，不产生重试成本。
      systemLocaleLanguage:
        getSystemLocaleLanguage() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    // 在传出任何 transcript 前连接出错时重试一次。conversation-engine proxy 可能拒绝
    // 快速重连，CE 的 Deepgram upstream 也可能在 teardown 窗口失败。
    // 250ms backoff 可避开两者；重试窗口中的 audio 路由到 audioBuffer，
    // 并在第二次 onReady 时刷新。
    let sawTranscript = false

    // 与录音并行连接 WebSocket。先异步收集 keyterm（很快且不调用模型），再连接。
    // 若已有更新会话则 callback 退出，防止慢连接的僵尸 WS 向新会话触发 onReady/onError，
    // 破坏 connectionRef 或触发虚假 retry。
    const isStale = () => sessionGenRef.current !== myGen

    const attemptConnect = (keyterms: string[]): void => {
      const myAttemptGen = attemptGenRef.current
      void connectVoiceStream(
        {
          onTranscript: (text: string, isFinal: boolean) => {
            if (isStale()) {
              return
            }
            sawTranscript = true
            logForDebugging(`[voice] onTranscript: isFinal=${String(isFinal)} text="${text}"`)
            if (isFinal && text.trim()) {
              if (focusTriggeredRef.current) {
                // focus 模式立即刷新每条 final transcript 并继续录音，
                // 在终端聚焦期间实现连续转录。
                logForDebugging(
                  `[voice] Focus mode: flushing final transcript immediately: "${text.trim()}"`,
                )
                onTranscriptRef.current(text.trim())
                focusFlushedCharsRef.current += text.trim().length
                setVoiceState((prev) => {
                  if (prev.voiceInterimTranscript === '') {
                    return prev
                  }
                  return { ...prev, voiceInterimTranscript: '' }
                })
                accumulatedRef.current = ''
                // 用户正在说话，重置静默定时器。
                armFocusSilenceTimer()
              } else {
                // hold-to-talk：用空格分隔并累积 final transcript
                if (accumulatedRef.current) {
                  accumulatedRef.current += ' '
                }
                accumulatedRef.current += text.trim()
                logForDebugging(`[voice] Accumulated final transcript: "${accumulatedRef.current}"`)
                // final 已取代 interim，清除 interim
                setVoiceState((prev) => {
                  const preview = accumulatedRef.current
                  if (prev.voiceInterimTranscript === preview) {
                    return prev
                  }
                  return { ...prev, voiceInterimTranscript: preview }
                })
              }
            } else if (!isFinal) {
              // 活跃 interim speech 会重置 focus 静默定时器。Nova 3 禁用 auto-finalize，
              // 流中 isFinal 始终不为 true；若不重置，5 秒定时器会在说话期间关闭会话。
              if (focusTriggeredRef.current) {
                armFocusSilenceTimer()
              }
              // 将累计 final + 当前 interim 显示为实时预览
              const interim = text.trim()
              const preview = accumulatedRef.current
                ? accumulatedRef.current + (interim ? ` ${interim}` : '')
                : interim
              setVoiceState((prev) => {
                if (prev.voiceInterimTranscript === preview) {
                  return prev
                }
                return { ...prev, voiceInterimTranscript: preview }
              })
            }
          },
          onError: (error: string, opts?: { fatal?: boolean }) => {
            if (isStale()) {
              logForDebugging(`[voice] ignoring onError from stale session: ${error}`)
              return
            }
            // 吞掉已被取代 attempt 的错误，包括调度 retry 后连接 1 的尾随 close，
            // 以及当前连接 ws error 已显示后又到达的 close event。
            if (attemptGenRef.current !== myAttemptGen) {
              logForDebugging(`[voice] ignoring stale onError from superseded attempt: ${error}`)
              return
            }
            // early-failure retry：任何 transcript 前的服务端错误通常是暂时 upstream 竞态。
            // 清除 connectionRef，使 audio 重新缓存，再 backoff 并重连。用户已松键时跳过；
            // Cloudflare challenge、auth rejection 等致命错误每次 retry 都相同，直接显示。
            if (!opts?.fatal && !sawTranscript && stateRef.current === 'recording') {
              if (!retryUsedRef.current) {
                retryUsedRef.current = true
                logForDebugging(
                  `[voice] early voice_stream error (pre-transcript), retrying once: ${error}`,
                )
                logEvent('zy_voice_stream_early_retry', {})
                connectionRef.current = null
                attemptGenRef.current++
                setTimeout(
                  (stateRef, attemptConnect, keyterms) => {
                    if (stateRef.current === 'recording') {
                      attemptConnect(keyterms)
                    }
                  },
                  250,
                  stateRef,
                  attemptConnect,
                  keyterms,
                )
                return
              }
            }
            // 显示错误时递增 generation，使该连接的尾随 close-error 被上方吞掉。
            attemptGenRef.current++
            logError(new Error(`[voice] voice_stream error: ${error}`))
            onErrorRef.current?.(`Voice stream error: ${error}`)
            // 出错时清除 audio buffer，避免内存泄漏
            audioBuffer.length = 0
            focusTriggeredRef.current = false
            cleanup()
            updateState('idle')
          },
          onClose: () => {
            // 无需处理，生命周期由 cleanup() 管理
          },
          onReady: (conn) => {
            // 仅在仍处于 recording 且仍为当前会话时继续。若用户已启动新会话，
            // 废弃会话中迟到连接的僵尸 WS 也可能通过单纯的 'recording' 检查。
            if (isStale() || stateRef.current !== 'recording') {
              conn.close()
              return
            }

            // WebSocket 已真正打开，赋值 connectionRef，使后续 audio callback 直接发送而非缓存。
            connectionRef.current = conn
            everConnectedRef.current = true

            // 刷新 WebSocket 连接期间缓存的全部 audio chunk。onReady 来自 WebSocket
            // 'open' 事件，因此可保证 send() 不会被丢弃。
            //
            // 合并为约 1 秒的 slice，而非每个 chunk 调用一次 ws.send；
            // 更少 WS frame 可降低两端开销。
            const SLICE_TARGET_BYTES = 32_000 // ~1s at 16kHz/16-bit/mono
            if (audioBuffer.length > 0) {
              let totalBytes = 0
              for (const c of audioBuffer) {
                totalBytes += c.length
              }
              const slices: Buffer[][] = [[]]
              let sliceBytes = 0
              for (const chunk of audioBuffer) {
                if (sliceBytes > 0 && sliceBytes + chunk.length > SLICE_TARGET_BYTES) {
                  slices.push([])
                  sliceBytes = 0
                }
                slices[slices.length - 1]!.push(chunk)
                sliceBytes += chunk.length
              }
              logForDebugging(
                `[voice] onReady: flushing ${String(audioBuffer.length)} buffered chunks (${String(totalBytes)} bytes) as ${String(slices.length)} coalesced frame(s)`,
              )
              for (const slice of slices) {
                conn.send(Buffer.concat(slice))
              }
            }
            audioBuffer.length = 0

            // Reset the release timer now that the WebSocket is ready.
            // Only arm it if auto-repeat has been seen — otherwise the OS
            // key repeat delay (~500ms) hasn't elapsed yet and the timer
            // would fire prematurely.
            if (releaseTimerRef.current) {
              clearTimeout(releaseTimerRef.current)
            }
            if (seenRepeatRef.current) {
              releaseTimerRef.current = setTimeout(
                (releaseTimerRef, stateRef, finishRecording) => {
                  releaseTimerRef.current = null
                  if (stateRef.current === 'recording') {
                    finishRecording()
                  }
                },
                RELEASE_TIMEOUT_MS,
                releaseTimerRef,
                stateRef,
                finishRecording,
              )
            }
          },
        },
        {
          language: stt.code,
          keyterms,
        },
      ).then((conn) => {
        if (isStale()) {
          conn?.close()
          return
        }
        if (!conn) {
          logForDebugging('[voice] Failed to connect to voice_stream (no OAuth token?)')
          onErrorRef.current?.('Voice mode requires a Zy.ai account. Please run /login to sign in.')
          // Clear the audio buffer on failure
          audioBuffer.length = 0
          cleanup()
          updateState('idle')
          return
        }

        // Safety check: if the user released the key before connectVoiceStream
        // resolved (but after onReady already ran), close the connection.
        if (stateRef.current !== 'recording') {
          audioBuffer.length = 0
          conn.close()
          return
        }
      })
    }

    void getVoiceKeyterms().then(attemptConnect)
  }

  // ── Hold-to-talk handler ────────────────────────────────────────────
  // Called on every keypress (including terminal auto-repeats while
  // the key is held).  A gap longer than RELEASE_TIMEOUT_MS between
  // events is interpreted as key release.
  //
  // Recording starts immediately on the first keypress to eliminate
  // startup delay.  The release timer is only armed after auto-repeat
  // is detected (to avoid false releases during the OS key repeat
  // delay of ~500ms on macOS).
  const handleKeyEvent = useCallback(
    (fallbackMs = REPEAT_FALLBACK_MS): void => {
      if (!enabled || !isVoiceStreamAvailable()) {
        return
      }

      // In focus mode, recording is driven by terminal focus, not keypresses.
      if (focusTriggeredRef.current) {
        // Active focus recording — ignore key events (session ends on blur).
        return
      }
      if (focusMode && silenceTimedOutRef.current) {
        // Focus session timed out due to silence — keypress re-arms it.
        logForDebugging('[voice] Re-arming focus recording after silence timeout')
        silenceTimedOutRef.current = false
        focusTriggeredRef.current = true
        void startRecordingSession()
        armFocusSilenceTimer()
        return
      }

      const currentState = stateRef.current

      // Ignore keypresses while processing
      if (currentState === 'processing') {
        return
      }

      if (currentState === 'idle') {
        logForDebugging('[voice] handleKeyEvent: idle, starting recording session immediately')
        void startRecordingSession()
        // Fallback: if no auto-repeat arrives within REPEAT_FALLBACK_MS,
        // arm the release timer anyway (the user likely tapped and released).
        repeatFallbackTimerRef.current = setTimeout(
          (repeatFallbackTimerRef, stateRef, seenRepeatRef, releaseTimerRef, finishRecording) => {
            repeatFallbackTimerRef.current = null
            if (stateRef.current === 'recording' && !seenRepeatRef.current) {
              logForDebugging('[voice] No auto-repeat seen, arming release timer via fallback')
              seenRepeatRef.current = true
              releaseTimerRef.current = setTimeout(
                (releaseTimerRef, stateRef, finishRecording) => {
                  releaseTimerRef.current = null
                  if (stateRef.current === 'recording') {
                    finishRecording()
                  }
                },
                RELEASE_TIMEOUT_MS,
                releaseTimerRef,
                stateRef,
                finishRecording,
              )
            }
          },
          fallbackMs,
          repeatFallbackTimerRef,
          stateRef,
          seenRepeatRef,
          releaseTimerRef,
          finishRecording,
        )
      } else if (currentState === 'recording') {
        // Second+ keypress while recording — auto-repeat has started.
        seenRepeatRef.current = true
        if (repeatFallbackTimerRef.current) {
          clearTimeout(repeatFallbackTimerRef.current)
          repeatFallbackTimerRef.current = null
        }
      }

      // Reset the release timer on every keypress (including auto-repeats)
      if (releaseTimerRef.current) {
        clearTimeout(releaseTimerRef.current)
      }

      // Only arm the release timer once auto-repeat has been seen.
      // The OS key repeat delay is ~500ms on macOS; without this gate
      // the 200ms timer fires before repeat starts, causing a false release.
      if (stateRef.current === 'recording' && seenRepeatRef.current) {
        releaseTimerRef.current = setTimeout(
          (releaseTimerRef, stateRef, finishRecording) => {
            releaseTimerRef.current = null
            if (stateRef.current === 'recording') {
              finishRecording()
            }
          },
          RELEASE_TIMEOUT_MS,
          releaseTimerRef,
          stateRef,
          finishRecording,
        )
      }
    },
    [enabled, focusMode, startRecordingSession, finishRecording, armFocusSilenceTimer],
  )

  // Cleanup only when disabled or unmounted - NOT on state changes
  useEffect(() => {
    if (!enabled && stateRef.current !== 'idle') {
      cleanup()
      updateState('idle')
    }
    return () => {
      cleanup()
    }
  }, [enabled, cleanup, updateState])

  return {
    state,
    handleKeyEvent,
  }
}
