# Examples

Runnable consumers of the EFS SDK, kept in the workspace so they stay in sync with the packages.

| Example | Shows | Status |
|---|---|---|
| `ts-quickstart/` | Use `@efs-project/sdk` from a TypeScript app (read a file, pin a file). | planned |
| `foundry-consumer/` | Import `@efs-project/solidity` into a Foundry project via remappings. | planned |
| `hardhat-consumer/` | Import `@efs-project/solidity` into a Hardhat project via `node_modules`. | planned |

> **Status: scaffold.** The directories above are planned and land alongside the package implementations. Each example doubles as an acceptance test for the "easy for external devs" goal — if it isn't copy-paste simple, the SDK API needs work, not the example.
