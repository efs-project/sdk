import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import type { EfsSchemaUIDs } from '../src/chain/deployments.js'
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
const CONTENT_HASH = uid(0x300) // a 0x-hex digest stand-in
const EXISTING_DATA = uid(0x400)

const baseInput = {
  path: '/docs/readme.md',
  mirrors: ['ipfs://QmExample'] as const,
  contentType: 'text/markdown',
  contentHash: CONTENT_HASH,
  size: 1234n,
  schemas: SCHEMAS,
  transportDefinition: TRANSPORT,
  parentAnchorUID: PARENT,
  fileName: 'readme.md',
} as const

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

    for (const ref of [
      REF.FILE_ANCHOR,
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

  it('encodes (name=fileName, forSchema=generic) and round-trips', () => {
    expect(a.data).toBe(anchorEnc.encodeData(['readme.md', ZERO_UID]))
    expect(anchorEnc.decodeData(a.data)).toEqual(['readme.md', ZERO_UID])
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

  it('emits one MIRROR per uri', () => {
    const two = buildFileWriteGraph({
      ...bytesInput,
      mirrors: ['ipfs://A', 'ar://B'],
    }).attestations.filter((a) => a.kind === 'MIRROR')
    expect(two).toHaveLength(2)
    expect(mirrorEnc.decodeData(two[1].data)).toEqual([TRANSPORT, 'ar://B'])
  })
})

describe('reserved-key triplets (contentType / contentHash / size)', () => {
  const atts = buildFileWriteGraph(bytesInput).attestations

  const cases: { key: 'contentType' | 'contentHash' | 'size'; value: string }[] = [
    { key: 'contentType', value: 'text/markdown' },
    { key: 'contentHash', value: CONTENT_HASH },
    { key: 'size', value: '1234' },
  ]

  for (const { key, value } of cases) {
    describe(key, () => {
      const keyAnchor = find(atts, REF.keyAnchor(key))
      const property = find(atts, REF.property(key))
      const bindingPin = find(atts, REF.bindingPin(key))

      it('key-ANCHOR: name=key, refUID=DATA, non-revocable', () => {
        expect(keyAnchor.revocable).toBe(false)
        expect(keyAnchor.refUID).toEqual({ ref: REF.DATA })
        expect(anchorEnc.decodeData(keyAnchor.data)).toEqual([key, ZERO_UID])
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

describe('hardlink short-circuit', () => {
  const graph = buildFileWriteGraph({
    ...baseInput,
    content: { kind: 'hardlink', dataUID: EXISTING_DATA },
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
})
