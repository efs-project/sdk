/**
 * `@efs/sdk/lenses` subpath entry — the lens primitives (ADR-0031/0039).
 * Thin barrel: re-exports the curated lens surface from `./resolve.js`.
 */

export {
  lens,
  identity,
  resolveLens,
  MAX_LENSES,
  type Lens,
  type LensContext,
} from './resolve.js'
