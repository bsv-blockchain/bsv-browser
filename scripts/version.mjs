#!/usr/bin/env node
/**
 * Usage: npm run version <semver>
 * Example: npm run version 1.2.0
 *
 * Updates:
 *   - package.json  → "version"
 *   - app.json      → "expo.version"  (sets iOS CFBundleShortVersionString and Android versionName)
 *
 * Build numbers (iOS buildNumber / Android versionCode) are left untouched —
 * they are auto-incremented by EAS on each production build via "autoIncrement": true in eas.json.
 */

import { readFileSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const version = process.argv[2]

if (!version) {
  console.error('Error: no version supplied.\nUsage: npm run version <semver>')
  process.exit(1)
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Error: "${version}" is not a valid semver (expected x.y.z)`)
  process.exit(1)
}

function updateJson(filePath, updater) {
  const raw = readFileSync(filePath, 'utf8')
  const json = JSON.parse(raw)
  updater(json)
  writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n')
  console.log(`  updated ${filePath.replace(root + '/', '')}`)
}

console.log(`\nSetting version to ${version}...\n`)

updateJson(resolve(root, 'package.json'), json => {
  json.version = version
})

updateJson(resolve(root, 'app.json'), json => {
  json.expo.version = version
})

// Commit the version bump
execSync('git add package.json app.json', { cwd: root, stdio: 'inherit' })
execSync(`git commit -m "chore: bump version to ${version}"`, { cwd: root, stdio: 'inherit' })

// Create annotated tag (force-update if it already exists locally)
try {
  execSync(`git tag -a v${version} -m "Version ${version}"`, { cwd: root, stdio: 'inherit' })
} catch {
  // Tag exists — move it to the new commit
  execSync(`git tag -d v${version}`, { cwd: root, stdio: 'inherit' })
  execSync(`git tag -a v${version} -m "Version ${version}"`, { cwd: root, stdio: 'inherit' })
}

console.log(`\nDone. Committed and tagged v${version}.`)
console.log(`Run \`git push && git push --tags\` to push to remote.`)
