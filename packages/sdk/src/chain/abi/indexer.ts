/**
 * Vendored `EFSIndexer` read-path ABI fragments.
 *
 * Hand-written `as const` viem ABI covering the append-only kernel's read surface
 * the SDK needs: path resolution, the frozen `*_SCHEMA_UID` getters, root/sorts
 * anchor lookups, revocation checks, and the lens-scoped "referencing" reads that
 * back PROPERTY / MIRROR / edge discovery and write-path resolution.
 *
 * Source of truth: `packages/hardhat/contracts/EFSIndexer.sol` (the kernel; not
 * redeployable — its address is baked into the schema UIDs). NOTE: this contract
 * is deployed under the key `Indexer` in the committed ABI mirror
 * `contracts/packages/nextjs/contracts/deployedContracts.ts`; signatures here are
 * transcribed from the `.sol` (the mirror can be a stale 31337 snapshot for the
 * schema getters per the task brief — trust the source for those).
 *
 * Keep this minimal — add fragments only when a code path needs them.
 */

// ── Path resolution ──────────────────────────────────────────────────────────

/**
 * `EFSIndexer.resolvePath(bytes32 parentUID, string name) -> bytes32`
 * (EFSIndexer.sol:523-525). Generic (schema = bytes32(0)) name → child anchor UID.
 * The router's single-segment walk delegates here (ADR-0033). Returns bytes32(0)
 * when the name slot is empty.
 */
