/**
 * Unit tests for path resolution (`reads/resolve.ts`) — the write-path parent
 * lookup. Driven through a stub `readContract` (the narrow `ResolvePublicClient`
 * surface), mirroring the mock style of `writes-submit.test.ts`. No live chain.
 *
 * Semantics under test (FROZEN EFSIndexer.sol):
 *   - the walk seeds from `rootAnchorUID()` and resolves each segment via
 *     `resolvePath(parent, name)` (the generic/folder flavor, EFSIndexer.sol
 *     :523-525);
 *   - an empty name slot returns `bytes32(0)` (no revert) → ParentNotFoundError;
 *   - `resolveParentAnchor` splits the final segment off as the file name.
 */

import type { Address, Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  ParentNotFoundError,
  type ResolvePublicClient,
  type TagReadPublicClient,
  planExistingAncestorVisibilityTags,
  resolveOrPlanParents,
  resolveParentAnchor,
  resolvePathToAnchor,
  splitPath,
} from '../src/reads/resolve.js'

const uid = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex
const ZERO_UID = uid(0)
const INDEXER: Address = '0x00000000000000000000000000000000000Index'
const ROOT = uid(0x1)

/**
 * A stub public client whose `resolvePath` reads from a flat `parent|name → uid`
 * map; an unmapped slot returns ZERO_UID (the kernel's empty-slot behavior).
 * Records every `resolvePath` call for ordering assertions.
 */
function makeResolver(
  edges: Record<string, Hex>,
  root: Hex = ROOT,
): { client: ResolvePublicClient; calls: { parent: Hex; name: string }[] } {
  const calls: { parent: Hex; name: string }[] = []
  const client: ResolvePublicClient = {
    async readContract(args) {
      if (args.functionName === 'rootAnchorUID') return root
      if (args.functionName === 'resolvePath') {
        const [parent, name] = args.args as [Hex, string]
        calls.push({ parent, name })
        return edges[`${parent}|${name}`] ?? ZERO_UID
      }
      throw new Error(`unexpected functionName ${args.functionName}`)
    },
  }
  return { client, calls }
}

describe('splitPath', () => {
  it('drops empty/leading/trailing/repeat slashes', () => {
    expect(splitPath('/docs//api/')).toEqual(['docs', 'api'])
    expect(splitPath('')).toEqual([])
    expect(splitPath('/')).toEqual([])
    expect(splitPath('readme.md')).toEqual(['readme.md'])
  })
})

describe('resolvePathToAnchor', () => {
  it('resolves the root path to the root anchor (no resolvePath calls)', async () => {
    const { client, calls } = makeResolver({})
    const anchor = await resolvePathToAnchor(client, INDEXER, '/')
    expect(anchor).toBe(ROOT)
    expect(calls).toHaveLength(0)
  })

  it('walks each segment from root in order', async () => {
    const docs = uid(0x10)
    const api = uid(0x11)
    const { client, calls } = makeResolver({
      [`${ROOT}|docs`]: docs,
      [`${docs}|api`]: api,
    })
    const anchor = await resolvePathToAnchor(client, INDEXER, '/docs/api')
    expect(anchor).toBe(api)
    // Each segment fed the next as the parent.
    expect(calls).toEqual([
      { parent: ROOT, name: 'docs' },
      { parent: docs, name: 'api' },
    ])
  })

  it('throws ParentNotFoundError naming the first missing segment', async () => {
    const docs = uid(0x10)
    const { client } = makeResolver({ [`${ROOT}|docs`]: docs }) // 'api' missing under docs
    const err = await resolvePathToAnchor(client, INDEXER, '/docs/api/sub').catch((e) => e)
    expect(err).toBeInstanceOf(ParentNotFoundError)
    const pe = err as ParentNotFoundError
    expect(pe.code).toBe('ParentNotFound')
    expect(pe.missingSegment).toBe('api')
    expect(pe.resolvedSegments).toEqual(['docs'])
    expect(pe.path).toBe('/docs/api/sub')
  })
})

describe('resolveParentAnchor', () => {
  it('splits the file name off and resolves the parent folder', async () => {
    const docs = uid(0x10)
    const { client, calls } = makeResolver({ [`${ROOT}|docs`]: docs })
    const { parentAnchorUID, fileName } = await resolveParentAnchor(
      client,
      INDEXER,
      '/docs/readme.md',
    )
    expect(parentAnchorUID).toBe(docs)
    expect(fileName).toBe('readme.md')
    // Only the folder segment is resolved — the file name is NOT looked up.
    expect(calls).toEqual([{ parent: ROOT, name: 'docs' }])
  })

  it('resolves the root parent for a file directly under root', async () => {
    const { client, calls } = makeResolver({})
    const { parentAnchorUID, fileName } = await resolveParentAnchor(client, INDEXER, '/readme.md')
    expect(parentAnchorUID).toBe(ROOT)
    expect(fileName).toBe('readme.md')
    expect(calls).toHaveLength(0)
  })

  it('throws InvalidArgument when there is no file-name segment', async () => {
    const { client } = makeResolver({})
    await expect(resolveParentAnchor(client, INDEXER, '/')).rejects.toThrow(/no file-name segment/)
  })

  it('propagates ParentNotFoundError when an intermediate folder is missing', async () => {
    const { client } = makeResolver({}) // nothing under root
    const err = await resolveParentAnchor(client, INDEXER, '/missing/readme.md').catch((e) => e)
    expect(err).toBeInstanceOf(ParentNotFoundError)
    expect((err as ParentNotFoundError).missingSegment).toBe('missing')
  })
})

