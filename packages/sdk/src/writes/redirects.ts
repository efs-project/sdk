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
import { EfsError } from '../errors.js'
import { type ReadContext, resolveAttesters } from '../reads/context.js'
import {
  canonicalizeSameAs,
  listLensRedirects,
  selectLensRedirect,
  walkSupersededBy,
} from '../reads/redirects.js'
import type { ReadOptions, RedirectKind, RedirectRecord, WriteReceipt } from '../types.js'
import { type EdgeSubmitContext, submitEdgePlan } from './edge-submit.js'
import { REDIRECT_KIND, buildRedirectPlan } from './edge.js'

/** Options for a `redirects.set`. */
export interface RedirectSetOptions {
  /** The redirect class (ADR-0050). A name (`'sameAs'`/`'supersededBy'`/`'symlink'`/
   * `'relatedVersion'`) or a raw `uint16` code for a reserved kind. Default `'sameAs'`. */
  kind?: RedirectKind | number
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
  /** Author a REDIRECT from `from` to `to` (one signature). `kind` defaults to
   * `'sameAs'`. Does NOT supersede a prior redirect from the same source. */
  set(from: Hex, to: Hex, opts?: RedirectSetOptions): Promise<WriteReceipt>
  /** Revoke a REDIRECT by its attestation UID (via `efs.eas.revoke`, REDIRECT schema). */
  remove(redirectUID: Hex): Promise<Hex>
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
  /** Revoke a UID under a schema (wired to `efs.eas.revoke`). */
  readonly revoke: (schema: Hex, uid: Hex) => Promise<Hex>
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
      return submitEdgePlan(plan, deps.submitContext())
    },

    remove: async (redirectUID) => {
      const dep = deps.getDeployment()
      return deps.revoke(dep.schemas.redirect, redirectUID)
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
