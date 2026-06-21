/**
 * Type-level tests for expand-narrowing (sdk-read-surface §Type narrowing — "narrow
 * on `expand` only", James 2026-06-19). COMPILE-TIME only — the verbs are never
 * actually invoked. The `narrowingProbe` function below is never called; it exists
 * purely so `tsc` checks that `efs.fs.info/read` are generic over the expand tuple
 * and that the result narrows. The `expectTypeOf` assertions pin the `Expanded`
 * helper (the machinery behind the narrowing) and the always-present provenance.
 */

import { http, type WalletClient, createPublicClient, createWalletClient } from 'viem'
import { sepolia } from 'viem/chains'
import { describe, expectTypeOf, it } from 'vitest'
import type {
  Attestation,
  DataUID,
  EfsFile,
  Expanded,
  FileAttestations,
  FileInfo,
} from '../src/index.js'
import { createEfsClient } from '../src/index.js'

// A client value only for its TYPE — never called (sepolia has no deployment).
const efs = createEfsClient({
  publicClient: createPublicClient({ chain: sepolia, transport: http() }),
  walletClient: createWalletClient({ chain: sepolia, transport: http() }) as WalletClient,
})

/**
 * NEVER CALLED. Exists so `tsc` verifies the verbs are generic over `expand` and the
 * return narrows `.attestations` to non-optional when the token is present. If the
 * methods stopped narrowing, the non-null member accesses below would error.
 */
async function _narrowingProbe() {
  // expand:['attestations'] → .attestations is non-optional (no `?.`, no `!`).
  const i = await efs.fs.info('/x', { expand: ['attestations'] })
  const _a: FileAttestations = i.attestations
  const i2 = await efs.fs.info('/x', { expand: ['attestations.schema'] })
  const _a2: FileAttestations = i2.attestations
  const f = await efs.fs.read('/x', { expand: ['attestations'] })
  const _a3: FileAttestations = f.attestations

  // no expand → .attestations is optional (must be `| undefined`).
  const wide = await efs.fs.info('/x')
  const _w: FileAttestations | undefined = wide.attestations
  // fields does NOT narrow — still optional.
  const proj = await efs.fs.info('/x', { fields: ['contentType', 'license'] })
  const _p: FileAttestations | undefined = proj.attestations

  // `mirrors`/`redirects` are NOT in the ExpandToken union (unimplemented → not a silent
  // no-op token). Passing them must be a type error, not a quietly-accepted expand.
  // @ts-expect-error 'mirrors' is not an ExpandToken
  await efs.fs.info('/x', { expand: ['mirrors'] })
  // @ts-expect-error 'redirects' is not an ExpandToken
  await efs.fs.info('/x', { expand: ['redirects'] })

  // A receipt step `uid` is a RAW attestation UID (kind given by `id`), NOT a DataUID —
  // it must NOT be assignable to a DataUID-typed slot (the wrong-UID-kind guard). The
  // file's content identity is `receipt.data.uid`, which IS a DataUID.
  const receipt = await efs.fs.write('/x', new Uint8Array())
  // @ts-expect-error a step uid is not a DataUID
  const _bad: DataUID | undefined = receipt.steps[0]?.uid
  const _ok: DataUID | undefined = receipt.data?.uid

  return { _a, _a2, _a3, _w, _p, _bad, _ok }
}
void _narrowingProbe // keep referenced

describe('expand-narrowing (type-level)', () => {
  it('Expanded<FileInfo, ["attestations"]> makes .attestations non-optional', () => {
    expectTypeOf<
      Expanded<FileInfo, ['attestations']>['attestations']
    >().toEqualTypeOf<FileAttestations>()
  })

  it('Expanded with the depth-2 attestations.schema also narrows', () => {
    expectTypeOf<
      Expanded<FileInfo, ['attestations.schema']>['attestations']
    >().toEqualTypeOf<FileAttestations>()
  })

  it('Expanded<FileInfo, []> leaves .attestations optional', () => {
    expectTypeOf<Expanded<FileInfo, []>['attestations']>().toEqualTypeOf<
      FileAttestations | undefined
    >()
  })

  it('Expanded narrows EfsFile the same way', () => {
    expectTypeOf<
      Expanded<EfsFile, ['attestations']>['attestations']
    >().toEqualTypeOf<FileAttestations>()
    expectTypeOf<Expanded<EfsFile, []>['attestations']>().toEqualTypeOf<
      FileAttestations | undefined
    >()
  })

  it('provenance fields are always present on FileInfo (never projected away)', () => {
    expectTypeOf<FileInfo>().toHaveProperty('resolvedBy')
    expectTypeOf<FileInfo>().toHaveProperty('verified')
    expectTypeOf<FileInfo>().toHaveProperty('sourceUIDs')
  })

  it('a per-field attestation is a plain Attestation record', () => {
    expectTypeOf<FileAttestations['placement']>().toEqualTypeOf<Attestation | undefined>()
  })

  it('EfsFile carries pure decoders', () => {
    expectTypeOf<EfsFile['text']>().toEqualTypeOf<() => string>()
  })
})
