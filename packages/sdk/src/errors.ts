/**
 * Typed error tree (ADR-0007, pending). External callers catch discriminated
 * `EfsError` subclasses or switch on `.code`, never raw RPC strings. Modeled on
 * viem's `BaseError`: a `shortMessage`, an open-union `code`, a `cause`
 * passthrough, and `walk()` for cause-chain traversal.
 */

import { BaseError, ContractFunctionRevertedError } from 'viem'
import type { Hex } from 'viem'
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
  /** A path's parent folder does not exist on-chain (write requires it to). */
  | 'ParentNotFound'
  /** No file is placed at a path under the read's lens (a byte read needs one). */
  | 'FileNotFound'
  /** No LIST attestation exists at the given UID (or it is the wrong schema). A
   * `lists.get` returns `exists:false`; the lens-scoped entry reads throw this. */
  | 'ListNotFound'
  /** A typed list-entry accessor was called for the wrong `targetType` (e.g.
   * `targetAsAddress` on a SCHEMA-typed list). Mirrors the ListReader revert. */
  | 'WrongListTargetType'
  /** A LIST create/add config violates a ListResolver/ListEntryResolver invariant —
   * caught client-side BEFORE submit so the caller gets a typed error, not a chain
   * revert (targetType bound, SCHEMA-mode targetSchema rule, appendOnly+duplicates cap,
   * ADDR/UID target shape). */
  | 'InvalidListConfig'
  /** A `lists.remove` was attempted on an append-only list (entries can never be
   * revoked). Rejected up front — no chain round-trip. */
  | 'ListAppendOnly'
  /** The winning attestation is revoked — distinct from absent (sdk-read-surface
   * error matrix). A byte read throws this; metadata surfaces `verified:'revoked'`. */
  | 'Revoked'
  /** Fetched bytes do not match the attester's claimed `contentHash`. Thrown by the
   * fail-closed value sugar (`readText`/`readBytes`/`readJson`); the `EfsFile` path
   * surfaces it as `verification:'mismatch'`. */
  | 'ContentHashMismatch'
  /** The attester's `contentHash` claim is not a well-formed hash (an authoring bug,
   * not tampering). Thrown by the value sugar; `EfsFile` surfaces `'malformed-claim'`. */
  | 'MalformedClaim'
  /** A write is missing a required input the deployment/opts should supply
   * (e.g. a transport-definition anchor UID for a mirror scheme). */
  | 'MissingTransport'
  /** A caller argument violated a documented bound (e.g. directory-query caps). */
  | 'InvalidArgument'
  /** A REDIRECT alias chain forms a cycle under the resolving lens (ADR-0050). The
   * SDK fails closed rather than guessing a canonical node (the normative
   * lowest-UID-in-SCC rule is not yet pinned). */
  | 'RedirectCycle'
  /** A REDIRECT alias chain exceeded the max-hop cap before terminating (ADR-0050
   * `D_MAX`/`MAX_ANCHOR_DEPTH`). Fail-closed — a partial stop is attacker-influenceable. */
  | 'RedirectHopLimit'
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

/** A surface that is shaped but not yet implemented (scaffold/seam). Optionally
 * carries an `alternative` (what to do instead today) and/or a `tracking` reference
 * (ADR/issue) so the message is a pointer, not a dead end. */
