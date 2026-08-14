/**
 * 记录 memory 召回操作的结构，用于 telemetry。
 * 这是外部 build 使用的占位实现。
 */
export function logMemoryRecallShape(_memories: unknown, _selected: unknown): void {
  // 占位逻辑：外部 build 中不执行操作
}

/**
 * 记录 memory 写入操作的结构，用于 telemetry。
 * 这是外部 build 使用的占位实现。
 */
export function logMemoryWriteShape(
  _toolName: string,
  _toolInput: unknown,
  _filePath: string,
  _scope: unknown,
): void {
  // 占位逻辑：外部 build 中不执行操作
}
