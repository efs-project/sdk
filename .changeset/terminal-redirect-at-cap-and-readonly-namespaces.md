---
"@efs/sdk": patch
---

> **Redirect half superseded in the same release**: `followRedirectChain` and `RedirectHopLimit` were replaced wholesale by the ratified specs/09 engine (see the ratified-redirect-resolution change) — the at-cap-terminal semantics survive inside `walkSymlinks`. The read-only-namespace half below stands.

Two fixes:

- **A redirect chain whose length equals the hop cap is no longer rejected.** `followRedirectChain`
  threw `RedirectHopLimit` unconditionally after consuming `cap` followable hops, even when the
  destination of the last hop was a terminal (e.g. `followRedirects: 1` for `A → B` with no
  redirect from `B`). It now does a final terminal check after the last allowed hop: a chain that
  terminates exactly at the cap is valid; it only fails closed when a genuine further followable
  hop (or a cycle) exists past the cap.
- **Read-only clients now type-expose the standalone read namespaces.** `EfsReadClient` omitted
  `graph`/`props`/`mirrors`/`redirects` entirely, even though the returned object includes them
  and their read verbs (`tags.active/list`, `pins.active`, `props.get/list`, `mirrors.list`,
  `redirects.get`) are lens-scoped and need no wallet. TypeScript callers on a read-only client
  can now reach those reads without an unsafe cast; the mutators (`add`/`set`/`place`/`remove`)
  remain gated to the write-capable `EfsClient`. (New `TagsReadNs`/`PinsReadNs`/`EfsGraphReadNs`/
  `PropsReadNs`/`MirrorsReadNs`/`RedirectsReadNs` types, derived from the full namespaces.)
