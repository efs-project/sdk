/**
 * Single source of truth for the **frozen 9-schema field strings** (Sepolia
 * freeze; contracts repo `docs/SEPOLIA_FREEZE_TABLE.md`). These are the exact,
 * byte-identical EAS field strings each EFS schema was registered with — the
 * input to both UID derivation
 * (`UID = keccak256(abi.encodePacked(fieldString, resolver, revocable))`) and
 * {@link SchemaEncoder} construction for encoding/decoding attestation `data`.
 *
 * Changing any string here is a Tier-1 break: it derives a different UID and
 * orphans the schema's on-chain data. Edit only to mirror a re-frozen contracts
 * table (and then via supersession, see ADR-0012).
 *
 * `DATA` is the empty schema (`''`, pure identity, ADR-0049) — it encodes to
 * `0x`. `REDIRECT` is the new first-class primitive (ADR-0050).
 */
export const EFS_SCHEMA_FIELDS = {
  anchor: 'string name, bytes32 forSchema',
  /** Non-revocable interned value (ADR-0052). */
  property: 'string value',
  /** Empty schema — pure identity (ADR-0049). */
  data: '',
  pin: 'bytes32 definition',
  tag: 'bytes32 definition, int256 weight',
  mirror: 'bytes32 transportDefinition, string uri',
  list: 'bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries',
  listEntry: 'bytes32 listUID, bytes32 target',
  /** Redirect primitive (ADR-0050); resolver = AliasResolver. */
  redirect: 'bytes32 target, uint16 kind',
} as const

/** The frozen schema keys (the 9-schema canonical set). */
export type EfsSchemaName = keyof typeof EFS_SCHEMA_FIELDS
