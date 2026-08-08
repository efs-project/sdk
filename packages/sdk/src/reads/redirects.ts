/**
 * Lens-scoped REDIRECT read-resolution — the RATIFIED algorithm of contracts
 * specs/09-redirect-resolution.md (Accepted, James 2026-06-20; ADR-0067). The
 * on-chain follower is deferred, so this SDK is the first conformant reader.
 *
 * ## The three separate operations (specs/09 §2/§4)
 *
 *  - **Navigation** ({@link walkSymlinks}) — ONLY `symlink` (2) is auto-followed,
 *    and a symlink is ANCHOR-sourced: path resolution consumes this walker per
 *    landed anchor (`reads/resolve.ts` / `reads/file.ts`). `sameAs` and
 *    `supersededBy` are NON-followed terminals — an exact DATA UID never
 *    silently advances ("no silent revision", path=newest / UID=exact).
 *  - **Equivalence canonicalization** ({@link canonicalizeSameAs}) — the dedup
 *    layer: the canonical representative of a `sameAs` SCC is its LOWEST UID by
 *    `bytes32` comparison (§4.2), start-independent. Never navigational.
 *  - **Version history** ({@link walkSupersededBy}) — a deliberate breadcrumb
 *    walk clients opt into (§2); the navigational follower never chases it.
 *
 * ## Results are DATA, not throws (specs/09 §3/§4.1/§6)
 *
 * A walk stops and SURFACES a node with a status — `Resolved` | `Dangling`
 * (broken/revoked/mistyped target; last good node) | `CycleStopped` (visited
 * re-entry; node before the repeat) | `DepthExceeded` (a healthy edge would be
 * hop `D_MAX`+1; the node at depth cap). It never reverts/throws. The prior
 * fail-closed `RedirectCycle`/`RedirectHopLimit` errors are deleted.
 *
 * ## Selection (specs/09 §5/§8) and the revoked-newest fix
 *
 * `firstInLensRedirect`: the first attester in lens order with ANY active
 * redirect out of the node wins (no fall-through — a trusted attester's
 * non-navigational winner is a `Resolved` terminal, never overridden by a
 * lower-priority attester's symlink); ties within the winning attester break by
 * LOWEST redirect UID. Selection paginates the indexer's PHYSICAL windows
 * (`_sliceUIDsFiltered` filters WITHIN a window — a `length=1` newest-first read
 * returns empty when the newest record is revoked even though older active ones
 * exist, which both faked an absence and let a lower-priority lens member win).
 */

import type { Address, Hex } from 'viem'
import { decodeAbiParameters } from 'viem'
import {
  getReferencingBySchemaAndAttesterAbi,
  getReferencingBySchemaAndAttesterCountAbi,
} from '../chain/abi/indexer.js'
import { getAttestationAbi } from '../eas/abi.js'
import { EfsError, RedirectScanTruncated } from '../errors.js'
import type { RedirectKind, RedirectRecord } from '../types.js'
import { type ReadContext, ZERO_UID, read } from './context.js'

/** The ratified default navigational ceiling (specs/09 §3: `D_MAX = 16`,
 * James 2026-06-20). Only followed symlinks count as hops. */
export const DEFAULT_REDIRECT_HOPS = 16

/** The structural hard ceiling on redirect hops (specs/09 §3: 32 — the walk's
 * own bounded-walk number; the anchor-depth budget is independent and larger,
 * `MAX_ANCHOR_DEPTH = 256` per ADR-0068). `followRedirects: n` clamps to this. */
export const MAX_REDIRECT_HOPS = 32

/** Physical index slots paged per `(source, attester)` during selection — an
 * SDK policy bound the spec doesn't set. Exceeding it throws
 * {@link RedirectScanTruncated} (fail closed): silently treating the attester
 * as redirect-free would be attacker-influenceable via revoked-spam, and a
 * partial window can't even vouch for the lowest-UID tie-break. */
export const MAX_REDIRECT_SCAN = 512

/** Page size for the physical-window pagination. */
const SCAN_PAGE = 32n

/** Node cap for the bounded `sameAs` SCC exploration (§4.2 is a client-layer
 * computation; unbounded cluster walking never belongs on a read path). */
export const MAX_SAMEAS_NODES = 256

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

/** The ONLY auto-followed (navigational) kind: `symlink` (2). specs/09 §2,
 * James ratified 2026-06-20 — `sameAs`(0)/`supersededBy`(1) are non-followed
 * terminals; `kind >= 3` is inert. */
