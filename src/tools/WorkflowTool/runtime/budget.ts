export interface WorkflowBudget {
  readonly total: number | null
  spent(): number
  remaining(): number
}

export function createWorkflowBudget(totalTokens: number | null): WorkflowBudget {
  const spentTokens = 0

  return {
    get total() {
      return totalTokens
    },
    spent() {
      return spentTokens
    },
    remaining() {
      if (totalTokens === null) {
        return Infinity
      }
      return Math.max(0, totalTokens - spentTokens)
    },
  }
}

export function addSpentTokens(budget: WorkflowBudget, tokens: number): void {
  const _b = budget as { total: number | null; spent: () => number }
  // 通过 setter 模式修改闭包中的变量
  ;(budget as any)._spent = ((budget as any)._spent ?? 0) + tokens
}

export class BudgetExhaustedError extends Error {
  constructor(spent: number, total: number) {
    super(`Workflow budget exhausted: spent ${spent} tokens, limit was ${total}`)
    this.name = 'BudgetExhaustedError'
  }
}

export function createMutableBudget(totalTokens: number | null): MutableWorkflowBudget {
  return new MutableWorkflowBudget(totalTokens)
}

export class MutableWorkflowBudget implements WorkflowBudget {
  private spentTokens = 0
  readonly total: number | null

  constructor(totalTokens: number | null) {
    this.total = totalTokens
  }

  spent(): number {
    return this.spentTokens
  }

  remaining(): number {
    if (this.total === null) {
      return Infinity
    }
    return Math.max(0, this.total - this.spentTokens)
  }

  addSpent(tokens: number): void {
    this.spentTokens += tokens
  }

  checkBudget(): void {
    if (this.total !== null && this.spentTokens >= this.total) {
      throw new BudgetExhaustedError(this.spentTokens, this.total)
    }
  }
}
