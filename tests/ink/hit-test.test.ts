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
})
