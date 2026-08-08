import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import type { EfsSchemaUIDs } from '../src/chain/deployments.js'
import { hashContent } from '../src/content/hash.js'
import { SchemaEncoder } from '../src/eas/schema-encoder.js'
import { EFS_SCHEMA_FIELDS } from '../src/eas/schemas.js'
import {
  type PlannedAttestation,
  REF,
  ZERO_UID,
  buildFileWriteGraph,
  isSymbolicRef,
} from '../src/writes/graph.js'

// Distinct, recognizable fake UIDs so we can assert exact wiring.
const uid = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex

const SCHEMAS: EfsSchemaUIDs = {
  anchor: uid(0xa),
  property: uid(0xb),
  data: uid(0xc),
  pin: uid(0xd),
  tag: uid(0xe),
  mirror: uid(0xf),
  list: uid(0x10),
  listEntry: uid(0x11),
  redirect: uid(0x12),
}

const PARENT = uid(0x100)
const TRANSPORT = uid(0x200)
// The CANONICAL specs/10 §2.3 form (f1220 + 64 hex) — the graph emits it verbatim
// as the non-revocable PROPERTY value, so the fixture pins the exact wire shape.
const CONTENT_HASH = hashContent(new Uint8Array([1, 2, 3]))
const EXISTING_DATA = uid(0x400)

const baseInput = {
  path: '/docs/readme.md',
  mirrors: [{ uri: 'ipfs://QmExample', transportDefinition: TRANSPORT }] as const,
  contentType: 'text/markdown',
  contentHash: CONTENT_HASH,
  size: 3n, // must MATCH the bytes — the builder verifies correspondence
  schemas: SCHEMAS,
  parentAnchorUID: PARENT,
  fileName: 'readme.md',
} as const

/** baseInput minus the byte-write metadata — HARDLINK inputs carry none (the
 * builder now REJECTS stray metadata instead of discarding it, r3741086780). */
const {
  mirrors: _hlM,
  contentHash: _hlH,
  size: _hlS,
  contentType: _hlT,
  ...hardlinkBase
} = baseInput
void [_hlM, _hlH, _hlS, _hlT]

const bytesInput = {
  ...baseInput,
  content: { kind: 'bytes' as const, bytes: new Uint8Array([1, 2, 3]) },
}

const find = (atts: readonly PlannedAttestation[], ref: string) => {
  const a = atts.find((x) => x.ref === ref)
  if (!a) throw new Error(`no planned attestation with ref ${ref}`)
  return a
}

const anchorEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.anchor)
const propertyEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.property)
const mirrorEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.mirror)
const dataEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.data)
const pinEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.pin)

describe('buildFileWriteGraph — full new-file graph', () => {
  const graph = buildFileWriteGraph(bytesInput)
  const atts = graph.attestations

  it('is not a hardlink', () => {
    expect(graph.hardlink).toBe(false)
  })

  it('emits the full ~13-node graph (1 DATA + 1 file-anchor + 1 mirror + 3 triplets + 1 placement)', () => {
    // 1 DATA, 1 file-ANCHOR, 1 MIRROR, 3 reserved keys × (anchor+property+pin) = 9,
    // 1 placement-PIN => 13.
    expect(atts).toHaveLength(13)
  })

  it('assigns each node to the correct DAG layer', () => {
    expect(find(atts, REF.DATA).layer).toBe(1)
    // The file-ANCHOR shares DATA's layer (r3741399511): a same-path race then
    // rolls the WHOLE layer back on DuplicateFileName — no orphaned DATA.
    expect(find(atts, REF.FILE_ANCHOR).layer).toBe(1)

    for (const ref of [
      REF.mirror(0),
      REF.keyAnchor('contentType'),
      REF.keyAnchor('contentHash'),
      REF.keyAnchor('size'),
      REF.property('contentType'),
      REF.property('contentHash'),
      REF.property('size'),
    ]) {
      expect(find(atts, ref).layer).toBe(2)
    }

    for (const ref of [
      REF.PLACEMENT_PIN,
      REF.bindingPin('contentType'),
      REF.bindingPin('contentHash'),
      REF.bindingPin('size'),
    ]) {
      expect(find(atts, ref).layer).toBe(3)
    }
  })

  it('orders attestations by non-decreasing layer (submit ordering)', () => {
    const layers = atts.map((a) => a.layer)
    const sorted = [...layers].sort((a, b) => a - b)
    expect(layers).toEqual(sorted)
  })

  it('has a unique ref per attestation', () => {
    const refs = atts.map((a) => a.ref)
    expect(new Set(refs).size).toBe(refs.length)
  })

  it('uses recipient/value/expiration zeros (modeled as fixed, not per-entry)', () => {
    // The PlannedAttestation type omits recipient/value/expirationTime precisely
    // because they are fixed to 0x0/0n/0n; assert none of them leaked onto a node.
    for (const a of atts) {
      expect(a).not.toHaveProperty('recipient')
      expect(a).not.toHaveProperty('value')
      expect(a).not.toHaveProperty('expirationTime')
    }
  })
})

