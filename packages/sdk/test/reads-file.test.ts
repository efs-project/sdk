/**
 * Unit tests for the lens-scoped read verbs (`reads/file.ts`, `reads/fetch.ts`,
 * `reads/list.ts`, `reads/attestations.ts`) — driven through a mocked viem
 * `readContract` + an injected fetch transport. No live chain.
 *
 * The mock `readContract` dispatches by `functionName` over small in-memory tables
 * keyed to the deployed read surface:
 *   - `rootAnchorUID` / `resolvePath`        → path walk (reads/resolve.ts)
 *   - `getFilesAtPath`                        → winning placement under the lens
 *   - `getActivePinSlot`                      → placement PIN UID (provenance)
 *   - `resolveAnchor` + `getActivePinTarget` + `getAttestation` → reserved PROPERTY
 *   - `getDataMirrors`                        → lens-scoped per-DATA active mirrors
 *   - `getDirectoryPageByAddressList`         → directory page
 *
 * What is asserted (sdk-read-surface verbs + semantics):
 *   - locate returns a DataRef whose `resolvedBy` is the winning lens attester, null when absent;
 *   - info is a flat DTO with always-present provenance + exists:false on absence + size/contentType;
 *   - read fetches + verifies, and a hash MISMATCH surfaces on `.verification`, not a throw;
 *   - read(ref) works from a bare ref; read's `.text()`/`.json()` are pure;
 *   - readText/readBytes/readJson are fail-closed (throw on mismatch) unless verify:false;
 *   - exists is a boolean;
 *   - list pages (.byPage) + iterates + .toArray with the opaque cursor;
 *   - attestationsFor batch-hydrates source UIDs;
 *   - no-lens/no-wallet reads fall back to the deployment SystemAccount (SYSTEM_LENS);
 *     LensRequired only when even the SystemAccount is unavailable.
 */

import { type Address, type Hex, encodeAbiParameters } from 'viem'
import { describe, expect, it } from 'vitest'
import type { EfsDeployment } from '../src/chain/deployments.js'
import { hashContent } from '../src/content/hash.js'
import {
  ContentHashMismatch,
  CursorInvalid,
  EfsError,
  FileNotFoundError,
  LensRequired,
  MalformedClaim,
  MissingContentHash,
} from '../src/errors.js'
import { attestationsFor } from '../src/reads/attestations.js'
import type { ReadContext } from '../src/reads/context.js'
import { InvalidDirectoryQuery } from '../src/reads/directory.js'
import { read, readBytes, readJson, readText } from '../src/reads/fetch.js'
import { exists, info, locate } from '../src/reads/file.js'
import { list } from '../src/reads/list.js'
import type { DataRef, DataUID } from '../src/types.js'

// ── Fixtures ────────────────────────────────────────────────────────────────────

const uid = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address
const ZERO = uid(0)

const EAS = addr(0xea51)
const INDEXER = addr(0x1de6)
const FILEVIEW = addr(0xf17e)
const EDGE = addr(0xed6e)

const ROOT = uid(0x1)
const DOCS_ANCHOR = uid(0x10)
const FILE_ANCHOR = uid(0x11) // /docs/readme.md anchor
const DATA_UID = uid(0xda7a) as DataUID
const PLACEMENT_PIN = uid(0x9111) // placement PIN UID
const LENS = addr(0xbeef) // the winning lens attester (resolvedBy)
const OTHER = addr(0xca11) // a different attester (should be ignored when scoped)

const SCHEMAS = {
  anchor: uid(0xa),
  property: uid(0xb),
  data: uid(0xc),
  pin: uid(0xd),
  tag: uid(0xe),
  mirror: uid(0xf),
  list: uid(0x100),
  listEntry: uid(0x101),
  redirect: uid(0x102),
}

function deployment(): EfsDeployment {
  return {
    chainId: 31337,
    contracts: {
      eas: EAS,
      schemaRegistry: addr(0x5),
      indexer: INDEXER,
      router: addr(0x6),
      fileView: FILEVIEW,
      edgeResolver: EDGE,
      mirrorResolver: addr(0x9),
      listResolver: addr(0xaa),
      listEntryResolver: addr(0xbb),
      listReader: addr(0xcc),
      aliasResolver: addr(0xdd),
      systemAccount: addr(0xee),
    },
    schemas: SCHEMAS,
    transports: {},
  }
}

/** Encode a PROPERTY `string value` blob the way the write path does. */
function propertyData(value: string): Hex {
  return encodeAbiParameters([{ type: 'string' }], [value]) as Hex
}

/** A FileSystemItem tuple as viem decodes it (object form). */
type Item = {
  uid: Hex
  name: string
  parentUID: Hex
  isFolder: boolean
  hasData: boolean
  childCount: bigint
  propertyCount: bigint
  timestamp: bigint
  attester: Address
  schema: Hex
  contentHash: Hex
}
function fileItem(over: Partial<Item>): Item {
  return {
    uid: DATA_UID,
    name: '',
    parentUID: FILE_ANCHOR,
    isFolder: false,
    hasData: true,
    childCount: 0n,
    propertyCount: 0n,
    timestamp: 0n,
    attester: LENS,
    schema: SCHEMAS.data,
    contentHash: ZERO,
    ...over,
  }
}

/** A getAttestation tuple (only fields the read path touches need to be real). */
function attestation(over: { uid?: Hex; data?: Hex; revocationTime?: bigint; schema?: Hex }) {
  return {
    uid: over.uid ?? ZERO,
    schema: over.schema ?? SCHEMAS.property,
    time: 0n,
    expirationTime: 0n,
    revocationTime: over.revocationTime ?? 0n,
    refUID: ZERO,
    recipient: addr(0),
    attester: LENS,
    revocable: true,
    data: over.data ?? ('0x' as Hex),
  }
}

/**
 * Build a mock {@link ReadContext}. `tables` configures the in-memory responses;
 * anything unset returns the empty sentinel (ZERO / empty array), matching the
 * kernel's empty-slot behavior.
 */
