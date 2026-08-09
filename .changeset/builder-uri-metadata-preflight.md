---
"@efs/sdk": patch
---

The exported graph builder gains the full byte-plan preflight: (1) every mirror URI is validated (`validateMirrorUri` — blank/oversized URIs previously encoded fine and reverted at the layer-2 MirrorResolver AFTER layer 1 mined, leaving a paid partial graph); (2) `contentHash` and `size` are verified against the supplied bytes before any layer is constructed — the `ContentHash` brand checks format only, so a stale hash from changed bytes persisted permanently and made every fail-closed read (`readText` etc.) reject forever, while a wrong size attested false metadata. `hashContent` is synchronous, so the builder stays pure and sync; the orchestrated `fs.write` path derives both values itself and is unaffected.
