/**
 * `efs.lists` write surface — the curated-collection (LIST) write primitives
 * (create / add / remove), pairing the `efs.lists` read surface (`get`/`entries`/
 * `length`/`has`, `reads/lists.ts`). A LIST is a curator-owned collection of targets
 * (addresses, attestation UIDs of one schema, or opaque member keys); entries are
 * per-attester (open curation), revocable or append-only, deduped per the list's
 * `allowsDuplicates` rule (ADR-0044/0046/0047).
 *
 *  - `create(config)` → `WriteReceipt & { listUID }` — mint a non-revocable, free-
 *    floating LIST. Validates the ListResolver invariants client-side BEFORE submit
 *    (targetType bound, SCHEMA-mode targetSchema rule, appendOnly+duplicates cap), so
 *    a bad config throws {@link InvalidListConfig} rather than reverting on-chain. One
 *    signature. Mirrors `EFSLib.createList`.
 *  - `add(listUID, target, opts?)` → `WriteReceipt` — add a LIST_ENTRY, routed by the
 *    list's `targetType` (read once via `lists.get`, or pass `{ targetType }` to skip
 *    the read). ANY/SCHEMA → `abi.encode(listUID, target)` (recipient 0); ADDR → the
 *    member address in `recipient`, payload `abi.encode(listUID, bytes32(0))`. Target
 *    shape is validated vs mode before submit. One signature. Mirrors
 *    `EFSLib.addEntry` / `addAddressEntry`.
 *  - `remove(entryUID)` → `Hex` — revoke a LIST_ENTRY via `efs.eas.revoke` (the
 *    listEntry schema). Rejects up front (typed {@link ListAppendOnly}, no chain
 *    round-trip) when the list is append-only — but only when the SDK can cheaply
 *    learn the owning list (an explicit `{ listUID }` hint, since a bare entryUID
 *    doesn't carry its list without an extra read).
 *
 * Writes route through the SAME Submitter seam as `fs.write` (`submitEdgePlan` /
 * `submitEdgePlanWithUID` → `submitLayeredTier1`); the config read reuses the read
 * engine's `getList`.
 */

import type { Address, Hex } from 'viem'
import type { EfsDeployment } from '../chain/deployments.js'
import { InvalidListConfig, ListAppendOnly, ListNotFound } from '../errors.js'
import type { ReadContext, ReadPublicClient } from '../reads/context.js'
import { getList } from '../reads/lists.js'
import type { ListTargetType, WriteReceipt } from '../types.js'
import { type EdgeSubmitContext, submitEdgePlan, submitEdgePlanWithUID } from './edge-submit.js'
import {
  EDGE_REF,
  type ListCreateConfig,
  buildAddEntryPlan,
  buildCreateListPlan,
  validateAddTarget,
} from './edge.js'

/** Options for {@link ListsWriteNs.add}. */
export interface ListAddOptions {
  /**
   * The owning list's `targetType`, to SKIP the `lists.get` config read (one fewer
   * round-trip). When omitted, `add` reads the list config to learn the mode and
   * route the entry encoding. Pass this when you already know the mode (e.g. you just
   * created the list) — it must match the on-chain config or the resolver reverts.
   */
  targetType?: ListTargetType
}

/** Options for {@link ListsWriteNs.remove}. */
export interface ListRemoveOptions {
  /**
   * The owning LIST UID. Supplied, `remove` reads that list's config and rejects up
   * front with {@link ListAppendOnly} if it is append-only (no chain round-trip).
   * Omitted, the SDK cannot cheaply learn the list from a bare entryUID, so the
   * append-only guard is skipped and the resolver enforces it on-chain (the revoke
   * reverts) — pass this to get the friendly client-side rejection.
   */
  listUID?: Hex
}

/** The `efs.lists` write surface (present only on a write-capable client). The read
 * verbs (`get`/`entries`/`length`/`has`) live on the shared `efs.lists` namespace;
 * these three writes are merged onto it by the client. */
export interface ListsWriteNs {
  /** Mint a LIST and return the receipt plus the new `listUID`. One signature.
   * Throws {@link InvalidListConfig} on an invariant violation (before submit). */
  create(config: ListCreateConfig): Promise<WriteReceipt & { listUID: Hex }>
  /** Add a LIST_ENTRY to `listUID`, routed by the list's `targetType`. One signature.
   * `target` is an `Address` (ADDR lists, incl. `address(0)`) or a nonzero `bytes32`
   * UID/member key (ANY/SCHEMA). Throws {@link InvalidListConfig} on a target/mode
   * mismatch, {@link ListNotFound} if no LIST exists at `listUID`. */
  add(listUID: Hex, target: Address | Hex, opts?: ListAddOptions): Promise<WriteReceipt>
  /** Revoke a LIST_ENTRY by its attestation UID (via `efs.eas.revoke`, listEntry
   * schema). Pass `{ listUID }` to reject an append-only list up front with
   * {@link ListAppendOnly} (no chain round-trip). */
  remove(entryUID: Hex, opts?: ListRemoveOptions): Promise<Hex>
}

