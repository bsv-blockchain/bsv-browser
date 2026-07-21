#!/usr/bin/env node
/**
 * Download UltrafastSecp256k1 v4.5.0 mobile prebuilts + ufsecp headers into vendor/.
 *
 * Layout after fetch:
 *   vendor/include/ufsecp/          — ufsecp.h (+ error/version)
 *   vendor/include/secp256k1/       — C++ headers (from iOS xcframework)
 *   vendor/ios/UltrafastSecp256k1.xcframework
 *   vendor/android/<abi>/lib/libfastsecp256k1.a
 *   vendor/.stamp                   — version marker
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync
} from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const VENDOR = path.join(ROOT, 'vendor')
const VERSION = '4.5.0'
const BASE = `https://github.com/shrec/UltrafastSecp256k1/releases/download/v${VERSION}`

const ASSETS = [
  { name: `UltrafastSecp256k1-v${VERSION}-ios-xcframework.tar.gz`, kind: 'ios' },
  {
    name: `UltrafastSecp256k1-v${VERSION}-android-arm64.tar.gz`,
    kind: 'android',
    abi: 'arm64-v8a'
  },
  {
    name: `UltrafastSecp256k1-v${VERSION}-android-armv7.tar.gz`,
    kind: 'android',
    abi: 'armeabi-v7a'
  },
  {
    name: `UltrafastSecp256k1-v${VERSION}-android-x64.tar.gz`,
    kind: 'android',
    abi: 'x86_64'
  },
  { name: `ufsecp-c-${VERSION}.tar.gz`, kind: 'headers' }
]

function stampPath() {
  return path.join(VENDOR, '.stamp')
}

function isComplete() {
  if (!existsSync(stampPath())) return false
  try {
    if (readFileSync(stampPath(), 'utf8').trim() !== VERSION) return false
  } catch {
    return false
  }
  const required = [
    path.join(VENDOR, 'include', 'ufsecp', 'ufsecp.h'),
    path.join(VENDOR, 'ios', 'UltrafastSecp256k1.xcframework', 'Info.plist'),
    path.join(VENDOR, 'android', 'arm64-v8a', 'lib', 'libfastsecp256k1.a')
  ]
  return required.every(p => existsSync(p))
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`)
  }
  await pipeline(res.body, createWriteStream(dest))
}

function extractTarGz(archive, destDir) {
  mkdirSync(destDir, { recursive: true })
  execFileSync('tar', ['-xzf', archive, '-C', destDir], { stdio: 'inherit' })
}

function firstMatchingDir(parent, predicate) {
  if (!existsSync(parent)) return null
  for (const name of readdirSync(parent)) {
    const full = path.join(parent, name)
    if (statSync(full).isDirectory() && predicate(name, full)) return full
  }
  return null
}

async function main() {
  const force = process.argv.includes('--force')
  if (!force && isComplete()) {
    console.log(`[native-secp256k1] vendor prebuilts already present (v${VERSION})`)
    return
  }

  console.log(`[native-secp256k1] fetching UltrafastSecp256k1 v${VERSION} prebuilts…`)
  mkdirSync(VENDOR, { recursive: true })

  const work = path.join(tmpdir(), `ufsecp-fetch-${randomBytes(4).toString('hex')}`)
  mkdirSync(work, { recursive: true })

  try {
    for (const asset of ASSETS) {
      const url = `${BASE}/${asset.name}`
      const archive = path.join(work, asset.name)
      console.log(`  ↓ ${asset.name}`)
      await download(url, archive)
      const extractTo = path.join(work, asset.kind + (asset.abi ? `-${asset.abi}` : ''))
      extractTarGz(archive, extractTo)

      if (asset.kind === 'ios') {
        const root = firstMatchingDir(extractTo, n => n.includes('ios-xcframework'))
        if (!root) throw new Error('iOS package root not found')
        const xcf = path.join(root, 'UltrafastSecp256k1.xcframework')
        if (!existsSync(xcf)) throw new Error('UltrafastSecp256k1.xcframework missing')
        rmSync(path.join(VENDOR, 'ios'), { recursive: true, force: true })
        mkdirSync(path.join(VENDOR, 'ios'), { recursive: true })
        cpSync(xcf, path.join(VENDOR, 'ios', 'UltrafastSecp256k1.xcframework'), {
          recursive: true
        })
        // C++ headers from device slice (platform-independent source headers)
        const headers = path.join(xcf, 'ios-arm64', 'Headers')
        if (existsSync(headers)) {
          for (const entry of readdirSync(headers)) {
            if (entry === 'module.modulemap') continue
            const src = path.join(headers, entry)
            const dest = path.join(VENDOR, 'include', entry)
            rmSync(dest, { recursive: true, force: true })
            cpSync(src, dest, { recursive: true })
          }
        }
        const ufInc = path.join(root, 'include', 'ufsecp')
        if (existsSync(ufInc)) {
          mkdirSync(path.join(VENDOR, 'include', 'ufsecp'), { recursive: true })
          cpSync(ufInc, path.join(VENDOR, 'include', 'ufsecp'), { recursive: true })
        }
      } else if (asset.kind === 'android') {
        const root = firstMatchingDir(extractTo, n => n.includes('android'))
        if (!root) throw new Error(`Android package root not found for ${asset.abi}`)
        const abiDir = path.join(VENDOR, 'android', asset.abi)
        rmSync(abiDir, { recursive: true, force: true })
        mkdirSync(path.join(abiDir, 'lib'), { recursive: true })
        const libA = path.join(root, 'lib', 'libfastsecp256k1.a')
        if (!existsSync(libA)) throw new Error(`libfastsecp256k1.a missing for ${asset.abi}`)
        cpSync(libA, path.join(abiDir, 'lib', 'libfastsecp256k1.a'))
        const jniSo = path.join(root, 'lib', 'libsecp256k1_jni.so')
        if (existsSync(jniSo)) {
          cpSync(jniSo, path.join(abiDir, 'lib', 'libsecp256k1_jni.so'))
        }
        const inc = path.join(root, 'include')
        if (existsSync(inc)) {
          cpSync(inc, path.join(abiDir, 'include'), { recursive: true })
        }
      } else if (asset.kind === 'headers') {
        const root = firstMatchingDir(extractTo, n => n.startsWith('ufsecp-c'))
        if (!root) throw new Error('ufsecp-c package root not found')
        const inc = path.join(root, 'include')
        mkdirSync(path.join(VENDOR, 'include', 'ufsecp'), { recursive: true })
        for (const f of readdirSync(inc)) {
          if (f.endsWith('.h')) {
            cpSync(path.join(inc, f), path.join(VENDOR, 'include', 'ufsecp', f))
          }
        }
      }
    }

    writeFileSync(stampPath(), VERSION + '\n')
    writeFileSync(
      path.join(VENDOR, 'README.md'),
      `# Vendor prebuilts (v${VERSION})

Downloaded by \`scripts/fetch-prebuilts.mjs\`. Do not commit large binaries.

- \`include/ufsecp/\` — C ABI headers
- \`include/secp256k1/\` (+ umbrella) — C++ headers for the mobile static library
- \`ios/UltrafastSecp256k1.xcframework\`
- \`android/<abi>/lib/libfastsecp256k1.a\`

Re-fetch: \`node modules/native-secp256k1/scripts/fetch-prebuilts.mjs --force\`
`
    )
    console.log(`[native-secp256k1] vendor ready at ${VENDOR}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

main().catch(err => {
  // Soft-fail: offline / network errors must not break `npm install`.
  // Native ECDSA needs vendor prebuilts; without them the app uses noble fallback.
  console.warn(
    '[native-secp256k1] WARNING: fetch-prebuilts failed — continuing without vendor prebuilts.'
  )
  console.warn(
    '[native-secp256k1] Offline install is OK; ECDSA will use @noble/secp256k1 until prebuilts are present and the native app is rebuilt.'
  )
  console.warn('[native-secp256k1] Re-run when online: npm run fetch-native-secp')
  console.warn(
    '[native-secp256k1]',
    err && typeof err === 'object' && 'message' in err ? err.message : err
  )
  process.exit(0)
})