export const resolvePathAbi = [
  {
    type: 'function',
    name: 'resolvePath',
    stateMutability: 'view',
    inputs: [
      { name: 'parentUID', type: 'bytes32' },
      { name: 'name', type: 'string' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * `EFSIndexer.resolveAnchor(bytes32 parentUID, string name, bytes32 schema) -> bytes32`
 * (EFSIndexer.sol:527-529). Schema-typed name → child anchor UID.
 */
export const resolveAnchorAbi = [
  {
    type: 'function',
    name: 'resolveAnchor',
    stateMutability: 'view',
    inputs: [
      { name: 'parentUID', type: 'bytes32' },
      { name: 'name', type: 'string' },
      { name: 'schema', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * `EFSIndexer.rootAnchorUID() -> bytes32` — public state var auto-getter
 * (EFSIndexer.sol:110). Seed of the Anchor-flavor URL walk.
 */
export const rootAnchorUidAbi = [
  {
    type: 'function',
    name: 'rootAnchorUID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * `EFSIndexer.sortsAnchorUID() -> bytes32` — public state var auto-getter
 * (EFSIndexer.sol:130). The well-known `/sorts/` anchor (sort overlay is deferred,
 * not in the frozen schema set — included for completeness of the kernel surface).
 */
export const sortsAnchorUidAbi = [
  {
    type: 'function',
    name: 'sortsAnchorUID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

// ── Frozen schema-UID getters ────────────────────────────────────────────────
//
// ANCHOR / PROPERTY / DATA are explicit `view` functions reading the ERC-7201
// config struct (EFSIndexer.sol:97-107). PIN / TAG / SORT_INFO / MIRROR are
// `public bytes32` state vars with compiler-generated getters (EFSIndexer.sol
// :117-120). All return bytes32; from an ABI standpoint they are identical.

export const anchorSchemaUidAbi = [
  {
    type: 'function',
    name: 'ANCHOR_SCHEMA_UID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

export const propertySchemaUidAbi = [
  {
    type: 'function',
    name: 'PROPERTY_SCHEMA_UID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

export const dataSchemaUidAbi = [
  {
    type: 'function',
    name: 'DATA_SCHEMA_UID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

export const pinSchemaUidAbi = [
  {
    type: 'function',
    name: 'PIN_SCHEMA_UID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

export const tagSchemaUidAbi = [
  {
    type: 'function',
    name: 'TAG_SCHEMA_UID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

export const sortInfoSchemaUidAbi = [
  {
    type: 'function',
    name: 'SORT_INFO_SCHEMA_UID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

export const mirrorSchemaUidAbi = [
  {
    type: 'function',
    name: 'MIRROR_SCHEMA_UID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * `EFSIndexer.DEPLOYER() -> address` (EFSIndexer.sol:136-138). Preserved by name
 * for ABI compatibility; now returns `owner()`. The router's pre-ADR-0053 default
 * lens fallback.
 */
export const deployerAbi = [
  {
    type: 'function',
    name: 'DEPLOYER',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

// ── Revocation ───────────────────────────────────────────────────────────────

/**
 * `EFSIndexer.isRevoked(bytes32 uid) -> bool` (EFSIndexer.sol:1197). Reads-exclude-
 * revoked default (ADR-0051) is enforced by callers via this check.
 */
export const isRevokedAbi = [
  {
    type: 'function',
    name: 'isRevoked',
    stateMutability: 'view',
    inputs: [{ name: 'uid', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

// ── Referencing reads (lens-scoped write-path resolution + discovery) ─────────

/**
 * `EFSIndexer.getReferencingAttestations(bytes32 targetUID, bytes32 schemaUID,
 * uint256 start, uint256 length, bool reverseOrder, bool showRevoked) -> bytes32[]`
 * (EFSIndexer.sol:740-747). All attestations of `schemaUID` that reference
 * `targetUID` via refUID. Backs `EFSFileView.getDataMirrors` and generic
 * referencing discovery.
 */
export const getReferencingAttestationsAbi = [
  {
    type: 'function',
    name: 'getReferencingAttestations',
    stateMutability: 'view',
    inputs: [
      { name: 'targetUID', type: 'bytes32' },
      { name: 'schemaUID', type: 'bytes32' },
      { name: 'start', type: 'uint256' },
      { name: 'length', type: 'uint256' },
      { name: 'reverseOrder', type: 'bool' },
      { name: 'showRevoked', type: 'bool' },
    ],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
] as const

/** `EFSIndexer.getReferencingAttestationCount(bytes32, bytes32) -> uint256` (EFSIndexer.sol:758). */
export const getReferencingAttestationCountAbi = [
  {
    type: 'function',
    name: 'getReferencingAttestationCount',
    stateMutability: 'view',
    inputs: [
      { name: 'targetUID', type: 'bytes32' },
      { name: 'schemaUID', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/**
 * `EFSIndexer.getReferencingBySchemaAndAttester(bytes32 targetUID, bytes32 schemaUID,
 * address attester, uint256 start, uint256 length, bool reverseOrder, bool showRevoked)
 * -> bytes32[]` (EFSIndexer.sol:813-821). Lens-scoped referencing read — the
 * per-attester filter behind lens-scoped PROPERTY / MIRROR lookup (ADR-0013/0014).
 */
export const getReferencingBySchemaAndAttesterAbi = [
  {
    type: 'function',
    name: 'getReferencingBySchemaAndAttester',
    stateMutability: 'view',
    inputs: [
      { name: 'targetUID', type: 'bytes32' },
      { name: 'schemaUID', type: 'bytes32' },
      { name: 'attester', type: 'address' },
      { name: 'start', type: 'uint256' },
      { name: 'length', type: 'uint256' },
      { name: 'reverseOrder', type: 'bool' },
      { name: 'showRevoked', type: 'bool' },
    ],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
] as const

/** `EFSIndexer.getReferencingBySchemaAndAttesterCount(bytes32, bytes32, address) -> uint256` (EFSIndexer.sol:907-911). */
export const getReferencingBySchemaAndAttesterCountAbi = [
  {
    type: 'function',
    name: 'getReferencingBySchemaAndAttesterCount',
    stateMutability: 'view',
    inputs: [
      { name: 'targetUID', type: 'bytes32' },
      { name: 'schemaUID', type: 'bytes32' },
      { name: 'attester', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// ── Children / sibling reads (back EFSFileView's directory views) ─────────────

/**
 * `EFSIndexer.getChildren(bytes32 anchorUID, uint256 start, uint256 length,
 * bool reverseOrder, bool showRevoked) -> bytes32[]` (EFSIndexer.sol:531-539).
 */
export const getChildrenAbi = [
  {
    type: 'function',
    name: 'getChildren',
    stateMutability: 'view',
    inputs: [
      { name: 'anchorUID', type: 'bytes32' },
      { name: 'start', type: 'uint256' },
      { name: 'length', type: 'uint256' },
      { name: 'reverseOrder', type: 'bool' },
      { name: 'showRevoked', type: 'bool' },
    ],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
] as const

/** `EFSIndexer.getChildrenCount(bytes32 anchorUID) -> uint256` (EFSIndexer.sol:541-543). */
export const getChildrenCountAbi = [
  {
    type: 'function',
    name: 'getChildrenCount',
    stateMutability: 'view',
    inputs: [{ name: 'anchorUID', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/**
 * `EFSIndexer.getChildrenByAddressList(bytes32 parentUID, address[] attesters,
 * uint256 startCursor, uint256 pageSize, bool reverseOrder, bool showRevoked)
 * -> (bytes32[] results, uint256 nextCursor)` (EFSIndexer.sol:851-858).
 */
export const getChildrenByAddressListAbi = [
  {
    type: 'function',
    name: 'getChildrenByAddressList',
    stateMutability: 'view',
    inputs: [
      { name: 'parentUID', type: 'bytes32' },
      { name: 'attesters', type: 'address[]' },
      { name: 'startCursor', type: 'uint256' },
      { name: 'pageSize', type: 'uint256' },
      { name: 'reverseOrder', type: 'bool' },
      { name: 'showRevoked', type: 'bool' },
    ],
    outputs: [
      { name: 'results', type: 'bytes32[]' },
      { name: 'nextCursor', type: 'uint256' },
    ],
  },
] as const

/**
 * `EFSIndexer.getAnchorsBySchemaAndAddressList(bytes32 parentUID, bytes32 anchorSchema,
 * address[] attesters, uint256 startCursor, uint256 pageSize, bool reverseOrder,
 * bool showRevoked) -> (bytes32[] results, uint256 nextCursor)` (EFSIndexer.sol
 * :635-643). Phase-1 source of `EFSFileView.getDirectoryPageBySchemaAndAddressList`.
 */
export const getAnchorsBySchemaAndAddressListAbi = [
  {
    type: 'function',
    name: 'getAnchorsBySchemaAndAddressList',
    stateMutability: 'view',
    inputs: [
      { name: 'parentUID', type: 'bytes32' },
      { name: 'anchorSchema', type: 'bytes32' },
      { name: 'attesters', type: 'address[]' },
      { name: 'startCursor', type: 'uint256' },
      { name: 'pageSize', type: 'uint256' },
      { name: 'reverseOrder', type: 'bool' },
      { name: 'showRevoked', type: 'bool' },
    ],
    outputs: [
      { name: 'results', type: 'bytes32[]' },
      { name: 'nextCursor', type: 'uint256' },
    ],
  },
] as const

/**
 * Combined `EFSIndexer` read ABI — composed from the per-function fragments above.
 * Deployed under the `Indexer` key in `deployedContracts.ts`.
 */
export const indexerAbi = [
  ...resolvePathAbi,
  ...resolveAnchorAbi,
  ...rootAnchorUidAbi,
  ...sortsAnchorUidAbi,
  ...anchorSchemaUidAbi,
  ...propertySchemaUidAbi,
  ...dataSchemaUidAbi,
  ...pinSchemaUidAbi,
  ...tagSchemaUidAbi,
  ...sortInfoSchemaUidAbi,
  ...mirrorSchemaUidAbi,
  ...deployerAbi,
  ...isRevokedAbi,
  ...getReferencingAttestationsAbi,
  ...getReferencingAttestationCountAbi,
  ...getReferencingBySchemaAndAttesterAbi,
  ...getReferencingBySchemaAndAttesterCountAbi,
  ...getChildrenAbi,
  ...getChildrenCountAbi,
  ...getChildrenByAddressListAbi,
  ...getAnchorsBySchemaAndAddressListAbi,
] as const
