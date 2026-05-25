/**
 * yoga-layout（Meta 的 flexbox 引擎）的纯 TypeScript 移植。
 *
 * 与 src/ink/layout/yoga.ts 所使用的 `yoga-layout/load` API 接口保持一致。
 * 上游 C++ 代码光是 CalculateLayout.cpp 就达 ~2500 行；本移植是一个简化的
 * 单趟 flexbox 实现，仅覆盖 Ink 实际使用的特性子集：
 *   - flex-direction（row/column + reverse）
 *   - flex-grow / flex-shrink / flex-basis
 *   - align-items / align-self（stretch、flex-start、center、flex-end）
 *   - justify-content（全部六个取值）
 *   - margin / padding / border / gap
 *   - width / height / min / max（point、percent、auto）
 *   - position：relative / absolute
 *   - display：flex / none
 *   - measure functions（用于文本节点）
 *
 * 为与 spec 对齐而实现（Ink 未使用）：
 *   - margin: auto（主轴 + 交叉轴，会覆盖 justify/align）
 *   - 子节点命中 min/max 约束时的多趟 flex 夹限
 *   - 容器尺寸不确定时，针对容器 min/max 的 flex-grow/shrink
 *
 * 为与 spec 对齐而实现（Ink 未使用）：
 *   - flex-wrap：wrap / wrap-reverse（多行 flex）
 *   - align-content（在交叉轴上安置换行后的行）
 *
 * 为与 spec 对齐而实现（Ink 未使用）：
 *   - display: contents（子节点被提升到父父节点，本身被移除）
 *
 * 为与 spec 对齐而实现（Ink 未使用）：
 *   - baseline 对齐（align-items/align-self: baseline）
 *
 * 未实现（Ink 未使用）：
 *   - aspect-ratio
 *   - box-sizing: content-box
 *   - RTL 方向（Ink 始终传入 Direction.LTR）
 *
 * 上游项目：https://github.com/facebook/yoga
 */

import {
  Align,
  BoxSizing,
  Dimension,
  Direction,
  Display,
  Edge,
  Errata,
  ExperimentalFeature,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Overflow,
  PositionType,
  Unit,
  Wrap,
} from './enums.js'

export {
  Align,
  BoxSizing,
  Dimension,
  Direction,
  Display,
  Edge,
  Errata,
  ExperimentalFeature,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Overflow,
  PositionType,
  Unit,
  Wrap,
}

// --
// 取值类型

export type Value = {
  unit: Unit
  value: number
}

const UNDEFINED_VALUE: Value = { unit: Unit.Undefined, value: NaN }
const AUTO_VALUE: Value = { unit: Unit.Auto, value: NaN }

function pointValue(v: number): Value {
  return { unit: Unit.Point, value: v }
}
function percentValue(v: number): Value {
  return { unit: Unit.Percent, value: v }
}

function resolveValue(v: Value, ownerSize: number): number {
  switch (v.unit) {
    case Unit.Point:
      return v.value
    case Unit.Percent:
      return Number.isNaN(ownerSize) ? NaN : (v.value * ownerSize) / 100
    default:
      return NaN
  }
}

function isDefined(n: number): boolean {
  return !Number.isNaN(n)
}

// 对布局缓存输入比较的 NaN 安全相等判断
function sameFloat(a: number, b: number): boolean {
  return a === b || (a !== a && b !== b)
}

// --
// 布局结果（计算后的取值）

type Layout = {
  left: number
  top: number
  width: number
  height: number
  // 逐边计算后的值（解析到物理边）
  border: [number, number, number, number] // left, top, right, bottom
  padding: [number, number, number, number]
  margin: [number, number, number, number]
}

// --
// 样式（输入值）

type Style = {
  direction: Direction
  flexDirection: FlexDirection
  justifyContent: Justify
  alignItems: Align
  alignSelf: Align
  alignContent: Align
  flexWrap: Wrap
  overflow: Overflow
  display: Display
  positionType: PositionType

  flexGrow: number
  flexShrink: number
  flexBasis: Value

  // 以 Edge 枚举作为索引的 9 边数组
  margin: Value[]
  padding: Value[]
  border: Value[]
  position: Value[]

  // 以 Gutter 枚举作为索引的 3 间隙数组
  gap: Value[]

  width: Value
  height: Value
  minWidth: Value
  minHeight: Value
  maxWidth: Value
  maxHeight: Value
}

function defaultStyle(): Style {
  return {
    direction: Direction.Inherit,
    flexDirection: FlexDirection.Column,
    justifyContent: Justify.FlexStart,
    alignItems: Align.Stretch,
    alignSelf: Align.Auto,
    alignContent: Align.FlexStart,
    flexWrap: Wrap.NoWrap,
    overflow: Overflow.Visible,
    display: Display.Flex,
    positionType: PositionType.Relative,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: AUTO_VALUE,
    margin: new Array(9).fill(UNDEFINED_VALUE),
    padding: new Array(9).fill(UNDEFINED_VALUE),
    border: new Array(9).fill(UNDEFINED_VALUE),
    position: new Array(9).fill(UNDEFINED_VALUE),
    gap: new Array(3).fill(UNDEFINED_VALUE),
    width: AUTO_VALUE,
    height: AUTO_VALUE,
    minWidth: UNDEFINED_VALUE,
    minHeight: UNDEFINED_VALUE,
    maxWidth: UNDEFINED_VALUE,
    maxHeight: UNDEFINED_VALUE,
  }
}

// --
// 边解析 —— yoga 的9-边模型压缩到 4 个物理边

const EDGE_LEFT = 0
const EDGE_TOP = 1
const EDGE_RIGHT = 2
const EDGE_BOTTOM = 3

function resolveEdge(
  edges: Value[],
  physicalEdge: number,
  ownerSize: number,
  // 对于 margin/position 允许 auto；对于 padding/border，auto 解析为 0
  allowAuto = false,
): number {
  // 优先级：特定边 > horizontal/vertical > all
  let v = edges[physicalEdge]!
  if (v.unit === Unit.Undefined) {
    if (physicalEdge === EDGE_LEFT || physicalEdge === EDGE_RIGHT) {
      v = edges[Edge.Horizontal]!
    } else {
      v = edges[Edge.Vertical]!
    }
  }
  if (v.unit === Unit.Undefined) {
    v = edges[Edge.All]!
  }
  // Start/End 在 LTR 下映射到 Left/Right（Ink 始终是 LTR）
  if (v.unit === Unit.Undefined) {
    if (physicalEdge === EDGE_LEFT) {
      v = edges[Edge.Start]!
    }
    if (physicalEdge === EDGE_RIGHT) {
      v = edges[Edge.End]!
    }
  }
  if (v.unit === Unit.Undefined) {
    return 0
  }
  if (v.unit === Unit.Auto) {
    return allowAuto ? NaN : 0
  }
  return resolveValue(v, ownerSize)
}

function resolveEdgeRaw(edges: Value[], physicalEdge: number): Value {
  let v = edges[physicalEdge]!
  if (v.unit === Unit.Undefined) {
    if (physicalEdge === EDGE_LEFT || physicalEdge === EDGE_RIGHT) {
      v = edges[Edge.Horizontal]!
    } else {
      v = edges[Edge.Vertical]!
    }
  }
  if (v.unit === Unit.Undefined) {
    v = edges[Edge.All]!
  }
  if (v.unit === Unit.Undefined) {
    if (physicalEdge === EDGE_LEFT) {
      v = edges[Edge.Start]!
    }
    if (physicalEdge === EDGE_RIGHT) {
      v = edges[Edge.End]!
    }
  }
  return v
}

function isMarginAuto(edges: Value[], physicalEdge: number): boolean {
  return resolveEdgeRaw(edges, physicalEdge).unit === Unit.Auto
}

// _hasAutoMargin / _hasPosition 快路径标志位的 setter 辅助函数。
// Unit.Undefined = 0，Unit.Auto = 3。
function hasAnyAutoEdge(edges: Value[]): boolean {
  for (let i = 0; i < 9; i++) {
    if (edges[i]!.unit === 3) {
      return true
    }
  }
  return false
}
function hasAnyDefinedEdge(edges: Value[]): boolean {
  for (let i = 0; i < 9; i++) {
    if (edges[i]!.unit !== 0) {
      return true
    }
  }
  return false
}

// 热路径：一趟解析出所有 4 个物理边，写入 `out`。
// 等价于以 allowAuto=false 调用 resolveEdge() 4 次，但会将共享的
// 回退查找（Horizontal/Vertical/All/Start/End）提前读取，
// 并避免每次 layoutNode() 调用都分配一个新的 4 元素数组。
function resolveEdges4Into(
  edges: Value[],
  ownerSize: number,
  out: [number, number, number, number],
): void {
  // 将回退项一次性提前读取——4 个逐边链路会共享这些读取。
  const eH = edges[6]! // Edge.Horizontal
  const eV = edges[7]! // Edge.Vertical
  const eA = edges[8]! // Edge.All
  const eS = edges[4]! // Edge.Start
  const eE = edges[5]! // Edge.End
  const pctDenom = Number.isNaN(ownerSize) ? NaN : ownerSize / 100

  // 左边：edges[0] → Horizontal → All → Start
  let v = edges[0]!
  if (v.unit === 0) {
    v = eH
  }
  if (v.unit === 0) {
    v = eA
  }
  if (v.unit === 0) {
    v = eS
  }
  out[0] = v.unit === 1 ? v.value : v.unit === 2 ? v.value * pctDenom : 0

  // 顶边：edges[1] → Vertical → All
  v = edges[1]!
  if (v.unit === 0) {
    v = eV
  }
  if (v.unit === 0) {
    v = eA
  }
  out[1] = v.unit === 1 ? v.value : v.unit === 2 ? v.value * pctDenom : 0

  // 右边：edges[2] → Horizontal → All → End
  v = edges[2]!
  if (v.unit === 0) {
    v = eH
  }
  if (v.unit === 0) {
    v = eA
  }
  if (v.unit === 0) {
    v = eE
  }
  out[2] = v.unit === 1 ? v.value : v.unit === 2 ? v.value * pctDenom : 0

  // 底边：edges[3] → Vertical → All
  v = edges[3]!
  if (v.unit === 0) {
    v = eV
  }
  if (v.unit === 0) {
    v = eA
  }
  out[3] = v.unit === 1 ? v.value : v.unit === 2 ? v.value * pctDenom : 0
}

// --
// 轴辅助函数

function isRow(dir: FlexDirection): boolean {
  return dir === FlexDirection.Row || dir === FlexDirection.RowReverse
}
function isReverse(dir: FlexDirection): boolean {
  return dir === FlexDirection.RowReverse || dir === FlexDirection.ColumnReverse
}
function crossAxis(dir: FlexDirection): FlexDirection {
  return isRow(dir) ? FlexDirection.Column : FlexDirection.Row
}
function leadingEdge(dir: FlexDirection): number {
  switch (dir) {
    case FlexDirection.Row:
      return EDGE_LEFT
    case FlexDirection.RowReverse:
      return EDGE_RIGHT
    case FlexDirection.Column:
      return EDGE_TOP
    case FlexDirection.ColumnReverse:
      return EDGE_BOTTOM
  }
}
function trailingEdge(dir: FlexDirection): number {
  switch (dir) {
    case FlexDirection.Row:
      return EDGE_RIGHT
    case FlexDirection.RowReverse:
      return EDGE_LEFT
    case FlexDirection.Column:
      return EDGE_BOTTOM
    case FlexDirection.ColumnReverse:
      return EDGE_TOP
  }
}

// --
// 公有类型

export type MeasureFunction = (
  width: number,
  widthMode: MeasureMode,
  height: number,
  heightMode: MeasureMode,
) => { width: number; height: number }

export type Size = { width: number; height: number }

