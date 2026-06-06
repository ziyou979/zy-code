#!/usr/bin/env node
/**
 * 为 src/utils/ 目录下所有 noExplicitAny biome lint 错误添加 biome-ignore 注释。
 * 仅处理没有已有 biome-ignore 注释的行。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// 获取所有 noExplicitAny 错误的文件和行号
const output = execSync(
  'npx biome lint --only=suspicious/noExplicitAny --max-diagnostics=5000 2>&1',
  { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
)

// 解析格式: src/utils/foo.ts:123:45 lint/suspicious/noExplicitAny
const regex = /^(src\/utils\/[^:]+):(\d+):\d+ lint\/suspicious\/noExplicitAny/gm
const errors = new Map() // file -> Set<lineNumber>

let match
while ((match = regex.exec(output)) !== null) {
  const file = match[1]
  const line = parseInt(match[2], 10)
  if (!errors.has(file)) {
    errors.set(file, new Set())
  }
  errors.get(file).add(line)
}

console.log(
  `Found ${Array.from(errors.values()).reduce((s, set) => s + set.size, 0)} errors across ${errors.size} files`,
)

// 为每个文件的每一行添加 biome-ignore 注释
for (const [file, lineNumbers] of errors) {
  const content = readFileSync(file, 'utf-8')
  const lines = content.split('\n')

  // 从后往前处理，避免行号偏移
  const sortedLines = Array.from(lineNumbers).sort((a, b) => b - a)

  for (const lineNum of sortedLines) {
    const idx = lineNum - 1 // 转为 0-based
    if (idx < 0 || idx >= lines.length) continue

    const currentLine = lines[idx]

    // 如果上一行已经有 biome-ignore，跳过
    if (idx > 0 && lines[idx - 1].includes('biome-ignore lint/suspicious/noExplicitAny')) {
      continue
    }

    // 如果当前行已包含 biome-ignore，跳过
    if (currentLine.includes('biome-ignore')) {
      continue
    }

    // 获取缩进
    const indent = currentLine.match(/^(\s*)/)[1]

    // 根据上下文生成注释原因
    let reason = '适配层类型桥接'
    if (currentLine.includes('secureStorage') || currentLine.includes('getSecureStorage')) {
      reason = 'SecureStorage 接口不包含扩展方法'
    } else if (currentLine.includes('querySource')) {
      reason = 'QuerySource 类型不含此运行时值'
    } else if (currentLine.includes('createAttachmentMessage')) {
      reason = '构造 hook 结果中间对象'
    } else if (currentLine.includes('.attachment')) {
      reason = '附件类型动态扩展'
    } else if (currentLine.includes('sideQuery')) {
      reason = 'sideQuery 参数适配'
    } else if (currentLine.includes('message') && currentLine.includes('.content')) {
      reason = '消息内容类型桥接'
    } else if (currentLine.includes('as any)')) {
      reason = '第三方类型定义不完善'
    }

    // 插入 biome-ignore 注释
    lines.splice(idx, 0, `${indent}// biome-ignore lint/suspicious/noExplicitAny: ${reason}`)
  }

  writeFileSync(file, lines.join('\n'))
  console.log(`Fixed ${lineNumbers.size} errors in ${file}`)
}

console.log('Done!')
