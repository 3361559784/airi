/**
 * Registration Helper
 *
 * Utilities for descriptor-driven tool registration.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ZodRawShape, ZodTypeAny } from 'zod'

import type { ToolDescriptor } from './types'

import { globalRegistry } from './registry'

type ToolRegistrationFn = (
  canonicalName: string,
  description: string,
  schema: unknown,
  handler: DescriptorAwareHandler,
) => unknown

/**
 * Options for descriptor-driven tool registration.
 */
export interface DescriptorToolOptions<TSchema extends ZodRawShape> {
  /**
   * The tool descriptor (from registry or inline).
   */
  descriptor: ToolDescriptor

  /**
   * Zod schema for input validation.
   */
  schema: TSchema

  /**
   * Tool handler function.
   */
  handler: (input: { [K in keyof TSchema]: TSchema[K] extends ZodTypeAny ? TSchema[K]['_output'] : never }, extra: unknown) => Promise<CallToolResult>
}

/**
 * Register a tool using its descriptor.
 * The description is automatically taken from the descriptor's summary.
 */
export function registerToolWithDescriptor<TSchema extends ZodRawShape>(
  server: McpServer,
  options: DescriptorToolOptions<TSchema>,
): void {
  const { descriptor, schema, handler } = options

  // Validate descriptor is in registry (fail-closed)
  if (!globalRegistry.has(descriptor.canonicalName)) {
    throw new Error(
      `Tool "${descriptor.canonicalName}" is not registered in the global descriptor registry. `
      + 'All tools must have descriptors registered before use.',
    )
  }

  // Register with MCP server
  // The description comes from the descriptor's summary
  // Note: Need to cast to any due to complex MCP SDK types
  const register = server.tool as unknown as ToolRegistrationFn

  register(
    descriptor.canonicalName,
    descriptor.summary,
    schema,
    handler as DescriptorAwareHandler,
  )
}

type DescriptorAwareHandler = (...args: unknown[]) => unknown

function normalizeRegistrationArgs(args: unknown[]): {
  schema: unknown
  handler: DescriptorAwareHandler
} {
  if (args.length === 2) {
    return {
      schema: args[0],
      handler: args[1] as DescriptorAwareHandler,
    }
  }

  if (args.length === 3 && typeof args[0] === 'string') {
    return {
      schema: args[1],
      handler: args[2] as DescriptorAwareHandler,
    }
  }

  throw new Error(`Unsupported tool registration signature. Expected (name, schema, handler) or (name, description, schema, handler); received ${args.length + 1} arguments.`)
}

/**
 * Create a descriptor-aware tool registrar.
 *
 * This lets existing register-* modules keep their current `server.tool(...)`
 * shape while forcing every registration through the descriptor registry.
 */
export function createDescriptorAwareToolRegistrar(server: McpServer) {
  return (canonicalName: string, ...args: unknown[]) => {
    const descriptor = requireDescriptor(canonicalName)
    const { schema, handler } = normalizeRegistrationArgs(args)

    const register = server.tool as unknown as ToolRegistrationFn

    register(
      descriptor.canonicalName,
      descriptor.summary,
      schema,
      handler,
    )
  }
}

/**
 * Create a lightweight registration-only server facade whose `tool(...)`
 * method always resolves tool metadata from the descriptor registry.
 *
 * NOTICE: This facade is only intended for the registration phase. It is not a
 * general-purpose McpServer replacement and should not be used for connect/run.
 */
export function createDescriptorAwareServer(server: McpServer): McpServer {
  return Object.assign(Object.create(server), {
    tool: createDescriptorAwareToolRegistrar(server),
  }) as McpServer
}

/**
 * Get descriptor for a tool name, throwing if not found.
 */
export function requireDescriptor(canonicalName: string): ToolDescriptor {
  return globalRegistry.get(canonicalName)
}

/**
 * Get descriptor summary for use in tool registration.
 */
export function getToolSummary(canonicalName: string): string {
  return globalRegistry.get(canonicalName).summary
}

/**
 * Check if a tool is read-only according to its descriptor.
 */
export function isToolReadOnly(canonicalName: string): boolean {
  return globalRegistry.get(canonicalName).readOnly
}

/**
 * Check if a tool requires approval by default according to its descriptor.
 */
export function toolRequiresApprovalByDefault(canonicalName: string): boolean {
  return globalRegistry.get(canonicalName).requiresApprovalByDefault
}

/**
 * Check if a tool is concurrency-safe according to its descriptor.
 */
export function isToolConcurrencySafe(canonicalName: string): boolean {
  return globalRegistry.get(canonicalName).concurrencySafe
}

/**
 * Get the lane for a tool.
 */
export function getToolLane(canonicalName: string): string {
  return globalRegistry.get(canonicalName).lane
}

/**
 * Get the kind for a tool.
 */
export function getToolKind(canonicalName: string): string {
  return globalRegistry.get(canonicalName).kind
}

/**
 * Validate that all tool names have registered descriptors.
 * Useful for testing registry completeness.
 */
export function validateToolsHaveDescriptors(toolNames: string[]): {
  valid: boolean
  missing: string[]
  orphans: string[]
} {
  const missing = globalRegistry.validateCompleteness(toolNames)
  const orphans = globalRegistry.findOrphans(toolNames)

  return {
    valid: missing.length === 0,
    missing,
    orphans,
  }
}
