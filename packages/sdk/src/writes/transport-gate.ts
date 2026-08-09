/**
 * The MIRROR transport-anchor predicate, shared by every write path that can
 * publish a MIRROR (r3741671356 / r3741715493).
 *
 * `MirrorResolver.onAttest` accepts a `transportDefinition` only when it is an
 * ANCHOR attestation descending from the `/transports/` anchor (within
 * `MAX_TRANSPORT_DEPTH`), reverting `InvalidTransport` otherwise — and it does
 * so at the MIRROR layer, i.e. AFTER the DATA layer has mined and (on the
 * auto-store path) after the irreversible chunk + manager deploys are paid for.
 * Both write paths therefore run this check FIRST:
 *
 *  - `writes/file.ts` before `storeOnchain` (no orphaned paid storage);
 *  - `submitLayeredTier1` before layer 1 (no paid partial graph) — the backstop
 *    for the exported builder + executor pair.
 *
 * Parents are walked through each ANCHOR's `refUID` — the same parent edge
 * `EFSIndexer.getParent` reports — so no extra ABI fragment is needed. The
 * common single-hop `/transports/<scheme>` case costs one read per distinct
 * definition plus two to resolve the root once.
 */

import type { Address, Hex } from 'viem'
import { resolvePathAbi, rootAnchorUidAbi } from '../chain/abi/indexer.js'
import { getAttestationAbi } from '../eas/abi.js'
import { EfsError } from '../errors.js'

/** Mirrors `MirrorResolver.MAX_TRANSPORT_DEPTH`. */
export const MAX_TRANSPORT_DEPTH = 8

/** The minimal read surface the check needs (a viem `PublicClient` satisfies it). */
export type TransportGateClient = {
  readContract(args: {
    address: Address
    abi: unknown
    functionName: string
    args: readonly unknown[]
  }): Promise<unknown>
}

/**
 * Throw unless every `definition` is an ANCHOR under `/transports/`.
 * @throws {EfsError} `InvalidArgument` naming the offending definition.
 */
export async function assertTransportAnchors(
  client: TransportGateClient,
  addresses: { eas: Address; indexer: Address },
  anchorSchemaUID: Hex,
  definitions: readonly Hex[],
): Promise<void> {
  if (definitions.length === 0) return
  const attestationOf = (uid: Hex) =>
    client.readContract({
      address: addresses.eas,
      abi: getAttestationAbi,
      functionName: 'getAttestation',
      args: [uid],
    }) as Promise<{ schema?: Hex; refUID?: Hex } | undefined>

  const rootAnchor = (await client.readContract({
    address: addresses.indexer,
    abi: rootAnchorUidAbi,
    functionName: 'rootAnchorUID',
    args: [],
  })) as Hex
  const transportsRoot = (await client.readContract({
    address: addresses.indexer,
    abi: resolvePathAbi,
    functionName: 'resolvePath',
    args: [rootAnchor, 'transports'],
  })) as Hex

  const ZERO = `0x${'0'.repeat(64)}` as Hex
  for (const def of new Set(definitions)) {
    const att = await attestationOf(def)
    if (att?.schema === undefined || att.schema.toLowerCase() !== anchorSchemaUID.toLowerCase()) {
      throw new EfsError(
        `EFS write: mirror transportDefinition ${def} is not an ANCHOR attestation (schema ${att?.schema ?? 'unknown'}) — MirrorResolver rejects it (InvalidTransport), after irreversible work has already been paid for.`,
        { code: 'InvalidArgument' },
      )
    }
    let parent = att.refUID
    let ok = false
    for (let depth = 0; depth < MAX_TRANSPORT_DEPTH; depth++) {
      if (parent === undefined || parent === ZERO) break
      if (parent.toLowerCase() === transportsRoot.toLowerCase()) {
        ok = true
        break
      }
      parent = (await attestationOf(parent))?.refUID
    }
    if (!ok) {
      throw new EfsError(
        `EFS write: mirror transportDefinition ${def} is not a descendant of /transports/ — MirrorResolver rejects it (InvalidTransport), after irreversible work has already been paid for. Use the deployment's transports map or the /transports/<scheme> anchor.`,
        { code: 'InvalidArgument' },
      )
    }
  }
}
