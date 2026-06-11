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
 * Combined EAS ABI for the functions the SDK calls on the EAS contract
 * (`attest`, `multiAttest`, `getAttestation`). `getSchema` lives on the
 * separate SchemaRegistry contract and is exported on its own.
 */
export const easAbi = [...attestAbi, ...multiAttestAbi, ...getAttestationAbi] as const

/** SchemaRegistry ABI subset (just `getSchema`). */
export const schemaRegistryAbi = [...getSchemaAbi] as const
