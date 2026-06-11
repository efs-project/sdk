/**
 * Typed error tree. External callers catch discriminated `EfsError` subclasses,
 * never raw RPC strings (mirrors viem's `BaseError` ergonomics). The error-model
 * ADR is pending (docs/adr "Recommended next").
 */

export class EfsError extends Error {
  override name = 'EfsError'
}

/** A surface that is shaped but not yet implemented (scaffold/seam). */
export class NotImplemented extends EfsError {
  override name = 'NotImplemented'
  constructor(what: string) {
    super(`${what} is not implemented yet.`)
  }
}

/** A read/write needs a lens but none was given and no wallet is connected. */
export class LensRequired extends EfsError {
  override name = 'LensRequired'
  constructor() {
    super('No lens given and no wallet connected — a read needs an attester to resolve against.')
  }
}

/** A lens stack exceeds MAX_LENSES. We throw rather than truncate: silent truncation
 * is a trust downgrade (it can push the trusted tail off the end). */
export class MaxLensesExceeded extends EfsError {
  override name = 'MaxLensesExceeded'
  constructor(count: number, max: number) {
    super(
      `Lens stack has ${count} entries; the maximum is ${max}. Reduce it explicitly — the SDK will not truncate (that would silently change which attester wins).`,
    )
  }
}

/** The SDK's compiled schema UIDs don't match what's deployed on the target chain.
 * Construct with a message describing the diff (`new SchemaMismatchError(...)`). */
export class SchemaMismatchError extends EfsError {
  override name = 'SchemaMismatchError'
}

/** No EFS deployment is known for the connected chain (and none was supplied). */
export class DeploymentNotFound extends EfsError {
  override name = 'DeploymentNotFound'
  constructor(chainId: number) {
    super(
      `No EFS deployment registered for chainId ${chainId}. Pass \`deployments\` to point at a custom/local deployment.`,
    )
  }
}
