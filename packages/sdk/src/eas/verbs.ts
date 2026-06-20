/**
 * `efs.eas.*` raw EAS verbs — the imperative escape hatch over the connected
 * wallet/public client (P1-4). The existing `eas` namespace already exposes the
 * *pure* tools (encoder / computeUID / verifyUID / attestationsFor builders); this
 * adds the four verbs that actually touch the chain:
 *
 *   - `attest` / `multiAttest` / `revoke` — writes, gated on a wallet (mirrors the
 *     SDK's `WalletRequired` type-gate; the runtime guard is the backstop).
 *   - `getAttestation` — a read, available always.
 *
 * Every call routes through {@link classifyError} (ADR-0007) so an EAS revert or
 * an RPC failure surfaces as a typed `EfsError`, never a raw viem/RPC string —
 * identical to the rest of the SDK's chain surface. The request builders
 * (`buildAttest`/`buildMultiAttest`) compute the payable `value` and shape the
 * args; these verbs add execution (wallet + account/chain) on top of them.
 */

import type { Account, Address, Chain, Hex } from 'viem'
import { classifyError } from '../errors.js'
import type { Attestation } from '../types.js'
import { easAbi } from './abi.js'
import {
  type AttestationRequest,
  type MultiAttestationRequest,
  buildAttest,
  buildMultiAttest,
} from './attest.js'

/** `RevocationRequest` (IEAS.sol): the schema the target was attested under, plus
 * the target UID and an optional resolver `value` (`0n` for EFS schemas). */
export interface RevocationRequest {
  /** The schema UID the attestation being revoked was created under. */
  schema: Hex
  /** The UID of the attestation to revoke. */
  uid: Hex
  /** Explicit ETH forwarded to a payable resolver's `onRevoke`. Defaults to `0n`. */
  value?: bigint
}

/**
 * The narrow viem wallet surface the write verbs need: `writeContract` over the
 * vendored `easAbi`. Structurally satisfied by a viem `WalletClient`; kept narrow
 * so the verbs are trivially mockable and don't couple to the full client type.
 */
export interface EasWalletClient {
  writeContract(args: {
    address: Address
    abi: typeof easAbi
    functionName: 'attest' | 'multiAttest' | 'revoke'
    args: readonly unknown[]
    value?: bigint
    account?: Account | Address | undefined
    chain?: Chain | undefined
  }): Promise<Hex>
}

/** The narrow viem public surface the read verb needs: a typed `readContract`. */
export interface EasPublicClient {
  readContract(args: {
    address: Address
    abi: typeof easAbi
    functionName: 'getAttestation'
    args: readonly [Hex]
  }): Promise<unknown>
}

/** Everything the verbs operate over: the EAS address + the clients + account/chain. */
export interface EasVerbContext {
  /** The EAS contract address from the resolved deployment. */
  easAddress: Address
  /** Read client (always present). */
  publicClient: EasPublicClient
  /** Write client — `undefined` on a read-only client (gates the write verbs). */
  walletClient: EasWalletClient | undefined
  /** Throws {@link WalletRequired} when no wallet is set (the runtime backstop). */
  requireWallet(): void
  /** The signing account, forwarded to `writeContract` when set. */
  account?: Account | Address
  /** The chain, forwarded to `writeContract` when set. */
  chain?: Chain
}

/** The `efs.eas.*` verb surface added to the namespace (the four raw EAS verbs). */
export interface EasVerbs {
  /** Submit one `attest` over the wallet; returns the tx hash. Requires a wallet. */
  attest(request: AttestationRequest): Promise<Hex>
  /** Submit one `multiAttest` (grouped by schema); returns the tx hash. Requires a wallet. */
  multiAttest(requests: readonly MultiAttestationRequest[]): Promise<Hex>
  /** Revoke an attestation (only the original attester may); tx hash. Requires a wallet. */
  revoke(request: RevocationRequest): Promise<Hex>
  /** Read one `getAttestation(uid)`; `undefined` when the UID is absent (zero record). */
  getAttestation(uid: Hex): Promise<Attestation | undefined>
}

const ZERO_UID = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

/** Shared write-tx options (account/chain) forwarded to `writeContract` when set. */
function txExtras(ctx: EasVerbContext): { account?: Account | Address; chain?: Chain } {
  return {
    ...(ctx.account !== undefined ? { account: ctx.account } : {}),
    ...(ctx.chain !== undefined ? { chain: ctx.chain } : {}),
  }
}

/** Build the raw `Attestation` view from viem's decoded `getAttestation` tuple. */
function toAttestation(raw: {
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
}): Attestation {
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

/** Construct the `efs.eas.*` verb implementations bound to a context. */
export function makeEasVerbs(ctx: EasVerbContext): EasVerbs {
  return {
    attest: async (request) => {
      ctx.requireWallet()
      const wallet = ctx.walletClient as EasWalletClient
      try {
        const call = buildAttest(ctx.easAddress, request)
        return await wallet.writeContract({
          address: call.address,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args,
          value: call.value,
          ...txExtras(ctx),
        })
      } catch (err) {
        throw classifyError(err)
      }
    },
    multiAttest: async (requests) => {
      ctx.requireWallet()
      const wallet = ctx.walletClient as EasWalletClient
      try {
        const call = buildMultiAttest(ctx.easAddress, requests)
        return await wallet.writeContract({
          address: call.address,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args,
          value: call.value,
          ...txExtras(ctx),
        })
      } catch (err) {
        throw classifyError(err)
      }
    },
    revoke: async (request) => {
      ctx.requireWallet()
      const wallet = ctx.walletClient as EasWalletClient
      try {
        return await wallet.writeContract({
          address: ctx.easAddress,
          abi: easAbi,
          functionName: 'revoke',
          args: [
            { schema: request.schema, data: { uid: request.uid, value: request.value ?? 0n } },
          ] as const,
          value: request.value ?? 0n,
          ...txExtras(ctx),
        })
      } catch (err) {
        throw classifyError(err)
      }
    },
    getAttestation: async (uid) => {
      if (uid === ZERO_UID) return undefined
      try {
        const raw = (await ctx.publicClient.readContract({
          address: ctx.easAddress,
          abi: easAbi,
          functionName: 'getAttestation',
          args: [uid],
        })) as Parameters<typeof toAttestation>[0]
        if (raw.uid === ZERO_UID) return undefined
        return toAttestation(raw)
      } catch (err) {
        throw classifyError(err)
      }
    },
  }
}
