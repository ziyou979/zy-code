import { spyOn } from 'bun:test'

type TestFunction = (...args: never[]) => unknown

/**
 * 遗留动态依赖测试逐个替换函数，不登记会反复重建的整模块工厂。
 * 调用方必须在 afterEach 或 afterAll 中执行 mock.restore()。
 */
export function spyOnModuleExports(
  module: Record<string, unknown>,
  overrides: Record<string, unknown>,
): void {
  for (const [name, implementation] of Object.entries(overrides)) {
    if (module[name] === implementation) {
      continue
    }
    if (typeof module[name] !== 'function' || typeof implementation !== 'function') {
      throw new Error(`Expected an existing function export: ${name}`)
    }
    // 只有通过上面的运行时函数检查后才收窄测试边界；业务模块仍保留完整类型。
    spyOn(module as Record<string, TestFunction>, name).mockImplementation(
      implementation as TestFunction,
    )
  }
}
