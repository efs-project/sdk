/**
 * `efs.graph.tags` — the standalone **TAG** edge primitive (add / remove / read).
 *
 * A TAG is a cardinality-N edge `TAG(definition, refUID = target, weight)` from the
 * connected attester to a `target` attestation/anchor under a `definition` predicate
 * (EdgeResolver.sol; ADR-0041). It is the same shape the file-write DAG emits for
 * folder visibility (`TAG(definition = DATA_SCHEMA_UID, refUID = folderAnchor,
 * weight = 1)`) — here exposed generically.
 *
 *  - `add(target, definition, { weight? })` — author one TAG (one signature). The
 *    `definition` may be a TAG-definition UID (`0x…`, 32-byte) or a `/tags/<name>`
 *    label the SDK resolves to its definition anchor UID via the indexer.
 *  - `remove(tagUID)` — revoke a TAG (through `efs.eas.revoke`, the TAG schema).
 *  - `active(attester, target, definition)` — read the active TAG weight at a slot
 *    (`getActiveTagWeight`), revoked excluded.
 *  - `list(target, { lens })` — the active TAGs the lens attester(s) placed on a
 *    target, with weights (`getActiveTagEntries`).
 *
 * The writes route through the SAME Submitter seam as `fs.write` (`submitEdgePlan` →
 * `submitLayeredTier1`); the reads reuse the vendored `EdgeResolver` ABI.
 */

import type { Address, Hex } from 'viem'
import { edgeResolverAbi } from '../chain/abi/edgeResolver.js'
import type { EfsDeployment } from '../chain/deployments.js'
import { EfsError } from '../errors.js'
import { read } from '../reads/context.js'
import type { ReadPublicClient } from '../reads/context.js'
import { type ResolvePublicClient, resolvePathToAnchor } from '../reads/resolve.js'
import type { WriteReceipt } from '../types.js'
import { type EdgeSubmitContext, submitEdgePlan } from './edge-submit.js'
import { buildTagPlan } from './edge.js'

/** Options for {@link TagsNs.add}. */
export interface TagAddOptions {
  /** The `int256` TAG weight; defaults to 1 (ADR-0041 §4 — weight is generic
   * per-entry metadata, irrelevant to whether the TAG is active). */
  weight?: bigint
}

/** Options for the TAG read verbs (lens-scoped). */
export interface TagListOptions {
  /** The attester(s) whose TAGs to read. A single `Address` (the common case) or an
   * ordered list. Defaults to the connected attester. */
  lens?: Address | readonly Address[]
  /** The target attestation's own schema UID — the slot's `targetSchema`
   * (`_activeByAAS[definition][attester][targetSchema]`, set in `onAttest` from the
   * target's schema). Defaults to the ANCHOR schema (the common case: the target is
   * a file/folder anchor). Pass the target's actual schema UID for a TAG on a
   * non-anchor attestation. */
  targetSchema?: Hex
}

/** One active TAG on a target, scoped to the attester who placed it. */
export interface ActiveTag {
  /** The attester whose active TAG this is. */
  attester: Address
  /** The raw `int256` weight stored on the TAG. */
  weight: bigint
}

/** A 32-byte hex UID (`0x` + 64 hex) vs. a `/tags/<name>` label. */
function isUID(s: string): s is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(s)
}

/**
 * Resolve a TAG `definition` argument to a concrete definition UID: a 32-byte hex
 * UID passes through; a `/tags/<name>` (or bare `name`) label is resolved to its
 * `/tags/<name>` anchor UID via the indexer path walk.
 *
 * @throws {EfsError} (`InvalidArgument`) when a label resolves to no anchor.
 */
export async function resolveTagDefinition(
  publicClient: ResolvePublicClient,
  indexer: Address,
  definition: Hex | string,
): Promise<Hex> {
  if (isUID(definition)) return definition
  // A label: `/tags/<name>`, `tags/<name>`, or a bare `<name>` (→ `/tags/<name>`).
  const path = definition.startsWith('/tags/')
    ? definition
    : definition.startsWith('tags/')
      ? `/${definition}`
      : `/tags/${definition.replace(/^\/+/, '')}`
  const uid = await resolvePathToAnchor(publicClient, indexer, path)
  return uid
}

/** The `efs.graph.tags` write+read surface (present only on a write-capable client). */
export interface TagsNs {
  /** Author one TAG edge from the connected attester to `target` under `definition`
   * (a definition UID or a `/tags/<name>` label). One signature. */
  add(target: Hex, definition: Hex | string, opts?: TagAddOptions): Promise<WriteReceipt>
  /** Revoke a TAG by its attestation UID (via `efs.eas.revoke`, TAG schema). */
  remove(tagUID: Hex): Promise<Hex>
  /** The active TAG weight at `(attester, target, definition)` — `undefined` when no
   * active TAG. `definition` accepts a UID or a `/tags/<name>` label; `targetSchema`
   * defaults to the ANCHOR schema (see {@link TagListOptions.targetSchema}). */
  active(
    attester: Address,
    target: Hex,
    definition: Hex | string,
    opts?: { targetSchema?: Hex },
  ): Promise<{ weight: bigint } | undefined>
  /** The active TAGs on `target` under `definition`, one per lens attester that has
   * one (built over `getActiveTagWeight`; revoked excluded). `definition` accepts a
   * UID or a `/tags/<name>` label; `lens` defaults to the connected attester. */
  list(target: Hex, definition: Hex | string, opts?: TagListOptions): Promise<ActiveTag[]>
}

