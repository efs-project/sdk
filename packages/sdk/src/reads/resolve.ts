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
import { edgeResolverAbi } from '../chain/abi/edgeResolver.js'
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
 * on-chain and the write opted OUT of creating it (`createParents: false`). By
 * default the write folds the missing ancestor folders into the same write
 * (`mkdir -p`, {@link WriteOptions}); pass `createParents: false` to require the
 * parents to already exist (a typo guard). Carries the full path requested and the
 * exact segment prefix that
 * resolved to `ZERO_UID`, so a caller can mkdir-p the gap or surface a precise
 * "folder X is missing" message.
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
      `EFS path resolution failed: the folder segment '${missingSegment}' does not exist under ${at} (resolving '${path}'). You passed \`createParents: false\`, which requires the parents to already exist — omit it (the default) to create the missing folders in the same write (mkdir -p).`,
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
 * Resolve a FILE path to its file-ANCHOR UID. Walks the PARENT folders generically
 * (`resolvePath`, the `forSchema = bytes32(0)` slot), then resolves the terminal FILE
 * segment in the DATA-typed slot (`resolveAnchor(parent, name, DATA_SCHEMA_UID)`), with
 * a generic fallback for legacy file anchors. This mirrors the router's resolution order
 * (EFSRouter.sol:240-245): SDK-written file anchors live at `(parent, name, DATA)`, so a
 * generic-only walk would report them ABSENT.
 *
 * @returns the file-ANCHOR UID, or `ZERO_UID` if the terminal segment has neither a
 *   DATA-typed nor a generic anchor (the file does not exist).
 * @throws {ParentNotFoundError} if a PARENT folder segment is missing.
 */
export async function resolveFilePathToAnchor(
  publicClient: ResolvePublicClient,
  indexerAddr: Address,
  path: string,
  dataSchema: Hex,
): Promise<Hex> {
  const segments = splitPath(path)
  if (segments.length === 0) return ZERO_UID // the root is a folder, never a file

  const root = (await publicClient.readContract({
    address: indexerAddr,
    abi: indexerAbi,
    functionName: 'rootAnchorUID',
  })) as Hex

  // Walk the parent folders generically (folders are the generic slot).
  let parent = root
  const resolved: string[] = []
  for (const segment of segments.slice(0, -1)) {
    const child = (await publicClient.readContract({
      address: indexerAddr,
      abi: indexerAbi,
      functionName: 'resolvePath',
      args: [parent, segment],
    })) as Hex
    if (child === ZERO_UID) throw new ParentNotFoundError(path, resolved, segment)
    parent = child
    resolved.push(segment)
  }

  // The file leaf: the DATA-typed slot first (where the SDK writes file anchors),
  // then the generic slot as a fallback (legacy file anchors / router parity).
  const leaf = segments[segments.length - 1] as string
  const dataAnchor = (await publicClient.readContract({
    address: indexerAddr,
    abi: indexerAbi,
    functionName: 'resolveAnchor',
    args: [parent, leaf, dataSchema],
  })) as Hex
  if (dataAnchor !== ZERO_UID) return dataAnchor

  return (await publicClient.readContract({
    address: indexerAddr,
    abi: indexerAbi,
    functionName: 'resolvePath',
    args: [parent, leaf],
  })) as Hex
}

/**
 * Split a target file path into its parent folder segments + the file name.
 * `/docs/api/readme.md` → `{ parentSegments: ['docs', 'api'], fileName: 'readme.md' }`.
 *
 * @throws {EfsError} (`InvalidArgument`) if `path` has no file-name segment.
 */
function splitTargetPath(path: string): { parentSegments: string[]; fileName: string } {
  const segments = splitPath(path)
  const fileName = segments.pop()
  if (fileName === undefined) {
    throw new EfsError(
      `EFS write: the path '${path}' has no file-name segment — nothing to place. Provide a path like '/docs/readme.md'.`,
      { code: 'InvalidArgument' },
    )
  }
  return { parentSegments: segments, fileName }
}

/**
 * The outcome of planning a target file's parent folder, supporting `mkdir -p`.
 * Either the full parent chain already exists (`parentAnchorUID` resolved), or some
 * suffix of ancestor folders is missing — in which case the deepest EXISTING anchor
 * is returned along with the ordered (shallowest-first) chain of missing segments
 * the write must create before placing the file.
 */
