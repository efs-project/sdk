# ADR-0007: Error model — viem-`BaseError`-grade typed tree

**Status:** Accepted
**Date:** 2026-06-11
**Related:** ADR-0008 (public API), `src/errors.ts`

## Context

External callers need to handle SDK failures programmatically — distinguish a missing file from a wallet-not-connected from an on-chain revert — without string-matching RPC errors. A bare `Error` subtree (just `name`) is too thin; viem set the bar with `BaseError` (`shortMessage`, `walk()`, cause chains), and it's the most-copied part of viem's DX.

## Decision

`EfsError` is the base of a typed tree modeled on viem's `BaseError`:

- **`shortMessage`** — the headline, separate from any appended `details`.
- **`code: EfsErrorCode`** — a stable, switchable discriminant. The type is an **open string-union** (`… | (string & {})`), never a TS `enum`, so adding a code is not a breaking change to an exhaustive `switch`.
- **`cause`** — passed through to `Error`'s `cause` (wraps the underlying viem/RPC error).
- **`walk(fn?)`** — traverse the cause chain; with `fn`, return the first match (or `null`); without, the deepest cause. Mirrors `viem`'s `BaseError.walk`.

Subclasses set a distinct `name` + `code`: `NotImplemented`, `WalletRequired`, `LensRequired`, `MaxLensesExceeded`, `SchemaMismatchError`, `DeploymentNotFound`, `CursorInvalid`, `PartialBatchFailure`. New failure modes (transport, mirror-scheme-rejected, list-constraint, partial-batch detail) are added as subclasses + codes over time — additive, never breaking, because callers catch `EfsError` and/or switch on the open `code`.

## Consequences

- Callers can `catch (e) { if (e instanceof EfsError) switch (e.code) … }` or `e.walk(x => x instanceof ContractFunctionRevertedError)` for the underlying revert.
- The `code` union being open-ended is the load-bearing future-proofing — adding a code never forces downstream churn.
- `WalletRequired` is the runtime backstop behind the type-level write gate (ADR-0008); both exist on purpose.

## Alternatives considered

- **Bare `Error` subclasses (name only)** — rejected: no `shortMessage`/`code`/`walk`, forces string-matching for the common "what went wrong" branch.
- **A TS `enum` for codes** — rejected: enum additions + the class-vs-code duality are a known trap; an open string-union is additive-safe.
