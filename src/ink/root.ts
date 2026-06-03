import { Stream } from 'node:stream'
import type { ReactNode } from 'react'
import { logForDebugging } from 'src/utils/debug.js'
import type { FrameEvent } from './frame.js'
import Ink, { type Options as InkOptions } from './ink.js'
import instances from './instances.js'

export type RenderOptions = {
  /**
   * 应用将被渲染到的输出流。
   *
   * @default process.stdout
   */
  stdout?: NodeJS.WriteStream
  /**
   * 应用将监听输入的输入流。
   *
   * @default process.stdin
   */
  stdin?: NodeJS.ReadStream
  /**
   * 错误流。
   * @default process.stderr
   */
  stderr?: NodeJS.WriteStream
  /**
   * 配置 Ink 是否应该监听 Ctrl+C 键盘输入并退出应用。
   * 当 `process.stdin` 处于 raw 模式时需要这个选项，因为默认情况下 Ctrl+C 会被忽略，
   * 进程需要手动处理它。
   *
   * @default true
   */
  exitOnCtrlC?: boolean

  /**
   * 修补 console 方法以确保 console 输出不与 Ink 输出混合。
   *
   * @default true
   */
  patchConsole?: boolean

  /**
   * 每次帧渲染后调用，带有时间和闪烁信息。
   */
  onFrame?: (event: FrameEvent) => void
}

export type Instance = {
  /**
   * 用新的根节点替换之前的根节点，或更新当前根节点的属性。
   */
  rerender: Ink['render']
  /**
   * 手动卸载整个 Ink 应用。
   */
  unmount: Ink['unmount']
  /**
   * 返回一个 promise，当应用卸载时解析。
   */
  waitUntilExit: Ink['waitUntilExit']
  cleanup: () => void
}

/**
 * 托管的 Ink 根节点，类似于 react-dom 的 createRoot API。
 * 将实例创建与渲染分离，以便同一个根节点可以
 * 复用于多个连续屏幕。
 */
export type Root = {
  render: (node: ReactNode) => void
  unmount: () => void
  waitUntilExit: () => Promise<void>
}

/**
 * 挂载组件并渲染输出。
 */
export const renderSync = (
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Instance => {
  const opts = getOptions(options)
  const inkOptions: InkOptions = {
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    exitOnCtrlC: true,
    patchConsole: true,
    ...opts,
  }

  const instance: Ink = getInstance(inkOptions.stdout, () => new Ink(inkOptions))

  instance.render(node)

  return {
    rerender: instance.render,
    unmount() {
      instance.unmount()
    },
    waitUntilExit: instance.waitUntilExit,
    cleanup: () => instances.delete(inkOptions.stdout),
  }
}

const wrappedRender = async (
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Promise<Instance> => {
  // 保留 `await loadYoga()` 曾经提供的微任务边界。
  // 没有它，第一次渲染会在异步启动工作
  //（例如 useReplBridge 通知状态）稳定之前同步触发，
  // 随后的 Static 写入会覆盖 scrollback 而不是附加到 logo 下方。
  await Promise.resolve()
  const instance = renderSync(node, options)
  logForDebugging(
    `[render] first ink render: ${Math.round(process.uptime() * 1000)}ms since process start`,
  )
  return instance
}

export default wrappedRender

/**
 * 创建一个 Ink 根节点，但尚未渲染任何内容。
 * 类似于 react-dom 的 createRoot — 调用 root.render() 来挂载树。
 */
export async function createRoot({
  stdout = process.stdout,
  stdin = process.stdin,
  stderr = process.stderr,
  exitOnCtrlC = true,
  patchConsole = true,
  onFrame,
}: RenderOptions = {}): Promise<Root> {
  // 见 wrappedRender — 保留旧的 WASM await 的微任务边界。
  await Promise.resolve()
  const instance = new Ink({
    stdout,
    stdin,
    stderr,
    exitOnCtrlC,
    patchConsole,
    onFrame,
  })

  // 注册到实例映射中，这样通过 stdout 查找 Ink
  // 实例的代码（例如外部编辑器暂停/恢复）可以找到它。
  instances.set(stdout, instance)

  return {
    render: (node) => instance.render(node),
    unmount: () => instance.unmount(),
    waitUntilExit: () => instance.waitUntilExit(),
  }
}

let getOptions!: (stdout?: NodeJS.WriteStream | RenderOptions) => RenderOptions
getOptions = (stdout: NodeJS.WriteStream | RenderOptions | undefined = {}): RenderOptions => {
  if (stdout instanceof Stream) {
    return {
      stdout,
      stdin: process.stdin,
    }
  }

  return stdout
}

let getInstance!: (stdout: NodeJS.WriteStream, createInstance: () => Ink) => Ink
getInstance = (stdout: NodeJS.WriteStream, createInstance: () => Ink): Ink => {
  let instance = instances.get(stdout)

  if (!instance) {
    instance = createInstance()
    instances.set(stdout, instance)
  }

  return instance
}
