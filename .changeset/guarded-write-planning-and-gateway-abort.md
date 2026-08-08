---
"@efs/sdk": patch
---

Two review fixes: `fs.write`/`setOverview` planning reads (the parent walk, overwrite probe, visibility-tag checks, transport lookups) now run through the chain-guarded client pinned to the deployment — the single entry preflight couldn't cover that multi-RPC window, so a provider drifting mid-planning and back could bake chain-B parent/anchor UIDs into a plan the per-tx guards then submitted on chain A; each planning read now fails closed on drift (pre+post-checked). And cancellation propagates between GATEWAY attempts too — an abort during the first IPFS/Arweave gateway no longer surfaces as `AllMirrorsFailedError` when the transport had another candidate URL.
