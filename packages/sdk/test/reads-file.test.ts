/**
 * Unit tests for the lens-scoped read verbs (`reads/file.ts`, `reads/fetch.ts`,
 * `reads/list.ts`) — driven through a mocked viem `readContract` + an injected
 * fetch transport. No live chain.
 *
 * The mock `readContract` dispatches by `functionName` over small in-memory tables
 * keyed to the FROZEN read surface:
 *   - `rootAnchorUID` / `resolvePath`      → path walk (reads/resolve.ts)
 *   - `getFilesAtPath`                       → winning placement under the lens
 *   - `resolveAnchor` + `getActivePinTarget` + `getAttestation` → reserved PROPERTY
 *   - `getDataMirrors`                       → per-DATA active mirrors
 *   - `getDirectoryPageByAddressList`        → directory page
 *
 * What is asserted (per the task's lens-scoping + verification semantics):
 *   - resolve returns a DataRef whose `resolvedBy` is the winning lens attester;
 *   - stat exists/absent (discriminated) + size/contentType from the reserved keys;
 *   - cat fetches + verifies, and a hash MISMATCH surfaces as `verification`, not a throw;
 *   - fetch(ref) works from a bare ref;
 *   - list pages + iterates with the opaque cursor;
 *   - LensRequired when neither a lens nor a wallet account is available.
 */

import { type Address, type Hex, encodeAbiParameters } from 'viem'
import { describe, expect, it } from 'vitest'
import type { EfsDeployment } from '../src/chain/deployments.js'
import { hashContent } from '../src/content/hash.js'
import { LensRequired } from '../src/errors.js'
import { FileNotFoundError } from '../src/errors.js'
import type { ReadContext } from '../src/reads/context.js'
import { cat, fetchRef } from '../src/reads/fetch.js'
import { resolve, stat } from '../src/reads/file.js'
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

/**
 * Build a mock {@link ReadContext}. `tables` configures the in-memory responses;
 * anything unset returns the empty sentinel (ZERO / empty array), matching the
 * kernel's empty-slot behavior.
 */
