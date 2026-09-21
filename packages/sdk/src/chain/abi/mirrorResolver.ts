/**
 * Vendored `MirrorResolver` read-path ABI fragments.
 *
 * Hand-written `as const` viem ABI covering the MIRROR resolver's read surface.
 *
 * Source of truth: `packages/hardhat/contracts/MirrorResolver.sol`. NOTE: the
 * per-DATA *mirror lookup* (`getDataMirrors`) does NOT live here — it lives on
 * `EFSFileView` (see `fileView.ts`); `MirrorResolver` is the write-time schema hook
 * (URI scheme allowlist + transport-ancestry check) and holds only the well-known
 * transports anchor and the URI length cap as reads. Not redeployable — wired into
 * `EFSIndexer`.
 *
 * Keep this minimal — add fragments only when a code path needs them.
 */

/**
 * `MirrorResolver.transportsAnchorUID() -> bytes32` — public state var auto-getter
 * (MirrorResolver.sol:117). The `/transports/` root anchor; a MIRROR's transport
 * definition must be a descendant of it (ADR-0011/0012/0023).
 */
export const transportsAnchorUidAbi = [
  {
    type: 'function',
    name: 'transportsAnchorUID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * `MirrorResolver.MAX_URI_LENGTH() -> uint256` — public constant auto-getter
 * (MirrorResolver.sol). The MIRROR URI length cap (ADR-0022).
 */
export const maxUriLengthAbi = [
  {
    type: 'function',
    name: 'MAX_URI_LENGTH',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/**
 * Combined `MirrorResolver` read ABI — composed from the per-function fragments above.
 */
export const mirrorResolverAbi = [...transportsAnchorUidAbi, ...maxUriLengthAbi] as const
