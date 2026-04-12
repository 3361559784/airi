import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runSwiftScript } from './swift'

import * as processUtil from './process'

vi.mock('./process', () => ({
  runProcess: vi.fn(),
}))

describe('swift util', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(processUtil.runProcess).mockResolvedValue({ stdout: 'success', stderr: '' })
  })

  it('writes source to temp file and runs swift binary', async () => {
    const result = await runSwiftScript({
      swiftBinary: '/usr/bin/swift',
      timeoutMs: 1000,
      source: 'print("hello swift")',
    })

    expect(result.stdout).toBe('success')
    expect(processUtil.runProcess).toHaveBeenCalledTimes(1)

    const [binary, args, options] = vi.mocked(processUtil.runProcess).mock.calls[0]!
    expect(binary).toBe('/usr/bin/swift')
    expect(args[0]).toMatch(/script\.swift$/)
    expect(options!.timeoutMs).toBe(1000)
    expect(options!.env?.COMPUTER_USE_SWIFT_STDIN).toBeUndefined()
  })

  it('passes stdinPayload via environment variable', async () => {
    const payload = { key: 'value' }
    await runSwiftScript({
      swiftBinary: '/usr/bin/swift',
      timeoutMs: 1000,
      source: 'print("hello swift")',
      stdinPayload: payload,
    })

    const [,, options] = vi.mocked(processUtil.runProcess).mock.calls[0]!
    expect(options!.env?.COMPUTER_USE_SWIFT_STDIN).toBe(JSON.stringify(payload))
  })
})