describe('DATA node honors the onAttest constraints', () => {
  const data = find(buildFileWriteGraph(bytesInput).attestations, REF.DATA)

  it('refUID is 0x0, non-revocable, empty data (EFSIndexer.sol:472-475)', () => {
    expect(data.refUID).toBe(ZERO_UID)
    expect(data.revocable).toBe(false)
    expect(data.data).toBe('0x')
    expect(data.dataRefs).toEqual([])
  })

  it('encodes the empty schema and decodes back to []', () => {
    expect(dataEnc.decodeData(data.data)).toEqual([])
  })

  it('targets the frozen DATA schema UID', () => {
    expect(data.schema).toBe(SCHEMAS.data)
  })
})

describe('file-ANCHOR node', () => {
  const a = find(buildFileWriteGraph(bytesInput).attestations, REF.FILE_ANCHOR)

  it('is non-revocable and points refUID at the pre-existing parent (concrete Hex)', () => {
    expect(a.revocable).toBe(false)
    expect(a.refUID).toBe(PARENT)
    expect(isSymbolicRef(a.refUID)).toBe(false)
  })

  it('encodes (name=fileName, forSchema=DATA schema) and round-trips', () => {
    // A file anchor MUST be DATA-typed — the kernel keys anchors by (parent, name,
    // forSchema); a generic file would land in the folder bucket and miss file
    // listings (EFSFileView Phase 1 reads only the DATA bucket). Folders stay generic.
    expect(a.data).toBe(anchorEnc.encodeData(['readme.md', SCHEMAS.data]))
    expect(anchorEnc.decodeData(a.data)).toEqual(['readme.md', SCHEMAS.data])
  })
})

describe('MIRROR node', () => {
  const m = find(buildFileWriteGraph(bytesInput).attestations, REF.mirror(0))

  it('is revocable and symbolically references DATA via refUID (MirrorResolver.sol:154-164)', () => {
    expect(m.revocable).toBe(true)
    expect(isSymbolicRef(m.refUID)).toBe(true)
    expect(m.refUID).toEqual({ ref: REF.DATA })
  })

  it('encodes (transportDefinition, uri) and round-trips', () => {
    expect(m.data).toBe(mirrorEnc.encodeData([TRANSPORT, 'ipfs://QmExample']))
    expect(mirrorEnc.decodeData(m.data)).toEqual([TRANSPORT, 'ipfs://QmExample'])
  })

  it('emits one MIRROR per uri, each labeled with its OWN transport (mixed-scheme)', () => {
    const IPFS_T = `0x${'a1'.repeat(32)}` as const
    const AR_T = `0x${'b2'.repeat(32)}` as const
    const two = buildFileWriteGraph({
      ...bytesInput,
      mirrors: [
        { uri: 'ipfs://A', transportDefinition: IPFS_T },
        { uri: 'ar://B', transportDefinition: AR_T },
      ],
    }).attestations.filter((a) => a.kind === 'MIRROR')
    expect(two).toHaveLength(2)
    // Each MIRROR carries its own transport — the ar:// entry is NOT mislabeled
    // with the ipfs transport (the bug this guards).
    expect(mirrorEnc.decodeData(two[0].data)).toEqual([IPFS_T, 'ipfs://A'])
    expect(mirrorEnc.decodeData(two[1].data)).toEqual([AR_T, 'ar://B'])
  })
})