function makeCtx(opts: {
  account?: Address
  edges?: Record<string, Hex> // `${parent}|${name}` -> child anchor (resolvePath)
  files?: readonly Item[] // getFilesAtPath result for FILE_ANCHOR
  placementPins?: Record<string, Hex> // `${anchor}|${attester}` -> placement pin UID (getActivePinSlot)
  keyAnchors?: Record<string, Hex> // `${dataUID}|${key}` -> keyAnchor (resolveAnchor)
  pinTargets?: Record<string, Hex> // `${keyAnchor}|${attester}` -> propertyUID (getActivePinTarget)
  attestations?: Record<string, Hex> // propertyUID -> data blob (getAttestation)
  mirrors?: readonly { uri: string; attester: Address }[]
  dirPage?: { items: readonly Item[]; nextCursor: bigint }
  // Filtered directory pages (ADR-0011 getDirectoryPageFiltered): ordered pages with
  // opaque `bytes` cursors. The mock walks them in order, keying the next page on the
  // cursor the previous one emitted (`'0x'` ⇒ exhausted). The first read uses cursor
  // `'0x'`. Captures the args so a test can assert the resolved excludeTagDefs/weights.
  filteredPages?: readonly { items: readonly Item[]; nextCursor: Hex }[]
  // REDIRECT (ADR-0050): `${source}|${attester}` -> the active redirect from that
  // source under that attester. Backs getReferencingBySchemaAndAttester (returns the
  // redirectUID) + getAttestation (returns the encoded `(target, kind)` blob).
  redirects?: Record<string, { redirectUID: Hex; target: Hex; kind: number }>
  calls?: { fn: string; args: readonly unknown[] }[]
}): ReadContext {
  const {
    edges = {},
    files = [],
    placementPins = {},
    keyAnchors = {},
    pinTargets = {},
    attestations = {},
    mirrors = [],
    dirPage = { items: [], nextCursor: 0n },
    filteredPages = [],
    redirects = {},
    calls = [],
  } = opts
  // Filtered-page walker: serve `filteredPages` in order. The mock returns page i and
  // sets its cursor to a synthetic `0x..0i+1` (or `'0x'` to end); the next call's
  // cursor selects page i+1. Keyed by the cursor the test sees (opaque, passed back).
  let filteredIdx = 0
  // Index redirectUID -> encoded redirect data, for the getAttestation branch.
  const redirectByUID = new Map<Hex, Hex>()
  for (const r of Object.values(redirects)) {
    redirectByUID.set(
      r.redirectUID,
      encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint16' }], [r.target, r.kind]) as Hex,
    )
  }
  const publicClient: ReadContext['publicClient'] = {
    async readContract(args) {
      calls.push({ fn: args.functionName, args: args.args ?? [] })
      switch (args.functionName) {
        case 'rootAnchorUID':
          return ROOT
        case 'resolvePath': {
          const [parent, name] = args.args as [Hex, string]
          return edges[`${parent}|${name}`] ?? ZERO
        }
        case 'getFilesAtPath':
          return { items: files, nextCursor: '0x' as Hex }
        case 'getActivePinSlot': {
          const [anchor, attester] = args.args as [Hex, Address]
          return {
            pinUID: placementPins[`${anchor}|${attester.toLowerCase()}`] ?? ZERO,
            targetID: ZERO,
          }
        }
        case 'resolveAnchor': {
          const [dataUID, key] = args.args as [Hex, string]
          return keyAnchors[`${dataUID}|${key}`] ?? ZERO
        }
        case 'getActivePinTarget': {
          const [keyAnchor, attester] = args.args as [Hex, Address]
          return pinTargets[`${keyAnchor}|${attester.toLowerCase()}`] ?? ZERO
        }
        case 'getReferencingBySchemaAndAttester': {
          // (source, REDIRECT_SCHEMA, attester, …) → the active redirect UID, if any.
          const [source, , attester] = args.args as [Hex, Hex, Address]
          const r = redirects[`${source}|${(attester as string).toLowerCase()}`]
          return r ? [r.redirectUID] : []
        }
        case 'getAttestation': {
          const [u] = args.args as [Hex]
          // A redirect attestation (its data is the `(target, kind)` blob)?
          const redirectData = redirectByUID.get(u)
          if (redirectData !== undefined) {
            return attestation({ uid: u, data: redirectData, schema: SCHEMAS.redirect })
          }
          const data = attestations[u]
          return attestation({ uid: data !== undefined ? u : ZERO, data })
        }
        case 'getDataMirrors': {
          const [, attester] = args.args as [Hex, Address]
          // The lens-scoped view returns ONLY the named attester's mirrors.
          return mirrors
            .filter((m) => m.attester.toLowerCase() === (attester as string).toLowerCase())
            .map((m, i) => ({
              uid: uid(0x9000 + i),
              transportDefinition: ZERO,
              uri: m.uri,
              attester: m.attester,
              timestamp: 0n,
            }))
        }
        case 'getDirectoryPageByAddressList':
          // TWO top-level ABI outputs ⇒ viem returns a positional TUPLE, not an object.
          return [dirPage.items, dirPage.nextCursor]
        case 'getDirectoryPageFiltered': {
          // args: [parentAnchor, anchorSchema, attesters, excludeTagDefs, minWeights, cursor, maxItems]
          const page = filteredPages[filteredIdx] ?? { items: [], nextCursor: '0x' as Hex }
          filteredIdx += 1
          return page
        }
        default:
          throw new Error(`unexpected functionName ${args.functionName}`)
      }
    },
  }
  return {
    publicClient,
    deployment: deployment(),
    ...(opts.account !== undefined ? { account: opts.account } : {}),
  }
}

/** Standard path edges placing /docs/readme.md at FILE_ANCHOR. */
const README_EDGES = { [`${ROOT}|docs`]: DOCS_ANCHOR, [`${DOCS_ANCHOR}|readme.md`]: FILE_ANCHOR }
/** A placement PIN under the winning lens at the file anchor. */
const README_PLACEMENT = { [`${FILE_ANCHOR}|${LENS.toLowerCase()}`]: PLACEMENT_PIN }

// ── locate ─────────────────────────────────────────────────────────────────────

