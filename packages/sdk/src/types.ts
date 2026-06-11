/** Public value shapes. Branded UID kinds because wrong-UID-kind is the dominant
 * integration bug (review DX-13). Static `DataRef` vs dynamic `PathRef` never
 * silently interconvert (sdk-architecture §5). */

import type { Address, Hex } from 'viem'
import type { VerificationStatus } from './content/hash.js'

export type DataUID = Hex & { readonly __kind: 'DataUID' }

/** Static reference — these exact bytes / this version. */
export type DataRef = { readonly __brand: 'DataRef'; readonly uid: DataUID }
/** Dynamic reference — whatever is active at this path now. */
export type PathRef = { readonly __brand: 'PathRef'; readonly path: string }

/** A durable, serializable write session. `steps` are idempotent per (path-qualified)
 * id so a resume skips only mined work and never double-mints (review B3). */
export type WriteReceipt = {
  contentHash: string
  data?: DataRef
  steps: Array<{ id: string; uid?: Hex; done: boolean }>
  signatureCount: number
  mechanism: 'multiAttest-sequential' | 'eip5792' | 'erc4337'
}

/** A resolved read: the data ref plus which attester/lens won (review UX-4). */
export type ReadResult = { data: DataRef; resolvedBy: Address }

/** Fetched bytes + trust-relative verification (never a bare "verified"). */
export type EfsFile = {
  bytes: Uint8Array
  contentType?: string
  verification: VerificationStatus
  hashAuthor?: Address
}

export type WriteEstimate = {
  attestations: number
  transactions: number
  signatureCount: number
  chunkDeploys: number
  gas: bigint
  estimatedUSD?: number
  warnings: string[]
}

export type Stat = { exists: boolean; data?: DataRef; resolvedBy?: Address }

export type WriteOptions = {
  contentType?: string
  onProgress?: (p: { step: number; total: number; phase: string }) => void
  resume?: WriteReceipt
  signal?: AbortSignal
}
