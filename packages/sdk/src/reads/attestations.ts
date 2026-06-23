/**
 * Batched attestation hydration — backs `efs.eas.attestationsFor(items)` and the
 * per-field `expand:['attestations']` hydrate on `info`/`read` (sdk-read-surface
 * §Trust escalation).
 *
 * ## Why Promise.all, not viem's `multicall()`
 *
 * The design specifies "one multicall of `eas.getAttestation(uid)` over many items,
 * `allowFailure:true`". The SDK's narrow read surface ({@link ReadPublicClient}) is
 * a typed `readContract` only — and the SDK-constructed public client sets
 * `batch:{ multicall:true }`, so concurrent `readContract`s fired in the SAME TICK
 * are coalesced by viem into one Multicall3 `aggregate3` automatically (principle 5:
 * same-tick concurrency is the correctness requirement). We therefore fan out via
 * `Promise.allSettled` — a revoked/absent UID rejects per-item (degraded), never
 * failing the whole batch — which is exactly viem's `allowFailure:true` posture
 * without coupling to the wider `multicall()` client method. On a user-supplied
 * client without `batch:{multicall:true}` these still resolve correctly, just not
 * coalesced (documented caveat).
 */

import type { Address, Hex } from 'viem'
import { schemaRegistryAbi } from '../eas/abi.js'
import { easAbi } from '../eas/abi.js'
import type { Attestation, SchemaRecord } from '../types.js'
import { type ReadContext, ZERO_UID, read } from './context.js'

/** A revoked attestation has a non-zero `revocationTime`. */
export function isRevoked(att: Attestation): boolean {
  return att.revocationTime > 0n
}

/** An absent attestation reads back as the zero record (`uid === bytes32(0)`). */
export function isAbsent(att: Attestation): boolean {
  return att.uid === ZERO_UID
}

/** The raw `getAttestation` tuple as viem decodes it. */
type RawAttestation = {
  uid: Hex
  schema: Hex
  time: bigint
  expirationTime: bigint
  revocationTime: bigint
  refUID: Hex
  recipient: Address
  attester: Address
  revocable: boolean
  data: Hex
}

function toAttestation(raw: RawAttestation): Attestation {
  return {
    uid: raw.uid,
    schema: raw.schema,
    time: raw.time,
    expirationTime: raw.expirationTime,
    revocationTime: raw.revocationTime,
    refUID: raw.refUID,
    recipient: raw.recipient,
    attester: raw.attester,
    revocable: raw.revocable,
    data: raw.data,
  }
}

/** Fetch one attestation record by UID, or `undefined` if the UID is zero/absent. */
export async function attestationFor(
  ctx: ReadContext,
  uid: Hex,
  opts?: { withSchema?: boolean },
): Promise<Attestation | undefined> {
  if (uid === ZERO_UID) return undefined
  const raw = await read<RawAttestation>(ctx.publicClient, {
    address: ctx.deployment.contracts.eas,
    abi: easAbi,
    functionName: 'getAttestation',
    args: [uid],
  })
  if (raw.uid === ZERO_UID) return undefined
  const att = toAttestation(raw)
  if (opts?.withSchema && att.schema !== ZERO_UID) {
    const schemaRecord = await schemaRecordFor(ctx, att.schema)
    if (schemaRecord !== undefined) att.schemaRecord = schemaRecord
  }
  return att
}

/** Resolve the schema record behind an attestation (depth-2 `attestations.schema`). */
async function schemaRecordFor(
  ctx: ReadContext,
  schemaUID: Hex,
): Promise<SchemaRecord | undefined> {
  try {
    const raw = await read<{
      uid: Hex
      resolver: Address
      revocable: boolean
      schema: string
    }>(ctx.publicClient, {
      address: ctx.deployment.contracts.schemaRegistry,
      abi: schemaRegistryAbi,
      functionName: 'getSchema',
      args: [schemaUID],
    })
    return { uid: raw.uid, resolver: raw.resolver, revocable: raw.revocable, schema: raw.schema }
  } catch {
    return undefined
  }
}