describe('locate', () => {
  it('returns a DataRef under the given lens (resolvedBy = winning attester)', async () => {
    const ctx = makeCtx({ edges: README_EDGES, files: [fileItem({})] })
    const res = await locate(ctx, '/docs/readme.md', { lens: LENS })
    expect(res).not.toBeNull()
    expect(res?.data.uid).toBe(DATA_UID)
    expect(res?.data.chainId).toBe(31337)
    expect(res?.data.resolvedBy).toBe(LENS)
    expect(res?.resolvedBy).toBe(LENS)
  })

  it('resolves a DATA-typed file anchor that is NOT in the generic folder slot', async () => {
    // The SDK writes file anchors at (parent, name, DATA_SCHEMA_UID). Here the leaf
    // 'readme.md' exists ONLY in the DATA slot (via keyAnchors → resolveAnchor), NOT in
    // the generic `edges` (resolvePath) — a generic-only walk would report it absent.
    // This is the read-side of the file-anchor fix: SDK-written files must resolve.
    const ctx = makeCtx({
      edges: { [`${ROOT}|docs`]: DOCS_ANCHOR }, // parent folder only (generic)
      keyAnchors: { [`${DOCS_ANCHOR}|readme.md`]: FILE_ANCHOR }, // DATA-typed file leaf
      placementPins: README_PLACEMENT,
      files: [fileItem({})],
    })
    const res = await locate(ctx, '/docs/readme.md', { lens: LENS })
    expect(res).not.toBeNull()
    expect(res?.data.uid).toBe(DATA_UID)
  })

  it('returns null when the file anchor does not exist', async () => {
    const ctx = makeCtx({ edges: { [`${ROOT}|docs`]: DOCS_ANCHOR }, files: [] })
    expect(await locate(ctx, '/docs/missing.md', { lens: LENS })).toBeNull()
  })

  // ── locate + followRedirects (ADR-0050 read-time resolution) ───────────────────

  const CANON = uid(0xca0) as DataUID // a canonical DATA the duplicate redirects to

  it('does NOT follow a redirect by default (opt-out is the default)', async () => {
    const ctx = makeCtx({
      edges: README_EDGES,
      files: [fileItem({})],
      // DATA_UID → CANON (sameAs), asserted by the winning lens.
      redirects: {
        [`${DATA_UID}|${LENS.toLowerCase()}`]: { redirectUID: uid(0xf01), target: CANON, kind: 0 },
      },
    })
    const res = await locate(ctx, '/docs/readme.md', { lens: LENS })
    // Literal placement preserved — no follow, no `via`.
    expect(res?.data.uid).toBe(DATA_UID)
    expect(res?.via).toBeUndefined()
  })

  it('follows a sameAs redirect to the canonical when followRedirects:true, surfacing `via`', async () => {
    const ctx = makeCtx({
      edges: README_EDGES,
      files: [fileItem({})],
      redirects: {
        [`${DATA_UID}|${LENS.toLowerCase()}`]: { redirectUID: uid(0xf01), target: CANON, kind: 0 },
      },
    })
    const res = await locate(ctx, '/docs/readme.md', { lens: LENS, followRedirects: true })
    expect(res?.data.uid).toBe(CANON) // resolved to the canonical
    expect(res?.via).toHaveLength(1)
    expect(res?.via?.[0]?.from).toBe(DATA_UID) // redirectedFrom = the requested identity
    expect(res?.via?.[0]?.to).toBe(CANON)
    expect(res?.via?.[0]?.kind).toBe('sameAs')
  })

  it('follows a multi-hop chain DATA→CANON→FINAL', async () => {
    const FINAL = uid(0xf1aa1) as DataUID
    const ctx = makeCtx({
      edges: README_EDGES,
      files: [fileItem({})],
      redirects: {
        [`${DATA_UID}|${LENS.toLowerCase()}`]: { redirectUID: uid(0xf01), target: CANON, kind: 1 },
        [`${CANON}|${LENS.toLowerCase()}`]: { redirectUID: uid(0xf02), target: FINAL, kind: 1 },
      },
    })
    const res = await locate(ctx, '/docs/readme.md', { lens: LENS, followRedirects: true })
    expect(res?.data.uid).toBe(FINAL)
    expect(res?.via?.map((v) => v.to)).toEqual([CANON, FINAL])
  })

  it('throws RedirectHopLimit when followRedirects:1 caps a 2-hop chain', async () => {
    const FINAL = uid(0xf1aa1) as DataUID
    const ctx = makeCtx({
      edges: README_EDGES,
      files: [fileItem({})],
      redirects: {
        [`${DATA_UID}|${LENS.toLowerCase()}`]: { redirectUID: uid(0xf01), target: CANON, kind: 0 },
        [`${CANON}|${LENS.toLowerCase()}`]: { redirectUID: uid(0xf02), target: FINAL, kind: 0 },
      },
    })
    await expect(
      locate(ctx, '/docs/readme.md', { lens: LENS, followRedirects: 1 }),
    ).rejects.toMatchObject({ code: 'RedirectHopLimit' })
  })

  it('returns null when no attester in the lens placed data', async () => {
    const ctx = makeCtx({ edges: README_EDGES, files: [] }) // anchor exists, no placement
    expect(await locate(ctx, '/docs/readme.md', { lens: LENS })).toBeNull()
  })

  it('defaults the lens to the connected wallet account', async () => {
    const ctx = makeCtx({ account: LENS, edges: README_EDGES, files: [fileItem({})] })
    const res = await locate(ctx, '/docs/readme.md') // no opts.lens
    expect(res?.resolvedBy).toBe(LENS)
  })

  it('falls back to the deployment SystemAccount lens (no lens, no wallet)', async () => {
    // A read-only client with no lens/wallet resolves via the SystemAccount
    // (SYSTEM_LENS), mirroring the contracts router's `system` fallback — so a
    // public file reads in one line with zero lens knowledge.
    const SYSTEM = addr(0xee) // deployment().contracts.systemAccount
    const calls: { fn: string; args: readonly unknown[] }[] = []
    const ctx = makeCtx({
      edges: README_EDGES,
      files: [fileItem({ attester: SYSTEM })],
      calls,
    })
    const res = await locate(ctx, '/docs/readme.md') // no opts.lens, no account
    expect(res?.resolvedBy).toBe(SYSTEM)
    // The attester set handed to the view IS the SystemAccount.
    const filesCall = calls.find((c) => c.fn === 'getFilesAtPath')
    expect(filesCall?.args[1]).toEqual([SYSTEM])
  })

  it('throws LensRequired only when even the SystemAccount is unavailable', async () => {
    const ctx = makeCtx({ edges: README_EDGES, files: [fileItem({})] })
    // Strip the SystemAccount so there is genuinely no attester to resolve against.
    ;(ctx.deployment.contracts as { systemAccount?: Address }).systemAccount = undefined
    await expect(locate(ctx, '/docs/readme.md')).rejects.toBeInstanceOf(LensRequired)
  })
})

// ── info ─────────────────────────────────────────────────────────────────────

