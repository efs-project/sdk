/**
 * `efs.fs.setOverview(container, markdown, opts?)` — author / replace a folder
 * Overview (ADR-0011).
 *
 * An Overview is an ORDINARY `README.md` file in the folder, tagged `system` so it
 * never shows as a visible sibling. `setOverview` therefore composes the NORMAL file
 * write pipeline ({@link writeFileTier1}) at `[...container, 'README.md']` with two
 * Overview-specific touches:
 *
 *   1. **`contentType = 'text/markdown'`** — so `fs.overview` classifies it as the
 *      `markdown` variant (and any generic reader renders it as markdown).
 *   2. **the `system` TAG is applied BEFORE placement** — resolved here from the
 *      `/tags/system` anchor UID and threaded into the write graph
 *      (`overviewSystemTagDef`), which emits `TAG(definition = /tags/system, refUID =
 *      file-ANCHOR, weight = 1)` in the layer STRICTLY BEFORE the placement PIN. The
 *      README is hidden the instant it becomes visible — it never flashes as an
 *      untagged sibling (ADR-0011 §4). Because that def is the SAME one the directory
 *      filter excludes on, a `SAFETY_EXCLUDES` listing already hides the Overview from
 *      its own folder.
 *
 * Re-running `setOverview` supersedes the prior README's placement PIN in O(1) (the
 * placement is cardinality-1 per `(attester, file-anchor)`), so it edits in place.
 *
 * Folder-scoped + authored on the connected wallet's lens (the Tier-1 attester),
 * mirroring `fs.write`. `markdown` is encoded UTF-8.
 */

import type { Hex } from 'viem'
import { EfsError } from '../errors.js'
import { OVERVIEW_NAME } from '../types.js'
import type { WriteOptions, WriteReceipt } from '../types.js'
import { type FileWriteContext, writeFileTier1 } from './file.js'

/** `bytes32(0)` — the indexer's "no such anchor" sentinel. */
const ZERO_UID = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

/** The `/tags/system` definition path — the folder-Overview marker TAG (ADR-0011).
 * The same `/tags/<name>` convention `efs.graph.tags` and the directory filter use. */
const SYSTEM_TAG_PATH = '/tags/system' as const

/** Join a container path with the well-known Overview file name (`README.md`),
 * tolerant of a trailing slash and the root container. */
function overviewPath(container: string): string {
  const trimmed = container.replace(/\/+$/, '')
  return `${trimmed}/${OVERVIEW_NAME}`
}

/** The minimal client surface this orchestrator needs to resolve the `/tags/system`
 * definition UID (an indexer `resolvePath`-shaped read). */
export interface OverviewWriteContext extends FileWriteContext {
  /** Resolve a path string to its anchor UID via the indexer (the SAME walk
   * `resolvePathToAnchor` / `efs.graph.tags` use). Injected so this module reuses the
   * read engine's resolver without importing the whole read context. */
  readonly resolveAnchorPath: (path: string) => Promise<Hex>
}

/**
 * Execute `setOverview`: resolve `/tags/system`, then run the normal file write at
 * `[...container, 'README.md']` with the Overview marker.
 *
 * @throws {EfsError} `InvalidArgument` when `/tags/system` resolves to no anchor (the
 *   deployment is missing the canonical `system` tag-definition — without it the
 *   marker TAG cannot be authored, and silently writing an untagged README would
 *   expose it as a visible sibling, the exact footgun this verb avoids).
 */
export async function setOverview(
  container: string,
  markdown: string,
  ctx: OverviewWriteContext,
  opts?: WriteOptions,
): Promise<WriteReceipt> {
  const overviewSystemTagDef = await ctx.resolveAnchorPath(SYSTEM_TAG_PATH)
  if (overviewSystemTagDef === ZERO_UID) {
    throw new EfsError(
      `efs.fs.setOverview: the deployment has no '${SYSTEM_TAG_PATH}' tag definition, so the Overview marker TAG cannot be authored. Writing an untagged README would expose it as a visible folder sibling — refusing rather than doing that. (The deploy seeds /tags/system; use a deployment that has it.)`,
      { code: 'InvalidArgument' },
    )
  }
  const bytes = new TextEncoder().encode(markdown)
  const writeCtx: FileWriteContext = {
    ...ctx,
    overviewSystemTagDef,
  }
  // contentType is forced to markdown (an explicit `opts.contentType` is ignored —
  // an Overview is markdown by contract). createParents stays default-true so
  // setOverview on a not-yet-created folder just works.
  return writeFileTier1(overviewPath(container), bytes, writeCtx, {
    ...opts,
    contentType: 'text/markdown',
  })
}

/** Re-export the resolved zero sentinel check is unnecessary — `resolveAnchorPath`
 * returns the zero UID for a missing anchor; the caller (`index.ts`) wraps the throw.
 * Exposed for tests that assert on the path mapping. */
export { overviewPath, SYSTEM_TAG_PATH }
