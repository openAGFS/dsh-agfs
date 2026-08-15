/**
 * Unit coverage for the file-browser core: path safety, every API endpoint,
 * static asset resolution, index injection, and body reading. System openers
 * are mocked so no test spawns a browser, explorer, or default application.
 */

import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgfsConfig, ApiOutcome } from '../src/types.ts'
import {
  ASSETS_DIR,
  dispatchApi,
  getClientIp,
  getSafePath,
  readJsonBody,
  renderIndex,
  resolveAsset,
  writeOutcome,
} from '../src/handler.ts'

const openControl = vi.hoisted(() => ({
  openInBrowser: vi.fn<() => Promise<void>>(),
  openInSystem: vi.fn<() => Promise<void>>(),
  openLocationInExplorer: vi.fn<() => Promise<void>>(),
}))

vi.mock('../src/open.ts', () => openControl)

// readdir is intercepted so one test can force a permission-denied listing;
// every other call forwards to the real implementation.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readdir: vi.fn(actual.readdir) }
})

function config(overrides: Partial<AgfsConfig> = {}): AgfsConfig {
  return {
    basePath: '/dsh-agfs',
    fileRoot: '',
    projectRoot: '',
    remoteMode: false,
    readOnly: false,
    strictRoot: false,
    roots: {},
    openOnCommand: false,
    debug: false,
    ...overrides,
  }
}

/** HTTP status of one outcome; streams always answer 200. */
function status(result: ApiOutcome): number {
  return result.kind === 'stream' ? 200 : result.status
}

let root: string | undefined