describe('resolveOrPlanParents (mkdir -p planning)', () => {
  it('returns the resolved parent anchor when every ancestor exists (no gap)', async () => {
    const photos = uid(0x20)
    const y2026 = uid(0x21)
    const { client } = makeResolver({
      [`${ROOT}|photos`]: photos,
      [`${photos}|2026`]: y2026,
    })
    const plan = await resolveOrPlanParents(client, INDEXER, '/photos/2026/trip.jpg')
    expect(plan.fileName).toBe('trip.jpg')
    expect(plan.missingSegments).toEqual([])
    expect('parentAnchorUID' in plan && plan.parentAnchorUID).toBe(y2026)
  })

  it('reports the deepest existing anchor + the full missing suffix (none exist)', async () => {
    const { client } = makeResolver({}) // nothing under root
    const plan = await resolveOrPlanParents(client, INDEXER, '/photos/2026/trip.jpg')
    expect(plan.fileName).toBe('trip.jpg')
    expect(plan.missingSegments).toEqual(['photos', '2026'])
    // Deepest existing = root (the first parent segment is already missing).
    expect('deepestExistingAnchorUID' in plan && plan.deepestExistingAnchorUID).toBe(ROOT)
  })

  it('reports only the leaf folder when the shallower ancestor already exists', async () => {
    const photos = uid(0x20)
    const { client } = makeResolver({ [`${ROOT}|photos`]: photos }) // 2026 missing
    const plan = await resolveOrPlanParents(client, INDEXER, '/photos/2026/trip.jpg')
    expect(plan.missingSegments).toEqual(['2026'])
    expect('deepestExistingAnchorUID' in plan && plan.deepestExistingAnchorUID).toBe(photos)
  })

  it('a file directly under root has no parents to plan', async () => {
    const { client } = makeResolver({})
    const plan = await resolveOrPlanParents(client, INDEXER, '/readme.md')
    expect(plan.missingSegments).toEqual([])
    expect('parentAnchorUID' in plan && plan.parentAnchorUID).toBe(ROOT)
  })

  it('throws InvalidArgument when there is no file-name segment', async () => {
    const { client } = makeResolver({})
    await expect(resolveOrPlanParents(client, INDEXER, '/')).rejects.toThrow(/no file-name segment/)
  })

  it('captures the existing-ancestor anchor chain (shallowest-first, root excluded)', async () => {
    const photos = uid(0x20)
    const y2026 = uid(0x21)
    const { client } = makeResolver({
      [`${ROOT}|photos`]: photos,
      [`${photos}|2026`]: y2026,
    })
    const plan = await resolveOrPlanParents(client, INDEXER, '/photos/2026/trip.jpg')
    // Both parent anchors are captured; ROOT is NOT in the list.
    expect(plan.existingAncestorUIDs).toEqual([photos, y2026])
    expect(plan.existingAncestorUIDs).not.toContain(ROOT)
  })

  it('captures only the existing prefix when a suffix is missing', async () => {
    const photos = uid(0x20)
    const { client } = makeResolver({ [`${ROOT}|photos`]: photos }) // 2026 missing
    const plan = await resolveOrPlanParents(client, INDEXER, '/photos/2026/trip.jpg')
    // Only /photos resolved before the gap; the created /2026 is NOT here.
    expect(plan.existingAncestorUIDs).toEqual([photos])
  })

  it('a file directly under root has no existing ancestors', async () => {
    const { client } = makeResolver({})
    const plan = await resolveOrPlanParents(client, INDEXER, '/readme.md')
    expect(plan.existingAncestorUIDs).toEqual([])
  })
})