// --
// 配置

export type Config = {
  pointScaleFactor: number
  errata: Errata
  useWebDefaults: boolean
  free(): void
  isExperimentalFeatureEnabled(_: ExperimentalFeature): boolean
  setExperimentalFeatureEnabled(_: ExperimentalFeature, __: boolean): void
  setPointScaleFactor(factor: number): void
  getErrata(): Errata
  setErrata(errata: Errata): void
  setUseWebDefaults(v: boolean): void
}

function createConfig(): Config {
  const config: Config = {
    pointScaleFactor: 1,
    errata: Errata.None,
    useWebDefaults: false,
    free() {},
    isExperimentalFeatureEnabled() {
      return false
    },
    setExperimentalFeatureEnabled() {},
    setPointScaleFactor(f) {
      config.pointScaleFactor = f
    },
    getErrata() {
      return config.errata
    },
    setErrata(e) {
      config.errata = e
    },
    setUseWebDefaults(v) {
      config.useWebDefaults = v
    },
  }
  return config
}

// --
// Node 实现

export class Node {
  style: Style
  layout: Layout
  parent: Node | null
  children: Node[]
  measureFunc: MeasureFunction | null
  config: Config
  isDirty_: boolean
  isReferenceBaseline_: boolean

  // 单次布局使用的草稿字段（非公有 API）
  _flexBasis = 0
  _mainSize = 0
  _crossSize = 0
  _lineIndex = 0
  // 由 style setter 维护的快路径标志位。根据 CPU profile，
  // 定位循环每次布局会对每个子节点调用 isMarginAuto 6 次、
  // resolveEdgeRaw(position) 4 次——1000 节点压测下约 1.1 万次调用，
  // 几乎全部返回 false/undefined，因为大多数节点既没有 auto margin
  // 也没有 position 偏移。这些标志位能让我们以单分支跳到
  // 常见分支。
  _hasAutoMargin = false
  _hasPosition = false
  // 同样适用于每次 layoutNode() 开头 3 次的 resolveEdges4Into 调用。
  // 在1000 节点压测中，约 67% 的调用面对的是全 undefined 的 edge
  // 数组（大多数节点没有 border；只有 col 有 padding；只有叶子
  // 单元有 margin）——单分支跳过越过了约 20 次属性读取 +
  // ~15 次比较 + 4 次零写入。
  _hasPadding = false
  _hasBorder = false
  _hasMargin = false
  // -- 脏标志布局缓存。与上游 CalculateLayout.cpp 的
  // layoutNodeInternal：当子树是 clean 状态且记录与当前询问一致时，
  // 整棵子树都可跳过。使用两个槽位，因为每个节点通常会接收到一个
  // measure 调用（performLayout=false，来自 computeFlexBasis），随后是一个
  // layout 调用（performLayout=true），两个调用在不同父趟下输入不同
  // ——单个槽位会频繁被覆写。加上该缓存后，重布局压测（将一个叶子
  // 节点标脏，重算 root）从 2.7x 提升到 1.1x：clean 同级节点直接
  // 跳过，只有 dirty 链路上的节点重算。
  _lW = NaN
  _lH = NaN
  _lWM: MeasureMode = 0
  _lHM: MeasureMode = 0
  _lOW = NaN
  _lOH = NaN
  _lFW = false
  _lFH = false
  // _hasL 会在计算之前提前存储输入，但 layout.width/height
  // 会被多槽缓存以及后续不同输入的 compute 调用修改。如果不存储
  // 输出，_hasL 命中时返回的 layout.width/height 会是上一次调用随意
  // 留下的值——即 scrollbox vpH=33→2624 的 bug。与多槽缓存一样，
  // 同时存储与恢复输出。
  _lOutW = NaN
  _lOutH = NaN
  _hasL = false
  _mW = NaN
  _mH = NaN
  _mWM: MeasureMode = 0
  _mHM: MeasureMode = 0
  _mOW = NaN
  _mOH = NaN
  _mOutW = NaN
  _mOutH = NaN
  _hasM = false
  // 缓存的 computeFlexBasis 结果。对 clean 子节点而言，basis 仅取决于
  // 容器的内部尺寸——只要这些未变，就可以完全跳过
  // layoutNode(performLayout=false) 递归。这是滚动场景的热路径：500 条
  // 消息的内容容器是 dirty，其 499 个 clean 子节点会随 dirty 链路的
  // measure/layout 趟叠起来被重复量约 20 次。Basis 缓存在子节点边界
  // 上短路。
  _fbBasis = NaN
  _fbOwnerW = NaN
  _fbOwnerH = NaN
  _fbAvailMain = NaN
  _fbAvailCross = NaN
  _fbCrossMode: MeasureMode = 0
  // _fbBasis 写入时的代号。上一代中被标为 dirty 的节点会拥有过期缓存
  // （子树发生过变化），但在同一代内缓存仍是新鲜的——dirty 链路的
  // measure→layout 趟叠会在 calculateLayout 中针对刚挂载的子项调用
  // computeFlexBasis ≥2^depth 次，而这期间子树不会变化。
  // 以代号代替 isDirty_ 作为闸门，能让刚挂载（虚拟滚动）的节点在
  // 首次计算后仍能命中缓存：105k 次访问 → 约 10k 次。
  _fbGen = -1
  // 多槽布局缓存——存储（输入 → 计算后的 w,h），使与 _hasL 的输入
  // 不同但仍命中时能恢复正确尺寸。上游 yoga 使用 16 个槽位；4 个
  // 已足以覆盖 Ink 的 dirty 链深度。以扁数组存储，避免逐条目的对象
  // 分配。槽位 i 使用 _cIn 索引 [i*8, i*8+8)（aW,aH,wM,hM,oW,oH,fW,fH）
  // 与 _cOut 索引 [i*2, i*2+2)（w,h）。
  _cIn: Float64Array | null = null
  _cOut: Float64Array | null = null
  _cGen = -1
  _cN = 0
  _cWr = 0

  constructor(config?: Config) {
    this.style = defaultStyle()
    this.layout = {
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      border: [0, 0, 0, 0],
      padding: [0, 0, 0, 0],
      margin: [0, 0, 0, 0],
    }
    this.parent = null
    this.children = []
    this.measureFunc = null
    this.config = config ?? DEFAULT_CONFIG
    this.isDirty_ = true
    this.isReferenceBaseline_ = false
    _yogaLiveNodes++
  }

  // -- 树结构

  insertChild(child: Node, index: number): void {
    child.parent = this
    this.children.splice(index, 0, child)
    this.markDirty()
  }
  removeChild(child: Node): void {
    const idx = this.children.indexOf(child)
    if (idx >= 0) {
      this.children.splice(idx, 1)
      child.parent = null
      this.markDirty()
    }
  }
  getChild(index: number): Node {
    return this.children[index]!
  }
  getChildCount(): number {
    return this.children.length
  }
  getParent(): Node | null {
    return this.parent
  }

  // -- 生命周期

  free(): void {
    this.parent = null
    this.children = []
    this.measureFunc = null
    this._cIn = null
    this._cOut = null
    _yogaLiveNodes--
  }
  freeRecursive(): void {
    for (const c of this.children) {
      c.freeRecursive()
    }
    this.free()
  }
  reset(): void {
    this.style = defaultStyle()
    this.children = []
    this.parent = null
    this.measureFunc = null
    this.isDirty_ = true
    this._hasAutoMargin = false
    this._hasPosition = false
    this._hasPadding = false
    this._hasBorder = false
    this._hasMargin = false
    this._hasL = false
    this._hasM = false
    this._cN = 0
    this._cWr = 0
    this._fbBasis = NaN
  }

  // -- 脏标记追踪

  markDirty(): void {
    this.isDirty_ = true
    if (this.parent && !this.parent.isDirty_) {
      this.parent.markDirty()
    }
  }
  isDirty(): boolean {
    return this.isDirty_
  }
  hasNewLayout(): boolean {
    return true
  }
  markLayoutSeen(): void {}

  // -- 测量函数

  setMeasureFunc(fn: MeasureFunction | null): void {
    this.measureFunc = fn
    this.markDirty()
  }
  unsetMeasureFunc(): void {
    this.measureFunc = null
    this.markDirty()
  }

  // -- 已计算布局的 getter

  getComputedLeft(): number {
    return this.layout.left
  }
  getComputedTop(): number {
    return this.layout.top
  }
  getComputedWidth(): number {
    return this.layout.width
  }
  getComputedHeight(): number {
    return this.layout.height
  }
  getComputedRight(): number {
    const p = this.parent
    return p ? p.layout.width - this.layout.left - this.layout.width : 0
  }
  getComputedBottom(): number {
    const p = this.parent
    return p ? p.layout.height - this.layout.top - this.layout.height : 0
  }
  getComputedLayout(): {
    left: number
    top: number
    right: number
    bottom: number
    width: number
    height: number
  } {
    return {
      left: this.layout.left,
      top: this.layout.top,
      right: this.getComputedRight(),
      bottom: this.getComputedBottom(),
      width: this.layout.width,
      height: this.layout.height,
    }
  }
  getComputedBorder(edge: Edge): number {
    return this.layout.border[physicalEdge(edge)]!
  }
  getComputedPadding(edge: Edge): number {
    return this.layout.padding[physicalEdge(edge)]!
  }
  getComputedMargin(edge: Edge): number {
    return this.layout.margin[physicalEdge(edge)]!
  }

  // -- 样式 setter：dimensions

  setWidth(v: number | 'auto' | string | undefined): void {
    this.style.width = parseDimension(v)
    this.markDirty()
  }
  setWidthPercent(v: number): void {
    this.style.width = percentValue(v)
    this.markDirty()
  }
  setWidthAuto(): void {
    this.style.width = AUTO_VALUE
    this.markDirty()
  }
  setHeight(v: number | 'auto' | string | undefined): void {
    this.style.height = parseDimension(v)
    this.markDirty()
  }
  setHeightPercent(v: number): void {
    this.style.height = percentValue(v)
    this.markDirty()
  }
  setHeightAuto(): void {
    this.style.height = AUTO_VALUE
    this.markDirty()
  }
  setMinWidth(v: number | string | undefined): void {
    this.style.minWidth = parseDimension(v)
    this.markDirty()
  }
  setMinWidthPercent(v: number): void {
    this.style.minWidth = percentValue(v)
    this.markDirty()
  }
  setMinHeight(v: number | string | undefined): void {
    this.style.minHeight = parseDimension(v)
    this.markDirty()
  }
  setMinHeightPercent(v: number): void {
    this.style.minHeight = percentValue(v)
    this.markDirty()
  }
  setMaxWidth(v: number | string | undefined): void {
    this.style.maxWidth = parseDimension(v)
    this.markDirty()
  }
  setMaxWidthPercent(v: number): void {
    this.style.maxWidth = percentValue(v)
    this.markDirty()
  }
  setMaxHeight(v: number | string | undefined): void {
    this.style.maxHeight = parseDimension(v)
    this.markDirty()
  }
  setMaxHeightPercent(v: number): void {
    this.style.maxHeight = percentValue(v)
    this.markDirty()
  }

  // -- 样式 setter：flex

