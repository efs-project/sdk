/**
 * Typed error tree (ADR-0007, pending). External callers catch discriminated
 * `EfsError` subclasses or switch on `.code`, never raw RPC strings. Modeled on
 * viem's `BaseError`: a `shortMessage`, an open-union `code`, a `cause`
 * passthrough, and `walk()` for cause-chain traversal.
 */

/** Open string-union of error codes — open (`string & {}`) so adding a code is
 * never a breaking change for an exhaustive `switch`. */
export type EfsErrorCode =
  | 'EfsError'
  | 'NotImplemented'
  | 'WalletRequired'
  | 'LensRequired'
  | 'MaxLensesExceeded'
  | 'SchemaMismatch'
  | 'DeploymentNotFound'
  | 'CursorInvalid'
  | 'PartialBatchFailure'
  | (string & Record<never, never>)

export type EfsErrorOptions = { code?: EfsErrorCode; cause?: unknown; details?: string }

function walkChain(err: unknown, fn?: (e: unknown) => boolean): unknown {
  if (fn?.(err)) return err
  const cause = (err as { cause?: unknown } | null | undefined)?.cause
  if (cause != null) return walkChain(cause, fn)
  return fn ? null : err
}

export class EfsError extends Error {
  override name = 'EfsError'
  /** A stable, switchable discriminant. */
  readonly code: EfsErrorCode
  /** The headline message, without any appended details. */
  readonly shortMessage: string

  constructor(shortMessage: string, opts: EfsErrorOptions = {}) {
    super(opts.details ? `${shortMessage}\n\n${opts.details}` : shortMessage, {
      cause: opts.cause,
    })
    this.shortMessage = shortMessage
    this.code = opts.code ?? 'EfsError'
  }

  /** Walk the `cause` chain. With `fn`, returns the first match (or `null`);
   * without, returns the deepest error in the chain. */
  walk(fn?: (err: unknown) => boolean): unknown {
    return walkChain(this, fn)
  }
}

/** A surface that is shaped but not yet implemented (scaffold/seam). */
export class NotImplemented extends EfsError {
  override name = 'NotImplemented'
  constructor(what: string) {
    super(`${what} is not implemented yet.`, { code: 'NotImplemented' })
  }
}

/** A write was attempted on a client created without a `walletClient`.
 * (Prefer the type-level gate — this is the runtime backstop.) */
export class WalletRequired extends EfsError {
  override name = 'WalletRequired'
  constructor() {
    super('This operation writes and needs a wallet — create the client with a `walletClient`.', {
      code: 'WalletRequired',
    })
  }
}

/** A read needs a lens but none was given and no wallet is connected. */
export class LensRequired extends EfsError {
  override name = 'LensRequired'
  constructor() {
    super('No lens given and no wallet connected — a read needs an attester to resolve against.', {
      code: 'LensRequired',
    })
  }
}

/** A lens stack exceeds MAX_LENSES. We throw rather than truncate: silent
 * truncation is a trust downgrade (it can push the trusted tail off the end). */
export class MaxLensesExceeded extends EfsError {
  override name = 'MaxLensesExceeded'
  constructor(count: number, max: number) {
    super(
      `Lens stack has ${count} entries; the maximum is ${max}. Reduce it explicitly — the SDK will not truncate (that would silently change which attester wins).`,
      { code: 'MaxLensesExceeded' },
    )
  }
}

/** The SDK's compiled schema UIDs don't match what's deployed on the target chain.
 * Construct with a message describing the diff. */
export class SchemaMismatchError extends EfsError {
  override name = 'SchemaMismatchError'
  constructor(message: string, cause?: unknown) {
    super(message, { code: 'SchemaMismatch', cause })
  }
}

/** No EFS deployment is known for the connected chain (and none was supplied). */
export class DeploymentNotFound extends EfsError {
  override name = 'DeploymentNotFound'
  constructor(chainId: number) {
    super(
      `No EFS deployment registered for chainId ${chainId}. Pass \`deployments\` to point at a custom/local deployment.`,
      { code: 'DeploymentNotFound' },
    )
  }
}

/** A pagination cursor was invalid, stale, or from a different query. */
export class CursorInvalid extends EfsError {
  override name = 'CursorInvalid'
  constructor() {
    super('The pagination cursor is invalid or stale — restart the listing from the beginning.', {
      code: 'CursorInvalid',
    })
  }
}

/** A multi-operation write partially failed; some operations landed, some did not. */
export class PartialBatchFailure extends EfsError {
  override name = 'PartialBatchFailure'
  constructor(message: string, cause?: unknown) {
    super(message, { code: 'PartialBatchFailure', cause })
  }
}