describe('reserved-key triplets (contentType / contentHash / size)', () => {
  const atts = buildFileWriteGraph(bytesInput).attestations

  it('persists the contentHash PROPERTY as exactly the canonical f1220… string (specs/10 §2.2 non-revocable-value guard)', () => {
    expect(CONTENT_HASH).toMatch(/^f1220[0-9a-f]{64}$/)
  })

  const cases: { key: 'contentType' | 'contentHash' | 'size'; value: string }[] = [
    { key: 'contentType', value: 'text/markdown' },
    { key: 'contentHash', value: CONTENT_HASH },
    { key: 'size', value: '3' },
  ]

  for (const { key, value } of cases) {
    describe(key, () => {
      const keyAnchor = find(atts, REF.keyAnchor(key))
      const property = find(atts, REF.property(key))
      const bindingPin = find(atts, REF.bindingPin(key))

      it('key-ANCHOR: name=key, forSchema=PROPERTY_SCHEMA, refUID=DATA, non-revocable', () => {
        expect(keyAnchor.revocable).toBe(false)
        expect(keyAnchor.refUID).toEqual({ ref: REF.DATA })
        // forSchema MUST be the PROPERTY schema UID so the kernel files the anchor
        // at `_nameToAnchor[DATA][key][PROPERTY_SCHEMA]`, where the canonical reader
        // (EFSRouter._getContentType / readReservedProperty) resolves it.
        expect(anchorEnc.decodeData(keyAnchor.data)).toEqual([key, SCHEMAS.property])
      })

      it('PROPERTY: value, refUID=0x0, non-revocable (EFSIndexer.sol:488-489)', () => {
        expect(property.revocable).toBe(false)
        expect(property.refUID).toBe(ZERO_UID)
        expect(propertyEnc.decodeData(property.data)).toEqual([value])
      })

      it('binding-PIN: refUID=PROPERTY, definition=key-ANCHOR (symbolic), revocable', () => {
        expect(bindingPin.revocable).toBe(true)
        expect(bindingPin.refUID).toEqual({ ref: REF.property(key) })
        expect(bindingPin.dataRefs).toEqual([
          { field: 'definition', ref: { ref: REF.keyAnchor(key) } },
        ])
        // The encoded `definition` is a placeholder (the submitter re-encodes it).
        expect(pinEnc.decodeData(bindingPin.data)).toEqual([ZERO_UID])
      })
    })
  }

  it('omits the contentType triplet when no contentType is given', () => {
    const noType = buildFileWriteGraph({ ...bytesInput, contentType: undefined })
    const refs = noType.attestations.map((a) => a.ref)
    expect(refs).not.toContain(REF.keyAnchor('contentType'))
    expect(refs).not.toContain(REF.property('contentType'))
    expect(refs).not.toContain(REF.bindingPin('contentType'))
    // 13 - 3 = 10 nodes.
    expect(noType.attestations).toHaveLength(10)
  })
})

describe('placement-PIN node', () => {
  const p = find(buildFileWriteGraph(bytesInput).attestations, REF.PLACEMENT_PIN)

  it('refUID=DATA (symbolic), definition=file-ANCHOR (symbolic in dataRefs), revocable (EdgeResolver.sol:336)', () => {
    expect(p.revocable).toBe(true)
    expect(p.refUID).toEqual({ ref: REF.DATA })
    expect(p.dataRefs).toEqual([{ field: 'definition', ref: { ref: REF.FILE_ANCHOR } }])
    expect(pinEnc.decodeData(p.data)).toEqual([ZERO_UID])
  })
})

