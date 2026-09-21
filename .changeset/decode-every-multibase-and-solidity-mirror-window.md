---
"@efs/sdk": patch
"@efs/solidity": patch
---

Close the two gaps left by the previous mirror fixes. The IPFS CID check no longer has an alphabet-only path: every accepted multibase (base2/8/10/16/32 families, base36, base58btc, base58flickr) is really decoded and the bytes face the same version/codec/multihash parse, so `ipfs://k0000000000` — well-formed base36, not a CID — is refused. And the Solidity SDK's `_requireActiveMirror` now scans the newest 500 raw slots like the TypeScript reader and `EFSRouter`, instead of the oldest 500: an active mirror stranded below the readable window no longer lets a placement through, and one past the 500th slot no longer blocks a readable DATA.
