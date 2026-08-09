---
"@efs/sdk": patch
---

The viem-form write-capable overload of `createEfsV1Client` now requires an account-BOUND wallet client (`walletClient.account: Account`). An unbound wallet (`createWalletClient({ chain, transport })`) cannot sign — every write verb it advertised threw `WalletRequired` at runtime — so it now falls through to the read-only overload and gets `EfsReadClient`. A wallet whose account is statically `Account | undefined` also types as read-only: narrow the wallet (or rebuild it with the account bound) to get the write surface. Runtime behavior is unchanged.
