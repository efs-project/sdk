/**
 * `efs.redirects.*` — the REDIRECT (alias) primitive (ADR-0050), with the
 * RATIFIED read semantics of contracts specs/09 (Accepted / ADR-0067): the
 * three redirect meanings are three SEPARATE operations, and only `symlink`
 * ever navigates (via `fs.locate/read({ followRedirects })`, ANCHOR-sourced).
 *
 *  - `set(from, to, { kind? })` → {@link WriteReceipt} — author a REDIRECT
 *    `(refUID = from, data = (to, kind))` as the connected wallet.
 *    `kind` defaults to `sameAs` (0). REDIRECT is NOT cardinality-1 (unlike PIN): a
 *    source may carry several active redirects, so `set` does NOT auto-supersede a
 *    prior one — replacement is `set` the new + `remove` the old. The AliasResolver
 *    enforces no-self-loop + per-kind endpoint typing on-chain; a violation surfaces
 *    as a typed `ContractReverted` at submit (the SDK does not pre-read endpoint
 *    schemas — the resolver is authoritative and reads cost gas on the write path).
 *  - `remove(redirectUID)` → `Hex` — revoke a REDIRECT by its own UID (via
 *    `efs.eas.revoke`, REDIRECT schema; REDIRECT is revocable per ADR-0050).
 *  - `get(from, { lens? })` → the SELECTED record per the ratified rule
 *    (first-attester-wins by lens order; ties within the winning attester break
 *    by LOWEST redirect UID — specs/09 §5/§8; selection paginates past revoked
 *    records). Any kind; not a walk.
 *  - `list(from, { lens? })` → EVERY active lens-visible redirect out of `from`
 *    (lens order, then ascending UID) — the raw discovery read.
 *  - `canonical(dataUID, { lens? })` → the `sameAs` dedup representative:
 *    lowest UID in the lens-scoped SCC (specs/09 §4.2), start-independent.
 *  - `history(dataUID, { lens?, maxHops? })` → the deliberate `supersededBy`
 *    breadcrumb walk (specs/09 §2) — the follower NEVER chases this; "latest"
 *    is the path's placement ("no silent revision": path = newest, UID = exact).
 *
 * Writes route through the SAME Submitter seam as `fs.write`/`graph.*`
 * (`submitEdgePlan`); the reads reuse the lens-scoped referencing index.
 */

import type { Hex } from 'viem'
import type { EfsDeployment } from '../chain/deployments.js'
import {
  EfsError,
  IndexSendUnknown,
  IndexUnconfirmed,
  IndexingIncomplete,
  RevokeUnconfirmed,
} from '../errors.js'
import { type ReadContext, resolveAttesters } from '../reads/context.js'
import {
  canonicalizeSameAs,
  listLensRedirects,
  selectLensRedirect,
  walkSupersededBy,
} from '../reads/redirects.js'
import type { ReadOptions, RedirectKind, RedirectRecord, WriteReceipt } from '../types.js'
import { type EdgeSubmitContext, submitEdgePlanWithUID } from './edge-submit.js'
import { EDGE_REF, REDIRECT_KIND, buildRedirectPlan } from './edge.js'

/** Options for a `redirects.set`. */
export interface RedirectSetOptions {
  /** The redirect class (ADR-0050). A name (`'sameAs'`/`'supersededBy'`/`'symlink'`/
   * `'relatedVersion'`) or a raw `uint16` code for a reserved kind. Default `'sameAs'`. */
  kind?: RedirectKind | number
  /** Send the follow-up `EFSIndexer.index(uid)` tx (default `true`). REDIRECT's
   * resolver does NOT populate the referencing index (AliasResolver is
   * write-guards-only), and every lens-scoped redirect read routes through it —
   * so WITHOUT this follow-up the freshly-set redirect is INVISIBLE to
   * `redirects.get`/`fs.locate` until someone calls the permissionless
   * `efs.index(uid)`. Opt out only when a relayer/batcher owns eventual
   * indexing; the caller then owns it (a subsequent `get` returns `undefined`
   * with no error). Costs one extra tx/prompt on the Tier-1 path — a
   * correctness necessity, not UX polish (correct > easy > fast). */
  index?: boolean
}

