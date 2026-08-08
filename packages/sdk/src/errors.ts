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
  /** A path segment / property key is not a valid anchor name (specs/02 canonical
   * encoding): empty, `.`/`..`, or — for a claimed-canonical string — a bare
   * reserved byte, malformed/lowercase/over-escape. Thrown by the segment codec. */
  | 'InvalidAnchorName'
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
  /** Fetched bytes do not match the attester's claimed `contentHash`. Thrown by the
   * fail-closed value sugar (`readText`/`readBytes`/`readJson`); the `EfsFile` path
   * surfaces it as `verification:'mismatch'`. */
  | 'ContentHashMismatch'
  /** The attester's `contentHash` claim is not a well-formed hash (an authoring bug,
   * not tampering). Thrown by the value sugar; `EfsFile` surfaces `'malformed-claim'`. */
  | 'MalformedClaim'
  /** The read's trust freshness is below the caller's `requireTrust` floor
   * (ADR-0015) — e.g. a content-only cached answer on the fail-closed sugar.
   * The rich results surface the same state on `.trust` without throwing. */
  | 'StaleTrust'
  /** A persisted artifact belongs to a FOREIGN profile or a NEWER envelope
   * version (ADR-0019) — never best-effort-parsed (a v2 logical ID read as a
   * v1 EAS UID would silently mis-dereference). */
  | 'UnsupportedArtifact'
  /** A persisted-artifact parse failed structurally (not JSON / no envelope /
   * missing required payload fields) — it was never a valid artifact. */
  | 'MalformedArtifact'
  /** A write is missing a required input the deployment/opts should supply
   * (e.g. a transport-definition anchor UID for a mirror scheme). */
  | 'MissingTransport'
  /** A caller argument violated a documented bound (e.g. directory-query caps). */
  | 'InvalidArgument'
  /** A read ref / write client targets a chain other than the resolved EFS deployment's
   * (cross-chain read of a `DataRef`, or a wallet/public-client chain mismatch on write).
   * Fail-closed: same-named contracts on another chain would silently read/write wrong. */
  | 'WrongChain'
  // NOTE: the pre-ratification 'RedirectCycle'/'RedirectHopLimit' codes are GONE —
  // specs/09 (Accepted) mandates surfaced-node result STATUSES (Resolved/Dangling/
  // CycleStopped/DepthExceeded), never throws; see reads/redirects.ts.
  /** A redirect selection scan hit the SDK's physical-slot bound (`MAX_REDIRECT_SCAN`)
   * before exhausting an attester's (source, attester) window — the attester's stance
   * is UNKNOWABLE within bounds, so selection fails closed rather than silently
   * falling through to a lower-priority attester (revoked-spam would otherwise let
   * an attacker suppress a trusted attester's redirect). NOT a spec walk status —
   * an SDK resource bound, like MaxLensesExceeded. */
  | 'RedirectScanTruncated'
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

/** A redirect selection scan hit `MAX_REDIRECT_SCAN` physical slots before
 * exhausting an attester's (source, attester) window (specs/09 selection over
 * the EFSIndexer referencing index). We throw rather than fall through: an
 * active record beyond the bound could hold both the first-attester win and
 * the lowest-UID tie-break, so a truncated verdict is unreliable in BOTH
 * directions — and silent absence would let revoked-spam suppress a trusted
 * attester's redirect (the same trust-downgrade class as lens truncation). */