export function isNavigationalKind(kindCode: number): boolean {
  return kindCode === 2
}

/**
 * Normalize the `followRedirects` read option to a numeric hop cap.
 *   - `undefined` / `false` / `0` ⇒ `0` (do not follow — the literal walk).
 *   - `true` ⇒ {@link DEFAULT_REDIRECT_HOPS} (the ratified `D_MAX = 16`).
 *   - a positive number ⇒ that number, clamped to {@link MAX_REDIRECT_HOPS}.
 *   - a NON-FINITE number (`NaN`/`±Infinity`) throws `InvalidArgument` — NaN
 *     fails every comparison, so it would silently DISABLE following for a
 *     caller who explicitly requested it (paths reachable only through a
 *     symlink would read as absent with no signal).
 */
export function resolveHopCap(followRedirects: boolean | number | undefined): number {
  if (followRedirects === undefined || followRedirects === false) return 0
  if (followRedirects === true) return DEFAULT_REDIRECT_HOPS
  if (!Number.isFinite(followRedirects)) {
    throw new EfsError(
      `EFS read: \`followRedirects\` is ${String(followRedirects)} — pass a boolean or a finite hop count (1–${MAX_REDIRECT_HOPS}).`,
      { code: 'InvalidArgument' },
    )
  }
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
 * Every ACTIVE redirect UID out of `source` authored by `attester`, by paging
 * the indexer's PHYSICAL windows forward (`showRevoked=false` filters WITHIN
 * each window — the fix for the revoked-newest empty-page bug). `complete` is
 * `false` when {@link MAX_REDIRECT_SCAN} slots were consumed before the
 * physical count was exhausted.
 */
async function listActiveRedirectUIDs(
  ctx: ReadContext,
  source: Hex,
  attester: Address,
): Promise<{ uids: Hex[]; complete: boolean }> {
  const { contracts, schemas } = ctx.deployment
  const count = await read<bigint>(ctx.publicClient, {
    address: contracts.indexer,
    abi: getReferencingBySchemaAndAttesterCountAbi,
    functionName: 'getReferencingBySchemaAndAttesterCount',
    args: [source, schemas.redirect, attester],
  })
  const uids: Hex[] = []
  const limit = count < BigInt(MAX_REDIRECT_SCAN) ? count : BigInt(MAX_REDIRECT_SCAN)
  for (let start = 0n; start < limit; start += SCAN_PAGE) {
    const page = await read<readonly Hex[]>(ctx.publicClient, {
      address: contracts.indexer,
      abi: getReferencingBySchemaAndAttesterAbi,
      functionName: 'getReferencingBySchemaAndAttester',
      // (targetUID=source, schemaUID=REDIRECT, attester, start, length, reverseOrder=false, showRevoked=false)
      args: [source, schemas.redirect, attester, start, SCAN_PAGE, false, false],
    })
    for (const u of page) if (u !== ZERO_UID) uids.push(u)
  }
  return { uids, complete: count <= BigInt(MAX_REDIRECT_SCAN) }
}

/** Fetch + decode one redirect record. `undefined` if the data blob is
 * malformed or zero-target (unreachable for resolver-validated writes —
 * defensive for foreign/mocked data). */
