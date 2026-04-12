import { beforeEach, describe, expect, it, vi } from 'vitest'

import { maskClipboardPreview, readClipboardText, writeClipboardText } from './clipboard'

import * as processUtil from './process'

vi.mock('./process', () => ({
  runProcess: vi.fn(),
}))

describe('clipboard util', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('platform', 'darwin')
    // platform in node:process is readonly, so we mock requireMacOSClipboard logic
    // by only testing on macOS or mocking process.platform if possible.
    // Instead we can use Object.defineProperty
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
    })
  })

  describe('maskClipboardPreview', () => {
    it('returns empty string for empty input', () => {
      expect(maskClipboardPreview('   ')).toBe('')
    })

    it('masks short strings', () => {
      expect(maskClipboardPreview('hello')).toBe('h***o')
      expect(maskClipboardPreview('a')).toBe('aa')
      expect(maskClipboardPreview('12')).toBe('12')
      expect(maskClipboardPreview('12345678')).toBe('1******8')
    })

    it('masks long strings', () => {
      expect(maskClipboardPreview('123456789')).toBe('1234*6789')
      expect(maskClipboardPreview('12345678901234567890')).toBe('1234************7890') // max 12 asterisks
      expect(maskClipboardPreview('abcdefghijklmnopqrstuvwxyz')).toBe('abcd************wxyz')
    })
  })

  describe('readClipboardText', () => {
    it('reads and trims text by default', async () => {
      vi.mocked(processUtil.runProcess).mockResolvedValue({ stdout: '  some text  \n', stderr: '' })

      const result = await readClipboardText(
        { binaries: { pbpaste: 'pbpaste' }, timeoutMs: 1000 } as any,
        {},
      )

      expect(result.text).toBe('some text')
      expect(result.originalLength).toBe(9)
      expect(result.returnedLength).toBe(9)
      expect(result.trimmed).toBe(true)
      expect(result.truncated).toBe(false)
    })

    it('can skip trimming and truncate', async () => {
      vi.mocked(processUtil.runProcess).mockResolvedValue({ stdout: '  some text  \n', stderr: '' })

      const result = await readClipboardText(
        { binaries: { pbpaste: 'pbpaste' }, timeoutMs: 1000 } as any,
        { trim: false, maxLength: 5 },
      )

      expect(result.text).toBe('  som')
      expect(result.originalLength).toBe(14)
      expect(result.returnedLength).toBe(5)
      expect(result.trimmed).toBe(false)
      expect(result.truncated).toBe(true)
    })
  })

  describe('writeClipboardText', () => {
    it('writes text to clipboard', async () => {
      vi.mocked(processUtil.runProcess).mockResolvedValue({ stdout: '', stderr: '' })

      const result = await writeClipboardText(
        { binaries: { pbcopy: 'pbcopy' }, timeoutMs: 1000 } as any,
        'hello world',
      )

      expect(result.textLength).toBe(11)
      expect(processUtil.runProcess).toHaveBeenCalledTimes(1)
      const [, , options] = vi.mocked(processUtil.runProcess).mock.calls[0]!
      expect(options!.stdin).toBe('hello world')
    })
  })
})
