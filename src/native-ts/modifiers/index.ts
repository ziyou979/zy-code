/**
 * modifiers-napi 的纯 TS 回退实现
 *
 * 通过 Bun FFI 调用 macOS CoreGraphics API (CGEventSourceKeyState)
 * 查询修饰键物理按下状态。仅在 macOS + Apple Terminal 下使用，
 * 用于弥补该终端不支持 CSI u 协议无法区分 Shift+Enter 等组合键的缺陷。
 *
 * 非 macOS 平台上所有函数返回空值（与原生模块降级行为一致）。
 */

// macOS 虚拟键码（来自 Events.h / Carbon HIToolbox）
const MODIFIER_KEYCODES: Record<string, number> = {
  shift: 56, // kVK_Shift
  command: 55, // kVK_Command
  control: 59, // kVK_Control
  option: 58, // kVK_Option
}

// 所有已知修饰键名
const ALL_MODIFIER_NAMES = Object.keys(MODIFIER_KEYCODES)

// kCGEventSourceStateCombinedSessionState = 0
const COMBINED_SESSION_STATE = 0

// 延迟加载的 FFI 符号引用
let cgEventSourceKeyState: ((stateID: number, keycode: number) => boolean) | null | undefined

/**
 * 延迟加载 CoreGraphics 动态库并绑定 CGEventSourceKeyState 符号。
 * 仅在首次调用时执行 dlopen，后续调用复用缓存结果。
 * 非 macOS 或加载失败时返回 null。
 */
function loadCGEventSource(): typeof cgEventSourceKeyState {
  if (cgEventSourceKeyState !== undefined) {
    return cgEventSourceKeyState
  }

  if (process.platform !== 'darwin') {
    cgEventSourceKeyState = null
    return null
  }

  try {
    // Bun FFI：dlopen 加载 CoreGraphics framework
    const { dlopen, FFIType, suffix } = require('bun:ffi') as typeof import('bun:ffi')
    const frameworkPath =
      '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'

    const lib = dlopen(frameworkPath, {
      CGEventSourceKeyState: {
        args: [FFIType.i32, FFIType.i32],
        returns: FFIType.bool,
      },
    })

    cgEventSourceKeyState = (stateID: number, keycode: number): boolean => {
      return lib.symbols.CGEventSourceKeyState(stateID, keycode) as unknown as boolean
    }
  } catch {
    cgEventSourceKeyState = null
  }

  return cgEventSourceKeyState
}

/**
 * 预热：提前加载动态库，避免首次调用时的延迟。
 */
export function prewarm(): void {
  loadCGEventSource()
}

/**
 * 检查指定修饰键是否当前被物理按下。
 *
 * @param modifier - 修饰键名称：'shift' | 'command' | 'control' | 'option'
 * @returns 该键是否按下；模块不可用时返回 false
 */
export function isModifierPressed(modifier: string): boolean {
  const keycode = MODIFIER_KEYCODES[modifier]
  if (keycode === undefined) {
    return false
  }

  const fn = loadCGEventSource()
  if (!fn) {
    return false
  }

  return fn(COMBINED_SESSION_STATE, keycode)
}

/**
 * 获取当前所有被按下的修饰键列表。
 *
 * @returns 当前按下的修饰键名称数组；模块不可用时返回空数组
 */
export function getModifiers(): string[] {
  const fn = loadCGEventSource()
  if (!fn) {
    return []
  }

  const pressed: string[] = []
  for (const name of ALL_MODIFIER_NAMES) {
    if (fn(COMBINED_SESSION_STATE, MODIFIER_KEYCODES[name]!)) {
      pressed.push(name)
    }
  }
  return pressed
}