async function fetchRedirectRecord(
  ctx: ReadContext,
  source: Hex,
  redirectUID: Hex,
  attester: Address,
): Promise<RedirectRecord | undefined> {
  const att = await read<{ data: Hex; revocationTime: bigint }>(ctx.publicClient, {
    address: ctx.deployment.contracts.eas,
    abi: getAttestationAbi,
    functionName: 'getAttestation',
    args: [redirectUID],
  })
  // The indexer scan that produced `redirectUID` was ACTIVE-only, but this EAS
  // lookup is a SECOND read — a revoke landing between the two still decodes
  // here. Recheck revocation on the authoritative record and discard: a
  // just-retracted redirect must not be honored by get/list/canonical/history
  // or the symlink walk for one more read (r3740949738).
  if (att.revocationTime !== 0n) return undefined
  const decoded = decodeRedirectData(att.data)
  if (decoded === undefined || decoded.target === ZERO_UID) return undefined
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

/**
 * `firstInLensRedirect` (specs/09 §5/§8): the selected redirect out of `source`
 * under the ordered lens — first attester with ANY active redirect wins; ties
 * within that attester break by LOWEST redirect UID (`bytes32` comparison, the
 * §4.2 discipline); the record may be of ANY kind (the caller decides
 * followability — a non-navigational winner is a terminal, never a
 * fall-through to a lower-priority attester). `undefined` = no lens member
 * asserts a redirect (a normal absence).
 */
export async function selectLensRedirect(
  ctx: ReadContext,
  source: Hex,
  attesters: readonly Address[],
): Promise<RedirectRecord | undefined> {
  for (const attester of attesters) {
    const { uids, complete } = await listActiveRedirectUIDs(ctx, source, attester)
    // Fail CLOSED on a truncated scan: an active record beyond the bound could
    // hold both the first-attester win and the lowest-UID tie-break, so neither
    // "this attester asserts nothing" (fall-through — the exact revoked-spam
    // suppression the paged scan exists to prevent) nor "the lowest found wins"
    // is a safe verdict.
    if (!complete) throw new RedirectScanTruncated(source, attester, MAX_REDIRECT_SCAN)
    if (uids.length === 0) continue
    // Ascending bytes32 order (lowercase-hex compares bytewise) — the §4.2
    // lowest-UID discipline. Decode candidates IN THAT ORDER until one survives
    // the EAS recheck: the scan and the decode are two reads, so the lowest UID
    // may have been revoked in between while the SAME attester still asserts
    // others — first-attester-wins means falling through to a lower-priority
    // attester is only legal when every candidate of this one is gone
    // (r3740967874). A malformed candidate (foreign data — unreachable for
    // resolver-validated writes) is likewise treated as not-a-record.
    const ordered = [...uids].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
    for (const candidate of ordered) {
      const record = await fetchRedirectRecord(ctx, source, candidate, attester)
      if (record !== undefined) return record
    }
  }
  return undefined
}

/**
 * ALL active lens-visible redirects out of `source`, decoded, in lens order
 * then ascending UID within each attester — the raw discovery read behind
 * `redirects.list` and the deliberate walks.
 */
export async function listLensRedirects(
  ctx: ReadContext,
  source: Hex,
  attesters: readonly Address[],
): Promise<RedirectRecord[]> {
  const out: RedirectRecord[] = []
  for (const attester of attesters) {
    const { uids, complete } = await listActiveRedirectUIDs(ctx, source, attester)
    // Same fail-closed rule as selection: a truncated discovery listing would
    // silently omit records, and the deliberate walks built on it (canonical/
    // history) would report confident results over an incomplete edge set.
    if (!complete) throw new RedirectScanTruncated(source, attester, MAX_REDIRECT_SCAN)
    uids.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
    const records = await Promise.all(
      uids.map((u) => fetchRedirectRecord(ctx, source, u, attester)),
    )
    for (const r of records) if (r !== undefined) out.push(r)
  }
  return out
}

/** The surfaced-node status of a navigational walk (specs/09 §8). The spec's
 * fifth status, `Suppressed-reserved`, is DEFINED-BUT-NEVER-RETURNED by the
 * redirect follower (§7: suppression is WHITEOUT, applied by router/view logic
 * outside this walker) — deliberately absent from this union so a conformant
 * consumer can never receive it from a redirect input. */
export type RedirectWalkStatus = 'Resolved' | 'Dangling' | 'CycleStopped' | 'DepthExceeded'

/** The result of a navigational symlink walk: the surfaced node + status +
 * the hops taken (specs/09 §8 `Result`, plus the SDK's hop provenance). */
export type RedirectWalkResult = {
  /** The surfaced node — the terminal on `Resolved`; the last good / last
   * reached / pre-repeat node on the non-`Resolved` statuses. */
  uid: Hex
  /** `true` ⇒ `uid` is a DATA; `false` ⇒ an ANCHOR. */
  isData: boolean
  status: RedirectWalkStatus
  /** The symlink hops followed, in order (empty when nothing was followed). */
  via: readonly RedirectRecord[]
}

/** A mutable hop budget for ONE navigational walk (specs/09 §8: the reference
 * algorithm re-initializes the hop counter per follower re-entry, so the
 * D_MAX bound is per landed anchor — the path resolver mints a fresh budget
 * per walk; total work stays bounded by segments × cap). */
export type HopBudget = { remaining: number }

/**
 * The navigational follower (specs/09 §8, exact check order): per iteration —
 * select the first-in-lens redirect (∅ → `Resolved`); a non-`symlink` kind →
 * `Resolved` (non-followed terminal); a dangling target (missing / revoked /
 * fails ANCHOR-or-DATA read-time typing, §6) → `Dangling`; budget exhausted
 * with a healthy edge pending → `DepthExceeded`; a visited target →
 * `CycleStopped`; else advance. Statuses surface nodes; nothing throws.
 *
 * ANCHOR-sourced: callers enter with the anchor a path walk landed on. A
 * symlink may cross ANCHOR→DATA (`isData` flips via the target's schema).
 */
export async function walkSymlinks(
  ctx: ReadContext,
  entry: { uid: Hex; isData: boolean },
  attesters: readonly Address[],
  budget: HopBudget,
): Promise<RedirectWalkResult> {
  const { schemas } = ctx.deployment
  const visited = new Set<string>()
  const via: RedirectRecord[] = []
  let node = entry

  for (;;) {
    const edge = await selectLensRedirect(ctx, node.uid, attesters)
    if (edge === undefined) {
      return { ...node, status: 'Resolved', via } // terminal: nothing to follow
    }
    if (!isNavigationalKind(edge.kindCode)) {
      return { ...node, status: 'Resolved', via } // non-followed terminal, no fall-through
    }

    // Dangling check (§6): the target must exist, be unrevoked, and pass the
    // kind's read-time typing — a symlink target must be ANCHOR-or-DATA.
    const target = await read<{ uid: Hex; schema: Hex; revocationTime: bigint }>(ctx.publicClient, {
      address: ctx.deployment.contracts.eas,
      abi: getAttestationAbi,
      functionName: 'getAttestation',
      args: [edge.to],
    })
    const targetIsData = target.schema === schemas.data
    const targetIsAnchor = target.schema === schemas.anchor
    if (
      target.uid === ZERO_UID ||
      target.revocationTime !== 0n ||
      !(targetIsData || targetIsAnchor)
    ) {
      return { ...node, status: 'Dangling', via } // surface the last good node
    }

    // Depth cap (§3): a healthy (cap+1)th edge pending ⇒ DepthExceeded.
    if (budget.remaining <= 0) {
      return { ...node, status: 'DepthExceeded', via }
    }

    // Cycle-stop (§4.1): the destination re-enters this walk's visited-set.
    if (visited.has(edge.to.toLowerCase())) {
      return { ...node, status: 'CycleStopped', via }
    }
    visited.add(node.uid.toLowerCase())

    via.push(edge)
    node = { uid: edge.to, isData: targetIsData }
    budget.remaining -= 1
  }
}

/**
 * `sameAs` canonicalization (specs/09 §4.2) — the DEDUP layer, never
 * navigation: compute the strongly-connected component of lens-visible active
 * `sameAs` edges containing `dataUID`; the canonical representative is the
 * LOWEST UID in the SCC (start-independent — every conformant reader
 * converges). Bounded by {@link MAX_SAMEAS_NODES}; `complete: false` when the
 * cap cut the exploration (the canonical is then best-effort over the explored
 * subgraph, surfaced honestly rather than thrown).
 *
 * `members` is the SCC over the FORWARD-reachable subgraph — correct for the
 * SCC-of-start (an SCC member is by definition reachable from the start), but
 * nodes that point AT the start without a back-path are not on-chain
 * discoverable (the referencing index is keyed by source), so this is the SCC,
 * not the weakly-connected cluster.
 */
export async function canonicalizeSameAs(
  ctx: ReadContext,
  dataUID: Hex,
  attesters: readonly Address[],
): Promise<{ canonical: Hex; members: readonly Hex[]; complete: boolean }> {
  // 1. Bounded forward exploration collecting sameAs adjacency.
  const adjacency = new Map<string, Set<string>>() // lowercase uid → lowercase targets
  const canonicalCase = new Map<string, Hex>() // lowercase → original casing
  const queue: Hex[] = [dataUID]
  canonicalCase.set(dataUID.toLowerCase(), dataUID)
  let complete = true

  while (queue.length > 0) {
    const node = queue.shift() as Hex
    const key = node.toLowerCase()
    if (adjacency.has(key)) continue
    if (adjacency.size >= MAX_SAMEAS_NODES) {
      complete = false
      break
    }
    const edges = await listLensRedirects(ctx, node, attesters)
    const targets = new Set<string>()
    for (const e of edges) {
      if (e.kindCode !== 0) continue // sameAs only
      const tKey = e.to.toLowerCase()
      targets.add(tKey)
      if (!canonicalCase.has(tKey)) {
        canonicalCase.set(tKey, e.to)
        queue.push(e.to)
      }
    }
    adjacency.set(key, targets)
  }

  // Targets we never fetched edges for (beyond the cap, or plain leaves) are
  // nodes with no known outgoing edges — trivially their own SCC.
  for (const targets of adjacency.values()) {
    for (const t of targets) if (!adjacency.has(t)) adjacency.set(t, new Set())
  }

  // 2. Tarjan SCC over the explored subgraph; take the component containing
  //    the start node.
  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let counter = 0
  let startSCC: string[] = []
  const startKey = dataUID.toLowerCase()
  if (!adjacency.has(startKey)) adjacency.set(startKey, new Set())

  const strongconnect = (v: string): void => {
    index.set(v, counter)
    lowlink.set(v, counter)
    counter += 1
    stack.push(v)
    onStack.add(v)
    for (const w of adjacency.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w)
        lowlink.set(v, Math.min(lowlink.get(v) as number, lowlink.get(w) as number))
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v) as number, index.get(w) as number))
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = []
      for (;;) {
        const w = stack.pop() as string
        onStack.delete(w)
        component.push(w)
        if (w === v) break
      }
      if (component.includes(startKey)) startSCC = component
    }
  }
  strongconnect(startKey)

  const members = startSCC
    .map((k) => canonicalCase.get(k) ?? (k as Hex))
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
  const canonical = members[0] ?? dataUID
  return { canonical, members, complete }
}

