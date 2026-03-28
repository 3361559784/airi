import { dirname, resolve } from 'node:path'
import { env, exit } from 'node:process'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function parseCommandArgs(raw: string | undefined, fallback: string[]) {
  if (!raw?.trim())
    return fallback

  return raw
    .split(/\s+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function requireStructuredContent(result: unknown, label: string) {
  if (!result || typeof result !== 'object')
    throw new Error(`${label} did not return an object result`)

  const structuredContent = (result as { structuredContent?: unknown }).structuredContent
  if (!structuredContent || typeof structuredContent !== 'object')
    throw new Error(`${label} missing structuredContent`)

  return structuredContent as Record<string, unknown>
}

async function approvePendingAction(
  client: Client,
  expectedToolName: string,
  options: {
    pendingActionId?: string
    approvalToken?: string
  } = {},
) {
  const pending = await client.callTool({
    name: 'desktop_list_pending_actions',
    arguments: {},
  })
  const pendingData = requireStructuredContent(pending, 'desktop_list_pending_actions')
  const pendingActions = Array.isArray(pendingData.pendingActions) ? pendingData.pendingActions : []
  const selectedPending = (options.pendingActionId
    ? pendingActions.find((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && String((item as Record<string, unknown>).id || '') === options.pendingActionId)
    : [...pendingActions]
        .reverse()
        .find((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && String((item as Record<string, unknown>).toolName || '') === expectedToolName))

  if (!selectedPending) {
    throw new Error(options.pendingActionId
      ? `pending action not found for ${expectedToolName}: ${options.pendingActionId}`
      : `no pending action found for ${expectedToolName}`)
  }

  const pendingId = String(selectedPending.id || '')
  if (!pendingId)
    throw new Error(`pending action missing id after ${expectedToolName}`)

  const approved = await client.callTool({
    name: 'desktop_approve_pending_action',
    arguments: {
      id: pendingId,
      ...(options.approvalToken ? { approvalToken: options.approvalToken } : {}),
    },
  })

  return {
    pendingId,
    structured: requireStructuredContent(approved, 'desktop_approve_pending_action'),
    raw: approved,
  }
}

async function callWithApprovalSupport(client: Client, name: string, args: Record<string, unknown>) {
  const raw = await client.callTool({ name, arguments: args })
  const structured = requireStructuredContent(raw, name)

  if (structured.status !== 'approval_required') {
    return {
      source: 'direct' as const,
      structured,
      raw,
    }
  }

  const approvalTokenFromCaller = (raw as { toolResult?: { approvalToken?: unknown } }).toolResult?.approvalToken
  const pendingActionId = typeof structured.pendingActionId === 'string' ? structured.pendingActionId : undefined
  const approved = await approvePendingAction(
    client,
    name,
    {
      pendingActionId,
      approvalToken: typeof approvalTokenFromCaller === 'string' ? approvalTokenFromCaller : undefined,
    },
  )
  return {
    source: 'approved' as const,
    structured: approved.structured,
    raw: approved.raw,
    pendingId: approved.pendingId,
  }
}

async function main() {
  const command = env.COMPUTER_USE_SMOKE_SERVER_COMMAND?.trim() || 'pnpm'
  const args = parseCommandArgs(env.COMPUTER_USE_SMOKE_SERVER_ARGS, ['start'])
  const cwd = env.COMPUTER_USE_SMOKE_SERVER_CWD?.trim() || packageDir

  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    env: {
      ...env,
      COMPUTER_USE_EXECUTOR: env.COMPUTER_USE_SMOKE_EXECUTOR || 'macos-local',
      COMPUTER_USE_APPROVAL_MODE: env.COMPUTER_USE_SMOKE_APPROVAL_MODE || 'actions',
      COMPUTER_USE_OPENABLE_APPS: env.COMPUTER_USE_OPENABLE_APPS || 'Terminal,Cursor,Google Chrome',
    },
    stderr: 'pipe',
  })

  const client = new Client({
    name: '@proj-airi/computer-use-mcp-smoke-macos-safe-loop-v3',
    version: '0.1.0',
  })

  transport.stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf-8').trim()
    if (text)
      console.error(`[computer-use-mcp stderr] ${text}`)
  })

  try {
    await client.connect(transport)

    const capabilitiesRaw = await client.callTool({
      name: 'desktop_get_capabilities',
      arguments: {},
    })
    const capabilities = requireStructuredContent(capabilitiesRaw, 'desktop_get_capabilities')
    const executionTarget = capabilities.executionTarget as Record<string, unknown> | undefined
    if (executionTarget?.mode !== 'local-windowed') {
      throw new Error(`desktop_get_capabilities expected local-windowed target, got ${String(executionTarget?.mode)}`)
    }
    const supportedAppsForOpenFocus = Array.isArray(capabilities.supportedAppsForOpenFocus)
      ? capabilities.supportedAppsForOpenFocus.map(item => String(item))
      : []

    const sceneRaw = await client.callTool({
      name: 'desktop_observe_scene',
      arguments: {},
    })
    const sceneResult = requireStructuredContent(sceneRaw, 'desktop_observe_scene')
    const scene = sceneResult.scene as Record<string, unknown> | undefined
    const windows = Array.isArray(scene?.windows) ? scene?.windows as Array<Record<string, unknown>> : []
    const focusedApp = typeof scene?.focusedApp === 'string' ? scene.focusedApp : undefined
    const focusedWindowId = typeof scene?.focusedWindowId === 'string' ? scene.focusedWindowId : undefined

    const screenshotRaw = await client.callTool({
      name: 'desktop_screenshot',
      arguments: {
        label: 'v3-safe-loop-pre-action',
      },
    })
    const screenshot = requireStructuredContent(screenshotRaw, 'desktop_screenshot')
    if (screenshot.status !== 'executed') {
      throw new Error(`desktop_screenshot before safe loop expected executed, got ${String(screenshot.status)}`)
    }

    const lease = await callWithApprovalSupport(client, 'desktop_request_lease', {
      kind: 'act',
      ttlMs: 3_000,
    })

    const safePlan = focusedWindowId
      ? [{ kind: 'focus_window', windowId: focusedWindowId }]
      : windows[0] && typeof windows[0].id === 'string'
        ? [{ kind: 'focus_window', windowId: String(windows[0].id) }]
        : [{ kind: 'wait', durationMs: 120 }]

    const runRaw = await client.callTool({
      name: 'desktop_run_safe_agent_loop',
      arguments: {
        objective: 'v3 safe loop smoke',
        plan: safePlan,
        maxSteps: 1,
        actionBudget: 4,
        stopOnVerificationFailure: true,
      },
    })
    const run = requireStructuredContent(runRaw, 'desktop_run_safe_agent_loop')
    if (run.status !== 'ok' || run.safeLoopStatus !== 'succeeded') {
      throw new Error(`desktop_run_safe_agent_loop expected ok/succeeded, got status=${String(run.status)} safeLoopStatus=${String(run.safeLoopStatus)}`)
    }

    const stepResults = Array.isArray(run.stepResults) ? run.stepResults as Array<Record<string, unknown>> : []
    if (stepResults.length === 0) {
      throw new Error('desktop_run_safe_agent_loop expected non-empty stepResults')
    }

    const firstStep = stepResults[0]
    const firstStepKind = String(firstStep?.stepKind || '')
    if (firstStepKind === 'focus_window' || firstStepKind === 'move_resize_window') {
      const observedIdentity = firstStep?.observedIdentity
      const reacquireSelector = firstStep?.reacquireSelector
      const reacquireStatus = String(firstStep?.reacquireStatus || '')

      if (!observedIdentity || typeof observedIdentity !== 'object' || !reacquireSelector || typeof reacquireSelector !== 'object') {
        throw new Error('safe-loop window step missing observedIdentity/reacquireSelector in v3.2')
      }

      if (!reacquireStatus) {
        throw new Error('safe-loop window step missing reacquireStatus in v3.2')
      }

      const observedWindowNumber = (observedIdentity as Record<string, unknown>).windowNumber
      const observedOwnerPid = (observedIdentity as Record<string, unknown>).ownerPid
      const selectorWindowNumber = (reacquireSelector as Record<string, unknown>).windowNumber
      const selectorOwnerPid = (reacquireSelector as Record<string, unknown>).ownerPid
      const hasStableWindowNumberPid = Number.isFinite(Number(observedWindowNumber)) && Number.isFinite(Number(observedOwnerPid))

      if (hasStableWindowNumberPid) {
        if (Number(selectorWindowNumber) !== Number(observedWindowNumber) || Number(selectorOwnerPid) !== Number(observedOwnerPid)) {
          throw new Error('safe-loop v3.2 expected windowNumber+ownerPid to stay stable between observedIdentity and reacquireSelector')
        }
      }
    }

    const requestedOpenAppTarget = env.COMPUTER_USE_SMOKE_OPEN_APP_TARGET?.trim()
    const openAppTarget = requestedOpenAppTarget
      ? supportedAppsForOpenFocus.includes(requestedOpenAppTarget)
        ? requestedOpenAppTarget
        : undefined
      : focusedApp && supportedAppsForOpenFocus.includes(focusedApp)
        ? focusedApp
        : undefined
    let openAppRun: Record<string, unknown> | undefined

    if (openAppTarget) {
      const openAppRunRaw = await client.callTool({
        name: 'desktop_run_safe_agent_loop',
        arguments: {
          objective: 'v3 safe loop open app smoke',
          plan: [{ kind: 'open_app', app: openAppTarget }],
          maxSteps: 1,
          actionBudget: 4,
          stopOnVerificationFailure: true,
        },
      })
      openAppRun = requireStructuredContent(openAppRunRaw, 'desktop_run_safe_agent_loop open_app')
      if (openAppRun.status !== 'ok' || openAppRun.safeLoopStatus !== 'succeeded') {
        throw new Error(`desktop_run_safe_agent_loop open_app expected ok/succeeded, got status=${String(openAppRun.status)} safeLoopStatus=${String(openAppRun.safeLoopStatus)}`)
      }

      const openAppStepResults = Array.isArray(openAppRun.stepResults) ? openAppRun.stepResults as Array<Record<string, unknown>> : []
      if (openAppStepResults.length === 0) {
        throw new Error('desktop_run_safe_agent_loop open_app expected non-empty stepResults')
      }

      const openAppVerification = openAppStepResults[0]?.verificationDetails
      if (!openAppVerification || typeof openAppVerification !== 'object') {
        throw new Error('desktop_run_safe_agent_loop open_app expected verificationDetails object')
      }

      const expectedApp = (openAppVerification as Record<string, unknown>).expectedApp
      const attempts = (openAppVerification as Record<string, unknown>).attempts
      const matchedBy = String((openAppVerification as Record<string, unknown>).matchedBy || '')
      const windowCountForApp = (openAppVerification as Record<string, unknown>).windowCountForApp

      if (String(expectedApp) !== openAppTarget) {
        throw new Error(`desktop_run_safe_agent_loop open_app expected verificationDetails.expectedApp=${openAppTarget}, got ${String(expectedApp)}`)
      }

      if (!Number.isFinite(Number(attempts)) || Number(attempts) < 1 || Number(attempts) > 3) {
        throw new Error(`desktop_run_safe_agent_loop open_app expected attempts in [1,3], got ${String(attempts)}`)
      }

      if (!['focused_app', 'visible_window', 'none'].includes(matchedBy)) {
        throw new Error(`desktop_run_safe_agent_loop open_app expected matchedBy to be focused_app|visible_window|none, got ${matchedBy}`)
      }

      if (!Number.isFinite(Number(windowCountForApp)) || Number(windowCountForApp) < 0) {
        throw new Error(`desktop_run_safe_agent_loop open_app expected non-negative windowCountForApp, got ${String(windowCountForApp)}`)
      }

    }

    const traceRaw = await client.callTool({
      name: 'desktop_get_safe_loop_trace',
      arguments: { limit: 5 },
    })
    const trace = requireStructuredContent(traceRaw, 'desktop_get_safe_loop_trace')
    const runs = Array.isArray(trace.runs) ? trace.runs : []
    if (trace.status !== 'ok' || runs.length === 0) {
      throw new Error(`desktop_get_safe_loop_trace expected runs, got status=${String(trace.status)} count=${runs.length}`)
    }

    let appRun: Record<string, unknown> | undefined
    if (focusedApp) {
      const appRunRaw = await client.callTool({
        name: 'desktop_run_safe_agent_loop',
        arguments: {
          objective: 'v3 safe loop app focus smoke',
          plan: [{ kind: 'focus_app', app: focusedApp }],
          maxSteps: 1,
          actionBudget: 4,
          stopOnVerificationFailure: true,
        },
      })
      appRun = requireStructuredContent(appRunRaw, 'desktop_run_safe_agent_loop focus_app')
      if (appRun.status !== 'ok' || appRun.safeLoopStatus !== 'succeeded') {
        throw new Error(`desktop_run_safe_agent_loop focus_app expected ok/succeeded, got status=${String(appRun.status)} safeLoopStatus=${String(appRun.safeLoopStatus)}`)
      }
    }

    const interruptRaw = await client.callTool({
      name: 'desktop_report_user_input',
      arguments: { source: 'keyboard' },
    })
    const interrupt = requireStructuredContent(interruptRaw, 'desktop_report_user_input')

    const leaseRequiredRaw = await client.callTool({
      name: 'desktop_run_safe_agent_loop',
      arguments: {
        objective: 'v3 safe loop lease boundary',
        plan: [{ kind: 'wait', durationMs: 50 }],
        maxSteps: 1,
        actionBudget: 1,
      },
    })
    const leaseRequired = requireStructuredContent(leaseRequiredRaw, 'desktop_run_safe_agent_loop')
    if (leaseRequired.status !== 'error' || leaseRequired.safeLoopStatus !== 'failed' || leaseRequired.failureClassification !== 'lease_required') {
      throw new Error(`desktop_run_safe_agent_loop expected failed/lease_required after interrupt, got status=${String(leaseRequired.status)} safeLoopStatus=${String(leaseRequired.safeLoopStatus)} failureClassification=${String(leaseRequired.failureClassification)}`)
    }

    console.info(JSON.stringify({
      ok: true,
      scenario: 'macos-safe-loop-v3',
      verified: {
        executionTarget,
        screenshot,
        lease,
        observedWindowCount: windows.length,
        supportedAppsForOpenFocus,
        focusedApp,
        focusedWindowId,
        run,
        openAppTarget,
        openAppRun,
        appRun,
        traceCount: runs.length,
        interrupt,
        leaseRequired,
      },
    }, null, 2))
  }
  finally {
    await client.close().catch(() => {})
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  exit(1)
})
