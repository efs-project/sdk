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
  submitLayeredTier1,
  WriteRevertedError,
  type SubmitContext,
  type SubmitWalletClient,
  type SubmitPublicClient,
  type Tier1WriteResult,
  type LayeredWriteResult,
  type LayerResult,
  type RefMap,
} from './submit.js'

// Standalone edge/value write primitives (TAG / PROPERTY-triple / PIN) — pure plan
// builders reusing the file-write attestation shapes, the shared edge submit, and
// the per-primitive namespaces (graph.tags / props / graph.pins).
export {
  buildTagPlan,
  buildPropertyPlan,
  buildPlacementPinPlan,
  EDGE_REF,
  DEFAULT_TAG_WEIGHT,
} from './edge.js'
export { submitEdgePlan, type EdgeSubmitContext } from './edge-submit.js'
export {
  makeTagsNs,
  resolveTagDefinition,
  type TagsNs,
  type TagsNsDeps,
  type TagAddOptions,
  type TagListOptions,
  type ActiveTag,
} from './tags.js'
export {
  makePropsNs,
  type PropsNs,
  type PropsNsDeps,
  type PropReadOptions,
  type PropSetOptions,
  type PropertyEntry,
} from './props.js'
export { makePinsNs, type PinsNs, type PinsNsDeps } from './pins.js'

export { writeFileTier1, resolveMirrors, type FileWriteContext } from './file.js'

// The pluggable execution seam (sdk-wallet-architecture): detect → select → submit.
// Tier-1 is the only live strategy; the deferred AA submitters plug into the
// selector without touching the core.
export { Tier1Submitter, type Submitter, type SubmitterContext } from './submitter.js'

export { selectSingle } from './select.js'

export {
  detectAccount,
  toCapabilities,
  invalidateAccountProfile,
  kindFromCode,
  unwrapCapabilities,
  type DetectClient,
} from './detect.js'

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