  setFlexDirection(dir: FlexDirection): void {
    this.style.flexDirection = dir
    this.markDirty()
  }
  setFlexGrow(v: number | undefined): void {
    this.style.flexGrow = v ?? 0
    this.markDirty()
  }
  setFlexShrink(v: number | undefined): void {
    this.style.flexShrink = v ?? 0
    this.markDirty()
  }
  setFlex(v: number | undefined): void {
    if (v === undefined || Number.isNaN(v)) {
      this.style.flexGrow = 0
      this.style.flexShrink = 0
    } else if (v > 0) {
      this.style.flexGrow = v
      this.style.flexShrink = 1
      this.style.flexBasis = pointValue(0)
    } else if (v < 0) {
      this.style.flexGrow = 0
      this.style.flexShrink = -v
    } else {
      this.style.flexGrow = 0
      this.style.flexShrink = 0
    }
    this.markDirty()
  }
  setFlexBasis(v: number | 'auto' | string | undefined): void {
    this.style.flexBasis = parseDimension(v)
    this.markDirty()
  }
  setFlexBasisPercent(v: number): void {
    this.style.flexBasis = percentValue(v)
    this.markDirty()
  }
  setFlexBasisAuto(): void {
    this.style.flexBasis = AUTO_VALUE
    this.markDirty()
  }
  setFlexWrap(wrap: Wrap): void {
    this.style.flexWrap = wrap
    this.markDirty()
  }

  // -- 样式 setter：alignment

  setAlignItems(a: Align): void {
    this.style.alignItems = a
    this.markDirty()
  }
  setAlignSelf(a: Align): void {
    this.style.alignSelf = a
    this.markDirty()
  }
  setAlignContent(a: Align): void {
    this.style.alignContent = a
    this.markDirty()
  }
  setJustifyContent(j: Justify): void {
    this.style.justifyContent = j
    this.markDirty()
  }

  // -- 样式 setter：display / position / overflow

  setDisplay(d: Display): void {
    this.style.display = d
    this.markDirty()
  }
  getDisplay(): Display {
    return this.style.display
  }
  setPositionType(t: PositionType): void {
    this.style.positionType = t
    this.markDirty()
  }
  setPosition(edge: Edge, v: number | string | undefined): void {
    this.style.position[edge] = parseDimension(v)
    this._hasPosition = hasAnyDefinedEdge(this.style.position)
    this.markDirty()
  }
  setPositionPercent(edge: Edge, v: number): void {
    this.style.position[edge] = percentValue(v)
    this._hasPosition = true
    this.markDirty()
  }
  setPositionAuto(edge: Edge): void {
    this.style.position[edge] = AUTO_VALUE
    this._hasPosition = true
    this.markDirty()
  }
  setOverflow(o: Overflow): void {
    this.style.overflow = o
    this.markDirty()
  }
  setDirection(d: Direction): void {
    this.style.direction = d
    this.markDirty()
  }
  setBoxSizing(_: BoxSizing): void {
    // 未实现：Ink 不使用 content-box
  }

  // -- 样式 setter：spacing

  setMargin(edge: Edge, v: number | 'auto' | string | undefined): void {
    const val = parseDimension(v)
    this.style.margin[edge] = val
    if (val.unit === Unit.Auto) {
      this._hasAutoMargin = true
    } else {
      this._hasAutoMargin = hasAnyAutoEdge(this.style.margin)
    }
    this._hasMargin = this._hasAutoMargin || hasAnyDefinedEdge(this.style.margin)
    this.markDirty()
  }
  setMarginPercent(edge: Edge, v: number): void {
    this.style.margin[edge] = percentValue(v)
    this._hasAutoMargin = hasAnyAutoEdge(this.style.margin)
    this._hasMargin = true
    this.markDirty()
  }
  setMarginAuto(edge: Edge): void {
    this.style.margin[edge] = AUTO_VALUE
    this._hasAutoMargin = true
    this._hasMargin = true
    this.markDirty()
  }
  setPadding(edge: Edge, v: number | string | undefined): void {
    this.style.padding[edge] = parseDimension(v)
    this._hasPadding = hasAnyDefinedEdge(this.style.padding)
    this.markDirty()
  }
  setPaddingPercent(edge: Edge, v: number): void {
    this.style.padding[edge] = percentValue(v)
    this._hasPadding = true
    this.markDirty()
  }
  setBorder(edge: Edge, v: number | undefined): void {
    this.style.border[edge] = v === undefined ? UNDEFINED_VALUE : pointValue(v)
    this._hasBorder = hasAnyDefinedEdge(this.style.border)
    this.markDirty()
  }
  setGap(gutter: Gutter, v: number | string | undefined): void {
    this.style.gap[gutter] = parseDimension(v)
    this.markDirty()
  }
  setGapPercent(gutter: Gutter, v: number): void {
    this.style.gap[gutter] = percentValue(v)
    this.markDirty()
  }

  // -- 样式 getter（部分实现，仅覆盖测试所需）

  getFlexDirection(): FlexDirection {
    return this.style.flexDirection
  }
  getJustifyContent(): Justify {
    return this.style.justifyContent
  }
  getAlignItems(): Align {
    return this.style.alignItems
  }
  getAlignSelf(): Align {
    return this.style.alignSelf
  }
  getAlignContent(): Align {
    return this.style.alignContent
  }
  getFlexGrow(): number {
    return this.style.flexGrow
  }
  getFlexShrink(): number {
    return this.style.flexShrink
  }
  getFlexBasis(): Value {
    return this.style.flexBasis
  }
  getFlexWrap(): Wrap {
    return this.style.flexWrap
  }
  getWidth(): Value {
    return this.style.width
  }
  getHeight(): Value {
    return this.style.height
  }
  getOverflow(): Overflow {
    return this.style.overflow
  }
  getPositionType(): PositionType {
    return this.style.positionType
  }
  getDirection(): Direction {
    return this.style.direction
  }

  // -- 未使用的 API 桩（为保持 API 兼容性而存在）

  copyStyle(_: Node): void {}
  setDirtiedFunc(_: unknown): void {}
  unsetDirtiedFunc(): void {}
  setIsReferenceBaseline(v: boolean): void {
    this.isReferenceBaseline_ = v
    this.markDirty()
  }
  isReferenceBaseline(): boolean {
    return this.isReferenceBaseline_
  }
  setAspectRatio(_: number | undefined): void {}
  getAspectRatio(): number {
    return NaN
  }
  setAlwaysFormsContainingBlock(_: boolean): void {}

  // -- 布局入口

  calculateLayout(
    ownerWidth: number | undefined,
    ownerHeight: number | undefined,
    _direction?: Direction,
  ): void {
    _yogaNodesVisited = 0
    _yogaMeasureCalls = 0
    _yogaCacheHits = 0
    _generation++
    const w = ownerWidth === undefined ? NaN : ownerWidth
    const h = ownerHeight === undefined ? NaN : ownerHeight
    layoutNode(
      this,
      w,
      h,
      isDefined(w) ? MeasureMode.Exactly : MeasureMode.Undefined,
      isDefined(h) ? MeasureMode.Exactly : MeasureMode.Undefined,
      w,
      h,
      true,
    )
    // 根节点自身位置 = margin + position insets（即使没有父容器，yoga 也会
    // 对根节点应用 position；这一点对取整很重要，因为根节点的绝对 top/left
    // 是像素网格遍历的起点）。
    const mar = this.layout.margin
    const posL = resolveValue(resolveEdgeRaw(this.style.position, EDGE_LEFT), isDefined(w) ? w : 0)
    const posT = resolveValue(resolveEdgeRaw(this.style.position, EDGE_TOP), isDefined(w) ? w : 0)
    this.layout.left = mar[EDGE_LEFT] + (isDefined(posL) ? posL : 0)
    this.layout.top = mar[EDGE_TOP] + (isDefined(posT) ? posT : 0)
    roundLayout(this, this.config.pointScaleFactor, 0, 0)
  }
}

let DEFAULT_CONFIG
DEFAULT_CONFIG = createConfig()

const CACHE_SLOTS = 4
function cacheWrite(
  node: Node,
  aW: number,
  aH: number,
  wM: MeasureMode,
  hM: MeasureMode,
  oW: number,
  oH: number,
  fW: boolean,
  fH: boolean,
  wasDirty: boolean,
): void {
  if (!node._cIn) {
    node._cIn = new Float64Array(CACHE_SLOTS * 8)
    node._cOut = new Float64Array(CACHE_SLOTS * 2)
  }
  // 脏化后的首次写入会清掉脏化之前的过期条目。
  // _cGen < _generation 表示条目来自上一轮 calculateLayout；
  // 若 wasDirty，则子树自那时起已发生变化 → 旧尺寸失效。
  // 干净节点的旧条目则会保留 —— 同一子树 + 相同输入 → 相同结果，
  // 所以跨代缓存仍然有效（这正是滚动热路径：499 条干净消息全部命中缓存，
  // 仅有 1 个脏叶节点需要重新计算）。
  if (wasDirty && node._cGen !== _generation) {
    node._cN = 0
    node._cWr = 0
  }
  // LRU 写索引会回绕；_cN 保持在 CACHE_SLOTS，使得读取扫描始终会检查所有
  // 已填充的槽位（而不只是回绕之后写入的那些）。
  const i = node._cWr++ % CACHE_SLOTS
  if (node._cN < CACHE_SLOTS) {
    node._cN = node._cWr
  }
  const o = i * 8
  const cIn = node._cIn
  cIn[o] = aW
  cIn[o + 1] = aH
  cIn[o + 2] = wM
  cIn[o + 3] = hM
  cIn[o + 4] = oW
  cIn[o + 5] = oH
  cIn[o + 6] = fW ? 1 : 0
  cIn[o + 7] = fH ? 1 : 0
  node._cOut![i * 2] = node.layout.width
  node._cOut![i * 2 + 1] = node.layout.height
  node._cGen = _generation
}

// 将计算得到的 layout.width/height 写入单槽缓存的输出字段。
// _hasL/_hasM 输入是在 layoutNode 顶部（计算之前）提交的；
// 输出则必须在此处（计算之后）提交，这样缓存命中时才能还原出正确的尺寸。
// 否则 _hasL 命中会返回上一次调用残留的 layout.width/height ——
// 那可能是 heightMode=Undefined 测量 pass 得到的内在内容高度，
// 而不是布局 pass 中受约束的视口高度。这就是 scrollbox
// vpH=33→2624 bug 的成因：scrollTop 被截断到 0，视口变成空白。
function commitCacheOutputs(node: Node, performLayout: boolean): void {
  if (performLayout) {
    node._lOutW = node.layout.width
    node._lOutH = node.layout.height
  } else {
    node._mOutW = node.layout.width
    node._mOutH = node.layout.height
  }
}

// --
// 核心 flexbox 算法

// 性能计数器：每次 calculateLayout 时重置，通过 getYogaCounters 读取。
// 每次调用 calculateLayout() 时自增。节点在写入缓存时会盖上 _fbGen/_cGen 戳；
// 当缓存条目的 gen === _generation 时，说明它是本轮 pass 计算出来的，
// 不论 isDirty_ 状态如何都视为新鲜。
let _generation = 0
let _yogaNodesVisited = 0
let _yogaMeasureCalls = 0
let _yogaCacheHits = 0
let _yogaLiveNodes = 0
export function getYogaCounters(): {
  visited: number
  measured: number
  cacheHits: number
  live: number
} {
  return {
    visited: _yogaNodesVisited,
    measured: _yogaMeasureCalls,
    cacheHits: _yogaCacheHits,
    live: _yogaLiveNodes,
  }
}

