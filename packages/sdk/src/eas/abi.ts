/**
 * Vendored EAS contract ABI fragments (ADR-0002: viem-only, no eas-sdk).
 *
 * These are hand-written `as const` viem ABI consts covering only the EAS
 * surface the SDK uses: `attest`, `multiAttest`, `getAttestation`, and the
 * schema registry's `getSchema`. Struct shapes mirror the EAS contracts
 * exactly:
 *
 *   - `AttestationRequestData` / `AttestationRequest` / `MultiAttestationRequest`
 *     from `IEAS.sol` (lines 10-38).
 *   - `Attestation` (the `getAttestation` return) from `Common.sol` (lines 26-37).
 *   - `SchemaRecord` (the `getSchema` return) from `ISchemaRegistry.sol`
 *     (lines 10-15); `resolver` is an `address` here (the `ISchemaResolver`
 *     contract type is an address on the wire).
 *
 * Keep this minimal — add fragments only when a code path needs them.
 */

/** `IEAS.attest(AttestationRequest)` — single attestation. Returns the new UID. */
export const attestAbi = [
  {
    type: 'function',
    name: 'attest',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'request',
        type: 'tuple',
        components: [
          { name: 'schema', type: 'bytes32' },
          {
            name: 'data',
            type: 'tuple',
            components: [
              { name: 'recipient', type: 'address' },
              { name: 'expirationTime', type: 'uint64' },
              { name: 'revocable', type: 'bool' },
              { name: 'refUID', type: 'bytes32' },
              { name: 'data', type: 'bytes' },
              { name: 'value', type: 'uint256' },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * `IEAS.multiAttest(MultiAttestationRequest[])` — batched attestations grouped
 * by schema. Returns the flattened list of new UIDs.
 */
export const multiAttestAbi = [
  {
    type: 'function',
    name: 'multiAttest',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'multiRequests',
        type: 'tuple[]',
        components: [
          { name: 'schema', type: 'bytes32' },
          {
            name: 'data',
            type: 'tuple[]',
            components: [
              { name: 'recipient', type: 'address' },
              { name: 'expirationTime', type: 'uint64' },
              { name: 'revocable', type: 'bool' },
              { name: 'refUID', type: 'bytes32' },
              { name: 'data', type: 'bytes' },
              { name: 'value', type: 'uint256' },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
] as const

/** `IEAS.getAttestation(bytes32) -> Attestation` (Common.sol struct). */
export const getAttestationAbi = [
  {
    type: 'function',
    name: 'getAttestation',
    stateMutability: 'view',
    inputs: [{ name: 'uid', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'uid', type: 'bytes32' },
          { name: 'schema', type: 'bytes32' },
          { name: 'time', type: 'uint64' },
          { name: 'expirationTime', type: 'uint64' },
          { name: 'revocationTime', type: 'uint64' },
          { name: 'refUID', type: 'bytes32' },
          { name: 'recipient', type: 'address' },
          { name: 'attester', type: 'address' },
          { name: 'revocable', type: 'bool' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
  },
] as const

/**
 * `IEAS.Attested(address indexed recipient, address indexed attester, bytes32 uid,
 * bytes32 indexed schemaUID)` (IEAS.sol). Emitted once per created attestation, in
 * submission order, by both `attest` and `multiAttest`. Only `uid` is non-indexed
 * (carried in the log `data`); `recipient`/`attester`/`schemaUID` are topics.
 *
 * The Tier-1 submitter parses these out of a mined receipt — in log order — to
 * recover the real UID minted for each planned attestation (EAS does not return
 * the UIDs in a way the tx receipt exposes other than this event).
 */
export const attestedEventAbi = [
  {
    type: 'event',
    name: 'Attested',
    anonymous: false,
    inputs: [
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'attester', type: 'address', indexed: true },
      { name: 'uid', type: 'bytes32', indexed: false },
      { name: 'schemaUID', type: 'bytes32', indexed: true },
    ],
  },
] as const

/** `ISchemaRegistry.getSchema(bytes32) -> SchemaRecord`. */
export const getSchemaAbi = [
  {
    type: 'function',
    name: 'getSchema',
    stateMutability: 'view',
    inputs: [{ name: 'uid', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'uid', type: 'bytes32' },
          { name: 'resolver', type: 'address' },
          { name: 'revocable', type: 'bool' },
          { name: 'schema', type: 'string' },
        ],
      },
    ],
  },
] as const

/**
 * EAS custom-error fragments (transcribed from eas-contracts EAS.sol/IEAS.sol —
 * all zero-arg). Required so viem can populate `ContractFunctionRevertedError
 * .data.errorName` when an `attest`/`multiAttest` call reverts; without them the
 * error classifier (errors.ts) can't map e.g. `InvalidSchema` → `SchemaMismatch`
 * and EAS reverts fall through as generic. (Codex P2.)
 */
const easErrorsAbi = [
  { type: 'error', name: 'AccessDenied', inputs: [] },
  { type: 'error', name: 'AlreadyRevoked', inputs: [] },
  { type: 'error', name: 'AlreadyRevokedOffchain', inputs: [] },
  { type: 'error', name: 'AlreadyTimestamped', inputs: [] },
  { type: 'error', name: 'DeadlineExpired', inputs: [] },
  { type: 'error', name: 'InsufficientValue', inputs: [] },
  { type: 'error', name: 'InvalidAttestation', inputs: [] },
  { type: 'error', name: 'InvalidAttestations', inputs: [] },
  { type: 'error', name: 'InvalidEAS', inputs: [] },
  { type: 'error', name: 'InvalidExpirationTime', inputs: [] },
  { type: 'error', name: 'InvalidLength', inputs: [] },
  { type: 'error', name: 'InvalidOffset', inputs: [] },
  { type: 'error', name: 'InvalidRegistry', inputs: [] },
  { type: 'error', name: 'InvalidRevocation', inputs: [] },
  { type: 'error', name: 'InvalidRevocations', inputs: [] },
  { type: 'error', name: 'InvalidSchema', inputs: [] },
  { type: 'error', name: 'InvalidSignature', inputs: [] },
  { type: 'error', name: 'InvalidVerifier', inputs: [] },
  { type: 'error', name: 'Irrevocable', inputs: [] },
  { type: 'error', name: 'NotFound', inputs: [] },
  { type: 'error', name: 'NotPayable', inputs: [] },
  { type: 'error', name: 'WrongSchema', inputs: [] },
] as const

/**
 * Combined EAS ABI for the functions the SDK calls on the EAS contract
 * (`attest`, `multiAttest`, `getAttestation`) plus the custom-error fragments so
 * reverts decode to named errors. `getSchema` lives on the separate
 * SchemaRegistry contract and is exported on its own.
 */
export const easAbi = [
  ...attestAbi,
  ...multiAttestAbi,
  ...getAttestationAbi,
  ...attestedEventAbi,
  ...easErrorsAbi,
] as const

/** SchemaRegistry ABI subset (just `getSchema`). */
export const schemaRegistryAbi = [...getSchemaAbi] as const
