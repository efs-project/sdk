/**
 * Vendored `EFSFileView` view-layer ABI fragments (ADR-0011, re-verified against
 * the frozen source).
 *
 * Hand-written `as const` viem ABI covering the directory-listing + mirror/name
 * view functions the SDK reads off `EFSFileView` — the stateless, redeployable
 * view over `EFSIndexer` + `EdgeResolver`. Struct shapes mirror the FROZEN
 * `EFSFileView.sol` exactly (cite `file:line`), cross-checked against the committed
 * ABI mirror `contracts/packages/nextjs/contracts/deployedContracts.ts`.
 *
 * Re-verification note (the freeze changed `EFSFileView`): the three pre-existing
 * directory-page fragments — `getDirectoryPageByAddressList`,
 * `getDirectoryPageBySchemaAndAddressList`, `getDirectoryPageFiltered` — were
 * re-checked signature-by-signature against `EFSFileView.sol` and are **unchanged**
 * (the `FileSystemItem` 11-field shape, the bare-array `(items, uint256 nextCursor)`
 * return of the address-list variant, and the opaque-`bytes`-cursor `DirectoryPage`
 * of the schema/filtered variants all still hold). The drift fixed here is one of
 * **completeness, not signature change**: the prior `fileViewAbi` combined export
 * omitted reads the SDK's read + write-path-resolution paths need. Added:
 *   - `getDirectoryPage` (single-attester unfiltered page; bare `FileSystemItem[]`).
 *   - `getFilesAtPath` (per-lens active-PIN file resolution; `DirectoryPage`).
 *   - `getDataMirrors` (per-DATA active mirrors; returns `MirrorItem[]`).
 *   - `getCanonicalData` (deprecated no-op reverse lookup; returns bytes32(0)).
 *   - `decodeName` (pure anchor-name decoder).
 *
 * Keep this minimal — add fragments only when a code path needs them.
 */

/**
 * `FileSystemItem` tuple components, shared by all the directory reads. Mirrors
 * `EFSFileView.FileSystemItem` (EFSFileView.sol:104-116).
 */
const fileSystemItemComponents = [
  { name: 'uid', type: 'bytes32' },
  { name: 'name', type: 'string' },
  { name: 'parentUID', type: 'bytes32' },
  { name: 'isFolder', type: 'bool' },
  { name: 'hasData', type: 'bool' },
  { name: 'childCount', type: 'uint256' },
  { name: 'propertyCount', type: 'uint256' },
  { name: 'timestamp', type: 'uint64' },
  { name: 'attester', type: 'address' },
  { name: 'schema', type: 'bytes32' },
  { name: 'contentHash', type: 'bytes32' },
] as const

/** `DirectoryPage` tuple — `{ FileSystemItem[] items; bytes nextCursor }` (EFSFileView.sol:142-145, ADR-0036). */
const directoryPageComponents = [
  { name: 'items', type: 'tuple[]', components: fileSystemItemComponents },
  { name: 'nextCursor', type: 'bytes' },
] as const

/**
 * `EFSFileView.getDirectoryPage(bytes32 parentAnchor, uint256 start, uint256 length,
 * bytes32 dataSchemaUID, bytes32 propertySchemaUID) -> FileSystemItem[]`
 * (EFSFileView.sol:157-166). Single-attester unfiltered listing (newest-first);
 * returns a bare `FileSystemItem[]`, no cursor.
 */
export const getDirectoryPageAbi = [
  {
    type: 'function',
    name: 'getDirectoryPage',
    stateMutability: 'view',
    inputs: [
      { name: 'parentAnchor', type: 'bytes32' },
      { name: 'start', type: 'uint256' },
      { name: 'length', type: 'uint256' },
      { name: 'dataSchemaUID', type: 'bytes32' },
      { name: 'propertySchemaUID', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'tuple[]', components: fileSystemItemComponents }],
  },
] as const

/**
 * `EFSFileView.getDirectoryPageByAddressList(bytes32 parentAnchor, address[] attesters,
 * uint256 startingCursor, uint256 pageSize)` (EFSFileView.sol:168-191) — unfiltered
 * listing across an attester list. Returns a bare `FileSystemItem[]` plus a
 * `uint256 nextCursor` (NOT wrapped in DirectoryPage).
 */