function layoutNode(
  node: Node,
  availableWidth: number,
  availableHeight: number,
  widthMode: MeasureMode,
  heightMode: MeasureMode,
  ownerWidth: number,
  ownerHeight: number,
  performLayout: boolean,
  // 为 true 时忽略该轴上的样式尺寸 —— flex 容器已经确定了主轴尺寸
  //（flex-basis + grow/shrink 的结果）。
  forceWidth = false,
  forceHeight = false,
): void {
  _yogaNodesVisited++
  const style = node.style
  const layout = node.layout

  // 脏标志跳过：干净子树 + 匹配的输入 → layout 对象中已经持有答案。
  // 缓存的布局结果也能满足测量请求（位置信息是尺寸信息的超集）；反之则不行。
  // 同代条目无论 isDirty_ 状态如何都是新鲜的 —— 它们就是本轮 calculateLayout
  // 计算出来的，子树之后未发生变化。
  // 跨代条目则需要 !isDirty_（脏节点在脏化之前的缓存已经过期）。
  // sameGen 旁路仅用于 MEASURE 调用 —— 在布局 pass 上跳过会绕开子节点定位
  // 的递归（STEP 5），导致子节点停留在过期位置。测量调用只需要 w/h，
  // 而这正是缓存中保存的内容。
  const sameGen = node._cGen === _generation && !performLayout
  if (!node.isDirty_ || sameGen) {
    if (
      !node.isDirty_ &&
      node._hasL &&
      node._lWM === widthMode &&
      node._lHM === heightMode &&
      node._lFW === forceWidth &&
      node._lFH === forceHeight &&
      sameFloat(node._lW, availableWidth) &&
      sameFloat(node._lH, availableHeight) &&
      sameFloat(node._lOW, ownerWidth) &&
      sameFloat(node._lOH, ownerHeight)
    ) {
      _yogaCacheHits++
      layout.width = node._lOutW
      layout.height = node._lOutH
      return
    }
    // 多槽缓存：扫描匹配的输入，命中时还原缓存的 w/h。
    // 覆盖如下场景：脏祖先的 measure→layout 级联会让每个干净子节点产生 N>1 种
    // 不同的输入组合 —— 单一 _hasL 槽不停地被覆盖，迫使整棵子树重新递归。
    // 在 500 条消息的 scrollbox + 1 个脏叶节点的场景下，脏叶重布局从
    // 76k 次 layoutNode 调用（21.7×节点数）降到 4k 次（1.2×节点数），
    // 6.86ms → 550µs。
    // 同代检查覆盖虚拟滚动中新挂载的（脏）节点 —— 脏链路会调用它们
    // ≥2^depth 次，首次写缓存，其余命中：1593 节点的树 105k 访问 → 约 10k。
    if (node._cN > 0 && (sameGen || !node.isDirty_)) {
      const cIn = node._cIn!
      for (let i = 0; i < node._cN; i++) {
        const o = i * 8
        if (
          cIn[o + 2] === widthMode &&
          cIn[o + 3] === heightMode &&
          cIn[o + 6] === (forceWidth ? 1 : 0) &&
          cIn[o + 7] === (forceHeight ? 1 : 0) &&
          sameFloat(cIn[o]!, availableWidth) &&
          sameFloat(cIn[o + 1]!, availableHeight) &&
          sameFloat(cIn[o + 4]!, ownerWidth) &&
          sameFloat(cIn[o + 5]!, ownerHeight)
        ) {
          layout.width = node._cOut![i * 2]!
          layout.height = node._cOut![i * 2 + 1]!
          _yogaCacheHits++
          return
        }
      }
    }
    if (
      !node.isDirty_ &&
      !performLayout &&
      node._hasM &&
      node._mWM === widthMode &&
      node._mHM === heightMode &&
      sameFloat(node._mW, availableWidth) &&
      sameFloat(node._mH, availableHeight) &&
      sameFloat(node._mOW, ownerWidth) &&
      sameFloat(node._mOH, ownerHeight)
    ) {
      layout.width = node._mOutW
      layout.height = node._mOutH
      _yogaCacheHits++
      return
    }
  }
  // 提前提交缓存输入，使得每条返回路径都留下有效条目。
  // 仅在布局 pass 上清掉 isDirty_ —— 测量 pass（computeFlexBasis →
  // layoutNode(performLayout=false)）会在同一次 calculateLayout 调用中先于布局
  // pass 运行。如果在测量期间清掉 dirty，后续布局 pass 会命中上一轮
  // calculateLayout（子节点插入之前）留下的过期 _hasL 缓存，
  // 使得 ScrollBox 内容高度永远不增长、sticky-scroll 永远跟不上新内容。
  // 脏节点的 _hasL 条目按定义就是过期的 —— 必须将它失效，让布局 pass 重新计算。
  const wasDirty = node.isDirty_
  if (performLayout) {
    node._lW = availableWidth
    node._lH = availableHeight
    node._lWM = widthMode
    node._lHM = heightMode
    node._lOW = ownerWidth
    node._lOH = ownerHeight
    node._lFW = forceWidth
    node._lFH = forceHeight
    node._hasL = true
    node.isDirty_ = false
    // 早期做法是在此处清掉 _cN，防止脏化之前的过期条目命中（长时间持续黑屏 bug）。
    // 现已改用「代戳」方案：缓存检查要求 sameGen || !isDirty_，
    // 因此脏节点的跨代条目无法命中。若仍在此处清空，会顺带清掉前一次
    // 测量调用刚写入的同代新鲜条目，导致布局调用又得重算一遍。
    if (wasDirty) {
      node._hasM = false
    }
  } else {
    node._mW = availableWidth
    node._mH = availableHeight
    node._mWM = widthMode
    node._mHM = heightMode
    node._mOW = ownerWidth
    node._mOH = ownerHeight
    node._hasM = true
    // 不清空 isDirty_。对脏节点，要将 _hasL 失效，使后续 performLayout=true 的
    // 调用基于新的子节点集合重新计算（否则 sticky-scroll 永远跟不上新内容 ——
    // 即提交 4557bc9f9c 修复的 bug）。
    // 干净节点则保留 _hasL：它们上一代的布局结果仍然有效，之所以走到这里，
    // 只是因为某个祖先变脏并以与缓存不同的输入再次调用。
    if (wasDirty) {
      node._hasL = false
    }
  }

  // 用 ownerWidth 解析 padding/border/margin（yoga 用 ownerWidth 解析百分比）。
  // 直接写入预分配的 layout 数组 —— 避免每次 layoutNode 调用 3 次分配和 12 次
  // resolveEdge 调用（CPU 火焰图中曾经的头号热点）。
  // 当没有任何 edge 被设置时整体跳过 —— 写 4 个零比 resolveEdges4Into
  // 产生 0 时所做的约 20 次读取 + 15 次比较要便宜。
  const pad = layout.padding
  const bor = layout.border
  const mar = layout.margin
  if (node._hasPadding) {
    resolveEdges4Into(style.padding, ownerWidth, pad)
  } else {
    pad[0] = pad[1] = pad[2] = pad[3] = 0
  }
  if (node._hasBorder) {
    resolveEdges4Into(style.border, ownerWidth, bor)
  } else {
    bor[0] = bor[1] = bor[2] = bor[3] = 0
  }
  if (node._hasMargin) {
    resolveEdges4Into(style.margin, ownerWidth, mar)
  } else {
    mar[0] = mar[1] = mar[2] = mar[3] = 0
  }

  const paddingBorderWidth = pad[0] + pad[2] + bor[0] + bor[2]
  const paddingBorderHeight = pad[1] + pad[3] + bor[1] + bor[3]

  // 解析样式尺寸
  const styleWidth = forceWidth ? NaN : resolveValue(style.width, ownerWidth)
  const styleHeight = forceHeight ? NaN : resolveValue(style.height, ownerHeight)

  // 若样式尺寸已定义，则覆盖可用尺寸
  let width = availableWidth
  let height = availableHeight
  let wMode = widthMode
  let hMode = heightMode
  if (isDefined(styleWidth)) {
    width = styleWidth
    wMode = MeasureMode.Exactly
  }
  if (isDefined(styleHeight)) {
    height = styleHeight
    hMode = MeasureMode.Exactly
  }

  // 对节点自身尺寸应用 min/max 约束
  width = boundAxis(style, true, width, ownerWidth, ownerHeight)
  height = boundAxis(style, false, height, ownerWidth, ownerHeight)

  // 带 measure-func 的叶节点
  if (node.measureFunc && node.children.length === 0) {
    const innerW = wMode === MeasureMode.Undefined ? NaN : Math.max(0, width - paddingBorderWidth)
    const innerH = hMode === MeasureMode.Undefined ? NaN : Math.max(0, height - paddingBorderHeight)
    _yogaMeasureCalls++
    const measured = node.measureFunc(innerW, wMode, innerH, hMode)
    node.layout.width =
      wMode === MeasureMode.Exactly
        ? width
        : boundAxis(
            style,
            true,
            (measured.width ?? 0) + paddingBorderWidth,
            ownerWidth,
            ownerHeight,
          )
    node.layout.height =
      hMode === MeasureMode.Exactly
        ? height
        : boundAxis(
            style,
            false,
            (measured.height ?? 0) + paddingBorderHeight,
            ownerWidth,
            ownerHeight,
          )
    commitCacheOutputs(node, performLayout)
    // 即使是脏节点也写入缓存 —— 虚拟滚动中新挂载的项目在首次布局时是脏的，
    // 但脏链路的 measure→layout 级联会在每次 calculateLayout 中调用它们
    // ≥2^depth 次。在此写入可以让第 2 次及之后的调用命中缓存（isDirty_
    // 已经在上面的布局 pass 中被清掉）。实测：1593 节点新挂载树
    // 105k 访问 → 10k。
    cacheWrite(
      node,
      availableWidth,
      availableHeight,
      widthMode,
      heightMode,
      ownerWidth,
      ownerHeight,
      forceWidth,
      forceHeight,
      wasDirty,
    )
    return
  }

  // 既无子节点也无 measure-func 的叶节点
  if (node.children.length === 0) {
    node.layout.width =
      wMode === MeasureMode.Exactly
        ? width
        : boundAxis(style, true, paddingBorderWidth, ownerWidth, ownerHeight)
    node.layout.height =
      hMode === MeasureMode.Exactly
        ? height
        : boundAxis(style, false, paddingBorderHeight, ownerWidth, ownerHeight)
    commitCacheOutputs(node, performLayout)
    // 即使是脏节点也写入缓存 —— 虚拟滚动中新挂载的项目在首次布局时是脏的，
    // 但脏链路的 measure→layout 级联会在每次 calculateLayout 中调用它们
    // ≥2^depth 次。在此写入可以让第 2 次及之后的调用命中缓存（isDirty_
    // 已经在上面的布局 pass 中被清掉）。实测：1593 节点新挂载树
    // 105k 访问 → 10k。
    cacheWrite(
      node,
      availableWidth,
      availableHeight,
      widthMode,
      heightMode,
      ownerWidth,
      ownerHeight,
      forceWidth,
      forceHeight,
      wasDirty,
    )
    return
  }

  // 带子节点的容器：运行 flexbox 算法
  const mainAxis = style.flexDirection
  const crossAx = crossAxis(mainAxis)
  const isMainRow = isRow(mainAxis)

  const mainSize = isMainRow ? width : height
  const crossSize = isMainRow ? height : width
  const mainMode = isMainRow ? wMode : hMode
  const crossMode = isMainRow ? hMode : wMode
  const mainPadBorder = isMainRow ? paddingBorderWidth : paddingBorderHeight
  const crossPadBorder = isMainRow ? paddingBorderHeight : paddingBorderWidth

  const innerMainSize = isDefined(mainSize) ? Math.max(0, mainSize - mainPadBorder) : NaN
  const innerCrossSize = isDefined(crossSize) ? Math.max(0, crossSize - crossPadBorder) : NaN

  // 解析 gap
  const gapMain = resolveGap(style, isMainRow ? Gutter.Column : Gutter.Row, innerMainSize)

  // 将子节点分为 flow 与 absolute 两类。display:contents 节点是透明的 ——
  // 它们的子节点会被上提到祖父节点的子列表中（递归进行），
  // 而 contents 节点自身则得到零布局。
  const flowChildren: Node[] = []
  const absChildren: Node[] = []
  collectLayoutChildren(node, flowChildren, absChildren)

  // ownerW/H 是用于解析子节点百分比值的参考尺寸。
  // 按 CSS 规范，% width 相对父节点的 content-box 宽度解析。
  // 若本节点宽度不确定，子节点的 % 宽度也是不确定的 ——
  // 不要回退到祖父节点的尺寸。
  const ownerW = isDefined(width) ? width : NaN
  const ownerH = isDefined(height) ? height : NaN
  const isWrap = style.flexWrap !== Wrap.NoWrap
  const gapCross = resolveGap(style, isMainRow ? Gutter.Row : Gutter.Column, innerCrossSize)

  // STEP 1：为每个 flow 子节点计算 flex-basis 并切分成行。
  // 单行（NoWrap）容器始终只有一行；多行容器在累计 basis+margin+gap
  // 超过 innerMainSize 时另起一行。
  for (const c of flowChildren) {
    c._flexBasis = computeFlexBasis(
      c,
      mainAxis,
      innerMainSize,
      innerCrossSize,
      crossMode,
      ownerW,
      ownerH,
    )
  }
  const lines: Node[][] = []
  if (!isWrap || !isDefined(innerMainSize) || flowChildren.length === 0) {
    for (const c of flowChildren) {
      c._lineIndex = 0
    }
    lines.push(flowChildren)
  } else {
    // 换行判定使用经 min/max 截断后的 basis（flexbox 规范 §9.3.5:
    // "hypothetical main size"），而不是原始的 flex-basis。
    let lineStart = 0
    let lineLen = 0
    for (let i = 0; i < flowChildren.length; i++) {
      const c = flowChildren[i]!
      const hypo = boundAxis(c.style, isMainRow, c._flexBasis, ownerW, ownerH)
      const outer = Math.max(0, hypo) + childMarginForAxis(c, mainAxis, ownerW)
      const withGap = i > lineStart ? gapMain : 0
      if (i > lineStart && lineLen + withGap + outer > innerMainSize) {
        lines.push(flowChildren.slice(lineStart, i))
        lineStart = i
        lineLen = outer
      } else {
        lineLen += withGap + outer
      }
      c._lineIndex = lines.length
    }
    lines.push(flowChildren.slice(lineStart))
  }
  const lineCount = lines.length
  const isBaseline = isBaselineLayout(node, flowChildren)

  // STEP 2+3：对每一行，解析弹性长度并布局子节点以测量交叉轴尺寸。
  // 跟踪每行消耗的主轴长度与最大交叉轴尺寸。
  const lineConsumedMain: number[] = new Array(lineCount)
  const lineCrossSizes: number[] = new Array(lineCount)
  // 基线布局会按行跟踪 maxAscent（baseline + 前导 margin），
  // 使基线对齐的项目可以被定位到 maxAscent - childBaseline。
  const lineMaxAscent: number[] = isBaseline ? new Array(lineCount).fill(0) : []
  let maxLineMain = 0
  let totalLinesCross = 0
  for (let li = 0; li < lineCount; li++) {
    const line = lines[li]!
    const lineGap = line.length > 1 ? gapMain * (line.length - 1) : 0
    let lineBasis = lineGap
    for (const c of line) {
      lineBasis += c._flexBasis + childMarginForAxis(c, mainAxis, ownerW)
    }
    // 用可用的内部主轴尺寸解析弹性长度。对于不确定且带 min/max 的容器，
    // 则按截断后的尺寸进行 flex 计算。
    let availMain = innerMainSize
    if (!isDefined(availMain)) {
      const mainOwner = isMainRow ? ownerWidth : ownerHeight
      const minM = resolveValue(isMainRow ? style.minWidth : style.minHeight, mainOwner)
      const maxM = resolveValue(isMainRow ? style.maxWidth : style.maxHeight, mainOwner)
      if (isDefined(maxM) && lineBasis > maxM - mainPadBorder) {
        availMain = Math.max(0, maxM - mainPadBorder)
      } else if (isDefined(minM) && lineBasis < minM - mainPadBorder) {
        availMain = Math.max(0, minM - mainPadBorder)
      }
    }
    resolveFlexibleLengths(line, availMain, lineBasis, isMainRow, ownerW, ownerH)

    // 对本行每个子节点进行布局以测量交叉轴
    let lineCross = 0
    for (const c of line) {
      const cStyle = c.style
      const childAlign = cStyle.alignSelf === Align.Auto ? style.alignItems : cStyle.alignSelf
      const cMarginCross = childMarginForAxis(c, crossAx, ownerW)
      let childCrossSize = NaN
      let childCrossMode: MeasureMode = MeasureMode.Undefined
      const resolvedCrossStyle = resolveValue(
        isMainRow ? cStyle.height : cStyle.width,
        isMainRow ? ownerH : ownerW,
      )
      const crossLeadE = isMainRow ? EDGE_TOP : EDGE_LEFT
      const crossTrailE = isMainRow ? EDGE_BOTTOM : EDGE_RIGHT
      const hasCrossAutoMargin =
        c._hasAutoMargin &&
        (isMarginAuto(cStyle.margin, crossLeadE) || isMarginAuto(cStyle.margin, crossTrailE))
      // 单行 stretch 直接拉伸到容器的交叉轴尺寸。
      // 多行 wrap 则以 Undefined 模式测量内在交叉轴尺寸，
      // 这样 flex-grow 的孙节点不会扩张到整个容器 ——
      // 先确定行的交叉轴尺寸，再对项目重新进行 stretch。
      if (isDefined(resolvedCrossStyle)) {
        childCrossSize = resolvedCrossStyle
        childCrossMode = MeasureMode.Exactly
      } else if (
        childAlign === Align.Stretch &&
        !hasCrossAutoMargin &&
        !isWrap &&
        isDefined(innerCrossSize) &&
        crossMode === MeasureMode.Exactly
      ) {
        childCrossSize = Math.max(0, innerCrossSize - cMarginCross)
        childCrossMode = MeasureMode.Exactly
      } else if (!isWrap && isDefined(innerCrossSize)) {
        childCrossSize = Math.max(0, innerCrossSize - cMarginCross)
        childCrossMode = MeasureMode.AtMost
      }
      const cw = isMainRow ? c._mainSize : childCrossSize
      const ch = isMainRow ? childCrossSize : c._mainSize
      layoutNode(
        c,
        cw,
        ch,
        isMainRow ? MeasureMode.Exactly : childCrossMode,
        isMainRow ? childCrossMode : MeasureMode.Exactly,
        ownerW,
        ownerH,
        performLayout,
        isMainRow,
        !isMainRow,
      )
      c._crossSize = isMainRow ? c.layout.height : c.layout.width
      lineCross = Math.max(lineCross, c._crossSize + cMarginCross)
    }
    // 基线布局：行的交叉轴尺寸必须能容纳基线对齐子节点的 maxAscent + maxDescent
    //（yoga STEP 8）。仅在 row 方向适用。
    if (isBaseline) {
      let maxAscent = 0
      let maxDescent = 0
      for (const c of line) {
        if (resolveChildAlign(node, c) !== Align.Baseline) {
          continue
        }
        const mTop = resolveEdge(c.style.margin, EDGE_TOP, ownerW)
        const mBot = resolveEdge(c.style.margin, EDGE_BOTTOM, ownerW)
        const ascent = calculateBaseline(c) + mTop
        const descent = c.layout.height + mTop + mBot - ascent
        if (ascent > maxAscent) {
          maxAscent = ascent
        }
        if (descent > maxDescent) {
          maxDescent = descent
        }
      }
      lineMaxAscent[li] = maxAscent
      if (maxAscent + maxDescent > lineCross) {
        lineCross = maxAscent + maxDescent
      }
    }
    // 上方 ~1117 行的 layoutNode(c) 已经用相同的 ownerW 通过 resolveEdges4Into
    // 解析了 c.layout.margin[] —— 直接读取，避免再走 childMarginForAxis →
    // 2× resolveEdge 重新解析。
    const mainLead = leadingEdge(mainAxis)
    const mainTrail = trailingEdge(mainAxis)
    let consumed = lineGap
    for (const c of line) {
      const cm = c.layout.margin
      consumed += c._mainSize + cm[mainLead]! + cm[mainTrail]!
    }
    lineConsumedMain[li] = consumed
    lineCrossSizes[li] = lineCross
    maxLineMain = Math.max(maxLineMain, consumed)
    totalLinesCross += lineCross
  }
  const totalCrossGap = lineCount > 1 ? gapCross * (lineCount - 1) : 0
  totalLinesCross += totalCrossGap

  // STEP 4：确定容器尺寸。按 yoga 的 STEP 9，对 AtMost（FitContent）和
  // Undefined（MaxContent）两种模式，节点都按内容自适应大小 ——
  // AtMost 不是硬截断，项目可能溢出可用空间（CSS "fit-content" 行为）。
  // 只有 Scroll 类型的 overflow 才会截断到可用尺寸。
  // 在 AtMost 下断成多行的 wrap 容器会填满可用主轴尺寸，
  // 因为它们就是在那个边界处换行的。
  const isScroll = style.overflow === Overflow.Scroll
  const contentMain = maxLineMain + mainPadBorder
  const finalMainSize =
    mainMode === MeasureMode.Exactly
      ? mainSize
      : mainMode === MeasureMode.AtMost && isScroll
        ? Math.max(Math.min(mainSize, contentMain), mainPadBorder)
        : isWrap && lineCount > 1 && mainMode === MeasureMode.AtMost
          ? mainSize
          : contentMain
  const contentCross = totalLinesCross + crossPadBorder
  const finalCrossSize =
    crossMode === MeasureMode.Exactly
      ? crossSize
      : crossMode === MeasureMode.AtMost && isScroll
        ? Math.max(Math.min(crossSize, contentCross), crossPadBorder)
        : contentCross
  node.layout.width = boundAxis(
    style,
    true,
    isMainRow ? finalMainSize : finalCrossSize,
    ownerWidth,
    ownerHeight,
  )
  node.layout.height = boundAxis(
    style,
    false,
    isMainRow ? finalCrossSize : finalMainSize,
    ownerWidth,
    ownerHeight,
  )
  commitCacheOutputs(node, performLayout)
  // 即使是脏节点也写入缓存 —— 虚拟滚动中新挂载的项目
  cacheWrite(
    node,
    availableWidth,
    availableHeight,
    widthMode,
    heightMode,
    ownerWidth,
    ownerHeight,
    forceWidth,
    forceHeight,
    wasDirty,
  )

  if (!performLayout) {
    return
  }

  // STEP 5：定位行（align-content）和子节点（justify-content +
  // align-items + auto margins）。
  const actualInnerMain = (isMainRow ? node.layout.width : node.layout.height) - mainPadBorder
  const actualInnerCross = (isMainRow ? node.layout.height : node.layout.width) - crossPadBorder
  const mainLeadEdgePhys = leadingEdge(mainAxis)
  const mainTrailEdgePhys = trailingEdge(mainAxis)
  const crossLeadEdgePhys = isMainRow ? EDGE_TOP : EDGE_LEFT
  const crossTrailEdgePhys = isMainRow ? EDGE_BOTTOM : EDGE_RIGHT
  const reversed = isReverse(mainAxis)
  const mainContainerSize = isMainRow ? node.layout.width : node.layout.height
  const crossLead = pad[crossLeadEdgePhys]! + bor[crossLeadEdgePhys]!

  // Align-content：在各行间分配剩余的交叉轴空间。
  // 单行容器把全部交叉轴尺寸用于唯一的那一行（行内定位由 align-items 处理）。
  let lineCrossOffset = crossLead
  let betweenLines = gapCross
  const freeCross = actualInnerCross - totalLinesCross
  if (lineCount === 1 && !isWrap && !isBaseline) {
    lineCrossSizes[0] = actualInnerCross
  } else {
    const remCross = Math.max(0, freeCross)
    switch (style.alignContent) {
      case Align.FlexStart:
        break
      case Align.Center:
        lineCrossOffset += freeCross / 2
        break
      case Align.FlexEnd:
        lineCrossOffset += freeCross
        break
      case Align.Stretch:
        if (lineCount > 0 && remCross > 0) {
          const add = remCross / lineCount
          for (let i = 0; i < lineCount; i++) {
            lineCrossSizes[i]! += add
          }
        }
        break
      case Align.SpaceBetween:
        if (lineCount > 1) {
          betweenLines += remCross / (lineCount - 1)
        }
        break
      case Align.SpaceAround:
        if (lineCount > 0) {
          betweenLines += remCross / lineCount
          lineCrossOffset += remCross / lineCount / 2
        }
        break
      case Align.SpaceEvenly:
        if (lineCount > 0) {
          betweenLines += remCross / (lineCount + 1)
          lineCrossOffset += remCross / (lineCount + 1)
        }
        break
      default:
        break
    }
  }

  // 对 wrap-reverse，行从交叉轴的尾部边开始堆叠。
  // 仍按顺序遍历行，但在容器内翻转交叉轴位置。
  const wrapReverse = style.flexWrap === Wrap.WrapReverse
  const crossContainerSize = isMainRow ? node.layout.height : node.layout.width
  let lineCrossPos = lineCrossOffset
  for (let li = 0; li < lineCount; li++) {
    const line = lines[li]!
    const lineCross = lineCrossSizes[li]!
    const consumedMain = lineConsumedMain[li]!
    const n = line.length

    // 既然行的交叉轴尺寸已知，对那些交叉轴为 auto 且 align 为 stretch 的子节点
    // 重新拉伸。多行 wrap 需要这样做（初次测量时行交叉轴尺寸尚未知）；
    // 单行情况下当容器交叉轴非 Exactly 时也需要（~1250 行处的首次 stretch
    // 因 innerCrossSize 未定义而被跳过 —— 容器是按子节点交叉轴最大值定的尺寸）。
    if (isWrap || crossMode !== MeasureMode.Exactly) {
      for (const c of line) {
        const cStyle = c.style
        const childAlign = cStyle.alignSelf === Align.Auto ? style.alignItems : cStyle.alignSelf
        const crossStyleDef = isDefined(
          resolveValue(isMainRow ? cStyle.height : cStyle.width, isMainRow ? ownerH : ownerW),
        )
        const hasCrossAutoMargin =
          c._hasAutoMargin &&
          (isMarginAuto(cStyle.margin, crossLeadEdgePhys) ||
            isMarginAuto(cStyle.margin, crossTrailEdgePhys))
        if (childAlign === Align.Stretch && !crossStyleDef && !hasCrossAutoMargin) {
          const cMarginCross = childMarginForAxis(c, crossAx, ownerW)
          const target = Math.max(0, lineCross - cMarginCross)
          if (c._crossSize !== target) {
            const cw = isMainRow ? c._mainSize : target
            const ch = isMainRow ? target : c._mainSize
            layoutNode(
              c,
              cw,
              ch,
              MeasureMode.Exactly,
              MeasureMode.Exactly,
              ownerW,
              ownerH,
              performLayout,
              isMainRow,
              !isMainRow,
            )
            c._crossSize = target
          }
        }
      }
    }

    // 本行的 justify-content + auto margins
    let mainOffset = pad[mainLeadEdgePhys]! + bor[mainLeadEdgePhys]!
    let betweenMain = gapMain
    let numAutoMarginsMain = 0
    for (const c of line) {
      if (!c._hasAutoMargin) {
        continue
      }
      if (isMarginAuto(c.style.margin, mainLeadEdgePhys)) {
        numAutoMarginsMain++
      }
      if (isMarginAuto(c.style.margin, mainTrailEdgePhys)) {
        numAutoMarginsMain++
      }
    }
    const freeMain = actualInnerMain - consumedMain
    const remainingMain = Math.max(0, freeMain)
    const autoMarginMainSize =
      numAutoMarginsMain > 0 && remainingMain > 0 ? remainingMain / numAutoMarginsMain : 0
    if (numAutoMarginsMain === 0) {
      switch (style.justifyContent) {
        case Justify.FlexStart:
          break
        case Justify.Center:
          mainOffset += freeMain / 2
          break
        case Justify.FlexEnd:
          mainOffset += freeMain
          break
        case Justify.SpaceBetween:
          if (n > 1) {
            betweenMain += remainingMain / (n - 1)
          }
          break
        case Justify.SpaceAround:
          if (n > 0) {
            betweenMain += remainingMain / n
            mainOffset += remainingMain / n / 2
          }
          break
        case Justify.SpaceEvenly:
          if (n > 0) {
            betweenMain += remainingMain / (n + 1)
            mainOffset += remainingMain / (n + 1)
          }
          break
      }
    }

    const effectiveLineCrossPos = wrapReverse
      ? crossContainerSize - lineCrossPos - lineCross
      : lineCrossPos

    let pos = mainOffset
    for (const c of line) {
      const cMargin = c.style.margin
      // c.layout.margin[] 已由上方 layoutNode(c) 调用内部的 resolveEdges4Into
      // 用相同 ownerW 填好。直接读取已解析的值，无需再通过 resolveEdge
      // 走 4 次边回退链。
      // auto margin 在 layout.margin 中解析为 0，所以 autoMarginMainSize
      // 替换仍然以 style 上的 isMarginAuto 判断为准。
      const cLayoutMargin = c.layout.margin
      let autoMainLead = false
      let autoMainTrail = false
      let autoCrossLead = false
      let autoCrossTrail = false
      let mMainLead: number
      let mMainTrail: number
      let mCrossLead: number
      let mCrossTrail: number
      if (c._hasAutoMargin) {
        autoMainLead = isMarginAuto(cMargin, mainLeadEdgePhys)
        autoMainTrail = isMarginAuto(cMargin, mainTrailEdgePhys)
        autoCrossLead = isMarginAuto(cMargin, crossLeadEdgePhys)
        autoCrossTrail = isMarginAuto(cMargin, crossTrailEdgePhys)
        mMainLead = autoMainLead ? autoMarginMainSize : cLayoutMargin[mainLeadEdgePhys]!
        mMainTrail = autoMainTrail ? autoMarginMainSize : cLayoutMargin[mainTrailEdgePhys]!
        mCrossLead = autoCrossLead ? 0 : cLayoutMargin[crossLeadEdgePhys]!
        mCrossTrail = autoCrossTrail ? 0 : cLayoutMargin[crossTrailEdgePhys]!
      } else {
        // 快路径：无 auto margin —— 直接读取已解析的值。
        mMainLead = cLayoutMargin[mainLeadEdgePhys]!
        mMainTrail = cLayoutMargin[mainTrailEdgePhys]!
        mCrossLead = cLayoutMargin[crossLeadEdgePhys]!
        mCrossTrail = cLayoutMargin[crossTrailEdgePhys]!
      }

      const mainPos = reversed
        ? mainContainerSize - (pos + mMainLead) - c._mainSize
        : pos + mMainLead

      const childAlign = c.style.alignSelf === Align.Auto ? style.alignItems : c.style.alignSelf
      let crossPos = effectiveLineCrossPos + mCrossLead
      const crossFree = lineCross - c._crossSize - mCrossLead - mCrossTrail
      if (autoCrossLead && autoCrossTrail) {
        crossPos += Math.max(0, crossFree) / 2
      } else if (autoCrossLead) {
        crossPos += Math.max(0, crossFree)
      } else if (autoCrossTrail) {
        // 保持在前缘
      } else {
        switch (childAlign) {
          case Align.FlexStart:
          case Align.Stretch:
            if (wrapReverse) {
              crossPos += crossFree
            }
            break
          case Align.Center:
            crossPos += crossFree / 2
            break
          case Align.FlexEnd:
            if (!wrapReverse) {
              crossPos += crossFree
            }
            break
          case Align.Baseline:
            // 仅 row 方向（isBaselineLayout 已校验）。让子节点基线与行最大
            // ascent 对齐。按 yoga：top = currentLead + maxAscent -
            // childBaseline + leadingPosition。
            if (isBaseline) {
              crossPos = effectiveLineCrossPos + lineMaxAscent[li]! - calculateBaseline(c)
            }
            break
          default:
            break
        }
      }

      // 相对位置偏移。快路径：未设置 position insets → 跳过
      // 4× resolveEdgeRaw + 4× resolveValue + 4× isDefined。
      let relX = 0
      let relY = 0
      if (c._hasPosition) {
        const relLeft = resolveValue(resolveEdgeRaw(c.style.position, EDGE_LEFT), ownerW)
        const relRight = resolveValue(resolveEdgeRaw(c.style.position, EDGE_RIGHT), ownerW)
        const relTop = resolveValue(resolveEdgeRaw(c.style.position, EDGE_TOP), ownerW)
        const relBottom = resolveValue(resolveEdgeRaw(c.style.position, EDGE_BOTTOM), ownerW)
        relX = isDefined(relLeft) ? relLeft : isDefined(relRight) ? -relRight : 0
        relY = isDefined(relTop) ? relTop : isDefined(relBottom) ? -relBottom : 0
      }

      if (isMainRow) {
        c.layout.left = mainPos + relX
        c.layout.top = crossPos + relY
      } else {
        c.layout.left = crossPos + relX
        c.layout.top = mainPos + relY
      }
      pos += c._mainSize + mMainLead + mMainTrail + betweenMain
    }
    lineCrossPos += lineCross + betweenLines
  }

  // STEP 6：绝对定位子节点
  for (const c of absChildren) {
    layoutAbsoluteChild(node, c, node.layout.width, node.layout.height, pad, bor)
  }
}

