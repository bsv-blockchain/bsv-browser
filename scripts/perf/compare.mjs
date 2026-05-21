// Compare baseline + improved harness results into a markdown table.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const baseline = JSON.parse(readFileSync(resolve(__dirname, 'results-baseline.json'), 'utf8'))
const improved = JSON.parse(readFileSync(resolve(__dirname, 'results-improved.json'), 'utf8'))

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

let md = `# Perf bench — baseline vs improved\n\nBaseline at: ${baseline.when}\nImproved at: ${improved.when}\n\n`
md += sep + '\n'
md += `| ${pad('Metric', colWidths.key)} | ${pad('Baseline', colWidths.base)} | ${pad('Improved', colWidths.imp)} | ${pad('Δ', colWidths.ratio)} |\n`
md += sep + '\n'
for (const r of rows) {
  md += `| ${pad(r.key, colWidths.key)} | ${pad(r.base, colWidths.base)} | ${pad(r.imp, colWidths.imp)} | ${pad(r.ratio, colWidths.ratio)} |\n`
}
md += sep + '\n'

console.log(md)
writeFileSync(resolve(__dirname, 'results-diff.md'), md)
console.log(`Wrote ${resolve(__dirname, 'results-diff.md')}`)
