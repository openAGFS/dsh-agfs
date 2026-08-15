/**
 * Model-facing file-browsing tool over the dsh-agfs browser core. The tool
 * reuses `dispatchApi` (the same pure seam the HTTP layer materializes), so
 * listing and recursive search behave identically for the model and the web
 * UI. It is registered by the plugin on `ctx.tools`; its parameter schema
 * flows into the model prompt automatically.
 * @module @agfs/dsh-agfs/tool
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
      const query: Query = {
        path: args.path ?? '',
        ...args.keyword !== undefined ? { keyword: args.keyword } : {},
        ...args.recursive === true ? { recursive: '1' } : {},
      }
      const outcome = await dispatchApi(
        'GET', args.keyword !== undefined ? 'search' : 'list', query, {}, config, '127.0.0.1', '',
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