function layoutAbsoluteChild(
  parent: Node,
  child: Node,
  parentWidth: number,
  parentHeight: number,
  pad: [number, number, number, number],
  bor: [number, number, number, number],
): void {
  const cs = child.style
  const posLeft = resolveEdgeRaw(cs.position, EDGE_LEFT)
  const posRight = resolveEdgeRaw(cs.position, EDGE_RIGHT)
  const posTop = resolveEdgeRaw(cs.position, EDGE_TOP)
  const posBottom = resolveEdgeRaw(cs.position, EDGE_BOTTOM)

  const rLeft = resolveValue(posLeft, parentWidth)
  const rRight = resolveValue(posRight, parentWidth)
  const rTop = resolveValue(posTop, parentHeight)
  const rBottom = resolveValue(posBottom, parentHeight)

  // 绝对定位子节点的百分比尺寸按 CSS §10.1 相对包含块的 padding-box
  //（父尺寸减去 border）解析。
  const paddingBoxW = parentWidth - bor[0] - bor[2]
  const paddingBoxH = parentHeight - bor[1] - bor[3]
  let cw = resolveValue(cs.width, paddingBoxW)
  let ch = resolveValue(cs.height, paddingBoxH)

  // 若同时定义 left+right 且未定义 width，则推导出 width
  if (!isDefined(cw) && isDefined(rLeft) && isDefined(rRight)) {
    cw = paddingBoxW - rLeft - rRight
  }
  if (!isDefined(ch) && isDefined(rTop) && isDefined(rBottom)) {
    ch = paddingBoxH - rTop - rBottom
  }

  layoutNode(
    child,
    cw,
    ch,
    isDefined(cw) ? MeasureMode.Exactly : MeasureMode.Undefined,
    isDefined(ch) ? MeasureMode.Exactly : MeasureMode.Undefined,
    paddingBoxW,
    paddingBoxH,
    true,
  )

  // 绝对定位子节点的 margin（在 insets 之外额外应用）
  const mL = resolveEdge(cs.margin, EDGE_LEFT, parentWidth)
  const mT = resolveEdge(cs.margin, EDGE_TOP, parentWidth)
  const mR = resolveEdge(cs.margin, EDGE_RIGHT, parentWidth)
  const mB = resolveEdge(cs.margin, EDGE_BOTTOM, parentWidth)

  const mainAxis = parent.style.flexDirection
  const reversed = isReverse(mainAxis)
  const mainRow = isRow(mainAxis)
  const wrapReverse = parent.style.flexWrap === Wrap.WrapReverse
  // 对绝对定位子节点，alignSelf 覆盖 alignItems（与 flow 项目相同）
  const alignment = cs.alignSelf === Align.Auto ? parent.style.alignItems : cs.alignSelf

  // 位置
  let left: number
  if (isDefined(rLeft)) {
    left = bor[0] + rLeft + mL
  } else if (isDefined(rRight)) {
    left = parentWidth - bor[2] - rRight - child.layout.width - mR
  } else if (mainRow) {
    // 主轴 —— justify-content，reverse 时翻转
    const lead = pad[0] + bor[0]
    const trail = parentWidth - pad[2] - bor[2]
    left = reversed
      ? trail - child.layout.width - mR
      : justifyAbsolute(parent.style.justifyContent, lead, trail, child.layout.width) + mL
  } else {
    left =
      alignAbsolute(
        alignment,
        pad[0] + bor[0],
        parentWidth - pad[2] - bor[2],
        child.layout.width,
        wrapReverse,
      ) + mL
  }

  let top: number
  if (isDefined(rTop)) {
    top = bor[1] + rTop + mT
  } else if (isDefined(rBottom)) {
    top = parentHeight - bor[3] - rBottom - child.layout.height - mB
  } else if (mainRow) {
    top =
      alignAbsolute(
        alignment,
        pad[1] + bor[1],
        parentHeight - pad[3] - bor[3],
        child.layout.height,
        wrapReverse,
      ) + mT
  } else {
    const lead = pad[1] + bor[1]
    const trail = parentHeight - pad[3] - bor[3]
    top = reversed
      ? trail - child.layout.height - mB
      : justifyAbsolute(parent.style.justifyContent, lead, trail, child.layout.height) + mT
  }

  child.layout.left = left
  child.layout.top = top
}

