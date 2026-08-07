#!/usr/bin/env bun

/**
 * Build script for ZY Code.
 * Uses Bun's native bundler. All feature() flags default to false,
 * which DCEs internal-only code paths (BRIDGE_MODE, DAEMON, etc.).
 */

import { cpSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = import.meta.dir
const srcDir = join(root, 'src')
const outDir = join(root, 'dist')
const buildTime = new Date().toISOString()

// 从 package.json 读取版本号，避免硬编码
const packageJson = await Bun.file(join(root, 'package.json')).json()
const version: string = packageJson.version

// Resolve react-compiler-runtime package path
const reactCompilerRuntime = resolve(root, 'node_modules/react-compiler-runtime/dist/index.js')

const entrypoints = [join(srcDir, 'entrypoints/cli.tsx')]
console.log(`Entrypoints: ${entrypoints.map((e) => e.replace(`${root}/`, '')).join(', ')}`)

const result = await Bun.build({
  entrypoints,
  outdir: outDir,
  target: 'bun',
  format: 'esm',
  sourcemap: 'none',
  minify: false,
  splitting: false,
  features: [
    // ZY Code 启用以下 Claude Code 功能
    // TREE_SITTER_BASH：Bash 命令 AST 安全解析（纯 TS 实现，与 CC 2.1.220 一致，
    // 已过黄金语料验证；超时/节点预算 fail-closed，无回退风险）
    'TREE_SITTER_BASH',
    'DAEMON',
    'FORK_SUBAGENT',
    'REACTIVE_COMPACT',
    'TOKEN_BUDGET',
    'CONTEXT_COLLAPSE',
    'KAIROS',
    'AGENT_TRIGGERS',
    'MONITOR_TOOL',
    'BUILTIN_EXPLORE_PLAN_AGENTS',
    'VERIFICATION_AGENT',
    'WORKFLOW_SCRIPTS',
  ],
  define: {
    // Treat as external build (notinternal)
    'process.env.USER_TYPE': '"external"',
    // Build-time macros (replace MACRO.* at bundle time)
    'MACRO.VERSION': JSON.stringify(version),
    'MACRO.BUILD_TIME': `"${buildTime}"`,
    'MACRO.PACKAGE_URL': '"@zy-ai/zy-code"',
    'MACRO.NATIVE_PACKAGE_URL': 'null',
    'MACRO.FEEDBACK_CHANNEL': '"https://github.com/ziyou979/zy-code/issues"',
    'MACRO.ISSUES_EXPLAINER': '"report the issue at https://github.com/ziyou979/zy-code/issues"',
    'MACRO.VERSION_CHANGELOG': '""',
  },
  plugins: [
    {
      name: 'react-compiler-runtime',
      setup(build) {
        build.onResolve({ filter: /^react\/compiler-runtime$/ }, () => ({
          path: reactCompilerRuntime,
        }))
      },
    },
    {
      name: 'color-diff-napi',
      setup(build) {
        build.onResolve({ filter: /^color-diff-napi$/ }, () => ({
          path: join(srcDir, 'native-ts/color-diff/index.ts'),
        }))
      },
    },
    {
      name: 'modifiers-napi',
      setup(build) {
        build.onResolve({ filter: /^modifiers-napi$/ }, () => ({
          path: join(srcDir, 'native-ts/modifiers/index.ts'),
        }))
      },
    },
  ],
  external: [
    // Native/binary packages (loaded at runtime, not bundled)
    '@ant/computer-use-input',
    '@ant/computer-use-swift',
    'image-processor-napi',
    // Dynamic-import-only SDK extensions
    '@azure/identity',
    '@aws-sdk/client-sts',
    '@aws-sdk/credential-provider-node',
    '@aws-sdk/credential-providers',
    // Lazy-loaded packages (dynamic import only)
    '@anthropic-ai/mcpb',
    '@smithy/core',
    '@smithy/node-http-handler',
    'sharp',
    'turndown',
    'fflate',
    'yaml',
    // OpenTelemetry exporters (lazy-loaded based on user config)
    '@opentelemetry/exporter-metrics-otlp-grpc',
    '@opentelemetry/exporter-metrics-otlp-http',
    '@opentelemetry/exporter-metrics-otlp-proto',
    '@opentelemetry/exporter-prometheus',
    '@opentelemetry/exporter-logs-otlp-grpc',
    '@opentelemetry/exporter-logs-otlp-http',
    '@opentelemetry/exporter-logs-otlp-proto',
    '@opentelemetry/exporter-trace-otlp-grpc',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/exporter-trace-otlp-proto',
  ],
})

if (!result.success) {
  console.error('Build failed:')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

// 复制 tokenizer 数据到 dist/（运行时从 import.meta.dir 加载）
cpSync(join(srcDir, 'services/tokenizer/data'), join(outDir, 'tokenizer-data'), { recursive: true })

console.log(`Build succeeded: ${result.outputs.length} output(s)`)
for (const out of result.outputs) {
  console.log(`  ${out.path} (${(out.size / 1024).toFixed(1)} KB)`)
}