describe('symbolic refUID threading — every symbol resolves to a sibling ref', () => {
  const atts = buildFileWriteGraph(bytesInput).attestations
  const presentRefs = new Set(atts.map((a) => a.ref))

  it('every symbolic refUID names a real sibling', () => {
    for (const a of atts) {
      if (isSymbolicRef(a.refUID)) {
        expect(presentRefs.has(a.refUID.ref)).toBe(true)
      }
    }
  })

  it('every symbolic dataRef names a real sibling', () => {
    for (const a of atts) {
      for (const dr of a.dataRefs) {
        expect(presentRefs.has(dr.ref.ref)).toBe(true)
      }
    }
  })

  it('L3 nodes only reference L1/L2 siblings (no forward refs within a layer that break ordering)', () => {
    const layerOf = new Map(atts.map((a) => [a.ref, a.layer]))
    for (const a of atts) {
      const referenced = [
        ...(isSymbolicRef(a.refUID) ? [a.refUID.ref] : []),
        ...a.dataRefs.map((d) => d.ref.ref),
      ]
      for (const r of referenced) {
        // a referenced sibling must be in a strictly-earlier layer
        expect(layerOf.get(r)!).toBeLessThan(a.layer)
      }
    }
  })
})

describe('mkdir -p — missing ancestor folders folded into the write', () => {
  const DEEPEST_EXISTING = uid(0x500)

  describe('fully-missing nested parents (createParents)', () => {
    // /photos/2026/trip.jpg where neither /photos nor /photos/2026 exist: the
    // deepest existing anchor is the root, and BOTH segments are created.
    const graph = buildFileWriteGraph({
      ...bytesInput,
      path: '/photos/2026/trip.jpg',
      fileName: 'trip.jpg',
      parentAnchorUID: DEEPEST_EXISTING, // = the deepest existing anchor (e.g. root)
      missingParents: ['photos', '2026'],
    })
    const atts = graph.attestations

    it('emits one ANCHOR per missing folder, shallowest-first, in the earliest layers', () => {
      const photos = find(atts, REF.parentFolder(0))
      const y2026 = find(atts, REF.parentFolder(1))
      expect(photos.kind).toBe('ANCHOR')
      expect(y2026.kind).toBe('ANCHOR')
      // Shallowest folder mines first (layer 1), next folder layer 2.
      expect(photos.layer).toBe(1)
      expect(y2026.layer).toBe(2)
      // Folder anchors are permanent (non-revocable).
      expect(photos.revocable).toBe(false)
      expect(y2026.revocable).toBe(false)
      // Each names its own segment (forSchema = generic folder sentinel).
      expect(anchorEnc.decodeData(photos.data)).toEqual(['photos', ZERO_UID])
      expect(anchorEnc.decodeData(y2026.data)).toEqual(['2026', ZERO_UID])
    })

    it('chains the refUID: first folder → deepest existing (concrete), next → prior folder (symbolic)', () => {
      const photos = find(atts, REF.parentFolder(0))
      const y2026 = find(atts, REF.parentFolder(1))
      // First created folder hangs off the deepest EXISTING anchor (concrete Hex).
      expect(photos.refUID).toBe(DEEPEST_EXISTING)
      expect(isSymbolicRef(photos.refUID)).toBe(false)
      // Second folder hangs off the first created folder (symbolic).
      expect(isSymbolicRef(y2026.refUID)).toBe(true)
      expect(y2026.refUID).toEqual({ ref: REF.parentFolder(0) })
    })

    it('threads the LAST created folder into the file-ANCHOR refUID (symbolic)', () => {
      const fileAnchor = find(atts, REF.FILE_ANCHOR)
      expect(isSymbolicRef(fileAnchor.refUID)).toBe(true)
      expect(fileAnchor.refUID).toEqual({ ref: REF.parentFolder(1) })
    })

    it('shifts DATA/L2/PIN layers up by the missing-folder count (folders mine first)', () => {
      const m = 2 // two created folders
      // DATA base layer 1 → m+1 = 3.
      expect(find(atts, REF.DATA).layer).toBe(m + 1)
      // file-ANCHOR shares DATA's layer (m+1); MIRROR base layer 2 → m+2 = 4.
      expect(find(atts, REF.FILE_ANCHOR).layer).toBe(m + 1)
      expect(find(atts, REF.mirror(0)).layer).toBe(m + 2)
      // placement-PIN base layer 3 → m+3 = 5.
      expect(find(atts, REF.PLACEMENT_PIN).layer).toBe(m + 3)
    })

    it('emits the base 13-node graph PLUS the 2 created folders + their 2 visibility TAGs', () => {
      // 13 base + 2 created-folder ANCHORs + 2 created-folder visibility TAGs = 17.
      expect(atts).toHaveLength(17)
      // Both created folders get a TAG (brand-new folders always need one); each
      // targets its symbolic folder ref and is placed in the last layer.
      const tags = atts.filter((a) => a.kind === 'TAG')
      expect(tags).toHaveLength(2)
      expect(tags.map((t) => t.refUID)).toEqual([
        { ref: REF.parentFolder(0) },
        { ref: REF.parentFolder(1) },
      ])
      const maxLayer = Math.max(...atts.map((a) => a.layer))
      expect(tags.every((t) => t.layer === maxLayer)).toBe(true)
    })

    it('orders attestations by non-decreasing layer and only refs strictly-earlier layers', () => {
      const layers = atts.map((a) => a.layer)
      expect(layers).toEqual([...layers].sort((a, b) => a - b))
      const layerOf = new Map(atts.map((a) => [a.ref, a.layer]))
      for (const a of atts) {
        const referenced = [
          ...(isSymbolicRef(a.refUID) ? [a.refUID.ref] : []),
          ...a.dataRefs.map((d) => d.ref.ref),
        ]
        for (const r of referenced) {
          expect(layerOf.get(r)!).toBeLessThan(a.layer)
        }
      }
    })
  })

  describe('only the leaf folder missing — reuse the deepest existing ancestor', () => {
    // /photos/2026/trip.jpg where /photos exists but /photos/2026 does not: ONLY
    // '2026' is created, hanging off the existing /photos anchor.
    const PHOTOS_ANCHOR = uid(0x510)
    const graph = buildFileWriteGraph({
      ...bytesInput,
      path: '/photos/2026/trip.jpg',
      fileName: 'trip.jpg',
      parentAnchorUID: PHOTOS_ANCHOR, // deepest existing = /photos
      missingParents: ['2026'],
    })
    const atts = graph.attestations

    it('creates ONLY the leaf folder, off the deepest existing anchor', () => {
      const folder = find(atts, REF.parentFolder(0))
      expect(anchorEnc.decodeData(folder.data)).toEqual(['2026', ZERO_UID])
      expect(folder.refUID).toBe(PHOTOS_ANCHOR) // reuses the existing /photos anchor
      expect(atts.filter((a) => a.ref.startsWith('parentFolder:'))).toHaveLength(1)
    })

    it('file-ANCHOR refs the single created folder; layers shift by 1', () => {
      const fileAnchor = find(atts, REF.FILE_ANCHOR)
      expect(fileAnchor.refUID).toEqual({ ref: REF.parentFolder(0) })
      expect(fileAnchor.layer).toBe(2) // m=1 → shares DATA's layer (m+1 = 2)
      expect(find(atts, REF.DATA).layer).toBe(2) // m+1
    })

    it('emits the base 13-node graph PLUS the 1 created folder + its visibility TAG', () => {
      // 13 base + 1 created-folder ANCHOR + 1 created-folder visibility TAG = 15.
      // (The existing /photos ancestor is NOT auto-tagged by the pure builder — the
      // caller passes those in via `existingAncestorTagUIDs`; none here.)
      expect(atts).toHaveLength(15)
      const tags = atts.filter((a) => a.kind === 'TAG')
      expect(tags).toHaveLength(1)
      expect(tags[0]!.refUID).toEqual({ ref: REF.parentFolder(0) })
    })
  })

  describe('parents already exist (no missingParents) — no extra folder anchors', () => {
    const graph = buildFileWriteGraph(bytesInput) // baseInput has no missingParents
    const atts = graph.attestations

    it('emits no parentFolder anchors and keeps the base layers', () => {
      expect(atts.filter((a) => a.ref.startsWith('parentFolder:'))).toHaveLength(0)
      expect(atts).toHaveLength(13)
      // file-ANCHOR refs the concrete parent directly (unchanged behavior).
      expect(find(atts, REF.FILE_ANCHOR).refUID).toBe(PARENT)
      expect(find(atts, REF.DATA).layer).toBe(1)
      expect(find(atts, REF.PLACEMENT_PIN).layer).toBe(3)
    })
  })

  describe('hardlink + missing parents', () => {
    const graph = buildFileWriteGraph({
      ...hardlinkBase,
      path: '/photos/2026/trip.jpg',
      fileName: 'trip.jpg',
      parentAnchorUID: DEEPEST_EXISTING,
      missingParents: ['photos', '2026'],
      content: { kind: 'hardlink', dataUID: EXISTING_DATA },
    })
    const atts = graph.attestations

    it('still creates the folder chain before the file-ANCHOR + placement PIN, then tags the folders', () => {
      expect(graph.hardlink).toBe(true)
      // Hardlinking into a new subtree still tags the created folders (so the file
      // shows in the uploader's lens) — the two created-folder visibility TAGs follow
      // the placement PIN, in the last layer.
      expect(atts.map((a) => a.ref)).toEqual([
        REF.parentFolder(0),
        REF.parentFolder(1),
        REF.FILE_ANCHOR,
        REF.PLACEMENT_PIN,
        REF.createdFolderTag(0),
        REF.createdFolderTag(1),
      ])
      // file-ANCHOR refs the last created folder; PIN refs the existing DATA.
      expect(find(atts, REF.FILE_ANCHOR).refUID).toEqual({ ref: REF.parentFolder(1) })
      expect(find(atts, REF.PLACEMENT_PIN).refUID).toBe(EXISTING_DATA)
      const tags = atts.filter((a) => a.kind === 'TAG')
      expect(tags.map((t) => t.refUID)).toEqual([
        { ref: REF.parentFolder(0) },
        { ref: REF.parentFolder(1) },
      ])
      // TAGs are in the last layer (after the placement PIN).
      const maxLayer = Math.max(...atts.map((a) => a.layer))
      expect(tags.every((t) => t.layer === maxLayer)).toBe(true)
    })
  })
})