export const getDirectoryPageByAddressListAbi = [
  {
    type: 'function',
    name: 'getDirectoryPageByAddressList',
    stateMutability: 'view',
    inputs: [
      { name: 'parentAnchor', type: 'bytes32' },
      { name: 'attesters', type: 'address[]' },
      { name: 'startingCursor', type: 'uint256' },
      { name: 'pageSize', type: 'uint256' },
    ],
    outputs: [
      { name: 'items', type: 'tuple[]', components: fileSystemItemComponents },
      { name: 'nextCursor', type: 'uint256' },
    ],
  },
] as const

/**
 * `EFSFileView.getDirectoryPageBySchemaAndAddressList(bytes32 parentAnchor,
 * bytes32 anchorSchema, address[] attesters, bytes cursor, uint256 maxItems)`
 * (EFSFileView.sol:285-291) — unfiltered sibling of `getDirectoryPageFiltered`:
 * same schema + attester filter and opaque `bytes` cursor (ADR-0036), no tag
 * exclusion. Returns a `DirectoryPage`.
 */
export const getDirectoryPageBySchemaAndAddressListAbi = [
  {
    type: 'function',
    name: 'getDirectoryPageBySchemaAndAddressList',
    stateMutability: 'view',
    inputs: [
      { name: 'parentAnchor', type: 'bytes32' },
      { name: 'anchorSchema', type: 'bytes32' },
      { name: 'attesters', type: 'address[]' },
      { name: 'cursor', type: 'bytes' },
      { name: 'maxItems', type: 'uint256' },
    ],
    outputs: [{ name: 'page', type: 'tuple', components: directoryPageComponents }],
  },
] as const

/**
 * `EFSFileView.getDirectoryPageFiltered(bytes32 parentAnchor, bytes32 anchorSchema,
 * address[] attesters, bytes32[] excludeTagDefs, int256[] minWeights, bytes cursor,
 * uint256 maxItems)` (EFSFileView.sol:459-467) — on-chain tag-exclusion directory
 * filter (ADR-0054). `excludeTagDefs` and `minWeights` are parallel arrays (length
 * must match, enforced on-chain). Returns a `DirectoryPage`; a heavily-excluded page
 * can return empty `items` with a non-empty `nextCursor` (phase scan budget) —
 * empty != end-of-list.
 */
export const getDirectoryPageFilteredAbi = [
  {
    type: 'function',
    name: 'getDirectoryPageFiltered',
    stateMutability: 'view',
    inputs: [
      { name: 'parentAnchor', type: 'bytes32' },
      { name: 'anchorSchema', type: 'bytes32' },
      { name: 'attesters', type: 'address[]' },
      { name: 'excludeTagDefs', type: 'bytes32[]' },
      { name: 'minWeights', type: 'int256[]' },
      { name: 'cursor', type: 'bytes' },
      { name: 'maxItems', type: 'uint256' },
    ],
    outputs: [{ name: 'page', type: 'tuple', components: directoryPageComponents }],
  },
] as const

/**
 * `EFSFileView.getFilesAtPath(bytes32 anchorUID, address[] attesters, bytes32 schema,
 * bytes cursor, uint256 maxItems) -> DirectoryPage` (EFSFileView.sol:805-811). Per-lens
 * active-PIN file resolution at a path: walks the attester list in order, returns each
 * lens's winning placement (first-attester-wins, ADR-0031), opaque-`bytes`-cursor
 * paginated (ADR-0036). The item's `attester` is the winning *placement* lens, not the
 * DATA author.
 */
export const getFilesAtPathAbi = [
  {
    type: 'function',
    name: 'getFilesAtPath',
    stateMutability: 'view',
    inputs: [
      { name: 'anchorUID', type: 'bytes32' },
      { name: 'attesters', type: 'address[]' },
      { name: 'schema', type: 'bytes32' },
      { name: 'cursor', type: 'bytes' },
      { name: 'maxItems', type: 'uint256' },
    ],
    outputs: [{ name: 'page', type: 'tuple', components: directoryPageComponents }],
  },
] as const