describe('info', () => {
  it('reports exists:false when nothing is placed, with provenance still present', async () => {
    const ctx = makeCtx({ edges: README_EDGES, files: [] })
    const i = await info(ctx, '/docs/readme.md', { lens: LENS })
    expect(i.exists).toBe(false)
    // Provenance is ALWAYS present, never projected away.
    expect(i).toHaveProperty('resolvedBy')
    expect(i).toHaveProperty('verified')
    expect(i).toHaveProperty('sourceUIDs')
    expect(i.verified).toBe('unchecked')
  })

  it('absent + expand:["attestations"] returns an EMPTY attestations bag (not undefined)', async () => {
    // The generic signature narrows `.attestations` to a non-optional field when
    // expand opts in. On absence there are no source UIDs — but the runtime must still
    // carry the field (an empty bag), else a caller relying on the narrowed type
    // dereferences `undefined`. Provenance stays present; exists is still false.
    const ctx = makeCtx({ edges: README_EDGES, files: [] })
    const i = await info(ctx, '/docs/readme.md', { lens: LENS, expand: ['attestations'] })
    expect(i.exists).toBe(false)
    expect(i).toHaveProperty('attestations')
    expect(i.attestations).toEqual({})
  })

  it('reports exists:true with size + contentType from the reserved PROPERTYs (lens-scoped)', async () => {
    const sizeAnchor = uid(0x5102)
    const typeAnchor = uid(0xc19e)
    const sizeProp = uid(0x5170)
    const typeProp = uid(0xc170)
    const ctx = makeCtx({
      edges: README_EDGES,
      files: [fileItem({})],
      placementPins: README_PLACEMENT,
      keyAnchors: {
        [`${DATA_UID}|size`]: sizeAnchor,
        [`${DATA_UID}|contentType`]: typeAnchor,
      },
      pinTargets: {
        [`${sizeAnchor}|${LENS.toLowerCase()}`]: sizeProp,
        [`${typeAnchor}|${LENS.toLowerCase()}`]: typeProp,
        // OTHER attester set a different size — must be ignored (lens scope).
        [`${sizeAnchor}|${OTHER.toLowerCase()}`]: uid(0xbad),
      },
      attestations: {
        [sizeProp]: propertyData('1234'),
        [typeProp]: propertyData('text/markdown'),
        [uid(0xbad)]: propertyData('999999'),
      },
    })
    const i = await info(ctx, '/docs/readme.md', { lens: LENS })
    expect(i.exists).toBe(true)
    expect(i.size).toBe(1234n)
    expect(i.contentType).toBe('text/markdown')
    expect(i.resolvedBy).toBe(LENS)
    expect(i.ref?.uid).toBe(DATA_UID)
    // `info` never fetches/hashes the bytes, so it cannot claim matches-author —
    // that status is reserved for the byte path (`read`). A resolved placement is
    // `unchecked` at the metadata level.
    expect(i.verified).toBe('unchecked')
    // Provenance: placement PIN + per-field property UIDs.
    expect(i.sourceUIDs.placement).toBe(PLACEMENT_PIN)
    expect(i.sourceUIDs.size).toBe(sizeProp)
    expect(i.sourceUIDs.contentType).toBe(typeProp)
  })

  it('omits size when the reserved PROPERTY is absent', async () => {
    const ctx = makeCtx({ edges: README_EDGES, files: [fileItem({})] })
    const i = await info(ctx, '/docs/readme.md', { lens: LENS })
    expect(i.exists).toBe(true)
    expect(i.size).toBeUndefined()
  })

  it('routes custom fields into the properties bag (typed slots stay reserved)', async () => {
    const licAnchor = uid(0x11ce)
    const licProp = uid(0x11cf)
    const ctx = makeCtx({
      edges: README_EDGES,
      files: [fileItem({})],
      keyAnchors: { [`${DATA_UID}|license`]: licAnchor },
      pinTargets: { [`${licAnchor}|${LENS.toLowerCase()}`]: licProp },
      attestations: { [licProp]: propertyData('CC-BY-4.0') },
    })
    const i = await info(ctx, '/docs/readme.md', { lens: LENS, fields: ['license'] })
    expect(i.properties?.license).toBe('CC-BY-4.0')
  })

  it('hydrates per-field attestations under expand:["attestations"]', async () => {
    const sizeAnchor = uid(0x5102)
    const sizeProp = uid(0x5170)
    const ctx = makeCtx({
      edges: README_EDGES,
      files: [fileItem({})],
      placementPins: README_PLACEMENT,
      keyAnchors: { [`${DATA_UID}|size`]: sizeAnchor },
      pinTargets: { [`${sizeAnchor}|${LENS.toLowerCase()}`]: sizeProp },
      attestations: {
        [sizeProp]: propertyData('1234'),
        [PLACEMENT_PIN]: propertyData('placement'),
      },
    })
    const i = await info(ctx, '/docs/readme.md', { lens: LENS, expand: ['attestations'] })
    expect(i.attestations).toBeDefined()
    expect(i.attestations?.placement?.uid).toBe(PLACEMENT_PIN)
    expect(i.attestations?.size?.uid).toBe(sizeProp)
  })
})

// ── exists ──────────────────────────────────────────────────────────────────────

describe('exists', () => {
  it('returns true when a placement resolves, false when absent', async () => {
    const present = makeCtx({ edges: README_EDGES, files: [fileItem({})] })
    const absent = makeCtx({ edges: README_EDGES, files: [] })
    expect(await exists(present, '/docs/readme.md', { lens: LENS })).toBe(true)
    expect(await exists(absent, '/docs/readme.md', { lens: LENS })).toBe(false)
  })
})

// ── read / read(ref) (bytes + verification) ───────────────────────────────────────