export class RedirectScanTruncated extends EfsError {
  override name = 'RedirectScanTruncated'
  /** The redirect source node whose scan truncated. */
  readonly source: string
  /** The lens attester whose (source, attester) window exceeded the bound. */
  readonly attester: string
  constructor(source: string, attester: string, max: number) {
    super(
      `EFS redirects: attester ${attester} has more than ${max} physical redirect slots on ${source} — the scan bound was hit before the window was exhausted, so this attester's stance cannot be determined within bounds. Selection fails closed rather than guessing. (This state is pathological — normal rotation stays far below the bound.)`,
      { code: 'RedirectScanTruncated' },
    )
    this.source = source
    this.attester = attester
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
  constructor(chainId: number, hint?: string) {
    super(
      `No EFS deployment registered for chainId ${chainId}. Pass \`deployments\` to point at a custom/local deployment.${hint !== undefined ? ` ${hint}` : ''}`,
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

/**
 * The attestation LANDED but its follow-up indexing tx did not — the write is
 * fully valid in EAS, only DISCOVERY is pending (lens-scoped reads route through
 * `EFSIndexer`'s referencing index, which REDIRECT's resolver does not populate).
 * Distinct from {@link WriteRevertedError}: nothing is half-WRITTEN, and the
 * retry is always safe — `EFSIndexer.index/indexRevocation` are permissionless +
 * idempotent, so `efs.index(uid)` (from ANY funded account) completes it.
 * Carries the landed handle so nothing is lost.
 */
/** A REDIRECT revoke tx was BROADCAST but its receipt could not be confirmed
 * (RPC loss / provider drift during the wait) — the outcome is UNKNOWN: the
 * revoke may still mine, and a blind resend would REVERT in EAS
 * (AlreadyRevoked) once it does. Distinct from a CONFIRMED reverted receipt
 * (which propagates as `ContractReverted` — the redirect is definitely still
 * active) and from {@link IndexingIncomplete} (revoke confirmed, indexing leg
 * missing). Carries the in-flight hash; once the tx's fate is known, a mined
 * revoke still needs `efs.index(uid)` for the indexer's revocation mirror. */
export class RevokeUnconfirmed extends EfsError {
  override name = 'RevokeUnconfirmed'
  /** The REDIRECT attestation being revoked. */
  readonly uid: string
  /** The broadcast revoke transaction whose receipt is unconfirmed. */
  readonly revokeTx: string
  constructor(uid: string, revokeTx: string, cause: unknown) {
    super(
      `EFS redirects: the revoke tx ${revokeTx} for ${uid} was broadcast but its receipt could not be confirmed — it may STILL MINE. Check its fate before retrying (a resend REVERTS once it mines: AlreadyRevoked); after it mines, run efs.index(${uid}) to sync the indexer's revocation mirror.`,
      { code: 'PartialBatchFailure', cause },
    )
    this.uid = uid
    this.revokeTx = revokeTx
  }
}

/** An EFSIndexer `index`/`indexRevocation` tx BROADCAST but its receipt could
 * not be confirmed (RPC loss, provider drift during the wait) — the tx may
 * STILL MINE. Thrown by the indexer leg (`efs.index(uid)` and the redirect
 * verbs' follow-up legs); the redirect verbs wrap it into
 * {@link IndexingIncomplete} with the hash preserved on `indexTx`. A CONFIRMED
 * on-chain revert is NOT this error — that propagates as `ContractReverted`. */
export class IndexUnconfirmed extends EfsError {
  override name = 'IndexUnconfirmed'
  /** Which indexer leg broadcast. */
  readonly op: 'index' | 'indexRevocation'
  /** The UID the leg was indexing. */
  readonly uid: Hex
  /** The broadcast indexer transaction whose receipt is unconfirmed. */
  readonly txHash: Hex
  constructor(args: { op: 'index' | 'indexRevocation'; uid: Hex; txHash: Hex; cause: unknown }) {
    super(
      `EFS indexer: the ${args.op}('${args.uid}') tx ${args.txHash} was broadcast but its receipt could not be confirmed — it may STILL MINE. Reconcile before resending: check the tx's fate, or re-run efs.index('${args.uid}') once the RPC recovers (it re-reads on-chain state and only sends what is still missing).`,
      { code: 'PartialBatchFailure', cause: args.cause },
    )
    this.op = args.op
    this.uid = args.uid
    this.txHash = args.txHash
  }
}

export class IndexingIncomplete extends EfsError {
  override name = 'IndexingIncomplete'
  /** Which indexing leg failed. */
  readonly op: 'index' | 'indexRevocation'
  /** The landed attestation's UID (the `efs.index(uid)` repair handle). */
  readonly uid: Hex
  /** The landed leg's tx hash (the revoke tx, for the `indexRevocation` op). */
  readonly txHash?: Hex
  /** The partial write receipt (the `index` op — carries the landed steps). */
  readonly receipt?: WriteReceiptLike
  /** The IN-FLIGHT indexer tx: present when the index/indexRevocation tx
   * BROADCAST but its receipt could not be confirmed — it may still mine, so
   * reconcile its fate (or re-run `efs.index(uid)`, which re-reads state)
   * before resending. Absent when the leg never broadcast. */
  readonly indexTx?: Hex
  constructor(args: {
    op: 'index' | 'indexRevocation'
    uid: Hex
    txHash?: Hex
    receipt?: WriteReceiptLike
    indexTx?: Hex
    cause?: unknown
  }) {
    super(
      `EFS redirects: the ${args.op === 'index' ? 'REDIRECT landed but its EFSIndexer.index(uid)' : 'revoke landed but its EFSIndexer.indexRevocation(uid)'} follow-up did not — the write is valid but not yet ${args.op === 'index' ? 'discoverable' : 'filtered from'} lens-scoped reads. Recovery is safe and permissionless: call efs.index('${args.uid}') from any funded account (idempotent).${args.indexTx !== undefined ? ` The ${args.op} tx ${args.indexTx} WAS broadcast and may still mine — check its fate first (a landed tx makes the repair report 'already-indexed').` : ''}`,
      { code: 'PartialBatchFailure', cause: args.cause },
    )
    this.op = args.op
    this.uid = args.uid
    if (args.txHash !== undefined) this.txHash = args.txHash
    if (args.receipt !== undefined) this.receipt = args.receipt
    if (args.indexTx !== undefined) this.indexTx = args.indexTx
  }
}

/** Structural stand-in for {@link import('./types.js').WriteReceipt} — typed
 * loosely here to avoid an errors→types import cycle. */
type WriteReceiptLike = {
  steps: Array<{ id: string; uid?: Hex; done: boolean }>
  signatureCount: number
  status?: string
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

// NOTE (r3740924425): there is deliberately NO `Revoked` error / distinct
// revoked read-state on the v1 surface. Lens-scoped views are ACTIVE-only
// (`showRevoked=false` end to end), so a revoked placement never resolves — it
// reads as ABSENCE (`FileNotFoundError` / `exists: false`). A previous
// `Revoked` class + `verified: 'revoked'` promise was unreachable by
// construction and was removed rather than left as a false advertisement.

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
        ? `EFS read: the contentHash claim for '${path}' is malformed (not a well-formed multibase-multihash contentHash, specs/10). The bytes cannot be verified.`
        : 'EFS read: the contentHash claim is malformed (not a well-formed multibase-multihash contentHash, specs/10). The bytes cannot be verified.',
      { code: 'MalformedClaim' },
    )
    if (path !== undefined) this.path = path
  }
}

/** The file has NO `contentHash` claim under the lens, so the bytes cannot be verified.
 * Thrown by the fail-closed value sugar when verification was requested (the default):
 * a bare value has no status field to carry `no-claim`, so returning unverifiable bytes
 * would silently defeat the fail-closed contract. Pass `{ verify: false }` to opt out
 * (then `no-claim` is acceptable), or use `read()` which reports `verification` instead
 * of throwing. The {@link EfsFile} path reports `verification:'no-claim'`. */
export class MissingContentHash extends EfsError {
  override name = 'MissingContentHash'
  readonly path?: string
  constructor(path?: string) {
    super(
      path !== undefined
        ? `EFS read: no contentHash claim for '${path}' under this lens, so the bytes cannot be verified. Pass { verify: false } to read them unverified, or use read() to inspect the verification status.`
        : 'EFS read: no contentHash claim under this lens, so the bytes cannot be verified. Pass { verify: false } to read them unverified, or use read() to inspect the verification status.',
      { code: 'MissingContentHash' },
    )
    if (path !== undefined) this.path = path
  }
}

/** The read's trust freshness is below the caller's `requireTrust` floor
 * (ADR-0015) — thrown by the fail-closed value sugar. Carries the descriptor so
 * the caller sees exactly what the answer's provenance was. */
export class StaleTrust extends EfsError {
  override name = 'StaleTrust'
  readonly path?: string
  /** The offending descriptor (what the answer's provenance actually was). */
  readonly trust: { freshness: string; source: string }
  constructor(trust: { freshness: string; source: string }, require: string, path?: string) {
    super(
      `EFS read: the answer's trust freshness is '${trust.freshness}' (source '${trust.source}')${path !== undefined ? ` for '${path}'` : ''}, below the required '${require}' floor. Pass { requireTrust: 'any' } to accept it, or use read()/info() to inspect .trust without throwing.`,
      { code: 'StaleTrust' },
    )
    this.trust = trust
    if (path !== undefined) this.path = path
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
/** Classified codes that PROVE a send/deploy was refused with a RESPONSE — the
 * wallet/node answered (an error code, a decoded revert) or one of our own
 * pre-send guards fired — so the transaction was never broadcast and a
 * confident "nothing was sent" state is safe. Anything else (a code-less
 * transport failure: connection drop/timeout after the request may already
 * have reached the node) proves nothing — the tx may have been accepted and
 * still mine, so callers must surface an UNKNOWN-send state instead. Shared by
 * the layered submitter and the on-chain storage deploys. */
const DEFINITE_SEND_REFUSALS: ReadonlySet<string> = new Set([
  'UserRejected',
  'Unauthorized',
  'UnsupportedMethod',
  'Disconnected',
  'ContractReverted',
  'RpcError',
  'WrongChain',
  'InvalidArgument',
  'WalletRequired',
])

/** A raw EAS verb's `writeContract` failed WITHOUT a response — the transport
 * dropped after the request may already have reached the node, so whether the
 * transaction was broadcast is UNKNOWN: it may still mine, and there is NO
 * hash to reconcile by. The refusal-vs-transport split every send path applies
 * (see {@link isDefiniteSendRefusal}); a response-backed refusal propagates as
 * the ordinary classified error instead. */
export class EasSendUnknown extends EfsError {
  override name = 'EasSendUnknown'
  /** Which verb sent. */
  readonly op: 'attest' | 'multiAttest' | 'revoke'
  constructor(op: 'attest' | 'multiAttest' | 'revoke', cause: unknown) {
    super(
      `EFS eas.${op}: the send failed WITHOUT a response — whether the transaction was broadcast is UNKNOWN and it may STILL MINE (no tx hash is available). Do NOT blindly retry: ${op === 'revoke' ? 'a landed revoke makes the resend REVERT (AlreadyRevoked)' : 'a landed send would DUPLICATE the attestation(s)'}. Check the signing account's pending transactions/nonce first.`,
      { code: 'PartialBatchFailure', cause },
    )
    this.op = op
  }
}

/** `true` when `err` classifies to a definite send REFUSAL (see
 * {@link DEFINITE_SEND_REFUSALS}) — the tx was provably never broadcast. */
export function isDefiniteSendRefusal(err: unknown): boolean {
  return DEFINITE_SEND_REFUSALS.has(classifyError(err).code)
}

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
