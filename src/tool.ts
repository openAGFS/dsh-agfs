/**
 * Model-facing file-browsing tools over the dsh-agfs browser core. The tools
 * reuse `dispatchApi` (the same pure seam the HTTP layer materializes), so
 * listing, searching, and reading behave identically for the model and the web
 * UI. They are registered by the plugin on `ctx.tools`; their parameter
 * schemas flow into the model prompt automatically.
 * @module @open-agfs/dsh-agfs/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { dispatchApi } from './handler.ts'
import type { AgfsConfig, Query } from './types.ts'

/** Format one canonical browse result as model-visible text lines. */
function renderBrowse(value: unknown): string {
  /* v8 ignore next -- the canonical value always carries an items array */
  const items = (value as { items?: ReadonlyArray<Readonly<Record<string, unknown>>> }).items ?? []
  if (items.length === 0) return '(empty)'
  const lines = items.map((item) => {
    const type = item.type === 'folder' ? 'DIR' : 'FILE'
    const size = typeof item.size === 'string' ? item.size : ''
    /* v8 ignore next -- listing entries always carry a string path, so the name and empty fallbacks are unreachable */
    const display = typeof item.path === 'string' ? item.path : typeof item.name === 'string' ? item.name : ''
    return `${type}\t${size}\t${display}`
  })
  return lines.join('\n')
}

/**
 * Register the `browse_files` tool.
 * @param ctx - context carrying the tool registry.
 * @param config - resolved plugin configuration (browser root and modes).
 * @returns the exact effect disposer that unregisters the tool.
 */
export function registerFileBrowseTool(ctx: Context, config: AgfsConfig): () => void {
  return ctx.tools.register(defineTool({
    name: 'browse_files',
    description: 'List entries in a directory of the file browser, or search entry names (optionally recursively). '
      + 'Returns name, path, type, size, and modification time per entry.',
    parameters: {
      path: { type: 'string', description: 'Directory path relative to the browser root; empty lists the root' },
      keyword: { type: 'string', description: 'When set, search entry names for this keyword instead of listing' },
      recursive: { type: 'boolean', description: 'Search recursively under the path (only with keyword)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderBrowse(value) }],
    },
    async execute(args) {
      // A blank keyword (e.g. a model emitting `keyword: ""`) means "no
      // search": fall back to a plain listing instead of failing the search
      // endpoint's keyword requirement.
      const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : ''
      const query: Query = {
        path: args.path ?? '',
        ...keyword !== '' ? { keyword } : {},
        ...args.recursive === true ? { recursive: '1' } : {},
      }
      const outcome = await dispatchApi(
        'GET', keyword !== '' ? 'search' : 'list', query, {}, config, '127.0.0.1', '',
      )
      if (outcome.kind === 'error') throw new Error(outcome.error)
      /* v8 ignore next -- list and search never produce a stream outcome */
      if (outcome.kind === 'stream') throw new Error('unexpected stream outcome')
      const data = outcome.data as { items?: unknown[]; results?: unknown[] } | undefined
      /* v8 ignore next -- the final fallback is unreachable: list and search always carry one of the two arrays */
      const items = (Array.isArray(data?.items) ? data.items : Array.isArray(data?.results) ? data.results : []) as JsonValue[]
      return { items }
    },
  }))
}

/**
 * Register the `read_file` tool: read one UTF-8 text file under the browser
 * root so an analysis agent can inspect file contents, not only names.
 * @param ctx - context carrying the tool registry.
 * @param config - resolved plugin configuration (browser root and modes).
 * @returns the exact effect disposer that unregisters the tool.
 */
export function registerFileReadTool(ctx: Context, config: AgfsConfig): () => void {
  return ctx.tools.register(defineTool({
    name: 'read_file',
    description: 'Read a UTF-8 text file under the browser root (markdown, code, logs). '
      + 'Returns the file path and its content.',
    parameters: {
      path: { type: 'string', description: 'File path relative to the browser root' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { path?: string; content?: string }
        return [{ type: 'text', text: `--- ${v.path ?? ''} ---\n${v.content ?? ''}` }]
      },
    },
    async execute(args) {
      const path = typeof args.path === 'string' ? args.path : ''
      if (path === '') throw new Error('缺少path参数')
      const outcome = await dispatchApi('GET', 'read', { path }, {}, config, '127.0.0.1', '')
      if (outcome.kind === 'error') throw new Error(outcome.error)
      /* v8 ignore next -- read never produces a stream outcome */
      if (outcome.kind === 'stream') throw new Error('unexpected stream outcome')
      const data = outcome.data as { path?: string; content?: string } | undefined
      return { path: data?.path ?? path, content: data?.content ?? '' }
    },
  }))
}
