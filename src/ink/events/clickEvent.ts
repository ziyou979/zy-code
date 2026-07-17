import { Event } from './event.js'

/**
 * 鼠标点击事件。在左键释放且无拖拽时触发，仅在
 * 启用鼠标跟踪时触发（即在 <AlternateScreen> 内）。
 *
 * 从最深的命中节点向上通过 parentNode 冒泡。调用
 * stopImmediatePropagation() 可阻止祖先的 onClick 触发。
 */
export class ClickEvent extends Event {
  /** 点击的屏幕列号（0 起始索引） */
  readonly col: number
  /** 点击的屏幕行号（0 起始索引） */
  readonly row: number
  /**
   * 点击列相对于当前处理者 Box 的位置（col - box.x）。
   * 由 dispatchClick 在每个处理者触发前重新计算，
   * 因此容器上的 onClick 看到的是相对于该容器的坐标，
   * 而不是点击命中的子元素的坐标。
   */
  localCol = 0
  /** 点击行相对于当前处理者 Box 的位置（row - box.y）。 */
  localRow = 0
  /**
   * 如果点击的单元格没有可见内容（在屏幕缓冲区中未写入
   * —— 两个 packed word 均为 0），则为 true。处理者可以检查
   * 此项以忽略空白区域的点击，避免意外点击
   * 终端空白区域触发状态切换。
   */
  readonly cellIsBlank: boolean

  constructor(col: number, row: number, cellIsBlank: boolean) {
    super()
    this.col = col
    this.row = row
    this.cellIsBlank = cellIsBlank
  }
}
