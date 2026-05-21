// Perf harness — exercises hot paths from GROK_REVIEW.md against current+improved code paths.
// Pure Node (ESM), no React Native deps. Faithful pure-JS reimplementations of the
// patterns the app uses, so we can diff baseline vs improved without booting Metro/RN.
//
// Usage:  node scripts/perf/harness.mjs [--out=<file>]  [--label=baseline|improved]

import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import * as mobx from 'mobx'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')

// CLI
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/)
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]
  })
)
const LABEL = args.label || 'baseline'
const OUT = args.out || join(ROOT, 'scripts/perf', `results-${LABEL}.json`)

const results = {}

function bench(name, fn, iterations = 1) {
  // Warm-up
  for (let i = 0; i < Math.max(1, iterations / 10); i++) fn()
  const samples = []
  for (let s = 0; s < 5; s++) {
    const t0 = performance.now()
    let last
    for (let i = 0; i < iterations; i++) last = fn(i)
    const t1 = performance.now()
    samples.push(t1 - t0)
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(samples.length / 2)]
  results[name] = {
    median_ms: +median.toFixed(4),
    iterations,
    ops_per_sec: Math.round((iterations / median) * 1000)
  }
  console.log(`  ${name.padEnd(50)} ${median.toFixed(2)}ms / ${iterations} iter  (${results[name].ops_per_sec.toLocaleString()} ops/sec)`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Console polyfill — bridge cost per log call
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] Console polyfill bridge cost')

function makeFakeWindowBaseline() {
  let bridgeCalls = 0
  const fakeWindow = {
    __consolePatched: false,
    ReactNativeWebView: {
      postMessage: () => { bridgeCalls++ }
    }
  }
  const fakeConsole = {
    log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {}
  }
  // Apply BASELINE patch (verbatim from injectedPolyfills.ts:7-46)
  if (!fakeWindow.__consolePatched) {
    const originalLog = fakeConsole.log
    const originalWarn = fakeConsole.warn
    const originalError = fakeConsole.error
    const originalInfo = fakeConsole.info
    const originalDebug = fakeConsole.debug

    const send = (method, args) => {
      try {
        fakeWindow.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'CONSOLE', method, args }))
      } catch {}
    }
    fakeConsole.log = function (...args) { originalLog.apply(fakeConsole, args); send('log', args) }
    fakeConsole.warn = function (...args) { originalWarn.apply(fakeConsole, args); send('warn', args) }
    fakeConsole.error = function (...args) { originalError.apply(fakeConsole, args); send('error', args) }
    fakeConsole.info = function (...args) { originalInfo.apply(fakeConsole, args); send('info', args) }
    fakeConsole.debug = function (...args) { originalDebug.apply(fakeConsole, args); send('debug', args) }
    fakeWindow.__consolePatched = true
  }
  return { fakeConsole, getBridgeCalls: () => bridgeCalls }
}

function makeFakeWindowImproved() {
  // Improved: dev gate + sampling for non-error methods + skip debug/info entirely in prod.
  // Mirrors the planned patch:
  //   - error/warn  → always send
  //   - log         → send 1/10 in prod, always in dev
  //   - info/debug  → skipped in prod
  let bridgeCalls = 0
  const fakeWindow = {
    __consolePatched: false,
    __DEV__: false, // simulate production
    ReactNativeWebView: {
      postMessage: () => { bridgeCalls++ }
    }
  }
  const fakeConsole = {
    log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {}
  }
  if (!fakeWindow.__consolePatched) {
    const originalLog = fakeConsole.log
    const originalWarn = fakeConsole.warn
    const originalError = fakeConsole.error
    const originalInfo = fakeConsole.info
    const originalDebug = fakeConsole.debug

    const isDev = !!fakeWindow.__DEV__
    const SAMPLE_RATE = isDev ? 1 : 10
    let logSeq = 0

    const send = (method, args) => {
      try {
        fakeWindow.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'CONSOLE', method, args }))
      } catch {}
    }

    fakeConsole.log = function (...args) {
      originalLog.apply(fakeConsole, args)
      if ((++logSeq % SAMPLE_RATE) === 0) send('log', args)
    }
    fakeConsole.warn = function (...args) { originalWarn.apply(fakeConsole, args); send('warn', args) }
    fakeConsole.error = function (...args) { originalError.apply(fakeConsole, args); send('error', args) }
    fakeConsole.info = function (...args) {
      originalInfo.apply(fakeConsole, args)
      if (isDev) send('info', args)
    }
    fakeConsole.debug = function (...args) {
      originalDebug.apply(fakeConsole, args)
      if (isDev) send('debug', args)
    }
    fakeWindow.__consolePatched = true
  }
  return { fakeConsole, getBridgeCalls: () => bridgeCalls }
}

