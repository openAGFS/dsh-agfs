/**
 * Unit coverage for the `browse_files` model tool: schema registration,
 * listing/search/recursive execution over the pure browser core, error
 * outcomes, mode enforcement, and HMR disposal of the registration.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { registerFileBrowseTool, registerFileReadTool } from '../src/tool.ts'
import type { AgfsConfig } from '../src/types.ts'

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

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function tempDir(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-agfs-tool-'))
  return root
}

async function setup(overrides: Partial<AgfsConfig> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  registerFileBrowseTool(ctx, config(overrides))
  return ctx
}

interface BrowseResult {
  isError: boolean
  value?: unknown
  content: Array<{ type: string; text?: string }>
}

function browse(ctx: Context, args: Record<string, unknown>): Promise<BrowseResult> {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('call-tool-1'),
    name: 'browse_files',
    arguments: args,
  })
}

/** Join the text fragments of a tool result. */
function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('browse_files tool', () => {
  it('registers a tool whose parameter schema names path, keyword, and recursive', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'browse_files')
    expect(schema).toBeDefined()
    const props = (schema?.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['keyword', 'path', 'recursive'])
    expect(props.path).toMatchObject({ type: 'string' })
    expect(props.keyword).toMatchObject({ type: 'string' })
    expect(props.recursive).toMatchObject({ type: 'boolean' })
  })

  it('lists a directory with the canonical items array', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.txt'), 'x')
    await mkdir(join(dir, 'sub'))
    const ctx = await setup({ fileRoot: dir })
    // An omitted path lists the root.
    const result = await browse(ctx, {})
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const items = (result.value as { items: Array<{ name: string; type: string }> }).items
    expect(items.map(item => item.name)).toEqual(['sub', 'a.txt'])
    expect(text(result)).toContain('a.txt')
    expect(text(result)).toContain('DIR')
  })

  it('renders an empty directory as (empty)', async () => {
    const dir = await tempDir()
    const ctx = await setup({ fileRoot: dir })
    const result = await browse(ctx, { path: '' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect((result.value as { items: unknown[] }).items).toEqual([])
    expect(text(result)).toBe('(empty)')
  })

  it('lists a subdirectory and searches by keyword', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'needle-root.txt'), 'r')
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'sub', 'needle.md'), 'y')
    const ctx = await setup({ fileRoot: dir })
    const listed = await browse(ctx, { path: 'sub' })
    if (listed.isError) throw new Error('expected success')
    expect((listed.value as { items: Array<{ name: string }> }).items.map(item => item.name)).toEqual(['needle.md'])
    // Shallow search only sees the root level.
    const searched = await browse(ctx, { path: '', keyword: 'needle' })
    if (searched.isError) throw new Error('expected success')
    expect((searched.value as { items: Array<{ name: string }> }).items.map(item => item.name)).toEqual(['needle-root.txt'])
    // Recursive search descends into subdirectories.
    const recursive = await browse(ctx, { path: '', keyword: 'needle', recursive: true })
    if (recursive.isError) throw new Error('expected success')
    expect((recursive.value as { items: Array<{ name: string }> }).items.map(item => item.name))
      .toEqual(['needle-root.txt', 'needle.md'])
  })

  it('reports browser errors as isError results', async () => {
    const dir = await tempDir()
    const ctx = await setup({ fileRoot: dir })
    const missing = await browse(ctx, { path: 'nope' })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('路径不存在')
    // A blank keyword is not a search: it falls back to a plain listing.
    const blankKeyword = await browse(ctx, { path: '', keyword: '' })
    expect(blankKeyword.isError).toBe(false)
    expect(text(blankKeyword)).toBe('(empty)')
  })

  it('respects strict-root confinement and read-only mode', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.txt'), 'x')
    const strictCtx = await setup({ fileRoot: dir, strictRoot: true })
    const escaped = await browse(strictCtx, { path: 'C:\\Windows\\win.ini' })
    expect(escaped.isError).toBe(true)
    expect(text(escaped)).toContain('路径超出允许范围')
    const inside = await browse(strictCtx, { path: '' })
    expect(inside.isError).toBe(false)
  })

  it('disposes the registration with its plugin fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      registerFileBrowseTool(inner, config())
    }, { inject: ['tools'] }))
    expect(ctx.tools.schemas().some(tool => tool.name === 'browse_files')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(tool => tool.name === 'browse_files')).toBe(false)
  })
})

describe('read_file tool', () => {
  async function setupRead(overrides: Partial<AgfsConfig> = {}): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    registerFileReadTool(ctx, config(overrides))
    return ctx
  }

  function read(ctx: Context, args: Record<string, unknown>): Promise<BrowseResult> {
    return ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('call-read-1'),
      name: 'read_file',
      arguments: args,
    })
  }

  it('registers a tool whose parameter schema names only path', async () => {
    const ctx = await setupRead()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'read_file')
    expect(schema).toBeDefined()
    const props = (schema?.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['path'])
  })

  it('reads a UTF-8 text file under the root and renders its content', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'README.md'), '# Hello\n\nSome **markdown** content.')
    const ctx = await setupRead({ fileRoot: dir })
    const result = await read(ctx, { path: 'README.md' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toMatchObject({ path: 'README.md', content: '# Hello\n\nSome **markdown** content.' })
    expect(text(result)).toContain('# Hello')
  })

  it('rejects a missing path and a missing file with isError results', async () => {
    const dir = await tempDir()
    const ctx = await setupRead({ fileRoot: dir })
    const noPath = await read(ctx, {})
    expect(noPath.isError).toBe(true)
    expect(text(noPath)).toContain('缺少path参数')
    const missing = await read(ctx, { path: 'nope.md' })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('文件不存在')
  })

  it('rejects reading a directory', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'sub'))
    const ctx = await setupRead({ fileRoot: dir })
    const result = await read(ctx, { path: 'sub' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('不是文件')
  })

  it('disposes the registration with its plugin fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      registerFileReadTool(inner, config())
    }, { inject: ['tools'] }))
    expect(ctx.tools.schemas().some(tool => tool.name === 'read_file')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(tool => tool.name === 'read_file')).toBe(false)
  })
})
