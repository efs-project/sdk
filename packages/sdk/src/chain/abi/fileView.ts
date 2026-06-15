/**
 * Vendored `EFSFileView` view-layer ABI fragments (ADR-0011).
 *
 * The SDK previously vendored only EAS ABIs (`src/eas/abi.ts`). This is the
 * SDK's first view-layer ABI: a hand-written `as const` viem ABI covering only
 * the directory-listing view functions the SDK reads. Struct shapes mirror the
 * contracts source of truth exactly:
 *
 *   - `FileSystemItem` and `DirectoryPage` from `EFSFileView.sol` (≈lines
 *     104-145). `DirectoryPage` is `{ FileSystemItem[] items; bytes nextCursor }`.
 *   - The three directory-page reads:
 *       - `getDirectoryPageByAddressList` — unfiltered, no schema filter, returns
 *         a bare `FileSystemItem[]` + a `uint256 nextCursor` (NOT a DirectoryPage).
 *       - `getDirectoryPageBySchemaAndAddressList` — unfiltered sibling, returns a
 *         `DirectoryPage` (opaque `bytes` cursor, ADR-0036).
 *       - `getDirectoryPageFiltered` — on-chain tag-exclusion filter (ADR-0048),
 *         returns a `DirectoryPage`.
 *
 * Component names / types / order are transcribed from the committed ABI mirror
 * `contracts/packages/nextjs/contracts/deployedContracts.ts` (the authoritative
 * artifact), cross-checked against `EFSFileView.sol`.
 *
 * Keep this minimal — add fragments only when a code path needs them.
 * `getActiveTagWeight` is deliberately NOT vendored (ADR-0011 §4): the filter
 * applies the weight threshold internally; no SDK consumer reads it directly.
 */

/**
 * `FileSystemItem` tuple components, shared by all three reads. Mirrors
 * `EFSFileView.FileSystemItem` (EFSFileView.sol lines 104-116).
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

/**
 * `EFSFileView.getDirectoryPageByAddressList(bytes32, address[], uint256, uint256)`
 * — unfiltered listing across an attester list. Returns a bare
 * `FileSystemItem[]` plus a `uint256 nextCursor` (NOT wrapped in DirectoryPage).
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
 * `EFSFileView.getDirectoryPageBySchemaAndAddressList(bytes32, bytes32, address[], bytes, uint256)`
 * — unfiltered sibling of `getDirectoryPageFiltered`: same schema + attester
 * filter and opaque `bytes` cursor (ADR-0036), no tag exclusion. Returns a
 * `DirectoryPage`.
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
    outputs: [
      {
        name: 'page',
        type: 'tuple',
        components: [
          { name: 'items', type: 'tuple[]', components: fileSystemItemComponents },
          { name: 'nextCursor', type: 'bytes' },
        ],
      },
    ],
  },
] as const

/**
 * `EFSFileView.getDirectoryPageFiltered(bytes32, bytes32, address[], bytes32[], int256[], bytes, uint256)`
 * — on-chain tag-exclusion directory filter (ADR-0048). `excludeTagDefs` and
 * `minWeights` are parallel arrays (length must match, enforced on-chain).
 * Returns a `DirectoryPage`; a heavily-excluded page can return empty `items`
 * with a non-empty `nextCursor` (phase-1 scan budget) — empty ≠ end-of-list.
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
    outputs: [
      {
        name: 'page',
        type: 'tuple',
        components: [
          { name: 'items', type: 'tuple[]', components: fileSystemItemComponents },
          { name: 'nextCursor', type: 'bytes' },
        ],
      },
    ],
  },
] as const

/**
 * Combined `EFSFileView` ABI for the directory-page reads the SDK calls. Compose
 * from the per-function fragments above (mirrors `easAbi`'s composition style).
 */
export const fileViewAbi = [
  ...getDirectoryPageByAddressListAbi,
  ...getDirectoryPageBySchemaAndAddressListAbi,
  ...getDirectoryPageFilteredAbi,
] as const