function justifyAbsolute(
  justify: Justify,
  leadEdge: number,
  trailEdge: number,
  childSize: number,
): number {
  switch (justify) {
    case Justify.Center:
      return leadEdge + (trailEdge - leadEdge - childSize) / 2
    case Justify.FlexEnd:
      return trailEdge - childSize
    default:
      return leadEdge
  }
}

function alignAbsolute(
  align: Align,
  leadEdge: number,
  trailEdge: number,
  childSize: number,
  wrapReverse: boolean,
): number {
  // wrap-reverse 翻转交叉轴：flex-start/stretch 移到尾缘，
  // flex-end 移到前缘（yoga 的 absoluteLayoutChild 在包含块为 wrap-reverse 时
  // 会翻转 align 取值）。
  switch (align) {
    case Align.Center:
      return leadEdge + (trailEdge - leadEdge - childSize) / 2
    case Align.FlexEnd:
      return wrapReverse ? leadEdge : trailEdge - childSize
    default:
      return wrapReverse ? trailEdge - childSize : leadEdge
  }
}

function computeFlexBasis(
  child: Node,
  mainAxis: FlexDirection,
  availableMain: number,
  availableCross: number,
  crossMode: MeasureMode,
  ownerWidth: number,
  ownerHeight: number,
): number {
  // 同代缓存命中：basis 是本轮 calculateLayout 计算的，
  // 所以无论 isDirty_ 状态如何都视为新鲜。这覆盖两类情况：干净子节点
  //（滚过未变化的消息），以及虚拟滚动中新挂载的脏子节点 —— 脏链路的
  // measure→layout 级联会调用本函数 ≥2^depth 次，但子节点的子树在同一次
  // calculateLayout 内的多次调用之间并不会变化）。
  // 对来自上一代缓存的干净子节点，若输入也匹配则同样命中 —— isDirty_
  // 起到门控作用，因为脏子节点的上代缓存已经过期。
  const sameGen = child._fbGen === _generation
  if (
    (sameGen || !child.isDirty_) &&
    child._fbCrossMode === crossMode &&
    sameFloat(child._fbOwnerW, ownerWidth) &&
    sameFloat(child._fbOwnerH, ownerHeight) &&
    sameFloat(child._fbAvailMain, availableMain) &&
    sameFloat(child._fbAvailCross, availableCross)
  ) {
    return child._fbBasis
  }
  const cs = child.style
  const isMainRow = isRow(mainAxis)

  // 显式 flex-basis
  const basis = resolveValue(cs.flexBasis, availableMain)
  if (isDefined(basis)) {
    const b = Math.max(0, basis)
    child._fbBasis = b
    child._fbOwnerW = ownerWidth
    child._fbOwnerH = ownerHeight
    child._fbAvailMain = availableMain
    child._fbAvailCross = availableCross
    child._fbCrossMode = crossMode
    child._fbGen = _generation
    return b
  }

  // 主轴上的样式尺寸
  const mainStyleDim = isMainRow ? cs.width : cs.height
  const mainOwner = isMainRow ? ownerWidth : ownerHeight
  const resolved = resolveValue(mainStyleDim, mainOwner)
  if (isDefined(resolved)) {
    const b = Math.max(0, resolved)
    child._fbBasis = b
    child._fbOwnerW = ownerWidth
    child._fbOwnerH = ownerHeight
    child._fbAvailMain = availableMain
    child._fbAvailCross = availableCross
    child._fbCrossMode = crossMode
    child._fbGen = _generation
    return b
  }

  // 需要测量子节点以获取它的自然尺寸
  const crossStyleDim = isMainRow ? cs.height : cs.width
  const crossOwner = isMainRow ? ownerHeight : ownerWidth
  let crossConstraint = resolveValue(crossStyleDim, crossOwner)
  let crossConstraintMode: MeasureMode = isDefined(crossConstraint)
    ? MeasureMode.Exactly
    : MeasureMode.Undefined
  if (!isDefined(crossConstraint) && isDefined(availableCross)) {
    crossConstraint = availableCross
    crossConstraintMode =
      crossMode === MeasureMode.Exactly && isStretchAlign(child)
        ? MeasureMode.Exactly
        : MeasureMode.AtMost
  }

  // 上游 yoga（YGNodeComputeFlexBasisForChild）在子树会调用 measure-func 时
  // 以 AtMost 模式传入可用内部宽度 —— 这样文本节点不会把不受约束的内在宽度
  // 报告为 flex-basis，否则会迫使兄弟节点收缩、文本在错误的宽度处换行。
  // 此处若改为传 Undefined，会让 Ink 的 <Text>（位于 <Box flexGrow={1}> 内）
  // 取到 width = 内在宽度而非可用宽度，导致换行边界处丢字。
  //
  // 何时应用该逻辑有两条约束：
  //   - 仅适用于宽度。高度在 basis 测量时不会被约束 ——
  //     column 容器必须以自然高度测量子节点，可滚动内容才能溢出
  //（约束高度会裁掉 ScrollBox）。
  //   - 子树必须含 measure-func。纯布局子树（无 measure-func）
  //     若有 flex-grow 子节点，会在 AtMost 约束下扩张，撑大 basis
  //（破坏 YGMinMaxDimensionTest 的 flex_grow_in_at_most 用例：
  //     flexGrow:1 的子节点本应保持 basis 0，而不是涨到 100）。
  let mainConstraint = NaN
  let mainConstraintMode: MeasureMode = MeasureMode.Undefined
  if (isMainRow && isDefined(availableMain) && hasMeasureFuncInSubtree(child)) {
    mainConstraint = availableMain
    mainConstraintMode = MeasureMode.AtMost
  }

  const mw = isMainRow ? mainConstraint : crossConstraint
  const mh = isMainRow ? crossConstraint : mainConstraint
  const mwMode = isMainRow ? mainConstraintMode : crossConstraintMode
  const mhMode = isMainRow ? crossConstraintMode : mainConstraintMode

  layoutNode(child, mw, mh, mwMode, mhMode, ownerWidth, ownerHeight, false)
  const b = isMainRow ? child.layout.width : child.layout.height
  child._fbBasis = b
  child._fbOwnerW = ownerWidth
  child._fbOwnerH = ownerHeight
  child._fbAvailMain = availableMain
  child._fbAvailCross = availableCross
  child._fbCrossMode = crossMode
  child._fbGen = _generation
  return b
}