/**
 * The deliberate `supersededBy` version-history walk (specs/09 §2 — a
 * discoverable breadcrumb clients opt into; the navigational follower NEVER
 * chases it). Per node the lens-visible kind-1 edges select first-attester-wins
 * with lowest-UID ties; a broken/revoked/mistyped pointer stops at the last
 * good DATA (`latest`, `complete: false`); a loop or budget exhaustion stops
 * the same way. There is no "canonical version" to elect (§4.2) — the walk is
 * ordered, not an equivalence class.
 */
export async function walkSupersededBy(
  ctx: ReadContext,
  dataUID: Hex,
  attesters: readonly Address[],
  opts?: { maxHops?: number },
): Promise<{ latest: Hex; chain: readonly RedirectRecord[]; complete: boolean }> {
  const { schemas } = ctx.deployment
  // Same validation rule as resolveHopCap: a NaN cap would walk ZERO edges and
  // report the start as an (incomplete-looking) history; a fractional cap
  // exceeds the requested bound in the `<` loop. Finite check + floor + clamp.
  const requested = opts?.maxHops ?? DEFAULT_REDIRECT_HOPS
  if (!Number.isFinite(requested) || requested < 0) {
    throw new EfsError(
      `EFS redirects.history: \`maxHops\` is ${String(requested)} — pass a finite non-negative hop count (≤ ${MAX_REDIRECT_HOPS}).`,
      { code: 'InvalidArgument' },
    )
  }
  const cap = Math.min(Math.floor(requested), MAX_REDIRECT_HOPS)
  const visited = new Set<string>([dataUID.toLowerCase()])
  const chain: RedirectRecord[] = []
  let current = dataUID

  for (let hop = 0; hop < cap; hop++) {
    // Select among the lens-visible kind-1 edges specifically: first attester
    // in lens order with one wins; ties break by lowest redirect UID.
    const all = await listLensRedirects(ctx, current, attesters)
    const edge = all.find((e) => e.kindCode === 1) // lens-then-UID ordered already
    if (edge === undefined) return { latest: current, chain, complete: true }

    // The §6 pointer re-check: a broken/revoked/non-DATA target means the last
    // good DATA is the latest reachable version.
    const target = await read<{ uid: Hex; schema: Hex; revocationTime: bigint }>(ctx.publicClient, {
      address: ctx.deployment.contracts.eas,
      abi: getAttestationAbi,
      functionName: 'getAttestation',
      args: [edge.to],
    })
    if (target.uid === ZERO_UID || target.revocationTime !== 0n || target.schema !== schemas.data) {
      return { latest: current, chain, complete: false }
    }
    if (visited.has(edge.to.toLowerCase())) {
      return { latest: current, chain, complete: false } // malformed looping chain
    }
    visited.add(edge.to.toLowerCase())
    chain.push(edge)
    current = edge.to
  }
  // Budget exhausted with the chain still advancing.
  const beyond = (await listLensRedirects(ctx, current, attesters)).find((e) => e.kindCode === 1)
  return { latest: current, chain, complete: beyond === undefined }
}