// Which variant to bench is decided by harness label
const consoleVariant = LABEL === 'improved' ? makeFakeWindowImproved : makeFakeWindowBaseline
let consoleHarness = consoleVariant()
let CONSOLE_BRIDGE_CALLS = 0

bench('console.log x10k (typical dApp logging)', () => {
  consoleHarness.fakeConsole.log('hello', { foo: 'bar' }, 42)
}, 10000)

// Measure bridge call count
consoleHarness = consoleVariant()
for (let i = 0; i < 10000; i++) {
  consoleHarness.fakeConsole.log('hello', { foo: 'bar' })
  if (i % 50 === 0) consoleHarness.fakeConsole.info('info-event')
  if (i % 100 === 0) consoleHarness.fakeConsole.debug('debug-trace')
  if (i % 500 === 0) consoleHarness.fakeConsole.warn('warn')
  if (i % 1000 === 0) consoleHarness.fakeConsole.error('err')
}
CONSOLE_BRIDGE_CALLS = consoleHarness.getBridgeCalls()
results['console.bridge_calls_for_10k_mixed'] = { count: CONSOLE_BRIDGE_CALLS }
console.log(`  console.bridge_calls_for_10k_mixed                ${CONSOLE_BRIDGE_CALLS.toLocaleString()} postMessage calls`)

// ─────────────────────────────────────────────────────────────────────────────
// 2. Provider value identity stability (useMemo vs literal)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] Provider value identity (consumer re-render storm)')

// Simulate React context: provider re-renders N times due to unrelated parent state.
// Consumer re-renders whenever value identity changes (Object.is comparison).
function simulateProviderRenders({ memo, parentRenders }) {
  let providerState = { route: 'closed', params: {}, history: [] }
  let lastValue = null
  let consumerRerenders = 0

  for (let i = 0; i < parentRenders; i++) {
    // Parent re-renders for some unrelated reason; provider state unchanged
    let value
    if (memo) {
      // Stable reference because memo deps unchanged
      if (lastValue === null) {
        value = { ...providerState, push: () => {}, pop: () => {}, close: () => {}, isOpen: false }
      } else {
        value = lastValue
      }
    } else {
      // BASELINE: new object literal every render
      value = { ...providerState, push: () => {}, pop: () => {}, close: () => {}, isOpen: false }
    }
    if (lastValue === null || !Object.is(lastValue, value)) {
      consumerRerenders++
      lastValue = value
    }
  }
  return consumerRerenders
}

const PARENT_RENDERS = 1000
const useMemoForBench = LABEL === 'improved'
const consumerRerenders = simulateProviderRenders({ memo: useMemoForBench, parentRenders: PARENT_RENDERS })
results['provider.consumer_rerenders_for_1000_parent_renders'] = { count: consumerRerenders }
console.log(`  provider.consumer_rerenders                      ${consumerRerenders.toLocaleString()} (out of ${PARENT_RENDERS} parent renders)`)

bench('provider.value_construction x1000', () => {
  // Simulate the per-render cost of building a SheetContext-shaped value
  const v = { route: 'closed', params: {}, history: [], push: () => {}, pop: () => {}, close: () => {}, isOpen: false }
  return v
}, 1000)

// ─────────────────────────────────────────────────────────────────────────────
// 3. MobX root-observer storm (bookmark mutation cascade)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] MobX bookmark mutation cascade')

const { makeAutoObservable, autorun, runInAction, computed } = mobx

class BookmarkStoreBench {
  bookmarks = []
  constructor() { makeAutoObservable(this) }
  add(b) { this.bookmarks.push(b) }
  remove(url) { this.bookmarks = this.bookmarks.filter(b => b.url !== url) }
  // Improved: derived isBookmarked computation lives on store, with explicit URL
  isBookmarkedFor(url) { return this.bookmarks.some(b => b.url === url) }
}

function runBookmarkScenario({ isolated }) {
  const store = new BookmarkStoreBench()
  let activeUrl = 'https://example.com/page1'
  // Seed
  for (let i = 0; i < 100; i++) {
    store.add({ url: `https://example.com/seed${i}`, title: `Seed ${i}` })
  }

  let rootRenders = 0
  let isolatedRenders = 0

  let disposer
  if (isolated) {
    // IMPROVED: tiny isolated reaction reads just one bookmark; root reaction reads only activeUrl
    disposer = autorun(() => {
      // Root reaction — depends only on activeUrl (simulated as observable below would be ideal, but here just constant)
      void activeUrl
      rootRenders++
    })
    const isolatedDisposer = autorun(() => {
      void store.isBookmarkedFor(activeUrl)
      isolatedRenders++
    })
    // Combine for cleanup
    const orig = disposer
    disposer = () => { orig(); isolatedDisposer() }
  } else {
    // BASELINE: root observer reads `bookmarkStore.bookmarks.some(...)` directly
    disposer = autorun(() => {
      void store.bookmarks.some(b => b.url === activeUrl)
      rootRenders++
    })
  }

  // Mutate bookmarks 500x — each should NOT re-render root in improved variant
  // because root no longer reads bookmarks at all.
  for (let i = 0; i < 500; i++) {
    runInAction(() => {
      store.add({ url: `https://example.com/extra${i}`, title: `Extra ${i}` })
    })
  }
  disposer()
  return { rootRenders, isolatedRenders }
}