describe('read + read(ref)', () => {
  const BYTES = new TextEncoder().encode('# Hello EFS\n')
  const GOOD_HASH = hashContent(BYTES) // 64-hex bare sha256
  const dataUri = `data:text/markdown;base64,${Buffer.from(BYTES).toString('base64')}`

  function ctxWithMirror(propHash: string) {
    const hashAnchor = uid(0x4a54)
    const hashProp = uid(0x4a51)
    return makeCtx({
      edges: README_EDGES,
      files: [fileItem({})],
      placementPins: README_PLACEMENT,
      keyAnchors: { [`${DATA_UID}|contentHash`]: hashAnchor },
      pinTargets: { [`${hashAnchor}|${LENS.toLowerCase()}`]: hashProp },
      attestations: { [hashProp]: propertyData(propHash) },
      mirrors: [{ uri: dataUri, attester: LENS }],
    })
  }

  it('read fetches bytes and verifies against the author contentHash (matches-author)', async () => {
    const file = await read(ctxWithMirror(GOOD_HASH), '/docs/readme.md', { lens: LENS })
    expect(file.text()).toBe('# Hello EFS\n') // pure decode
    expect(file.verification).toBe('matches-author')
    expect(file.hashAuthor).toBe(LENS)
  })

  it('surfaces a hash MISMATCH as verification status, not a throw', async () => {
    const wrong = 'a'.repeat(64)
    const file = await read(ctxWithMirror(wrong), '/docs/readme.md', { lens: LENS })
    expect(file.verification).toBe('mismatch')
    expect(file.bytes.byteLength).toBeGreaterThan(0)
  })

  it('reports no-claim when verify:false (no contentHash lookup)', async () => {
    const file = await read(ctxWithMirror(GOOD_HASH), '/docs/readme.md', {
      lens: LENS,
      verify: false,
    })
    expect(file.verification).toBe('no-claim')
  })

  it('read() uses the ATTESTED contentType, never the transport/data-uri mime', async () => {
    const hashAnchor = uid(0x4a54)
    const hashProp = uid(0x4a51)
    const typeAnchor = uid(0xc1de)
    const typeProp = uid(0xc1df)
    const ctx = makeCtx({
      edges: README_EDGES,
      files: [fileItem({})],
      placementPins: README_PLACEMENT,
      keyAnchors: {
        [`${DATA_UID}|contentHash`]: hashAnchor,
        [`${DATA_UID}|contentType`]: typeAnchor,
      },
      pinTargets: {
        [`${hashAnchor}|${LENS.toLowerCase()}`]: hashProp,
        [`${typeAnchor}|${LENS.toLowerCase()}`]: typeProp,
      },
      attestations: {
        [hashProp]: propertyData(GOOD_HASH),
        [typeProp]: propertyData('application/x-attested'),
      },
      mirrors: [{ uri: dataUri, attester: LENS }], // the data: URI mime is text/markdown
    })
    const file = await read(ctx, '/docs/readme.md', { lens: LENS })
    expect(file.contentType).toBe('application/x-attested') // attested, not 'text/markdown'
    expect(file.verification).toBe('matches-author')
  })

  it('read() enforces the attested size — a body exceeding the declared size is rejected', async () => {
    const hashAnchor = uid(0x4a54)
    const hashProp = uid(0x4a51)
    const sizeAnchor = uid(0x5102)
    const sizeProp = uid(0x5170)
    const ctx = makeCtx({
      edges: README_EDGES,
      files: [fileItem({})],
      placementPins: README_PLACEMENT,
      keyAnchors: {
        [`${DATA_UID}|contentHash`]: hashAnchor,
        [`${DATA_UID}|size`]: sizeAnchor,
      },
      pinTargets: {
        [`${hashAnchor}|${LENS.toLowerCase()}`]: hashProp,
        [`${sizeAnchor}|${LENS.toLowerCase()}`]: sizeProp,
      },
      attestations: {
        [hashProp]: propertyData(GOOD_HASH),
        [sizeProp]: propertyData('4'), // declared 4 bytes, but the body is 12
      },
      mirrors: [{ uri: dataUri, attester: LENS }],
    })
    // The 12-byte body exceeds the declared 4 → the fetch cap rejects it (all mirrors
    // fail) rather than returning oversized bytes as matches-author.
    await expect(read(ctx, '/docs/readme.md', { lens: LENS })).rejects.toThrow()
  })

  it('read() returns a legitimately EMPTY file (declared size 0) — does not clamp the cap to 0', async () => {
    const empty = new Uint8Array()
    const emptyHash = hashContent(empty)
    const hashAnchor = uid(0x4a54)
    const hashProp = uid(0x4a51)
    const sizeAnchor = uid(0x5102)
    const sizeProp = uid(0x5170)
    const ctx = makeCtx({
      edges: README_EDGES,
      files: [fileItem({})],
      placementPins: README_PLACEMENT,
      keyAnchors: {
        [`${DATA_UID}|contentHash`]: hashAnchor,
        [`${DATA_UID}|size`]: sizeAnchor,
      },
      pinTargets: {
        [`${hashAnchor}|${LENS.toLowerCase()}`]: hashProp,
        [`${sizeAnchor}|${LENS.toLowerCase()}`]: sizeProp,
      },
      attestations: {
        [hashProp]: propertyData(emptyHash),
        [sizeProp]: propertyData('0'), // legitimately empty (fs.write('/empty', new Uint8Array()))
      },
      mirrors: [{ uri: 'data:text/plain;base64,', attester: LENS }], // decodes to 0 bytes
    })
    // Before the fix, declared size 0 clamped the cap to 0 and the engine rejected the
    // non-positive cap → empty files failed. Now the empty body verifies vs the empty-SHA-256.
    const file = await read(ctx, '/docs/readme.md', { lens: LENS })
    expect(file.bytes.byteLength).toBe(0)
    expect(file.verification).toBe('matches-author')
  })

  it('a HUGE declared size does NOT raise the cap above the engine default (P1)', async () => {
    // An untrusted attester declares size = 1 GB. With default opts (no maxBytes) the cap
    // must stay the 50 MB engine default — NOT become 1 GB. A mirror advertising a 60 MB
    // Content-Length (over the default, under the lie) must be REJECTED before buffering.
    const hashAnchor = uid(0x4a54)
    const hashProp = uid(0x4a51)
    const sizeAnchor = uid(0x5102)
    const sizeProp = uid(0x5170)
    const ctx = makeCtx({
      edges: README_EDGES,
      files: [fileItem({})],
      placementPins: README_PLACEMENT,
      keyAnchors: {
        [`${DATA_UID}|contentHash`]: hashAnchor,
        [`${DATA_UID}|size`]: sizeAnchor,
      },
      pinTargets: {
        [`${hashAnchor}|${LENS.toLowerCase()}`]: hashProp,
        [`${sizeAnchor}|${LENS.toLowerCase()}`]: sizeProp,
      },
      attestations: {
        [hashProp]: propertyData(GOOD_HASH),
        [sizeProp]: propertyData(String(1_000_000_000)), // 1 GB lie
      },
      mirrors: [{ uri: 'https://127.0.0.1/x', attester: LENS }],
    })
    // The engine trips on the 60 MB Content-Length vs the 50 MB default cap. With the bug
    // (declared size becomes the cap), 60 MB < 1 GB would pass.
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-length': String(60 * 1024 * 1024) },
      })) as unknown as typeof fetch
    await expect(
      read(ctx, '/docs/readme.md', { lens: LENS, fetchImpl, allowPrivateHosts: true }),
    ).rejects.toThrow(/cap/)
  })

  it('forwards an abort signal to the fetch engine (cancels the read)', async () => {
    // A pre-aborted signal must propagate to the mirror engine and abort the read,
    // rather than being ignored (the option previously never reached the engine).
    await expect(
      read(ctxWithMirror(GOOD_HASH), '/docs/readme.md', {
        lens: LENS,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow()
  })

  it('read throws FileNotFoundError when nothing is placed at the path', async () => {
    const ctx = makeCtx({ edges: README_EDGES, files: [] })
    await expect(read(ctx, '/docs/readme.md', { lens: LENS })).rejects.toBeInstanceOf(
      FileNotFoundError,
    )
  })

  it('read(ref) verifies from a bare DataRef (lens carried by the ref)', async () => {
    const hashAnchor = uid(0x4a54)
    const hashProp = uid(0x4a51)
    const ctx = makeCtx({
      keyAnchors: { [`${DATA_UID}|contentHash`]: hashAnchor },
      pinTargets: { [`${hashAnchor}|${LENS.toLowerCase()}`]: hashProp },
      attestations: { [hashProp]: propertyData(GOOD_HASH) },
      mirrors: [{ uri: dataUri, attester: LENS }],
    })
    const ref: DataRef = { __brand: 'DataRef', uid: DATA_UID, chainId: 31337, resolvedBy: LENS }
    const file = await read(ctx, ref)
    expect(file.verification).toBe('matches-author')
    expect(file.hashAuthor).toBe(LENS)
  })

  it('read(ref, { expand:["attestations"] }) hydrates provenance (contentHash; no placement)', async () => {
    const hashAnchor = uid(0x4a54)
    const hashProp = uid(0x4a51)
    const ctx = makeCtx({
      keyAnchors: { [`${DATA_UID}|contentHash`]: hashAnchor },
      pinTargets: { [`${hashAnchor}|${LENS.toLowerCase()}`]: hashProp },
      attestations: { [hashProp]: propertyData(GOOD_HASH) },
      mirrors: [{ uri: dataUri, attester: LENS }],
    })
    const ref: DataRef = { __brand: 'DataRef', uid: DATA_UID, chainId: 31337, resolvedBy: LENS }
    // The DataRef path now honors expand (the generic signature narrows `attestations`
    // to non-optional) — it must not return undefined where TS says the field is set.
    const file = await read(ctx, ref, { expand: ['attestations'] })
    expect(file.attestations).toBeDefined()
    expect(file.attestations?.contentHash).toBeDefined()
    // A bare ref has no placement PIN, so that slot is legitimately absent.
    expect(file.attestations?.placement).toBeUndefined()
  })

  it('ignores mirrors attached by a non-lens attester (lens-scoped view)', async () => {
    const hashAnchor = uid(0x4a54)
    const hashProp = uid(0x4a51)
    const ctx = makeCtx({
      keyAnchors: { [`${DATA_UID}|contentHash`]: hashAnchor },
      pinTargets: { [`${hashAnchor}|${LENS.toLowerCase()}`]: hashProp },
      attestations: { [hashProp]: propertyData(GOOD_HASH) },
      mirrors: [{ uri: dataUri, attester: OTHER }], // wrong attester
    })
    const ref: DataRef = { __brand: 'DataRef', uid: DATA_UID, chainId: 31337, resolvedBy: LENS }
    // The lens-scoped view returns no mirrors for LENS → AllMirrorsFailed (classified).
    await expect(read(ctx, ref)).rejects.toThrow()
  })

  // ── fail-closed value sugar ─────────────────────────────────────────────────

  it('readText returns the string on a match', async () => {
    const text = await readText(ctxWithMirror(GOOD_HASH), '/docs/readme.md', { lens: LENS })
    expect(text).toBe('# Hello EFS\n')
  })

  it('readBytes returns the bytes on a match', async () => {
    const bytes = await readBytes(ctxWithMirror(GOOD_HASH), '/docs/readme.md', { lens: LENS })
    expect(new TextDecoder().decode(bytes)).toBe('# Hello EFS\n')
  })

  it('readText THROWS ContentHashMismatch on a hash mismatch (fail-closed)', async () => {
    const wrong = 'a'.repeat(64)
    await expect(
      readText(ctxWithMirror(wrong), '/docs/readme.md', { lens: LENS }),
    ).rejects.toBeInstanceOf(ContentHashMismatch)
  })

  it('readText THROWS MalformedClaim on a malformed contentHash claim', async () => {
    const malformed = '0xnot-a-hash'
    await expect(
      readText(ctxWithMirror(malformed), '/docs/readme.md', { lens: LENS }),
    ).rejects.toBeInstanceOf(MalformedClaim)
  })

  it('readText with verify:false returns mismatched bytes WITHOUT throwing (opt-out)', async () => {
    const wrong = 'a'.repeat(64)
    const text = await readText(ctxWithMirror(wrong), '/docs/readme.md', {
      lens: LENS,
      verify: false,
    })
    expect(text).toBe('# Hello EFS\n')
  })

  // A file with a mirror but NO contentHash PROPERTY → verification 'no-claim'.
  const ctxNoHash = () =>
    makeCtx({
      edges: README_EDGES,
      files: [fileItem({})],
      placementPins: README_PLACEMENT,
      mirrors: [{ uri: dataUri, attester: LENS }],
      // deliberately no keyAnchors/pinTargets/attestations → no contentHash claim
    })

  it('readText THROWS MissingContentHash when verification is requested but no claim exists', async () => {
    // Bare-value helpers are fail-closed: a missing claim ('no-claim') is unverifiable,
    // and there is no status field to warn — so the default (verify on) must throw.
    await expect(readText(ctxNoHash(), '/docs/readme.md', { lens: LENS })).rejects.toBeInstanceOf(
      MissingContentHash,
    )
  })

  it('readBytes with verify:false returns unverifiable (no-claim) bytes without throwing', async () => {
    const bytes = await readBytes(ctxNoHash(), '/docs/readme.md', { lens: LENS, verify: false })
    expect(new TextDecoder().decode(bytes)).toBe('# Hello EFS\n')
  })

  it('read() (non-value) reports no-claim for a missing hash WITHOUT throwing', async () => {
    const file = await read(ctxNoHash(), '/docs/readme.md', { lens: LENS })
    expect(file.verification).toBe('no-claim')
    expect(file.bytes.byteLength).toBeGreaterThan(0)
  })

  it('readJson parses + (optionally) validates', async () => {
    const obj = { hello: 'efs' }
    const jsonBytes = new TextEncoder().encode(JSON.stringify(obj))
    const jsonHash = hashContent(jsonBytes)
    const jsonUri = `data:application/json;base64,${Buffer.from(jsonBytes).toString('base64')}`
    const hashAnchor = uid(0x4a54)
    const hashProp = uid(0x4a51)
    const ctx = makeCtx({
      edges: README_EDGES,
      files: [fileItem({})],
      keyAnchors: { [`${DATA_UID}|contentHash`]: hashAnchor },
      pinTargets: { [`${hashAnchor}|${LENS.toLowerCase()}`]: hashProp },
      attestations: { [hashProp]: propertyData(jsonHash) },
      mirrors: [{ uri: jsonUri, attester: LENS }],
    })
    const parsed = await readJson<{ hello: string }>(ctx, '/docs/readme.md', { lens: LENS })
    expect(parsed.hello).toBe('efs')

    // With a zod-like schema.
    const schema = {
      parse(v: unknown) {
        if (typeof (v as { hello?: unknown }).hello !== 'string') throw new Error('bad')
        return v as { hello: string }
      },
    }
    const validated = await readJson(ctx, '/docs/readme.md', { lens: LENS, schema })
    expect(validated.hello).toBe('efs')
  })
})

// ── attestationsFor (batched hydrate) ─────────────────────────────────────────────

describe('attestationsFor', () => {
  it('hydrates source UIDs across items, degrading absent UIDs per-item', async () => {
    const propA = uid(0x7001)
    const ctx = makeCtx({
      attestations: { [propA]: propertyData('hello') },
    })
    const items = [
      { sourceUIDs: { contentType: propA, size: uid(0xdead) /* absent */ } },
      { sourceUIDs: {} },
    ]
    const out = await attestationsFor(ctx, items)
    expect(out).toHaveLength(2)
    expect(out[0]?.attestations.contentType?.uid).toBe(propA)
    // An absent UID (no table entry) hydrates to undefined, not a throw.
    expect(out[0]?.attestations.size).toBeUndefined()
    expect(out[1]?.attestations).toEqual({})
  })

  it('escapes a systemic WrongChain instead of swallowing it to empty attestations', async () => {
    // A drift after readContext() resolved makes the guarded client reject every getAttestation
    // with WrongChain. That is systemic, not per-UID absence — it must fail closed, not return
    // an empty/missing map that looks like genuine absence.
    const ctx = {
      publicClient: {
        readContract: async () => {
          throw new EfsError('provider drifted', { code: 'WrongChain' })
        },
      },
      deployment: deployment(), // `deployment` is a factory in this file
    } as unknown as ReadContext
    const err = await attestationsFor(ctx, [{ sourceUIDs: { contentType: uid(0x7001) } }]).catch(
      (e) => e,
    )
    expect((err as { code?: string }).code).toBe('WrongChain')
  })

  it('hydrates items carrying only TOP-LEVEL UIDs (DirEntry dataUID/anchorUID, DataRef ref.uid)', async () => {
    // HasSourceUIDs accepts ref.uid / dataUID / anchorUID; a DirEntry from fs.list() or a
    // DataRef carries those and NO sourceUIDs bag. They must still hydrate (not return {}).
    const dataAtt = uid(0x201)
    const anchorAtt = uid(0x202)
    const refAtt = uid(0x203)
    const ctx = makeCtx({
      attestations: {
        [dataAtt]: propertyData('d'),
        [anchorAtt]: propertyData('a'),
        [refAtt]: propertyData('r'),
      },
    })
    const items = [
      { dataUID: dataAtt }, // a file DirEntry
      { anchorUID: anchorAtt }, // a dir DirEntry
      { ref: { uid: refAtt } }, // a DataRef
    ]
    const out = await attestationsFor(ctx, items)
    expect(out[0]?.attestations.data?.uid).toBe(dataAtt) // dataUID → `data`
    expect(out[1]?.attestations.anchor?.uid).toBe(anchorAtt) // anchorUID → `anchor`
    expect(out[2]?.attestations.data?.uid).toBe(refAtt) // ref.uid → `data`
  })
})

// ── list (pagination + iteration) ───────────────────────────────────────────────

describe('list', () => {
  const dirEntries: readonly Item[] = [
    fileItem({ uid: uid(0x201), name: 'a.md', isFolder: false, hasData: true }),
    fileItem({ uid: uid(0x202), name: 'sub', isFolder: true, hasData: false }),
  ]

  it('returns a page of DirEntry with kind file|dir and the anchoring UID (.byPage)', async () => {
    const ctx = makeCtx({
      edges: { [`${ROOT}|docs`]: DOCS_ANCHOR },
      dirPage: { items: dirEntries, nextCursor: 0n },
    })
    const p = await list(() => ctx, '/docs', { lens: LENS }).byPage()
    expect(p.items).toHaveLength(2)
    expect(p.items[0]).toEqual({ name: 'a.md', kind: 'file', dataUID: uid(0x201) })
    expect(p.items[1]).toEqual({ name: 'sub', kind: 'dir', anchorUID: uid(0x202) })
    expect(p.cursor).toBeUndefined() // nextCursor 0 → end
  })

  it('exposes a resumable opaque cursor when more remain', async () => {
    const ctx = makeCtx({
      edges: { [`${ROOT}|docs`]: DOCS_ANCHOR },
      dirPage: { items: dirEntries, nextCursor: 7n },
    })
    const p = await list(() => ctx, '/docs', { lens: LENS }).byPage({ limit: 2 })
    expect(p.cursor).toBe('7')
  })

  it('async-iterates across pages until the cursor is exhausted', async () => {
    let call = 0
    const calls: { fn: string; args: readonly unknown[] }[] = []
    const ctx = makeCtx({ edges: { [`${ROOT}|docs`]: DOCS_ANCHOR }, calls })
    const inner = ctx.publicClient.readContract.bind(ctx.publicClient)
    ctx.publicClient.readContract = async (args) => {
      if (args.functionName === 'getDirectoryPageByAddressList') {
        call += 1
        // TWO ABI outputs ⇒ viem returns a positional [items, nextCursor] tuple.
        return call === 1 ? [[dirEntries[0]], 1n] : [[dirEntries[1]], 0n]
      }
      return inner(args)
    }
    const names: string[] = []
    for await (const e of list(() => ctx, '/docs', { lens: LENS })) names.push(e.name)
    expect(names).toEqual(['a.md', 'sub'])
    expect(call).toBe(2)
  })

  it('.toArray materializes up to the mandatory limit', async () => {
    const ctx = makeCtx({
      edges: { [`${ROOT}|docs`]: DOCS_ANCHOR },
      dirPage: { items: dirEntries, nextCursor: 0n },
    })
    const all = await list(() => ctx, '/docs', { lens: LENS }).toArray({ limit: 1 })
    expect(all).toHaveLength(1)
    expect(all[0]?.name).toBe('a.md')
  })

  it('.toArray rejects a non-finite/fractional/non-positive limit (cap stays bounded)', async () => {
    // toArray's cap is mandatory: Infinity must NOT silently collapse to a normal page
    // size and collect the whole directory; 1.5/NaN/0/-1 are likewise invalid.
    const ctx = makeCtx({
      edges: { [`${ROOT}|docs`]: DOCS_ANCHOR },
      dirPage: { items: dirEntries, nextCursor: 0n },
    })
    for (const bad of [Number.POSITIVE_INFINITY, 1.5, Number.NaN, 0, -1]) {
      await expect(
        list(() => ctx, '/docs', { lens: LENS }).toArray({ limit: bad }),
      ).rejects.toThrow(/positive integer/)
    }
  })

  it('falls back to the SystemAccount lens on .byPage (no lens/wallet)', async () => {
    // With no lens/wallet the listing resolves via the deployment SystemAccount
    // (SYSTEM_LENS) rather than throwing — a public directory lists in one line.
    const ctx = makeCtx({
      edges: { [`${ROOT}|docs`]: DOCS_ANCHOR },
      dirPage: { items: dirEntries, nextCursor: 0n },
    })
    const p = await list(() => ctx, '/docs').byPage()
    expect(p.items).toHaveLength(2)
  })

  it('throws LensRequired (on .byPage) only when even the SystemAccount is unavailable', async () => {
    const ctx = makeCtx({ edges: { [`${ROOT}|docs`]: DOCS_ANCHOR } })
    ;(ctx.deployment.contracts as { systemAccount?: Address }).systemAccount = undefined
    await expect(list(() => ctx, '/docs').byPage()).rejects.toBeInstanceOf(LensRequired)
  })

  it('rejects a non-positive per-page limit override (InvalidDirectoryQuery)', async () => {
    // The constructor validates the default limit; a per-page byPage({limit:0}) override
    // must be validated too (else the contract reverts / the page never progresses).
    const ctx = makeCtx({ edges: README_EDGES, files: [fileItem({})] })
    await expect(list(() => ctx, '/docs', { lens: LENS }).byPage({ limit: 0 })).rejects.toThrow(
      /positive integer/,
    )
  })

  it('rejects a fractional/Infinity CONSTRUCTOR limit with InvalidDirectoryQuery (not RangeError)', async () => {
    // A bad default limit (no per-page override) must surface the typed error at prime
    // time, not slip through to a raw `BigInt(pageSize)` RangeError on the first page.
    const ctx = makeCtx({ edges: README_EDGES, files: [fileItem({})] })
    for (const bad of [1.5, Number.POSITIVE_INFINITY]) {
      const err = await list(() => ctx, '/docs', { lens: LENS, limit: bad })
        .byPage()
        .catch((e) => e)
      expect(err).toBeInstanceOf(InvalidDirectoryQuery)
    }
  })
})

// ── list with excludes (ADR-0011 tag-exclusion filter) ──────────────────────────

describe('list({ excludes }) — on-chain tag-exclusion filter (ADR-0011)', () => {
  const TAGS_ANCHOR = uid(0x7a65) // /tags anchor
  const NSFW_DEF = uid(0x5f0) // /tags/nsfw definition anchor
  const visibleA = (over: Partial<Item>): Item =>
    fileItem({ name: 'a.md', isFolder: false, ...over })
  const visibleB = (over: Partial<Item>): Item =>
    fileItem({ name: 'b.md', isFolder: false, ...over })

  /** Edges placing /docs + the /tags/nsfw label so the SDK can resolve it. */
  const FILTER_EDGES = {
    [`${ROOT}|docs`]: DOCS_ANCHOR,
    [`${ROOT}|tags`]: TAGS_ANCHOR,
    [`${TAGS_ANCHOR}|nsfw`]: NSFW_DEF,
  }

  it('routes to getDirectoryPageFiltered with the resolved def + reconciled weights', async () => {
    const calls: { fn: string; args: readonly unknown[] }[] = []
    const ctx = makeCtx({
      edges: FILTER_EDGES,
      filteredPages: [{ items: [visibleA({ uid: uid(0xa1) })], nextCursor: '0x' as Hex }],
      calls,
    })
    const page = await list(() => ctx, '/docs', { lens: LENS, excludes: ['nsfw'] }).byPage()
    // The single (non-excluded) entry survives.
    expect(page.items.map((e) => e.name)).toEqual(['a.md'])
    // The label resolved to the /tags/nsfw def, weights reconciled to all-zero, and
    // the filtered view was called (NOT the unfiltered sibling).
    const filtered = calls.find((c) => c.fn === 'getDirectoryPageFiltered')
    expect(filtered).toBeDefined()
    const [, anchorSchema, attesters, excludeTagDefs, minWeights] = filtered?.args as [
      Hex,
      Hex,
      readonly Address[],
      readonly Hex[],
      readonly bigint[],
    ]
    // The bucket key MUST be the DATA schema, not the ANCHOR schema: file anchors are
    // stored under `_childrenBySchema[parent][DATA_SCHEMA_UID]` and folder-visibility
    // tags key on `definition = DATA_SCHEMA_UID`. Passing the ANCHOR schema here scanned
    // an empty bucket → filtered listings dropped normal files (the bug).
    expect(anchorSchema).toBe(SCHEMAS.data)
    expect(anchorSchema).not.toBe(SCHEMAS.anchor)
    expect(attesters).toEqual([LENS]) // lens-scoped
    expect(excludeTagDefs).toEqual([NSFW_DEF])
    expect(minWeights).toEqual([0n]) // omitted ⇒ all-zero (ADR-0042 default)
    // The unfiltered sibling was never called.
    expect(calls.some((c) => c.fn === 'getDirectoryPageByAddressList')).toBe(false)
  })

  it('passes a def-UID exclude through verbatim (no label resolution)', async () => {
    const calls: { fn: string; args: readonly unknown[] }[] = []
    const ctx = makeCtx({
      edges: { [`${ROOT}|docs`]: DOCS_ANCHOR },
      filteredPages: [{ items: [], nextCursor: '0x' as Hex }],
      calls,
    })
    await list(() => ctx, '/docs', {
      lens: LENS,
      excludes: [NSFW_DEF],
      minWeights: [5n],
    }).byPage()
    const filtered = calls.find((c) => c.fn === 'getDirectoryPageFiltered')
    const [, , , excludeTagDefs, minWeights] = filtered?.args as [
      Hex,
      Hex,
      readonly Address[],
      readonly Hex[],
      readonly bigint[],
    ]
    expect(excludeTagDefs).toEqual([NSFW_DEF]) // passed through, no /tags walk
    expect(minWeights).toEqual([5n]) // explicit weight honored 1:1
    // No /tags resolution happened (a UID needs none).
    expect(calls.filter((c) => c.fn === 'resolvePath').some((c) => c.args[1] === 'nsfw')).toBe(
      false,
    )
  })

  it('drops excluded entries: the filtered view omits them (the non-excluded stay)', async () => {
    // The on-chain filter does the omission; the SDK just maps what the view returns.
    // Here the view returns only b.md (a.md was excluded by the nsfw TAG on-chain).
    const ctx = makeCtx({
      edges: FILTER_EDGES,
      filteredPages: [{ items: [visibleB({ uid: uid(0xb1) })], nextCursor: '0x' as Hex }],
    })
    const items = await list(() => ctx, '/docs', { lens: LENS, excludes: ['nsfw'] }).toArray({
      limit: 50,
    })
    expect(items.map((e) => e.name)).toEqual(['b.md'])
  })

  it('keeps paging on an EMPTY page with a non-empty cursor (phase-1 budget) — empty != end', async () => {
    // First filtered page: EMPTY items but a NON-EMPTY cursor → must NOT stop. Second
    // page yields the entry and the empty `0x` cursor → end.
    const ctx = makeCtx({
      edges: FILTER_EDGES,
      filteredPages: [
        { items: [], nextCursor: `0x${'11'.repeat(48)}` as Hex }, // empty, but more to come
        { items: [visibleA({ uid: uid(0xa1) })], nextCursor: '0x' as Hex },
      ],
    })
    const all = await list(() => ctx, '/docs', { lens: LENS, excludes: ['nsfw'] }).toArray({
      limit: 50,
    })
    expect(all.map((e) => e.name)).toEqual(['a.md'])
  })

  it('byPage surfaces the opaque bytes cursor + feeds it back', async () => {
    const NEXT = `0x${'22'.repeat(48)}` as Hex
    const ctx = makeCtx({
      edges: FILTER_EDGES,
      filteredPages: [
        { items: [visibleA({ uid: uid(0xa1) })], nextCursor: NEXT },
        { items: [visibleB({ uid: uid(0xb1) })], nextCursor: '0x' as Hex },
      ],
    })
    const efsList = list(() => ctx, '/docs', { lens: LENS, excludes: ['nsfw'] })
    const p1 = await efsList.byPage()
    expect(p1.items.map((e) => e.name)).toEqual(['a.md'])
    expect(p1.cursor).toBe(NEXT) // opaque hex cursor surfaced verbatim
    const p2 = await efsList.byPage({ cursor: p1.cursor })
    expect(p2.items.map((e) => e.name)).toEqual(['b.md'])
    expect(p2.cursor).toBeUndefined() // `0x` ⇒ exhausted
  })

  it('rejects a base-10 (unfiltered) cursor fed into the filtered path', async () => {
    const ctx = makeCtx({
      edges: FILTER_EDGES,
      filteredPages: [{ items: [], nextCursor: '0x' as Hex }],
    })
    await expect(
      list(() => ctx, '/docs', { lens: LENS, excludes: ['nsfw'] }).byPage({ cursor: '42' }),
    ).rejects.toThrow(CursorInvalid)
  })

  it('fails fast over the 8-exclude on-chain cap (InvalidDirectoryQuery)', async () => {
    const nine = new Array(9).fill(NSFW_DEF) as Hex[]
    const ctx = makeCtx({ edges: FILTER_EDGES })
    await expect(list(() => ctx, '/docs', { lens: LENS, excludes: nine }).byPage()).rejects.toThrow(
      InvalidDirectoryQuery,
    )
  })

  it('fails closed on an unresolvable exclude label (no silent unfiltered leak)', async () => {
    // /tags/nsfw does NOT exist here (only /docs is wired), so resolvePath returns ZERO
    // and the real path walk throws ParentNotFound. The filter must surface a clear
    // InvalidDirectoryQuery naming the label — never degrade to a zero def (which the
    // on-chain filter would treat as "exclude nothing", leaking the entries to hide).
    const calls: { fn: string; args: readonly unknown[] }[] = []
    const ctx = makeCtx({ edges: { [`${ROOT}|docs`]: DOCS_ANCHOR }, calls })
    await expect(
      list(() => ctx, '/docs', { lens: LENS, excludes: ['nsfw'] }).byPage(),
    ).rejects.toThrow(InvalidDirectoryQuery)
    // It fails before ever issuing a directory read (filtered OR unfiltered) — no leak.
    expect(calls.some((c) => c.fn === 'getDirectoryPageFiltered')).toBe(false)
    expect(calls.some((c) => c.fn === 'getDirectoryPageByAddressList')).toBe(false)
  })
})
