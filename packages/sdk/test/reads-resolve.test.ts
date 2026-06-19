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
