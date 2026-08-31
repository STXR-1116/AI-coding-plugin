/**
 * Package-owned invariant companion for the AI Coding platform demo.
 * @module @deepseek-ai/dsh-client-ui-ai-coding-platform/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-ai-coding-platform'

/** Cordis companion plugin name. */
export const name = 'client-ui-ai-coding-platform-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * The demo owns only local browser presentation state. Its behavior is
 * asserted by component tests rather than by a cross-plugin runtime event.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
