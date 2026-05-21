/**
 * 输入分词器 - 转义序列边界检测
 *
 * 将终端输入分割为 token：文本块和原始转义序列。
 * 与 Parser 对序列进行语义解释不同，这里仅识别边界，
 * 供键盘输入解析使用。
 */

import { C0, ESC_TYPE, isEscFinal } from './ansi.js'
import { isCSIFinal, isCSIIntermediate, isCSIParam } from './csi.js'

export type Token = { type: 'text'; value: string } | { type: 'sequence'; value: string }

type State = 'ground' | 'escape' | 'escapeIntermediate' | 'csi' | 'ss3' | 'osc' | 'dcs' | 'apc'

export type Tokenizer = {
  /** 输入并获取生成的 token */
  feed(input: string): Token[]
  /** 刷新任何缓冲的不完整序列 */
  flush(): Token[]
  /** 重置分词器状态 */
  reset(): void
  /** 获取任何缓冲的不完整序列 */
  buffer(): string
}

type TokenizerOptions = {
  /**
   * 将 `CSI M` 视为 X10 鼠标事件前缀并消费 3 个载荷字节。
   * 仅在 stdin 输入时启用 — 在输出流中 `\x1b[M` 也是 CSI DL（删除行），
   * 在那里启用会吞掉显示文本。默认为 false。
   */
  x10Mouse?: boolean
}

/**
 * 为终端输入创建流式分词器。
 *
 * 用法：
 * ```typescript
 * const tokenizer = createTokenizer()
 * const tokens1 = tokenizer.feed('hello\x1b[')
 * const tokens2 = tokenizer.feed('A')  // 完成转义序列
 * const remaining = tokenizer.flush()  // 强制输出不完整序列
 * ```
 */
export function createTokenizer(options?: TokenizerOptions): Tokenizer {
  let currentState: State = 'ground'
  let currentBuffer = ''
  const x10Mouse = options?.x10Mouse ?? false

  return {
    feed(input: string): Token[] {
      const result = tokenize(input, currentState, currentBuffer, false, x10Mouse)
      currentState = result.state.state
      currentBuffer = result.state.buffer
      return result.tokens
    },

    flush(): Token[] {
      const result = tokenize('', currentState, currentBuffer, true, x10Mouse)
      currentState = result.state.state
      currentBuffer = result.state.buffer
      return result.tokens
    },

    reset(): void {
      currentState = 'ground'
      currentBuffer = ''
    },

    buffer(): string {
      return currentBuffer
    },
  }
}

type InternalState = {
  state: State
  buffer: string
}

