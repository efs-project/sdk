/**
 * Vendored `EFSRouter` read-path ABI fragments.
 *
 * Hand-written `as const` viem ABI covering only the `EFSRouter` view surface the
 * SDK calls for `web3://` resolution (ERC-5219) and URL classification. Struct
 * shapes and signatures are transcribed verbatim from the FROZEN contract source
 * (cite `file:line`), cross-checked against the committed ABI mirror
 * `contracts/packages/nextjs/contracts/deployedContracts.ts` (`EFSRouter` entry)
 * for component names / order.
 *
 * Source of truth: `packages/hardhat/contracts/EFSRouter.sol` (the redeployable
 * stateless view, ADR-0033). The contract `EFSRouter` exposes exactly three
 * public reads of its own: `request`, `resolveMode`, `classifyTopLevel`.
 * (`resolvePath` / `resolveAnchor` live on `EFSIndexer` — see `indexer.ts` — the
 * router delegates to them internally; they are NOT router-contract functions.)
 *
 * Keep this minimal — add fragments only when a code path needs them. Matches the
 * vendoring style of `src/eas/abi.ts`.
 */

/**
 * `EFSRouter.request(string[] resource, KeyValue[] params)` — the EIP-5219 /
 * EIP-6944 manual-resolve-mode read entrypoint (EFSRouter.sol:199-202). `KeyValue`
 * is `{ string key; string value }` (IDecentralizedApp.KeyValue, EFSRouter.sol:9-12).
 * Returns `(uint256 statusCode, bytes body, KeyValue[] headers)`.
 */
export const requestAbi = [
  {
    type: 'function',
    name: 'request',
    stateMutability: 'view',
    inputs: [
      { name: 'resource', type: 'string[]' },
      {
        name: 'params',
        type: 'tuple[]',
        components: [
          { name: 'key', type: 'string' },
          { name: 'value', type: 'string' },
        ],
      },
    ],
    outputs: [
      { name: 'statusCode', type: 'uint256' },
      { name: 'body', type: 'bytes' },
      {
        name: 'headers',
        type: 'tuple[]',
        components: [
          { name: 'key', type: 'string' },
          { name: 'value', type: 'string' },
        ],
      },
    ],
  },
] as const

/**
 * `EFSRouter.resolveMode() -> bytes32` — EIP-6944 manual-resolve-mode marker;
 * returns the ASCII `"5219"` (EFSRouter.sol:148-150).
 */
export const resolveModeAbi = [
  {
    type: 'function',
    name: 'resolveMode',
    stateMutability: 'pure',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * `EFSRouter.classifyTopLevel(string segment) -> (uint8 flavor, bytes32 uid)`
 * (EFSRouter.sol:681-684). Public wrapper around the URL top-level classifier so
 * off-chain clients can keep a byte-identical classifier (ADR-0033). `flavor` is a
 * uint8-cast `ContainerFlavor` enum: 0 = Anchor, 1 = Address, 2 = Schema,
 * 3 = Attestation (EFSRouter.sol:115-120).
 */
export const classifyTopLevelAbi = [
  {
    type: 'function',
    name: 'classifyTopLevel',
    stateMutability: 'view',
    inputs: [{ name: 'segment', type: 'string' }],
    outputs: [
      { name: 'flavor', type: 'uint8' },
      { name: 'uid', type: 'bytes32' },
    ],
  },
] as const

/**
 * Combined `EFSRouter` read ABI — composed from the per-function fragments above
 * (mirrors `easAbi`'s composition style).
 */
export const routerAbi = [...requestAbi, ...resolveModeAbi, ...classifyTopLevelAbi] as const
