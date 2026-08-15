/**
 * @open-agfs/dsh-agfs — file-browser web app served by the host webserver
 * with a human `/dsh-agfs` command. The plugin registers a prefix route at
 * `basePath` (static assets plus the `file_browser` API, ported from the
 * standalone server.js backend) and a command that opens the app in the system
 * default browser. Everything rides the composing dsh web server: no separate
 * port, no process.
 * @module @open-agfs/dsh-agfs
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-workspace'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { dispatchApi, getClientIp, getSafePath, readJsonBody, resolveAsset, writeOutcome } from './handler.ts'
import { openInBrowser } from './open.ts'
import { registerFileBrowseTool } from './tool.ts'
import type { AgfsConfig, Body, Query } from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-agfs'

/** Services required before the route, command, and tool can be registered. */
export const inject = ['commands', 'webServer', 'tools']

/** Plugin configuration. */
export interface Config {
  /** Webserver route prefix serving the app and its API; must start with `/` and have no trailing slash. */
  basePath: string
  /** File-browser root; empty resolves to the current working directory. */
  fileRoot: string
  /** Project root shown in the sidebar; empty resolves to the working directory. */
  projectRoot: string
  /** Remote mode: disables open-in-system, open-location, and copy endpoints. */
  remoteMode: boolean
  /** Read-only mode: disables delete, create, rename, and copy endpoints. */
  readOnly: boolean
  /** Strict-root mode: locks browsing inside fileRoot and rejects absolute and symlink escapes. */
  strictRoot: boolean
  /** Named browse roots shown in the sidebar (name -> path). */
  roots: Record<string, string>
  /** Whether `/dsh-agfs` opens the file browser in the system default browser. */
  openOnCommand: boolean
  /** Debug logging: API calls and system-open results to stderr. */
  debug: boolean
}

export const Config: z<Config> = z.object({
  basePath: z.string().default('/dsh-agfs'),
  fileRoot: z.string().default(''),
  projectRoot: z.string().default(''),
  remoteMode: z.boolean().default(false),
  readOnly: z.boolean().default(false),
  strictRoot: z.boolean().default(false),
  roots: z.dict(z.string()).default({}),
  openOnCommand: z.boolean().default(true),
  debug: z.boolean().default(false),
})

/** Reject an invalid route prefix before any registration happens. */
function normalizeBasePath(basePath: string): string {
  if (!basePath.startsWith('/') || basePath.endsWith('/') || basePath.length < 2) {
    throw new TypeError('dsh-agfs: basePath must start with "/" and have no trailing slash')
  }
  return basePath
}

/**
 * The absolute URL of the file browser for the current webserver port; with a
 * target, the URL carries `?path=` so the frontend boots at that directory.
 */
function appUrl(ctx: Context, basePath: string, target?: string): string {
  const base = `http://127.0.0.1:${ctx.webServer.port}${basePath}/`
  return target === undefined ? base : `${base}?path=${encodeURIComponent(target)}`
}

/**
 * The current session's workspace directory — the same absolute cwd the
 * workspace registry groups sessions by — or undefined when the session
 * carries no cwd or the directory is missing.
 */
function workspaceTarget(invocation: CommandInvocation): string | undefined {
  const cwd = invocation.agent.session.header.cwd
  if (cwd === undefined || cwd === '') return undefined
  try {
    if (existsSync(cwd) && statSync(cwd).isDirectory()) return cwd
  } catch { /* an unreadable cwd falls back to the browser root */ }
  return undefined
}

/** One started analysis: the minted session and the workspace directory it lives in. */
export interface AnalysisResult {
  readonly sessionId: string
  readonly workspacePath: string
}

/**
 * Start one AI analysis: create (or reuse) the workspace for `targetPath`,
 * mint a fresh session with its cwd pinned to that directory, and wake its
 * agent with the user's requirement as an ordinary follow-up turn. The
 * workspace/agent services are optional (ctx.get) so the rest of the plugin
 * keeps working in compositions that do not mount them; absence fails the
 * endpoint with a clear error instead.
 * @param ctx - context carrying the optional workspace and agent registries.
 * @param targetPath - the directory the analysis runs in (a file resolves to its parent).
 * @param requirement - the user's analysis request, sent verbatim as one user message.
 * @returns the minted session id and the workspace directory.
 */
export async function runAnalysis(
  ctx: Context,
  targetPath: string,
  requirement: string,
): Promise<AnalysisResult> {
  const workspaceRegistry = ctx.get('workspaceRegistry')
  if (workspaceRegistry === undefined) throw new Error('工作区服务不可用')
  const workspace = await workspaceRegistry.create(targetPath)
  const agents = ctx.get('agents')
  if (agents === undefined) throw new Error('智能体服务不可用')
  const sessionId = SessionId(`analysis-${randomUUID()}`)
  const handle = await agents.create({ sessionId, meta: { cwd: targetPath } })
  // Group the session under the workspace: membership requires an explicit
  // attach (the GUI's normal session flow attaches on creation).
  await workspace.attachSession(sessionId)
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: requirement }],
    source: { kind: 'user' },
  }))
  return { sessionId: String(sessionId), workspacePath: targetPath }
}

