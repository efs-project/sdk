import { describe, expect, it } from 'vitest'
import { NotImplemented, createEfsClient, identity, lens, version } from '../src/index.js'

describe('@efs-project/sdk scaffold', () => {
  it('exposes a version', () => {
    expect(version).toBe('0.0.0')
  })

  it('stubs throw NotImplemented until the build lands', () => {
    expect(() => lens('0x0000000000000000000000000000000000000001')).toThrow(NotImplemented)
    expect(() => identity('jamescarnley.eth')).toThrow(NotImplemented)
    // @ts-expect-error scaffold: config shape not exercised yet
    expect(() => createEfsClient({})).toThrow(NotImplemented)
  })
})
