#!/usr/bin/env bun
/**
 * 从 HuggingFace 下载各模型家族的 tokenizer 数据并 gzip 压缩。
 *
 * 用法:
 *   bun scripts/download-tokenizers.ts          # 跳过已存在的文件
 *   bun scripts/download-tokenizers.ts --force   # 强制重新下载
 *
 * 支持 HTTP_PROXY / HTTPS_PROXY 代理。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const DATA_DIR = join(import.meta.dir, '..', 'src', 'services', 'tokenizer', 'data')
const FORCE = process.argv.includes('--force')
const MAX_RETRIES = 3

interface TokenizerSource {
  key: string
  repo: string
  files?: string[]
  tokenizerConfigOverride?: Record<string, unknown>
}

const SOURCES: TokenizerSource[] = [
  // OpenAI
  { key: 'gpt4o', repo: 'Xenova/gpt-4o' },
  { key: 'gpt4', repo: 'Xenova/gpt-4' },
  { key: 'gpt35turbo', repo: 'Xenova/gpt-3.5-turbo' },

  // Claude
  {
    key: 'claude',
    repo: 'Xenova/claude-tokenizer',
    tokenizerConfigOverride: { tokenizer_class: 'PreTrainedTokenizer' },
  },

  // DeepSeek
  { key: 'deepseek', repo: 'deepseek-ai/DeepSeek-V3' },

  // Qwen（全系列共用 tokenizer）
  { key: 'qwen', repo: 'Qwen/Qwen3-4B' },

  // Llama 3
  { key: 'llama3', repo: 'Xenova/llama3-tokenizer-new' },

  // GLM / 智谱
  { key: 'glm', repo: 'THUDM/glm-4-9b' },

  // Kimi / Moonshot — 使用 tiktoken.model 格式，@lenml/tokenizers 不支持
  // 需要转换工具（参考 btrip-aligo-v2 的 _load_tiktoken_model_file），暂不支持

  // MiniMax
  { key: 'minimax', repo: 'MiniMaxAI/MiniMax-Text-01' },

  // Gemini
  { key: 'gemini', repo: 'Xenova/gemini-nano' },

  // Gemma
  { key: 'gemma', repo: 'unsloth/gemma-3-1b-it' },

  // Mistral
  { key: 'mistral', repo: 'nbeerbower/mistral-nemo-wissenschaft-12B' },

  // Cohere（原 CohereForAI/c4ai-command-r-plus 需认证，用 ungated 替代）
  { key: 'cohere', repo: 'adamo1139/aya-expanse-8b-ungated' },
]

function hfDownloadUrl(repo: string, filename: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${filename}?download=true`
}

function hfRawUrl(repo: string, filename: string): string {
  return `https://raw.githubusercontent.com/${repo}/raw/main/${filename}`
}

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<Response> {
  const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY ||
    process.env.http_proxy || process.env.https_proxy

  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, {
        ...(proxy ? { proxy } : {}),
        redirect: 'follow',
      } as RequestInit)
      if (resp.ok) return resp
      if (resp.status === 404) throw new Error(`404 Not Found: ${url}`)
      throw new Error(`HTTP ${resp.status}: ${url}`)
    } catch (err) {
      if (i === retries - 1) throw err
      const delay = 1000 + i * 1000
      console.log(`  重试 ${i + 1}/${retries} (${delay}ms)...`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw new Error('unreachable')
}

async function downloadFile(repo: string, filename: string): Promise<Buffer> {
  const urls = [
    hfDownloadUrl(repo, filename),
    hfRawUrl(repo, filename),
  ]

  for (const url of urls) {
    try {
      console.log(`  下载 ${url}`)
      const resp = await fetchWithRetry(url)
      const data = Buffer.from(await resp.arrayBuffer())
      if (filename.endsWith('.json')) {
        JSON.parse(data.toString())
      }
      return data
    } catch (err) {
      console.log(`  失败: ${(err as Error).message}`)
    }
  }

  throw new Error(`无法下载 ${repo}/${filename}`)
}

async function processSource(source: TokenizerSource): Promise<void> {
  const tokenizerGz = join(DATA_DIR, `${source.key}.tokenizer.json.gz`)
  const configGz = join(DATA_DIR, `${source.key}.tokenizer_config.json.gz`)

  if (!FORCE && existsSync(tokenizerGz) && existsSync(configGz)) {
    console.log(`[${source.key}] 已存在，跳过`)
    return
  }

  console.log(`[${source.key}] 从 ${source.repo} 下载...`)

  try {
    const tokenizerData = await downloadFile(source.repo, 'tokenizer.json')
    console.log(`  tokenizer.json: ${(tokenizerData.length / 1024 / 1024).toFixed(1)}MB`)
    writeFileSync(tokenizerGz, gzipSync(tokenizerData, { level: 9 }))

    let configData: Buffer
    if (source.tokenizerConfigOverride) {
      configData = Buffer.from(JSON.stringify(source.tokenizerConfigOverride, null, 2))
    } else {
      try {
        configData = await downloadFile(source.repo, 'tokenizer_config.json')
      } catch {
        configData = Buffer.from(JSON.stringify({ tokenizer_class: 'PreTrainedTokenizer' }))
        console.log(`  tokenizer_config.json 不存在，使用默认配置`)
      }
    }
    writeFileSync(configGz, gzipSync(configData, { level: 9 }))

    const gzSize = readFileSync(tokenizerGz).length
    console.log(`  完成: ${(gzSize / 1024 / 1024).toFixed(1)}MB (gzip)`)
  } catch (err) {
    console.error(`[${source.key}] 下载失败: ${(err as Error).message}`)
    if (existsSync(tokenizerGz)) unlinkSync(tokenizerGz)
    if (existsSync(configGz)) unlinkSync(configGz)
  }
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true })
  console.log(`目标目录: ${DATA_DIR}`)
  console.log(`模式: ${FORCE ? '强制重新下载' : '跳过已存在'}`)
  console.log(`共 ${SOURCES.length} 个模型\n`)

  for (const source of SOURCES) {
    await processSource(source)
  }

  console.log('\n完成!')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
