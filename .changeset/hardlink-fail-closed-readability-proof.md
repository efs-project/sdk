---
"@efs/sdk": patch
---

The hardlink gate hardens further: (1) a hardlink plan whose placement PIN has a symbolic or missing `refUID` now FAILS CLOSED instead of skipping every check — a crafted plan could otherwise mint a non-DATA in an earlier layer and place it into the wrong schema slot unverified. (2) The gate now also proves READABILITY before broadcasting: authorship + schema were not enough, since a self-authored bare DATA (minted via the raw EAS verbs) hardlinked "successfully" and then every `read()` failed `AllMirrorsFailed`. The gate scans for at least one ACTIVE mirror authored by the submitter on the target (raw-count-bounded filtered windows, first-hit early exit) via the new `SubmitContext.indexerAddress` (required for hardlink submissions, wired by the write orchestrator) and the new `FileWriteGraph.mirrorSchemaUID` stamp — both fail closed when absent.
