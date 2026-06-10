# ADR-0004: Publish via npm Trusted Publishing (OIDC), not a stored token

**Status:** Accepted
**Date:** 2026-06-10
**Related:** ADR-0001, `.github/workflows/release.yml`

## Context

We publish `@efs/sdk` and `@efs/solidity` to npm from CI. The classic approach is a long-lived npm **automation token** stored as a GitHub secret (`NPM_TOKEN`). Long-lived publish tokens are a supply-chain liability: if leaked (CI log, compromised action, exfiltrated secret) an attacker can publish malicious versions. In July 2025 npm made **Trusted Publishing via OIDC** generally available — CI authenticates to npm with a short-lived OIDC token tied to the specific repo + workflow, and **no token is stored**.

## Decision

Publish using **npm Trusted Publishing (OIDC)** from `.github/workflows/release.yml` (Changesets-driven). No `NPM_TOKEN` secret.

Setup (one-time, requires the npm org owner):
- Create the npm org `efs` (reserves the `@efs` scope; free for public packages). Enable org 2FA.
- For **each** package on npmjs.com → Settings → **Trusted Publisher** → GitHub repo `efs-project/sdk`, workflow `.github/workflows/release.yml`.
- The workflow declares `permissions: id-token: write`, uses Node ≥ 22.14 / npm ≥ 11.5.1, and the **repo must stay public** (OIDC provenance is not emitted from private repos).

Mechanics: a merge to `main` runs the Changesets "Version Packages" PR; merging that publishes the changed packages. Provenance is attached automatically — no `--provenance` flag, no `publishConfig.provenance` needed.

## Consequences

- **No long-lived publish secret** to leak or rotate — the biggest supply-chain win for a published SDK.
- Provenance ships free, so consumers can verify packages were built from this repo.
- Constraints to honour: repo stays public; Node/npm version floor in CI; per-package Trusted Publisher config must exist before the first publish or it fails loudly (no silent fallback).
- Caveat to validate against our setup: `changesets/action` + OIDC has had rough edges (see changesets/action#542); confirm the publish step runs in a job with `id-token: write` and the action version cooperates. If it can't, the fallback is a granular, short-expiry token — still better than a classic automation token.

## Alternatives considered

- **Classic automation token (`NPM_TOKEN`)** — rejected: long-lived, broad scope, the exact thing OIDC removes.
- **Granular access token** — better (scoped, expiring) but still a stored secret to rotate; kept only as the fallback if OIDC tooling blocks us.
