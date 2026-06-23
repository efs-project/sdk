/**
 * Lens-scoped REDIRECT (alias) read-resolution — the read-time half of ADR-0050.
 *
 * ## Why this is client logic (not free from the chain)
 *
 * `AliasResolver` is **write-time-guards-only**: it rejects a direct self-loop and
 * type-checks endpoints per `kind`, but does NOT follow redirects, and keeps NO
 * `(source, attester)` active-slot mapping (unlike PIN). `EFSRouter.resolvePath`
 * reads only the DATA-pin slot, so symlink/sameAs/supersededBy following is *new*
 * resolution logic that lives here (ADR-0050 §"Write-time guards vs read-time
 * resolution", §"Symlink/hardlink mapping" — both verified against the contract).
 *
 * ## Discovering the active redirect FROM a source (lens-scoped)
 *
 * A REDIRECT puts the SOURCE in `refUID` and `(target, kind)` in the payload. So the
 * active redirect(s) from a source are exactly the referencing attestations of the
 * REDIRECT schema that point at that source — read lens-scoped + revoked-excluded via
 * `EFSIndexer.getReferencingBySchemaAndAttester(source, REDIRECT_SCHEMA_UID, attester,
 * …, showRevoked=false)` (the same per-attester referencing index that backs
 * lens-scoped MIRROR/PROPERTY reads, ADR-0013/0014). We walk the lens in order and
 * take the FIRST attester with an active redirect (first-attester-wins, ADR-0031),
 * and that attester's MOST RECENT active redirect (reverseOrder=true) when they have
 * more than one — REDIRECT is not cardinality-1, so a source can carry several.
 *
 * ## What is NOT yet pinned (honest scope)
 *
 * ADR-0050's normative *resolution spec* (Durable, not frozen) is unfinished — it
 * must be pinned before durable seeding. Two of its rules are therefore NOT guessed
 * here:
 *   - **Cycle = lowest-UID-in-SCC.** On a detected cycle we throw {@link RedirectCycle}
 *     rather than computing a strongly-connected component and picking its lowest UID
 *     (a start-independent canonical). Implementing the SCC walk would be guessing an
 *     unpinned Etched-adjacent algorithm; failing closed is the safe, honest choice.
 *   - **Lens precedence across a multi-attester chain.** We resolve each hop against
 *     the SAME ordered lens (first-attester-wins per hop). ADR-0050's "follow only
 *     redirects asserted by attesters in the reader's trusted lens, in priority
 *     order" is satisfied per hop; any richer cross-hop precedence is deferred with
 *     the spec.
 *
 * Everything that IS clear from the contract — the encoding, from→to, kind-following
 * (`sameAs`/`supersededBy`/`symlink` followed; `relatedVersion`/`kind>=3` never),
 * the hop cap, and cycle *detection* — is implemented.
 */

import type { Address, Hex } from 'viem'
import { decodeAbiParameters } from 'viem'
import { getReferencingBySchemaAndAttesterAbi } from '../chain/abi/indexer.js'
import { getAttestationAbi } from '../eas/abi.js'
import { RedirectCycle, RedirectHopLimit } from '../errors.js'
import type { RedirectKind, RedirectRecord } from '../types.js'
import { REDIRECT_FOLLOW_MAX_KIND } from '../writes/edge.js'
import { type ReadContext, ZERO_UID, read } from './context.js'

/** ADR-0050 default depth cap (`D_MAX` ≈ 8). The hard ceiling is
 * {@link MAX_REDIRECT_HOPS} (= `MAX_ANCHOR_DEPTH`, 32). */
export const DEFAULT_REDIRECT_HOPS = 8

/** Hard ceiling on redirect hops (ADR-0050: `MAX_ANCHOR_DEPTH` = 32). A larger
 * `followRedirects: n` is clamped to this. */
export const MAX_REDIRECT_HOPS = 32

/** Map a numeric `kind` to its named {@link RedirectKind}, or `undefined` for a
 * reserved code with no SDK name yet (`kind >= 4`). */
export function redirectKindName(kindCode: number): RedirectKind | undefined {
  switch (kindCode) {
    case 0:
      return 'sameAs'
    case 1:
      return 'supersededBy'
    case 2:
      return 'symlink'
    case 3:
      return 'relatedVersion'
    default:
      return undefined
  }
}

/** Whether a `kind` is auto-followed at read time (ADR-0050: `sameAs`/`supersededBy`/
 * `symlink` followed; `relatedVersion`/`kind >= 3` is a discovery hint, never
 * auto-followed). */
export function isAutoFollowedKind(kindCode: number): boolean {
  return kindCode >= 0 && kindCode < REDIRECT_FOLLOW_MAX_KIND
}

/**
 * Normalize the `followRedirects` read option to a numeric hop cap.
 *   - `undefined` / `false` / `0` ⇒ `0` (do not follow).
 *   - `true` ⇒ {@link DEFAULT_REDIRECT_HOPS}.
 *   - a positive number ⇒ that number, clamped to {@link MAX_REDIRECT_HOPS}.
 */
export function resolveHopCap(followRedirects: boolean | number | undefined): number {
  if (followRedirects === undefined || followRedirects === false) return 0
  if (followRedirects === true) return DEFAULT_REDIRECT_HOPS
  if (followRedirects <= 0) return 0
  return Math.min(Math.floor(followRedirects), MAX_REDIRECT_HOPS)
}

