/**
 * 无需超时地查询终端并等待响应。
 *
 * 终端查询（DECRQM、DA1、OSC 11 等）与键盘输入共享 stdin 流。
 * 响应序列在语法上与按键事件可区分，因此输入解析器能识别它们
 * 并将其分发到此处。
 *
 * 为避免超时，每批查询都以 DA1 哨兵（CSI c）终止——自 VT100
 * 以来每个终端都会响应 DA1，且终端按顺序回答查询。因此：如果
 * 你的查询响应在 DA1 之前到达，说明终端支持它；如果 DA1 先到，
 * 说明不支持。
 *
 * 用法：
 *   const [sync, grapheme] = await Promise.all([
 *     querier.send(decrqm(2026)),
 *     querier.send(decrqm(2027)),
 *     querier.flush(),
 *   ])
 *   // sync 和 grapheme 是 DECRPM 响应，不支持则为 undefined
 */

import type { TerminalResponse } from './parseKeypress.js'
import { csi } from './termio/csi.js'
import { osc } from './termio/osc.js'

/** 终端查询：一个出站请求序列，配对一个识别预期入站响应的匹配器。
 *  由 `decrqm()`、`oscColor()`、`kittyKeyboard()` 等构建。*/
export type TerminalQuery<T extends TerminalResponse = TerminalResponse> = {
  /** 写入 stdout 的转义序列 */
  request: string
  /** 在入站流中识别预期响应 */
  match: (r: TerminalResponse) => r is T
}

type DecrpmResponse = Extract<TerminalResponse, { type: 'decrpm' }>
type Da1Response = Extract<TerminalResponse, { type: 'da1' }>
type Da2Response = Extract<TerminalResponse, { type: 'da2' }>
type KittyResponse = Extract<TerminalResponse, { type: 'kittyKeyboard' }>
type CursorPosResponse = Extract<TerminalResponse, { type: 'cursorPosition' }>
type OscResponse = Extract<TerminalResponse, { type: 'osc' }>
type XtversionResponse = Extract<TerminalResponse, { type: 'xtversion' }>

// -- 查询构建器 --

/** DECRQM：请求 DEC 私有模式状态（CSI ? mode $ p）。
 *  终端回复 DECRPM（CSI ? mode ; status $ y）或忽略。*/
export function decrqm(mode: number): TerminalQuery<DecrpmResponse> {
  return {
    request: csi(`?${mode}$p`),
    match: (r): r is DecrpmResponse => r.type === 'decrpm' && r.mode === mode,
  }
}

/** 主设备属性查询（CSI c）。每个终端都会应答——
 *  flush() 内部用作通用哨兵。直接调用可获取 DA1 参数。*/
export function da1(): TerminalQuery<Da1Response> {
  return {
    request: csi('c'),
    match: (r): r is Da1Response => r.type === 'da1',
  }
}

/** 次设备属性查询（CSI > c）。返回终端版本。*/
export function da2(): TerminalQuery<Da2Response> {
  return {
    request: csi('>c'),
    match: (r): r is Da2Response => r.type === 'da2',
  }
}

/** 查询当前 Kitty 键盘协议标志（CSI ? u）。
 *  终端回复 CSI ? flags u 或忽略。*/
export function kittyKeyboard(): TerminalQuery<KittyResponse> {
  return {
    request: csi('?u'),
    match: (r): r is KittyResponse => r.type === 'kittyKeyboard',
  }
}

/** DECXCPR：请求光标位置，带 DEC 私有标记（CSI ? 6 n）。
 *  终端回复 CSI ? row ; col R。`?` 标记至关重要——
 *  普通 DSR 形式（CSI 6 n → CSI row;col R）与修改后的 F3 键
 *  （Shift+F3 = CSI 1;2 R 等）会产生歧义。*/
export function cursorPosition(): TerminalQuery<CursorPosResponse> {
  return {
    request: csi('?6n'),
    match: (r): r is CursorPosResponse => r.type === 'cursorPosition',
  }
}

/** OSC 动态颜色查询（如 OSC 11 查背景色，OSC 10 查前景色）。
 *  `?` 数据槽位请求终端回复当前值。*/
export function oscColor(code: number): TerminalQuery<OscResponse> {
  return {
    request: osc(code, '?'),
    match: (r): r is OscResponse => r.type === 'osc' && r.code === code,
  }
}

