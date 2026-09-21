/**
 * Vendored `AliasResolver` read-path ABI fragments.
 *
 * Hand-written `as const` viem ABI covering the REDIRECT resolver's read surface.
 *
 * Source of truth: `packages/hardhat/contracts/AliasResolver.sol`. `AliasResolver`
 * is write-time-guards-only (no self-loop, per-kind typing); it does NOT do
 * read-time redirect resolution — multi-hop `sameAs` / `supersededBy` / `symlink`
 * resolution is client/spec logic over EAS reads (ADR-0050). Its only reads are
 * the schema-UID getters used for registry assertions and write-time type checks.
 * Not redeployable — baked into REDIRECT_SCHEMA_UID at registration.
 *
 * Keep this minimal — add fragments only when a code path needs them.
 */

/**
 * `AliasResolver.redirectSchemaUID() -> bytes32` (AliasResolver.sol:145-147). The
 * REDIRECT schema UID this resolver validates.
 */
export const redirectSchemaUidAbi = [
  {
    type: 'function',
    name: 'redirectSchemaUID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * `AliasResolver.dataSchemaUID() -> bytes32` (AliasResolver.sol:150-152). DATA schema
 * UID used to type-check sameAs / supersededBy endpoints and symlink targets.
 */
export const dataSchemaUidAbi = [
  {
    type: 'function',
    name: 'dataSchemaUID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * `AliasResolver.anchorSchemaUID() -> bytes32` (AliasResolver.sol:155-157). ANCHOR
 * schema UID used to type-check symlink sources (and accept symlink targets).
 */
export const anchorSchemaUidAbi = [
  {
    type: 'function',
    name: 'anchorSchemaUID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * Combined `AliasResolver` read ABI — composed from the per-function fragments above.
 */
export const aliasResolverAbi = [
  ...redirectSchemaUidAbi,
  ...dataSchemaUidAbi,
  ...anchorSchemaUidAbi,
] as const
