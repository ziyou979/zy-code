/* eslint-disable custom-rules/no-top-level-side-effects */

import { appendFileSync } from 'node:fs'
import createReconciler from 'react-reconciler'
import { getYogaCounters } from 'src/native-ts/yoga-layout/index.js'
import { isEnvTruthy } from '../services/infra/envUtils.js'
import {
  appendChildNode,
  clearYogaNodeReferences,
  createNode,
  createTextNode,
  type DOMElement,
  type DOMNodeAttribute,
  type ElementNames,
  insertBeforeNode,
  markDirty,
  removeChildNode,
  setAttribute,
  setStyle,
  setTextNodeValue,
  setTextStyles,
  type TextNode,
} from './dom.js'
import { Dispatcher } from './events/dispatcher.js'
import { EVENT_HANDLER_PROPS } from './events/eventHandlers.js'
import { getFocusManager, getRootNode } from './focus.js'
import { LayoutDisplay } from './layout/node.js'
import applyStyles, { type Styles, type TextStyles } from './styles.js'

// 我们需要有条件地执行 devtools 连接，以避免意外破坏其他第三方代码。
// 参见 https://github.com/vadimdemedes/ink/issues/384
if (process.env.NODE_ENV === 'development') {
  try {
    // eslint-disable-next-line custom-rules/no-top-level-dynamic-import -- dev-only; NODE_ENV check is DCE'd in production
    void import('./devtools.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  } catch (error: any) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      // biome-ignore lint/suspicious/noConsole: intentional warning
      console.warn(
        `${`
The environment variable DEV is set to true, so Ink tried to import \`react-devtools-core\`,
but this failed as it was not installed. Debugging with React Devtools requires it.

To install use this command:

$ npm install --save-dev react-devtools-core
				`.trim()}\n`,
      )
    } else {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw error
    }
  }
}

// --

type AnyObject = Record<string, unknown>

const diff = (before: AnyObject, after: AnyObject): AnyObject | undefined => {
  if (before === after) {
    return
  }

  if (!before) {
    return after
  }

  const changed: AnyObject = {}
  let isChanged = false

  for (const key of Object.keys(before)) {
    const isDeleted = after ? !Object.hasOwn(after, key) : true

    if (isDeleted) {
      changed[key] = undefined
      isChanged = true
    }
  }

  if (after) {
    for (const key of Object.keys(after)) {
      if (after[key] !== before[key]) {
        changed[key] = after[key]
        isChanged = true
      }
    }
  }

  return isChanged ? changed : undefined
}

const cleanupYogaNode = (node: DOMElement | TextNode): void => {
  const yogaNode = node.yogaNode
  if (yogaNode) {
    yogaNode.unsetMeasureFunc()
    // 在释放之前清除所有引用，防止其他代码在并发操作期间访问已释放的 WASM 内存
    clearYogaNodeReferences(node)
    yogaNode.freeRecursive()
  }
}

// --

type Props = Record<string, unknown>

type HostContext = {
  isInsideText: boolean
}

function setEventHandler(node: DOMElement, key: string, value: unknown): void {
  if (!node._eventHandlers) {
    node._eventHandlers = {}
  }
  node._eventHandlers[key] = value
}

function applyProp(node: DOMElement, key: string, value: unknown): void {
  if (key === 'children') {
    return
  }

  if (key === 'style') {
    setStyle(node, value as Styles)
    if (node.yogaNode) {
      applyStyles(node.yogaNode, value as Styles)
    }
    return
  }

  if (key === 'textStyles') {
    node.textStyles = value as TextStyles
    return
  }

  if (EVENT_HANDLER_PROPS.has(key)) {
    setEventHandler(node, key, value)
    return
  }

  setAttribute(node, key, value as DOMNodeAttribute)
}

// --

// react-reconciler 的 Fiber 结构 —— 仅包含我们遍历的字段。createInstance 的第 5 个参数是 Fiber（react-reconciler.dev.js 中的 `workInProgress`）。
// _debugOwner 是渲染此元素的组件（仅 dev 构建）；return 是父 fiber（始终存在）。我们优先使用 _debugOwner，因为它可以跳过 Box/Text 包装器直接找到实际的命名组件。
type FiberLike = {
  elementType?: { displayName?: string; name?: string } | string | null
  _debugOwner?: FiberLike | null
  return?: FiberLike | null
}

export function getOwnerChain(fiber: unknown): string[] {
  const chain: string[] = []
  const seen = new Set<unknown>()
  let cur = fiber as FiberLike | null | undefined
  for (let i = 0; cur && i < 50; i++) {
    if (seen.has(cur)) {
      break
    }
    seen.add(cur)
    const t = cur.elementType
    const name =
      typeof t === 'function'
        ? (t as { displayName?: string; name?: string }).displayName ||
          (t as { displayName?: string; name?: string }).name
        : typeof t === 'string'
          ? undefined // 宿主元素（ink-box 等）—— 跳过
          : t?.displayName || t?.name
    if (name && name !== chain[chain.length - 1]) {
      chain.push(name)
    }
    cur = cur._debugOwner ?? cur.return
  }
  return chain
}

let debugRepaints: boolean | undefined
export function isDebugRepaintsEnabled(): boolean {
  if (debugRepaints === undefined) {
    debugRepaints = isEnvTruthy(process.env.ZY_CODE_DEBUG_REPAINTS)
  }
  return debugRepaints
}

export const dispatcher = new Dispatcher()

// --- COMMIT 埋点（临时调试）---
// eslint-disable-next-line custom-rules/no-process-env-top-level -- debug instrumentation, read-once is fine
const COMMIT_LOG = process.env.ZY_CODE_COMMIT_LOG
let _commits = 0
let _lastLog = 0
let _lastCommitAt = 0
let _maxGapMs = 0
let _createCount = 0
let _prepareAt = 0
// --- END ---

// --- SCROLL 性能分析（bench/scroll-e2e.sh 通过 getLastYogaMs 读取）---
// 由 ink.tsx 中的 onComputeLayout 包装器设置；由 onRender 读取用于阶段划分。
let _lastYogaMs = 0
let _lastCommitMs = 0
let _commitStart = 0
export function recordYogaMs(ms: number): void {
  _lastYogaMs = ms
}
export function getLastYogaMs(): number {
  return _lastYogaMs
}
export function markCommitStart(): void {
  _commitStart = performance.now()
}
export function getLastCommitMs(): number {
  return _lastCommitMs
}
export function resetProfileCounters(): void {
  _lastYogaMs = 0
  _lastCommitMs = 0
  _commitStart = 0
}
// --- END ---

type ReconcileWithSync = ReturnType<typeof createReconciler> & {
  createContainer: (...args: unknown[]) => Record<string, unknown>
  updateContainerSync: (...args: unknown[]) => void
  flushSyncWork: () => void
  flushSyncFromReconciler: (...args: unknown[]) => void
}

const reconciler = (
  createReconciler as unknown as (config: Record<string, unknown>) => ReconcileWithSync
)({
  getRootHostContext: () => ({ isInsideText: false }),
  prepareForCommit: () => {
    if (COMMIT_LOG) {
      _prepareAt = performance.now()
    }
    return null
  },
  preparePortalMount: () => null,
  clearContainer: () => false,
  resetAfterCommit(rootNode: DOMElement) {
    _lastCommitMs = _commitStart > 0 ? performance.now() - _commitStart : 0
    _commitStart = 0
    if (COMMIT_LOG) {
      const now = performance.now()
      _commits++
      const gap = _lastCommitAt > 0 ? now - _lastCommitAt : 0
      if (gap > _maxGapMs) {
        _maxGapMs = gap
      }
      _lastCommitAt = now
      const reconcileMs = _prepareAt > 0 ? now - _prepareAt : 0
      if (gap > 30 || reconcileMs > 20 || _createCount > 50) {
        // eslint-disable-next-line custom-rules/no-sync-fs -- debug instrumentation
        appendFileSync(
          COMMIT_LOG,
          `${now.toFixed(1)} gap=${gap.toFixed(1)}ms reconcile=${reconcileMs.toFixed(1)}ms creates=${_createCount}\n`,
        )
      }
      _createCount = 0
      if (now - _lastLog > 1000) {
        // eslint-disable-next-line custom-rules/no-sync-fs -- debug instrumentation
        appendFileSync(
          COMMIT_LOG,
          `${now.toFixed(1)} commits=${_commits}/s maxGap=${_maxGapMs.toFixed(1)}ms\n`,
        )
        _commits = 0
        _maxGapMs = 0
        _lastLog = now
      }
    }
    const _t0 = COMMIT_LOG ? performance.now() : 0
    if (typeof rootNode.onComputeLayout === 'function') {
      rootNode.onComputeLayout()
    }
    if (COMMIT_LOG) {
      const layoutMs = performance.now() - _t0
      if (layoutMs > 20) {
        const c = getYogaCounters()
        // eslint-disable-next-line custom-rules/no-sync-fs -- debug instrumentation
        appendFileSync(
          COMMIT_LOG,
          `${_t0.toFixed(1)} SLOW_YOGA ${layoutMs.toFixed(1)}ms visited=${c.visited} measured=${c.measured} hits=${c.cacheHits} live=${c.live}\n`,
        )
      }
    }

    if (process.env.NODE_ENV === 'test') {
      if (rootNode.childNodes.length === 0 && rootNode.hasRenderedContent) {
        return
      }
      if (rootNode.childNodes.length > 0) {
        rootNode.hasRenderedContent = true
      }
      rootNode.onImmediateRender?.()
      return
    }

    const _tr = COMMIT_LOG ? performance.now() : 0
    rootNode.onRender?.()
    if (COMMIT_LOG) {
      const renderMs = performance.now() - _tr
      if (renderMs > 10) {
        // eslint-disable-next-line custom-rules/no-sync-fs -- debug instrumentation
        appendFileSync(COMMIT_LOG, `${_tr.toFixed(1)} SLOW_PAINT ${renderMs.toFixed(1)}ms\n`)
      }
    }
  },
  getChildHostContext(parentHostContext: HostContext, type: ElementNames): HostContext {
    const previousIsInsideText = parentHostContext.isInsideText
    const isInsideText = type === 'ink-text' || type === 'ink-virtual-text' || type === 'ink-link'

    if (previousIsInsideText === isInsideText) {
      return parentHostContext
    }

    return { isInsideText }
  },
  shouldSetTextContent: () => false,
  createInstance(
    originalType: ElementNames,
    newProps: Props,
    _root: DOMElement,
    hostContext: HostContext,
    internalHandle?: unknown,
  ): DOMElement {
    if (hostContext.isInsideText && originalType === 'ink-box') {
      throw new Error(`<Box> can't be nested inside <Text> component`)
    }

    const type =
      originalType === 'ink-text' && hostContext.isInsideText ? 'ink-virtual-text' : originalType

    const node = createNode(type)
    if (COMMIT_LOG) {
      _createCount++
    }

    for (const [key, value] of Object.entries(newProps)) {
      applyProp(node, key, value)
    }

    if (isDebugRepaintsEnabled()) {
      node.debugOwnerChain = getOwnerChain(internalHandle)
    }

    return node
  },
  createTextInstance(text: string, _root: DOMElement, hostContext: HostContext): TextNode {
    if (!hostContext.isInsideText) {
      throw new Error(`Text string "${text}" must be rendered inside <Text> component`)
    }

    return createTextNode(text)
  },
  resetTextContent() {},
  hideTextInstance(node: TextNode) {
    setTextNodeValue(node, '')
  },
  unhideTextInstance(node: TextNode, text: string) {
    setTextNodeValue(node, text)
  },
  getPublicInstance: (instance: DOMElement | TextNode): DOMElement => instance as DOMElement,
  hideInstance(node: DOMElement) {
    node.isHidden = true
    node.yogaNode?.setDisplay(LayoutDisplay.None)
    markDirty(node)
  },
  unhideInstance(node: DOMElement) {
    node.isHidden = false
    node.yogaNode?.setDisplay(LayoutDisplay.Flex)
    markDirty(node)
  },
  appendInitialChild: appendChildNode,
  appendChild: appendChildNode,
  insertBefore: insertBeforeNode,
  finalizeInitialChildren(_node: DOMElement, _type: ElementNames, props: Props): boolean {
    return props.autoFocus === true
  },
  commitMount(node: DOMElement): void {
    getFocusManager(node).handleAutoFocus(node)
  },
  isPrimaryRenderer: true,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  getCurrentUpdatePriority: () => dispatcher.currentUpdatePriority,
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
  detachDeletedInstance() {},
  getInstanceFromNode: () => null,
  prepareScopeUpdate() {},
  getInstanceFromScope: () => null,
  appendChildToContainer: appendChildNode,
  insertInContainerBefore: insertBeforeNode,
  removeChildFromContainer(node: DOMElement, removeNode: DOMElement): void {
    removeChildNode(node, removeNode)
    cleanupYogaNode(removeNode)
    getFocusManager(node).handleNodeRemoved(removeNode, node)
  },
  // React 19 的 commitUpdate 直接接收旧的和新的 props，而不是 updatePayload
  commitUpdate(node: DOMElement, _type: ElementNames, oldProps: Props, newProps: Props): void {
    const props = diff(oldProps, newProps)
    const style = diff(oldProps.style as Styles, newProps.style as Styles)

    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (key === 'style') {
          setStyle(node, value as Styles)
          continue
        }

        if (key === 'textStyles') {
          setTextStyles(node, value as TextStyles)
          continue
        }

        if (EVENT_HANDLER_PROPS.has(key)) {
          setEventHandler(node, key, value)
          continue
        }

        setAttribute(node, key, value as DOMNodeAttribute)
      }
    }

    if (style && node.yogaNode) {
      applyStyles(node.yogaNode, style, newProps.style as Styles)
    }
  },
  commitTextUpdate(node: TextNode, _oldText: string, newText: string): void {
    setTextNodeValue(node, newText)
  },
  removeChild(node: DOMElement, removeNode: DOMElement | TextNode) {
    removeChildNode(node, removeNode)
    cleanupYogaNode(removeNode)
    if (removeNode.nodeName !== '#text') {
      const root = getRootNode(node)
      root.focusManager!.handleNodeRemoved(removeNode, root)
    }
  },
  // React 19 所需的方法
  maySuspendCommit(): boolean {
    return false
  },
  preloadInstance(): boolean {
    return true
  },
  startSuspendingCommit(): void {},
  suspendInstance(): void {},
  waitForCommitToBeReady(): null {
    return null
  },
  NotPendingTransition: null,
  HostTransitionContext: {
    $$typeof: Symbol.for('react.context'),
    _currentValue: null,
  } as never,
  setCurrentUpdatePriority(newPriority: number): void {
    dispatcher.currentUpdatePriority = newPriority
  },
  resolveUpdatePriority(): number {
    return dispatcher.resolveEventPriority()
  },
  resetFormInstance(): void {},
  requestPostPaintCallback(): void {},
  shouldAttemptEagerTransition(): boolean {
    return false
  },
  trackSchedulerEvent(): void {},
  resolveEventType(): string | null {
    return dispatcher.currentEvent?.type ?? null
  },
  resolveEventTimeStamp(): number {
    return dispatcher.currentEvent?.timeStamp ?? -1.1
  },
})

// 将 reconciler 的 discreteUpdates 接入 dispatcher。
// 这样打破了导入循环：dispatcher.ts 不导入 reconciler.ts。
dispatcher.discreteUpdates = reconciler.discreteUpdates.bind(reconciler)

export default reconciler
