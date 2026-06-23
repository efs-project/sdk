/**
 * `efs.redirects.*` — the REDIRECT (alias) primitive (ADR-0050): the trust-scoped
 * "this points at that" edge for canonical/dedup (`sameAs`), version supersession
 * (`supersededBy`), and path symlinks (`symlink`).
 *
 *  - `set(from, to, { kind? })` → {@link WriteReceipt} — author a REDIRECT
 *    `(refUID = from, data = (to, kind))` as the connected wallet (ONE signature).
 *    `kind` defaults to `sameAs` (0). REDIRECT is NOT cardinality-1 (unlike PIN): a
 *    source may carry several active redirects, so `set` does NOT auto-supersede a
 *    prior one — replacement is `set` the new + `remove` the old. The AliasResolver
 *    enforces no-self-loop + per-kind endpoint typing on-chain; a violation surfaces
 *    as a typed `ContractReverted` at submit (the SDK does not pre-read endpoint
 *    schemas — the resolver is authoritative and reads cost gas on the write path).
 *  - `remove(redirectUID)` → `Hex` — revoke a REDIRECT by its own UID (via
 *    `efs.eas.revoke`, REDIRECT schema; REDIRECT is revocable per ADR-0050).
 *  - `get(from, { lens? })` → {@link RedirectRecord} | undefined — the active redirect
 *    FROM `from` under the lens (first-attester-wins, revoked excluded). NOT a chain
 *    walk and NOT kind-filtered — it surfaces the literal record (any kind, including
 *    the never-auto-followed `relatedVersion`). To FOLLOW a chain to its target, use
 *    `efs.fs.locate(path, { followRedirects: true })`.
 *
 * Writes route through the SAME Submitter seam as `fs.write`/`graph.*`
 * (`submitEdgePlan`); the read reuses the lens-scoped referencing index.
 */

import type { Address, Hex } from 'viem'
import type { EfsDeployment } from '../chain/deployments.js'
import { EfsError } from '../errors.js'
import { type ReadContext, resolveAttesters } from '../reads/context.js'
import { readActiveRedirect } from '../reads/redirects.js'
import type { ReadOptions, RedirectKind, RedirectRecord, WriteReceipt } from '../types.js'
import { type EdgeSubmitContext, submitEdgePlan } from './edge-submit.js'
import { REDIRECT_KIND, buildRedirectPlan } from './edge.js'

/** Options for a `redirects.set`. */
export interface RedirectSetOptions {
  /** The redirect class (ADR-0050). A name (`'sameAs'`/`'supersededBy'`/`'symlink'`/
   * `'relatedVersion'`) or a raw `uint16` code for a reserved kind. Default `'sameAs'`. */
  kind?: RedirectKind | number
}

/** Options for a `redirects.get` (lens-scoped, like the other reads). */
export type RedirectGetOptions = Pick<ReadOptions, 'lens'>

/** The `efs.redirects.*` write+read surface (present only on a write-capable client). */
export interface RedirectsNs {
  /** Author a REDIRECT from `from` to `to` (one signature). `kind` defaults to
   * `'sameAs'`. Does NOT supersede a prior redirect from the same source. */
  set(from: Hex, to: Hex, opts?: RedirectSetOptions): Promise<WriteReceipt>
  /** Revoke a REDIRECT by its attestation UID (via `efs.eas.revoke`, REDIRECT schema). */
  remove(redirectUID: Hex): Promise<Hex>
  /** The active redirect FROM `from` under the lens — the literal record (any kind),
   * or `undefined` when no lens member asserts one. Not a chain walk. */
  get(from: Hex, opts?: RedirectGetOptions): Promise<RedirectRecord | undefined>
}

/** Dependencies the `redirects` namespace binds to (built once by the client). */
export interface RedirectsNsDeps {
  readonly getDeployment: () => EfsDeployment
  /** The lens-scoped read context (for `get`). */
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
      // Literal record (any kind, not chain-followed): requireFollowable stays false.
      return readActiveRedirect(ctx, from, attesters)
    },
  }
}
