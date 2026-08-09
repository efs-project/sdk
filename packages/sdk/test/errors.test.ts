import {
  ContractFunctionRevertedError,
  ProviderRpcError,
  UserRejectedRequestError,
  RpcError as ViemRpcError,
  toFunctionSelector,
} from 'viem'
import { describe, expect, it } from 'vitest'
import { easAbi } from '../src/eas/index.js'
import {
  ContractReverted,
  Disconnected,
  EfsError,
  RpcError,
  SchemaMismatchError,
  Unauthorized,
  UnsupportedMethod,
  UserRejected,
  WalletRequired,
  classifyError,
} from '../src/errors.js'

describe('classifyError (ADR-0007 classifier)', () => {
  it('is idempotent — an existing EfsError passes through unchanged', () => {
    const original = new WalletRequired()
    expect(classifyError(original)).toBe(original)

    const base = new EfsError('boom', { code: 'EfsError' })
    expect(classifyError(base)).toBe(base)
  })

  it('maps EIP-1193 4001 to a benign UserRejected (not a generic failure)', () => {
    const cause = new Error('User denied transaction signature')
    const viemErr = new UserRejectedRequestError(cause)
    const out = classifyError(viemErr)
    expect(out).toBeInstanceOf(UserRejected)
    expect(out.code).toBe('UserRejected')
    // The benign user-rejection is distinct from a generic 'EfsError'.
    expect(out.code).not.toBe('EfsError')
    expect(out.cause).toBe(viemErr)
  })

  it('maps EIP-1193 4100 to Unauthorized', () => {
    const err = new ProviderRpcError(new Error('x'), { code: 4100, shortMessage: 'unauthorized' })
    const out = classifyError(err)
    expect(out).toBeInstanceOf(Unauthorized)
    expect(out.code).toBe('Unauthorized')
    expect(out.cause).toBe(err)
  })

  it('maps EIP-1193 4200 to UnsupportedMethod', () => {
    const err = new ProviderRpcError(new Error('x'), { code: 4200, shortMessage: 'unsupported' })
    const out = classifyError(err)
    expect(out).toBeInstanceOf(UnsupportedMethod)
    expect(out.code).toBe('UnsupportedMethod')
  })

  it('maps EIP-1193 4900/4901 to Disconnected', () => {
    for (const code of [4900, 4901]) {
      const err = new ProviderRpcError(new Error('x'), { code, shortMessage: 'disconnected' })
      const out = classifyError(err)
      expect(out).toBeInstanceOf(Disconnected)
      expect(out.code).toBe('Disconnected')
      expect(out.cause).toBe(err)
    }
  })

  it('maps JSON-RPC -32xxx (EIP-1474) to RpcError with the shortMessage', () => {
    const err = new ViemRpcError(new Error('boom'), { code: -32000, shortMessage: 'rpc boom' })
    const out = classifyError(err)
    expect(out).toBeInstanceOf(RpcError)
    expect(out.code).toBe('RpcError')
    expect(out.shortMessage).toBe('rpc boom')
    expect(out.cause).toBe(err)
  })

  it('walks a viem BaseError to the ContractFunctionRevertedError and maps the revert', () => {
    const revert = new ContractFunctionRevertedError({
      abi: [{ type: 'error', name: 'SomeCustomError', inputs: [] }],
      functionName: 'attest',
      data: '0x',
    })
    const out = classifyError(revert)
    expect(out).toBeInstanceOf(ContractReverted)
    expect(out.code).toBe('ContractReverted')
    expect(out.cause).toBe(revert)
  })

  it('maps an InvalidSchema revert to SchemaMismatchError', () => {
    const revert = new ContractFunctionRevertedError({
      abi: [{ type: 'error', name: 'InvalidSchema', inputs: [] }],
      functionName: 'attest',
      data: '0x',
    })
    // Force the decoded error name viem would surface for a real on-chain decode.
    Object.defineProperty(revert, 'data', {
      value: { errorName: 'InvalidSchema', args: [] },
      configurable: true,
    })
    const out = classifyError(revert)
    expect(out).toBeInstanceOf(SchemaMismatchError)
    expect(out.code).toBe('SchemaMismatch')
    expect(out.cause).toBe(revert)
  })

  it('wraps an unrecognized plain Error in a generic EfsError, preserving cause', () => {
    const plain = new Error('something odd happened')
    const out = classifyError(plain)
    expect(out).toBeInstanceOf(EfsError)
    expect(out.code).toBe('EfsError')
    expect(out.shortMessage).toBe('something odd happened')
    expect(out.cause).toBe(plain)
  })

  it('decodes a real EAS revert via the bundled easAbi error fragments', () => {
    // The bundled easAbi must carry the EAS custom-error fragments, or viem
    // cannot populate errorName on a real attest/multiAttest revert.
    expect(easAbi.some((f) => f.type === 'error' && f.name === 'InvalidSchema')).toBe(true)
    const revert = new ContractFunctionRevertedError({
      abi: easAbi,
      functionName: 'attest',
      data: toFunctionSelector('InvalidSchema()'),
    })
    expect(revert.data?.errorName).toBe('InvalidSchema')
    expect(classifyError(revert).code).toBe('SchemaMismatch')
  })

  it('finds an EIP-1193 code on a nested cause (wrapped wallet rejection)', () => {
    // viem wraps a UserRejectedRequestError (4001) under a contract/tx error;
    // the code is on the cause, not the outer error.
    const inner = Object.assign(new Error('User rejected the request.'), { code: 4001 })
    const wrapped = Object.assign(new Error('execution failed'), { cause: inner })
    expect(classifyError(wrapped).code).toBe('UserRejected')
    // A nested JSON-RPC code resolves too.
    const rpcInner = Object.assign(new Error('rpc'), { code: -32000 })
    const rpcWrapped = Object.assign(new Error('outer'), { cause: rpcInner })
    expect(classifyError(rpcWrapped).code).toBe('RpcError')
  })

  it('never throws on exotic inputs and always returns an EfsError', () => {
    for (const input of [undefined, null, 42, 'a string', {}, Symbol('s')]) {
      const out = classifyError(input)
      expect(out).toBeInstanceOf(EfsError)
      expect(typeof out.code).toBe('string')
    }
  })

  it('preserves the cause chain so .walk() reaches the underlying revert', () => {
    const revert = new ContractFunctionRevertedError({
      abi: [{ type: 'error', name: 'SomeCustomError', inputs: [] }],
      functionName: 'attest',
      data: '0x',
    })
    const out = classifyError(revert)
    const found = out.walk((e) => e instanceof ContractFunctionRevertedError)
    expect(found).toBe(revert)
  })
})