function tokenize(
  input: string,
  initialState: State,
  initialBuffer: string,
  flush: boolean,
  x10Mouse: boolean,
): { tokens: Token[]; state: InternalState } {
  const tokens: Token[] = []
  const result: InternalState = {
    state: initialState,
    buffer: '',
  }

  const data = initialBuffer + input
  let i = 0
  let textStart = 0
  let seqStart = 0

  const flushText = (): void => {
    if (i > textStart) {
      const text = data.slice(textStart, i)
      if (text) {
        tokens.push({ type: 'text', value: text })
      }
    }
    textStart = i
  }

  const emitSequence = (seq: string): void => {
    if (seq) {
      tokens.push({ type: 'sequence', value: seq })
    }
    result.state = 'ground'
    textStart = i
  }

  while (i < data.length) {
    const code = data.charCodeAt(i)

    switch (result.state) {
      case 'ground':
        if (code === C0.ESC) {
          flushText()
          seqStart = i
          result.state = 'escape'
          i++
        } else {
          i++
        }
        break

      case 'escape':
        if (code === ESC_TYPE.CSI) {
          result.state = 'csi'
          i++
        } else if (code === ESC_TYPE.OSC) {
          result.state = 'osc'
          i++
        } else if (code === ESC_TYPE.DCS) {
          result.state = 'dcs'
          i++
        } else if (code === ESC_TYPE.APC) {
          result.state = 'apc'
          i++
        } else if (code === 0x4f) {
          // 'O' - SS3
          result.state = 'ss3'
          i++
        } else if (isCSIIntermediate(code)) {
          // 中间字节（例如 ESC ( 用于字符集）- 继续缓冲
          result.state = 'escapeIntermediate'
          i++
        } else if (isEscFinal(code)) {
          // 两字符转义序列
          i++
          emitSequence(data.slice(seqStart, i))
        } else if (code === C0.ESC) {
          // 双重转义 - 输出第一个，开始新的
          emitSequence(data.slice(seqStart, i))
          seqStart = i
          result.state = 'escape'
          i++
        } else {
          // 无效 - 将 ESC 视为文本
          result.state = 'ground'
          textStart = seqStart
        }
        break

      case 'escapeIntermediate':
        // 在中间字节之后，等待结束字节
        if (isCSIIntermediate(code)) {
          // 更多中间字节
          i++
        } else if (isEscFinal(code)) {
          // 结束字节 - 完成序列
          i++
          emitSequence(data.slice(seqStart, i))
        } else {
          // 无效 - 视为文本
          result.state = 'ground'
          textStart = seqStart
        }
        break

      case 'csi':
        // X10 鼠标：CSI M + 3 个原始载荷字节（Cb+32, Cx+32, Cy+32）。
        // [ 之后的 M（偏移量 2）表示无参数 — SGR 鼠标（CSI < ... M）首先有 `<` 参数字节，
        // 在偏移量 > 2 处才到达 M。
        // 忽略 DECSET 1006 但遵循 1000/1002 的终端会发出这种
        // 遗留编码；没有这个分支，3 个载荷字节会作为文本泄漏
        // （提示中出现 `` `rK `` / `arK` 乱码）。
        //
        // 受 x10Mouse 门控 — `\x1b[M` 也是 CSI DL（删除行），
        // 盲目消费 3 个字符会破坏输出渲染（Parser/Ansi）
        // 并分割括号粘贴 PASTE_END。仅 stdin 启用此功能。
        // 对每个载荷槽的 >=0x20 检查是双保险：X10
        // 保证 Cb>=32, Cx>=33, Cy>=33，因此任何槽中的控制字节（ESC=0x1B）
        // 意味着这是 CSI DL 与另一个序列相邻，而不是
        // 鼠标事件。检查所有三个槽可防止粘贴内容以 `\x1b[M`+0-2 个字符结尾时
        // 消费 PASTE_END 的 ESC。
        //
        // 已知限制：这里计数 JS 字符串字符，但 X10 是面向字节的，
        // stdin 使用 utf8 编码（App.tsx）。在 col 162-191 ×
        // row 96-159 处，两个坐标字节（0xC2-0xDF, 0x80-0xBF）形成一个有效的
        // UTF-8 2 字节序列并折叠为一个字符 — 长度检查
        // 失败，事件缓冲直到下次按键吸收它。
        // 修复此问题需要 latin1 stdin；X10 的 223 坐标上限正是
        // 发明 SGR 的原因，162+ 列的无 SGR 终端很少见。
        if (
          x10Mouse &&
          code === 0x4d /* M */ &&
          i - seqStart === 2 &&
          (i + 1 >= data.length || data.charCodeAt(i + 1) >= 0x20) &&
          (i + 2 >= data.length || data.charCodeAt(i + 2) >= 0x20) &&
          (i + 3 >= data.length || data.charCodeAt(i + 3) >= 0x20)
        ) {
          if (i + 4 <= data.length) {
            i += 4
            emitSequence(data.slice(seqStart, i))
          } else {
            // 不完整 — 退出循环；来自 seqStart 的输入结束缓冲区。
            // 重新进入时通过无效 CSI 回退从 ground 重新分词。
            i = data.length
          }
          break
        }
        if (isCSIFinal(code)) {
          i++
          emitSequence(data.slice(seqStart, i))
        } else if (isCSIParam(code) || isCSIIntermediate(code)) {
          i++
        } else {
          // 无效 CSI - 中止，视为文本
          result.state = 'ground'
          textStart = seqStart
        }
        break

      case 'ss3':
        // SS3 序列：ESC O 后跟单个结束字节
        if (code >= 0x40 && code <= 0x7e) {
          i++
          emitSequence(data.slice(seqStart, i))
        } else {
          // 无效 - 视为文本
          result.state = 'ground'
          textStart = seqStart
        }
        break

      case 'osc':
        if (code === C0.BEL) {
          i++
          emitSequence(data.slice(seqStart, i))
        } else if (
          code === C0.ESC &&
          i + 1 < data.length &&
          data.charCodeAt(i + 1) === ESC_TYPE.ST
        ) {
          i += 2
          emitSequence(data.slice(seqStart, i))
        } else {
          i++
        }
        break

      case 'dcs':
      case 'apc':
        if (code === C0.BEL) {
          i++
          emitSequence(data.slice(seqStart, i))
        } else if (
          code === C0.ESC &&
          i + 1 < data.length &&
          data.charCodeAt(i + 1) === ESC_TYPE.ST
        ) {
          i += 2
          emitSequence(data.slice(seqStart, i))
        } else {
          i++
        }
        break
    }
  }

  // 处理输入结束
  if (result.state === 'ground') {
    flushText()
  } else if (flush) {
    // 强制输出不完整序列
    const remaining = data.slice(seqStart)
    if (remaining) {
      tokens.push({ type: 'sequence', value: remaining })
    }
    result.state = 'ground'
  } else {
    // 缓冲不完整序列供下次调用
    result.buffer = data.slice(seqStart)
  }

  return { tokens, state: result }
}
