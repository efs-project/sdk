---
"@efs/sdk": patch
---

The mirror-readability gate every write path runs before minting a placement, symlink or hardlink is now one shared predicate (`hasActiveMirror`). The check had been re-derived at five call sites and the copies drifted: after the reader moved to scanning the newest `MAX_MIRRORS` slots, some gates were still scanning raw slots `[0, 500)`, so a caller with a fresh mirror past slot 500 was refused a write the reader and the router could both serve — while a mirror stranded below the readable window was accepted, producing a placement that confirms and then fails every read with `AllMirrorsFailed`. A gate that disagrees with the reader is worse than no gate. The shared predicate also reads UIDs rather than decoded rows and exits on the first hit, so the healthy case costs one count read plus one window.