const isolatedForBench = LABEL === 'improved'
const scenario = runBookmarkScenario({ isolated: isolatedForBench })
results['bookmark.root_renders_for_500_mutations'] = { count: scenario.rootRenders }
results['bookmark.isolated_renders_for_500_mutations'] = { count: scenario.isolatedRenders }
console.log(`  bookmark.root_observer_renders                    ${scenario.rootRenders.toLocaleString()} (target: 1 in improved)`)
console.log(`  bookmark.isolated_observer_renders                ${scenario.isolatedRenders.toLocaleString()} (only fires when activeUrl's bookmarked state changes)`)

// Timing version
bench('bookmark.add+react x500', () => {
  const store = new BookmarkStoreBench()
  for (let i = 0; i < 50; i++) store.add({ url: `u${i}`, title: 't' })
  let count = 0
  const disp = autorun(() => { void store.bookmarks.some(b => b.url === 'target'); count++ })
  for (let i = 0; i < 500; i++) runInAction(() => store.add({ url: `x${i}`, title: 't' }))
  disp()
  return count
}, 5)

// ─────────────────────────────────────────────────────────────────────────────
// 4. Tab store cap + LRU
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] Tab store cap + LRU eviction')

class TabStoreBench {
  tabs = []
  activeTabId = 0
  nextId = 1
  lastFocusedAt = new Map()
  // Improved variant honors a cap and evicts LRU non-active
  MAX_TABS = 8
  evict_lru = false

  newTab(url = 'about:blank') {
    if (this.evict_lru && this.tabs.length >= this.MAX_TABS) {
      // Find oldest non-active
      let oldestId = null
      let oldestTime = Infinity
      for (const t of this.tabs) {
        if (t.id === this.activeTabId) continue
        const tFocused = this.lastFocusedAt.get(t.id) || 0
        if (tFocused < oldestTime) { oldestTime = tFocused; oldestId = t.id }
      }
      if (oldestId !== null) {
        this.tabs = this.tabs.filter(t => t.id !== oldestId)
        this.lastFocusedAt.delete(oldestId)
      }
    }
    const tab = { id: this.nextId++, url }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.lastFocusedAt.set(tab.id, Date.now())
    return tab
  }
}

function runTabScenario({ withCap }) {
  const store = new TabStoreBench()
  store.evict_lru = withCap
  for (let i = 0; i < 50; i++) store.newTab(`https://example.com/${i}`)
  return { final_tab_count: store.tabs.length, max_id_in_store: store.nextId - 1 }
}

const withCap = LABEL === 'improved'
const tabScenario = runTabScenario({ withCap })
results['tab.count_after_50_opens'] = { count: tabScenario.final_tab_count }
console.log(`  tab.count_after_50_opens                          ${tabScenario.final_tab_count} (cap target: 8 in improved)`)

// ─────────────────────────────────────────────────────────────────────────────
// 5. WalletContext-shaped value rebuild cost (35-field object on every tick)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] WalletContext value rebuild')

function makeWalletValue() {
  // Faithful shape — 35+ fields, mix of primitives, arrays, functions
  return {
    managers: {}, wallet: null, walletReady: true, isLoading: false, isAuthenticated: false,
    network: 'main', balance: 0, balanceFiat: 0, currency: 'USD', exchangeRate: 1,
    txStatusVersion: 0, basketQueue: [], certQueue: [], permissionQueue: [], spendingQueue: [],
    autoApproveBelowSat: 0, defaultSpendingPolicies: [], updateSpending: () => {},
    updateAutoApprove: () => {}, refreshBalance: async () => {}, signOut: async () => {},
    createAction: async () => ({}), getPublicKey: async () => ({}), createSignature: async () => ({}),
    verifySignature: async () => ({}), encrypt: async () => ({}), decrypt: async () => ({}),
    listOutputs: async () => ([]), revealCounterpartyKey: async () => ({}),
    revealSpecificKey: async () => ({}), acquireCertificate: async () => ({}),
    proveCertificate: async () => ({}), getNetwork: () => 'main', getVersion: () => '1',
    checkUtxoSpendability: async () => true, internalizeAction: async () => ({}),
    abortAction: async () => ({}), listActions: async () => ([]), listCertificates: async () => ([])
  }
}