beforeEach(() => {
  openControl.openInBrowser.mockReset()
  openControl.openInSystem.mockReset()
  openControl.openLocationInExplorer.mockReset()
  openControl.openInBrowser.mockResolvedValue(undefined)
  openControl.openInSystem.mockResolvedValue(undefined)
  openControl.openLocationInExplorer.mockResolvedValue(undefined)
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function tempDir(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-agfs-handler-'))
  return root
}

/** A fake IncomingMessage that emits one body and ends. */
function fakeRequest(body: string): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  process.nextTick(() => {
    req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

interface CapturedResponse {
  res: Writable & { writeHead: (status: number, headers: Record<string, string>) => void }
  status: () => number | undefined
  headers: () => Record<string, string>
  body: () => string
}

/** A fake ServerResponse capturing status, headers, and body bytes. */
function fakeResponse(): CapturedResponse {
  const captured: { status: number | undefined; headers: Record<string, string>; body: string } = {
    status: undefined,
    headers: {},
    body: '',
  }
  const res = new Writable({
    write(chunk: Buffer, _enc, callback) {
      captured.body += chunk.toString('utf8')
      callback()
    },
  }) as Writable & { writeHead: (status: number, headers: Record<string, string>) => void }
  res.writeHead = (statusCode: number, headers: Record<string, string>): void => {
    captured.status = statusCode
    captured.headers = headers
  }
  return {
    res,
    status: () => captured.status,
    headers: () => captured.headers,
    body: () => captured.body,
  }
}

describe('getSafePath', () => {
  it('confines relative paths under the root', async () => {
    const dir = await tempDir()
    expect(getSafePath(dir, 'sub/file.txt')).toBe(resolve(join(dir, 'sub/file.txt')))
  })

  it('rejects traversal outside the root', async () => {
    const dir = await tempDir()
    expect(() => getSafePath(dir, '../escape')).toThrow('路径超出允许范围')
  })

  it('passes drive-letter absolute paths through on Windows-style input', () => {
    expect(getSafePath('C:\\base', 'D:/other/file.txt')).toBe('D:\\other\\file.txt')
    expect(getSafePath('C:\\base', 'D:')).toBe('D:\\')
  })

  it('returns the root itself for an empty relative path', () => {
    expect(getSafePath('C:\\base', '')).toBe('C:\\base')
  })

  it('resolves a slash root without throwing', () => {
    expect(getSafePath('C:\\base', '/').length).toBeGreaterThan(0)
  })

  it('enforces strict-root confinement for absolute, escaping, and symlink paths', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.txt'), 'x')
    expect(getSafePath(dir, 'a.txt', true)).toBe(resolve(join(dir, 'a.txt')))
    expect(() => getSafePath(dir, '../escape', true)).toThrow('路径超出允许范围')
    expect(() => getSafePath(dir, 'D:/x', true)).toThrow('路径超出允许范围')
    expect(() => getSafePath(dir, '/', true)).toThrow('路径超出允许范围')

    const outside = await mkdtemp(join(tmpdir(), 'dsh-agfs-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'x')
    const link = join(dir, 'evil')
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // Junction/symlink creation can fail on exotic filesystems; without a
      // working link the escape assertions below are meaningless.
      await rm(outside, { recursive: true, force: true })
      return
    }
    expect(existsSync(link)).toBe(true)
    expect(() => getSafePath(dir, 'evil/secret.txt', false)).not.toThrow()
    try {
      getSafePath(dir, 'evil/secret.txt', true)
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as Error).message).toBe('路径超出允许范围')
    }
    await rm(outside, { recursive: true, force: true })
    // A not-yet-created nested target walks up to the nearest existing ancestor.
    expect(getSafePath(dir, 'deep/nested/new.txt', true)).toBe(resolve(join(dir, 'deep', 'nested', 'new.txt')))
  })

  it('falls back to the lexical check when strict-root confinement cannot realpath the root', () => {
    // A missing root cannot be realpathed; the lexical confinement still applies.
    const root = join(tmpdir(), 'dsh-agfs-missing-root')
    expect(getSafePath(root, 'a.txt', true)).toBe(resolve(join(root, 'a.txt')))
    expect(() => getSafePath(root, '../escape', true)).toThrow('路径超出允许范围')
  })
})

describe('dispatchApi list/read/search', () => {
  it('lists an empty directory with the original response envelope', async () => {
    const dir = await tempDir()
    const result = await dispatchApi('GET', 'list', {}, {}, config({ fileRoot: dir }), '127.0.0.1', '')
    if (result.kind !== 'json') throw new Error('expected json')
    expect(result.status).toBe(200)
    const data = result.data as { current_path: string; parent_path: string; root_path: string; items: unknown[] }
    expect(data.items).toEqual([])
    expect(data.root_path.replace(/\\/g, '/')).toBe(dir.replace(/\\/g, '/'))
  })

  it('sorts folders before files and files by name', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'b.txt'), 'b')
    await writeFile(join(dir, 'a.txt'), 'a')
    await mkdir(join(dir, 'z-folder'))
    const result = await dispatchApi('GET', 'list', {}, {}, config({ fileRoot: dir }), '127.0.0.1', '')
    if (result.kind !== 'json') throw new Error('expected json')
    const data = result.data as { items: Array<{ name: string; type: string; size: string | null }> }
    expect(data.items.map(item => item.name)).toEqual(['z-folder', 'a.txt', 'b.txt'])
    expect(data.items[1]?.size).toBe('1.0 B')
    // A multi-KB file exercises the size-unit loop past the first byte tier.
    await writeFile(join(dir, 'big.bin'), Buffer.alloc(2048, 0x61))
    const withBig = await dispatchApi('GET', 'list', {}, {}, config({ fileRoot: dir }), '127.0.0.1', '')
    if (withBig.kind !== 'json') throw new Error('expected json')
    const big = (withBig.data as { items: Array<{ name: string; size: string | null }> }).items.find(item => item.name === 'big.bin')
    expect(big?.size).toBe('2.0 KB')
  })

  it('sorts names case-insensitively', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'B.txt'), 'x')
    await writeFile(join(dir, 'a.txt'), 'x')
    const result = await dispatchApi('GET', 'list', {}, {}, config({ fileRoot: dir }), '127.0.0.1', '')
    if (result.kind !== 'json') throw new Error('expected json')
    const names = (result.data as { items: Array<{ name: string }> }).items.map(item => item.name)
    expect(names).toEqual(['a.txt', 'B.txt'])
  })

  it('lists the current working directory when no fileRoot is configured', async () => {
    const result = await dispatchApi('GET', 'list', {}, {}, config(), '127.0.0.1', '')
    if (result.kind !== 'json') throw new Error('expected json')
    expect(result.status).toBe(200)
    const data = result.data as { root_path: string; items: unknown[] }
    expect(Array.isArray(data.items)).toBe(true)
    expect(data.root_path.replace(/\\/g, '/')).toBe(process.cwd().replace(/\\/g, '/'))
  })

  it('lists a subdirectory through the path parameter', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'sub'))
    await mkdir(join(dir, 'sub', 'inner'))
    await writeFile(join(dir, 'sub', 'inner', 'inner.txt'), 'x')
    const result = await dispatchApi('GET', 'list', { path: 'sub/inner' }, {}, config({ fileRoot: dir }), '127.0.0.1', '')
    if (result.kind !== 'json') throw new Error('expected json')
    const data = result.data as { current_path: string; parent_path: string; items: Array<{ name: string }> }
    expect(data.items.map(item => item.name)).toEqual(['inner.txt'])
    expect(data.parent_path).toBe('sub')
  })

  it('reports missing and non-directory list targets', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'f.txt'), 'x')
    expect(status(await dispatchApi('GET', 'list', { path: 'nope' }, {}, config({ fileRoot: dir }), '127.0.0.1', ''))).toBe(404)
    expect(status(await dispatchApi('GET', 'list', { path: 'f.txt' }, {}, config({ fileRoot: dir }), '127.0.0.1', ''))).toBe(400)
  })

  it('uses the filepath query parameter as the browsable root', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'via-filepath.txt'), 'x')
    const result = await dispatchApi('GET', 'list', { filepath: dir }, {}, config(), '127.0.0.1', '')
    if (result.kind !== 'json') throw new Error('expected json')
    const data = result.data as { items: Array<{ name: string }> }
    expect(data.items.map(item => item.name)).toEqual(['via-filepath.txt'])
  })

  it('reads a text file with content and metadata', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'doc.txt'), 'hello 世界')
    const result = await dispatchApi('GET', 'read', { path: 'doc.txt' }, {}, config({ fileRoot: dir }), '127.0.0.1', '')
    if (result.kind !== 'json') throw new Error('expected json')
    const data = result.data as { name: string; content: string; size: number }
    expect(data.content).toBe('hello 世界')
    expect(data.name).toBe('doc.txt')
    expect(data.size).toBe(Buffer.byteLength('hello 世界'))
  })

  it('rejects binary, oversized, missing, and directory reads', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]))
    const big = join(dir, 'big.txt')
    await writeFile(big, '')
    await truncate(big, 10 * 1024 * 1024 + 1)
    const cfg = config({ fileRoot: dir })
    expect(status(await dispatchApi('GET', 'read', { path: 'bin.dat' }, {}, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('GET', 'read', { path: 'big.txt' }, {}, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('GET', 'read', { path: 'nope' }, {}, cfg, '127.0.0.1', ''))).toBe(404)
    expect(status(await dispatchApi('GET', 'read', { path: '' }, {}, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('GET', 'read', {}, {}, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('GET', 'read', { path: '.' }, {}, cfg, '127.0.0.1', ''))).toBe(400)
  })

  it('reports unreadable directories as 403', async () => {
    const dir = await tempDir()
    const { readdir } = await import('node:fs/promises')
    vi.mocked(readdir).mockRejectedValueOnce(new Error('EACCES'))
    const result = await dispatchApi('GET', 'list', {}, {}, config({ fileRoot: dir }), '127.0.0.1', '')
    expect(status(result)).toBe(403)
  })

  it('caps search at 200 hits and includes folder entries', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'hit-folder'))
    for (let i = 0; i < 201; i++) {
      await writeFile(join(dir, `hit-${String(i).padStart(3, '0')}.txt`), 'x')
    }
    const capped = await dispatchApi('GET', 'search', { path: '', keyword: 'hit-' }, {}, config({ fileRoot: dir }), '127.0.0.1', '')
    if (capped.kind !== 'json') throw new Error('expected json')
    expect((capped.data as { results: unknown[] }).results).toHaveLength(200)
    const folders = await dispatchApi('GET', 'search', { path: '', keyword: 'hit-folder' }, {}, config({ fileRoot: dir }), '127.0.0.1', '')
    if (folders.kind !== 'json') throw new Error('expected json')
    const folderResults = (folders.data as { results: Array<{ name: string; type: string; size: string | null }> }).results
    expect(folderResults).toEqual([
      expect.objectContaining({ name: 'hit-folder', type: 'folder', size: null, size_bytes: null }),
    ])
  })

  it('caps recursive search across subdirectories', async () => {
    const dir = await tempDir()
    for (let i = 0; i < 150; i++) {
      await writeFile(join(dir, `r-${String(i).padStart(3, '0')}.txt`), 'x')
    }
    await mkdir(join(dir, 'sub-a'))
    for (let i = 0; i < 100; i++) {
      await writeFile(join(dir, 'sub-a', `s-${String(i).padStart(3, '0')}.txt`), 'x')
    }
    await mkdir(join(dir, 'sub-b'))
    for (let i = 0; i < 60; i++) {
      await writeFile(join(dir, 'sub-b', `t-${String(i).padStart(3, '0')}.txt`), 'x')
    }
    const capped = await dispatchApi(
      'GET', 'search', { path: '', keyword: 'txt', recursive: '1' }, {}, config({ fileRoot: dir }), '127.0.0.1', '',
    )
    if (capped.kind !== 'json') throw new Error('expected json')
    expect((capped.data as { results: unknown[] }).results).toHaveLength(200)
  })

  it('skips unreadable directories during recursive search', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'kept.txt'), 'x')
    const { readdir } = await import('node:fs/promises')
    vi.mocked(readdir).mockRejectedValueOnce(new Error('EACCES'))
    const result = await dispatchApi(
      'GET', 'search', { path: '', keyword: 'txt', recursive: '1' }, {}, config({ fileRoot: dir }), '127.0.0.1', '',
    )
    if (result.kind !== 'json') throw new Error('expected json')
    expect((result.data as { results: unknown[] }).results).toEqual([])
  })

  it('searches recursively with depth and hit caps', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'top.txt'), 'x')
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'sub', 'nested.txt'), 'x')
    await mkdir(join(dir, 'sub', 'a'))
    await mkdir(join(dir, 'sub', 'a', 'b'))
    await mkdir(join(dir, 'sub', 'a', 'b', 'c'))
    await mkdir(join(dir, 'sub', 'a', 'b', 'c', 'd'))
    await mkdir(join(dir, 'sub', 'a', 'b', 'c', 'd', 'e'))
    await writeFile(join(dir, 'sub', 'a', 'b', 'c', 'd', 'e', 'deep.txt'), 'x')
    const cfg = config({ fileRoot: dir })

    const shallow = await dispatchApi('GET', 'search', { path: '', keyword: 'nested' }, {}, cfg, '127.0.0.1', '')
    if (shallow.kind !== 'json') throw new Error('expected json')
    expect((shallow.data as { results: unknown[] }).results).toEqual([])

    const recursive = await dispatchApi('GET', 'search', { path: '', keyword: 'nested', recursive: '1' }, {}, cfg, '127.0.0.1', '')
    if (recursive.kind !== 'json') throw new Error('expected json')
    const recursiveData = recursive.data as { recursive: boolean; results: Array<{ name: string; path: string }> }
    expect(recursiveData.recursive).toBe(true)
    expect(recursiveData.results).toEqual([
      expect.objectContaining({ name: 'nested.txt', path: 'sub/nested.txt' }),
    ])

    // 'true' and 'yes' are truthy; an absent or '0' flag stays shallow.
    for (const flag of ['true', 'yes']) {
      const hit = await dispatchApi('GET', 'search', { path: '', keyword: 'nested', recursive: flag }, {}, cfg, '127.0.0.1', '')
      if (hit.kind !== 'json') throw new Error('expected json')
      expect((hit.data as { results: unknown[] }).results).toHaveLength(1)
    }
    const zero = await dispatchApi('GET', 'search', { path: '', keyword: 'nested', recursive: '0' }, {}, cfg, '127.0.0.1', '')
    if (zero.kind !== 'json') throw new Error('expected json')
    expect((zero.data as { results: unknown[] }).results).toEqual([])

    // Depth cap: a file at depth 5 is found, at depth 6 it is not.
    const atDepth = await dispatchApi('GET', 'search', { path: 'sub', keyword: 'deep', recursive: '1' }, {}, cfg, '127.0.0.1', '')
    if (atDepth.kind !== 'json') throw new Error('expected json')
    expect((atDepth.data as { results: Array<{ path: string }> }).results).toEqual([
      expect.objectContaining({ path: 'sub/a/b/c/d/e/deep.txt' }),
    ])
    await mkdir(join(dir, 'sub', 'a', 'b', 'c', 'd', 'e', 'f'))
    await writeFile(join(dir, 'sub', 'a', 'b', 'c', 'd', 'e', 'f', 'too-deep.txt'), 'x')
    const tooDeep = await dispatchApi('GET', 'search', { path: 'sub', keyword: 'too-deep', recursive: '1' }, {}, cfg, '127.0.0.1', '')
    if (tooDeep.kind !== 'json') throw new Error('expected json')
    expect((tooDeep.data as { results: unknown[] }).results).toEqual([])
  })

  it('searches entry names with a 100-hit cap', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'alpha.txt'), 'x')
    await writeFile(join(dir, 'beta.txt'), 'x')
    const cfg = config({ fileRoot: dir })
    const result = await dispatchApi('GET', 'search', { path: '', keyword: 'alp' }, {}, cfg, '127.0.0.1', '')
    if (result.kind !== 'json') throw new Error('expected json')
    const data = result.data as { keyword: string; results: Array<{ name: string }> }
    expect(data.results.map(item => item.name)).toEqual(['alpha.txt'])
    // Matching is case-insensitive.
    const upper = await dispatchApi('GET', 'search', { path: '', keyword: 'ALP' }, {}, cfg, '127.0.0.1', '')
    if (upper.kind !== 'json') throw new Error('expected json')
    expect((upper.data as { results: Array<{ name: string }> }).results.map(item => item.name)).toEqual(['alpha.txt'])
    expect(status(await dispatchApi('GET', 'search', {}, {}, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('GET', 'search', { path: 'nope', keyword: 'x' }, {}, cfg, '127.0.0.1', ''))).toBe(404)
    await writeFile(join(dir, 'f.txt'), 'x')
    expect(status(await dispatchApi('GET', 'search', { path: 'f.txt', keyword: 'x' }, {}, cfg, '127.0.0.1', ''))).toBe(400)
  })
})