/**
 * `EFSFileView.getDataMirrors(bytes32 dataUID, uint256 start, uint256 length)
 * -> MirrorItem[]` (EFSFileView.sol:919-923). The per-DATA active-mirror lookup
 * (revoked excluded). `MirrorItem` (EFSFileView.sol:118-124):
 * `{ bytes32 uid; bytes32 transportDefinition; string uri; address attester; uint64 timestamp }`.
 * Mirror selection (transport priority + lens scope) is the SDK's / router's job over
 * this list — this read does not itself pick a winner.
 */
export const getDataMirrorsAbi = [
  {
    type: 'function',
    name: 'getDataMirrors',
    stateMutability: 'view',
    inputs: [
      { name: 'dataUID', type: 'bytes32' },
      { name: 'start', type: 'uint256' },
      { name: 'length', type: 'uint256' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'uid', type: 'bytes32' },
          { name: 'transportDefinition', type: 'bytes32' },
          { name: 'uri', type: 'string' },
          { name: 'attester', type: 'address' },
          { name: 'timestamp', type: 'uint64' },
        ],
      },
    ],
  },
] as const

/**
 * `EFSFileView.getDataMirrorsByAttester(bytes32 dataUID, address attester, uint256 start,
 * uint256 length) -> MirrorItem[]` (EFSFileView.sol:984-989). The LENS-SCOPED per-DATA
 * active-mirror lookup (ADR-0056 lens-scoping fix): unlike the unscoped `getDataMirrors`
 * (which returns every attester's mirrors and forces the caller to filter), this returns
 * ONLY the named attester's active mirrors. The SDK read path scopes to the winning lens
 * (`resolvedBy`) by passing that address here, so a foreign attester's mirror can never
 * surface on data served under someone else's lens. Same `MirrorItem` shape as
 * `getDataMirrors`.
 */
export const getDataMirrorsByAttesterAbi = [
  {
    type: 'function',
    name: 'getDataMirrorsByAttester',
    stateMutability: 'view',
    inputs: [
      { name: 'dataUID', type: 'bytes32' },
      { name: 'attester', type: 'address' },
      { name: 'start', type: 'uint256' },
      { name: 'length', type: 'uint256' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'uid', type: 'bytes32' },
          { name: 'transportDefinition', type: 'bytes32' },
          { name: 'uri', type: 'string' },
          { name: 'attester', type: 'address' },
          { name: 'timestamp', type: 'uint64' },
        ],
      },
    ],
  },
] as const

/**
 * `EFSFileView.getCanonicalData(bytes32 contentHash) -> bytes32` (EFSFileView.sol:966-968).
 * Deprecated content-hash → canonical DATA reverse lookup; always returns bytes32(0)
 * post-ADR-0049 (DATA is pure identity, no intrinsic hash index). Retained as a no-op
 * so the view ABI stays stable.
 */
export const getCanonicalDataAbi = [
  {
    type: 'function',
    name: 'getCanonicalData',
    stateMutability: 'pure',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * `EFSFileView.decodeName(bytes data) -> string` (EFSFileView.sol:970-973). Pure
 * helper: decodes the anchor `(string name, bytes32 anchorType)` payload and returns
 * the name.
 */
export const decodeNameAbi = [
  {
    type: 'function',
    name: 'decodeName',
    stateMutability: 'pure',
    inputs: [{ name: 'data', type: 'bytes' }],
    outputs: [{ name: '', type: 'string' }],
  },
] as const

/**
 * Combined `EFSFileView` ABI for the view reads the SDK calls. Composed from the
 * per-function fragments above (mirrors `easAbi`'s composition style).
 */
export const fileViewAbi = [
  ...getDirectoryPageAbi,
  ...getDirectoryPageByAddressListAbi,
  ...getDirectoryPageBySchemaAndAddressListAbi,
  ...getDirectoryPageFilteredAbi,
  ...getFilesAtPathAbi,
  ...getDataMirrorsAbi,
  ...getDataMirrorsByAttesterAbi,
  ...getCanonicalDataAbi,
  ...decodeNameAbi,
] as const
