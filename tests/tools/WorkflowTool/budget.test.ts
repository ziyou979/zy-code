import { describe, expect, test } from 'bun:test'
import { MutableWorkflowBudget, BudgetExhaustedError } from '../../../src/tools/WorkflowTool/runtime/budget.js'

describe('MutableWorkflowBudget', () => {
  test('null total means no limit', () => {
    const budget = new MutableWorkflowBudget(null)
    expect(budget.total).toBeNull()
    expect(budget.remaining()).toBe(Infinity)
    expect(budget.spent()).toBe(0)
    // Should not throw
    budget.checkBudget()
  })

  test('tracks spent tokens', () => {
    const budget = new MutableWorkflowBudget(100000)
    expect(budget.spent()).toBe(0)
    expect(budget.remaining()).toBe(100000)

    budget.addSpent(30000)
    expect(budget.spent()).toBe(30000)
    expect(budget.remaining()).toBe(70000)

    budget.addSpent(50000)
    expect(budget.spent()).toBe(80000)
    expect(budget.remaining()).toBe(20000)
  })

  test('checkBudget throws when exhausted', () => {
    const budget = new MutableWorkflowBudget(1000)
    budget.addSpent(1000)

    expect(() => budget.checkBudget()).toThrow(BudgetExhaustedError)
  })

  test('checkBudget does not throw when under limit', () => {
    const budget = new MutableWorkflowBudget(1000)
    budget.addSpent(999)
    expect(() => budget.checkBudget()).not.toThrow()
  })

  test('remaining never goes below 0', () => {
    const budget = new MutableWorkflowBudget(100)
    budget.addSpent(200)
    expect(budget.remaining()).toBe(0)
  })
})
