---
"@efs/sdk": patch
---

Two fixes: (1) `getEnsAddress` is now chain-guarded like `readContract`/`getCode` — the client holds one provider, so an ENS-backed lens resolved during provider drift produced an attester from another chain's registry while the guarded EFS reads ran on the deployment chain (false absence, or another lens's data). Both the read path and `efs.lenses.resolve` now resolve through the guarded client. The earlier "cross-chain by nature" exemption bought nothing with a single client — it only made resolution nondeterministic. (2) Mirror-URI preflight now runs the SDK's structural parser for schemes the SDK itself resolves: `ipfs://!` and friends previously minted a valid MIRROR (the chain has no scheme allowlist by design) that no read could ever resolve, leaving `AllMirrorsFailedError` on a confirmed file. Unknown/custom schemes pass through untouched, preserving the ADR-0056 escape hatch.