describe('missingParents + existingFileAnchorUID is rejected (review r3741637988)', () => {
  it('bytes: a reused anchor cannot combine with created parents', () => {
    expect(() =>
      buildFileWriteGraph({
        ...baseInput,
        content: { kind: 'bytes', bytes: new Uint8Array([1, 2, 3]) },
        missingParents: ['photos'],
        existingFileAnchorUID: uid(0xcc),
      }),
    ).toThrowError(/cannot be combined with `missingParents`/)
  })

  it('hardlink: same rejection', () => {
    expect(() =>
      buildFileWriteGraph({
        ...hardlinkBase,
        content: { kind: 'hardlink', dataUID: EXISTING_DATA },
        missingParents: ['photos'],
        existingFileAnchorUID: uid(0xcc),
      }),
    ).toThrowError(/cannot be combined with `missingParents`/)
  })
})

describe('byte-plan builder preflight (reviews r3741586928 / r3741586938)', () => {
  const bytes = new Uint8Array([1, 2, 3])
  const good = {
    ...baseInput,
    content: { kind: 'bytes' as const, bytes },
  }

  it('REJECTS a blank mirror URI before any layer is built', () => {
    expect(() =>
      buildFileWriteGraph({
        ...good,
        mirrors: [{ uri: '', transportDefinition: baseInput.mirrors[0]!.transportDefinition }],
      }),
    ).toThrowError(/InvalidArgument|URI/i)
  })

  it('REJECTS an oversized mirror URI (MirrorResolver would revert at layer 2)', () => {
    expect(() =>
      buildFileWriteGraph({
        ...good,
        mirrors: [
          {
            uri: `ipfs://${'Q'.repeat(9000)}`,
            transportDefinition: baseInput.mirrors[0]!.transportDefinition,
          },
        ],
      }),
    ).toThrowError(/URI|8192|length/i)
  })

  it('REJECTS a STALE contentHash — permanent metadata must describe the bytes', () => {
    expect(() =>
      buildFileWriteGraph({
        ...good,
        contentHash: hashContent(new Uint8Array([9, 9, 9])), // hash of OTHER bytes
      }),
    ).toThrowError(/contentHash.*does not match/)
  })

  it('REJECTS a wrong size', () => {
    expect(() => buildFileWriteGraph({ ...good, size: 999n })).toThrowError(/size.*does not match/)
  })
})