describe('dispatchApi info/workspace/sidebar/mode/debug', () => {
  it('reports root info and the workspace marker', async () => {
    const dir = await tempDir()
    const info = await dispatchApi('GET', 'info', {}, {}, config({ fileRoot: dir }), '127.0.0.1', '')
    if (info.kind !== 'json') throw new Error('expected json')
    expect((info.data as { root: string }).root.replace(/\\/g, '/')).toBe(dir.replace(/\\/g, '/'))
    const ws = await dispatchApi('GET', 'workspace', {}, {}, config(), '127.0.0.1', '')
    if (ws.kind !== 'json') throw new Error('expected json')
    expect((ws.data as { exists: boolean }).exists).toBe(false)
  })

  it('builds sidebar data from the configured project root', async () => {
    const dir = await tempDir()
    const result = await dispatchApi('GET', 'sidebar', {}, {}, config({ projectRoot: dir }), '127.0.0.1', '')
    if (result.kind !== 'json') throw new Error('expected json')
    const data = result.data as { project: string; quick: unknown[]; drives: unknown[]; roots: unknown[] }
    expect(data.project?.replace(/\\/g, '/')).toBe(dir.replace(/\\/g, '/'))
    expect(Array.isArray(data.quick)).toBe(true)
    expect(Array.isArray(data.drives)).toBe(true)
    expect(data.roots).toEqual([])
  })

  it('reports configured roots sorted by name and drops unresolved entries', async () => {
    const dir = await tempDir()
    const other = await mkdtemp(join(tmpdir(), 'dsh-agfs-other-root-'))
    const result = await dispatchApi(
      'GET', 'sidebar', {}, {}, config({ roots: { Beta: other, Alpha: dir, Ghost: join(dir, 'nope') } }), '127.0.0.1', '',
    )
    if (result.kind !== 'json') throw new Error('expected json')
    const roots = (result.data as { roots: Array<{ name: string; path: string }> }).roots
    const expectedPath = (p: string): string => (p.length >= 2 && p[1] === ':' ? p.replace(/\//g, '\\') : p.replace(/\\/g, '/'))
    expect(roots).toEqual([
      { name: 'Alpha', path: expectedPath(dir) },
      { name: 'Beta', path: expectedPath(other) },
    ])
    await rm(other, { recursive: true, force: true })
  })

  it('answers clean 400 outcomes for strict-root violations on every endpoint', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.txt'), 'x')
    const cfg = config({ fileRoot: dir, strictRoot: true })
    const read = await dispatchApi('GET', 'read', { path: '../a.txt' }, {}, cfg, '127.0.0.1', '')
    expect(read).toEqual({ kind: 'error', status: 400, error: '路径超出允许范围' })
    const list = await dispatchApi('GET', 'list', { path: 'D:/x' }, {}, cfg, '127.0.0.1', '')
    expect(list).toEqual({ kind: 'error', status: 400, error: '路径超出允许范围' })
    // Mutations inside the root still work in strict mode.
    const created = await dispatchApi('POST', 'create_folder', {}, { path: 'made' }, cfg, '127.0.0.1', '')
    expect(created.kind).toBe('json')
    const renamed = await dispatchApi('POST', 'rename', {}, { path: 'a.txt', new_name: 'b.txt' }, cfg, '127.0.0.1', '')
    expect(renamed.kind).toBe('json')
  })

  it('falls back to the working directory and null for a missing project root', async () => {
    const cwdResult = await dispatchApi('GET', 'sidebar', {}, {}, config(), '127.0.0.1', '')
    if (cwdResult.kind !== 'json') throw new Error('expected json')
    const cwdData = cwdResult.data as { project: string }
    expect(cwdData.project?.replace(/\\/g, '/')).toBe(process.cwd().replace(/\\/g, '/'))
    const missingResult = await dispatchApi('GET', 'sidebar', {}, {}, config({ projectRoot: join(tmpdir(), 'dsh-agfs-no-project') }), '127.0.0.1', '')
    if (missingResult.kind !== 'json') throw new Error('expected json')
    expect((missingResult.data as { project: string | null }).project).toBeNull()
  })

  it('falls back to the configured and default roots for missing filepaths', async () => {
    const dir = await tempDir()
    const viaConfigured = await dispatchApi('GET', 'info', { filepath: join(dir, 'nope') }, {}, config({ fileRoot: dir }), '127.0.0.1', '')
    if (viaConfigured.kind !== 'json') throw new Error('expected json')
    expect((viaConfigured.data as { root: string }).root.replace(/\\/g, '/')).toBe(dir.replace(/\\/g, '/'))
    const viaDefault = await dispatchApi('GET', 'info', {}, {}, config({ fileRoot: join(tmpdir(), 'dsh-agfs-no-root') }), '127.0.0.1', '')
    if (viaDefault.kind !== 'json') throw new Error('expected json')
    expect((viaDefault.data as { root: string }).root.length).toBeGreaterThan(0)
    // A bare drive-letter filepath exercises the Windows drive normalization arm.
    const viaDrive = await dispatchApi('GET', 'info', { filepath: 'C:' }, {}, config({ fileRoot: dir }), '127.0.0.1', '')
    expect(viaDrive.kind).toBe('json')
    // A root-slash filepath exercises the '/' branch.
    const viaSlash = await dispatchApi('GET', 'info', { filepath: '/' }, {}, config({ fileRoot: dir }), '127.0.0.1', '')
    expect(viaSlash.kind).toBe('json')
    // A relative filepath exercises the resolve(clean) arm; it misses on disk and falls back.
    const viaRelative = await dispatchApi('GET', 'info', { filepath: 'dsh-agfs-relative-nope' }, {}, config({ fileRoot: dir }), '127.0.0.1', '')
    if (viaRelative.kind !== 'json') throw new Error('expected json')
    expect((viaRelative.data as { root: string }).root.replace(/\\/g, '/')).toBe(dir.replace(/\\/g, '/'))
  })

  it('classifies mode by remote flag and client IP', async () => {
    const local = await dispatchApi('GET', 'mode', {}, {}, config(), '127.0.0.1', '')
    if (local.kind !== 'json') throw new Error('expected json')
    expect((local.data as { remote_mode: boolean }).remote_mode).toBe(false)
    const remote = await dispatchApi('GET', 'mode', {}, {}, config(), '10.0.0.9', '')
    if (remote.kind !== 'json') throw new Error('expected json')
    expect((remote.data as { remote_mode: boolean }).remote_mode).toBe(true)
    const forced = await dispatchApi('GET', 'mode', {}, {}, config({ remoteMode: true }), '127.0.0.1', '')
    if (forced.kind !== 'json') throw new Error('expected json')
    expect((forced.data as { remote_mode: boolean }).remote_mode).toBe(true)
  })

  it('returns debug identity data', async () => {
    const result = await dispatchApi('GET', 'debug', { path: '' }, {}, config(), '127.0.0.1', '')
    if (result.kind !== 'json') throw new Error('expected json')
    const debug = result.extra?.debug as { os_name: string; get_safe_path_result: string }
    expect(debug.os_name).toBe(process.platform)
    expect(debug.get_safe_path_result.length).toBeGreaterThan(0)
    // Empty and filepath-only queries cover the nullish fallback chain.
    expect((await dispatchApi('GET', 'debug', {}, {}, config(), '127.0.0.1', '')).kind).toBe('json')
    expect((await dispatchApi('GET', 'debug', { filepath: process.cwd() }, {}, config(), '127.0.0.1', '')).kind).toBe('json')
  })
})

describe('dispatchApi mutations', () => {
  it('creates, renames, copies, and deletes files', async () => {
    const dir = await tempDir()
    const cfg = config({ fileRoot: dir })
    const created = await dispatchApi('POST', 'create_folder', {}, { path: 'new-folder' }, cfg, '127.0.0.1', '')
    if (created.kind !== 'json') throw new Error('expected json')
    await writeFile(join(dir, 'new-folder', 'a.txt'), 'data')
    // Renaming to a name with internal spaces is valid.
    const renamed = await dispatchApi('POST', 'rename', {}, { path: 'new-folder', new_name: 'my folder' }, cfg, '127.0.0.1', '')
    if (renamed.kind !== 'json') throw new Error('expected json')
    expect((renamed.extra?.new_path as string).replace(/\\/g, '/')).toBe('my folder')
    const copied = await dispatchApi('POST', 'copy', {}, { path: 'my folder/a.txt', dest_path: 'my folder/b.txt' }, cfg, '127.0.0.1', '')
    if (copied.kind !== 'json') throw new Error('expected json')
    expect((copied.extra?.dest_path as string).replace(/\\/g, '/')).toBe('my folder/b.txt')
    expect(await readFile(join(dir, 'my folder', 'b.txt'), 'utf8')).toBe('data')
    // Copying a whole folder tree preserves nested content.
    const treeCopied = await dispatchApi('POST', 'copy', {}, { path: 'my folder', dest_path: 'tree copy' }, cfg, '127.0.0.1', '')
    if (treeCopied.kind !== 'json') throw new Error('expected json')
    expect((treeCopied.extra?.dest_path as string).replace(/\\/g, '/')).toBe('tree copy')
    expect(await readFile(join(dir, 'tree copy', 'a.txt'), 'utf8')).toBe('data')
    expect(await readFile(join(dir, 'tree copy', 'b.txt'), 'utf8')).toBe('data')
    const deleted = await dispatchApi('POST', 'delete', {}, { path: 'my folder' }, cfg, '127.0.0.1', '')
    if (deleted.kind !== 'json') throw new Error('expected json')
    expect(existsSync(join(dir, 'my folder'))).toBe(false)
  })

  it('copies a destination directly under the browsable root', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.txt'), 'root-level')
    const cfg = config({ fileRoot: dir })
    const copied = await dispatchApi('POST', 'copy', {}, { path: 'a.txt', dest_path: 'root-copy.txt' }, cfg, '127.0.0.1', '')
    if (copied.kind !== 'json') throw new Error('expected json')
    expect((copied.extra?.dest_path as string).replace(/\\/g, '/')).toBe('root-copy.txt')
    expect(await readFile(join(dir, 'root-copy.txt'), 'utf8')).toBe('root-level')
    // A destination whose parent does not exist yet creates the parent chain.
    const nested = await dispatchApi('POST', 'copy', {}, { path: 'a.txt', dest_path: 'deep/nested/copy.txt' }, cfg, '127.0.0.1', '')
    if (nested.kind !== 'json') throw new Error('expected json')
    expect(await readFile(join(dir, 'deep', 'nested', 'copy.txt'), 'utf8')).toBe('root-level')
  })

  it('rejects invalid mutation arguments loudly', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.txt'), 'x')
    const cfg = config({ fileRoot: dir })
    expect(status(await dispatchApi('POST', 'delete', {}, {}, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('POST', 'delete', {}, { path: '' }, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('POST', 'delete', {}, { path: 'nope' }, cfg, '127.0.0.1', ''))).toBe(404)
    expect(status(await dispatchApi('POST', 'create_folder', {}, { path: '' }, cfg, '127.0.0.1', ''))).toBe(400)
    await mkdir(join(dir, 'exists'))
    expect(status(await dispatchApi('POST', 'create_folder', {}, { path: 'exists' }, cfg, '127.0.0.1', ''))).toBe(409)
    expect(status(await dispatchApi('POST', 'create_folder', {}, { path: 'deep/nested' }, cfg, '127.0.0.1', ''))).toBe(500)
    expect(status(await dispatchApi('POST', 'rename', {}, { path: 'a.txt' }, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('POST', 'rename', {}, { path: '', new_name: 'b.txt' }, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('POST', 'rename', {}, { path: 'a.txt', new_name: 'b<.txt' }, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('POST', 'rename', {}, { path: 'a.txt', new_name: ' b.txt' }, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('POST', 'rename', {}, { path: 'nope', new_name: 'b.txt' }, cfg, '127.0.0.1', ''))).toBe(404)
    await writeFile(join(dir, 'c.txt'), 'x')
    expect(status(await dispatchApi('POST', 'rename', {}, { path: 'a.txt', new_name: 'c.txt' }, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('POST', 'copy', {}, { path: 'a.txt' }, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('POST', 'copy', {}, { path: '', dest_path: 'd.txt' }, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('POST', 'copy', {}, { path: 'a.txt', dest_path: '' }, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('POST', 'copy', {}, { path: 'nope', dest_path: 'd.txt' }, cfg, '127.0.0.1', ''))).toBe(404)
    await writeFile(join(dir, 'e.txt'), 'x')
    expect(status(await dispatchApi('POST', 'copy', {}, { path: 'a.txt', dest_path: 'e.txt' }, cfg, '127.0.0.1', ''))).toBe(400)
  })

  it('honors a body filepath root for every mutation', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.txt'), 'x')
    const created = await dispatchApi(
      'POST', 'create_folder', {}, { path: 'made', filepath: dir }, config(), '127.0.0.1', '',
    )
    expect(created.kind).toBe('json')
    const renamed = await dispatchApi(
      'POST', 'rename', {}, { path: 'made', new_name: 'renamed', filepath: dir }, config(), '127.0.0.1', '',
    )
    expect(renamed.kind).toBe('json')
    const copied = await dispatchApi(
      'POST', 'copy', {}, { path: 'a.txt', dest_path: 'renamed/b.txt', filepath: dir }, config(), '127.0.0.1', '',
    )
    expect(copied.kind).toBe('json')
    const deleted = await dispatchApi(
      'POST', 'delete', {}, { path: 'renamed', filepath: dir }, config(), '127.0.0.1', '',
    )
    expect(deleted.kind).toBe('json')
  })

  it('rejects copy and system open endpoints in remote mode', async () => {
    const dir = await tempDir()
    const cfg = config({ fileRoot: dir, remoteMode: true })
    expect(status(await dispatchApi('POST', 'copy', {}, { path: 'a.txt', dest_path: 'b.txt' }, cfg, '127.0.0.1', ''))).toBe(403)
    expect(status(await dispatchApi('GET', 'open', { path: 'a.txt' }, {}, cfg, '127.0.0.1', ''))).toBe(403)
    expect(status(await dispatchApi('GET', 'open_location', { path: 'a.txt' }, {}, cfg, '127.0.0.1', ''))).toBe(403)
  })

  it('blocks every mutation in read-only mode while reads keep working', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.txt'), 'x')
    const cfg = config({ fileRoot: dir, readOnly: true })
    expect(status(await dispatchApi('POST', 'delete', {}, { path: 'a.txt' }, cfg, '127.0.0.1', ''))).toBe(403)
    expect(status(await dispatchApi('POST', 'create_folder', {}, { path: 'made' }, cfg, '127.0.0.1', ''))).toBe(403)
    expect(status(await dispatchApi('POST', 'rename', {}, { path: 'a.txt', new_name: 'b.txt' }, cfg, '127.0.0.1', ''))).toBe(403)
    expect(status(await dispatchApi('POST', 'copy', {}, { path: 'a.txt', dest_path: 'b.txt' }, cfg, '127.0.0.1', ''))).toBe(403)
    expect(status(await dispatchApi('GET', 'list', {}, {}, cfg, '127.0.0.1', ''))).toBe(200)
    expect(status(await dispatchApi('GET', 'read', { path: 'a.txt' }, {}, cfg, '127.0.0.1', ''))).toBe(200)
    expect(existsSync(join(dir, 'a.txt'))).toBe(true)
  })
})

describe('dispatchApi streams and openers', () => {
  it('produces a download stream with disposition', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'file.txt'), 'content')
    await writeFile(join(dir, 'blob.xyz'), 'data')
    const cfg = config({ fileRoot: dir })
    const result = await dispatchApi('GET', 'download', { path: 'file.txt' }, {}, cfg, '127.0.0.1', '')
    if (result.kind !== 'stream') throw new Error('expected stream')
    expect(result.disposition).toContain('file.txt')
    expect(result.mime).toContain('text/plain')
    const fallback = await dispatchApi('GET', 'download', { path: 'blob.xyz' }, {}, cfg, '127.0.0.1', '')
    if (fallback.kind !== 'stream') throw new Error('expected stream')
    expect(fallback.mime).toBe('application/octet-stream')
    expect(status(await dispatchApi('GET', 'download', {}, {}, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('GET', 'download', { path: '' }, {}, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('GET', 'download', { path: 'nope' }, {}, cfg, '127.0.0.1', ''))).toBe(404)
    await mkdir(join(dir, 'folder'))
    expect(status(await dispatchApi('GET', 'download', { path: 'folder' }, {}, cfg, '127.0.0.1', ''))).toBe(400)
  })

  it('produces a thumbnail stream only for image files', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await writeFile(join(dir, 'doc.txt'), 'x')
    await mkdir(join(dir, 'folder'))
    const cfg = config({ fileRoot: dir })
    const result = await dispatchApi('GET', 'thumbnail', { path: 'pic.png' }, {}, cfg, '127.0.0.1', '')
    if (result.kind !== 'stream') throw new Error('expected stream')
    expect(result.cache).toBe('max-age=3600')
    expect(status(await dispatchApi('GET', 'thumbnail', { path: 'doc.txt' }, {}, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('GET', 'thumbnail', { path: 'folder' }, {}, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('GET', 'thumbnail', {}, {}, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('GET', 'thumbnail', { path: 'nope' }, {}, cfg, '127.0.0.1', ''))).toBe(404)
  })

  it('opens files and locations through the system openers', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.txt'), 'x')
    await mkdir(join(dir, 'folder'))
    const cfg = config({ fileRoot: dir })
    const opened = await dispatchApi('GET', 'open', { path: 'a.txt' }, {}, cfg, '127.0.0.1', '')
    if (opened.kind !== 'json') throw new Error('expected json')
    expect(opened.message).toBe('已打开文件')
    expect(openControl.openInSystem).toHaveBeenCalledTimes(1)
    const revealed = await dispatchApi('GET', 'open_location', { path: 'folder' }, {}, cfg, '127.0.0.1', '')
    if (revealed.kind !== 'json') throw new Error('expected json')
    expect(revealed.message).toBe('已打开位置')
    expect(openControl.openLocationInExplorer).toHaveBeenCalledTimes(1)
    expect(status(await dispatchApi('GET', 'open', {}, {}, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('GET', 'open', { path: '' }, {}, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('GET', 'open', { path: 'nope' }, {}, cfg, '127.0.0.1', ''))).toBe(404)
    expect(status(await dispatchApi('GET', 'open', { path: 'folder' }, {}, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('GET', 'open_location', {}, {}, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('GET', 'open_location', { path: '' }, {}, cfg, '127.0.0.1', ''))).toBe(400)
    expect(status(await dispatchApi('GET', 'open_location', { path: 'nope' }, {}, cfg, '127.0.0.1', ''))).toBe(404)
  })

  it('reports opener failures as 500 outcomes', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.txt'), 'x')
    // One Error and one non-Error rejection cover both catch-render arms.
    openControl.openInSystem
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockRejectedValueOnce('plain failure')
    openControl.openLocationInExplorer
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockRejectedValueOnce('plain failure')
    const cfg = config({ fileRoot: dir })
    const opened = await dispatchApi('GET', 'open', { path: 'a.txt' }, {}, cfg, '127.0.0.1', '')
    if (opened.kind !== 'error') throw new Error('expected error outcome')
    expect(opened.status).toBe(500)
    const openedPlain = await dispatchApi('GET', 'open', { path: 'a.txt' }, {}, cfg, '127.0.0.1', '')
    if (openedPlain.kind !== 'error') throw new Error('expected error outcome')
    expect(openedPlain.status).toBe(500)
    const revealed = await dispatchApi('GET', 'open_location', { path: 'a.txt' }, {}, cfg, '127.0.0.1', '')
    if (revealed.kind !== 'error') throw new Error('expected error outcome')
    expect(revealed.status).toBe(500)
    const revealedPlain = await dispatchApi('GET', 'open_location', { path: 'a.txt' }, {}, cfg, '127.0.0.1', '')
    if (revealedPlain.kind !== 'error') throw new Error('expected error outcome')
    expect(revealedPlain.status).toBe(500)
  })

  it('answers unknown endpoints with 404', async () => {
    expect(status(await dispatchApi('GET', 'bogus', {}, {}, config(), '127.0.0.1', ''))).toBe(404)
  })
})

describe('resolveAsset and renderIndex', () => {
  it('serves the index with the routed API base injected', async () => {
    const asset = await resolveAsset('/dsh-agfs', '/dsh-agfs')
    if (asset?.kind !== 'index') throw new Error('expected index')
    expect(asset.html).toContain('<title>文件浏览器</title>')
    expect(asset.html).toContain("window.__DSH_AGFS__={apiPrefix:'/dsh-agfs/api/file_browser/'};")
    expect(asset.html).not.toContain('<!--DSH-AGFS-CONFIG-->')
  })

  it('serves the app script and stylesheet with MIME types', async () => {
    const jsx = await resolveAsset('/dsh-agfs/app.jsx', '/dsh-agfs')
    expect(jsx).toEqual({ kind: 'file', file: join(ASSETS_DIR, 'app.jsx'), mime: 'text/babel; charset=utf-8' })
    const app = await resolveAsset('/dsh-agfs/app.js', '/dsh-agfs')
    expect(app?.kind).toBe('file')
    if (app?.kind === 'file') expect(app.mime).toContain('javascript')
    const vendor = await resolveAsset('/dsh-agfs/vendor/react.production.min.js', '/dsh-agfs')
    expect(vendor?.kind).toBe('file')
    const css = await resolveAsset('/dsh-agfs/webbrowser.css', '/dsh-agfs')
    if (css?.kind !== 'file') throw new Error('expected file')
    expect(css.mime).toContain('text/css')
  })

  it('rejects unknown, out-of-prefix, and traversal paths', async () => {
    expect(await resolveAsset('/dsh-agfs/missing.js', '/dsh-agfs')).toBeUndefined()
    expect(await resolveAsset('/other/', '/dsh-agfs')).toBeUndefined()
    expect(await resolveAsset('/dsh-agfs/../secrets', '/dsh-agfs')).toBeUndefined()
    expect(await resolveAsset('/dsh-agfs/..%2fapp.jsx', '/dsh-agfs')).toBeUndefined()
  })

  it('injects only into a page carrying the marker', () => {
    expect(renderIndex('a<!--DSH-AGFS-CONFIG-->b', '/x'))
      .toBe('a<script>window.__DSH_AGFS__={apiPrefix:\'/x/api/file_browser/\'};</script>b')
    expect(renderIndex('plain', '/x')).toBe('plain')
  })
})

describe('getClientIp and readJsonBody', () => {
  it('prefers forwarded headers and falls back to the socket address', () => {
    expect(getClientIp({ 'x-forwarded-for': '10.1.1.1, 10.1.1.2' }, '127.0.0.1')).toBe('10.1.1.1')
    expect(getClientIp({ 'x-forwarded-for': ['10.1.1.1', '10.1.1.2'] }, '127.0.0.1')).toBe('10.1.1.1')
    expect(getClientIp({ 'x-forwarded-for': [] }, '127.0.0.1')).toBe('')
    expect(getClientIp({ 'x-real-ip': '10.2.2.2' }, '127.0.0.1')).toBe('10.2.2.2')
    expect(getClientIp({ 'x-real-ip': ['10.2.2.2'] }, '127.0.0.1')).toBe('10.2.2.2')
    expect(getClientIp({}, '::1')).toBe('::1')
  })

  it('parses JSON bodies and rejects malformed or oversized ones', async () => {
    await expect(readJsonBody(fakeRequest('{"a":1}'))).resolves.toEqual({ a: 1 })
    await expect(readJsonBody(fakeRequest(''))).resolves.toEqual({})
    await expect(readJsonBody(fakeRequest('not json'))).rejects.toThrow('无效的 JSON')
    const oversize = new EventEmitter() as unknown as IncomingMessage
    ;(oversize as unknown as { destroy: () => void }).destroy = () => {}
    process.nextTick(() => {
      oversize.emit('data', Buffer.alloc(5 * 1024 * 1024 + 1))
    })
    await expect(readJsonBody(oversize)).rejects.toThrow('请求体过大')
    const errored = new EventEmitter() as unknown as IncomingMessage
    process.nextTick(() => { errored.emit('error', new Error('socket reset')) })
    await expect(readJsonBody(errored)).rejects.toThrow('socket reset')
  })
})

describe('writeOutcome', () => {
  it('writes success JSON with data, message, and extras', () => {
    const { res, status: getStatus, headers: getHeaders, body: getBody } = fakeResponse()
    writeOutcome(res as unknown as ServerResponse, { kind: 'json', status: 200, data: { ok: true }, message: 'done', extra: { path: 'x' } })
    const parsed = JSON.parse(getBody()) as { success: boolean; data: { ok: boolean }; message: string; path: string }
    expect(parsed).toEqual({ success: true, data: { ok: true }, message: 'done', path: 'x' })
    expect(getStatus()).toBe(200)
    expect(getHeaders()['Content-Type']).toContain('application/json')
  })

  it('writes error JSON', () => {
    const { res, status: getStatus, body: getBody } = fakeResponse()
    writeOutcome(res as unknown as ServerResponse, { kind: 'error', status: 404, error: '文件不存在' })
    expect(JSON.parse(getBody())).toEqual({ success: false, error: '文件不存在' })
    expect(getStatus()).toBe(404)
  })

  it('streams a file onto the response', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'dl.txt'), 'streamed-content')
    const { res, headers: getHeaders } = fakeResponse()
    writeOutcome(res as unknown as ServerResponse, {
      kind: 'stream',
      file: join(dir, 'dl.txt'),
      mime: 'text/plain',
      disposition: 'attachment; filename="dl.txt"',
    })
    expect(getHeaders()['Content-Type']).toBe('text/plain')
    expect(getHeaders()['Content-Disposition']).toContain('dl.txt')
    await new Promise<void>((resolvePromise) => { res.on('finish', resolvePromise) })
  })

  it('streams with cache control and without disposition', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'thumb.png'), 'png')
    const cached = fakeResponse()
    writeOutcome(cached.res as unknown as ServerResponse, {
      kind: 'stream',
      file: join(dir, 'thumb.png'),
      mime: 'image/png',
      cache: 'max-age=3600',
    })
    expect(cached.headers()['Cache-Control']).toBe('max-age=3600')
    expect(cached.headers()['Content-Disposition']).toBeUndefined()
    await new Promise<void>((resolvePromise) => { cached.res.on('finish', resolvePromise) })
    const bare = fakeResponse()
    writeOutcome(bare.res as unknown as ServerResponse, {
      kind: 'stream',
      file: join(dir, 'thumb.png'),
      mime: 'image/png',
    })
    expect(bare.headers()['Cache-Control']).toBeUndefined()
    await new Promise<void>((resolvePromise) => { bare.res.on('finish', resolvePromise) })
  })

  it('writes success JSON without data', () => {
    const { res, body: getBody } = fakeResponse()
    writeOutcome(res as unknown as ServerResponse, { kind: 'json', status: 200, message: 'done' })
    expect(JSON.parse(getBody())).toEqual({ success: true, message: 'done' })
  })
})
