---
"@efs/sdk": patch
---

`props.list`'s key-scan budget now clamps the window LENGTH, not just the page starts. `maxKeys: 10` previously still requested a full 256-row window (and decoded + value-read all of it), and `maxKeys: 300` processed 512 — defeating the caller-controlled anti-griefing bound the option documents. The final window now asks for exactly the remaining budget.
