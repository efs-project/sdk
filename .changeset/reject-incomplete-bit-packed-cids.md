---
"@efs/sdk": patch
---

The bit-packed multibase decoders (the base2/base8/base16/base32 families) now reject a body that carries more bits than the bytes it spells, instead of silently dropping the trailing partial byte. Appending one hex nibble to a valid base16 CID — or one character to a valid base32 CID — produced the SAME decoded bytes and cleared every structural CID check, so the malformed locator could be minted as a file's only mirror and then 404 at a strict IPFS gateway: a write that confirms and can never be read. RFC 4648 leaves at most `bits - 1` padding bits and they are zero; anything more is now refused. Valid CIDv0/CIDv1 locators in every multibase the table decodes are unaffected.