/** XTVERSION：请求终端名称/版本（CSI > 0 q）。
 *  终端回复 DCS > | name ST（如 "xterm.js(5.5.0)"）或忽略。
 *  该查询能穿越 SSH——查询通过 pty 而非环境变量发出，
 *  因此即使 TERM_PROGRAM 未转发，也能识别*客户端*终端。
 *  用于检测 xterm.js 以进行滚轮滚动补偿。*/
export function xtversion(): TerminalQuery<XtversionResponse> {
  return {
    request: csi('>0q'),
    match: (r): r is XtversionResponse => r.type === 'xtversion',
  }
}

// -- 查询器 --

/** 哨兵请求序列（DA1）。保持内部使用，由 flush() 写入。*/
const SENTINEL = csi('c')

type Pending =
  | {
      kind: 'query'
      match: (r: TerminalResponse) => boolean
      resolve: (r: TerminalResponse | undefined) => void
    }
  | { kind: 'sentinel'; resolve: () => void }

export class TerminalQuerier {
  /**
   * 查询和哨兵的交错队列，按发送顺序排列。终端按顺序响应，
   * 因此每次 flush() 屏障只排空排在其前面的查询——来自不同调用者
   * 的并发批次保持隔离。
   */
  private queue: Pending[] = []

  constructor(private stdout: NodeJS.WriteStream) {}

  /**
   * 发送查询并等待响应。
   *
   * 当 `query.match` 匹配到传入的 TerminalResponse 时 resolve 为响应，
   * 或在 flush() 哨兵先于任何匹配响应到达时 resolve 为 `undefined`
   * （意味着终端忽略了该查询）。
   *
   * 永不 reject；永不自行超时。如果从不调用 flush() 且终端不响应，
   * promise 将保持 pending 状态。
   */
  send<T extends TerminalResponse>(query: TerminalQuery<T>): Promise<T | undefined> {
    return new Promise((resolve) => {
      this.queue.push({
        kind: 'query',
        match: query.match,
        resolve: (r) => resolve(r as T | undefined),
      })
      this.stdout.write(query.request)
    })
  }

  /**
   * 发送 DA1 哨兵。DA1 响应到达时 resolve。
   *
   * 副作用：DA1 到达时仍 pending 的所有查询都以 `undefined` resolve
   * （终端未响应 → 不支持该查询）。这使得 send() 无需超时。
   *
   * 在没有待处理查询时调用也是安全的——仍然等待一次往返。
   */
  flush(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ kind: 'sentinel', resolve })
      this.stdout.write(SENTINEL)
    })
  }

  /**
   * 分发从 stdin 解析的响应。由 App.tsx 的 processKeysInBatch
   * 对每个 `kind: 'response'` 项调用。
   *
   * 匹配策略：
   * - 首先，尝试匹配待处理查询（FIFO，先匹配者胜出）。
   *   这允许调用者显式 send(da1()) 获取 DA1 参数——
   *   单独写入 DA1 意味着终端发送两个 DA1 响应。第一个匹配
   *   显式查询，第二个（未匹配的）触发哨兵。
   * - 否则，如果是 DA1，触发第一个待处理哨兵：
   *   将排在该哨兵之前的所有查询以 undefined resolve
   *   （终端回答了 DA1 但未回答它们 → 不支持）并通知其
   *   flush() 完成。只排空到第一个哨兵，这样当多个调用者有
   *   并发查询时，后面的批次保持完整。
   * - 非预期响应（无匹配、无哨兵）被静默丢弃。
   */
  onResponse(r: TerminalResponse): void {
    const idx = this.queue.findIndex((p) => p.kind === 'query' && p.match(r))
    if (idx !== -1) {
      const [q] = this.queue.splice(idx, 1)
      if (q?.kind === 'query') {
        q.resolve(r)
      }
      return
    }

    if (r.type === 'da1') {
      const s = this.queue.findIndex((p) => p.kind === 'sentinel')
      if (s === -1) {
        return
      }
      for (const p of this.queue.splice(0, s + 1)) {
        if (p.kind === 'query') {
          p.resolve(undefined)
        } else {
          p.resolve()
        }
      }
    }
  }
}