function makeCtx(opts: {
  account?: Address
  edges?: Record<string, Hex> // `${parent}|${name}` -> child anchor (resolvePath)
  files?: readonly Item[] // getFilesAtPath result for FILE_ANCHOR
  keyAnchors?: Record<string, Hex> // `${dataUID}|${key}` -> keyAnchor (resolveAnchor)
  pinTargets?: Record<string, Hex> // `${keyAnchor}|${attester}` -> propertyUID (getActivePinTarget)
  attestations?: Record<string, Hex> // propertyUID -> data blob (getAttestation)
  mirrors?: readonly { uri: string; attester: Address }[]
  dirPage?: { items: readonly Item[]; nextCursor: bigint }
  calls?: { fn: string; args: readonly unknown[] }[]
}): ReadContext {
  const {
    edges = {},
    files = [],
    keyAnchors = {},
    pinTargets = {},
    attestations = {},
    mirrors = [],
    dirPage = { items: [], nextCursor: 0n },
    calls = [],
  } = opts
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
        case 'resolveAnchor': {
          const [dataUID, key] = args.args as [Hex, string]
          return keyAnchors[`${dataUID}|${key}`] ?? ZERO
        }
        case 'getActivePinTarget': {
          const [keyAnchor, attester] = args.args as [Hex, Address]
          return pinTargets[`${keyAnchor}|${attester.toLowerCase()}`] ?? ZERO
        }
        case 'getAttestation': {
          const [u] = args.args as [Hex]
          return { data: attestations[u] ?? ('0x' as Hex) }
        }
        case 'getDataMirrors':
          return mirrors.map((m, i) => ({
            uid: uid(0x9000 + i),
            transportDefinition: ZERO,
            uri: m.uri,
            attester: m.attester,
            timestamp: 0n,
          }))
        case 'getDirectoryPageByAddressList':
          return dirPage
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

// ── resolve ──────────────────────────────────────────────────────────────────────

describe('resolve', () => {
  it('returns a DataRef under the given lens (resolvedBy = winning attester)', async () => {
    const ctx = makeCtx({ edges: README_EDGES, files: [fileItem({})] })
    const res = await resolve(ctx, '/docs/readme.md', { lens: LENS })
    expect(res).not.toBeNull()
    expect(res?.data.uid).toBe(DATA_UID)
    expect(res?.data.chainId).toBe(31337)
    expect(res?.data.resolvedBy).toBe(LENS)
    expect(res?.resolvedBy).toBe(LENS)
  })

  it('returns null when the file anchor does not exist', async () => {
    const ctx = makeCtx({ edges: { [`${ROOT}|docs`]: DOCS_ANCHOR }, files: [] })
    expect(await resolve(ctx, '/docs/missing.md', { lens: LENS })).toBeNull()
  })

  it('returns null when no attester in the lens placed data', async () => {
    const ctx = makeCtx({ edges: README_EDGES, files: [] }) // anchor exists, no placement
    expect(await resolve(ctx, '/docs/readme.md', { lens: LENS })).toBeNull()
  })

  it('defaults the lens to the connected wallet account', async () => {
    const ctx = makeCtx({ account: LENS, edges: README_EDGES, files: [fileItem({})] })
    const res = await resolve(ctx, '/docs/readme.md') // no opts.lens
    expect(res?.resolvedBy).toBe(LENS)
  })

  it('throws LensRequired when neither a lens nor a wallet is available', async () => {
    const ctx = makeCtx({ edges: README_EDGES, files: [fileItem({})] })
    await expect(resolve(ctx, '/docs/readme.md')).rejects.toBeInstanceOf(LensRequired)
  })
})

// ── stat ───────────────────────────────────────────────────────────────────────

describe('stat', () => {
  it('reports exists:false when nothing is placed', async () => {
    const ctx = makeCtx({ edges: README_EDGES, files: [] })
    const s = await stat(ctx, '/docs/readme.md', { lens: LENS })
    expect(s.exists).toBe(false)
  })

  it('reports exists:true with size + contentType from the reserved PROPERTYs (lens-scoped)', async () => {
    const sizeAnchor = uid(0x5102)
    const typeAnchor = uid(0xc19e)
    const sizeProp = uid(0x5170)
    const typeProp = uid(0xc170)
    const ctx = makeCtx({
      edges: README_EDGES,
      files: [fileItem({})],
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
    const s = await stat(ctx, '/docs/readme.md', { lens: LENS })
    expect(s.exists).toBe(true)
    if (s.exists) {
      expect(s.size).toBe(1234n)
      expect(s.contentType).toBe('text/markdown')
      expect(s.resolvedBy).toBe(LENS)
      expect(s.data.uid).toBe(DATA_UID)
    }
  })

  it('omits size when the reserved PROPERTY is absent', async () => {
    const ctx = makeCtx({ edges: README_EDGES, files: [fileItem({})] })
    const s = await stat(ctx, '/docs/readme.md', { lens: LENS })
    expect(s.exists).toBe(true)
    if (s.exists) expect(s.size).toBeUndefined()
  })
})

// ── cat / fetch (bytes + verification) ──────────────────────────────────────────

describe('cat + fetch', () => {
  const BYTES = new TextEncoder().encode('# Hello EFS\n')
  const GOOD_HASH = hashContent(BYTES) // 64-hex bare sha256
  const dataUri = `data:text/markdown;base64,${Buffer.from(BYTES).toString('base64')}`

  function ctxWithMirror(propHash: string) {
    const hashAnchor = uid(0x4a54)
    const hashProp = uid(0x4a51)
    return makeCtx({
      edges: README_EDGES,
      files: [fileItem({})],
      keyAnchors: { [`${DATA_UID}|contentHash`]: hashAnchor },
      pinTargets: { [`${hashAnchor}|${LENS.toLowerCase()}`]: hashProp },
      attestations: { [hashProp]: propertyData(propHash) },
      mirrors: [{ uri: dataUri, attester: LENS }],
    })
  }

  it('cat fetches bytes and verifies against the author contentHash (matches-author)', async () => {
    const file = await cat(ctxWithMirror(GOOD_HASH), '/docs/readme.md', { lens: LENS })
    expect(new TextDecoder().decode(file.bytes)).toBe('# Hello EFS\n')
    expect(file.verification).toBe('matches-author')
    expect(file.hashAuthor).toBe(LENS)
  })

  it('surfaces a hash MISMATCH as verification status, not a throw', async () => {
    const wrong = 'a'.repeat(64)
    const file = await cat(ctxWithMirror(wrong), '/docs/readme.md', { lens: LENS })
    expect(file.verification).toBe('mismatch')
    // Bytes are still returned — the caller decides whether to trust them.
    expect(file.bytes.byteLength).toBeGreaterThan(0)
  })

  it('reports no-claim when verify:false (no contentHash lookup)', async () => {
    const file = await cat(ctxWithMirror(GOOD_HASH), '/docs/readme.md', {
      lens: LENS,
      verify: false,
    })
    expect(file.verification).toBe('no-claim')
  })

  it('cat throws FileNotFoundError when nothing is placed at the path', async () => {
    const ctx = makeCtx({ edges: README_EDGES, files: [] })
    await expect(cat(ctx, '/docs/readme.md', { lens: LENS })).rejects.toBeInstanceOf(
      FileNotFoundError,
    )
  })

  it('fetch(ref) verifies from a bare DataRef (lens carried by the ref)', async () => {
    const hashAnchor = uid(0x4a54)
    const hashProp = uid(0x4a51)
    const ctx = makeCtx({
      keyAnchors: { [`${DATA_UID}|contentHash`]: hashAnchor },
      pinTargets: { [`${hashAnchor}|${LENS.toLowerCase()}`]: hashProp },
      attestations: { [hashProp]: propertyData(GOOD_HASH) },
      mirrors: [{ uri: dataUri, attester: LENS }],
    })
    const ref: DataRef = {
      __brand: 'DataRef',
      uid: DATA_UID,
      chainId: 31337,
      resolvedBy: LENS,
    }
    const file = await fetchRef(ctx, ref)
    expect(file.verification).toBe('matches-author')
    expect(file.hashAuthor).toBe(LENS)
  })

  it('ignores mirrors attached by a non-lens attester', async () => {
    const hashAnchor = uid(0x4a54)
    const hashProp = uid(0x4a51)
    const ctx = makeCtx({
      keyAnchors: { [`${DATA_UID}|contentHash`]: hashAnchor },
      pinTargets: { [`${hashAnchor}|${LENS.toLowerCase()}`]: hashProp },
      attestations: { [hashProp]: propertyData(GOOD_HASH) },
      mirrors: [{ uri: dataUri, attester: OTHER }], // wrong attester
    })
    const ref: DataRef = { __brand: 'DataRef', uid: DATA_UID, chainId: 31337, resolvedBy: LENS }
    // No lens-scoped mirror → AllMirrorsFailed (classified EfsError).
    await expect(fetchRef(ctx, ref)).rejects.toThrow()
  })
})

// ── list (pagination + iteration) ───────────────────────────────────────────────

describe('list', () => {
  const dirEntries: readonly Item[] = [
    fileItem({ uid: uid(0x201), name: 'a.md', isFolder: false, hasData: true }),
    fileItem({ uid: uid(0x202), name: 'sub', isFolder: true, hasData: false }),
  ]

  it('returns a page of DirEntry with kind file|dir and the anchoring UID', async () => {
    const ctx = makeCtx({
      edges: { [`${ROOT}|docs`]: DOCS_ANCHOR },
      dirPage: { items: dirEntries, nextCursor: 0n },
    })
    const p = await list(() => ctx, '/docs', { lens: LENS }).page()
    expect(p.items).toHaveLength(2)
    expect(p.items[0]).toEqual({ name: 'a.md', kind: 'file', dataUID: uid(0x201) })
    expect(p.items[1]).toEqual({ name: 'sub', kind: 'dir', anchorUID: uid(0x202) })
    expect(p.nextCursor).toBeUndefined() // nextCursor 0 → end
  })

  it('exposes a resumable opaque cursor when more remain', async () => {
    const ctx = makeCtx({
      edges: { [`${ROOT}|docs`]: DOCS_ANCHOR },
      dirPage: { items: dirEntries, nextCursor: 7n },
    })
    const p = await list(() => ctx, '/docs', { lens: LENS }).page({ limit: 2 })
    expect(p.nextCursor).toBe('7')
  })

  it('async-iterates across pages until the cursor is exhausted', async () => {
    // First window returns nextCursor 1, second returns 0 (end). We flip the table
    // between calls via a counter in the mock.
    let call = 0
    const calls: { fn: string; args: readonly unknown[] }[] = []
    const ctx = makeCtx({ edges: { [`${ROOT}|docs`]: DOCS_ANCHOR }, calls })
    // Override getDirectoryPageByAddressList with a paging stub.
    const inner = ctx.publicClient.readContract.bind(ctx.publicClient)
    ctx.publicClient.readContract = async (args) => {
      if (args.functionName === 'getDirectoryPageByAddressList') {
        call += 1
        return call === 1
          ? { items: [dirEntries[0]], nextCursor: 1n }
          : { items: [dirEntries[1]], nextCursor: 0n }
      }
      return inner(args)
    }
    const names: string[] = []
    for await (const e of list(() => ctx, '/docs', { lens: LENS })) names.push(e.name)
    expect(names).toEqual(['a.md', 'sub'])
    expect(call).toBe(2) // two windows walked
  })

  it('throws LensRequired (on iterate) when no lens/wallet is available', async () => {
    const ctx = makeCtx({ edges: { [`${ROOT}|docs`]: DOCS_ANCHOR } })
    await expect(list(() => ctx, '/docs').page()).rejects.toBeInstanceOf(LensRequired)
  })

  it('refuses the filtered (excludes) path until it is wired', () => {
    const ctx = makeCtx({ edges: { [`${ROOT}|docs`]: DOCS_ANCHOR } })
    expect(() => list(() => ctx, '/docs', { lens: LENS, excludes: ['nsfw'] })).toThrow(/excludes/)
  })
})
