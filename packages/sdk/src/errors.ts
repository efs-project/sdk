/**
 * Typed error tree (ADR-0007, pending). External callers catch discriminated
 * `EfsError` subclasses or switch on `.code`, never raw RPC strings. Modeled on
 * viem's `BaseError`: a `shortMessage`, an open-union `code`, a `cause`
 * passthrough, and `walk()` for cause-chain traversal.
 */

import { BaseError, ContractFunctionRevertedError } from 'viem'
import { easAbi } from './eas/abi.js'

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
  // --- classifier codes (ADR-0007 §Realization) ---------------------------
  /** Wallet rejected by the user (EIP-1193 `4001`). Benign, not a failure. */
  | 'UserRejected'
  /** Caller lacks authorization for the request (EIP-1193 `4100`). */
  | 'Unauthorized'
  /** The provider does not support the requested method (EIP-1193 `4200`). */
  | 'UnsupportedMethod'
  /** Provider/chain disconnected (EIP-1193 `4900`/`4901`). */
  | 'Disconnected'
  /** A contract call reverted (decoded against the EAS ABI where possible). */
  | 'ContractReverted'
  /** A JSON-RPC transport/server error (EIP-1474 `-32xxx`). */
  | 'RpcError'
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

/** The wallet rejected the request because the user declined it (EIP-1193 `4001`).
 * Benign — a user choice, not a fault. Surfaced as a distinct code so callers can
 * quietly no-op instead of treating it like a failure. */
export class UserRejected extends EfsError {
  override name = 'UserRejected'
  constructor(cause?: unknown) {
    super('The wallet request was rejected in the wallet.', { code: 'UserRejected', cause })
  }
}

/** The caller is not authorized for the requested method/account (EIP-1193 `4100`). */
export class Unauthorized extends EfsError {
  override name = 'Unauthorized'
  constructor(cause?: unknown) {
    super('The wallet has not authorized this account or method — connect/grant access first.', {
      code: 'Unauthorized',
      cause,
    })
  }
}

/** The provider does not support the requested method (EIP-1193 `4200`). */
export class UnsupportedMethod extends EfsError {
  override name = 'UnsupportedMethod'
  constructor(cause?: unknown) {
    super('The wallet provider does not support this method.', {
      code: 'UnsupportedMethod',
      cause,
    })
  }
}

/** The provider or the chain is disconnected (EIP-1193 `4900`/`4901`). */
export class Disconnected extends EfsError {
  override name = 'Disconnected'
  constructor(cause?: unknown) {
    super('The wallet provider is disconnected from the chain — reconnect and retry.', {
      code: 'Disconnected',
      cause,
    })
  }
}

/** A contract call reverted. The decoded revert (custom error name / `Error(string)`
 * reason) is in the `shortMessage`; the underlying viem error is the `cause`. */
export class ContractReverted extends EfsError {
  override name = 'ContractReverted'
  constructor(shortMessage: string, cause?: unknown) {
    super(shortMessage, { code: 'ContractReverted', cause })
  }
}

/** A JSON-RPC transport/server error (EIP-1474 `-32xxx`). */
export class RpcError extends EfsError {
  override name = 'RpcError'
  constructor(shortMessage: string, cause?: unknown) {
    super(shortMessage, { code: 'RpcError', cause })
  }
}

/** Pull a numeric EIP-1193/1474 error code off an arbitrary error-ish value.
 * viem's `ProviderRpcError`/`RpcError` carry `.code`; raw EIP-1193 errors do too. */
function numericCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return typeof code === 'number' ? code : undefined
}

/**
 * Map a viem `ContractFunctionRevertedError` to a meaningful EfsError. viem has
 * already decoded the revert against the ABI passed at call time (and the SDK
 * always passes `easAbi`), exposing `.data` (custom error name + args) or
 * `.reason` (an `Error(string)` revert). We key off the decoded error name.
 */
function fromRevert(revert: ContractFunctionRevertedError, original: unknown): EfsError {
  const errorName = revert.data?.errorName
  const reason = revert.reason

  // EAS surfaces schema problems as `InvalidSchema`; map that to the existing
  // SchemaMismatch code so the typed-tree contract (ADR-0007) holds end to end.
  if (errorName === 'InvalidSchema' || /invalid schema/i.test(reason ?? '')) {
    return new SchemaMismatchError(
      'The on-chain EAS schema does not match what the SDK expected (revert: InvalidSchema).',
      original,
    )
  }

  const headline = errorName
    ? `Contract reverted with ${errorName}.`
    : reason
      ? `Contract reverted: ${reason}`
      : (revert.shortMessage ?? 'Contract reverted.')
  return new ContractReverted(headline, original)
}

/**
 * Classify an arbitrary thrown value into a typed {@link EfsError} (ADR-0007).
 *
 * The single funnel external surfaces run unknown failures through so callers
 * get a stable, switchable `.code` instead of raw RPC strings. It is a pure
 * classifier — it never throws, always returns an `EfsError`, and preserves the
 * original error as `.cause`.
 *
 * - An existing `EfsError` is returned unchanged (idempotent).
 * - A viem `BaseError` is walked to its underlying `ContractFunctionRevertedError`
 *   (decoded against `easAbi`) and mapped to a meaningful EfsError.
 * - EIP-1193 codes — `4001` user-rejected (benign), `4100` unauthorized, `4200`
 *   unsupported method, `4900`/`4901` disconnected — map to dedicated subclasses.
 * - EIP-1474 JSON-RPC `-32xxx` codes map to {@link RpcError}.
 * - Anything else is wrapped in a generic {@link EfsError}.
 */
export function classifyError(err: unknown): EfsError {
  // Idempotent: an already-classified error passes straight through.
  if (err instanceof EfsError) return err

  // viem error tree: walk to a contract revert and decode it (against easAbi,
  // which viem applied at call time). `easAbi` is referenced so this module is
  // the documented home of EAS-revert decoding per ADR-0007.
  void easAbi
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError) {
      return fromRevert(revert, err)
    }
  }

  // EIP-1193 / EIP-1474 numeric codes. viem's ProviderRpcError/RpcError expose
  // `.code`; raw provider errors carry the same field, so this catches both.
  const code = numericCode(err)
  if (code !== undefined) {
    switch (code) {
      case 4001:
        return new UserRejected(err)
      case 4100:
        return new Unauthorized(err)
      case 4200:
        return new UnsupportedMethod(err)
      case 4900:
      case 4901:
        return new Disconnected(err)
      default:
        // EIP-1474 reserves -32768..-32000 (and the -327xx block) for RPC errors.
        if (code <= -32000 && code >= -32768) {
          const short =
            (err as { shortMessage?: unknown }).shortMessage ??
            (err as { message?: unknown }).message
          return new RpcError(
            typeof short === 'string' && short.length > 0
              ? short
              : `JSON-RPC error (code ${code}).`,
            err,
          )
        }
    }
  }

  // Unrecognized: wrap, never throw.
  const message =
    err instanceof Error && err.message
      ? err.message
      : typeof err === 'string' && err.length > 0
        ? err
        : 'An unexpected error occurred.'
  return new EfsError(message, { cause: err })
}
