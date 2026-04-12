import { describe, expect, it } from 'vitest'

import { runProcess, sanitizeFileSegment } from './process'

describe('process util', () => {
  describe('runProcess', () => {
    it('runs a simple process and returns stdout', async () => {
      const result = await runProcess('node', ['-e', 'console.log("hello world")'])
      expect(result.stdout.trim()).toBe('hello world')
      expect(result.stderr).toBe('')
    })

    it('rejects on non-zero exit code', async () => {
      await expect(runProcess('node', ['-e', 'process.exit(1)'])).rejects.toThrow()
    })

    it('handles stderr correctly', async () => {
      await expect(runProcess('node', ['-e', 'console.error("some error"); process.exit(1)'])).rejects.toThrow('some error')
    })

    it('times out if takes too long', async () => {
      await expect(runProcess('node', ['-e', 'setTimeout(() => {}, 1000)'], { timeoutMs: 50 })).rejects.toThrow('process timeout after 50ms')
    })

    it('can write to stdin', async () => {
      const result = await runProcess('node', [
        '-e',
        'process.stdin.on("data", chunk => console.log(chunk.toString().trim().toUpperCase()))',
      ], { stdin: 'input data' })
      expect(result.stdout.trim()).toBe('INPUT DATA')
    })
  })

  describe('sanitizeFileSegment', () => {
    it('sanitizes strings replacing non-alphanumeric chars with dashes', () => {
      expect(sanitizeFileSegment('Hello World!', 'fallback')).toBe('hello-world')
      expect(sanitizeFileSegment('Test@123_456', 'fallback')).toBe('test-123_456') // . _ - are allowed
      expect(sanitizeFileSegment('---hello---', 'fallback')).toBe('hello')
    })

    it('uses fallback if result is empty or input is undefined', () => {
      expect(sanitizeFileSegment('', 'fallback')).toBe('fallback')
      expect(sanitizeFileSegment(undefined, 'fallback')).toBe('fallback')
      expect(sanitizeFileSegment('@@@', 'fallback')).toBe('fallback')
    })
  })
})
