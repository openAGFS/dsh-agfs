/**
 * Package-owned invariant companion for `@yfjz/dsh-agfs`.
 * @module @yfjz/dsh-agfs/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@yfjz/dsh-agfs'

/** Cordis companion plugin name. */
export const name = 'dsh-agfs-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the plugin owns two registrations, and each owner
 * enforces its own lifecycle — the webserver rejects duplicate (kind, path)
 * routes and unregisters on the disposer, and the command registry rejects
 * duplicate names and logs the full `command/run`/`command/done` pair. The
 * register/release symmetry of both contributions is covered by the package's
 * real-composition HMR-safety test instead.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
