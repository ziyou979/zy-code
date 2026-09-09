import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileReadCache } from '../../../src/services/file-persistence/fileReadCache.js'

const directories: string[] = []
function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'zy-file-cache-'))
  directories.push(directory)
  return directory
}
afterEach(() => {
  fileReadCache.clear()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('fileReadCache', () => {
  test('容量超限时淘汰冷文件，保留最近读取的文件', () => {
    const directory = makeDirectory()
    const content = 'x'.repeat(512 * 1024)
    const paths = Array.from({ length: 48 }, (_, i) => join(directory, `${i}.txt`))
    for (let i = 0; i < paths.length; i++) {
      if (i === 24) fileReadCache.readFile(paths[0]!)
      writeFileSync(paths[i]!, content)
      expect(fileReadCache.readFile(paths[i]!).content.length).toBe(content.length)
    }
    const { entries, size } = fileReadCache.getStats()
    expect(size).toBeLessThanOrEqual(31)
    expect(entries).toContain(paths[0]!)
    expect(entries).not.toContain(paths[1]!)
    expect(entries).toContain(paths.at(-1)!)
  })

  test('大文件正常返回但不常驻缓存，改写后不会返回旧值', () => {
    const path = join(makeDirectory(), 'large.txt')
    writeFileSync(path, 'small\r\n')
    expect(fileReadCache.readFile(path).content).toBe('small\n')
    const large = 'x'.repeat(1100 * 1024)
    writeFileSync(path, large)
    utimesSync(path, new Date(), new Date(Date.now() + 2000))
    expect(fileReadCache.readFile(path).content).toBe(large)
    expect(fileReadCache.getStats().entries).not.toContain(path)
  })
})