/**
 * Register the `/dsh-agfs` command and the `basePath` prefix route.
 * @param ctx - context carrying the command registry and the webserver.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const basePath = normalizeBasePath(config.basePath)
  const resolved: AgfsConfig = {
    basePath,
    fileRoot: config.fileRoot,
    projectRoot: config.projectRoot,
    remoteMode: config.remoteMode,
    readOnly: config.readOnly,
    strictRoot: config.strictRoot,
    roots: config.roots,
    openOnCommand: config.openOnCommand,
    debug: config.debug,
  }

  const commandHandler = async (invocation: CommandInvocation): Promise<CommandResult> => {
    const url = appUrl(ctx, basePath, workspaceTarget(invocation))
    if (invocation.rawInput.trim() !== '') {
      return { kind: 'error', text: `Usage: /dsh-agfs (no arguments); the file browser is at ${url}` }
    }
    if (!config.openOnCommand) return { kind: 'success', text: `文件浏览器: ${url}` }
    try {
      await openInBrowser(url)
      return { kind: 'success', text: `文件浏览器已打开: ${url}` }
    } catch (error: unknown) {
      return {
        kind: 'error',
        text: `无法打开浏览器,请手动访问: ${url} (${error instanceof Error ? error.message : String(error)})`,
      }
    }
  }

  /* ---- 一键AI分析:建工作区 + 新会话 + 唤醒智能体(仅本机模式) ---- */
  const handleAnalyze = async (
    req: IncomingMessage,
    res: ServerResponse,
    body: Body,
  ): Promise<void> => {
    if (req.method !== 'POST') {
      writeOutcome(res, { kind: 'error', status: 405, error: '方法不允许' })
      return
    }
    if (resolved.remoteMode) {
      writeOutcome(res, { kind: 'error', status: 403, error: '远程模式下不支持AI分析' })
      return
    }
    const rawPath = typeof body.path === 'string' ? body.path : ''
    const requirement = typeof body.requirement === 'string' ? body.requirement.trim() : ''
    if (rawPath === '') {
      writeOutcome(res, { kind: 'error', status: 400, error: '缺少path参数' })
      return
    }
    if (requirement === '') {
      writeOutcome(res, { kind: 'error', status: 400, error: '缺少需求描述' })
      return
    }
    // Resolve the browsed item; a file analyzes in its parent directory.
    const root = resolved.fileRoot.trim() !== '' ? resolved.fileRoot : process.cwd()
    let target: string
    try {
      target = getSafePath(root, rawPath, resolved.strictRoot)
    } catch (error: unknown) {
      writeOutcome(res, { kind: 'error', status: 400, error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (!existsSync(target)) {
      writeOutcome(res, { kind: 'error', status: 404, error: '路径不存在' })
      return
    }
    if (!statSync(target).isDirectory()) target = dirname(target)
    try {
      const result = await runAnalysis(ctx, target, requirement)
      if (resolved.debug) console.error(`[dsh-agfs:debug] POST analyze path=${target} session=${result.sessionId}`)
      writeOutcome(res, {
        kind: 'json',
        status: 200,
        data: { sessionId: result.sessionId, workspacePath: result.workspacePath },
        message: '分析已启动',
      })
    } catch (error: unknown) {
      if (resolved.debug) console.error(`[dsh-agfs:debug] POST analyze failed: ${error instanceof Error ? error.message : String(error)}`)
      writeOutcome(res, { kind: 'error', status: 500, error: `分析启动失败: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  const routeHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let pathname: string
    let query: Query
    try {
      /* v8 ignore next -- node:http always sets url on server requests */
      const u = new URL(req.url ?? '/', 'http://x')
      pathname = decodeURIComponent(u.pathname)
      query = Object.fromEntries(u.searchParams.entries())
    } catch {
      writeOutcome(res, { kind: 'error', status: 400, error: '无效的请求地址' })
      return
    }
    const apiPrefix = `${basePath}/api/file_browser/`
    if (pathname.startsWith(apiPrefix)) {
      const endpoint = pathname.slice(apiPrefix.length)
      let body: Body = {}
      if (req.method === 'POST') {
        try {
          body = await readJsonBody(req)
        } catch (error: unknown) {
          /* v8 ignore next -- readJsonBody rejects with Error instances only */
          writeOutcome(res, { kind: 'error', status: 400, error: error instanceof Error ? error.message : String(error) })
          return
        }
        if (body.filepath === undefined && query.filepath !== undefined) {
          body = { ...body, filepath: query.filepath }
        }
      }
      /* v8 ignore next -- server sockets always carry a remote address */
      const socketAddress = req.socket.remoteAddress ?? ''
      /* v8 ignore next -- node:http always sets method on server requests */
      const method = req.method ?? 'GET'
      if (endpoint === 'analyze') {
        await handleAnalyze(req, res, body)
        return
      }
      const outcome = await dispatchApi(method, endpoint, query, body, resolved, getClientIp(req.headers, socketAddress), socketAddress)
      if (resolved.debug) {
        console.error(`[dsh-agfs:debug] ${method} ${endpoint} status=${outcome.kind === 'stream' ? 200 : outcome.status}`)
      }
      writeOutcome(res, outcome)
      return
    }
    // Static assets answer GET/HEAD only; the API prefix owns its own methods.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeOutcome(res, { kind: 'error', status: 405, error: '方法不允许' })
      return
    }
    const asset = await resolveAsset(pathname, basePath)
    if (asset === undefined) {
      writeOutcome(res, { kind: 'error', status: 404, error: '文件不存在' })
      return
    }
    if (asset.kind === 'index') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      })
      res.end(asset.html)
      return
    }
    res.writeHead(200, {
      'Content-Type': asset.mime,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    })
    createReadStream(asset.file).pipe(res)
  }

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'dsh-agfs',
      description: 'Open the file browser in the system browser',
      handler: commandHandler,
    })
    yield ctx.webServer.register({ kind: 'prefix', path: basePath, handler: routeHandler })
    yield registerFileBrowseTool(ctx, resolved)
  }, 'dsh-agfs lifecycle')
}
