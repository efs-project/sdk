/**
 * Barrel for the vendored EFS read-path contract ABIs.
 *
 * Hand-written `as const` viem ABI fragments transcribed from the FROZEN contracts
 * (`packages/hardhat/contracts/*.sol`), cross-checked against the committed ABI
 * mirror `deployedContracts.ts`. Each per-contract module exports per-function
 * fragments plus a combined per-contract ABI (`<contract>Abi`). Mirrors the
 * vendoring style of `src/eas/abi.ts`.
 *
 * The combined per-contract ABIs are the primary surface and are re-exported by
 * name below. The per-function fragments are also re-exported, but because a few
 * fragment names collide across contracts (`pinSchemaUidAbi`, `tagSchemaUidAbi`,
 * `dataSchemaUidAbi`, `anchorSchemaUidAbi` — the same schema-UID getter exists on
 * multiple contracts), the fragments are exposed as per-contract namespaces
 * (`*AbiFragments`) to keep every fragment reachable without ambiguity. The
 * combined ABIs cover the vast majority of consumer needs; reach for a namespace
 * only when you need a single-function ABI to keep `encodeFunctionData` calldata
 * tight.
 */

// ── Combined per-contract ABIs (primary surface) ─────────────────────────────
export { routerAbi } from './router.js'
export { indexerAbi } from './indexer.js'
export { edgeResolverAbi } from './edgeResolver.js'
export { mirrorResolverAbi } from './mirrorResolver.js'
export { aliasResolverAbi } from './aliasResolver.js'
export {
  listResolverAbi,
  listEntryResolverAbi,
  listReaderAbi,
} from './listReader.js'
export { fileViewAbi } from './fileView.js'

// ── Per-contract fragment namespaces (collision-free access to single-fn ABIs) ─
export * as routerAbiFragments from './router.js'
export * as indexerAbiFragments from './indexer.js'
export * as edgeResolverAbiFragments from './edgeResolver.js'
export * as mirrorResolverAbiFragments from './mirrorResolver.js'
export * as aliasResolverAbiFragments from './aliasResolver.js'
export * as listAbiFragments from './listReader.js'
export * as fileViewAbiFragments from './fileView.js'
