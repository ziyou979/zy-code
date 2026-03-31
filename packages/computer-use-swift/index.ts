// Stub for @ant/computer-use-swift

export type ComputerUseAPI = {
  screenshot(): Promise<{ data: Buffer; width: number; height: number }>
  getWindows(): Promise<Array<{ id: number; title: string; appName: string }>>
}
