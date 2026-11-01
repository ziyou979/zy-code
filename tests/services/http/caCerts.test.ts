import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'
import {
  clearCACertsCache,
  ExtraCACertificatesError,
  getCACertificates,
} from '../../../src/services/http/caCerts.js'

const directory = mkdtempSync(join(tmpdir(), 'zycode-ca-test-'))
const originalPath = process.env.NODE_EXTRA_CA_CERTS
const certificate = rootCertificates[0]!

afterEach(() => {
  if (originalPath === undefined) {
    delete process.env.NODE_EXTRA_CA_CERTS
  } else {
    process.env.NODE_EXTRA_CA_CERTS = originalPath
  }
  clearCACertsCache()
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

function configureBundle(contents: string): void {
  const path = join(directory, 'ca.pem')
  writeFileSync(path, contents)
  process.env.NODE_EXTRA_CA_CERTS = path
  clearCACertsCache()
}

describe('caCerts', () => {
  test('不存在的 CA 路径明确报错，不继续使用默认信任库', () => {
    const path = join(directory, 'missing-ca.pem')
    process.env.NODE_EXTRA_CA_CERTS = path
    clearCACertsCache()
    let failure: unknown
    try {
      getCACertificates()
    } catch (error) {
      failure = error
    }
    // 全套测试会 mock i18n；此处验证错误类别和配置路径，不依赖其他文件的翻译状态。
    expect(failure).toBeInstanceOf(ExtraCACertificatesError)
    if (failure instanceof ExtraCACertificatesError) {
      expect(failure.path).toBe(path)
    }
  })

  test('有效 CA bundle 保留全部自定义证书和基础信任库', () => {
    const bundle = `# proxy CA bundle\n${certificate}\n${rootCertificates[1]!}`
    configureBundle(bundle)
    const certificates = getCACertificates()!
    expect(certificates.length).toBeGreaterThan(1)
    expect(certificates).toContain(bundle)
  })

  test('空文件、无效证书和残缺的尾证书均拒绝加载', () => {
    for (const contents of [
      '',
      'not a certificate',
      `${certificate}\n-----BEGIN CERTIFICATE-----\nbroken\n-----END CERTIFICATE-----`,
      `${certificate}\n-----BEGIN CERTIFICATE-----\ntruncated`,
    ]) {
      configureBundle(contents)
      expect(getCACertificates).toThrow(ExtraCACertificatesError)
    }
  })

  test('修正配置并清理缓存后可以加载正确证书', () => {
    configureBundle('invalid')
    expect(getCACertificates).toThrow()
    configureBundle(certificate)
    expect(getCACertificates()).toContain(certificate)
  })
})
