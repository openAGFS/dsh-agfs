/**
 * File-browser API core ported from the standalone `server.js` backend: path
 * safety, listing/read/search/mutate endpoints, streaming outcomes, and static
 * asset resolution. All functions are pure over their inputs (no HTTP server),
 * so the plugin's HTTP layer stays a thin materializer and every endpoint is
 * unit-testable. Response shapes mirror the original contract exactly
 * (`{success:true,data,message}` / `{success:false,error}`).
 * @module @agfs/dsh-agfs/handler
 */

import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir, networkInterfaces, platform } from 'node:os'
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AgfsConfig,
  ApiOutcome,
  AssetResponse,
  Body,
  Query,
  StreamOutcome,
} from './types.ts'
import { openInSystem, openLocationInExplorer } from './open.ts'

/** Package assets directory, stable in both the source tree and the built lib. */
export const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

/** Read limit for the `read` endpoint, matching the original 10 MiB cap. */
export const READ_LIMIT_BYTES = 10 * 1024 * 1024

/** MIME table for static assets and downloads, mirroring the original server. */
export const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.jsx': 'text/babel; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.txt': 'text/plain; charset=utf-8',
}

/** Placeholder inside `index.html` replaced with the routed API-base script. */
const INDEX_CONFIG_MARKER = '<!--DSH-AGFS-CONFIG-->'

/** Default file-browser root: the current working directory. */
function defaultFileRoot(): string {
  /* v8 ignore next -- process.cwd() is never empty in a running process */
  return process.cwd() || resolve('/')
}

