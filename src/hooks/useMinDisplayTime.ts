import { useEffect, useRef, useState } from 'react'

/**
 * 限制值的更新速度，确保每个不同的值至少显示 `minMs`。
 * 避免进度文本切换过快、还没看清就一闪而过。
 *
 * 这与等待输入平静的 debounce、限制更新频率的 throttle 不同：
 * 此处保证每个值被替换前都能达到最短显示时间。
 */
export function useMinDisplayTime<T>(value: T, minMs: number): T {
  const [displayed, setDisplayed] = useState(value)
  const lastShownAtRef = useRef(0)

  useEffect(() => {
    const elapsed = Date.now() - lastShownAtRef.current
    if (elapsed >= minMs) {
      lastShownAtRef.current = Date.now()
      setDisplayed(value)
      return
    }
    const timer = setTimeout(
      (shownAtRef, setFn, v) => {
        shownAtRef.current = Date.now()
        setFn(v)
      },
      minMs - elapsed,
      lastShownAtRef,
      setDisplayed,
      value,
    )
    return () => clearTimeout(timer)
  }, [value, minMs])

  return displayed
}
