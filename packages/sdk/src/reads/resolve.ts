/**
 * Path resolution against the EFSIndexer kernel — the read the write path needs
 * to find the parent folder anchor a new file's `file-ANCHOR` hangs off of.
 *
 * ## Contract semantics (FROZEN EFSIndexer.sol)
 *
 * The kernel resolves a single path segment via:
 *
 *   `resolvePath(bytes32 parentUID, string name) -> bytes32`
 *     (EFSIndexer.sol:523-525) `=> _nameToAnchor[parentUID][name][bytes32(0)]`.
 *     Looks up the child anchor named `name` under `parentUID` typed as the
 *     **generic** (folder) schema `bytes32(0)`. A folder/generic walk uses this.
 *
 *   `resolveAnchor(bytes32 parentUID, string name, bytes32 schema) -> bytes32`
 *     (EFSIndexer.sol:527-529) `=> _nameToAnchor[parentUID][name][schema]`.
 *     The schema-typed variant — same lookup with an explicit content-type slot.
 *     `resolvePath` is exactly `resolveAnchor(parentUID, name, bytes32(0))`.
 *
 * Both are pure mapping reads: an **empty slot returns `bytes32(0)`** — they do
 * NOT revert on an absent name (verified at EFSIndexer.sol:523-529; the mapping
 * default is the zero word). So "not found" is `ZERO_UID`, never a thrown revert.
 *
 * The walk seeds from the kernel's `rootAnchorUID()` public getter
 * (EFSIndexer.sol:110) — the root of the anchor tree — and resolves each segment
 * in turn, feeding each resolved child UID in as the next segment's parent. A
 * `ZERO_UID` at any segment means that prefix folder does not exist, so the walk
 * stops and reports the missing segment.
 *
 * NOTE on prior ADR text: ADR-0033 (contracts repo) frames the *router's* full
 * URL walk, which first classifies the top-level segment into address / schema-
 * UID / attestation-UID / anchor-name flavors before walking. That classification
 * is a router concern (`EFSRouter`), not a kernel one. For the SDK write path the
 * caller supplies a plain anchor path (e.g. `/docs/api`), which seeds from
 * `rootAnchorUID` and walks via `resolvePath` segment-by-segment — the generic
 * (folder) flavor only. We deliberately do not replicate the router's flavor
 * classification here; a folder path is always anchor-name-flavored.
 */

import type { Address, Hex } from 'viem'
import { indexerAbi } from '../chain/abi/indexer.js'
import { EfsError } from '../errors.js'

/** The empty UID (`bytes32(0)`) — the kernel's "name slot is empty" sentinel and
 * the seed type for the generic (folder) anchor flavor. */
export const ZERO_UID = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

/** The minimal viem public surface path resolution needs: a typed `readContract`.
 * Structurally satisfied by a viem `PublicClient`; kept narrow so resolution is
 * trivially mockable and does not couple to the full client type. */
export interface ResolvePublicClient {
  readContract(args: {
    address: Address
    abi: typeof indexerAbi
    functionName: 'resolvePath' | 'resolveAnchor' | 'rootAnchorUID'
    args?: readonly unknown[]
  }): Promise<unknown>
}

/**
 * Raised when a path prefix (a folder on the way to the target) does not exist
 * on-chain. The write path requires the parent folder to already exist; creating
 * it (`mkdir -p`) is a later slice. Carries the full path requested and the exact
 * segment prefix that resolved to `ZERO_UID`, so a caller can later mkdir-p the
 * gap or surface a precise "folder X is missing" message.
 */
