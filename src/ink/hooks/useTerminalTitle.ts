import { useContext, useEffect } from 'react'
import stripAnsi from 'strip-ansi'
import { OSC, osc } from '../termio/osc.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'

/**
 * 声明式设置终端标签页/窗口标题。
 *
 * 传入字符串设置标题。ANSI 转义序列会自动剥离，
 * 因此调用者无需了解终端编码细节。
 * 传入 `null` 退出——hook 变为 no-op，不修改终端标题。
 *
 * Windows 上使用 `process.title`（经典 conhost 不支持 OSC）。
 * 其他平台通过 Ink 的 stdout 写入 OSC 0（设置标题+图标）。
 */
export function useTerminalTitle(title: string | null): void {
  const writeRaw = useContext(TerminalWriteContext)

  useEffect(() => {
    if (title === null || !writeRaw) {
      return
    }

    const clean = stripAnsi(title)

    if (process.platform === 'win32') {
      process.title = clean
    } else {
      writeRaw(osc(OSC.SET_TITLE_AND_ICON, clean))
    }
  }, [title, writeRaw])
}
