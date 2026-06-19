/**
 * Vendored List-primitive read-path ABI fragments (ADR-0044 / ADR-0046).
 *
 * Hand-written `as const` viem ABI covering the curated-collection read surface
 * across three frozen contracts:
 *
 *   - `ListResolver`        — LIST schema hook (stateless). Exposes `listSchemaUID()`.
 *   - `ListEntryResolver`   — LIST_ENTRY schema hook (wide `EntryRecord[]` storage,
 *                             per-attester lens). Exposes the schema-UID getters
 *                             and the raw entry/length/member-count reads.
 *   - `ListReader`          — stateless view over `ListEntryResolver` + EAS. The
 *                             primary SDK read surface: `getMode`, `length`,
 *                             `entries`, `countOf`, typed accessors, identity-key
 *                             helpers. Redeployable (its address is in no schema UID).
 *
 * Source of truth: `packages/hardhat/contracts/{ListResolver,ListEntryResolver,
 * ListReader}.sol` + `contracts/interfaces/IListReader.sol`. Component names / order
 * are cross-checked against `deployedContracts.ts`.
 *
 * The schema-UID getters here let the deployments registry assertion source
 * `LIST_SCHEMA_UID` / `listEntrySchemaUID` straight from chain.
 *
 * Keep this minimal — add fragments only when a code path needs them.
 */

// ── ListResolver ─────────────────────────────────────────────────────────────

/**
 * `ListResolver.listSchemaUID() -> bytes32` (ListResolver.sol:57-59). The LIST
 * schema UID this resolver validates.
 */
