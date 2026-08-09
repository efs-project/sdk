---
"@efs/sdk": patch
---

`parseWeb3Uri` now redacts before truncating the URI it rejects. It is a public export, so its argument is arbitrary — and both error paths sliced the head of the raw string, meaning `https://alice:hunter2@…` printed `https://alice:hu`. Summarizing first keeps the messages short while stripping userinfo and inline `data:` bodies. Found by sweeping for the pattern behind the wrapped-parser-error leak rather than waiting for it to be reported; severity is lower than the mirror-URI leaks (the string is the caller's own, not one read from the chain), but it was the last unredacted URI-in-error site in the package.
