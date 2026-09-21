/**
 * Vendored `EdgeResolver` read-path ABI fragments.
 *
 * Hand-written `as const` viem ABI covering the PIN + TAG resolver reads the SDK
 * needs for active (revoked-excluded) edge resolution: the O(1) active-PIN-target
 * read that backs file placement / PROPERTY value binding (Shape A), and the
 * active-TAG weight/entry reads behind the view-layer exclusion filter (ADR-0042,
 * ADR-0054). The kernel stays weight-neutral — weight is returned verbatim.
 *
 * Source of truth: `packages/hardhat/contracts/EdgeResolver.sol`. PIN and TAG are
 * sibling edge schemas served by this one resolver; cardinality lives in the
 * schema UID (ADR-0041). Not redeployable — wired into `EFSIndexer`.
 *
 * Keep this minimal — add fragments only when a code path needs them.
 */

/**
 * `EdgeResolver.PIN_SCHEMA_UID() -> bytes32` (EdgeResolver.sol:164-166) and
 * `TAG_SCHEMA_UID() -> bytes32` (EdgeResolver.sol:169-171). The edge-schema UID
 * getters, for registry assertions.
 */
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

/**
 * `EdgeResolver.getActivePinTarget(bytes32 definition, address attester,
 * bytes32 targetSchema) -> bytes32` (EdgeResolver.sol:846-852). O(1) read of the
 * active PIN's target UID for a slot — the primary Shape A read (file placement,
 * PROPERTY value binding, contentType). Returns bytes32(0) when the slot is empty.
 */
export const getActivePinTargetAbi = [
  {
    type: 'function',
    name: 'getActivePinTarget',
    stateMutability: 'view',
    inputs: [
      { name: 'definition', type: 'bytes32' },
      { name: 'attester', type: 'address' },
      { name: 'targetSchema', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * `EdgeResolver.getActivePin(bytes32 definition, address attester, bytes32 targetSchema)
 * -> bytes32` (EdgeResolver.sol:840-842). O(1) read of the active PIN's *attestation
 * UID* (vs. its target).
 */
export const getActivePinAbi = [
  {
    type: 'function',
    name: 'getActivePin',
    stateMutability: 'view',
    inputs: [
      { name: 'definition', type: 'bytes32' },
      { name: 'attester', type: 'address' },
      { name: 'targetSchema', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * `EdgeResolver.getActivePinSlot(bytes32 definition, address attester, bytes32 targetSchema)
 * -> SlotEntry` (EdgeResolver.sol:855-861). `SlotEntry` is `{ bytes32 pinUID; bytes32 targetID }`
 * (EdgeResolver.sol:224-227) — the UID and target in one read.
 */
export const getActivePinSlotAbi = [
  {
    type: 'function',
    name: 'getActivePinSlot',
    stateMutability: 'view',
    inputs: [
      { name: 'definition', type: 'bytes32' },
      { name: 'attester', type: 'address' },
      { name: 'targetSchema', type: 'bytes32' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'pinUID', type: 'bytes32' },
          { name: 'targetID', type: 'bytes32' },
        ],
      },
    ],
  },
] as const

/**
 * `EdgeResolver.getActiveTagWeight(address attester, bytes32 target, bytes32 definition,
 * bytes32 targetSchema) -> (bool exists, int256 weight)` (EdgeResolver.sol:946-956).
 * O(1) read of the raw stored `int256` weight of the active TAG at a slot. The
 * kernel returns weight verbatim — callers apply any threshold policy (ADR-0042 /
 * ADR-0054). `targetSchema = bytes32(0)` is the sentinel for an address-target TAG.
 *
 * Argument order is `(attester, target, definition, targetSchema)` — distinct from
 * the PIN reads' `(definition, attester, targetSchema)` order; transcribe carefully.
 */
export const getActiveTagWeightAbi = [
  {
    type: 'function',
    name: 'getActiveTagWeight',
    stateMutability: 'view',
    inputs: [
      { name: 'attester', type: 'address' },
      { name: 'target', type: 'bytes32' },
      { name: 'definition', type: 'bytes32' },
      { name: 'targetSchema', type: 'bytes32' },
    ],
    outputs: [
      { name: 'exists', type: 'bool' },
      { name: 'weight', type: 'int256' },
    ],
  },
] as const

/**
 * `EdgeResolver.getActiveTagEntries(bytes32 definition, address attester, bytes32 schema,
 * uint256 start, uint256 length) -> TagEntry[]` (EdgeResolver.sol:870-878). `TagEntry`
 * is `{ bytes32 tagUID; int256 weight }` (EdgeResolver.sol:237-240). Bulk list reader
 * returning (tagUID, weight) tuples in one SLOAD per slot.
 */
export const getActiveTagEntriesAbi = [
  {
    type: 'function',
    name: 'getActiveTagEntries',
    stateMutability: 'view',
    inputs: [
      { name: 'definition', type: 'bytes32' },
      { name: 'attester', type: 'address' },
      { name: 'schema', type: 'bytes32' },
      { name: 'start', type: 'uint256' },
      { name: 'length', type: 'uint256' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'tagUID', type: 'bytes32' },
          { name: 'weight', type: 'int256' },
        ],
      },
    ],
  },
] as const

/**
 * Combined `EdgeResolver` read ABI — composed from the per-function fragments above.
 */
export const edgeResolverAbi = [
  ...pinSchemaUidAbi,
  ...tagSchemaUidAbi,
  ...getActivePinTargetAbi,
  ...getActivePinAbi,
  ...getActivePinSlotAbi,
  ...getActiveTagWeightAbi,
  ...getActiveTagEntriesAbi,
] as const