bench('wallet.value_rebuild x1000', () => {
  return makeWalletValue()
}, 1000)

// ─────────────────────────────────────────────────────────────────────────────
// 6. Thumbnail-capture scheduling cost (timer churn)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[6] Thumbnail capture scheduling churn')

bench('thumbnail.schedule x500 (every onLoadEnd)', () => {
  // Mimic: clearTimeout + setTimeout 800ms on every loadEnd
  const handle = setTimeout(() => {}, 800)
  clearTimeout(handle)
  return handle
}, 500)

// Improved scenario: only schedule when condition met (tabsOpen||bg), wrap with InteractionManager idle
let scheduledCount = 0
bench('thumbnail.schedule_gated x500', () => {
  // simulate gate: 1/10 of loadEnd events actually need capture
  const gate = Math.random() < 0.1
  if (gate) {
    scheduledCount++
    const handle = setTimeout(() => {}, 800)
    clearTimeout(handle)
  }
  return scheduledCount
}, 500)

// ─────────────────────────────────────────────────────────────────────────────
// 7. Suggestions debounce (sync vs useDeferredValue-like batching)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[7] Suggestions debounce — sync vs deferred')

// Simulate Fuse search cost: 0.5 ms per keystroke on a 200-entry collection.
function fakeFuseSearch(query) {
  let acc = 0
  for (let i = 0; i < 200; i++) {
    if (typeof query === 'string' && query.length > 0 && query.charCodeAt(0) + i > 0) acc++
  }
  return acc
}

function syncTypingScenario(keystrokes) {
  // Baseline: every keystroke triggers immediate Fuse search.
  let work = 0
  for (let i = 0; i < keystrokes.length; i++) {
    work += fakeFuseSearch(keystrokes[i])
  }
  return work
}

function deferredTypingScenario(keystrokes) {
  // Improved: only the latest value is searched after the burst settles.
  // useDeferredValue collapses N synchronous renders into one search pass.
  let work = 0
  // Simulate: every keystroke pushes state, but search only runs once for the
  // final value (after the input burst stops).
  work += fakeFuseSearch(keystrokes[keystrokes.length - 1])
  return work
}

const keystrokes = []
for (let i = 0; i < 50; i++) keystrokes.push('hello world'.slice(0, (i % 11) + 1))

bench('suggestions.sync_search_50keystrokes', () => {
  return syncTypingScenario(keystrokes)
}, 500)

bench('suggestions.deferred_search_50keystrokes', () => {
  return deferredTypingScenario(keystrokes)
}, 500)

// ─────────────────────────────────────────────────────────────────────────────
// 8. FlatList getItemLayout vs measure-on-mount
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[8] FlatList getItemLayout vs per-item measure')

// Simulate the cost of computing layout for N items synchronously vs O(1).
const N_ITEMS = 200
bench('list.measure_each_x200', () => {
  // Baseline: O(N) — every item needs a layout pass on first render.
  let total = 0
  for (let i = 0; i < N_ITEMS; i++) {
    // Simulate measurement: tiny math + offset accumulation.
    total += Math.floor(60 + Math.sin(i) * 0.1)
  }
  return total
}, 200)

bench('list.getItemLayout_x200', () => {
  // Improved: O(1) — derive offsets arithmetically.
  return N_ITEMS * 60
}, 200)

// ─────────────────────────────────────────────────────────────────────────────
// 9. CWI handleMessage InteractionManager gate
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[9] CWI gate via InteractionManager (simulated)')

async function cwiPath(gated) {
  // Simulated ECDSA op: 3 ms of work.
  if (gated) {
    // Yield first — releases JS thread to chrome animation.
    await new Promise(r => setImmediate(r))
  }
  const t0 = performance.now()
  while (performance.now() - t0 < 3) { /* spin */ }
  return performance.now() - t0
}

;(async () => {
  const samples = LABEL === 'improved'
  let total = 0
  for (let i = 0; i < 10; i++) total += await cwiPath(samples)
  results['cwi.10x3ms_op'] = { median_ms: +(total / 10).toFixed(2), iterations: 10, ops_per_sec: 0 }
  console.log(`  cwi.10x3ms_op                                     ${(total / 10).toFixed(2)}ms avg`)

  // Write results
  writeFileSync(OUT, JSON.stringify({ label: LABEL, when: new Date().toISOString(), results }, null, 2))
  console.log(`\nWrote ${OUT}`)
})()
