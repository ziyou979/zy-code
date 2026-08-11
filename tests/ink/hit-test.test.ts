import { describe, expect, test } from 'bun:test'
import { appendChildNode, createNode } from '../../src/ink/dom.js'
import { dispatchHover, hitTest } from '../../src/ink/hitTest.js'
import { nodeCache } from '../../src/ink/nodeCache.js'

describe('hit-test', () => {
  test('应命中逃出父布局框的 absolute 子节点', () => {
    const root = createNode('ink-root')
    const bottomSlot = createNode('ink-box')
    const overlay = createNode('ink-box')

    overlay.style = { position: 'absolute' }
    appendChildNode(root, bottomSlot)
    appendChildNode(bottomSlot, overlay)

    nodeCache.set(root, { x: 0, y: 0, width: 80, height: 24 })
    nodeCache.set(bottomSlot, { x: 0, y: 20, width: 80, height: 4 })
    nodeCache.set(overlay, { x: 0, y: 15, width: 80, height: 5 })

    expect(hitTest(root, 10, 16)).toBe(overlay)
  })

  test('悬停应分发到逃出父布局框的 absolute 子节点', () => {
    const root = createNode('ink-root')
    const bottomSlot = createNode('ink-box')
    const overlay = createNode('ink-box')
    let entered = 0

    overlay.style = { position: 'absolute' }
    overlay._eventHandlers = {
      onMouseEnter: () => {
        entered++
      },
    }
    appendChildNode(root, bottomSlot)
    appendChildNode(bottomSlot, overlay)

    nodeCache.set(root, { x: 0, y: 0, width: 80, height: 24 })
    nodeCache.set(bottomSlot, { x: 0, y: 20, width: 80, height: 4 })
    nodeCache.set(overlay, { x: 0, y: 15, width: 80, height: 5 })

    dispatchHover(root, 10, 16, new Set())

    expect(entered).toBe(1)
  })

  test('真实指针移动先完成进入转换，再派发 mousemove', () => {
    const root = createNode('ink-root')
    const item = createNode('ink-box')
    const events: string[] = []

    item._eventHandlers = {
      onMouseMove: () => events.push('move'),
      onMouseEnter: () => events.push('enter'),
    }
    appendChildNode(root, item)
    nodeCache.set(root, { x: 0, y: 0, width: 80, height: 24 })
    nodeCache.set(item, { x: 0, y: 4, width: 30, height: 1 })

    dispatchHover(root, 5, 4, new Set())

    expect(events).toEqual(['enter', 'move'])
  })

  test('重绘替换 hover 路径时，旧节点 leave 不覆盖新节点 move', () => {
    const root = createNode('ink-root')
    const staleParent = createNode('ink-box')
    const currentParent = createNode('ink-box')
    const currentItem = createNode('ink-box')
    let hoveredId: string | null = 'old-item'

    staleParent._eventHandlers = {
      onMouseLeave: () => {
        hoveredId = null
      },
    }
    currentParent._eventHandlers = { onMouseLeave: () => {} }
    currentItem._eventHandlers = {
      onMouseMove: () => {
        hoveredId = 'current-item'
      },
    }
    // 模拟 reconciler 已将新路径挂入 root，但旧节点仍暂时保留 parentNode。
    staleParent.parentNode = root
    appendChildNode(root, currentParent)
    appendChildNode(currentParent, currentItem)
    nodeCache.set(root, { x: 0, y: 0, width: 80, height: 24 })
    nodeCache.set(currentParent, { x: 0, y: 3, width: 40, height: 3 })
    nodeCache.set(currentItem, { x: 0, y: 4, width: 40, height: 1 })

    dispatchHover(root, 5, 4, new Set([staleParent]))

    expect(hoveredId).toBe('current-item')
  })
})