function hasMeasureFuncInSubtree(node: Node): boolean {
  if (node.measureFunc) {
    return true
  }
  for (const c of node.children) {
    if (hasMeasureFuncInSubtree(c)) {
      return true
    }
  }
  return false
}

function resolveFlexibleLengths(
  children: Node[],
  availableInnerMain: number,
  totalFlexBasis: number,
  isMainRow: boolean,
  ownerW: number,
  ownerH: number,
): void {
  // 按 CSS flexbox 规范 §9.7 "Resolving Flexible Lengths" 进行多趟弹性长度分配：
  // 分配剩余空间、检测 min/max 违规、冻结所有违规者、在未冻结子节点间
  // 重新分配，重复直至稳定。
  const n = children.length
  const frozen: boolean[] = new Array(n).fill(false)
  const initialFree = isDefined(availableInnerMain) ? availableInnerMain - totalFlexBasis : 0
  // 把不可伸缩的项目按截断后的 basis 冻结
  for (let i = 0; i < n; i++) {
    const c = children[i]!
    const clamped = boundAxis(c.style, isMainRow, c._flexBasis, ownerW, ownerH)
    const inflexible =
      !isDefined(availableInnerMain) ||
      (initialFree >= 0 ? c.style.flexGrow === 0 : c.style.flexShrink === 0)
    if (inflexible) {
      c._mainSize = Math.max(0, clamped)
      frozen[i] = true
    } else {
      c._mainSize = c._flexBasis
    }
  }
  // 迭代分配，直到没有违规。每趟都会重新计算剩余空间：
  // 初始剩余空间减去已冻结子节点相对于其 basis 的偏差总和。
  const unclamped: number[] = new Array(n)
  for (let iter = 0; iter <= n; iter++) {
    let frozenDelta = 0
    let totalGrow = 0
    let totalShrinkScaled = 0
    let unfrozenCount = 0
    for (let i = 0; i < n; i++) {
      const c = children[i]!
      if (frozen[i]) {
        frozenDelta += c._mainSize - c._flexBasis
      } else {
        totalGrow += c.style.flexGrow
        totalShrinkScaled += c.style.flexShrink * c._flexBasis
        unfrozenCount++
      }
    }
    if (unfrozenCount === 0) {
      break
    }
    let remaining = initialFree - frozenDelta
    // 规范 §9.7 step 4c：若 flex factor 之和 < 1，则只分配
    // initialFree × sum，而非全部剩余空间（部分 flex）。
    if (remaining > 0 && totalGrow > 0 && totalGrow < 1) {
      const scaled = initialFree * totalGrow
      if (scaled < remaining) {
        remaining = scaled
      }
    } else if (remaining < 0 && totalShrinkScaled > 0) {
      let totalShrink = 0
      for (let i = 0; i < n; i++) {
        if (!frozen[i]) {
          totalShrink += children[i]!.style.flexShrink
        }
      }
      if (totalShrink < 1) {
        const scaled = initialFree * totalShrink
        if (scaled > remaining) {
          remaining = scaled
        }
      }
    }
    // 为所有未冻结子节点计算目标值 + 违规量
    let totalViolation = 0
    for (let i = 0; i < n; i++) {
      if (frozen[i]) {
        continue
      }
      const c = children[i]!
      let t = c._flexBasis
      if (remaining > 0 && totalGrow > 0) {
        t += (remaining * c.style.flexGrow) / totalGrow
      } else if (remaining < 0 && totalShrinkScaled > 0) {
        t += (remaining * (c.style.flexShrink * c._flexBasis)) / totalShrinkScaled
      }
      unclamped[i] = t
      const clamped = Math.max(0, boundAxis(c.style, isMainRow, t, ownerW, ownerH))
      c._mainSize = clamped
      totalViolation += clamped - t
    }
    // 按规范 §9.7 step 5 冻结：若 totalViolation 为零则全部冻结；
    // 为正则冻结 min 违规者；为负则冻结 max 违规者。
    if (totalViolation === 0) {
      break
    }
    let anyFrozen = false
    for (let i = 0; i < n; i++) {
      if (frozen[i]) {
        continue
      }
      const v = children[i]!._mainSize - unclamped[i]!
      if ((totalViolation > 0 && v > 0) || (totalViolation < 0 && v < 0)) {
        frozen[i] = true
        anyFrozen = true
      }
    }
    if (!anyFrozen) {
      break
    }
  }
}

