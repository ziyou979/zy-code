// Stub for @ant/computer-use-input

export type ComputerUseInputAPI = {
  key(key: string): Promise<void>
  keys(keys: string[]): Promise<void>
  mouseMove(x: number, y: number): Promise<void>
  mouseClick(button: string): Promise<void>
  mouseDrag(x: number, y: number): Promise<void>
  mouseScroll(x: number, y: number, dx: number, dy: number): Promise<void>
  type(text: string): Promise<void>
  getFrontmostApp(): Promise<string>
}

export type ComputerUseInput =
  | ({ isSupported: true } & ComputerUseInputAPI)
  | { isSupported: false }
