#!/usr/bin/env node
/**
 * Manual release helper: show release state by default; cut a tag-driven
 * release only when explicitly asked.
 *
 * Pushing a `v*` tag triggers the Publish workflow (.github/workflows/publish.yml)
 * to publish to npm, so tagging is the release action. This script NEVER tags
 * on its own — the maintainer decides when. Without flags it only reports the
 * current state; `--do` (optionally with `--version <x.y.z>`) bumps the
 * version, commits the bump, creates the `v<version>` tag, and pushes the
 * branch and the tag.
 *
 * Usage:
 *   node scripts/release.mjs                 # report state only (no writes)
 *   node scripts/release.mjs --do            # cut a release now (patch bump)
 *   node scripts/release.mjs --do --version 0.2.0   # cut a release at a chosen version
 *   node scripts/release.mjs --do --dry-run  # preview without writing or pushing
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const TAG_MATCH = 'v*'
const args = new Set(process.argv.slice(2))
const doRelease = args.has('--do')
const dryRun = args.has('--dry-run')
const versionIndex = [...args].indexOf('--version')
const requestedVersion = versionIndex >= 0 ? [...args][versionIndex + 1] : undefined

function git(gitArgs, opts = {}) {
  return execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
}

function step(message) {
  console.log(`[release] ${message}`)
}

const pkgPath = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const [major, minor, patch] = pkg.version.split('.').map(Number)
if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
  console.error(`[release] abort: cannot parse version ${pkg.version}`)
  process.exit(1)
}

// Latest v* tag and the commit count since it (or since the start without tags).
let lastTag = ''
try {
  lastTag = git(['describe', '--tags', '--abbrev=0', '--match', TAG_MATCH])
} catch {
  // no tags yet — the count starts from the first commit
}
const count = lastTag === ''
  ? Number(git(['rev-list', '--count', 'HEAD']))
  : Number(git(['rev-list', '--count', `${lastTag}..HEAD`]))

if (!doRelease) {
  step(`current version ${pkg.version}; last tag ${lastTag === '' ? '(none)' : lastTag}; ${count} commit${count === 1 ? '' : 's'} since then`)
  step(`cut a release manually when ready: node scripts/release.mjs --do (or --do --version <x.y.z>)`)
  step(`this script never tags automatically.`)
  process.exit(0)
}

// Manual release: require a clean tree so the version-bump commit stays isolated.
const dirty = git(['status', '--porcelain'])
if (dirty !== '') {
  console.error('[release] abort: working tree is not clean — commit or stash first:')
  console.error(dirty.split('\n').map(line => `  ${line}`).join('\n'))
  process.exit(1)
}

const next = requestedVersion !== undefined
  ? requestedVersion.replace(/^v/, '')
  : `${major}.${minor}.${patch + 1}`
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error(`[release] abort: invalid version ${JSON.stringify(next)} (expected x.y.z)`)
  process.exit(1)
}
step(`cutting release v${next} (${count} commit${count === 1 ? '' : 's'} since ${lastTag === '' ? 'the start' : lastTag})`)

if (dryRun) {
  step(`dry-run: would bump package.json to ${next}, commit "chore: release v${next}", tag v${next}, push branch + tag.`)
  process.exit(0)
}

const updated = `${JSON.stringify({ ...pkg, version: next }, null, 2)}\n`
writeFileSync(pkgPath, updated)
git(['add', 'package.json'])
git(['commit', '-m', `chore: release v${next}`])
git(['tag', `v${next}`])
git(['push', 'origin', 'HEAD'])
git(['push', 'origin', `v${next}`])
step(`pushed main + tag v${next}; the Publish workflow publishes @open-agfs/dsh-agfs@${next} to npm.`)
