import type { Tool } from '../Tool.js'

export type ToolRegistrationOptions = {
  /** 标记为特殊工具，getTools() 中默认排除 */
  special?: boolean
}

type ToolRegistration = {
  tool: Tool
  /** 运行时条件：返回 false 时 getAll() 不包含该工具 */
  condition?: () => boolean
  options: ToolRegistrationOptions
}

/**
 * 工具注册中心。
 * 每个工具在自身模块底部调用 register() 完成自注册，
 * tools.ts 负责触发加载（import/require），getAllBaseTools() 从此处读取。
 */
class ToolRegistry {
  private registrations: ToolRegistration[] = []

  /**
   * 注册一个工具到全局注册表。
   * @param tool - 工具实例
   * @param condition - 可选的运行时条件函数，返回 false 时该工具不会出现在 getAll() 结果中
   * @param options - 注册选项（如 special 标记）
   */
  register(tool: Tool, condition?: () => boolean, options?: ToolRegistrationOptions): void {
    this.registrations.push({ tool, condition, options: options ?? {} })
  }

  /**
   * 获取所有满足条件的已注册工具。
   * @param opts.excludeSpecial - 为 true 时排除 special 标记的工具
   */
  getAll(opts?: { excludeSpecial?: boolean }): Tool[] {
    return this.registrations
      .filter((r) => {
        if (opts?.excludeSpecial && r.options.special) return false
        return !(r.condition && !r.condition())
      })
      .map((r) => r.tool)
  }
}

export const toolRegistry = new ToolRegistry()
