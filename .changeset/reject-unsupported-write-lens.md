---
"@efs/sdk": patch
---

> **Option renamed in the same release**: the write-side option is now `author` (the v1-profile change — a lens is reader policy; the write-side identity is the author). The guard semantics below are unchanged under the new name.

`fs.write`/`fs.setOverview` now reject a `lens` other than the connected account with a
typed `NotImplemented` error instead of silently ignoring it. The Tier-1 write path always
attests as the wallet account (EFS lenses key on the attester), so a foreign `opts.lens`
was accepted but never honored — the file was authored under the wallet lens, invisible to
reads/lists through the requested lens, with no signal to the caller. Until delegated/
foreign-lens writes land, a mismatched lens fails fast; passing the connected account (or
omitting `lens`) is unchanged.