/** Dependencies the `lists` write namespace binds to (built once by the client). */
export interface ListsWriteNsDeps {
  readonly getDeployment: () => EfsDeployment
  readonly publicClient: ReadPublicClient
  /** Drift-guarded read client pinned to a chainId (for the `lists.get` config
   * read add/remove plan against — write-planning reads must not follow a
   * drifting provider). */
  readonly guardReadClient?: (chainId: number) => ReadPublicClient
  /** Build the submit context (wallet/public clients + EAS addr + attester). */
  readonly submitContext: () => EdgeSubmitContext
  /** Revoke a UID under a schema (wired to `efs.eas.revoke`). */
  readonly revoke: (schema: Hex, uid: Hex) => Promise<Hex>
}

/** Construct the `efs.lists` write namespace bound to a client's deps. */
export function makeListsWriteNs(deps: ListsWriteNsDeps): ListsWriteNs {
  /** Resolve the list config or throw {@link ListNotFound} (a write against a
   * non-existent list is a caller error). The config read is a WRITE-PLANNING
   * read: it is pinned to the already-selected deployment and its drift-guarded
   * client (like every other planner) — a live readContext() would re-resolve
   * the CURRENT chain, so a provider drifting after add/remove's one-time
   * assertChain could serve a chain-B mode into a chain-A plan (a wrong-mode
   * entry encoding, a false/skipped append-only rejection, or a submit that can
   * only revert). */
  const requireConfig = async (dep: EfsDeployment, listUID: Hex) => {
    const ctx: ReadContext = {
      publicClient: deps.guardReadClient?.(dep.chainId) ?? deps.publicClient,
      deployment: dep,
    }
    const config = await getList(ctx, listUID)
    if (!config.exists) throw new ListNotFound(listUID)
    return config
  }

  return {
    create: async (config) => {
      const dep = deps.getDeployment()
      // buildCreateListPlan validates the invariants (throws InvalidListConfig).
      const plan = buildCreateListPlan(dep.schemas, config)
      const { receipt, uid } = await submitEdgePlanWithUID(
        plan,
        deps.submitContext(),
        EDGE_REF.LIST,
      )
      return { ...receipt, listUID: uid }
    },

    add: async (listUID, target, opts) => {
      const ctx = deps.submitContext()
      // Fail closed BEFORE the config read — when no `targetType` hint is given it reads the
      // list config to route the plan, so a drifted public client could read a different
      // chain's config and build an entry against the wrong mode. Same guard the submit runs.
      await ctx.assertChain?.()
      const dep = deps.getDeployment()
      // Route by targetType: use the explicit hint, else read the list config once.
      const targetType: ListTargetType =
        opts?.targetType ?? (await requireConfig(dep, listUID)).targetType
      // Validate the target shape vs the mode BEFORE submit (throws InvalidListConfig).
      const validated = validateAddTarget(targetType, target)
      const plan = buildAddEntryPlan(dep.schemas, listUID, targetType, validated)
      return submitEdgePlan(plan, ctx)
    },

    remove: async (entryUID, opts) => {
      const dep = deps.getDeployment()
      // When the owning list is known, reject an append-only list up front (no chain
      // round-trip). A bare entryUID doesn't carry its list, so without the hint the
      // resolver enforces append-only on-chain.
      if (opts?.listUID !== undefined) {
        // Guard the advisory config read before the append-only check — a drifted public
        // client could read the wrong chain's config and skip/false-trigger the courtesy
        // throw. The revoke itself is chain-guarded (easVerbs); this keeps the early check
        // honest so it surfaces WrongChain rather than a misleading ListNotFound/AppendOnly.
        await deps.submitContext().assertChain?.()
        const config = await requireConfig(dep, opts.listUID)
        if (config.appendOnly) throw new ListAppendOnly(opts.listUID)
      }
      return deps.revoke(dep.schemas.listEntry, entryUID)
    },
  }
}

export type { ListCreateConfig }
// Re-export so callers can catch the typed list-write errors without a deep import.
export { InvalidListConfig, ListAppendOnly }
