/**
 * IDE 类型定义，从 ide.ts 中提取以打破循环依赖。
 *
 * editorDiscovery.ts / extensionInstaller.ts 等底层模块只依赖本文件，
 * 而不直接依赖功能密集的 ide.ts。
 */

export type IdeType =
  | 'cursor'
  | 'windsurf'
  | 'vscode'
  | 'pycharm'
  | 'intellij'
  | 'webstorm'
  | 'phpstorm'
  | 'rubymine'
  | 'clion'
  | 'goland'
  | 'rider'
  | 'datagrip'
  | 'appcode'
  | 'dataspell'
  | 'aqua'
  | 'gateway'
  | 'fleet'
  | 'androidstudio'