/** Dependencies the `tags` namespace binds to (built once by the client). */
export interface TagsNsDeps {
  readonly getDeployment: () => EfsDeployment
  /** Resolve the deployment from the LIVE provider chain for READ methods (a mutable
   * provider can switch chains after construction; reads go to the current chain). Falls
   * back to {@link TagsNsDeps.getDeployment} when omitted (unit tests). Write methods keep
   * `getDeployment` (aligned with the wallet/submit chain guard). */
  readonly liveDeployment?: () => EfsDeployment | Promise<EfsDeployment>
  readonly publicClient: ReadPublicClient
  /** Wrap {@link TagsNsDeps.publicClient} with a guard pinned to the LIVE-resolved deployment
   * chain, so `active`/`list` fail closed (`WrongChain`) if the provider drifts between
   * `liveDeployment()` and the reads (TOCTOU). Falls back to the unguarded client when omitted. */
  readonly guardReadClient?: (chainId: number) => ReadPublicClient
  /** Build the submit context (wallet/public clients + EAS addr + attester). */
  readonly submitContext: () => EdgeSubmitContext
  /** The connected attester (default lens for reads). */
  readonly attester: () => Address | undefined
  /** Revoke a UID under a schema (wired to `efs.eas.revoke`). */
  readonly revoke: (schema: Hex, uid: Hex) => Promise<Hex>
}

/** Construct the `efs.graph.tags` namespace bound to a client's deps. */
export function makeTagsNs(deps: TagsNsDeps): TagsNs {
  const lensList = (lens: TagListOptions['lens']): readonly Address[] => {
    if (lens === undefined) {
      const me = deps.attester()
      if (me === undefined)
        throw new EfsError('efs.graph.tags: no lens supplied and no connected attester.', {
          code: 'LensRequired',
        })
      return [me]
    }
    return typeof lens === 'string' ? [lens] : lens
  }

  return {
    add: async (target, definition, opts) => {
      const ctx = deps.submitContext()
      // Fail closed BEFORE the definition-resolution read — it FEEDS the plan, so a drifted
      // public client could resolve the tag definition on the wrong chain and poison the
      // plan with a UID absent on the deployment chain. Same guard the submit runs per layer.
      await ctx.assertChain?.()
      const dep = deps.getDeployment()
      // The multi-RPC /tags/<name> walk goes through the drift-GUARDED client
      // (same as every other planner): `assertChain` above samples ONCE, so a
      // mutable provider could switch chains mid-walk and resolve a chain-B
      // definition UID that poisons the chain-A plan (revert, or on a UID
      // collision, tagging the wrong definition). The guard re-asserts the
      // live chain around each read.
      const pc = deps.guardReadClient?.(dep.chainId) ?? deps.publicClient
      const definitionUID = await resolveTagDefinition(
        pc as unknown as ResolvePublicClient,
        dep.contracts.indexer,
        definition,
      )
      const plan = buildTagPlan(dep.schemas, target, definitionUID, opts?.weight)
      return submitEdgePlan(plan, ctx)
    },

    remove: async (tagUID) => {
      const dep = deps.getDeployment()
      return deps.revoke(dep.schemas.tag, tagUID)
    },

    active: async (attester, target, definition, opts) => {
      const dep = await (deps.liveDeployment ?? deps.getDeployment)()
      // Guard against a chain switch between resolving `dep` and the reads below (TOCTOU).
      const pc = deps.guardReadClient?.(dep.chainId) ?? deps.publicClient
      const definitionUID = await resolveTagDefinition(
        pc as unknown as ResolvePublicClient,
        dep.contracts.indexer,
        definition,
      )
      const targetSchema = opts?.targetSchema ?? dep.schemas.anchor
      const [exists, weight] = await read<readonly [boolean, bigint]>(pc, {
        address: dep.contracts.edgeResolver,
        abi: edgeResolverAbi,
        functionName: 'getActiveTagWeight',
        // (attester, target, definition, targetSchema) — see edgeResolver ABI note.
        args: [attester, target, definitionUID, targetSchema],
      })
      return exists ? { weight } : undefined
    },

    list: async (target, definition, opts) => {
      const dep = await (deps.liveDeployment ?? deps.getDeployment)()
      // Guard against a chain switch between resolving `dep` and the reads below (TOCTOU).
      const pc = deps.guardReadClient?.(dep.chainId) ?? deps.publicClient
      const definitionUID = await resolveTagDefinition(
        pc as unknown as ResolvePublicClient,
        dep.contracts.indexer,
        definition,
      )
      const attesters = lensList(opts?.lens)
      const targetSchema = opts?.targetSchema ?? dep.schemas.anchor
      // One active-weight read per lens attester (independent → multicall coalescing).
      // TAGs are cardinality-N, so there is no first-wins truncation: every attester
      // with an active TAG on this (target, definition) slot is returned.
      const results = await Promise.all(
        attesters.map(async (attester) => {
          const [exists, weight] = await read<readonly [boolean, bigint]>(pc, {
            address: dep.contracts.edgeResolver,
            abi: edgeResolverAbi,
            functionName: 'getActiveTagWeight',
            args: [attester, target, definitionUID, targetSchema],
          })
          return exists ? { attester, weight } : undefined
        }),
      )
      return results.filter((r): r is ActiveTag => r !== undefined)
    },
  }
}