describe('planExistingAncestorVisibilityTags (ancestor walk + short-circuit)', () => {
  const EDGE = '0x00000000000000000000000000000000000000Ed' as Address
  const ATTESTER = '0x000000000000000000000000000000000000A77e' as Address
  const DATA_SCHEMA = uid(0xda7a)
  const ANCHOR_SCHEMA = uid(0xa9c0)

  /**
   * Stub the `getActiveTagWeight` read off a set of already-tagged anchor UIDs.
   * Records every queried target so we can assert the short-circuit stops early.
   */
  function makeTagReader(tagged: readonly Hex[]): {
    client: TagReadPublicClient
    queried: Hex[]
  } {
    const set = new Set<string>(tagged)
    const queried: Hex[] = []
    const client: TagReadPublicClient = {
      async readContract(args) {
        const [attester, target, definition, targetSchema] = args.args as [Address, Hex, Hex, Hex]
        expect(attester).toBe(ATTESTER)
        expect(definition).toBe(DATA_SCHEMA)
        expect(targetSchema).toBe(ANCHOR_SCHEMA)
        queried.push(target)
        return [set.has(target), set.has(target) ? 1n : 0n]
      },
    }
    return { client, queried }
  }

  const A = uid(0xa1)
  const B = uid(0xb2)
  const C = uid(0xc3)
  const input = {
    edgeResolver: EDGE,
    attester: ATTESTER,
    dataSchemaUID: DATA_SCHEMA,
    anchorSchemaUID: ANCHOR_SCHEMA,
  }

  it('returns [] for an empty ancestor list (no reads)', async () => {
    const { client, queried } = makeTagReader([])
    const out = await planExistingAncestorVisibilityTags(client, [], input)
    expect(out).toEqual([])
    expect(queried).toHaveLength(0)
  })

  it('none tagged: emits a TAG for every ancestor', async () => {
    const { client } = makeTagReader([])
    // Input is shallowest-first [A, B, C]; output is the untagged set (order-agnostic).
    const out = await planExistingAncestorVisibilityTags(client, [A, B, C], input)
    expect(out.sort()).toEqual([A, B, C].sort())
  })

  it('immediate parent (deepest) already tagged: short-circuits to zero TAGs', async () => {
    const { client } = makeTagReader([C]) // C = the deepest existing parent
    const out = await planExistingAncestorVisibilityTags(client, [A, B, C], input)
    expect(out).toEqual([])
  })

  it('immediate parent untagged but its parent IS tagged: exactly one TAG (the untagged parent)', async () => {
    const { client } = makeTagReader([B]) // B tagged, C not
    const out = await planExistingAncestorVisibilityTags(client, [A, B, C], input)
    // Bottom-up: C untagged → tag it; B tagged → stop (A above is left alone).
    expect(out).toEqual([C])
  })
})

// ── Canonical segment encoding at the resolution choke point (specs/02) ─────────

describe('canonical segment encoding (specs/02)', () => {
  it('resolvePathToAnchor issues CANONICAL segment args for reserved-byte names', async () => {
    const qa = uid(0x20)
    const file = uid(0x21)
    const { client, calls } = makeResolver({
      [`${ROOT}|Q%26A%3A%20Episode%205`]: qa,
      [`${qa}|file.txt`]: file,
    })
    const anchor = await resolvePathToAnchor(client, INDEXER, '/Q&A: Episode 5/file.txt')
    expect(anchor).toBe(file)
    expect(calls.map((c) => c.name)).toEqual(['Q%26A%3A%20Episode%205', 'file.txt'])
  })

  it('composed and decomposed é resolve the SAME slot (NFC before lookup)', async () => {
    const cafe = uid(0x22)
    const { client } = makeResolver({ [`${ROOT}|café`]: cafe })
    expect(await resolvePathToAnchor(client, INDEXER, '/café')).toBe(cafe) // composed
    expect(await resolvePathToAnchor(client, INDEXER, '/café')).toBe(cafe) // decomposed
  })

  it('ParentNotFoundError carries the HUMAN segment, not the canonical form', async () => {
    const { client } = makeResolver({})
    const err = await resolvePathToAnchor(client, INDEXER, '/My Docs/x').catch((e) => e)
    expect(err).toBeInstanceOf(ParentNotFoundError)
    expect((err as ParentNotFoundError).missingSegment).toBe('My Docs')
  })

  it('resolveOrPlanParents returns CANONICAL fileName and missingSegments', async () => {
    const { client } = makeResolver({})
    const plan = await resolveOrPlanParents(client, INDEXER, '/My Docs/Ep 5.txt')
    expect(plan.fileName).toBe('Ep%205.txt')
    expect(plan.missingSegments).toEqual(['My%20Docs'])
  })

  it('an unencodable segment throws BEFORE any chain read (fail-fast)', async () => {
    const { client, calls } = makeResolver({})
    await expect(resolvePathToAnchor(client, INDEXER, '/docs/../etc')).rejects.toThrow(
      /not a valid anchor name/,
    )
    expect(calls).toHaveLength(0)
  })

  it('a pre-encoded path segment is treated as HUMAN and double-encodes (documented boundary)', async () => {
    // A caller holding the canonical form must decode it first (or use the codec
    // exports); passing it as a path resolves a DIFFERENT slot by design — no sniffing.
    const wrong = uid(0x23)
    const { client, calls } = makeResolver({ [`${ROOT}|Q%2526A`]: wrong })
    expect(await resolvePathToAnchor(client, INDEXER, '/Q%26A')).toBe(wrong)
    expect(calls[0]?.name).toBe('Q%2526A')
  })
})