export class ParentNotFoundError extends EfsError {
  override name = 'ParentNotFoundError'
  /** The full anchor path that was being resolved. */
  readonly path: string
  /** The path segments that DID resolve, up to (not including) the missing one. */
  readonly resolvedSegments: readonly string[]
  /** The first segment whose name slot was empty under its parent. */
  readonly missingSegment: string
  constructor(path: string, resolvedSegments: readonly string[], missingSegment: string) {
    const at = resolvedSegments.length > 0 ? `/${resolvedSegments.join('/')}` : '(root)'
    super(
      `EFS path resolution failed: the folder segment '${missingSegment}' does not exist under ${at} (resolving '${path}'). Its parent folder must exist before writing into it — creating missing folders (mkdir -p) is not implemented yet.`,
      { code: 'ParentNotFound' },
    )
    this.path = path
    this.resolvedSegments = resolvedSegments
    this.missingSegment = missingSegment
  }
}

/**
 * Split a path into its non-empty segments, tolerant of leading/trailing/repeat
 * slashes (`/docs//api/` → `['docs', 'api']`). The empty/root path → `[]`.
 */
export function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0)
}

/**
 * Resolve a folder path to its anchor UID by walking each segment from the root.
 *
 * Seeds from `rootAnchorUID()` and applies `resolvePath(parent, segment)` per
 * segment (the generic/folder flavor — EFSIndexer.sol:523-525). The root path
 * (`/` or `''`) resolves to the root anchor itself.
 *
 * @param publicClient  A viem public client (typed `readContract`).
 * @param indexerAddr   The EFSIndexer (kernel) address for the deployment.
 * @param path          The folder path to resolve (e.g. `/docs/api`).
 * @returns The resolved anchor UID.
 * @throws {ParentNotFoundError} if any segment's name slot is empty (`ZERO_UID`).
 */
export async function resolvePathToAnchor(
  publicClient: ResolvePublicClient,
  indexerAddr: Address,
  path: string,
): Promise<Hex> {
  const segments = splitPath(path)
  const root = (await publicClient.readContract({
    address: indexerAddr,
    abi: indexerAbi,
    functionName: 'rootAnchorUID',
  })) as Hex

  let parent = root
  const resolved: string[] = []
  for (const segment of segments) {
    const child = (await publicClient.readContract({
      address: indexerAddr,
      abi: indexerAbi,
      functionName: 'resolvePath',
      args: [parent, segment],
    })) as Hex
    if (child === ZERO_UID) {
      throw new ParentNotFoundError(path, resolved, segment)
    }
    parent = child
    resolved.push(segment)
  }
  return parent
}

/**
 * Resolve the **parent folder anchor** for a target file path — i.e. resolve the
 * path with its final segment (the file name) split off. `/docs/api/readme.md`
 * resolves the folder `/docs/api`; the returned `fileName` is `readme.md`.
 *
 * The file-ANCHOR built by `buildFileWriteGraph` hangs off this parent anchor
 * (`refUID = parentAnchorUID`), so this is the exact pre-existing dependency the
 * write path needs. A target directly under root (`/readme.md`) resolves the
 * parent to the root anchor.
 *
 * @returns `{ parentAnchorUID, fileName }`.
 * @throws {EfsError} (`InvalidArgument`) if `path` has no file-name segment
 *   (empty or root path — there is nothing to place).
 * @throws {ParentNotFoundError} if the parent folder does not exist on-chain.
 */
export async function resolveParentAnchor(
  publicClient: ResolvePublicClient,
  indexerAddr: Address,
  path: string,
): Promise<{ parentAnchorUID: Hex; fileName: string }> {
  const segments = splitPath(path)
  const fileName = segments.pop()
  if (fileName === undefined) {
    throw new EfsError(
      `EFS write: the path '${path}' has no file-name segment — nothing to place. Provide a path like '/docs/readme.md'.`,
      { code: 'InvalidArgument' },
    )
  }
  // The parent is the path minus the final segment. Re-join and resolve it as a
  // folder walk; an empty parent path means the file lives directly under root.
  const parentPath = segments.join('/')
  const parentAnchorUID = await resolvePathToAnchor(publicClient, indexerAddr, parentPath)
  return { parentAnchorUID, fileName }
}