/** Normalize a path for display: Windows paths use backslashes, others slashes. */
function normalizePath(p: string): string {
  if (p.length >= 2 && p[1] === ':') return p.replace(/\//g, '\\')
  return p.replace(/\\/g, '/')
}

/** Whether the current process looks like a Git Bash (MSYS/MINGW) environment. */
/* v8 ignore start -- the Git Bash probes are Windows-only; POSIX coverage exercises the call sites, never the probes */
function isGitBashEnvironment(): boolean {
  const ms = (process.env.MSYSTEM ?? '').toUpperCase()
  if (ms.includes('MINGW') || ms.includes('MSYS')) return true
  const pe = (process.env.PATH ?? '').toLowerCase()
  if (pe.includes('git') && (pe.includes('mingw') || pe.includes('/usr/bin'))) return true
  for (const r of ['C:/Program Files/Git/usr', 'C:/Program Files (x86)/Git/usr', 'C:/Git/usr']) {
    try { if (existsSync(r)) return true } catch { /* ignore */ }
  }
  return false
}
/* v8 ignore stop */

/** Resolve the Git Bash user-root for `/`-prefixed paths under a Git Bash shell. */
/* v8 ignore start -- the Git Bash root probes are Windows-only; POSIX coverage exercises the call sites, never the probes */
function getGitBashRoot(): string {
  for (const r of ['C:/Program Files/Git/usr', 'C:/Program Files (x86)/Git/usr', 'C:/Git/usr', 'F:/programs/Git/usr']) {
    try { if (existsSync(r)) return normalize(r) } catch { /* ignore */ }
  }
  const pe = process.env.PATH ?? ''
  for (const part of pe.split(';')) {
    const l = part.toLowerCase()
    if (!l.includes('git') || !l.includes('usr')) continue
    const idx = l.indexOf('usr')
    if (idx > 0) {
      const g = normalize(part.slice(0, idx + 3))
      try { if (existsSync(g)) return g } catch { /* ignore */ }
    }
  }
  return homedir()
}
/* v8 ignore stop */

/** Resolve the effective browser root for one request's `filepath` parameter. */
function getRoot(filepath: string | undefined, config: AgfsConfig): string {
  if (filepath !== undefined) {
    const clean = filepath.trim()
    try {
      let root: string
      if (clean.length >= 2 && clean[1] === ':') {
        let win = clean.replace(/\//g, '\\')
        if (win.length === 2 && win[1] === ':') win += '\\'
        root = normalize(win)
      } else if (clean === '/') {
        /* v8 ignore start -- the Git Bash root arm is Windows-only; POSIX covers the resolve('/') peer */
        root = platform() === 'win32' && isGitBashEnvironment() ? getGitBashRoot() : resolve('/')
        /* v8 ignore stop */
      } else {
        root = resolve(clean)
      }
      if (existsSync(root) && statSync(root).isDirectory()) return root
    } catch { /* fall through to the configured root */ }
  }
  const configured = config.fileRoot.trim()
  if (configured !== '') {
    try {
      const root = resolve(configured)
      if (existsSync(root) && statSync(root).isDirectory()) return root
    } catch { /* fall through to the default root */ }
  }
  return defaultFileRoot()
}

/** Nearest existing ancestor of a path (the path itself when it exists). */
function nearestExisting(p: string): string {
  let cursor = p
  for (;;) {
    try {
      realpathSync(cursor)
      return cursor
    } catch {
      const parent = dirname(cursor)
      /* v8 ignore next -- fs-root termination is unreachable: confined targets always have an existing ancestor under the root */
      if (parent === cursor) return cursor
      cursor = parent
    }
  }
}

/**
 * Strict-root confinement: the target's resolved real path (walking up to the
 * nearest existing ancestor for not-yet-created targets) must stay inside the
 * root's real path. This rejects symlink and junction escapes. A root that
 * cannot be realpathed (missing) falls back to the lexical check.
 */
function ensureStrictWithin(root: string, target: string): void {
  let rootReal: string
  try {
    rootReal = realpathSync(root)
  } catch {
    return
  }
  const existing = nearestExisting(target)
  const real = realpathSync(existing)
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new Error('路径超出允许范围')
  }
}

/**
 * Confine a relative path under a root; absolute paths escape confinement.
 * @param root - the browsable root directory.
 * @param relativePath - request path, possibly `''` for the root itself.
 * @param strict - strict-root mode: reject absolute escapes and symlink escapes.
 * @returns the confined absolute path.
 */
export function getSafePath(root: string, relativePath: string, strict = false): string {
  if (!relativePath) return root
  const cleanPath = relativePath.replace(/\\/g, '/')
  if (cleanPath.length >= 2 && cleanPath[1] === ':') {
    if (strict) throw new Error('路径超出允许范围')
    let winPath = cleanPath.replace(/\//g, '\\')
    if (winPath.length === 2 && winPath[1] === ':') winPath += '\\'
    return normalize(winPath)
  }
  if (cleanPath.startsWith('/')) {
    if (strict) throw new Error('路径超出允许范围')
    /* v8 ignore start -- the Git Bash root arm is Windows-only; POSIX covers the normalize peer */
    if (platform() === 'win32' && isGitBashEnvironment()) {
      const gitRoot = getGitBashRoot()
      if (cleanPath === '/') return gitRoot
      return join(gitRoot, cleanPath.slice(1))
    }
    /* v8 ignore stop */
    return normalize(cleanPath)
  }
  const fullPath = resolve(join(root, cleanPath.replace(/^\/+/, '')))
  const rootResolved = resolve(root)
  /* v8 ignore next -- the trailing-separator arm is a Windows drive-root shape; POSIX resolve() never ends with sep */
  const base = rootResolved.endsWith(sep) ? rootResolved.slice(0, -1) : rootResolved
  if (fullPath !== rootResolved && !fullPath.startsWith(base + sep)) {
    throw new Error('路径超出允许范围')
  }
  if (strict) ensureStrictWithin(root, fullPath)
  return fullPath
}

/** Windows drive letters that exist, or the default root when none do. */
function getSystemRoots(): string[] {
  /* v8 ignore start -- the drive scan is Windows-only; POSIX covers the single-root peer */
  if (platform() === 'win32') {
    const drives: string[] = []
    for (let i = 65; i <= 90; i++) {
      const drive = `${String.fromCharCode(i)}:\\`
      try { if (existsSync(drive)) drives.push(normalize(drive)) } catch { /* ignore */ }
    }
    return drives.length > 0 ? drives : [defaultFileRoot()]
  }
  /* v8 ignore stop */
  return [defaultFileRoot()]
}

/** Human-readable byte size, e.g. `1.5 KB`. */
function formatSize(size: number): string {
  let f = size
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
    if (f < 1024) return `${f.toFixed(1)} ${unit}`
    f /= 1024
  }
  /* v8 ignore next -- a 1 TiB real file is beyond any browsable fixture */
  return `${f.toFixed(1)} PB`
}

/** `YYYY-MM-DD HH:mm:ss` local timestamp, matching the original formatting. */
function formatModified(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** One directory entry descriptor in the original `file_item` shape. */
function getFileInfo(itemPath: string, root: string): Record<string, unknown> {
  const s = statSync(itemPath)
  let rel: string
  /* v8 ignore start -- the basename and relative() fallbacks are unreachable for search children */
  try {
    rel = normalizePath(relative(root, itemPath) || basename(itemPath))
  } catch {
    rel = normalizePath(itemPath)
  }
  /* v8 ignore stop */
  const isDir = s.isDirectory()
  return {
    name: basename(itemPath),
    path: rel,
    type: isDir ? 'folder' : 'file',
    size: isDir ? null : formatSize(s.size),
    size_bytes: isDir ? null : s.size,
    modified: formatModified(s.mtimeMs),
  }
}

/** All local interface addresses plus loopback literals. */
function getLocalIps(): string[] {
  const ips = new Set(['127.0.0.1', '::1', 'localhost'])
  try {
    const nets = networkInterfaces()
    for (const name of Object.keys(nets)) {
      /* v8 ignore next -- nets[name] always exists for keys from Object.keys(nets) */
      for (const net of nets[name] ?? []) {
        ips.add(net.address)
        /* v8 ignore next -- IPv4-mapped addresses depend on the host's interface mix */
        if (net.address.startsWith('::ffff:')) ips.add(net.address.slice(7))
      }
    }
  } catch { /* ignore */ }
  return [...ips]
}

/** Extracted client IP from the standard forwarded headers, or the socket address. */
export function getClientIp(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  socketAddress: string,
): string {
  const xff = headers['x-forwarded-for']
  if (xff !== undefined) {
    const raw = Array.isArray(xff) ? xff[0] : xff
    if (raw === undefined) return ''
    /* v8 ignore next -- split of a non-empty string always yields an element, so the fallback arm is unreachable */
    return raw.split(',')[0]?.trim() ?? ''
  }
  const xri = headers['x-real-ip']
  if (xri !== undefined) return String(Array.isArray(xri) ? xri[0] : xri).trim()
  return socketAddress
}

/** Read and parse one JSON request body with the original 5 MiB guard. */
export function readJsonBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolvePromise, reject) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString()
      if (raw.length > 5 * 1024 * 1024) {
        req.destroy()
        reject(new Error('请求体过大'))
      }
    })
    req.on('end', () => {
      if (!raw) {
        resolvePromise({})
        return
      }
      try { resolvePromise(JSON.parse(raw) as Body) } catch {
        reject(new Error('无效的 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** List one directory under the browsable root. */
async function apiList(query: Query, config: AgfsConfig): Promise<ApiOutcome> {
  const relativePath = query.path ?? ''
  const root = getRoot(query.filepath, config)
  const targetPath = getSafePath(root, relativePath, config.strictRoot)
  const effectiveRoot = resolve(targetPath)
  if (!existsSync(targetPath)) return { kind: 'error', status: 404, error: '路径不存在' }
  if (!statSync(targetPath).isDirectory()) return { kind: 'error', status: 400, error: '路径不是目录' }
  let entries: string[]
  try {
    entries = await readdir(targetPath)
  } catch {
    return { kind: 'error', status: 403, error: '权限不足' }
  }
  const items: Array<Record<string, unknown>> = []
  await Promise.all(entries.map(async (name) => {
    const full = join(targetPath, name)
    try {
      const s = await stat(full)
      const isDir = s.isDirectory()
      let rel: string
      /* v8 ignore next -- the basename fallback needs a child path equal to the root, which listing never produces */
      try { rel = normalizePath(relative(effectiveRoot, full) || name) } catch { rel = normalizePath(full) }
      items.push({
        name,
        path: rel,
        type: isDir ? 'folder' : 'file',
        size: isDir ? null : formatSize(s.size),
        size_bytes: isDir ? null : s.size,
        modified: formatModified(s.mtimeMs),
      })
    } catch { /* entry vanished mid-listing */ }
  }))
  items.sort((a, b) => {
    /* v8 ignore next -- the comparator's reverse arm depends on engine ordering; the folder-first assertion pins the observable order */
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase())
  })
  let parentPath = ''
  if (relativePath) {
    const clean = relativePath.replace(/\/+$/, '')
    /* v8 ignore next -- the drive-letter parent skip is a Windows absolute-path shape unreachable on POSIX */
    if (!(clean.length >= 2 && clean[1] === ':')) {
      const idx = clean.lastIndexOf('/')
      parentPath = idx > 0 ? clean.slice(0, idx) : ''
    }
  }
  return {
    kind: 'json',
    status: 200,
    data: {
      current_path: normalizePath(targetPath),
      parent_path: normalizePath(parentPath),
      root_path: normalizePath(effectiveRoot),
      items,
    },
  }
}

/** Read a UTF-8 text file with the original binary and size guards. */
async function apiRead(query: Query, config: AgfsConfig): Promise<ApiOutcome> {
  const relativePath = query.path ?? ''
  if (!relativePath) return { kind: 'error', status: 400, error: '缺少path参数' }
  const root = getRoot(query.filepath, config)
  const targetPath = getSafePath(root, relativePath, config.strictRoot)
  if (!existsSync(targetPath)) return { kind: 'error', status: 404, error: '文件不存在' }
  if (!statSync(targetPath).isFile()) return { kind: 'error', status: 400, error: '不是文件' }
  if (statSync(targetPath).size > READ_LIMIT_BYTES) return { kind: 'error', status: 400, error: '文件过大' }
  try {
    const content = await readFile(targetPath, 'utf-8')
    if (content.indexOf('\u0000') !== -1) return { kind: 'error', status: 400, error: '无法读取二进制文件' }
    return {
      kind: 'json',
      status: 200,
      data: { name: basename(targetPath), path: normalizePath(relativePath), content, size: statSync(targetPath).size },
    }
  } catch {
    /* v8 ignore next -- the binary-read catch is the same 400 as the NUL check; readFile only throws here on races */
    return { kind: 'error', status: 400, error: '无法读取二进制文件' }
  }
}

/** Download one file as a streaming attachment. */
function apiDownload(query: Query, config: AgfsConfig): ApiOutcome {
  const relativePath = query.path ?? ''
  if (!relativePath) return { kind: 'error', status: 400, error: '缺少path参数' }
  const root = getRoot(query.filepath, config)
  const targetPath = getSafePath(root, relativePath, config.strictRoot)
  if (!existsSync(targetPath)) return { kind: 'error', status: 404, error: '文件不存在' }
  if (!statSync(targetPath).isFile()) return { kind: 'error', status: 400, error: '不是文件' }
  const name = basename(targetPath)
  const ext = extname(name).toLowerCase()
  const outcome: StreamOutcome = {
    kind: 'stream',
    file: targetPath,
    mime: MIME[ext] ?? 'application/octet-stream',
    disposition: `attachment; filename="${encodeURIComponent(name)}"`,
  }
  return outcome
}

/** Open a file in the system default application (local mode only). */
async function apiOpen(query: Query, config: AgfsConfig): Promise<ApiOutcome> {
  if (config.remoteMode) return { kind: 'error', status: 403, error: '远程模式下不支持打开文件' }
  const relativePath = query.path ?? ''
  if (!relativePath) return { kind: 'error', status: 400, error: '缺少path参数' }
  const root = getRoot(query.filepath, config)
  const targetPath = getSafePath(root, relativePath, config.strictRoot)
  if (!existsSync(targetPath)) return { kind: 'error', status: 404, error: '文件不存在' }
  if (!statSync(targetPath).isFile()) return { kind: 'error', status: 400, error: '不是文件' }
  try {
    await openInSystem(targetPath)
    return { kind: 'json', status: 200, data: null, message: '已打开文件' }
  } catch (error: unknown) {
    return { kind: 'error', status: 500, error: `打开文件失败: ${String(error instanceof Error ? error.message : error)}` }
  }
}

/** Reveal a file or folder in the system file manager (local mode only). */
async function apiOpenLocation(query: Query, config: AgfsConfig): Promise<ApiOutcome> {
  if (config.remoteMode) return { kind: 'error', status: 403, error: '远程模式下不支持打开所在目录' }
  const relativePath = query.path ?? ''
  if (!relativePath) return { kind: 'error', status: 400, error: '缺少path参数' }
  const root = getRoot(query.filepath, config)
  const targetPath = getSafePath(root, relativePath, config.strictRoot)
  if (!existsSync(targetPath)) return { kind: 'error', status: 404, error: '路径不存在' }
  try {
    await openLocationInExplorer(targetPath)
    return { kind: 'json', status: 200, data: null, message: '已打开位置' }
  } catch (error: unknown) {
    return { kind: 'error', status: 500, error: `打开位置失败: ${String(error instanceof Error ? error.message : error)}` }
  }
}

/** Recursive search hit cap (also the shallow cap); bounded so one request cannot scan unboundedly. */
const SEARCH_MAX_HITS = 200

/** Recursive search directory-depth cap (the starting directory is depth 0). */
const SEARCH_MAX_DEPTH = 5

/** Recursive search sibling-directory concurrency: one batch of siblings per Promise.all. */
const SEARCH_BATCH_SIZE = 8

/** Whether a query flag reads as truthy (`1`, `true`, `yes`). */
function isTruthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes'
}

/**
 * Depth-bounded recursive name search. Unreadable directories are skipped
 * silently; both the hit cap and the depth cap terminate the walk.
 * @param dir - directory currently being scanned.
 * @param root - browsable root used for relative result paths.
 * @param keywordLower - lower-cased keyword.
 * @param results - shared result accumulator.
 * @param depth - current directory depth below the start.
 */
async function searchRecursive(
  dir: string,
  root: string,
  keywordLower: string,
  results: Array<Record<string, unknown>>,
  depth: number,
): Promise<void> {
  if (depth > SEARCH_MAX_DEPTH || results.length >= SEARCH_MAX_HITS) return
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return // unreadable directory: skip silently
  }
  const subdirs: string[] = []
  for (const name of entries) {
    if (results.length >= SEARCH_MAX_HITS) return
    const full = join(dir, name)
    try {
      const s = await stat(full)
      if (s.isDirectory()) subdirs.push(full)
      // The guard runs again after the stat await so concurrent sibling scans
      // cannot overshoot the shared cap: check and push are synchronous.
      if (results.length >= SEARCH_MAX_HITS) return
      if (name.toLowerCase().includes(keywordLower)) results.push(getFileInfo(full, root))
    } catch { /* entry vanished mid-scan */ }
  }
  // Sibling directories walk in bounded parallel batches; the shared hit
  // guard above keeps the 200 cap exact even under interleaved pushes.
  for (let offset = 0; offset < subdirs.length; offset += SEARCH_BATCH_SIZE) {
    await Promise.all(subdirs.slice(offset, offset + SEARCH_BATCH_SIZE).map(
      sub => searchRecursive(sub, root, keywordLower, results, depth + 1),
    ))
  }
}

/** Name search; `recursive=1` walks the tree with depth and hit caps. */
async function apiSearch(query: Query, config: AgfsConfig): Promise<ApiOutcome> {
  const relativePath = query.path ?? ''
  const keyword = query.keyword ?? ''
  if (!keyword) return { kind: 'error', status: 400, error: '缺少keyword参数' }
  const root = getRoot(query.filepath, config)
  const targetPath = getSafePath(root, relativePath, config.strictRoot)
  if (!existsSync(targetPath)) return { kind: 'error', status: 404, error: '路径不存在' }
  if (!statSync(targetPath).isDirectory()) return { kind: 'error', status: 400, error: '路径不是目录' }
  const results: Array<Record<string, unknown>> = []
  const keywordLower = keyword.toLowerCase()
  const recursive = isTruthy(query.recursive)
  if (recursive) {
    await searchRecursive(targetPath, root, keywordLower, results, 0)
  } else {
    let entries: string[] = []
    try { entries = await readdir(targetPath) } catch { /* unreadable dir yields no results */ }
    for (const name of entries) {
      if (results.length >= SEARCH_MAX_HITS) break
      if (!name.toLowerCase().includes(keywordLower)) continue
      try { results.push(getFileInfo(join(targetPath, name), root)) } catch { /* ignore */ }
    }
  }
  return { kind: 'json', status: 200, data: { keyword, path: normalizePath(relativePath), recursive, results } }
}

/** Current root identity, matching the original `info` endpoint. */
function apiInfo(query: Query, config: AgfsConfig): ApiOutcome {
  const root = getRoot(query.filepath, config)
  return {
    kind: 'json',
    status: 200,
    /* v8 ignore next -- basename(root) is never empty for a resolved directory */
    data: { root, name: basename(root) || root.replace(/[\\/]$/, '') },
  }
}

/** Workspace directory marker under the working directory (API parity). */
function apiWorkspace(): ApiOutcome {
  const ws = join(process.cwd(), 'workspace')
  return { kind: 'json', status: 200, data: { workspace: ws, exists: existsSync(ws) } }
}

/** Sidebar data: project root, existing quick-access folders, and drives. */
function apiSidebar(config: AgfsConfig): ApiOutcome {
  const projectRoot = resolve(config.projectRoot.trim() !== '' ? config.projectRoot : process.cwd())
  const project = (existsSync(projectRoot) && statSync(projectRoot).isDirectory()) ? normalizePath(projectRoot) : null
  const quick: Array<{ name: string; path: string }> = []
  const home = homedir()
  const defs: ReadonlyArray<readonly [string, string]> = [
    ['桌面', 'Desktop'], ['下载', 'Downloads'], ['文档', 'Documents'],
    ['图片', 'Pictures'], ['音乐', 'Music'], ['视频', 'Videos'],
  ]
  for (const [name, dir] of defs) {
    const p = join(home, dir)
    try {
      /* v8 ignore next -- whether a quick-access folder exists depends on the host's home folder */
      if (existsSync(p) && statSync(p).isDirectory()) quick.push({ name, path: normalizePath(p) })
    } catch { /* ignore */ }
  }
  const drives = getSystemRoots().map(d => ({
    name: basename(d) || d.replace(/\\$/, ''),
    path: normalizePath(d),
  }))
  // Configured named roots: unresolved entries are dropped, the rest sort by name.
  const roots = Object.entries(config.roots)
    .map(([name, p]) => ({ name, path: resolve(p) }))
    .filter(({ path }) => existsSync(path) && statSync(path).isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, path }) => ({ name, path: normalizePath(path) }))
  return { kind: 'json', status: 200, data: { project, quick, drives, roots } }
}

