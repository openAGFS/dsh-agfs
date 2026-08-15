/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the session store, the command registry, the
 * webserver, and the dsh-agfs plugin, and the assertions observe the durable
 * outcomes — HTTP serving with the routed API base injected, the file_browser
 * API over a real socket, the registered `/dsh-agfs` command, and that
 * disposing the plugin's fiber removes both the route and the command again
 * (HMR safety). Browser opening is mocked so no test spawns a browser.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { load as loadYaml } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Agfs from '../src/index.ts'

const openControl = vi.hoisted(() => ({
  openInBrowser: vi.fn<() => Promise<void>>(),
  openInSystem: vi.fn<() => Promise<void>>(),
  openLocationInExplorer: vi.fn<() => Promise<void>>(),
}))

vi.mock('../src/open.ts', () => openControl)

const AGFS = '@open-agfs/dsh-agfs'
const WEBSERVER = '@deepseek-ai/dsh-host-webserver'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  root = undefined
  openControl.openInBrowser.mockReset()
  openControl.openInBrowser.mockResolvedValue(undefined)
})

/**
 * Boot the real Loader against a cordis.yml (session, commands, webserver on
 * an OS-assigned port, and the plugin under test).
 * @param pluginConfig - extra YAML config lines for the plugin row.
 * @param options - composition variants: omit the fileRoot/projectRoot rows to
 * exercise plugin defaults, or append extra rows (e.g. a duplicate mount).
 */
async function loadComposition(
  pluginConfig: string,
  options: { withRoots?: boolean; extraRows?: string; rootsConfig?: Record<string, string> } = {},
): Promise<{ ctx: Context }> {
  const withRoots = options.withRoots ?? true
  root = await mkdtemp(join(tmpdir(), 'dsh-agfs-composition-'))
  const configPath = join(root, 'cordis.yml')
  // The browsable root is a dedicated subdirectory so the loader's own
  // cordis.yml never appears in the listing.
  const browseRoot = join(root, 'browse')
  await mkdir(browseRoot)
  const fileRoot = browseRoot.replace(/\\/g, '/')
  const pluginLines = withRoots
    ? [`    fileRoot: '${fileRoot}'`, `    projectRoot: '${fileRoot}'`, pluginConfig]
    : [pluginConfig]
  if (options.rootsConfig !== undefined) {
    pluginLines.push('    roots:')
    for (const [name, p] of Object.entries(options.rootsConfig)) {
      pluginLines.push(`      ${JSON.stringify(name)}: '${p.replace(/\\/g, '/')}'`)
    }
  }
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-commands'",
    `- name: '${WEBSERVER}'`,
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    `- name: '${AGFS}'`,
    withRoots ? '  config:' : '',
    ...pluginLines,
    options.extraRows ?? '',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    [WEBSERVER, HttpServer],
    [AGFS, Agfs],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return { ctx: context }
}

