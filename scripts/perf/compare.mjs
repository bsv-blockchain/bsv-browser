// Compare baseline + improved harness results into a markdown table.
// Two presentations:
//   1. Label-diff table — same metric name, baseline-label vs improved-label run.
//   2. Head-to-head pairs — variants that run inside a single label (e.g. sync vs
//      deferred suggestions, measure-each vs getItemLayout).
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const baseline = JSON.parse(readFileSync(resolve(__dirname, 'results-baseline.json'), 'utf8'))
const improved = JSON.parse(readFileSync(resolve(__dirname, 'results-improved.json'), 'utf8'))

// Head-to-head pairs — both variants exist in either label's result set.
// Use the improved-label run since it ran most recently. baseline values would
// match within noise.
const HEAD_TO_HEAD = [
  {
    name: 'Address bar typing — Fuse search cost (50 keystrokes)',
    slow: 'suggestions.sync_search_50keystrokes',
    fast: 'suggestions.deferred_search_50keystrokes'
  },
  {
    name: 'FlatList row layout — 200 rows',
    slow: 'list.measure_each_x200',
    fast: 'list.getItemLayout_x200'
  },
  {
    name: 'Thumbnail scheduling — onLoadEnd cost',
    slow: 'thumbnail.schedule x500 (every onLoadEnd)',
    fast: 'thumbnail.schedule_gated x500'
  }
]

const rows = []
for (const key of Object.keys(baseline.results)) {
  const b = baseline.results[key]
  const i = improved.results[key] ?? {}
  if (b.ops_per_sec && i.ops_per_sec) {
    const ratio = (i.ops_per_sec / b.ops_per_sec).toFixed(2)
    rows.push({ key, base: `${b.ops_per_sec.toLocaleString()} ops/s`, imp: `${i.ops_per_sec.toLocaleString()} ops/s`, ratio: `${ratio}x` })
  } else if (typeof b.count === 'number' && typeof i.count === 'number') {
    const ratio = i.count === 0 ? '∞' : (b.count / Math.max(1, i.count)).toFixed(2)
    rows.push({ key, base: b.count.toLocaleString(), imp: i.count.toLocaleString(), ratio: `${ratio}x fewer` })
  }
}

const colWidths = {
  key: Math.max(...rows.map(r => r.key.length), 'Metric'.length),
  base: Math.max(...rows.map(r => r.base.length), 'Baseline'.length),
  imp: Math.max(...rows.map(r => r.imp.length), 'Improved'.length),
  ratio: Math.max(...rows.map(r => r.ratio.length), 'Δ'.length)
}

const pad = (s, w) => s.padEnd(w)
const sep = '+' + '-'.repeat(colWidths.key + 2) + '+' + '-'.repeat(colWidths.base + 2) + '+' + '-'.repeat(colWidths.imp + 2) + '+' + '-'.repeat(colWidths.ratio + 2) + '+'

let md = `# Perf bench — baseline vs improved\n\nBaseline at: ${baseline.when}\nImproved at: ${improved.when}\n\n## Label diff (baseline run vs improved run)\n\n`
md += sep + '\n'
md += `| ${pad('Metric', colWidths.key)} | ${pad('Baseline', colWidths.base)} | ${pad('Improved', colWidths.imp)} | ${pad('Δ', colWidths.ratio)} |\n`
md += sep + '\n'
for (const r of rows) {
  md += `| ${pad(r.key, colWidths.key)} | ${pad(r.base, colWidths.base)} | ${pad(r.imp, colWidths.imp)} | ${pad(r.ratio, colWidths.ratio)} |\n`
}
md += sep + '\n'

// Head-to-head section
md += `\n## Head-to-head (single-run, slow path vs fast path)\n\n`
const h2hRows = []
for (const pair of HEAD_TO_HEAD) {
  const slow = improved.results[pair.slow] ?? baseline.results[pair.slow]
  const fast = improved.results[pair.fast] ?? baseline.results[pair.fast]
  if (!slow || !fast) continue
  if (slow.ops_per_sec && fast.ops_per_sec) {
    const ratio = (fast.ops_per_sec / slow.ops_per_sec).toFixed(1)
    h2hRows.push({
      name: pair.name,
      slow: `${slow.ops_per_sec.toLocaleString()} ops/s`,
      fast: `${fast.ops_per_sec.toLocaleString()} ops/s`,
      ratio: `${ratio}x faster`
    })
  }
}
if (h2hRows.length) {
  const nW = Math.max(...h2hRows.map(r => r.name.length), 'Scenario'.length)
  const sW = Math.max(...h2hRows.map(r => r.slow.length), 'Slow path'.length)
  const fW = Math.max(...h2hRows.map(r => r.fast.length), 'Fast path'.length)
  const rW = Math.max(...h2hRows.map(r => r.ratio.length), 'Δ'.length)
  const sep2 = '+' + '-'.repeat(nW + 2) + '+' + '-'.repeat(sW + 2) + '+' + '-'.repeat(fW + 2) + '+' + '-'.repeat(rW + 2) + '+'
  md += sep2 + '\n'
  md += `| ${pad('Scenario', nW)} | ${pad('Slow path', sW)} | ${pad('Fast path', fW)} | ${pad('Δ', rW)} |\n`
  md += sep2 + '\n'
  for (const r of h2hRows) md += `| ${pad(r.name, nW)} | ${pad(r.slow, sW)} | ${pad(r.fast, fW)} | ${pad(r.ratio, rW)} |\n`
  md += sep2 + '\n'
}

console.log(md)
writeFileSync(resolve(__dirname, 'results-diff.md'), md)
console.log(`Wrote ${resolve(__dirname, 'results-diff.md')}`)
