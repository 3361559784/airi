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

function extractText(result: unknown) {
  if (!result || typeof result !== 'object')
    return ''

  const content = (result as { content?: Array<{ type?: string, text?: string }> }).content
  if (!Array.isArray(content))
    return ''

  return content
    .filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join(' ')
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

  const pendingToolName = typeof selectedPending.toolName === 'string' ? selectedPending.toolName : undefined
  if (pendingToolName && pendingToolName !== expectedToolName) {
    throw new Error(`pending action ${pendingId} belongs to ${pendingToolName}, expected ${expectedToolName}`)
  }

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

function isFocusErrorAcceptable(params: {
  errorText: string
  reason: string
  accessibilityStatus?: string
}) {
  if (params.accessibilityStatus !== 'granted') {
    return true
  }

  return params.reason.includes('focus_window_failed')
    || params.reason.includes('focus_window_unsupported')
    || params.errorText.includes('focus_window_failed')
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
    name: '@proj-airi/computer-use-mcp-smoke-macos-control-quality',
    version: '0.1.0',
  })

  transport.stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf-8').trim()
    if (text)
      console.error(`[computer-use-mcp stderr] ${text}`)
  })

  const warnings: string[] = []

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

    const permissions = capabilities.permissions as Record<string, unknown> | undefined
    const accessibility = permissions?.accessibility as Record<string, unknown> | undefined

    const sceneRaw = await client.callTool({
      name: 'desktop_observe_scene',
      arguments: {},
    })
    const sceneResult = requireStructuredContent(sceneRaw, 'desktop_observe_scene')
    const scene = sceneResult.scene as Record<string, unknown> | undefined
    const screens = Array.isArray(scene?.screens) ? scene.screens as Array<Record<string, unknown>> : []
    if (screens.length === 0) {
      throw new Error('desktop_observe_scene returned no screens')
    }

    const firstScreen = screens[0]!
    const bounds = (firstScreen.bounds ?? {}) as Record<string, unknown>
    const target = {
      x: Math.round(Number(bounds.x || 0) + Number(bounds.width || 0) / 2),
      y: Math.round(Number(bounds.y || 0) + Number(bounds.height || 0) / 2),
    }

    const preActionScreenshotRaw = await client.callTool({
      name: 'desktop_screenshot',
      arguments: {
        label: 'v2-control-quality-pre-action',
      },
    })
    const preActionScreenshot = requireStructuredContent(preActionScreenshotRaw, 'desktop_screenshot')
    if (preActionScreenshot.status !== 'executed') {
      throw new Error(`desktop_screenshot before mutations expected executed status, got ${String(preActionScreenshot.status)}`)
    }

    const lease = await callWithApprovalSupport(client, 'desktop_request_lease', {
      kind: 'act',
      ttlMs: 3_000,
    })
    if (!['granted', 'approval_required', 'executed'].includes(String(lease.structured.status || ''))) {
      throw new Error(`desktop_request_lease returned unexpected status: ${String(lease.structured.status)}`)
    }

    const previewRaw = await client.callTool({
      name: 'desktop_preview_pointer_move',
      arguments: {
        target,
        label: 'v2-smoke-move',
      },
    })
    const preview = requireStructuredContent(previewRaw, 'desktop_preview_pointer_move')
    if (preview.status !== 'ok') {
      throw new Error(`desktop_preview_pointer_move unexpected status: ${String(preview.status)}`)
    }

    const move = await callWithApprovalSupport(client, 'desktop_move_pointer', {
      x: target.x,
      y: target.y,
      captureAfter: false,
    })
    if (move.structured.status !== 'executed' && move.structured.status !== 'ok') {
      throw new Error(`desktop_move_pointer unexpected status: ${String(move.structured.status)}`)
    }

    const pointerRaw = await client.callTool({
      name: 'desktop_observe_pointer',
      arguments: {},
    })
    const pointer = requireStructuredContent(pointerRaw, 'desktop_observe_pointer')

    const windows = Array.isArray(scene?.windows) ? scene.windows as Array<Record<string, unknown>> : []
    let focusOutcome: Record<string, unknown> | undefined
    if (windows.length > 0) {
      const focusRaw = await client.callTool({
        name: 'desktop_focus_window',
        arguments: {
          windowId: String(windows[0]!.id || ''),
        },
      })
      const focusStructured = requireStructuredContent(focusRaw, 'desktop_focus_window')

      if (focusStructured.status === 'error') {
        const reason = String(focusStructured.reason || '')
        const error = extractText(focusRaw)
        if (!isFocusErrorAcceptable({
          errorText: error,
          reason,
          accessibilityStatus: typeof accessibility?.status === 'string' ? accessibility.status : undefined,
        })) {
          throw new Error(`desktop_focus_window failed unexpectedly: ${reason} ${error}`)
        }

        warnings.push(`desktop_focus_window degraded: ${reason || error || 'unknown'}`)
      }

      focusOutcome = focusStructured
    }

    const interruptRaw = await client.callTool({
      name: 'desktop_report_user_input',
      arguments: {
        source: 'mouse',
      },
    })
    const interrupt = requireStructuredContent(interruptRaw, 'desktop_report_user_input')

    const postInterruptLayoutRaw = await client.callTool({
      name: 'desktop_apply_layout',
      arguments: {
        layoutId: 'coding-dual-pane',
      },
    })
    const postInterruptLayout = requireStructuredContent(postInterruptLayoutRaw, 'desktop_apply_layout')
    if (postInterruptLayout.status !== 'error' || !String(postInterruptLayout.reason || '').includes('lease_required')) {
      throw new Error(`desktop_apply_layout expected lease_required error after interrupt, got ${JSON.stringify(postInterruptLayout)}`)
    }

    const secondLease = await callWithApprovalSupport(client, 'desktop_request_lease', {
      kind: 'act',
      ttlMs: 2_000,
    })

    const cancelLeaseRaw = await client.callTool({
      name: 'desktop_cancel_lease',
      arguments: {
        reason: 'smoke_end',
      },
    })
    const cancelLease = requireStructuredContent(cancelLeaseRaw, 'desktop_cancel_lease')

    const screenshotRaw = await client.callTool({
      name: 'desktop_screenshot',
      arguments: {
        label: 'v2-control-quality-smoke',
      },
    })
    const screenshot = requireStructuredContent(screenshotRaw, 'desktop_screenshot')
    if (screenshot.status !== 'executed') {
      throw new Error(`desktop_screenshot expected executed status, got ${String(screenshot.status)}`)
    }

    console.info(JSON.stringify({
      ok: true,
      scenario: 'macos-control-quality-v2',
      warnings,
      verified: {
        executionTarget,
        accessibility,
        sceneScreens: screens.length,
        preActionScreenshot: preActionScreenshot.screenshot,
        pointer,
        lease,
        move,
        focusOutcome,
        interrupt,
        postInterruptLayout,
        secondLease,
        cancelLease,
        screenshot: screenshot.screenshot,
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
