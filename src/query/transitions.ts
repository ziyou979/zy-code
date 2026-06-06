/** 终止态 — 查询循环到达最终状态，应停止。 */
export type Terminal = {
  reason: string
  [key: string]: unknown
}

/** 继续态 — 查询循环应继续运行。 */
export type Continue = {
  reason: string
  [key: string]: unknown
}

/** 查询状态转移联合类型。 */
export type TransitionState = Terminal | Continue
