/**
 * Folder Overviews — `efs.fs.overview(container, opts?)` (ADR-0011).
 *
 * ## The model (no new schema / contract / reserved key)
 *
 * A folder Overview is an ORDINARY file: a `README.md` anchor placed in the folder
 * (the well-known {@link OVERVIEW_NAME}) and tagged `system` so it never shows as a
 * visible untagged sibling. There is no Overview schema, no reserved on-chain key —
 * `README.md` + the existing `/tags/system` folder-visibility TAG are the *entire*
 * convention, so tooling agrees to treat that one file specially. (Because `system`
 * is one of {@link SAFETY_EXCLUDES}, a list filtered with that policy already hides
 * the Overview from its own folder listing — see `reads/list.ts`.)
 *
 * ## Resolution — by EXACT path, never a directory scan
 *
 * `overview` resolves `[...container, 'README.md']` by exact path (the same lens-
 * scoped placement resolution `read`/`locate` use) — it does NOT enumerate the
 * folder. Absence is the common case and is carried cleanly by the discriminated
 * {@link OverviewResult} (`kind: 'none'`), not a throw.
 *
 * ## The discriminated result (markdown-only display contract)
 *
 *   - `none`      — no `README.md` placed under the lens (the common case).
 *   - `markdown`  — a displayable text Overview: the decoded UTF-8 `text`, with
 *     `source` distinguishing on-chain (`web3://`, editable via `setOverview`) from a
 *     mirror-hosted body. Chosen when the `contentType` is markdown/text or absent
 *     (a bare `README.md` with no contentType is treated as markdown by convention).
 *   - `binary`    — a `README.md` whose `contentType` is NOT text/markdown (a tooling
 *     mistake, but surfaced honestly rather than mis-rendered): the raw `bytes`.
 *   - `too-large` — the attested `size` exceeds {@link MAX_RENDER_BYTES}; the bytes
 *     are NOT fetched (the guard is the point — an Overview is meant to be small).
 *
 * `size` is read as the reserved-key PROPERTY on the DATA (lens-scoped to the winning
 * attester); when absent we proceed (a missing size claim is not "too large").
 */

import type { Address, Hex } from 'viem'
import { fileViewAbi } from '../chain/abi/fileView.js'
import { MAX_RENDER_BYTES, OVERVIEW_NAME } from '../types.js'
import type { FetchOptions, OverviewOptions, OverviewResult } from '../types.js'
import { type ReadContext, read } from './context.js'
import { fetchRef } from './fetch.js'
import { readReservedProperty, resolvePlacement } from './file.js'

/** Join a container path with the well-known Overview file name. Tolerant of a
 * trailing slash and the root container (`/` or `''`). */
function overviewPath(container: string): string {
  const trimmed = container.replace(/\/+$/, '')
  return `${trimmed}/${OVERVIEW_NAME}`
}

/** Whether a `contentType` denotes displayable markdown/text. A bare README with NO
 * contentType is treated as markdown by convention (the common `setOverview` case
 * tags it `text/markdown`, but a hand-written one may omit it). */
function isMarkdownContentType(contentType: string | undefined): boolean {
  if (contentType === undefined || contentType === '') return true
  const ct = contentType.toLowerCase()
  return ct.startsWith('text/markdown') || ct.startsWith('text/') || ct === 'text/x-markdown'
}

/** One row of `getDataMirrors` (lens-scoped). We only need the URI here. */
type MirrorRow = { uri: string }

/** Decide the Overview `source` from the winning lens's active mirrors: a `web3://`
 * mirror is on-chain (SSTORE2, editable via `setOverview`); anything else is mirror-
 * hosted. Reads at most one small window — an Overview has few mirrors. Defaults to
 * `'mirror'` when no mirror is found (a degenerate placement). */
async function overviewSource(
  ctx: ReadContext,
  dataUID: Hex,
  resolvedBy: Address,
): Promise<'onchain' | 'mirror'> {
  const rows = await read<readonly MirrorRow[]>(ctx.publicClient, {
    address: ctx.deployment.contracts.fileView,
    abi: fileViewAbi,
    functionName: 'getDataMirrors',
    args: [dataUID, resolvedBy, 0n, 50n],
  })
  return rows.some((m) => /^web3:/i.test(m.uri)) ? 'onchain' : 'mirror'
}

/** Parse the `size` reserved PROPERTY (decimal byte count) → bigint, tolerant of a
 * malformed/absent value (→ undefined). */
function parseSize(s: string | undefined): bigint | undefined {
  if (s === undefined || !/^\d+$/.test(s)) return undefined
  try {
    return BigInt(s)
  } catch {
    return undefined
  }
}

/**
 * `efs.fs.overview(container, opts?)` — read the folder Overview (`README.md`) at
 * `container`, resolved by EXACT path under the lens. Returns a discriminated
 * {@link OverviewResult}; `kind: 'none'` when absent (never a throw).
 */
export async function overview(
  ctx: ReadContext,
  container: string,
  opts?: OverviewOptions,
): Promise<OverviewResult> {
  const path = overviewPath(container)

  // Resolve the README.md placement by exact path under the lens. Absent ⇒ none.
  const placement = await resolvePlacement(ctx, path, opts)
  if (!placement) return { kind: 'none' }
  const { dataUID, resolvedBy } = placement

  // Read the attested size + contentType (lens-scoped to the winning attester), in
  // one tick (multicall-coalesced). Size gates the too-large guard; contentType
  // picks markdown vs binary.
  const [sizeProp, contentTypeProp] = await Promise.all([
    readReservedProperty(ctx, dataUID, resolvedBy, 'size'),
    readReservedProperty(ctx, dataUID, resolvedBy, 'contentType'),
  ])
  const size = parseSize(sizeProp.value)
  const contentType = contentTypeProp.value

  // Too-large guard: bail BEFORE fetching bytes (the whole point is not to buffer a
  // huge payload as a folder header).
  if (size !== undefined && size > BigInt(MAX_RENDER_BYTES)) {
    return { kind: 'too-large', size }
  }

  // Determine the source (on-chain vs mirror) and fetch the bytes. The fetch is
  // verified by default (the value path is never trust-blind), mirroring `read`.
  const source = await overviewSource(ctx, dataUID, resolvedBy)
  const file = await fetchRef(
    ctx,
    { __brand: 'DataRef', uid: dataUID as never, chainId: ctx.deployment.chainId, resolvedBy },
    opts as FetchOptions | undefined,
  )

  if (isMarkdownContentType(contentType)) {
    return { kind: 'markdown', text: file.text(), source }
  }
  return {
    kind: 'binary',
    bytes: file.bytes,
    ...(contentType !== undefined ? { contentType } : {}),
    source,
  }
}
