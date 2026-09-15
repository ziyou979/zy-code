/**
 * React 开发版的 User Timing 会在 Bun 原生层复制 detail；清理记录仍会留下高 RSS。
 * 仅在 dev preload 安装：跳过 React 轨道的原生记录创建，避免序列化和分配器膨胀。
 * 需要 PerformanceObserver 或性能轨道历史时，通过 dev 启动开关恢复原生实现。
 */
export function installReactPerformanceEntryCleanup(target: Performance = performance): () => void {
  const originalMeasure = target.measure
  const measure: Performance['measure'] = function (...args) {
    const options = args[1]
    if (
      typeof options === 'object' &&
      options !== null &&
      isReactDetail(options.detail) &&
      typeof options.start === 'number' &&
      Number.isFinite(options.start) &&
      options.start >= 0 &&
      typeof options.end === 'number' &&
      Number.isFinite(options.end) &&
      options.end >= options.start &&
      options.duration === undefined
    ) {
      // React 只传显式时间戳且不使用返回值。返回轻量记录保留字段访问，
      // 不制造原生条目，也不克隆可能包含大量组件属性的 detail。
      // 其他参数形式交回原生方法，保留 mark 解析和参数校验。
      return {
        name: args[0],
        entryType: 'measure',
        startTime: options.start,
        duration: options.end - options.start,
        detail: options.detail,
        toJSON() {
          return {
            name: this.name,
            entryType: this.entryType,
            startTime: this.startTime,
            duration: this.duration,
            detail: this.detail,
          }
        },
      }
    }
    return originalMeasure.apply(target, args)
  }
  target.measure = measure
  return () => {
    if (target.measure === measure) target.measure = originalMeasure
  }
}

function isReactDetail(detail: unknown): boolean {
  if (typeof detail !== 'object' || detail === null || !('devtools' in detail)) return false
  const devtools = detail.devtools
  if (typeof devtools !== 'object' || devtools === null) return false
  return (
    ('track' in devtools && devtools.track === 'Components ⚛') ||
    ('trackGroup' in devtools && devtools.trackGroup === 'Scheduler ⚛')
  )
}