describe('byte-plan mirror floor (review r3741534977)', () => {
  it('REJECTS an empty mirror set — a mirror-less file is unreadable', () => {
    expect(() =>
      buildFileWriteGraph({
        ...baseInput,
        content: { kind: 'bytes', bytes: new Uint8Array([1]) },
        mirrors: [],
      }),
    ).toThrowError(/at least one mirror/)
  })
})

describe('hardlink short-circuit', () => {
  const graph = buildFileWriteGraph({
    ...hardlinkBase,
    content: { kind: 'hardlink', dataUID: EXISTING_DATA },
  })

  it('REJECTS stray retrieval metadata instead of discarding it (r3741086780)', () => {
    // A hardlink plan cannot carry mirrors/contentHash/size: the placer must
    // already have authored the DATA + metadata (self-dedup) — silently
    // dropping supplied metadata produced an unreadable, unverifiable file.
    expect(() =>
      buildFileWriteGraph({
        ...baseInput, // metadata still present
        content: { kind: 'hardlink', dataUID: EXISTING_DATA },
      } as never),
    ).toThrowError(/HARDLINK plan carries no retrieval metadata/)
  })

  it('flags hardlink and collapses the content graph (no DATA/MIRROR/PROPERTY)', () => {
    expect(graph.hardlink).toBe(true)
    const kinds = graph.attestations.map((a) => a.kind)
    expect(kinds).not.toContain('DATA')
    expect(kinds).not.toContain('MIRROR')
    expect(kinds).not.toContain('PROPERTY')
  })

  it('emits the file-ANCHOR plus a single placement PIN pointing at the existing DATA', () => {
    expect(graph.attestations.map((a) => a.ref)).toEqual([REF.FILE_ANCHOR, REF.PLACEMENT_PIN])
    const pin = find(graph.attestations, REF.PLACEMENT_PIN)
    // refUID is the *concrete* existing DATA UID — not symbolic.
    expect(pin.refUID).toBe(EXISTING_DATA)
    expect(isSymbolicRef(pin.refUID)).toBe(false)
    // definition still points at the fresh file-ANCHOR.
    expect(pin.dataRefs).toEqual([{ field: 'definition', ref: { ref: REF.FILE_ANCHOR } }])
    expect(pin.revocable).toBe(true)
  })

  it('relink to an EXISTING path reuses the file anchor (no fresh ANCHOR; PIN at the existing one)', () => {
    const EXISTING_ANCHOR = `0x${'cc'.repeat(32)}` as Hex
    const g = buildFileWriteGraph({
      ...hardlinkBase,
      content: { kind: 'hardlink', dataUID: EXISTING_DATA },
      existingFileAnchorUID: EXISTING_ANCHOR,
    })
    // No fresh file-ANCHOR minted — the permanent existing one is reused.
    expect(g.attestations.map((a) => a.kind)).not.toContain('ANCHOR')
    const pin = find(g.attestations, REF.PLACEMENT_PIN)
    // PIN definition = the CONCRETE existing anchor (encoded directly, no symbolic thread).
    expect(pin.dataRefs).toEqual([])
    const pinEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.pin)
    expect(pin.data).toBe(pinEnc.encodeData([EXISTING_ANCHOR]))
    expect(pin.refUID).toBe(EXISTING_DATA)
  })
})

