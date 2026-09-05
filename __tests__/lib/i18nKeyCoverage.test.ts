import fs from 'node:fs'
import path from 'node:path'

/**
 * Every t('key') the app renders must exist in the merged catalogue — the
 * library's, plus the browser-only keys layered on in
 * context/i18n/browserTranslations.ts. A key in neither renders as the raw
 * string on screen, which is exactly what adopting the library's catalogue
 * could have caused for the 20 keys it does not ship.
 *
 * Reads the sources rather than importing them: the library's translations
 * module pulls expo-localization and react-native-localize at import time.
 */
const ROOT = path.resolve(__dirname, '../..')
const PKG_I18N = path.join(ROOT, 'node_modules/@bsv/expo-wallet-toolbox/core/i18n/translations.tsx')
const BROWSER_I18N = path.join(ROOT, 'context/i18n/browserTranslations.ts')

const SEARCH_DIRS = ['app', 'components', 'context', 'hooks', 'services', 'shared', 'storage', 'stores', 'utils']

/** `t('key')` / `i18n.t('key')`, but not `split(`, `at(`, `startsWith(`... */
const CALL = /(?<![A-Za-z0-9_$.])(?:i18n\.)?t\(\s*['"]([a-zA-Z0-9_]+)['"]/g
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT = /^\s*\/\/.*$/gm

function englishKeysOf(file: string): Set<string> {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const starts = lines.flatMap((l, i) => (/^ {2}[a-z]{2}: \{/.test(l) ? [i] : []))
  const body = starts.length > 1 ? lines.slice(starts[0], starts[1]) : lines
  return new Set(body.flatMap(l => l.match(/^ {4,6}([A-Za-z_][A-Za-z0-9_]*):/)?.slice(1) ?? []))
}

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) out.push(p)
    }
  }
  for (const d of SEARCH_DIRS) {
    const dir = path.join(ROOT, d)
    if (fs.existsSync(dir)) walk(dir)
  }
  return out
}

describe('i18n key coverage', () => {
  it('resolves every referenced key against the merged catalogue', () => {
    const catalogue = new Set([...englishKeysOf(PKG_I18N), ...englishKeysOf(BROWSER_I18N)])
    expect(catalogue.size).toBeGreaterThan(500)

    const missing: string[] = []
    for (const file of sourceFiles()) {
      const src = fs.readFileSync(file, 'utf8').replace(BLOCK_COMMENT, '').replace(LINE_COMMENT, '')
      for (const [, key] of src.matchAll(CALL)) {
        if (!catalogue.has(key)) missing.push(`${key} (${path.relative(ROOT, file)})`)
      }
    }
    expect(missing).toEqual([])
  })

  it('still carries the browser-only keys the library does not ship', () => {
    const browserKeys = englishKeysOf(BROWSER_I18N)
    for (const key of ['tx_action_copy_beef', 'tx_txid_copied', 'message_box_tap_to_configure']) {
      expect(browserKeys.has(key)).toBe(true)
    }
    expect(englishKeysOf(PKG_I18N).has('tx_action_copy_beef')).toBe(false)
  })
})