export class NotImplemented extends EfsError {
  override name = 'NotImplemented'
  /** A usable workaround for the missing surface, when one exists. */
  readonly alternative?: string
  /** Where the work is tracked (e.g. an ADR or issue id). */
  readonly tracking?: string
  constructor(what: string, opts: { alternative?: string; tracking?: string } = {}) {
    const parts = [`${what} is not implemented yet.`]
    if (opts.alternative) parts.push(opts.alternative)
    if (opts.tracking) parts.push(`(tracked: ${opts.tracking})`)
    super(parts.join(' '), { code: 'NotImplemented' })
    if (opts.alternative !== undefined) this.alternative = opts.alternative
    if (opts.tracking !== undefined) this.tracking = opts.tracking
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

/** No file is placed at a path under the read's lens. A byte read (`fs.cat`)
 * needs an active placement; resolve/stat instead model absence as `null` /
 * `{exists:false}`. Carries the path so a caller can surface a precise message. */
export class FileNotFoundError extends EfsError {
  override name = 'FileNotFoundError'
  readonly path: string
  constructor(path: string) {
    super(`EFS read: no file is placed at '${path}' under the resolving lens.`, {
      code: 'FileNotFound',
    })
    this.path = path
  }
}

/** No LIST attestation exists at `listUID` (or the UID points at a non-LIST
 * attestation — `ListReader.getMode` schema-checks before decode). The cheap
 * `lists.get` probe surfaces this as `exists:false`; the lens-scoped entry reads
 * (`entries`/`length`/`has`) throw it, since reading entries of a non-existent list
 * is a caller error, not a normal empty. */
export class ListNotFound extends EfsError {
  override name = 'ListNotFound'
  readonly listUID: Hex
  constructor(listUID: Hex) {
    super(
      `EFS lists: no LIST attestation exists at '${listUID}' (absent or wrong schema). Check the UID, or call efs.lists.get(uid) which reports { exists: false } instead of throwing.`,
      { code: 'ListNotFound' },
    )
    this.listUID = listUID
  }
}

/** A typed list-target accessor was requested for a list whose `targetType` does not
 * match — e.g. asking for `addr` targets on a `schema`-typed list. The ListReader
 * typed accessors revert in this case; the SDK refuses up front with the list's
 * actual target type so the caller can pick the right read. */
export class WrongListTargetType extends EfsError {
  override name = 'WrongListTargetType'
  readonly listUID: Hex
  readonly actual: string
  readonly requested: string
  constructor(listUID: Hex, actual: string, requested: string) {
    super(
      `EFS lists: list '${listUID}' has targetType '${actual}', not '${requested}'. Read its entries with the matching target kind.`,
      { code: 'WrongListTargetType' },
    )
    this.listUID = listUID
    this.actual = actual
    this.requested = requested
  }
}

/**
 * A LIST create/add config violates a frozen-resolver invariant, caught client-side
 * BEFORE submit (the resolver would `revert` the whole tx; the SDK refuses up front
 * with an actionable message instead). Covers: `targetType` out of range (>2);
 * SCHEMA-mode requires a nonzero `targetSchema` and non-SCHEMA requires zero;
 * `appendOnly && allowsDuplicates ⇒ maxEntries != 0`; and an `add` target whose shape
 * is wrong for the list's mode (ADDR needs an address, ANY/SCHEMA need a nonzero UID).
 */
export class InvalidListConfig extends EfsError {
  override name = 'InvalidListConfig'
  constructor(message: string) {
    super(`EFS lists: ${message}`, { code: 'InvalidListConfig' })
  }
}

/** A `lists.remove` was attempted on an append-only list — its entries can never be
 * revoked (ListEntryResolver rejects the revocation). Rejected up front with no chain
 * round-trip; the list's {@link ListConfig.appendOnly} flag is the authoritative gate. */
export class ListAppendOnly extends EfsError {
  override name = 'ListAppendOnly'
  readonly listUID: Hex
  constructor(listUID: Hex) {
    super(
      `EFS lists: list '${listUID}' is append-only — its entries can never be removed (revoked).`,
      { code: 'ListAppendOnly' },
    )
    this.listUID = listUID
  }
}

/** The winning attestation backing a read is revoked. Distinct from absent
 * ({@link FileNotFoundError}): the placement existed and resolved, but the trusted
 * attester revoked the record, so the bytes are no longer vouched-for. A byte read
 * (`read`/`readText`/…) throws this; `locate`/`info` surface `verified:'revoked'`. */
export class Revoked extends EfsError {
  override name = 'Revoked'
  readonly path?: string
  constructor(path?: string) {
    super(
      path !== undefined
        ? `EFS read: the attestation backing '${path}' under the resolving lens is revoked.`
        : 'EFS read: the attestation backing this reference is revoked.',
      { code: 'Revoked' },
    )
    if (path !== undefined) this.path = path
  }
}

/** Fetched bytes did not match the attester's claimed `contentHash`. Thrown by the
 * fail-closed value sugar (`readText`/`readBytes`/`readJson`) — the bare-value path
 * has nowhere to surface a status, so a mismatch MUST throw to stay trust-safe. The
 * {@link EfsFile} path reports `verification:'mismatch'` instead. */
export class ContentHashMismatch extends EfsError {
  override name = 'ContentHashMismatch'
  readonly path?: string
  constructor(path?: string) {
    super(
      path !== undefined
        ? `EFS read: bytes at '${path}' do not match the attester's claimed contentHash. Pass { verify: false } to read them unverified.`
        : "EFS read: bytes do not match the attester's claimed contentHash. Pass { verify: false } to read them unverified.",
      { code: 'ContentHashMismatch' },
    )
    if (path !== undefined) this.path = path
  }
}

/** The attester's `contentHash` claim is not a well-formed hash — an authoring bug,
 * not content tampering. Thrown by the fail-closed value sugar; the {@link EfsFile}
 * path reports `verification:'malformed-claim'`. */
export class MalformedClaim extends EfsError {
  override name = 'MalformedClaim'
  readonly path?: string
  constructor(path?: string) {
    super(
      path !== undefined
        ? `EFS read: the contentHash claim for '${path}' is malformed (not a bare SHA-256). The bytes cannot be verified.`
        : 'EFS read: the contentHash claim is malformed (not a bare SHA-256). The bytes cannot be verified.',
      { code: 'MalformedClaim' },
    )
    if (path !== undefined) this.path = path
  }
}

/**
 * A REDIRECT alias chain forms a cycle under the resolving lens (e.g. A→B asserted
 * by one attester, B→A by another — ADR-0050 §"Write-time guards vs read-time
 * resolution"). The on-chain resolver only blocks a *direct* self-loop (`target ==
 * source`); multi-hop cycles are a read-time concern. The SDK fails CLOSED on a
 * detected cycle: ADR-0050's normative cycle rule (resolve to the lowest UID in the
 * strongly-connected component) is a Durable spec that is not yet pinned, so the SDK
 * does not guess a canonical node — it throws and carries the visited chain. Carries
 * the UID where the cycle was detected (`at`) and the ordered chain that led there.
 */
export class RedirectCycle extends EfsError {
  override name = 'RedirectCycle'
  /** The UID re-encountered, closing the cycle. */
  readonly at: Hex
  /** The ordered chain of source UIDs visited before the cycle closed. */
  readonly chain: readonly Hex[]
  constructor(at: Hex, chain: readonly Hex[]) {
    super(
      `EFS redirects: the alias chain cycles back to '${at}' under the resolving lens. The SDK does not auto-resolve a cycle (ADR-0050's lowest-UID-in-SCC rule is not yet pinned) — break the cycle or read with { followRedirects: false }.`,
      { code: 'RedirectCycle' },
    )
    this.at = at
    this.chain = chain
  }
}

/**
 * A REDIRECT alias chain exceeded the max-hop cap before terminating (ADR-0050
 * `D_MAX` ≈ 8, hard ceiling `MAX_ANCHOR_DEPTH` = 32). Fail-closed: stopping at a
 * partial chain would resolve to an entry-dependent, attacker-influenceable node.
 * Carries the cap and the chain followed up to it.
 */
export class RedirectHopLimit extends EfsError {
  override name = 'RedirectHopLimit'
  /** The max-hop cap that was hit. */
  readonly cap: number
  /** The ordered chain of source UIDs followed up to the cap. */
  readonly chain: readonly Hex[]
  constructor(cap: number, chain: readonly Hex[]) {
    super(
      `EFS redirects: the alias chain did not terminate within ${cap} hops under the resolving lens. Raise the cap with { followRedirects: <n> } (≤ 32) or fix the chain.`,
      { code: 'RedirectHopLimit' },
    )
    this.cap = cap
    this.chain = chain
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

/** Pull a numeric EIP-1193/1474 error code off an error or ANY error in its
 * `cause` chain. viem wraps provider errors (e.g. a `UserRejectedRequestError`
 * carrying `4001`) under contract/transaction errors, so the code is often on a
 * nested cause, not the outer error — walk the chain or wrapped failures fall
 * through to a generic `EfsError`. Cycle-guarded. */
function numericCode(err: unknown): number | undefined {
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur != null && !seen.has(cur)) {
    seen.add(cur)
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'number') return code
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
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
