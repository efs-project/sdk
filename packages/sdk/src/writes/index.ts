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

export { writeFileTier1, resolveMirrors, type FileWriteContext } from './file.js'

export {
  storeOnchain,
  buildSstore2InitCode,
  DEFAULT_ONCHAIN_AUTO_LIMIT,
  MAX_SINGLE_CHUNK_BYTES,
  EFS_BYTES_STORE_ABI,
  PayloadTooLarge,
  MultiChunkUnsupported,
  type OnchainStoreContext,
  type OnchainWalletClient,
  type OnchainPublicClient,
} from './onchain.js'
