---
"@efs/sdk": patch
---

Seed the shared community **devnet** (chainId `26001993`) in the built-in deployments
registry. The devnet is a Sepolia fork (contracts ADR-0062), so its contract addresses and
the 9 schema UIDs are byte-identical to Sepolia — CREATE/CREATE2 and EAS schema UIDs are
chain-id-independent, only the network identity differs. Devs can now point a viem client
at the devnet RPC and the SDK resolves the deployment automatically (no `deployments`
override), giving a frictionless place to try EFS without burdening Sepolia or running a
local node. The Sepolia entry is unchanged.