/** Options for a `redirects.remove`. */
export interface RedirectRemoveOptions {
  /** Send the follow-up `EFSIndexer.indexRevocation(uid)` tx (default `true`).
   * Filtered reads key on the INDEXER's revocation mirror, not EAS state — an
   * indexed redirect that is revoked in EAS keeps being SERVED until this runs.
   * Same opt-out semantics as {@link RedirectSetOptions.index}. */
  index?: boolean
}

/** The two-leg result of a `redirects.remove`: the EAS revoke tx plus the
 * indexer revocation-mirror tx (absent when `{ index: false }` opted out). */
export type RedirectRemoveReceipt = {
  /** The `efs.eas.revoke` tx hash (the revocation itself). */
  revokeTx: Hex
  /** The `EFSIndexer.indexRevocation(uid)` tx hash — what makes filtered reads
   * stop serving the redirect. Absent ⇔ the caller opted out. */
  indexRevocationTx?: Hex
}

/** Options for the lens-scoped redirect reads. */
export type RedirectGetOptions = Pick<ReadOptions, 'lens'>

/** Options for {@link RedirectsNs.history}. */
export type RedirectHistoryOptions = RedirectGetOptions & {
  /** Bound on the deliberate walk (default 16, hard ceiling 32 — specs/09 §3). */
  maxHops?: number
}

/** The result of a `redirects.canonical` (specs/09 §4.2). */
export type CanonicalResult = {
  /** The lowest UID in the `sameAs` SCC — the dedup representative. */
  canonical: Hex
  /** The SCC members (over the forward-reachable lens-visible subgraph). */
  members: readonly Hex[]
  /** `false` when the bounded exploration hit its node cap — the canonical is
   * then best-effort over the explored subgraph. */
  complete: boolean
}

/** The result of a `redirects.history` (specs/09 §2 breadcrumb walk). */
export type HistoryResult = {
  /** The latest REACHABLE version — the walk's terminal DATA. */
  latest: Hex
  /** The `supersededBy` hops taken, oldest→newest. */
  chain: readonly RedirectRecord[]
  /** `false` when a broken/revoked pointer, a loop, or the hop bound stopped
   * the walk early — `latest` is then the last GOOD reachable version. */
  complete: boolean
}

/** The `efs.redirects.*` write+read surface (present only on a write-capable client;
 * the read verbs also surface on the read-only client via `RedirectsReadNs`). */
export interface RedirectsNs {
  /** Author a REDIRECT from `from` to `to`, then make it DISCOVERABLE with a
   * follow-up `EFSIndexer.index(uid)` tx (two txs/prompts total; `{ index:
   * false }` opts out — see {@link RedirectSetOptions.index}). `kind` defaults
   * to `'sameAs'`. Does NOT supersede a prior redirect from the same source.
   * @throws {IndexingIncomplete} when the REDIRECT landed but the index tx did
   *   not — carries the landed UID; `efs.index(uid)` is the safe retry. */
  set(from: Hex, to: Hex, opts?: RedirectSetOptions): Promise<WriteReceipt>
  /** Revoke a REDIRECT by its attestation UID, then sync the indexer's
   * revocation mirror with `EFSIndexer.indexRevocation(uid)` (sequenced AFTER
   * the revoke mines — the contract requires it; two txs/prompts total).
   * @throws {IndexingIncomplete} when the revoke landed but the mirror tx did
   *   not — the redirect keeps being SERVED until `efs.index(uid)` repairs it.
   * @throws {RevokeUnconfirmed} when the broadcast revoke's receipt could not
   *   be confirmed (unknown outcome — may still mine; carries `revokeTx`). */
  remove(redirectUID: Hex, opts?: RedirectRemoveOptions): Promise<RedirectRemoveReceipt>
  /** The SELECTED active redirect FROM `from` under the lens (first-attester-wins,
   * lowest-UID tie-break — specs/09 §5/§8), or `undefined` when no lens member
   * asserts one. Any kind; not a chain walk. */
  get(from: Hex, opts?: RedirectGetOptions): Promise<RedirectRecord | undefined>
  /** EVERY active lens-visible redirect out of `from` (lens order, ascending UID
   * within each attester) — the raw discovery read. */
  list(from: Hex, opts?: RedirectGetOptions): Promise<readonly RedirectRecord[]>
  /** The `sameAs` dedup representative of `dataUID`'s cluster: the LOWEST UID in
   * the lens-scoped SCC (specs/09 §4.2) — start-independent, never navigational. */
  canonical(dataUID: Hex, opts?: RedirectGetOptions): Promise<CanonicalResult>
  /** The deliberate `supersededBy` version-history walk from `dataUID`
   * (specs/09 §2 breadcrumb — reads/locate NEVER auto-follow this). */
  history(dataUID: Hex, opts?: RedirectHistoryOptions): Promise<HistoryResult>
}

