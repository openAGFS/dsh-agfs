#!/usr/bin/env node
/**
 * Release-rule helper: cut one tag-driven release every RELEASE_EVERY commits.
 *
 * Pushing a `v*` tag triggers the Publish workflow (.github/workflows/publish.yml)
 * to publish to npm, so tagging is the release action. To keep release noise
 * low, this script only acts once RELEASE_EVERY commits have accumulated on the
 * current branch since the last `v*` tag; below the threshold it prints the
 * progress and does nothing.
 *
 * At the threshold it bumps the patch version in package.json, commits the bump,
 * creates the `v<version>` tag, and pushes the branch and the tag.
 *
 * Usage:
 *   node scripts/release.mjs            # cut a release when due
 *   node scripts/release.mjs --dry-run  # preview without writing or pushing
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const RELEASE_EVERY = 10
const TAG_MATCH = 'v*'

const dryRun = process.argv.includes('--dry-run')

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
}

function step(message) {
  console.log(`[release] ${message}`)
}

// Require a clean tree so the version-bump commit stays isolated.
const dirty = git(['status', '--porcelain'])
if (dirty !== '') {
  console.error('[release] abort: working tree is not clean — commit or stash first:')
  console.error(dirty.split('\n').map(line => `  ${line}`).join('\n'))
  process.exit(1)
}

// Latest v* tag and the commit count since it (or since the start without tags).
let lastTag = ''
try {
  lastTag = git(['describe', '--tags', '--abbrev=0', '--match', TAG_MATCH])
} catch {
  // no tags yet — first release counts from the first commit
}
const count = lastTag === ''
  ? Number(git(['rev-list', '--count', 'HEAD']))
  : Number(git(['rev-list', '--count', `${lastTag}..HEAD`]))

if (count < RELEASE_EVERY) {
  step(`no release yet: ${count}/${RELEASE_EVERY} commits since ${lastTag === '' ? 'the start' : lastTag}`)
  step(`cut the next release when ${RELEASE_EVERY - count} more commit${RELEASE_EVERY - count === 1 ? '' : 's'} land (or run with --dry-run to preview).`)
  process.exit(0)
}

// Bump the patch version.
const pkgPath = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const [major, minor, patch] = pkg.version.split('.').map(Number)
if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
  console.error(`[release] abort: cannot parse version ${pkg.version}`)
  process.exit(1)
}
const next = `${major}.${minor}.${patch + 1}`
step(`cutting release v${next} (${count} commits since ${lastTag === '' ? 'the start' : lastTag})`)

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