/** Decode a REDIRECT attestation `data` blob (`bytes32 target, uint16 kind`). */
function decodeRedirectData(data: Hex): { target: Hex; kindCode: number } | undefined {
  if (data === undefined || data === '0x' || data.length <= 2) return undefined
  try {
    const [target, kind] = decodeAbiParameters([{ type: 'bytes32' }, { type: 'uint16' }], data) as [
      Hex,
      number,
    ]
    return { target, kindCode: Number(kind) }
  } catch {
    return undefined
  }
}

/**
 * Read the active redirect FROM `source` under the lens — the first attester in the
 * ordered `attesters` list with an active (unrevoked) REDIRECT whose `refUID` is
 * `source`. Returns `undefined` when no lens member asserts one (a normal absence).
 *
 * When the winning attester has more than one active redirect from the same source
 * (REDIRECT is not cardinality-1), the MOST RECENT is taken (`reverseOrder=true`).
 *
 * @param opts.requireFollowable When `true` (the chain-walk path), a winning record
 *   whose `kind` is NOT auto-followed (`relatedVersion`/`kind >= 3`) is treated as no
 *   redirect (returns `undefined`) — a discovery hint never reroutes resolution. The
 *   plain `redirects.get` read leaves this `false` so it surfaces the literal record
 *   regardless of kind.
 */
export async function readActiveRedirect(
  ctx: ReadContext,
  source: Hex,
  attesters: readonly Address[],
  opts?: { requireFollowable?: boolean },
): Promise<RedirectRecord | undefined> {
  const { contracts, schemas } = ctx.deployment
  const requireFollowable = opts?.requireFollowable ?? false

  for (const attester of attesters) {
    // The attester's active redirects pointing at `source`, newest-first, revoked
    // excluded. `length` 1 is enough — we want the single most-recent active one.
    const uids = await read<readonly Hex[]>(ctx.publicClient, {
      address: contracts.indexer,
      abi: getReferencingBySchemaAndAttesterAbi,
      functionName: 'getReferencingBySchemaAndAttester',
      // (targetUID=source, schemaUID=REDIRECT, attester, start, length, reverseOrder, showRevoked)
      args: [source, schemas.redirect, attester, 0n, 1n, true, false],
    })
    const redirectUID = uids[0]
    if (redirectUID === undefined || redirectUID === ZERO_UID) continue

    const att = await read<{ data: Hex }>(ctx.publicClient, {
      address: contracts.eas,
      abi: getAttestationAbi,
      functionName: 'getAttestation',
      args: [redirectUID],
    })

    const decoded = decodeRedirectData(att.data)
    if (decoded === undefined || decoded.target === ZERO_UID) continue
    if (requireFollowable && !isAutoFollowedKind(decoded.kindCode)) {
      // A discovery-hint kind from the winning attester does NOT reroute; and since
      // first-attester-wins resolved to this attester, we stop here (no fall-through
      // to a lower-priority attester's redirect — that would let a less-trusted lens
      // member override the trusted one's "do not follow" stance).
      return undefined
    }
    const kind = redirectKindName(decoded.kindCode)
    return {
      from: source,
      to: decoded.target,
      kindCode: decoded.kindCode,
      ...(kind !== undefined ? { kind } : {}),
      redirectUID,
      attester,
    }
  }
  return undefined
}

/** The terminal of a redirect walk: where it landed plus the chain followed. */
export type RedirectFollowResult = {
  /** The terminal UID — the requested UID itself when nothing was followed. */
  target: Hex
  /** The ordered hops taken (empty when no redirect was followed). */
  via: readonly RedirectRecord[]
}

/**
 * Follow the active redirect chain from `start` under the lens, up to `cap` hops,
 * following only auto-followable kinds (`sameAs`/`supersededBy`/`symlink`). Stops at
 * the first UID with no active followable redirect and returns it as `target`.
 *
 * Fail-closed on the two hazard cases (ADR-0050):
 *   - a UID re-encountered ⇒ {@link RedirectCycle} (no SCC-canonicalization guess);
 *   - the chain not terminating within `cap` ⇒ {@link RedirectHopLimit}.
 *
 * `cap === 0` short-circuits to `{ target: start, via: [] }` (the opt-out path).
 */
export async function followRedirectChain(
  ctx: ReadContext,
  start: Hex,
  attesters: readonly Address[],
  cap: number,
): Promise<RedirectFollowResult> {
  if (cap <= 0) return { target: start, via: [] }

  const via: RedirectRecord[] = []
  const visited = new Set<Hex>([start])
  let current = start

  for (let hop = 0; hop < cap; hop++) {
    const record = await readActiveRedirect(ctx, current, attesters, { requireFollowable: true })
    if (record === undefined) {
      // No active followable redirect — `current` is the terminal.
      return { target: current, via }
    }
    if (visited.has(record.to)) {
      // The destination re-enters the visited set: a cycle. Fail closed.
      throw new RedirectCycle(record.to, [...visited])
    }
    via.push(record)
    visited.add(record.to)
    current = record.to
  }

  // Consumed all `cap` followable hops. The chain is only OVER the cap if `current` (the
  // destination of the last hop, not yet inspected) STILL has another followable redirect — a
  // chain whose length EQUALS the cap and then terminates is valid (e.g. `followRedirects: 1`
  // for `A → B` with no redirect from `B`). One final terminal check before failing closed:
  const beyond = await readActiveRedirect(ctx, current, attesters, { requireFollowable: true })
  if (beyond === undefined) return { target: current, via } // terminal exactly at the cap — valid
  if (visited.has(beyond.to)) throw new RedirectCycle(beyond.to, [...visited])
  // A genuine (cap+1)th followable hop exists — the chain is too long (or unbounded).
  throw new RedirectHopLimit(cap, [...visited])
}
