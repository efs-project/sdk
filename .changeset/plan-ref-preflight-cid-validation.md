---
"@efs/sdk": patch
---

Two preflight fixes: (1) `submitLayeredTier1` validates the WHOLE plan's symbolic wiring before broadcasting layer 1 — every symbolic reference must name a ref minted in a strictly earlier layer, and ref ids must be unique. A malformed later layer previously mined (and charged for) its earlier layers first, then threw a generic error carrying none of the structured partial-write recovery state. (2) Mirror write-preflight decodes IPFS CIDs properly (multibase + CID structure: CIDv0 base58btc, CIDv1 in base32/base16/base58btc) instead of only checking the alphabet, so `ipfs://x` no longer mints a MIRROR that no gateway can resolve. Read behavior is deliberately unchanged — `resolveTransport` stays as tolerant as the gateways, the same read-tolerant/write-strict split used for `web3://`.