/** Dependencies the `redirects` namespace binds to (built once by the client). */
export interface RedirectsNsDeps {
  readonly getDeployment: () => EfsDeployment
  /** The lens-scoped read context (for the read verbs). */
  readonly readContext: () => ReadContext | Promise<ReadContext>
  readonly submitContext: () => EdgeSubmitContext
  /** Revoke a UID under a schema (wired to `efs.eas.revoke`). Returns the tx
   * hash WITHOUT waiting for the receipt (mirrors the eas verb). */
  readonly revoke: (schema: Hex, uid: Hex) => Promise<Hex>
  /** Send an `EFSIndexer.index`/`indexRevocation` tx and WAIT for its receipt
   * (wired by the client through the chain-guarded wallet + public clients).
   * Returns the tx hash. These calls are indexer txs, not EAS attestations, so
   * they cannot ride inside the layered `multiAttest` submit. */
  readonly indexerCall: (fn: 'index' | 'indexRevocation', uid: Hex) => Promise<Hex>
  /** Wait for a tx to mine (the revoke leg — `indexRevocation` reverts if the
   * revocation hasn't mined yet, so ordering is mandatory). */
  readonly waitForReceipt: (txHash: Hex) => Promise<void>
}

/**
 * Resolve a `kind` name|code to its numeric `uint16`. A raw number passes through
 * unchanged (the escape hatch for a reserved `kind >= 4`); a known name maps to its
 * code; `undefined` defaults to `sameAs` (0). Per ADR-0050 only the field string is
 * frozen — the kind taxonomy is upgradeable convention, so the named set may grow.
 *
 * @throws {InvalidArgument} for an unrecognized name string — silently coercing it to
 *   `sameAs` would miscategorize an identity-rerouting edge, so it fails loudly.
 */
function kindCode(kind: RedirectKind | number | undefined): number {
  if (kind === undefined) return REDIRECT_KIND.sameAs
  if (typeof kind === 'number') return kind
  switch (kind) {
    case 'sameAs':
      return REDIRECT_KIND.sameAs
    case 'supersededBy':
      return REDIRECT_KIND.supersededBy
    case 'symlink':
      return REDIRECT_KIND.symlink
    case 'relatedVersion':
      return REDIRECT_KIND.relatedVersion
    default:
      throw new EfsError(
        `efs.redirects: unrecognized kind '${String(kind)}'. Use 'sameAs' | 'supersededBy' | 'symlink' | 'relatedVersion', or pass a raw uint16 code for a reserved kind.`,
        { code: 'InvalidArgument' },
      )
  }
}

