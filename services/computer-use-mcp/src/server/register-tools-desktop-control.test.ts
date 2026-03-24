import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { ActionInvocation } from '../types'
import type { ComputerUseServerRuntime } from './runtime'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RunStateManager } from '../state'
import {
  createDisplayInfo,
  createLocalExecutionTarget,
  createPermissionInfo,
  createTerminalState,
  createTestConfig,
} from '../test-fixtures'
import { registerComputerUseTools } from './register-tools'

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>

function createMockServer() {
  const handlers = new Map<string, ToolHandler>()

  return {
    server: {
      tool(...args: unknown[]) {
        const name = args[0] as string
        const handler = args[args.length - 1] as ToolHandler
        handlers.set(name, handler)
      },
    } as unknown as McpServer,
    async invoke(name: string, args: Record<string, unknown> = {}) {
      const handler = handlers.get(name)
      if (!handler) {
        throw new Error(`Missing registered tool: ${name}`)
      }

      return await handler(args)
    },
  }
}

function makeExecutedResult(action: ActionInvocation): CallToolResult {
  return {
    content: [{ type: 'text', text: `${action.kind} ok` }],
    structuredContent: {
      status: 'executed',
      action: action.kind,
      backendResult: {},
    },
  }
}

async function sleep(ms: number) {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

function installPendingActionStore(runtime: ComputerUseServerRuntime) {
  const pendingActions = new Map<string, Record<string, unknown>>()
  const pendingApprovalTokens = new Map<string, string>()
  const session = runtime.session as unknown as {
    createPendingAction: ReturnType<typeof vi.fn>
    getPendingAction: ReturnType<typeof vi.fn>
    listPendingActions: ReturnType<typeof vi.fn>
    removePendingAction: ReturnType<typeof vi.fn>
    getPendingActionApprovalToken: ReturnType<typeof vi.fn>
    hasPendingActionApprovalToken: ReturnType<typeof vi.fn>
  }

  session.createPendingAction = vi.fn((record: Record<string, unknown>) => {
    const pendingId = `pending-${pendingActions.size + 1}`
    const pending = {
      id: pendingId,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...record,
    }
    pendingActions.set(pendingId, pending)
    pendingApprovalTokens.set(pendingId, `token-${pendingId}`)
    return pending
  })
  session.getPendingAction = vi.fn((id: string) => pendingActions.get(id))
  session.listPendingActions = vi.fn(() => [...pendingActions.values()])
  session.removePendingAction = vi.fn((id: string) => {
    pendingActions.delete(id)
    pendingApprovalTokens.delete(id)
  })
  session.getPendingActionApprovalToken = vi.fn((id: string) => pendingApprovalTokens.get(id))
  session.hasPendingActionApprovalToken = vi.fn((id: string, token: string | undefined) => pendingApprovalTokens.get(id) === token)

  return {
    pendingActions,
    pendingApprovalTokens,
  }
}

describe('registerComputerUseTools: desktop control tools', () => {
  let runtime: ComputerUseServerRuntime

  beforeEach(() => {
    runtime = {
      config: createTestConfig({ approvalMode: 'never' }),
      stateManager: new RunStateManager(),
      session: {
        createPendingAction: vi.fn(),
        getPendingAction: vi.fn(),
        listPendingActions: vi.fn(() => []),
        removePendingAction: vi.fn(),
        record: vi.fn().mockResolvedValue(undefined),
        recordSafeLoopRun: vi.fn().mockResolvedValue(undefined),
        getRecentSafeLoopRuns: vi.fn(() => []),
        getBudgetState: vi.fn(() => ({ operationsExecuted: 0, operationUnitsConsumed: 0 })),
        getLastScreenshot: vi.fn(() => undefined),
        getSnapshot: vi.fn(() => ({ operationsExecuted: 0, operationUnitsConsumed: 0, pendingActions: [] })),
        getPointerPosition: vi.fn(() => ({ x: 240, y: 160 })),
      },
      executor: {
        getExecutionTarget: vi.fn().mockResolvedValue(createLocalExecutionTarget()),
        getForegroundContext: vi.fn().mockResolvedValue({ available: true, platform: 'darwin' }),
        getDisplayInfo: vi.fn().mockResolvedValue(createDisplayInfo({
          platform: 'darwin',
          displayCount: 1,
          displays: [{
            displayId: 1,
            isMain: true,
            isBuiltIn: true,
            bounds: { x: 0, y: 0, width: 1280, height: 720 },
            visibleBounds: { x: 0, y: 0, width: 1280, height: 720 },
            scaleFactor: 2,
            pixelWidth: 2560,
            pixelHeight: 1440,
          }],
        })),
        getPermissionInfo: vi.fn().mockResolvedValue(createPermissionInfo()),
        observeWindows: vi.fn().mockResolvedValue({
          frontmostAppName: 'Cursor',
          frontmostWindowTitle: 'repo - cursor',
          observedAt: '2026-01-01T00:00:00.000Z',
          windows: [
            {
              id: 'w-cursor',
              appName: 'Cursor',
              title: 'repo - cursor',
              bounds: { x: 0, y: 0, width: 720, height: 720 },
              layer: 10,
            },
            {
              id: 'w-terminal',
              appName: 'Terminal',
              title: 'zsh',
              bounds: { x: 720, y: 0, width: 560, height: 720 },
              layer: 11,
            },
          ],
        }),
        describe: vi.fn(() => ({ kind: 'dry-run', notes: [] })),
      },
      terminalRunner: {
        getState: vi.fn(() => createTerminalState()),
        describe: vi.fn(() => ({ kind: 'local-shell-runner', notes: [] })),
      },
      browserDomBridge: {
        getStatus: vi.fn(() => ({
          enabled: false,
          connected: false,
          host: '127.0.0.1',
          port: 8765,
          pendingRequests: 0,
        })),
      },
      cdpBridgeManager: {
        probeAvailability: vi.fn().mockResolvedValue({
          endpoint: 'http://localhost:9222',
          connected: false,
          connectable: false,
        }),
      },
      taskMemory: {},
    } as unknown as ComputerUseServerRuntime
  })

  it('requires act lease before desktop_apply_layout', async () => {
    const executeAction = vi.fn(async (action: ActionInvocation) => makeExecutedResult(action))
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    const result = await invoke('desktop_apply_layout', { layoutId: 'coding-dual-pane' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      status: 'error',
      reason: 'act_lease_required_before_apply_layout',
    })
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('focuses a window when act lease is granted', async () => {
    const executeAction = vi.fn(async (action: ActionInvocation) => makeExecutedResult(action))
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    const leaseResult = await invoke('desktop_request_lease', { kind: 'act', ttlMs: 5_000 })
    expect(leaseResult.structuredContent).toMatchObject({ status: 'granted' })

    const focusResult = await invoke('desktop_focus_window', { windowId: 'w-cursor' })
    expect(focusResult.isError).not.toBe(true)
    expect(focusResult.structuredContent).toMatchObject({
      status: 'ok',
      result: {
        status: 'completed',
        windowId: 'w-cursor',
      },
    })

    expect(executeAction.mock.calls.map(call => call[0].kind)).toEqual(['focus_window'])
    expect((executeAction.mock.calls[0] as unknown[])[2]).toMatchObject({
      skipApprovalQueue: true,
    })
  })

  it('does not register internal-only desktop tools in v1', async () => {
    const executeAction = vi.fn(async (action: ActionInvocation) => makeExecutedResult(action))
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    await expect(invoke('desktop_move_resize_window', {
      windowId: 'w-cursor',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    })).rejects.toThrow(/Missing registered tool/)

    await expect(invoke('desktop_run_action_plan', {
      plan: {
        id: 'p1',
        createdAt: new Date().toISOString(),
        steps: [],
      },
    })).rejects.toThrow(/Missing registered tool/)
  })

  it('registers pointer primitive tools on the public MCP surface', async () => {
    const executeAction = vi.fn(async (action: ActionInvocation) => makeExecutedResult(action))
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    await invoke('desktop_move_pointer', { x: 120, y: 160 })
    await invoke('desktop_mouse_button', { x: 120, y: 160, state: 'down' })
    await invoke('desktop_long_press', { x: 180, y: 210, durationMs: 500 })
    await invoke('desktop_drag_pointer', {
      startX: 180,
      startY: 210,
      endX: 360,
      endY: 260,
      durationMs: 420,
    })

    expect(executeAction.mock.calls.map(call => call[0].kind)).toEqual([
      'move_pointer',
      'mouse_button',
      'long_press',
      'drag_pointer',
    ])
  })

  it('returns isError=true when desktop_focus_window fails', async () => {
    const executeAction = vi.fn(async (action: ActionInvocation) => {
      if (action.kind === 'focus_window') {
        return {
          isError: true,
          content: [{ type: 'text', text: 'focus_window failed' }],
        } satisfies CallToolResult
      }
      return makeExecutedResult(action)
    })
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    await invoke('desktop_request_lease', { kind: 'act', ttlMs: 5_000 })
    const focusResult = await invoke('desktop_focus_window', { windowId: 'w-cursor' })

    expect(focusResult.isError).toBe(true)
    expect(focusResult.structuredContent).toMatchObject({
      status: 'error',
    })
  })

  it('returns isError=true when desktop_apply_layout has no targets', async () => {
    const executeAction = vi.fn(async (action: ActionInvocation) => makeExecutedResult(action))
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    await invoke('desktop_request_lease', { kind: 'act', ttlMs: 5_000 })
    const result = await invoke('desktop_apply_layout', {
      layoutId: 'coding-dual-pane',
      windowIds: ['unknown-window-id'],
    })

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      status: 'error',
      reason: 'layout_preview_has_no_targets',
    })
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('returns isError=true when desktop_apply_layout is unsupported', async () => {
    const executeAction = vi.fn(async (action: ActionInvocation) => {
      if (action.kind === 'set_window_bounds') {
        return {
          isError: true,
          content: [{ type: 'text', text: 'set_window_bounds unsupported' }],
        } satisfies CallToolResult
      }
      return makeExecutedResult(action)
    })
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    await invoke('desktop_request_lease', { kind: 'act', ttlMs: 5_000 })
    const result = await invoke('desktop_apply_layout', { layoutId: 'coding-dual-pane' })

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      status: 'error',
      reason: expect.stringContaining('set_window_bounds_unsupported'),
    })
  })

  it('requires approval before granting act lease in approvalMode=actions', async () => {
    runtime.config.approvalMode = 'actions'
    installPendingActionStore(runtime)

    const executeAction = vi.fn(async (action: ActionInvocation) => makeExecutedResult(action))
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    const leaseResult = await invoke('desktop_request_lease', { kind: 'act', ttlMs: 5_000 })
    expect(leaseResult.structuredContent).toMatchObject({
      status: 'approval_required',
      toolName: 'desktop_request_lease',
    })

    const pendingId = (leaseResult.structuredContent as { pendingActionId: string }).pendingActionId
    const approvalToken = (leaseResult.toolResult as { approvalToken?: string } | undefined)?.approvalToken
    expect(pendingId).toBeTruthy()
    expect(approvalToken).toBeTruthy()

    const blockedFocusResult = await invoke('desktop_focus_window', { windowId: 'w-cursor' })
    expect(blockedFocusResult.isError).toBe(true)
    expect(blockedFocusResult.structuredContent).toMatchObject({
      status: 'error',
      reason: 'act_lease_required_before_focus_window',
    })

    const approved = await invoke('desktop_approve_pending_action', { id: pendingId, approvalToken })
    expect(approved.structuredContent).toMatchObject({
      status: 'granted',
      pendingActionId: pendingId,
    })

    const focusResult = await invoke('desktop_focus_window', { windowId: 'w-cursor' })
    expect(focusResult.isError).not.toBe(true)
    expect(focusResult.structuredContent).toMatchObject({
      status: 'ok',
      result: {
        status: 'completed',
      },
    })

    expect(executeAction.mock.calls.map(call => call[0].kind)).toEqual(['focus_window'])
  })

  it('requires approval before granting act lease in approvalMode=all', async () => {
    runtime.config.approvalMode = 'all'
    installPendingActionStore(runtime)

    const executeAction = vi.fn(async (action: ActionInvocation) => makeExecutedResult(action))
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    const leaseResult = await invoke('desktop_request_lease', { kind: 'act', ttlMs: 5_000 })
    expect(leaseResult.structuredContent).toMatchObject({
      status: 'approval_required',
      toolName: 'desktop_request_lease',
    })
    expect((leaseResult.toolResult as { approvalToken?: string } | undefined)?.approvalToken).toBeTruthy()
  })

  it('rejects desktop approval attempts without the opaque approval token', async () => {
    runtime.config.approvalMode = 'actions'
    installPendingActionStore(runtime)

    const executeAction = vi.fn(async (action: ActionInvocation) => makeExecutedResult(action))
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    const leaseResult = await invoke('desktop_request_lease', { kind: 'act', ttlMs: 5_000 })
    const pendingId = (leaseResult.structuredContent as { pendingActionId: string }).pendingActionId

    const approved = await invoke('desktop_approve_pending_action', { id: pendingId })
    expect(approved.isError).toBe(true)
    expect(approved.structuredContent).toMatchObject({
      status: 'error',
      reason: 'pending_action_approval_token_invalid',
      pendingActionId: pendingId,
    })

    const focusResult = await invoke('desktop_focus_window', { windowId: 'w-cursor' })
    expect(focusResult.isError).toBe(true)
    expect(focusResult.structuredContent).toMatchObject({
      status: 'error',
      reason: 'act_lease_required_before_focus_window',
    })
  })

  it('requires act lease before running desktop safe agent loop', async () => {
    const executeAction = vi.fn(async (action: ActionInvocation) => makeExecutedResult(action))
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    const run = await invoke('desktop_run_safe_agent_loop', {
      objective: 'focus cursor window',
      plan: [{
        kind: 'focus_window',
        windowId: 'w-cursor',
      }],
    })

    expect(run.isError).toBe(true)
    expect(run.structuredContent).toMatchObject({
      status: 'error',
      safeLoopStatus: 'failed',
      failureClassification: 'lease_required',
      errors: ['act_lease_required_before_safe_agent_loop'],
    })
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('runs desktop safe agent loop with observe/act/verify and stores trace', async () => {
    const executeAction = vi.fn(async (action: ActionInvocation) => makeExecutedResult(action))
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    await invoke('desktop_request_lease', { kind: 'act', ttlMs: 5_000 })

    const run = await invoke('desktop_run_safe_agent_loop', {
      objective: 'focus cursor window',
      plan: [{
        kind: 'focus_window',
        windowId: 'w-cursor',
      }],
      maxSteps: 1,
      actionBudget: 2,
    })

    expect(run.isError).not.toBe(true)
    expect(run.structuredContent).toMatchObject({
      status: 'ok',
      safeLoopStatus: 'succeeded',
      executedSteps: 1,
      verification: {
        attempted: 1,
        passed: 1,
        failed: 0,
        notApplicable: 0,
        skipped: 0,
      },
      stepResults: [
        {
          stepKind: 'focus_window',
          actionStatus: 'completed',
          verificationStatus: 'passed',
        },
      ],
      plan: {
        requestedSteps: 1,
        cappedSteps: 1,
      },
    })

    expect(runtime.session.recordSafeLoopRun).toHaveBeenCalledTimes(1)

    const trace = await invoke('desktop_get_safe_loop_trace', { limit: 5 })
    expect(trace.structuredContent).toMatchObject({
      status: 'ok',
    })

    const runs = (trace.structuredContent as { runs?: Array<{ objective?: string, status?: string }> }).runs || []
    expect(runs.length).toBeGreaterThan(0)
    expect(runs[0]).toMatchObject({
      objective: 'focus cursor window',
      status: 'succeeded',
    })

    expect(executeAction.mock.calls.map(call => call[0].kind)).toEqual(['focus_window'])
  })

  it('returns failed with verification classification when verify fails but stopOnVerificationFailure=false', async () => {
    const executeAction = vi.fn(async (action: ActionInvocation) => makeExecutedResult(action))
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    await invoke('desktop_request_lease', { kind: 'act', ttlMs: 5_000 })

    const run = await invoke('desktop_run_safe_agent_loop', {
      objective: 'verify mismatch with continue',
      plan: [
        {
          kind: 'click',
          x: 10,
          y: 10,
        },
        {
          kind: 'wait',
          durationMs: 5,
        },
      ],
      maxSteps: 2,
      actionBudget: 4,
      stopOnVerificationFailure: false,
    })

    expect(run.isError).toBe(true)
    expect(run.structuredContent).toMatchObject({
      status: 'error',
      safeLoopStatus: 'failed',
      failureClassification: 'verification_failed',
      executedSteps: 2,
      verification: {
        attempted: 1,
        passed: 0,
        failed: 1,
        notApplicable: 1,
        skipped: 0,
      },
    })

    const stepResults = (run.structuredContent as { stepResults?: Array<Record<string, unknown>> }).stepResults || []
    expect(stepResults.length).toBe(2)
    expect(stepResults[0]).toMatchObject({
      stepKind: 'click',
      verificationStatus: 'failed',
    })
    expect(stepResults[1]).toMatchObject({
      stepKind: 'wait',
      verificationStatus: 'not_applicable',
    })
  })

  it('returns failed with budget classification when action budget is exhausted before step', async () => {
    const executeAction = vi.fn(async (action: ActionInvocation) => makeExecutedResult(action))
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    await invoke('desktop_request_lease', { kind: 'act', ttlMs: 5_000 })

    const run = await invoke('desktop_run_safe_agent_loop', {
      objective: 'budget gate',
      plan: [{
        kind: 'move_resize_window',
        windowId: 'w-cursor',
        bounds: { x: 4, y: 6, width: 600, height: 420 },
      }],
      maxSteps: 1,
      actionBudget: 1,
    })

    expect(run.isError).toBe(true)
    expect(run.structuredContent).toMatchObject({
      status: 'error',
      safeLoopStatus: 'failed',
      failureClassification: 'budget_exhausted',
      executedSteps: 0,
    })

    const stepResults = (run.structuredContent as { stepResults?: Array<Record<string, unknown>> }).stepResults || []
    expect(stepResults[0]).toMatchObject({
      stepKind: 'move_resize_window',
      actionStatus: 'skipped',
      verificationStatus: 'verification_skipped',
    })
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('returns interrupted with lease_lost classification when lease expires mid-loop', async () => {
    const executeAction = vi.fn(async (action: ActionInvocation) => {
      if (action.kind === 'wait') {
        await sleep(action.input.durationMs)
      }
      return makeExecutedResult(action)
    })
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    await invoke('desktop_request_lease', { kind: 'act', ttlMs: 250 })

    const run = await invoke('desktop_run_safe_agent_loop', {
      objective: 'lease expiry interrupt',
      plan: [
        { kind: 'wait', durationMs: 320 },
        { kind: 'wait', durationMs: 10 },
      ],
      maxSteps: 2,
      actionBudget: 2,
    })

    expect(run.isError).toBe(true)
    expect(run.structuredContent).toMatchObject({
      status: 'error',
      safeLoopStatus: 'interrupted',
      failureClassification: 'lease_lost',
      interruptedBy: 'lease_lost',
    })
  })

  it('returns interrupted with interruptedBy=user_input when user input preempts lease', async () => {
    const executeAction = vi.fn(async (action: ActionInvocation) => {
      if (action.kind === 'wait') {
        await sleep(action.input.durationMs)
      }
      return makeExecutedResult(action)
    })
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    await invoke('desktop_request_lease', { kind: 'act', ttlMs: 5_000 })

    const runPromise = invoke('desktop_run_safe_agent_loop', {
      objective: 'user preemption interrupt',
      plan: [
        { kind: 'wait', durationMs: 120 },
        { kind: 'wait', durationMs: 120 },
      ],
      maxSteps: 2,
      actionBudget: 4,
    })

    await sleep(25)
    await invoke('desktop_report_user_input', { source: 'keyboard' })

    const run = await runPromise
    expect(run.isError).toBe(true)
    expect(run.structuredContent).toMatchObject({
      status: 'error',
      safeLoopStatus: 'interrupted',
      interruptedBy: 'user_input',
    })
    expect(run.structuredContent).not.toHaveProperty('failureClassification')
  })

  it('prefers durable safe-loop artifact when merging trace sources by runId', async () => {
    const executeAction = vi.fn(async (action: ActionInvocation) => makeExecutedResult(action))
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    await invoke('desktop_request_lease', { kind: 'act', ttlMs: 5_000 })

    const run = await invoke('desktop_run_safe_agent_loop', {
      objective: 'trace dedupe source preference',
      plan: [{
        kind: 'wait',
        durationMs: 10,
      }],
      maxSteps: 1,
      actionBudget: 2,
    })

    const runId = String((run.structuredContent as { runId?: string }).runId || '')
    expect(runId).toBeTruthy()

    const durableRun = {
      ...(run.structuredContent as Record<string, unknown>),
      objective: 'durable-objective-preferred',
      status: 'failed',
      failureClassification: 'verification_failed',
      finishedAt: new Date(Date.now() + 10_000).toISOString(),
    }

    const getRecentSafeLoopRuns = runtime.session.getRecentSafeLoopRuns as unknown as ReturnType<typeof vi.fn>
    getRecentSafeLoopRuns.mockReturnValue([durableRun])

    const trace = await invoke('desktop_get_safe_loop_trace', { limit: 5 })
    const runs = (trace.structuredContent as { runs?: Array<Record<string, unknown>> }).runs || []

    const target = runs.find(item => item.runId === runId)
    expect(target).toMatchObject({
      objective: 'durable-objective-preferred',
      status: 'failed',
      failureClassification: 'verification_failed',
    })
  })
})