export type ParentPlan =
  | {
      /** Every ancestor folder exists; this is the file's immediate parent anchor. */
      readonly parentAnchorUID: Hex
      readonly fileName: string
      /** No folders to create. */
      readonly missingSegments: readonly []
      /**
       * The EXISTING ancestor folder anchor UIDs the walk resolved, ordered
       * SHALLOWEST-first and **excluding the root anchor** (root is never tagged —
       * the visibility walk is "up to root exclusive", overview.md step 7). For a
       * fully-resolved path this is every parent segment's anchor; the visibility-TAG
       * planner walks it bottom-up. Empty when the file lives directly under root.
       */
      readonly existingAncestorUIDs: readonly Hex[]
    }
  | {
      /** The deepest ancestor that DOES exist — the chain of created folders extends
       * from here (the first created folder's `refUID`). */
      readonly deepestExistingAnchorUID: Hex
      readonly fileName: string
      /** The ordered (shallowest-first) folder segments that must be created. */
      readonly missingSegments: readonly string[]
      /**
       * The EXISTING ancestor folder anchor UIDs resolved before the walk hit the
       * gap, ordered SHALLOWEST-first and **excluding the root anchor**. These are
       * the already-on-chain ancestors whose visibility TAGs the planner must check
       * (the newly-created `missingSegments` always need a TAG). Empty when the gap
       * starts at the first parent segment (the created chain hangs off root).
       */
      readonly existingAncestorUIDs: readonly Hex[]
    }

/**
 * Plan the parent folder for a target file path, walking as deep as the chain
 * exists and reporting any missing suffix (instead of throwing) — the `mkdir -p`
 * planning step.
 *
 * Walks each parent segment from `rootAnchorUID()` via `resolvePath`. Once a segment
 * resolves to `ZERO_UID`, the walk stops: that segment and all following parent
 * segments are the `missingSegments` (shallowest-first), and the last resolved anchor
 * (or the root, if the first parent segment is already missing) is the deepest
 * existing anchor the created-folder chain extends from.
 *
 * Unlike {@link resolveParentAnchor} this NEVER throws {@link ParentNotFoundError};
 * the caller decides whether to create the gap (`createParents:true`) or reject it.
 *
 * @returns A {@link ParentPlan} — either the resolved parent anchor (no gap) or the
 *   deepest existing anchor + the ordered missing segments.
 * @throws {EfsError} (`InvalidArgument`) if `path` has no file-name segment.
 */
export async function resolveOrPlanParents(
  publicClient: ResolvePublicClient,
  indexerAddr: Address,
  path: string,
): Promise<ParentPlan> {
  const { parentSegments, fileName } = splitTargetPath(path)

  const root = (await publicClient.readContract({
    address: indexerAddr,
    abi: indexerAbi,
    functionName: 'rootAnchorUID',
  })) as Hex

  let parent = root
  // The EXISTING ancestor anchor UIDs the walk resolves (shallowest-first). The root
  // anchor is deliberately NOT seeded here — the visibility walk is "up to root
  // exclusive" (overview.md step 7), so root never gets a TAG.
  const existingAncestorUIDs: Hex[] = []
  for (let i = 0; i < parentSegments.length; i++) {
    const segment = parentSegments[i] as string
    const child = (await publicClient.readContract({
      address: indexerAddr,
      abi: indexerAbi,
      functionName: 'resolvePath',
      args: [parent, segment],
    })) as Hex
    if (child === ZERO_UID) {
      // From here down the parent chain does not exist — everything from `i` on is
      // a folder to create, hanging off the last resolved anchor (`parent`).
      return {
        deepestExistingAnchorUID: parent,
        fileName,
        missingSegments: parentSegments.slice(i),
        existingAncestorUIDs,
      }
    }
    existingAncestorUIDs.push(child)
    parent = child
  }

  return { parentAnchorUID: parent, fileName, missingSegments: [], existingAncestorUIDs }
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
  const { parentSegments, fileName } = splitTargetPath(path)
  // The parent is the path minus the final segment. Re-join and resolve it as a
  // folder walk; an empty parent path means the file lives directly under root.
  const parentPath = parentSegments.join('/')
  const parentAnchorUID = await resolvePathToAnchor(publicClient, indexerAddr, parentPath)
  return { parentAnchorUID, fileName }
}

