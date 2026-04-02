import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { describe, expect, it } from 'vitest'

import { globalRegistry, initializeGlobalRegistry } from './index'
import { createDescriptorAwareServer } from './register-helper'

type ToolHandler = (input: Record<string, unknown>) => Promise<CallToolResult>

function createMockServer() {
  const handlers = new Map<string, ToolHandler>()
  const descriptions = new Map<string, string>()

  return {
    server: {
      tool(name: string, description: string, _schema: unknown, handler: ToolHandler) {
        handlers.set(name, handler)
        descriptions.set(name, description)
      },
    } as McpServer,
    getDescription(name: string) {
      return descriptions.get(name)
    },
  }
}

describe('createDescriptorAwareServer', () => {
  it('should inject the descriptor summary for 3-arg registrations', () => {
    initializeGlobalRegistry()
    const mock = createMockServer()
    const server = createDescriptorAwareServer(mock.server)

    server.tool(
      'coding_read_file',
      {},
      async () => ({ content: [] }),
    )

    expect(mock.getDescription('coding_read_file')).toBe(globalRegistry.get('coding_read_file').summary)
  })

  it('should override handwritten descriptions with the descriptor summary', () => {
    initializeGlobalRegistry()
    const mock = createMockServer()
    const server = createDescriptorAwareServer(mock.server)

    server.tool(
      'coding_read_file',
      'this should not become the source of truth',
      {},
      async () => ({ content: [] }),
    )

    expect(mock.getDescription('coding_read_file')).toBe(globalRegistry.get('coding_read_file').summary)
  })

  it('should fail closed for unknown tool registrations', () => {
    initializeGlobalRegistry()
    const mock = createMockServer()
    const server = createDescriptorAwareServer(mock.server)

    expect(() => server.tool(
      'nonexistent_tool',
      {},
      async () => ({ content: [] }),
    )).toThrow(/Unknown tool/)
  })
})