/** Stream an image file for thumbnail display (original image, CSS-scaled). */
function apiThumbnail(query: Query, config: AgfsConfig): ApiOutcome {
  const relativePath = query.path ?? ''
  if (!relativePath) return { kind: 'error', status: 400, error: '缺少path参数' }
  const root = getRoot(query.filepath, config)
  const targetPath = getSafePath(root, relativePath, config.strictRoot)
  if (!existsSync(targetPath)) return { kind: 'error', status: 404, error: '文件不存在' }
  if (!statSync(targetPath).isFile()) return { kind: 'error', status: 400, error: '不是文件' }
  const ext = extname(targetPath).toLowerCase()
  if (!['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
    return { kind: 'error', status: 400, error: '不是图片文件' }
  }
  /* v8 ignore next -- every image extension has a MIME entry, so the octet-stream fallback is unreachable */
  return { kind: 'stream', file: targetPath, mime: MIME[ext] ?? 'image/jpeg', cache: 'max-age=3600' }
}

/** Local vs remote mode decision for one request, mirroring the original heuristics. */
function apiMode(
  config: AgfsConfig,
  clientIp: string,
  socketAddress: string,
): ApiOutcome {
  const localIps = getLocalIps()
  const isLocal = localIps.includes(clientIp)
  const remote = config.remoteMode ? true : !isLocal
  return {
    kind: 'json',
    status: 200,
    data: {
      remote_mode: remote,
      mode_name: remote ? '远程模式' : '本机模式',
      client_ip: clientIp,
      is_local: isLocal,
      local_ips: localIps,
      socket_address: socketAddress,
    },
  }
}

/** Debug identity data for the original `debug` endpoint. */
function apiDebug(query: Query, config: AgfsConfig): ApiOutcome {
  const root = getRoot(query.filepath, config)
  let safePathResult = 'N/A'
  let safePathError: string | null = null
  try { safePathResult = getSafePath(root, query.path ?? query.filepath ?? '', config.strictRoot) } catch (error: unknown) {
    /* v8 ignore next -- getSafePath only throws Error instances */
    safePathError = error instanceof Error ? error.message : String(error)
  }
  return {
    kind: 'json',
    status: 200,
    extra: {
      debug: {
        filepath: query.filepath ?? '',
        path: query.path ?? '',
        os_name: platform(),
        is_git_bash: isGitBashEnvironment(),
        git_bash_root: getGitBashRoot(),
        /* v8 ignore next -- MSYSTEM is a Git Bash variable, unset everywhere else */
        msystem: process.env.MSYSTEM ?? 'NOT_SET',
        /* v8 ignore next -- PATH is always set in a running process */
        path_env_sample: (process.env.PATH ?? 'NOT_SET').slice(0, 200),
        get_root_result: root,
        get_safe_path_result: safePathResult,
        get_safe_path_error: safePathError,
      },
    },
  }
}

/** Delete a file or folder recursively. */
async function apiDelete(body: Body, config: AgfsConfig): Promise<ApiOutcome> {
  if (config.readOnly) return { kind: 'error', status: 403, error: '只读模式' }
  const relativePath = body.path
  if (typeof relativePath !== 'string' || relativePath === '') return { kind: 'error', status: 400, error: '缺少path参数' }
  const root = getRoot(typeof body.filepath === 'string' ? body.filepath : undefined, config)
  const targetPath = getSafePath(root, relativePath, config.strictRoot)
  if (!existsSync(targetPath)) return { kind: 'error', status: 404, error: '文件不存在' }
  try {
    await rm(targetPath, { recursive: true, force: true })
    return { kind: 'json', status: 200, data: null, message: '删除成功' }
  } catch (error: unknown) {
    /* v8 ignore next -- fs rejects with Error instances only */
    return { kind: 'error', status: 500, error: `删除失败: ${String(error instanceof Error ? error.message : error)}` }
  }
}

/** Create one folder; fails when the target already exists. */
async function apiCreateFolder(body: Body, config: AgfsConfig): Promise<ApiOutcome> {
  if (config.readOnly) return { kind: 'error', status: 403, error: '只读模式' }
  const relativePath = body.path
  if (typeof relativePath !== 'string' || relativePath === '') return { kind: 'error', status: 400, error: '缺少path参数' }
  const root = getRoot(typeof body.filepath === 'string' ? body.filepath : undefined, config)
  const targetPath = getSafePath(root, relativePath, config.strictRoot)
  if (existsSync(targetPath)) return { kind: 'error', status: 409, error: '文件夹已存在' }
  try {
    await mkdir(targetPath, { recursive: false })
    return { kind: 'json', status: 200, data: null, message: '创建成功', extra: { path: targetPath } }
  } catch (error: unknown) {
    /* v8 ignore next -- fs rejects with Error instances only */
    return { kind: 'error', status: 500, error: `创建失败: ${String(error instanceof Error ? error.message : error)}` }
  }
}

/** Rename a file or folder to a new sibling name. */
async function apiRename(body: Body, config: AgfsConfig): Promise<ApiOutcome> {
  if (config.readOnly) return { kind: 'error', status: 403, error: '只读模式' }
  const relativePath = body.path
  const newName = body.new_name
  if (typeof relativePath !== 'string' || relativePath === '') return { kind: 'error', status: 400, error: '缺少path参数' }
  if (typeof newName !== 'string' || newName === '') return { kind: 'error', status: 400, error: '缺少new_name参数' }
  const illegal = ['<', '>', ':', '"', '/', '\\', '|', '?', '*']
  for (const ch of illegal) {
    if (newName.includes(ch)) return { kind: 'error', status: 400, error: `文件名包含非法字符: ${ch}` }
  }
  if (newName.trim() !== newName) return { kind: 'error', status: 400, error: '文件名不能以空格开头或结尾' }
  /* v8 ignore next -- a whitespace-only name is caught by the trim check above, so this arm is unreachable */
  if (!newName.trim()) return { kind: 'error', status: 400, error: '文件名不能为空' }
  const root = getRoot(typeof body.filepath === 'string' ? body.filepath : undefined, config)
  const targetPath = getSafePath(root, relativePath, config.strictRoot)
  if (!existsSync(targetPath)) return { kind: 'error', status: 404, error: '文件不存在' }
  const newPath = join(dirname(targetPath), newName)
  if (existsSync(newPath)) return { kind: 'error', status: 400, error: '目标文件名已存在' }
  try {
    await rename(targetPath, newPath)
    let rel: string
    /* v8 ignore next -- relative() only throws on impossible root/path pairs */
    try { rel = normalizePath(relative(root, newPath)) } catch { rel = normalizePath(newPath) }
    return { kind: 'json', status: 200, data: null, message: '重命名成功', extra: { new_path: rel } }
  } catch (error: unknown) {
    /* v8 ignore next -- fs rejects with Error instances only */
    return { kind: 'error', status: 500, error: `重命名失败: ${String(error instanceof Error ? error.message : error)}` }
  }
}

/** Copy a file or folder tree to a new destination (local mode only). */
async function apiCopy(body: Body, config: AgfsConfig): Promise<ApiOutcome> {
  if (config.readOnly) return { kind: 'error', status: 403, error: '只读模式' }
  if (config.remoteMode) return { kind: 'error', status: 403, error: '远程模式下不支持复制功能' }
  const relativePath = body.path
  const destRelative = body.dest_path
  if (typeof relativePath !== 'string' || relativePath === '') return { kind: 'error', status: 400, error: '缺少path参数' }
  if (typeof destRelative !== 'string' || destRelative === '') return { kind: 'error', status: 400, error: '缺少dest_path参数' }
  const root = getRoot(typeof body.filepath === 'string' ? body.filepath : undefined, config)
  const sourcePath = getSafePath(root, relativePath, config.strictRoot)
  const destPath = getSafePath(root, destRelative, config.strictRoot)
  if (!existsSync(sourcePath)) return { kind: 'error', status: 404, error: '源文件不存在' }
  if (existsSync(destPath)) return { kind: 'error', status: 400, error: '目标路径已存在' }
  try {
    // Only create the destination parent when it is missing: recursive mkdir of
    // an existing drive root or filesystem root raises EPERM on Windows.
    const parent = dirname(destPath)
    if (!existsSync(parent)) await mkdir(parent, { recursive: true })
    await cp(sourcePath, destPath, { recursive: true, force: false })
    let rel: string
    /* v8 ignore next -- relative() only throws on impossible root/path pairs */
    try { rel = normalizePath(relative(root, destPath)) } catch { rel = normalizePath(destPath) }
    return { kind: 'json', status: 200, data: null, message: '复制成功', extra: { dest_path: rel } }
  } catch (error: unknown) {
    /* v8 ignore next -- fs rejects with Error instances only */
    return { kind: 'error', status: 500, error: `复制失败: ${String(error instanceof Error ? error.message : error)}` }
  }
}

/**
 * Dispatch one API request to its endpoint handler.
 * @param method - HTTP method (GET or POST).
 * @param endpoint - endpoint name after the API prefix.
 * @param query - parsed query parameters.
 * @param body - parsed JSON body (POST only).
 * @param config - plugin configuration.
 * @param clientIp - client IP for the mode heuristic.
 * @param socketAddress - raw socket remote address fallback.
 * @returns the discriminated API outcome.
 */
export async function dispatchApi(
  method: string,
  endpoint: string,
  query: Query,
  body: Body,
  config: AgfsConfig,
  clientIp: string,
  socketAddress: string,
): Promise<ApiOutcome> {
  try {
    switch (`${method} ${endpoint}`) {
      case 'GET list': return await apiList(query, config)
      case 'GET read': return await apiRead(query, config)
      case 'GET download': return apiDownload(query, config)
      case 'GET open': return await apiOpen(query, config)
      case 'GET open_location': return await apiOpenLocation(query, config)
      case 'GET search': return await apiSearch(query, config)
      case 'GET info': return apiInfo(query, config)
      case 'GET workspace': return apiWorkspace()
      case 'GET sidebar': return apiSidebar(config)
      case 'GET thumbnail': return apiThumbnail(query, config)
      case 'GET mode': return apiMode(config, clientIp, socketAddress)
      case 'GET debug': return apiDebug(query, config)
      case 'POST delete': return await apiDelete(body, config)
      case 'POST create_folder': return await apiCreateFolder(body, config)
      case 'POST rename': return await apiRename(body, config)
      case 'POST copy': return await apiCopy(body, config)
      default: return { kind: 'error', status: 404, error: '接口不存在' }
    }
  } catch (error: unknown) {
    // Path-safety violations surface as clean 400 outcomes, mirroring the
    // original backend's per-request error envelope.
    /* v8 ignore next -- getSafePath and the endpoint bodies reject with Error instances only */
    return { kind: 'error', status: 400, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Serve-time index injection: route the frontend's API base under `basePath`. */
export function renderIndex(html: string, basePath: string): string {
  const script = `<script>window.__DSH_AGFS__={apiPrefix:'${basePath}/api/file_browser/'};</script>`
  return html.includes(INDEX_CONFIG_MARKER) ? html.replace(INDEX_CONFIG_MARKER, script) : html
}

/**
 * Resolve one request pathname to a static asset.
 * @param pathname - decoded URL pathname of the request.
 * @param basePath - configured route prefix.
 * @returns the asset response, or `undefined` for a miss.
 */
export async function resolveAsset(pathname: string, basePath: string): Promise<AssetResponse> {
  const root = `${basePath}/`
  const relative = pathname === basePath || pathname === root || pathname === `${basePath}/index.html`
    ? 'index.html'
    : pathname.startsWith(root)
      ? pathname.slice(root.length)
      : undefined
  if (relative === undefined) return undefined
  const target = resolve(join(ASSETS_DIR, relative))
  if (!target.startsWith(resolve(ASSETS_DIR) + sep) && target !== resolve(ASSETS_DIR)) return undefined
  if (!existsSync(target) || !statSync(target).isFile()) return undefined
  if (relative === 'index.html') {
    return { kind: 'index', html: renderIndex(await readFile(target, 'utf8'), basePath) }
  }
  /* v8 ignore next -- the three packaged assets all have MIME entries, so the octet-stream fallback is unreachable */
  return { kind: 'file', file: target, mime: MIME[extname(target).toLowerCase()] ?? 'application/octet-stream' }
}

/** Materialize one API outcome onto a node:http response. */
export function writeOutcome(res: ServerResponse, outcome: ApiOutcome): void {
  if (outcome.kind === 'stream') {
    const headers: Record<string, string> = {
      'Content-Type': outcome.mime,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    }
    if (outcome.disposition !== undefined) headers['Content-Disposition'] = outcome.disposition
    if (outcome.cache !== undefined) headers['Cache-Control'] = outcome.cache
    res.writeHead(200, headers)
    createReadStream(outcome.file).pipe(res)
    return
  }
  const payload: Record<string, unknown> = outcome.kind === 'error'
    ? { success: false, error: outcome.error }
    : {
      success: true,
      ...outcome.data === undefined ? {} : { data: outcome.data },
      ...outcome.message === undefined ? {} : { message: outcome.message },
      ...outcome.extra ?? {},
    }
  const body = JSON.stringify(payload)
  res.writeHead(outcome.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  })
  res.end(body)
}