/** One plain HTTP response. */
interface HttpResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** Perform one HTTP request against the composed webserver. */
function http(
  ctx: Context,
  method: string,
  path: string,
  body?: unknown,
  encoding: BufferEncoding = 'utf8',
): Promise<HttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: ctx.webServer.port,
      path,
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    }, (res) => {
      let raw = ''
      res.on('data', (chunk: Buffer) => { raw += chunk.toString(encoding) })
      res.on('end', () => {
        resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: raw })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

/** Mint a live-session agent for command registry checks. */
function mintAgent(ctx: Context): Agent {
  const session = ctx.sessions.create(SessionId('composition-agent'))
  return { id: session.id, session } as Agent
}

let workspaceAgentSeq = 0

/** Mint a live-session agent whose session cwd (workspace) is a real directory. */
function mintWorkspaceAgent(ctx: Context, cwd: string): Agent {
  const session = ctx.sessions.create(SessionId(`composition-agent-ws-${workspaceAgentSeq++}`), { meta: { cwd } })
  return { id: session.id, session } as Agent
}

describe('real Loader composition', () => {
  it('ships a bundle patch that mounts the plugin by bare name', async () => {
    const packageRoot = fileURLToPath(new URL('..', import.meta.url))
    const patch = loadYaml(await readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8')) as Array<{
      insert?: Array<{ id?: string; name?: string }>
    }>
    const row = patch[0]?.insert?.[0]
    expect(row).toMatchObject({ id: 'dsh-agfs', name: '@open-agfs/dsh-agfs' })
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
      files?: string[]
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toContain('cordis.patch.yml')
  })

  it('serves the file browser and injects the routed API base', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('')
    const index = await http(ctx, 'GET', '/dsh-agfs/')
    expect(index.status).toBe(200)
    expect(index.body).toContain('<title>文件浏览器</title>')
    expect(index.body).toContain("window.__DSH_AGFS__={apiPrefix:'/dsh-agfs/api/file_browser/'};")
    // Boot runs on vendored React and the precompiled app; no CDN script tags.
    expect(index.body).toContain('vendor/react.production.min.js')
    expect(index.body).toContain('vendor/react-dom.production.min.js')
    expect(index.body).toContain('app.js?v=2')
    expect(index.body).not.toContain('unpkg.com')
    expect(index.body).not.toContain('babel')
    const bare = await http(ctx, 'GET', '/dsh-agfs')
    expect(bare.status).toBe(200)
    expect(bare.body).toContain('<title>文件浏览器</title>')
    const explicitIndex = await http(ctx, 'GET', '/dsh-agfs/index.html')
    expect(explicitIndex.status).toBe(200)
    expect(explicitIndex.body).toContain('<title>文件浏览器</title>')
    const jsx = await http(ctx, 'GET', '/dsh-agfs/app.jsx')
    expect(jsx.status).toBe(200)
    expect(jsx.body).toContain('API_PREFIX')
    const css = await http(ctx, 'GET', '/dsh-agfs/webbrowser.css')
    expect(css.status).toBe(200)
    expect(css.body.length).toBeGreaterThan(1000)
    // Static assets answer GET/HEAD only.
    const post = await http(ctx, 'POST', '/dsh-agfs/', {})
    expect(post.status).toBe(405)
    expect(JSON.parse(post.body)).toEqual({ success: false, error: '方法不允许' })
    const head = await http(ctx, 'HEAD', '/dsh-agfs/')
    expect(head.status).toBe(200)
  })

  it('answers the file_browser API over a real socket', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('')
    const listed = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/list?path=')
    const listJson = JSON.parse(listed.body) as { success: boolean; data: { items: unknown[]; root_path: string } }
    expect(listJson.success).toBe(true)
    expect(listJson.data.items).toEqual([])
    expect(listJson.data.root_path.replace(/\\/g, '/')).toBe(join(root ?? '', 'browse').replace(/\\/g, '/'))

    const created = await http(ctx, 'POST', '/dsh-agfs/api/file_browser/create_folder', { path: 'made' })
    expect(JSON.parse(created.body)).toMatchObject({ success: true })
    const relisted = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/list?path=')
    expect((JSON.parse(relisted.body) as { data: { items: Array<{ name: string }> } }).data.items.map(item => item.name))
      .toEqual(['made'])

    const mode = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/mode')
    expect((JSON.parse(mode.body) as { data: { remote_mode: boolean } }).data.remote_mode).toBe(false)

    const download = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/download?path=made')
    // 'made' is a folder: downloading it is a 400, not a file stream.
    expect(download.status).toBe(400)
    expect(JSON.parse(download.body)).toEqual({ success: false, error: '不是文件' })
    const missing = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/download?path=nope')
    expect(missing.status).toBe(404)
  })

  it('rejects malformed JSON bodies and invalid URLs with 400', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('')
    const badJson = await new Promise<HttpResponse>((resolvePromise, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: ctx.webServer.port,
        path: '/dsh-agfs/api/file_browser/create_folder',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let raw = ''
        res.on('data', (chunk: Buffer) => { raw += chunk.toString() })
        res.on('end', () => {
          resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: raw })
        })
      })
      req.on('error', reject)
      req.write('{not json')
      req.end()
    })
    expect(badJson.status).toBe(400)
    expect(JSON.parse(badJson.body)).toEqual({ success: false, error: '无效的 JSON' })

    const invalidUrl = await http(ctx, 'GET', '/dsh-agfs/%E0%A4%A')
    expect(invalidUrl.status).toBe(400)
    expect(JSON.parse(invalidUrl.body)).toEqual({ success: false, error: '无效的请求地址' })
  })

  it('merges a query filepath into POST bodies', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('')
    const browse = join(root ?? '', 'browse')
    const created = await http(
      ctx,
      'POST',
      `/dsh-agfs/api/file_browser/create_folder?filepath=${encodeURIComponent(browse)}`,
      { path: 'via-query' },
    )
    expect(JSON.parse(created.body)).toMatchObject({ success: true })
    const listed = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/list?path=')
    expect((JSON.parse(listed.body) as { data: { items: Array<{ name: string }> } }).data.items.map(item => item.name))
      .toEqual(['via-query'])
  })

  it.each(['x', '/x/', '/'])('fails boot when basePath is %j', async (basePath) => {
    await expect(loadComposition(`    basePath: ${basePath}`)).rejects.toThrow()
  }, 60_000)

  it('fails boot when the plugin is mounted twice', { timeout: 60_000 }, async () => {
    await expect(loadComposition('', { extraRows: `- name: '${AGFS}'` })).rejects.toThrow()
  })

  it('mounts with plugin defaults and opens the browser on command', { timeout: 60_000 }, async () => {
    openControl.openInBrowser.mockResolvedValue(undefined)
    const { ctx } = await loadComposition('', { withRoots: false })
    const agent = mintAgent(ctx)
    const result = await ctx.commands.execute(agent, '/dsh-agfs', new AbortController().signal)
    expect(result?.result).toEqual({
      kind: 'success',
      text: `文件浏览器已打开: http://127.0.0.1:${ctx.webServer.port}/dsh-agfs/`,
    })
    expect(openControl.openInBrowser).toHaveBeenCalledTimes(1)
  })

  it('accepts the debug config flag and still serves the API', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('    debug: true')
    const listed = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/list?path=')
    expect((JSON.parse(listed.body) as { success: boolean }).success).toBe(true)
  })

  it('validates analyze requests and fails loud without the workspace service', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('')
    const browse = join(root ?? '', 'browse')
    const noReq = await http(ctx, 'POST', '/dsh-agfs/api/file_browser/analyze', { path: browse })
    expect(noReq.status).toBe(400)
    expect(JSON.parse(noReq.body)).toEqual({ success: false, error: '缺少需求描述' })
    const noPath = await http(ctx, 'POST', '/dsh-agfs/api/file_browser/analyze', { requirement: '分析' })
    expect(noPath.status).toBe(400)
    expect(JSON.parse(noPath.body)).toEqual({ success: false, error: '缺少path参数' })
    const missing = await http(ctx, 'POST', '/dsh-agfs/api/file_browser/analyze', { path: join(browse, 'nope'), requirement: '分析' })
    expect(missing.status).toBe(404)
    const getOnly = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/analyze?path=x')
    expect(getOnly.status).toBe(405)
    // The bare composition mounts no workspace/agent services, so a valid
    // request fails loud instead of silently doing nothing.
    const started = await http(ctx, 'POST', '/dsh-agfs/api/file_browser/analyze', { path: browse, requirement: '分析这个目录' })
    expect(started.status).toBe(500)
    expect((JSON.parse(started.body) as { error: string }).error).toContain('工作区服务不可用')
  })

  it('rejects analyze in remote mode', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('    remoteMode: true')
    const browse = join(root ?? '', 'browse')
    const started = await http(ctx, 'POST', '/dsh-agfs/api/file_browser/analyze', { path: browse, requirement: 'x' })
    expect(started.status).toBe(403)
    expect(JSON.parse(started.body)).toEqual({ success: false, error: '远程模式下不支持AI分析' })
  })

  it('answers every read-only endpoint over HTTP with the contract envelope', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('')
    const browse = join(root ?? '', 'browse')
    await writeFile(join(browse, 'hello.txt'), 'hello 世界')
    await writeFile(join(browse, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))
    await writeFile(join(browse, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]))

    const read = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/read?path=hello.txt')
    expect(JSON.parse(read.body)).toEqual({
      success: true,
      data: { name: 'hello.txt', path: 'hello.txt', content: 'hello 世界', size: Buffer.byteLength('hello 世界') },
    })

    const search = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/search?path=&keyword=hello')
    const searchJson = JSON.parse(search.body) as { success: boolean; data: { results: Array<{ name: string }> } }
    expect(searchJson.success).toBe(true)
    expect(searchJson.data.results.map(item => item.name)).toEqual(['hello.txt'])

    const info = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/info')
    const infoJson = JSON.parse(info.body) as { success: boolean; data: { root: string } }
    expect(infoJson.success).toBe(true)
    expect(infoJson.data.root.replace(/\\/g, '/')).toBe(browse.replace(/\\/g, '/'))

    const workspace = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/workspace')
    expect((JSON.parse(workspace.body) as { success: boolean }).success).toBe(true)

    const sidebar = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/sidebar')
    const sidebarJson = JSON.parse(sidebar.body) as { success: boolean; data: { project: string | null } }
    expect(sidebarJson.success).toBe(true)
    expect(sidebarJson.data.project?.replace(/\\/g, '/')).toBe(browse.replace(/\\/g, '/'))

    const debug = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/debug')
    expect((JSON.parse(debug.body) as { success: boolean; debug: { os_name: string } }).debug.os_name).toBe(process.platform)

    const binary = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/read?path=bin.dat')
    expect(binary.status).toBe(400)
    expect(JSON.parse(binary.body)).toEqual({ success: false, error: '无法读取二进制文件' })

    const unknown = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/bogus')
    expect(unknown.status).toBe(404)
    expect(JSON.parse(unknown.body)).toEqual({ success: false, error: '接口不存在' })
  })

  it('mutates files over HTTP and keeps the envelope', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('')
    const browse = join(root ?? '', 'browse')
    await writeFile(join(browse, 'a.txt'), 'alpha')

    const renamed = await http(ctx, 'POST', '/dsh-agfs/api/file_browser/rename', { path: 'a.txt', new_name: 'b.txt' })
    expect(JSON.parse(renamed.body)).toMatchObject({ success: true, new_path: 'b.txt' })
    const copied = await http(ctx, 'POST', '/dsh-agfs/api/file_browser/copy', { path: 'b.txt', dest_path: 'c.txt' })
    expect(JSON.parse(copied.body)).toMatchObject({ success: true, dest_path: 'c.txt' })
    const created = await http(ctx, 'POST', '/dsh-agfs/api/file_browser/create_folder', { path: 'made' })
    expect(JSON.parse(created.body)).toMatchObject({ success: true })
    const deleted = await http(ctx, 'POST', '/dsh-agfs/api/file_browser/delete', { path: 'made' })
    expect(JSON.parse(deleted.body)).toMatchObject({ success: true })

    const conflict = await http(ctx, 'POST', '/dsh-agfs/api/file_browser/create_folder', { path: 'b.txt' })
    expect(conflict.status).toBe(409)
    expect(JSON.parse(conflict.body)).toEqual({ success: false, error: '文件夹已存在' })
    const missingDelete = await http(ctx, 'POST', '/dsh-agfs/api/file_browser/delete', { path: 'nope' })
    expect(missingDelete.status).toBe(404)

    const listed = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/list?path=')
    const names = (JSON.parse(listed.body) as { data: { items: Array<{ name: string }> } }).data.items.map(item => item.name)
    expect(names).toEqual(['b.txt', 'c.txt'])
    const content = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/read?path=c.txt')
    expect((JSON.parse(content.body) as { data: { content: string } }).data.content).toBe('alpha')
  })

  it('streams real file content over HTTP', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('')
    const browse = join(root ?? '', 'browse')
    const payload = 'download-body-内容'
    await writeFile(join(browse, 'doc.txt'), payload)
    await writeFile(join(browse, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const download = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/download?path=doc.txt')
    expect(download.status).toBe(200)
    expect(String(download.headers['content-type'])).toContain('text/plain')
    expect(String(download.headers['content-disposition'])).toContain('doc.txt')
    expect(download.body).toBe(payload)

    const thumb = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/thumbnail?path=img.png', undefined, 'latin1')
    expect(thumb.status).toBe(200)
    expect(String(thumb.headers['content-type'])).toBe('image/png')
    expect(thumb.body).toBe('\u0089PNG')
  })

  it('searches recursively over HTTP and honors read-only mode', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('    readOnly: true')
    const browse = join(root ?? '', 'browse')
    await mkdir(join(browse, 'sub'))
    await writeFile(join(browse, 'sub', 'needle.txt'), 'x')
    await writeFile(join(browse, 'top.txt'), 'x')

    const shallow = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/search?path=&keyword=needle')
    expect((JSON.parse(shallow.body) as { data: { results: unknown[] } }).data.results).toEqual([])
    const recursive = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/search?path=&keyword=needle&recursive=1')
    const recursiveJson = JSON.parse(recursive.body) as { data: { recursive: boolean; results: Array<{ path: string }> } }
    expect(recursiveJson.data.recursive).toBe(true)
    expect(recursiveJson.data.results).toEqual([expect.objectContaining({ path: 'sub/needle.txt' })])

    const read = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/read?path=sub/needle.txt')
    expect((JSON.parse(read.body) as { data: { content: string } }).data.content).toBe('x')
    const created = await http(ctx, 'POST', '/dsh-agfs/api/file_browser/create_folder', { path: 'blocked' })
    expect(created.status).toBe(403)
    expect(JSON.parse(created.body)).toEqual({ success: false, error: '只读模式' })
    const deleted = await http(ctx, 'POST', '/dsh-agfs/api/file_browser/delete', { path: 'top.txt' })
    expect(deleted.status).toBe(403)
  })

  it('serves security headers on static and API responses', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('')
    const index = await http(ctx, 'GET', '/dsh-agfs/')
    expect(String(index.headers['x-content-type-options'])).toBe('nosniff')
    expect(String(index.headers['x-frame-options'])).toBe('DENY')
    expect(String(index.headers['referrer-policy'])).toBe('no-referrer')
    const jsx = await http(ctx, 'GET', '/dsh-agfs/app.jsx')
    expect(String(jsx.headers['x-content-type-options'])).toBe('nosniff')
    expect(String(jsx.headers['cache-control'])).toBe('no-cache')
    const list = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/list?path=')
    expect(String(list.headers['x-content-type-options'])).toBe('nosniff')
    expect(String(list.headers['x-frame-options'])).toBe('DENY')
    expect(String(list.headers['referrer-policy'])).toBe('no-referrer')
    await writeFile(join(root ?? '', 'browse', 'dl.txt'), 'x')
    const download = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/download?path=dl.txt')
    expect(String(download.headers['x-content-type-options'])).toBe('nosniff')
    expect(String(download.headers['x-frame-options'])).toBe('DENY')
  })

  it('serves configured roots in the sidebar over HTTP', { timeout: 60_000 }, async () => {
    const extraRoot = await mkdtemp(join(tmpdir(), 'dsh-agfs-extra-root-'))
    const { ctx } = await loadComposition('', { rootsConfig: { Work: extraRoot, Ghost: join(extraRoot, 'missing') } })
    const sidebar = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/sidebar')
    const roots = (JSON.parse(sidebar.body) as { data: { roots: Array<{ name: string; path: string }> } }).data.roots
    const expectedPath = extraRoot.length >= 2 && extraRoot[1] === ':'
      ? extraRoot.replace(/\//g, '\\')
      : extraRoot.replace(/\\/g, '/')
    expect(roots).toEqual([{ name: 'Work', path: expectedPath }])
    await rm(extraRoot, { recursive: true, force: true })
  })

  it('locks browsing to the root in strict mode', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('    strictRoot: true')
    const browse = join(root ?? '', 'browse')
    await writeFile(join(browse, 'a.txt'), 'x')

    const list = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/list?path=')
    expect((JSON.parse(list.body) as { success: boolean }).success).toBe(true)
    const read = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/read?path=a.txt')
    expect((JSON.parse(read.body) as { data: { content: string } }).data.content).toBe('x')
    const created = await http(ctx, 'POST', '/dsh-agfs/api/file_browser/create_folder', { path: 'made' })
    expect(JSON.parse(created.body)).toMatchObject({ success: true })

    // Absolute-path escapes answer a clean 400 envelope.
    const escape = await http(ctx, 'GET', '/dsh-agfs/api/file_browser/read?path=C%3A%5CWindows%5Cwin.ini')
    expect(escape.status).toBe(400)
    expect(JSON.parse(escape.body)).toEqual({ success: false, error: '路径超出允许范围' })
  })

  it('serves the enhanced frontend with text preview support', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('')
    const jsx = await http(ctx, 'GET', '/dsh-agfs/app.jsx')
    expect(jsx.body).toContain('TEXT_PREVIEW_EXTS')
    expect(jsx.body).toContain('isTextPreview')
    expect(jsx.body).toContain('自定义根')
    // The local-mode floating button opens the system file manager at the
    // current directory; its marker lives in the served source and bundle.
    expect(jsx.body).toContain('open-local-float')
    expect(jsx.body).toContain('本地打开')
    // The three display sizes (view / whole / fullscreen) cycle through a
    // toolbar button; their markers live in the served source and bundle.
    expect(jsx.body).toContain('sizeMode')
    expect(jsx.body).toContain('size-view')
    expect(jsx.body).toContain('size-whole')
    expect(jsx.body).toContain('视图大小')
    expect(jsx.body).toContain('整个视图')
    // The one-click AI analysis entry: context-menu item and dialog markers.
    expect(jsx.body).toContain('一键AI分析')
    expect(jsx.body).toContain('开始分析')
    expect(jsx.body).toContain('analyze-input')
    // The theme support: a toolbar button cycles modern (default) and the
    // optional Win10 theme; markers live in the served source and bundle.
    expect(jsx.body).toContain('theme-win10')
    expect(jsx.body).toContain('theme-mode-label')
    expect(jsx.body).toContain('Win10')
    // The precompiled bundle the page actually loads carries the same markers.
    const app = await http(ctx, 'GET', '/dsh-agfs/app.js')
    expect(app.status).toBe(200)
    expect(app.body).toContain('isTextPreview')
    expect(app.body).toContain('自定义根')
    expect(app.body).toContain('__DSH_AGFS__')
    expect(app.body).toContain('open-local-float')
    expect(app.body).toContain('本地打开')
    expect(app.body).toContain('sizeMode')
    expect(app.body).toContain('size-view')
    expect(app.body).toContain('size-whole')
    expect(app.body).toContain('视图大小')
    expect(app.body).toContain('整个视图')
    expect(app.body).toContain('一键AI分析')
    expect(app.body).toContain('开始分析')
    expect(app.body).toContain('analyze-input')
    expect(app.body).toContain('theme-win10')
    expect(app.body).toContain('theme-mode-label')
    expect(app.body).toContain('Win10')
    const react = await http(ctx, 'GET', '/dsh-agfs/vendor/react.production.min.js')
    expect(react.status).toBe(200)
    const reactDom = await http(ctx, 'GET', '/dsh-agfs/vendor/react-dom.production.min.js')
    expect(reactDom.status).toBe(200)
    const css = await http(ctx, 'GET', '/dsh-agfs/webbrowser.css')
    expect(css.body).toContain('.preview-text')
    expect(css.body).toContain('body.theme-win10')
    expect(css.body).toContain('.browser.theme-win10')
  })

  it('registers and executes the browse_files tool in the real composition', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('')
    const browse = join(root ?? '', 'browse')
    await writeFile(join(browse, 'a.txt'), 'x')
    await mkdir(join(browse, 'sub'))
    await writeFile(join(browse, 'sub', 'alpha.md'), 'y')
    const agent = mintAgent(ctx)

    const schema = ctx.tools.schemas().find(tool => tool.name === 'browse_files')
    expect(schema).toBeDefined()
    const listed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composition-browse-1'),
      name: 'browse_files',
      arguments: { path: '' },
      agent,
    })
    expect(listed.isError).toBe(false)
    if (listed.isError) throw new Error('expected browse_files success')
    expect((listed.value as { items: Array<{ name: string }> }).items.map(item => item.name)).toEqual(['sub', 'a.txt'])
    const searched = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composition-browse-2'),
      name: 'browse_files',
      arguments: { path: '', keyword: 'alpha', recursive: true },
      agent,
    })
    if (searched.isError) throw new Error('expected browse_files success')
    expect((searched.value as { items: Array<{ name: string }> }).items.map(item => item.name)).toEqual(['alpha.md'])
    const failed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composition-browse-3'),
      name: 'browse_files',
      arguments: { path: 'missing' },
      agent,
    })
    expect(failed.isError).toBe(true)
  })

  it('logs the command lifecycle and answers concurrent requests', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('    openOnCommand: false')
    const agent = mintAgent(ctx)
    const executed = await ctx.commands.execute(agent, '/dsh-agfs', new AbortController().signal)
    if (executed?.result.kind !== 'success') throw new Error('expected success')
    const events = agent.session.events.filter(event => event.type === 'command/run' || event.type === 'command/done')
    const run = events.find(event => event.type === 'command/run')
    const done = events.find(event => event.type === 'command/done')
    expect(run?.data).toMatchObject({ commandId: executed.commandId, name: 'dsh-agfs' })
    expect(done?.data).toMatchObject({ commandId: executed.commandId, kind: 'success' })

    const responses = await Promise.all(Array.from({ length: 8 }, () =>
      http(ctx, 'GET', '/dsh-agfs/api/file_browser/list?path=')))
    for (const response of responses) {
      expect(response.status).toBe(200)
      expect((JSON.parse(response.body) as { success: boolean }).success).toBe(true)
    }
  })

  it('404s unknown assets and out-of-prefix paths', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('')
    const missing = await http(ctx, 'GET', '/dsh-agfs/nope.js')
    expect(missing.status).toBe(404)
    expect(JSON.parse(missing.body)).toEqual({ success: false, error: '文件不存在' })
    // Dot segments are normalized away by the URL parser before the handler,
    // so an escape attempt never reaches the plugin's route.
    const escape = await http(ctx, 'GET', '/dsh-agfs/../outside')
    expect(escape.status).toBe(404)
  })

  it('registers and executes the /dsh-agfs command', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('    openOnCommand: false')
    const agent = mintAgent(ctx)
    const descriptors = ctx.commands.list(agent)
    expect(descriptors.map(item => item.name)).toContain('dsh-agfs')
    expect(ctx.commands.find(agent, 'dsh-agfs')?.description).toBe('Open the file browser in the system browser')

    const executed = await ctx.commands.execute(agent, '/dsh-agfs', new AbortController().signal)
    expect(executed?.result.kind).toBe('success')
    if (executed?.result.kind !== 'success') return
    expect(executed.result.text).toContain(`http://127.0.0.1:${ctx.webServer.port}/dsh-agfs/`)
    expect(openControl.openInBrowser).not.toHaveBeenCalled()

    const withArgs = await ctx.commands.execute(agent, '/dsh-agfs extra', new AbortController().signal)
    expect(withArgs?.result.kind).toBe('error')
    if (withArgs?.result.kind !== 'error') return
    expect(withArgs.result.text).toContain('Usage: /dsh-agfs')
  })

  it('opens the browser on command when enabled, and reports failure', { timeout: 60_000 }, async () => {
    openControl.openInBrowser.mockResolvedValue(undefined)
    const opened = await loadComposition('    openOnCommand: true')
    const agent = mintAgent(opened.ctx)
    const result = await opened.ctx.commands.execute(agent, '/dsh-agfs', new AbortController().signal)
    expect(result?.result).toEqual({
      kind: 'success',
      text: `文件浏览器已打开: http://127.0.0.1:${opened.ctx.webServer.port}/dsh-agfs/`,
    })
    expect(openControl.openInBrowser).toHaveBeenCalledTimes(1)
    await opened.ctx.fiber.dispose()
    context = undefined

    openControl.openInBrowser.mockRejectedValue('no browser')
    const failed = await loadComposition('    openOnCommand: true')
    const failedAgent = mintAgent(failed.ctx)
    const failedResult = await failed.ctx.commands.execute(failedAgent, '/dsh-agfs', new AbortController().signal)
    expect(failedResult?.result.kind).toBe('error')
    if (failedResult?.result.kind !== 'error') return
    expect(failedResult.result.text).toContain('无法打开浏览器')
    await failed.ctx.fiber.dispose()
    context = undefined

    openControl.openInBrowser.mockRejectedValue(new Error('no browser binary'))
    const errored = await loadComposition('    openOnCommand: true')
    const erroredAgent = mintAgent(errored.ctx)
    const erroredResult = await errored.ctx.commands.execute(erroredAgent, '/dsh-agfs', new AbortController().signal)
    expect(erroredResult?.result.kind).toBe('error')
    if (erroredResult?.result.kind !== 'error') return
    expect(erroredResult.result.text).toContain('no browser binary')
  })

  it('opens the browser at the session workspace directory on command', { timeout: 60_000 }, async () => {
    openControl.openInBrowser.mockResolvedValue(undefined)
    const { ctx } = await loadComposition('')
    const browse = join(root ?? '', 'browse')
    const agent = mintWorkspaceAgent(ctx, browse)
    const expectedUrl = `http://127.0.0.1:${ctx.webServer.port}/dsh-agfs/?path=${encodeURIComponent(browse)}`
    const result = await ctx.commands.execute(agent, '/dsh-agfs', new AbortController().signal)
    expect(result?.result).toEqual({ kind: 'success', text: `文件浏览器已打开: ${expectedUrl}` })
    expect(openControl.openInBrowser).toHaveBeenCalledWith(expectedUrl)
  })

  it('reports the workspace URL without opening when disabled', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('    openOnCommand: false')
    const browse = join(root ?? '', 'browse')
    const agent = mintWorkspaceAgent(ctx, browse)
    const result = await ctx.commands.execute(agent, '/dsh-agfs', new AbortController().signal)
    expect(result?.result).toEqual({
      kind: 'success',
      text: `文件浏览器: http://127.0.0.1:${ctx.webServer.port}/dsh-agfs/?path=${encodeURIComponent(browse)}`,
    })
  })

  it('falls back to the bare URL when the session cwd directory is missing', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('')
    const agent = mintWorkspaceAgent(ctx, join(root ?? '', 'missing-workspace'))
    const result = await ctx.commands.execute(agent, '/dsh-agfs', new AbortController().signal)
    expect(result?.result).toEqual({
      kind: 'success',
      text: `文件浏览器已打开: http://127.0.0.1:${ctx.webServer.port}/dsh-agfs/`,
    })
  })

  it('disposing the plugin fiber removes the route and the command', { timeout: 60_000 }, async () => {
    const { ctx } = await loadComposition('')
    const agent = mintAgent(ctx)
    expect(ctx.commands.find(agent, 'dsh-agfs')).toBeDefined()
    const entry = [...ctx.loader.entries()].find(item => item.options.name === AGFS)
    if (entry?.fiber === undefined) throw new Error('expected the dsh-agfs loader entry')
    await entry.fiber.dispose()
    expect(ctx.commands.find(agent, 'dsh-agfs')).toBeUndefined()
    const after = await http(ctx, 'GET', '/dsh-agfs/')
    expect(after.status).toBe(404)
  })
})
