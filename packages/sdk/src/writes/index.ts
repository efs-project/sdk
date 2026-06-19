/**
 * Writes layer — the pure, chain-free write-graph builders. The submitter
 * (a later slice) consumes these plans; nothing here touches the network.
 */

export {
  buildFileWriteGraph,
  isSymbolicRef,
  REF,
  ZERO_ADDRESS,
  ZERO_UID,
  type FileWriteGraph,
  type FileWriteGraphInput,
  type PlannedAttestation,
  type SymbolicRef,
  type RefOrUID,
  type PinDataRef,
  type ReservedKey,
  type WriteLayer,
} from './graph.js'

export {
  submitWriteTier1,
  WriteRevertedError,
  type SubmitContext,
  type SubmitWalletClient,
  type SubmitPublicClient,
  type Tier1WriteResult,
  type LayerResult,
  type RefMap,
} from './submit.js'