/** Construct the `efs.redirects.*` namespace bound to a client's deps. */
export function makeRedirectsNs(deps: RedirectsNsDeps): RedirectsNs {
  return {
    set: async (from, to, opts) => {
      const dep = deps.getDeployment()
      const plan = buildRedirectPlan(dep.schemas, from, to, kindCode(opts?.kind))
      const { receipt, uid: redirectUID } = await submitEdgePlanWithUID(
        plan,
        deps.submitContext(),
        EDGE_REF.REDIRECT,
      )
      if (opts?.index === false) return receipt // caller owns eventual indexing

      // The follow-up discovery tx. `index(uid)` reverts if the UID doesn't
      // exist in EAS, so it necessarily runs after the attest mined (it has —
      // submitEdgePlanWithUID waited for the layer receipt).
      try {
        await deps.indexerCall('index', redirectUID)
      } catch (err) {
        // The REDIRECT is fully landed and valid; only discovery is pending.
        // Surface the recoverable state, never lose the UID.
        throw new IndexingIncomplete({
          op: 'index',
          uid: redirectUID,
          // The index tx may have BROADCAST before the confirmation failed —
          // keep its hash so callers can reconcile before the repair; a send
          // that lost its response is flagged UNKNOWN (no hash exists).
          ...(err instanceof IndexUnconfirmed ? { indexTx: err.txHash } : {}),
          ...(err instanceof IndexSendUnknown ? { indexBroadcastUnknown: true } : {}),
          receipt: {
            ...receipt,
            status: 'partial',
            steps: [...receipt.steps, { id: 'index', uid: redirectUID, done: false }],
            // The user SIGNED the index tx when it broadcast (IndexUnconfirmed)
            // — and also when the SEND lost its response (IndexSendUnknown: the
            // wallet prompted and signed before the transport dropped) — so the
            // recovery artifact must not underreport the write's prompts/cost.
            // Only a refusal (never signed/broadcast) adds nothing.
            signatureCount:
              receipt.signatureCount +
              (err instanceof IndexUnconfirmed || err instanceof IndexSendUnknown ? 1 : 0),
          },
          cause: err,
        })
      }
      return {
        ...receipt,
        steps: [...receipt.steps, { id: 'index', uid: redirectUID, done: true }],
        // The index tx is a real extra prompt on the Tier-1 path.
        signatureCount: receipt.signatureCount + 1,
      }
    },

    remove: async (redirectUID, opts) => {
      const dep = deps.getDeployment()
      const revokeTx = await deps.revoke(dep.schemas.redirect, redirectUID)
      if (opts?.index === false) return { revokeTx }

      // ORDERING IS MANDATORY: indexRevocation reverts 'not revoked in EAS'
      // until the revoke tx mines — wait for it first. The two legs fail
      // DIFFERENTLY and must not share a catch: a failed/REVERTED revoke means
      // the redirect is still fully active in EAS — IndexingIncomplete's
      // "the write landed, efs.index(uid) repairs it" story would be false on
      // every clause (and the repair would report 'already-indexed', closing
      // the loop on the lie). Only an indexing-leg failure AFTER a successful
      // revoke wait is the recoverable partial state.
      try {
        await deps.waitForReceipt(revokeTx)
      } catch (err) {
        // A CONFIRMED reverted revoke is a definite failure — the redirect is
        // still active; it propagates raw (ContractReverted). Anything else
        // (RPC loss, provider drift during the wait) is an UNKNOWN outcome:
        // the revoke may still mine, and a blind resend would REVERT in EAS
        // (AlreadyRevoked) once it does. Preserve the in-flight hash.
        if ((err as { code?: string } | undefined)?.code === 'ContractReverted') throw err
        throw new RevokeUnconfirmed(redirectUID, revokeTx, err)
      }
      try {
        const indexRevocationTx = await deps.indexerCall('indexRevocation', redirectUID)
        return { revokeTx, indexRevocationTx }
      } catch (err) {
        // The revoke IS landed; the mirror is stale — the redirect keeps being
        // SERVED by filtered reads until repaired via efs.index(uid).
        throw new IndexingIncomplete({
          op: 'indexRevocation',
          uid: redirectUID,
          txHash: revokeTx,
          // Same hash preservation as set(): a broadcast-but-unconfirmed
          // indexRevocation tx may still mine — never discard it.
          ...(err instanceof IndexUnconfirmed ? { indexTx: err.txHash } : {}),
          cause: err,
        })
      }
    },

    get: async (from, opts) => {
      const ctx = await deps.readContext()
      const attesters = await resolveAttesters(ctx, opts)
      return selectLensRedirect(ctx, from, attesters)
    },

    list: async (from, opts) => {
      const ctx = await deps.readContext()
      const attesters = await resolveAttesters(ctx, opts)
      return listLensRedirects(ctx, from, attesters)
    },

    canonical: async (dataUID, opts) => {
      const ctx = await deps.readContext()
      const attesters = await resolveAttesters(ctx, opts)
      return canonicalizeSameAs(ctx, dataUID, attesters)
    },

    history: async (dataUID, opts) => {
      const ctx = await deps.readContext()
      const attesters = await resolveAttesters(ctx, opts)
      return walkSupersededBy(
        ctx,
        dataUID,
        attesters,
        opts?.maxHops !== undefined ? { maxHops: opts.maxHops } : undefined,
      )
    },
  }
}
