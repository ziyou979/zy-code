#!/usr/bin/env bun
/**
 * Build script for ZY Code.
 * Uses Bun's native bundler. All feature() flags default to false,
 * which DCEs internal-only code paths (BRIDGE_MODE, DAEMON, etc.).
 */

import { join, resolve } from 'path'
import { readdirSync } from 'fs'

const root = import.meta.dir
const srcDir = join(root, 'src')
const outDir = join(root, 'dist')
const buildTime = new Date().toISOString()

// 解析 --target 参数：cli | sdk | all（默认 all）
const targetArg = Bun.argv.find(arg => arg.startsWith('--target'))
const targetValue = targetArg?.includes('=')
  ? targetArg.split('=')[1]
  : Bun.argv[Bun.argv.indexOf('--target') + 1]
const target = (targetValue === 'cli' || targetValue === 'sdk') ? targetValue : 'all'

// 根据 target 确定入口文件
function resolveEntrypoints(): string[] {
  const entries: string[] = []
  if (target === 'cli' || target === 'all') {
    entries.push(join(srcDir, 'entrypoints/cli.tsx'))
  }
  if (target === 'sdk' || target === 'all') {
    const sdkDir = join(srcDir, 'entrypoints/sdk')
    const sdkFiles = readdirSync(sdkDir)
      .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))
      .map(f => join(sdkDir, f))
    entries.push(...sdkFiles)
  }
  return entries
}

// Resolve react-compiler-runtime package path
const reactCompilerRuntime = resolve(root, 'node_modules/react-compiler-runtime/dist/index.js')

console.log(`Building target: ${target}`)
const entrypoints = resolveEntrypoints()
console.log(`Entrypoints: ${entrypoints.map(e => e.replace(root + '/', '')).join(', ')}`)

const result = await Bun.build({
  entrypoints,
  outdir: outDir,
  target: 'bun',
  format: 'esm',
  sourcemap: 'none',
  minify: false,
  splitting: false,
  features: [
    // 启用 transcript classifier（auto mode）
    'TRANSCRIPT_CLASSIFIER',
    // ZY Code 启用以下 Claude Code 功能
    'FORK_SUBAGENT',
    'REACTIVE_COMPACT',
    'TOKEN_BUDGET',
    'CONTEXT_COLLAPSE',
    'HISTORY_SNIP',
    'KAIROS',
    'BUILTIN_EXPLORE_PLAN_AGENTS',
  ],
  define: {
    // Treat as external build (notinternal)
    'process.env.USER_TYPE': '"external"',
    // Build-time macros (replace MACRO.* at bundle time)
    'MACRO.VERSION': '"1.0.0"',
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
  ],
  external: [
    // Native/binary packages (loaded at runtime, not bundled)
    '@ant/computer-use-input',
    '@ant/computer-use-swift',
    'modifiers-napi',
    'image-processor-napi',
    // Dynamic-import-only SDK extensions
    '@azure/identity',
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

console.log(`Build succeeded: ${result.outputs.length} output(s)`)
for (const out of result.outputs) {
  console.log(`  ${out.path} (${(out.size / 1024).toFixed(1)} KB)`)
}
