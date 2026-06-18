/**
 * EAS layer — the SDK's self-contained, viem-native interface to the Ethereum
 * Attestation Service (ADR-0002: no ethers, no eas-sdk; ABIs vendored here).
 *
 * Public surface:
 *   - ABI consts for `attest` / `multiAttest` / `getAttestation` / `getSchema`.
 *   - `SchemaEncoder` for ABI-encoding/decoding attestation `data`.
 *   - `buildAttest` / `buildMultiAttest` request builders.
 *   - `computeAttestationUID` / `verifyAttestationUID` for UID re-derivation.
 */

export {
  attestAbi,
  multiAttestAbi,
  getAttestationAbi,
  getSchemaAbi,
  easAbi,
  schemaRegistryAbi,
} from './abi.js'

export {
  SchemaEncoder,
  parseSchema,
  type SchemaField,
} from './schema-encoder.js'

export {
  EFS_SCHEMA_FIELDS,
  type EfsSchemaName,
} from './schemas.js'

export {
  buildAttest,
  buildMultiAttest,
  type AttestationRequest,
  type AttestationRequestData,
  type MultiAttestationRequest,
  type ContractCall,
} from './attest.js'

export {
  computeAttestationUID,
  verifyAttestationUID,
  type AttestationUIDInput,
  type MinedAttestation,
} from './uid.js'