/**
 * Hydrate many attestation UIDs in one coalesced batch (positional — result `[i]`
 * maps to `uids[i]`). A revoked/absent/failing UID degrades to `undefined` for that
 * slot (`allowFailure:true` posture), never throwing the whole batch — EXCEPT a
 * systemic `WrongChain` rejection, which escapes (see below).
 */
export async function attestationsForUIDs(
  ctx: ReadContext,
  uids: readonly Hex[],
  opts?: { withSchema?: boolean },
): Promise<(Attestation | undefined)[]> {
  const settled = await Promise.allSettled(uids.map((uid) => attestationFor(ctx, uid, opts)))
  // A `WrongChain` rejection is SYSTEMIC, not per-UID degradation: the chain-guarded read
  // client fails closed when the provider drifted after `readContext()` resolved. Swallowing
  // it to `undefined` would hand the caller empty/missing attestations that look like genuine
  // absence — the opposite of fail-closed. Re-throw it; only true per-UID
  // absence/revocation/transient-read failures degrade to `undefined`.
  const wrongChain = settled.find(
    (s): s is PromiseRejectedResult =>
      s.status === 'rejected' && (s.reason as { code?: string } | undefined)?.code === 'WrongChain',
  )
  if (wrongChain) throw wrongChain.reason
  return settled.map((s) => (s.status === 'fulfilled' ? s.value : undefined))
}

/** An item carrying source UIDs that {@link attestationsFor} can hydrate over. */
export type HasSourceUIDs = {
  sourceUIDs?: Record<string, Hex | undefined>
  ref?: { uid?: Hex }
  dataUID?: Hex
  anchorUID?: Hex
}

/** A per-item hydrated result: the item's source UIDs resolved to attestation
 * records (degraded per-item; absent/revoked → `undefined`). */
export type HydratedItem = {
  attestations: Record<string, Attestation | undefined>
}

/**
 * `efs.eas.attestationsFor(items)` — batched hydrate (sdk-read-surface §Trust
 * escalation). Collects every source UID across the items and resolves them in ONE
 * coalesced batch (`Promise.all` → multicall under the SDK-constructed client),
 * `allowFailure`-style per-item. Returns a parallel array: `result[i].attestations`
 * maps each of item `i`'s source-UID keys to its hydrated record (or `undefined`
 * when revoked/absent — degraded, not thrown). This also backs
 * `expand:['attestations']` at request time.
 */
export async function attestationsFor(
  ctx: ReadContext,
  items: readonly HasSourceUIDs[],
  opts?: { withSchema?: boolean },
): Promise<HydratedItem[]> {
  // Flatten every (itemIndex, key, uid) so the whole set fans out in one tick. Collect BOTH
  // the explicit `sourceUIDs` bag AND the top-level UID fields `HasSourceUIDs` accepts
  // (`ref.uid` / `dataUID` / `anchorUID`) — so a `DirEntry`/`DataRef` DTO that carries only
  // those (no bag) still hydrates instead of returning an empty map. The bag wins on a key
  // collision (file bags use `placement`/`contentType`/`size`/`contentHash`/`name`, so the
  // synthesized `data`/`anchor` keys are additive in practice).
  const flat: { item: number; key: string; uid: Hex }[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item) continue
    const bag: Record<string, Hex | undefined> = { ...item.sourceUIDs }
    // `ref.uid` and `dataUID` both name the DATA attestation → key `data`; `anchorUID` → `anchor`.
    if (item.ref?.uid !== undefined && bag.data === undefined) bag.data = item.ref.uid
    if (item.dataUID !== undefined && bag.data === undefined) bag.data = item.dataUID
    if (item.anchorUID !== undefined && bag.anchor === undefined) bag.anchor = item.anchorUID
    for (const [key, uid] of Object.entries(bag)) {
      if (uid !== undefined && uid !== ZERO_UID) flat.push({ item: i, key, uid })
    }
  }

  const hydrated = await attestationsForUIDs(
    ctx,
    flat.map((f) => f.uid),
    opts,
  )

  const out: HydratedItem[] = items.map(() => ({ attestations: {} }))
  flat.forEach((f, i) => {
    const slot = out[f.item]
    if (slot) slot.attestations[f.key] = hydrated[i]
  })
  return out
}