function isStretchAlign(child: Node): boolean {
  const p = child.parent
  if (!p) {
    return false
  }
  const align = child.style.alignSelf === Align.Auto ? p.style.alignItems : child.style.alignSelf
  return align === Align.Stretch
}

function resolveChildAlign(parent: Node, child: Node): Align {
  return child.style.alignSelf === Align.Auto ? parent.style.alignItems : child.style.alignSelf
}

// 节点的基线，按 CSS Flexbox §8.5 / yoga 的 YGBaseline 定义。
// 叶节点（无子节点）使用自身高度。容器则递归进入首行中第一个基线对齐的
// 子节点（若都不是基线对齐，则取首个 flow 子节点），返回该子节点的基线 +
// 其 top 偏移。
function calculateBaseline(node: Node): number {
  let baselineChild: Node | null = null
  for (const c of node.children) {
    if (c._lineIndex > 0) {
      break
    }
    if (c.style.positionType === PositionType.Absolute) {
      continue
    }
    if (c.style.display === Display.None) {
      continue
    }
    if (resolveChildAlign(node, c) === Align.Baseline || c.isReferenceBaseline_) {
      baselineChild = c
      break
    }
    if (baselineChild === null) {
      baselineChild = c
    }
  }
  if (baselineChild === null) {
    return node.layout.height
  }
  return calculateBaseline(baselineChild) + baselineChild.layout.top
}

// 容器仅在 row 方向、且 align-items 为 baseline 或任一 flow 子节点的
// align-self 为 baseline 时，使用基线布局。
function isBaselineLayout(node: Node, flowChildren: Node[]): boolean {
  if (!isRow(node.style.flexDirection)) {
    return false
  }
  if (node.style.alignItems === Align.Baseline) {
    return true
  }
  for (const c of flowChildren) {
    if (c.style.alignSelf === Align.Baseline) {
      return true
    }
  }
  return false
}

function childMarginForAxis(child: Node, axis: FlexDirection, ownerWidth: number): number {
  if (!child._hasMargin) {
    return 0
  }
  const lead = resolveEdge(child.style.margin, leadingEdge(axis), ownerWidth)
  const trail = resolveEdge(child.style.margin, trailingEdge(axis), ownerWidth)
  return lead + trail
}

function resolveGap(style: Style, gutter: Gutter, ownerSize: number): number {
  let v = style.gap[gutter]!
  if (v.unit === Unit.Undefined) {
    v = style.gap[Gutter.All]!
  }
  const r = resolveValue(v, ownerSize)
  return isDefined(r) ? Math.max(0, r) : 0
}

function boundAxis(
  style: Style,
  isWidth: boolean,
  value: number,
  ownerWidth: number,
  ownerHeight: number,
): number {
  const minV = isWidth ? style.minWidth : style.minHeight
  const maxV = isWidth ? style.maxWidth : style.maxHeight
  const minU = minV.unit
  const maxU = maxV.unit
  // 快路径：未设置 min/max 约束。按 CPU 火焰图，这是绝对主要的情况
  //（1000 节点基准下每次布局约 32k 次调用，几乎都没有 min/max）——
  // 跳过总是空操作的 2× resolveValue + 2× isNaN。Unit.Undefined = 0。
  if (minU === 0 && maxU === 0) {
    return value
  }
  const owner = isWidth ? ownerWidth : ownerHeight
  let v = value
  // 内联 resolveValue：Unit.Point=1，Unit.Percent=2。`m === m` 等价于 !isNaN。
  if (maxU === 1) {
    if (v > maxV.value) {
      v = maxV.value
    }
  } else if (maxU === 2) {
    const m = (maxV.value * owner) / 100
    if (m === m && v > m) {
      v = m
    }
  }
  if (minU === 1) {
    if (v < minV.value) {
      v = minV.value
    }
  } else if (minU === 2) {
    const m = (minV.value * owner) / 100
    if (m === m && v < m) {
      v = m
    }
  }
  return v
}

function zeroLayoutRecursive(node: Node): void {
  for (const c of node.children) {
    c.layout.left = 0
    c.layout.top = 0
    c.layout.width = 0
    c.layout.height = 0
    // 使布局缓存失效 —— 否则隐藏后再 calculateLayout 时，子节点会被认为
    // 是干净的（!isDirty_）且 _hasL 完好，命中 ~1086 行的缓存，
    // 还原过期的 _lOutW/_lOutH 并提前返回 —— 跳过子节点定位的递归。
    // 孙节点会因为上面的清零保持在 (0,0,0,0) 而无法渲染。
    // isDirty_=true 还会通过 (sameGen || !isDirty_) 检查门控 _cN 与 _fbBasis ——
    // 由于隐藏期间 _cGen/_fbGen 被冻结，所以取消隐藏时 sameGen 为 false。
    c.isDirty_ = true
    c._hasL = false
    c._hasM = false
    zeroLayoutRecursive(c)
  }
}

function collectLayoutChildren(node: Node, flow: Node[], abs: Node[]): void {
  // 把节点的子节点分为 flow 与 absolute 两类，并把 display:contents 子树扁平化，
  // 使其子节点像本节点的直接子节点一样参与布局
  //（按 CSS display:contents 规范 —— 盒子从布局树中移除，但其子节点保留并
  // 上提到祖父节点）。
  for (const c of node.children) {
    const disp = c.style.display
    if (disp === Display.None) {
      c.layout.left = 0
      c.layout.top = 0
      c.layout.width = 0
      c.layout.height = 0
      zeroLayoutRecursive(c)
    } else if (disp === Display.Contents) {
      c.layout.left = 0
      c.layout.top = 0
      c.layout.width = 0
      c.layout.height = 0
      // 递归 —— 嵌套的 display:contents 会一路向上提。contents 节点自身的
      // margin/padding/position/尺寸都会被忽略。
      collectLayoutChildren(c, flow, abs)
    } else if (c.style.positionType === PositionType.Absolute) {
      abs.push(c)
    } else {
      flow.push(c)
    }
  }
}

function roundLayout(node: Node, scale: number, absLeft: number, absTop: number): void {
  if (scale === 0) {
    return
  }
  const l = node.layout
  const nodeLeft = l.left
  const nodeTop = l.top
  const nodeWidth = l.width
  const nodeHeight = l.height

  const absNodeLeft = absLeft + nodeLeft
  const absNodeTop = absTop + nodeTop

  // 上游 YGRoundValueToPixelGrid：文本节点（含 measureFunc）的位置向下取整，
  // 使换行后的文本永远不会越过分配给它的列起点。宽度则在出现小数时向上取整，
  // 避免裁掉最后一个字形。非文本节点用标准 round。
  // 行为对齐 yoga 的 PixelGrid.cpp —— 否则 justify 的 center/space-evenly
  // 位置与 WASM 相比会差 1 像素，flex-shrink 溢出时兄弟节点会放到错误的列。
  const isText = node.measureFunc !== null
  l.left = roundValue(nodeLeft, scale, false, isText)
  l.top = roundValue(nodeTop, scale, false, isText)

  // 通过绝对边来对宽高取整，避免累计漂移
  const absRight = absNodeLeft + nodeWidth
  const absBottom = absNodeTop + nodeHeight
  const hasFracW = !isWholeNumber(nodeWidth * scale)
  const hasFracH = !isWholeNumber(nodeHeight * scale)
  l.width =
    roundValue(absRight, scale, isText && hasFracW, isText && !hasFracW) -
    roundValue(absNodeLeft, scale, false, isText)
  l.height =
    roundValue(absBottom, scale, isText && hasFracH, isText && !hasFracH) -
    roundValue(absNodeTop, scale, false, isText)

  for (const c of node.children) {
    roundLayout(c, scale, absNodeLeft, absNodeTop)
  }
}

function isWholeNumber(v: number): boolean {
  const frac = v - Math.floor(v)
  return frac < 0.0001 || frac > 0.9999
}

function roundValue(v: number, scale: number, forceCeil: boolean, forceFloor: boolean): number {
  let scaled = v * scale
  let frac = scaled - Math.floor(scaled)
  if (frac < 0) {
    frac += 1
  }
  // 浮点 epsilon 容差与上游 YGDoubleEqual 一致（1e-4）
  if (frac < 0.0001) {
    scaled = Math.floor(scaled)
  } else if (frac > 0.9999) {
    scaled = Math.ceil(scaled)
  } else if (forceCeil) {
    scaled = Math.ceil(scaled)
  } else if (forceFloor) {
    scaled = Math.floor(scaled)
  } else {
    // half-up 取整（>= 0.5 进位），与上游一致
    scaled = Math.floor(scaled) + (frac >= 0.4999 ? 1 : 0)
  }
  return scaled / scale
}

// --
// 辅助函数

function parseDimension(v: number | string | undefined): Value {
  if (v === undefined) {
    return UNDEFINED_VALUE
  }
  if (v === 'auto') {
    return AUTO_VALUE
  }
  if (typeof v === 'number') {
    // WASM 版 yoga 的 YGFloatIsUndefined 把 NaN 与 ±Infinity 都视作 undefined。
    // Ink 会传入 height={Infinity}（例如 LogSelector 的 maxHeight 默认值），
    // 期望它表示 "无约束" —— 若按字面 point 值存储，节点高度会变成 Infinity，
    // 进而破坏后续所有布局。
    return Number.isFinite(v) ? pointValue(v) : UNDEFINED_VALUE
  }
  if (typeof v === 'string' && v.endsWith('%')) {
    return percentValue(parseFloat(v))
  }
  const n = parseFloat(v)
  return Number.isNaN(n) ? UNDEFINED_VALUE : pointValue(n)
}

function physicalEdge(edge: Edge): number {
  switch (edge) {
    case Edge.Left:
    case Edge.Start:
      return EDGE_LEFT
    case Edge.Top:
      return EDGE_TOP
    case Edge.Right:
    case Edge.End:
      return EDGE_RIGHT
    case Edge.Bottom:
      return EDGE_BOTTOM
    default:
      return EDGE_LEFT
  }
}

// --
// 与 yoga-layout/load 对齐的模块 API

export type Yoga = {
  Config: {
    create(): Config
    destroy(config: Config): void
  }
  Node: {
    create(config?: Config): Node
    createDefault(): Node
    createWithConfig(config: Config): Node
    destroy(node: Node): void
  }
}

const YOGA_INSTANCE: Yoga = {
  Config: {
    create: createConfig,
    destroy() {},
  },
  Node: {
    create: (config?: Config) => new Node(config),
    createDefault: () => new Node(),
    createWithConfig: (config: Config) => new Node(config),
    destroy() {},
  },
}

export function loadYoga(): Promise<Yoga> {
  return Promise.resolve(YOGA_INSTANCE)
}

export default YOGA_INSTANCE
