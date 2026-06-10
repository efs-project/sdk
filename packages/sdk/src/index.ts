/**
 * @efs-project/sdk — TypeScript SDK for the Ethereum File System (EFS).
 *
 * Status: scaffold. Public surface is shaped per planning/Designs/sdk-architecture.md;
 * method bodies are stubs (`NotImplemented`) until the build lands. The *shapes* below
 * are the load-bearing part — they encode decisions we don't want to break later
 * (the identity seam, the static-vs-dynamic reference split).
 */

import type { Address, PublicClient, WalletClient } from 'viem'

// ── Errors ───────────────────────────────────────────────────────────────────
// Discriminated error base so external callers catch typed errors, never raw RPC
// strings (ADR-0004, pending). Mirrors viem's BaseError ergonomics.

export class EfsError extends Error {
  override name = 'EfsError'
}

export class NotImplemented extends EfsError {
  override name = 'NotImplemented'
  constructor(what: string) {
    super(`${what} is not implemented yet (SDK scaffold).`)
  }
}

// ── Identity / lens seam (sdk-architecture §1–§3) ──────────────────────────────
// A lens is a *resolved set of attester addresses*, built from a configurable
// hierarchy (EFS contracts ADR-0039), not a bare address. v1 ships the trivial resolver
// (addr -> [addr]); ENS/key-set expansion drops in later, additively. The type
// stays opaque so N-vs-1 never leaks into a signature.

export type Lens = {
  readonly __brand: 'Lens'
  /** Resolve to the ordered attester set at read time. */
  resolve(): Promise<readonly Address[]>
}

/** An explicit, literal lens — exactly these addresses, never expanded. */
export function lens(_addresses: Address | readonly Address[]): Lens {
  throw new NotImplemented('lens()')
}

/** An identity that may expand (ENS -> key-set -> ordered lens). Resolves at read time. */
export function identity(_ensOrAddress: string): Lens {
  throw new NotImplemented('identity()')
}

// ── Static vs dynamic references (sdk-architecture §5) ─────────────────────────
// Distinct types that never silently interconvert. A DataRef is "these exact
// bytes / this version" (UID). A PathRef is "whatever is active here now".

export type DataRef = { readonly __brand: 'DataRef'; readonly uid: `0x${string}` }
export type PathRef = { readonly __brand: 'PathRef'; readonly path: string }

// ── Client ─────────────────────────────────────────────────────────────────────

export type EfsClientConfig = {
  publicClient: PublicClient
  /** Required for writes; reads work without it. */
  walletClient?: WalletClient
  /** Default lens when none is passed to a read. Defaults to the connected wallet. */
  defaultLens?: Lens
}

export type EfsClient = {
  /** Read the file at a path, resolved through a lens. */
  read(path: string, opts?: { as?: Lens }): Promise<DataRef | null>
  /** Pin (write) a file. Batches the underlying attestations (sdk-architecture §6). */
  pinFile(path: string, content: Uint8Array): Promise<DataRef>
  /** Clean viem-native access to the underlying EAS layer (ADR-0002). */
  readonly eas: unknown
}

export function createEfsClient(_config: EfsClientConfig): EfsClient {
  throw new NotImplemented('createEfsClient()')
}

export const version = '0.0.0'
