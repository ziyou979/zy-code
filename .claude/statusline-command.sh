#!/bin/bash
branch=$(git branch --show-current 2>/dev/null || echo "")

node -e "
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const data = JSON.parse(input);
  const branch = process.argv[1] || '';

  function fmt(n) {
    if (n >= 1000000) return (Math.round(n / 100000) / 10) + 'M';
    if (n >= 1000) return (Math.round(n / 100) / 10) + 'K';
    return String(n);
  }

  const project = data.workspace?.repo?.name || data.workspace?.current_dir?.split('/').pop() || 'unknown';
  const model = data.model?.display_name || 'unknown';
  const ctx = data.context_window || {};
  const ctxTotal = ctx.context_window_size || 0;
  const ctxPct = Math.round(ctx.used_percentage || 0);
  const usage = ctx.current_usage || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;

  // ANSI colors
  const cyan = (s) => '\x1b[36m' + s + '\x1b[0m';
  const green = (s) => '\x1b[32m' + s + '\x1b[0m';
  const yellow = (s) => '\x1b[33m' + s + '\x1b[0m';
  const blue = (s) => '\x1b[34m' + s + '\x1b[0m';
  const magenta = (s) => '\x1b[35m' + s + '\x1b[0m';
  const dim = (s) => '\x1b[90m' + s + '\x1b[0m';

  const ctxPctColor = ctxPct > 80 ? '\x1b[31m' + ctxPct + '%\x1b[0m' : ctxPct > 50 ? yellow(ctxPct + '%') : green(ctxPct + '%');

  const parts = [
    cyan(project),
    branch ? green('[' + branch + ']') : null,
    dim('|') + ' ' + magenta(model),
    dim('|') + ' ctx: ' + ctxPctColor + dim(' of ') + Math.round(ctxTotal / 1000) + 'K',
    dim('|') + ' in: ' + blue(fmt(inputTokens)) + ' out: ' + yellow(fmt(outputTokens)),
    cacheRead > 0 ? dim('cache_r: ') + green(fmt(cacheRead)) : null,
    cacheWrite > 0 ? dim('cache_w: ') + magenta(fmt(cacheWrite)) : null,
  ].filter(Boolean);

  console.log(parts.join(' '));
});
" "$branch"