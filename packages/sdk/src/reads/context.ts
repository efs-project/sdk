/**
 * Shared plumbing for the lens-scoped read verbs (`resolve` / `stat` / `read` /
 * `fetch` / `list`).
 *
 * ## Lens-scoping (core to EFS, ADR-0013/0014/0031/0053)
 *
 * Every read resolves through an **attester/lens** — an ordered set of attester
 * addresses, first-attester-wins. The on-chain views (`EFSFileView.getFilesAtPath`,
 * the directory pages, the per-attester PROPERTY/MIRROR reads) all take that
 * ordered `address[]` and return the *winning* attester's placement. There is no
 * "global" view: a file only exists relative to the lens you read through.
 *
 * The lens defaults, in order:
 *   1. `opts.lens` (a {@link Lens} or a raw `Address` treated as a literal lens);
 *   2. the SDK client's `defaultLens` (config);
 *   3. the connected wallet account (a single-address literal lens).
 * If none of those yields an attester, the read throws {@link LensRequired} — a
 * read with no attester to resolve against is meaningless, never a silent empty.
 *
 * ## Reads exclude revoked (ADR-0051)
 *
 * The view reads we call already drop revoked attestations (`getActivePinTarget`
 * reads the active slot; `getDataMirrors`/`getFilesAtPath` pass `showRevoked=false`).
 * We never set `showRevoked=true` on a read path.
 *
 * ## contentHash verification is trust-relative (ADR-0006, review A2)
 *
 * The `contentHash` we verify fetched bytes against is the one attested *by the
 * winning lens attester* (`resolvedBy`) — read via the reserved-key PROPERTY,
 * scoped to that exact attester. It is NOT absolute integrity; it is "do these
 * bytes match what the attester I trust claimed".
 */

import type { Abi, Address, Hex } from 'viem'
import { decodeAbiParameters } from 'viem'
import type { EfsDeployment } from '../chain/deployments.js'
import { classifyError } from '../errors.js'
import { LensRequired } from '../errors.js'
import { type Lens, resolveLens } from '../lenses/resolve.js'
import type { ReadOptions } from '../types.js'

/** `bytes32(0)` — the kernel's "empty slot" sentinel (mirrors `reads/resolve.ts`). */
export const ZERO_UID = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

/**
 * The minimal viem public surface the read verbs need: a typed `readContract`.
 * Structurally satisfied by a viem `PublicClient`; kept wide on the ABI so any of
 * the vendored read ABIs can be passed, and trivially mockable in tests.
 */
export interface ReadPublicClient {
  readContract(args: {
    address: Address
    abi: Abi
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
  getEnsAddress?(args: { name: string }): Promise<Address | null>
  /** Read a contract's deployed bytecode — used by the `web3://` (SSTORE2) read
   * transport to code-copy each chunk. Optional on the structural type (mocks may
   * omit it); a real viem `PublicClient` always provides it. */
  getCode?(args: { address: Address }): Promise<Hex | undefined>
}

/** Everything a read verb needs, assembled once by the client. */
export type ReadContext = {
  publicClient: ReadPublicClient
  deployment: EfsDeployment
  /** The client's configured default lens (config `defaultLens`), if any. */
  defaultLens?: Lens
  /** The connected wallet account address, if a wallet is set (last-resort lens). */
  account?: Address
}

/**
 * Resolve the effective lens for a read into an ordered, deduped attester set.
 * Tries `opts.lens` → `ctx.defaultLens` → `ctx.account`; throws {@link LensRequired}
 * when none is available. The returned order is load-bearing (first-attester-wins).
 *
 * @throws {LensRequired} when no lens, default lens, or wallet account is present.
 */
export async function resolveAttesters(
  ctx: ReadContext,
  opts: ReadOptions | undefined,
): Promise<readonly Address[]> {
  const input: Lens | Address | undefined = opts?.lens ?? ctx.defaultLens ?? ctx.account
  if (input === undefined) throw new LensRequired()
  try {
    const attesters = await resolveLens(input, { publicClient: ctx.publicClient as never })
    if (attesters.length === 0) throw new LensRequired()
    return attesters
  } catch (err) {
    if (err instanceof LensRequired) throw err
    throw classifyError(err)
  }
}

/**
 * Run a single `readContract` through the {@link classifyError} funnel (ADR-0007):
 * every viem read failure surfaces as a typed `EfsError`, never a raw RPC string.
 */
export async function read<T>(
  client: ReadPublicClient,
  args: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] },
): Promise<T> {
  try {
    return (await client.readContract(args)) as T
  } catch (err) {
    throw classifyError(err)
  }
}

/** The shape `EFSFileView` returns for a directory/path item (the 11-field tuple). */
export type FileSystemItem = {
  uid: Hex
  name: string
  parentUID: Hex
  isFolder: boolean
  hasData: boolean
  childCount: bigint
  propertyCount: bigint
  timestamp: bigint
  attester: Address
  schema: Hex
  contentHash: Hex
}

/** A `DirectoryPage` (`{ items, bytes nextCursor }`). */
export type DirectoryPageRaw = { items: readonly FileSystemItem[]; nextCursor: Hex }

/**
 * Decode a reserved-key PROPERTY `string value` attestation `data` blob. PROPERTY
 * is the frozen `string value` schema (ADR-0052), so the payload is a single
 * ABI-encoded string. Empty/`0x` data → `undefined`.
 */
export function decodePropertyValue(data: Hex): string | undefined {
  if (data === undefined || data === '0x' || data.length <= 2) return undefined
  try {
    const [value] = decodeAbiParameters([{ type: 'string' }], data) as [string]
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}