describe('folder-visibility TAGs (overview.md step 7; specs/02 §4a; ADR-0038/0041)', () => {
  const tagEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.tag)
  const EX1 = uid(0xe10)
  const EX2 = uid(0xe20)

  it('emits a correctly-encoded TAG per existing-ancestor UID (definition=DATA, weight=1, revocable)', () => {
    const graph = buildFileWriteGraph({ ...bytesInput, existingAncestorTagUIDs: [EX1, EX2] })
    const tags = graph.attestations.filter((a) => a.kind === 'TAG')
    expect(tags).toHaveLength(2)
    for (const t of tags) {
      expect(t.schema).toBe(SCHEMAS.tag)
      expect(t.revocable).toBe(true) // EdgeResolver: TAG must be revocable
      const [definition, weight] = tagEnc.decodeData(t.data) as [Hex, bigint]
      expect(definition).toBe(SCHEMAS.data) // folder-visibility definition = DATA schema UID
      expect(weight).toBe(1n) // weight defaults to 1 by convention (ADR-0041 §4)
    }
    // The TAG refUIDs are the concrete existing-ancestor UIDs (not symbolic).
    expect(tags.map((t) => t.refUID).sort()).toEqual([EX1, EX2].sort())
    expect(tags.every((t) => !isSymbolicRef(t.refUID))).toBe(true)
  })

  it('places TAGs in the LAST layer (after the placement PIN), and only refs earlier layers', () => {
    const graph = buildFileWriteGraph({ ...bytesInput, existingAncestorTagUIDs: [EX1] })
    const atts = graph.attestations
    const tag = atts.find((a) => a.kind === 'TAG')!
    const pinLayer = find(atts, REF.PLACEMENT_PIN).layer
    expect(tag.layer).toBeGreaterThan(pinLayer)
    expect(tag.layer).toBe(Math.max(...atts.map((a) => a.layer)))
  })

  it('combines created-folder TAGs (symbolic) with existing-ancestor TAGs (concrete)', () => {
    const graph = buildFileWriteGraph({
      ...bytesInput,
      path: '/a/new/file.txt',
      fileName: 'file.txt',
      parentAnchorUID: uid(0xaaa), // deepest existing = /a
      missingParents: ['new'], // /a/new is created in this write
      existingAncestorTagUIDs: [uid(0xaaa)], // /a exists + untagged
    })
    const tags = graph.attestations.filter((a) => a.kind === 'TAG')
    expect(tags).toHaveLength(2)
    // Created folder → symbolic ref; existing ancestor → concrete UID.
    expect(tags.some((t) => isSymbolicRef(t.refUID) && t.refUID.ref === REF.parentFolder(0))).toBe(
      true,
    )
    expect(tags.some((t) => t.refUID === uid(0xaaa))).toBe(true)
  })

  it('no missingParents + no existingAncestorTagUIDs → zero TAGs (steady-state)', () => {
    const graph = buildFileWriteGraph(bytesInput)
    expect(graph.attestations.some((a) => a.kind === 'TAG')).toBe(false)
  })

  it('never tags the file anchor or any non-folder node', () => {
    const graph = buildFileWriteGraph({ ...bytesInput, existingAncestorTagUIDs: [EX1] })
    const tags = graph.attestations.filter((a) => a.kind === 'TAG')
    // No TAG targets the fresh file-ANCHOR (symbolically or concretely) — only
    // folders are tagged. The only TAG target here is the supplied existing ancestor.
    const targets = tags.map((t) => (isSymbolicRef(t.refUID) ? t.refUID.ref : t.refUID))
    expect(targets).not.toContain(REF.FILE_ANCHOR)
    expect(targets).toEqual([EX1])
  })
})