export const listResolverSchemaUidAbi = [
  {
    type: 'function',
    name: 'listSchemaUID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/** Combined `ListResolver` read ABI. */
export const listResolverAbi = [...listResolverSchemaUidAbi] as const

// ── ListEntryResolver ────────────────────────────────────────────────────────

/**
 * `ListEntryResolver.LIST_SCHEMA_UID() -> bytes32` (ListEntryResolver.sol:126-128)
 * and `listEntrySchemaUID() -> bytes32` (ListEntryResolver.sol:137-139). The
 * schema-UID getters used by the deploy freeze-gate and registry assertions.
 */
export const listEntryResolverListSchemaUidAbi = [
  {
    type: 'function',
    name: 'LIST_SCHEMA_UID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

export const listEntryResolverEntrySchemaUidAbi = [
  {
    type: 'function',
    name: 'listEntrySchemaUID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * `ListEntryResolver.getEntries(bytes32 listUID, address attester, uint256 start,
 * uint256 len) -> EntryRecord[]` (ListEntryResolver.sol:328-345). `EntryRecord` is
 * `{ bytes32 entryUID; bytes32 identityKey }` (ListEntryResolver.sol:159-162) — raw
 * per-attester storage read (zero per-entry EAS calls).
 */
export const getEntriesAbi = [
  {
    type: 'function',
    name: 'getEntries',
    stateMutability: 'view',
    inputs: [
      { name: 'listUID', type: 'bytes32' },
      { name: 'attester', type: 'address' },
      { name: 'start', type: 'uint256' },
      { name: 'len', type: 'uint256' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'entryUID', type: 'bytes32' },
          { name: 'identityKey', type: 'bytes32' },
        ],
      },
    ],
  },
] as const

/** `ListEntryResolver.getLength(bytes32 listUID, address attester) -> uint256` (ListEntryResolver.sol:324). */
export const getLengthAbi = [
  {
    type: 'function',
    name: 'getLength',
    stateMutability: 'view',
    inputs: [
      { name: 'listUID', type: 'bytes32' },
      { name: 'attester', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/** `ListEntryResolver.getMemberCount(bytes32 listUID, bytes32 identityKey, address attester) -> uint256` (ListEntryResolver.sol:346). */
export const getMemberCountAbi = [
  {
    type: 'function',
    name: 'getMemberCount',
    stateMutability: 'view',
    inputs: [
      { name: 'listUID', type: 'bytes32' },
      { name: 'identityKey', type: 'bytes32' },
      { name: 'attester', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/** Combined `ListEntryResolver` read ABI. */
export const listEntryResolverAbi = [
  ...listEntryResolverListSchemaUidAbi,
  ...listEntryResolverEntrySchemaUidAbi,
  ...getEntriesAbi,
  ...getLengthAbi,
  ...getMemberCountAbi,
] as const

// ── ListReader (IListReader) ─────────────────────────────────────────────────

/**
 * `ListReader.LIST_SCHEMA_UID() -> bytes32` / `LIST_ENTRY_SCHEMA_UID() -> bytes32`
 * — public immutable auto-getters (ListReader.sol:20-21). The reader's pinned
 * schema UIDs, for registry assertions.
 */
export const listReaderListSchemaUidAbi = [
  {
    type: 'function',
    name: 'LIST_SCHEMA_UID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

export const listReaderListEntrySchemaUidAbi = [
  {
    type: 'function',
    name: 'LIST_ENTRY_SCHEMA_UID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * `ListReader.getMode(bytes32 listUID) -> ListMode` (ListReader.sol:36; IListReader.sol:24).
 * `ListMode` (IListReader.sol:5-13): `{ bool exists; address curator; bool allowsDuplicates;
 * bool appendOnly; uint8 targetType; bytes32 targetSchema; uint256 maxEntries }`.
 * `targetType`: 0=ANY, 1=ADDR, 2=SCHEMA. Schema-checked before decode.
 */
export const getModeAbi = [
  {
    type: 'function',
    name: 'getMode',
    stateMutability: 'view',
    inputs: [{ name: 'listUID', type: 'bytes32' }],
    outputs: [
      {
        name: 'm',
        type: 'tuple',
        components: [
          { name: 'exists', type: 'bool' },
          { name: 'curator', type: 'address' },
          { name: 'allowsDuplicates', type: 'bool' },
          { name: 'appendOnly', type: 'bool' },
          { name: 'targetType', type: 'uint8' },
          { name: 'targetSchema', type: 'bytes32' },
          { name: 'maxEntries', type: 'uint256' },
        ],
      },
    ],
  },
] as const

/** `ListReader.length(bytes32 listUID, address attester) -> uint256` (ListReader.sol:48; IListReader.sol:27). */
export const lengthAbi = [
  {
    type: 'function',
    name: 'length',
    stateMutability: 'view',
    inputs: [
      { name: 'listUID', type: 'bytes32' },
      { name: 'attester', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/**
 * `ListReader.entries(bytes32 listUID, address attester, uint256 start, uint256 len)
 * -> Entry[]` (ListReader.sol:52; IListReader.sol:31). `Entry` (IListReader.sol:15-19):
 * `{ bytes32 entryUID; uint8 targetType; bytes32 identityKey }` — targetType denormalized
 * from the LIST; order/label are PIN-bound PROPERTYs, not fields (ADR-0046).
 */
export const entriesAbi = [
  {
    type: 'function',
    name: 'entries',
    stateMutability: 'view',
    inputs: [
      { name: 'listUID', type: 'bytes32' },
      { name: 'attester', type: 'address' },
      { name: 'start', type: 'uint256' },
      { name: 'len', type: 'uint256' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'entryUID', type: 'bytes32' },
          { name: 'targetType', type: 'uint8' },
          { name: 'identityKey', type: 'bytes32' },
        ],
      },
    ],
  },
] as const

/** `ListReader.countOf(bytes32 listUID, address attester, bytes32 identityKey) -> uint256` (ListReader.sol:77; IListReader.sol:40). */
export const countOfAbi = [
  {
    type: 'function',
    name: 'countOf',
    stateMutability: 'view',
    inputs: [
      { name: 'listUID', type: 'bytes32' },
      { name: 'attester', type: 'address' },
      { name: 'identityKey', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/**
 * Typed entry accessors (ListReader.sol:87-120; IListReader.sol:48-52). Each reverts
 * unless the list's `targetType` matches: `targetAsAddress` → ADDR(1),
 * `targetAsUID` → SCHEMA(2), `targetAsMemberKey` → ANY(0). `lens` is the attester
 * whose entries you read.
 */
export const targetAsAddressAbi = [
  {
    type: 'function',
    name: 'targetAsAddress',
    stateMutability: 'view',
    inputs: [
      { name: 'listUID', type: 'bytes32' },
      { name: 'lens', type: 'address' },
      { name: 'entryUID', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

export const targetAsUidAbi = [
  {
    type: 'function',
    name: 'targetAsUID',
    stateMutability: 'view',
    inputs: [
      { name: 'listUID', type: 'bytes32' },
      { name: 'lens', type: 'address' },
      { name: 'entryUID', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

export const targetAsMemberKeyAbi = [
  {
    type: 'function',
    name: 'targetAsMemberKey',
    stateMutability: 'view',
    inputs: [
      { name: 'listUID', type: 'bytes32' },
      { name: 'lens', type: 'address' },
      { name: 'entryUID', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * Pure identity-key helpers (ListReader.sol:124-134; IListReader.sol:55-59).
 * Stateless conversions, callable off-chain or on.
 */
export const identityKeyForAddressAbi = [
  {
    type: 'function',
    name: 'identityKeyForAddress',
    stateMutability: 'pure',
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

export const identityKeyForUidAbi = [
  {
    type: 'function',
    name: 'identityKeyForUID',
    stateMutability: 'pure',
    inputs: [{ name: 'uid', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

export const identityKeyForMemberKeyAbi = [
  {
    type: 'function',
    name: 'identityKeyForMemberKey',
    stateMutability: 'pure',
    inputs: [{ name: 'k', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * Combined `ListReader` (IListReader) read ABI — composed from the per-function
 * fragments above.
 */
export const listReaderAbi = [
  ...listReaderListSchemaUidAbi,
  ...listReaderListEntrySchemaUidAbi,
  ...getModeAbi,
  ...lengthAbi,
  ...entriesAbi,
  ...countOfAbi,
  ...targetAsAddressAbi,
  ...targetAsUidAbi,
  ...targetAsMemberKeyAbi,
  ...identityKeyForAddressAbi,
  ...identityKeyForUidAbi,
  ...identityKeyForMemberKeyAbi,
] as const
