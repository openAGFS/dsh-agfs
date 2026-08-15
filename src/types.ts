/**
 * Shared type declarations for `@open-agfs/dsh-agfs`. Types only — no runtime
 * code, per the package conventions.
 * @module @open-agfs/dsh-agfs/types
 */

/** Plugin configuration after schemastery validation. */
export interface AgfsConfig {
  /** Webserver route prefix serving the app and its API; starts with a slash, no trailing slash. */
  readonly basePath: string
  /** File-browser root; empty resolves to the current working directory. */
  readonly fileRoot: string
  /** Project root shown in the sidebar; empty resolves to the working directory. */
  readonly projectRoot: string
  /** Remote mode: disables open-in-system, open-location, and copy endpoints. */
  readonly remoteMode: boolean
  /** Read-only mode: disables delete, create, rename, and copy endpoints. */
  readonly readOnly: boolean
  /** Strict-root mode: locks browsing inside fileRoot and rejects absolute and symlink escapes. */
  readonly strictRoot: boolean
  /** Named browse roots shown in the sidebar (name -> path); entries that do not resolve to a directory are dropped. */
  readonly roots: Readonly<Record<string, string>>
  /** Whether `/dsh-agfs` opens the file browser in the system default browser. */
  readonly openOnCommand: boolean
  /** Debug logging: when true, API calls and system-open results are logged to stderr with a `[dsh-agfs:debug]` prefix. */
  readonly debug: boolean
}

/** One validated query-string key/value pair set. */
export type Query = Readonly<Record<string, string>>

/** One parsed JSON request body. */
export type Body = Readonly<Record<string, unknown>>

/** JSON success outcome mirroring the original `{success:true,...}` contract. */
export interface JsonOutcome {
  readonly kind: 'json'
  readonly status: number
  readonly data?: unknown
  readonly message?: string
  readonly extra?: Readonly<Record<string, unknown>>
}

/** JSON error outcome mirroring the original `{success:false,error}` contract. */
export interface ErrorOutcome {
  readonly kind: 'error'
  readonly status: number
  readonly error: string
}

/** Streaming file outcome (download and thumbnail) materialized by the HTTP layer. */
export interface StreamOutcome {
  readonly kind: 'stream'
  readonly file: string
  readonly mime: string
  readonly disposition?: string
  readonly cache?: string
}

/** Discriminated result of one API dispatch. */
export type ApiOutcome = JsonOutcome | ErrorOutcome | StreamOutcome

/** Static asset resolved for one request pathname, or `undefined` for a miss. */
export type AssetResponse =
  | { readonly kind: 'index'; readonly html: string }
  | { readonly kind: 'file'; readonly file: string; readonly mime: string }
  | undefined
