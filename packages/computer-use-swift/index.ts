// Stub for @ant/computer-use-swift
// 第三方原生模块 stub——运行时实际对象比声明类型大得多。
// 如需添加额外运行时属性，请在此集中声明，避免调用处散落类型断言。

export type ComputerUseAPI = {
  screenshot(): Promise<{ data: Buffer; width: number; height: number }>
  getWindows(): Promise<Array<{ id: number; title: string; appName: string }>>

  // ── CFRunLoop ──────────────────────────────────────────────────
  /** 驱动 DispatchQueue.main 的 CFRunLoop pump，供 @MainActor 方法使用。 */
  _drainMainRunLoop(): void

  // ── 全局 Escape 热键 ────────────────────────────────────────────
  hotkey: {
    /** 注册系统级 Escape 回调。失败（权限不足）返回 false。 */
    registerEscape(onEscape: () => void): boolean
    unregister(): void
    /** 告知 Swift 层「即将发送模型合成的 Escape」，避免吞掉用户后续按键。 */
    notifyExpectedEscape(): void
  }

  // ── 隐私权限检查 ────────────────────────────────────────────────
  tcc: {
    checkAccessibility(): boolean
    checkScreenRecording(): boolean
  }

  // ── 应用管理 ────────────────────────────────────────────────────
  apps: {
    /** 隐藏指定 bundle ID 的应用（在截图前隐藏浮动窗口）。 */
    unhide(bundleIds: string[]): Promise<void>
  }
}