/**
 * The minimal viem public surface the visibility-TAG walk needs: a typed
 * `readContract` for `EdgeResolver.getActiveTagWeight`. Kept separate from
 * {@link ResolvePublicClient} (which is indexer-typed) so each read stays
 * trivially mockable. A viem `PublicClient` structurally satisfies both.
 */
export interface TagReadPublicClient {
  readContract(args: {
    address: Address
    abi: typeof edgeResolverAbi
    functionName: 'getActiveTagWeight'
    args: readonly unknown[]
  }): Promise<unknown>
}

/** Inputs the visibility-TAG planner needs beyond the ancestor list. */
export interface VisibilityTagPlanInput {
  /** The `EdgeResolver` address (active-TAG reads). */
  readonly edgeResolver: Address
  /** The uploader = attester whose lens listing must show these folders. */
  readonly attester: Address
  /** The DATA schema UID — the folder-visibility TAG's `definition` (ADR-0038). */
  readonly dataSchemaUID: Hex
  /** The ANCHOR schema UID — the `targetSchema` of a TAG whose target is a folder
   * anchor (`_activeByAAS[definition][attester][targetSchema]`). */
  readonly anchorSchemaUID: Hex
}

/**
 * Plan which EXISTING ancestor folders need a folder-visibility TAG from the
 * uploader (overview.md "Upload flow" step 7; specs/02 §4a + §Schema-Hierarchy
 * step 6; ADR-0038, ADR-0041).
 *
 * The semantics: a folder only appears in an attester's lens listing if that
 * attester has an active `TAG(definition = DATA_SCHEMA_UID, refUID = folderAnchor)`
 * under it. On a write, every generic ancestor folder from the file's immediate
 * parent up to **root exclusive** must carry such a TAG. Newly-created folders
 * (the `createParents` chain) ALWAYS need one (handled by the graph builder); this
 * function covers only the **already-existing** ancestors.
 *
 * Walk + short-circuit: `existingAncestorUIDs` is shallowest-first (root already
 * excluded). We read `getActiveTagWeight(attester, ancestor, DATA_SCHEMA_UID,
 * ANCHOR_SCHEMA_UID)` and emit a TAG only for ancestors with no active TAG yet.
 * Because a TAG is always emitted walking UP to root, an ancestor that is already
 * tagged guarantees every ancestor ABOVE it is too — so the walk goes BOTTOM-UP
 * (deepest existing parent first) and STOPS at the first already-tagged ancestor
 * ("steady-state zero cost", overview.md step 7). Everything below the stop point
 * that was untagged gets a TAG.
 *
 * The existence checks are fanned with `Promise.all` (independent reads), then the
 * short-circuit is applied to the resolved bottom-up sequence — we read upward,
 * then cut at the first tagged ancestor. Weight is irrelevant to activity (ADR-0041
 * §4): any unrevoked TAG counts as covered.
 *
 * @returns The existing-ancestor anchor UIDs that need a NEW visibility TAG, in no
 *   particular order (each is an independent TAG; order does not matter to the DAG).
 */
export async function planExistingAncestorVisibilityTags(
  publicClient: TagReadPublicClient,
  existingAncestorUIDs: readonly Hex[],
  input: VisibilityTagPlanInput,
): Promise<Hex[]> {
  if (existingAncestorUIDs.length === 0) return []

  // Bottom-up: deepest existing ancestor (immediate parent) first, root-ward last.
  const bottomUp = [...existingAncestorUIDs].reverse()

  // Fan the independent active-TAG existence reads. We read them all, then apply the
  // short-circuit on the resolved sequence (read upward, then cut) — cheaper in round
  // trips than a serial walk, and the cut still honors "stop at the first tagged".
  const exists = await Promise.all(
    bottomUp.map(async (ancestor) => {
      const [hasTag] = (await publicClient.readContract({
        address: input.edgeResolver,
        abi: edgeResolverAbi,
        functionName: 'getActiveTagWeight',
        // (attester, target, definition, targetSchema) — see edgeResolver ABI note.
        args: [input.attester, ancestor, input.dataSchemaUID, input.anchorSchemaUID],
      })) as readonly [boolean, bigint]
      return hasTag
    }),
  )

  const needTags: Hex[] = []
  for (let i = 0; i < bottomUp.length; i++) {
    // Steady-state short-circuit: the first already-tagged ancestor means every
    // ancestor above it is tagged too — stop the walk.
    if (exists[i]) break
    needTags.push(bottomUp[i] as Hex)
  }
  return needTags
}
